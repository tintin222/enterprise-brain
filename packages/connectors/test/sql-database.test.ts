import { describe, expect, it } from "vitest";
import { ConnectorError, createSqlDatabaseConnector, guardReadOnlySql, limitQuery, type SqlClient, type SqlQueryResult } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

function rejects(sql: string): ConnectorError {
  try {
    guardReadOnlySql(sql);
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error(`guard accepted: ${sql}`);
}

describe("guardReadOnlySql", () => {
  it("rejects anything that is not a single read-only SELECT/WITH statement", () => {
    expect(rejects("DELETE FROM customers").code).toBe("validation");
    expect(rejects("DELETE FROM customers").message).toMatch(/Only SELECT or WITH/);
    expect(rejects("SELECT 1; DROP TABLE x").message).toMatch(/single SQL statement/);
    expect(rejects("select 1;\n drop table x;").message).toMatch(/single SQL statement/);
    expect(rejects("UPDATE orders SET status = 'x'").code).toBe("validation");
    expect(rejects("WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone").message).toMatch(/must not contain DELETE/);
    expect(rejects("SELECT * INTO backup_orders FROM orders").message).toMatch(/INTO/);
    expect(rejects("SELECT * FROM orders FOR UPDATE").message).toMatch(/UPDATE/);
    expect(rejects("SELECT * FROM orders FOR SHARE").message).toMatch(/FOR SHARE/);
    expect(rejects("SELECT pg_sleep(60)").message).toMatch(/pg_sleep/);
    expect(rejects("SELECT set_config('role', 'admin', false)").message).toMatch(/set_config/);
    expect(rejects("SELECT nextval('orders_id_seq')").message).toMatch(/nextval/);
    expect(rejects("EXPLAIN ANALYZE DELETE FROM orders").code).toBe("validation");
    expect(rejects("SELECT 'unterminated").message).toMatch(/Unterminated string/);
    expect(rejects("SELECT 1 /* open comment").message).toMatch(/Unterminated block comment/);
    expect(rejects("SELECT (1").message).toMatch(/Unbalanced/);
    expect(rejects("   ;  ").message).toMatch(/empty/);
  });

  it("accepts read-only queries, ignoring keywords inside literals, identifiers and comments", () => {
    expect(guardReadOnlySql("SELECT 1;")).toBe("SELECT 1");
    expect(guardReadOnlySql("select * from orders where note = 'drop; delete' -- trailing ; comment")).toBe("select * from orders where note = 'drop; delete'");
    expect(guardReadOnlySql('SELECT "update", "delete" FROM audit_log')).toBe('SELECT "update", "delete" FROM audit_log');
    expect(guardReadOnlySql("WITH totals AS (SELECT customer_id, sum(amount) AS total FROM invoices GROUP BY 1) SELECT * FROM totals")).toMatch(/^WITH/);
    expect(guardReadOnlySql("(SELECT 1) UNION ALL (SELECT 2)")).toBe("(SELECT 1) UNION ALL (SELECT 2)");
    expect(guardReadOnlySql("SELECT $$; DROP TABLE x; $$ AS s, $tag$it's$tag$ AS t")).toContain("$$; DROP TABLE x; $$");
    expect(guardReadOnlySql("SELECT E'it\\'s; fine' AS e")).toBe("SELECT E'it\\'s; fine' AS e");
    expect(guardReadOnlySql("SELECT order_no, load_weight, release_date FROM shipments WHERE customer_id = $1 /* note: update */")).toBe(
      "SELECT order_no, load_weight, release_date FROM shipments WHERE customer_id = $1",
    );
  });

  it("wraps queries with a row limit", () => {
    expect(limitQuery("SELECT * FROM orders", 500)).toBe("SELECT * FROM (SELECT * FROM orders) AS q LIMIT 500");
  });
});

class FakeClient implements SqlClient {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  ended = false;
  constructor(private readonly respond: (text: string, values?: unknown[]) => SqlQueryResult | Error = () => ({ rows: [] })) {}
  async connect(): Promise<void> {}
  async query(text: string, values?: unknown[]): Promise<SqlQueryResult> {
    this.statements.push({ text, values });
    const result = this.respond(text, values);
    if (result instanceof Error) throw result;
    return result;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("sql-database", () => {
  const ctx = () => makeCtx({ config: { max_rows: 500, statement_timeout_ms: 15000 }, secrets: { connection_string: "postgresql://readonly:pw@db.acme.example:5432/reporting" } });

  it("runs guarded queries in a read-only transaction with a row limit", async () => {
    const client = new FakeClient((text) =>
      text.startsWith("SELECT * FROM (")
        ? {
            fields: [{ name: "order_no" }, { name: "created_at" }, { name: "qty" }, { name: "blob" }],
            rows: [{ order_no: "SO-7000121", created_at: new Date("2026-09-01T08:00:00Z"), qty: 12n, blob: Buffer.from("hi") }],
          }
        : { rows: [] },
    );
    let received: unknown;
    const connector = createSqlDatabaseConnector({
      createClient: (config) => {
        received = config;
        return client;
      },
    });
    const result = await run(connector, "run_query", { sql: "SELECT order_no, created_at, qty, blob FROM orders WHERE customer_id = $1; -- recent", params: ["CUST-2002"] }, ctx());
    expect(received).toEqual({ connectionString: "postgresql://readonly:pw@db.acme.example:5432/reporting", statementTimeoutMs: 15000 });
    expect(client.statements.map((s) => s.text)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = 15000",
      "SELECT * FROM (SELECT order_no, created_at, qty, blob FROM orders WHERE customer_id = $1) AS q LIMIT 500",
      "ROLLBACK",
    ]);
    expect(client.statements[2]!.values).toEqual(["CUST-2002"]);
    expect(client.ended).toBe(true);
    expect(result).toEqual({
      columns: ["order_no", "created_at", "qty", "blob"],
      rows: [{ order_no: "SO-7000121", created_at: "2026-09-01T08:00:00.000Z", qty: "12", blob: "aGk=" }],
      row_count: 1,
      truncated: false,
      max_rows: 500,
    });
  });

  it("rejects unsafe SQL before connecting", async () => {
    let connected = false;
    const connector = createSqlDatabaseConnector({
      createClient: () => {
        connected = true;
        return new FakeClient();
      },
    });
    expect((await expectConnectorError(connector.execute("run_query", { sql: "DELETE FROM orders" }, ctx()))).code).toBe("validation");
    expect((await expectConnectorError(connector.execute("run_query", { sql: "SELECT 1; DROP TABLE x" }, ctx()))).code).toBe("validation");
    expect((await expectConnectorError(connector.execute("run_query", { sql: "SELECT $1", params: [{ nested: true }] }, ctx()))).code).toBe("validation");
    expect(connected).toBe(false);
  });

  it("maps PostgreSQL errors and always rolls back and disconnects", async () => {
    const client = new FakeClient((text) => (text.startsWith("SELECT * FROM (") ? pgError("42P01", 'relation "ordrs" does not exist') : { rows: [] }));
    const connector = createSqlDatabaseConnector({ createClient: () => client });
    const error = await expectConnectorError(connector.execute("run_query", { sql: "SELECT * FROM ordrs" }, ctx()));
    expect(error).toMatchObject({ code: "validation", message: 'Unknown table: relation "ordrs" does not exist' });
    expect(client.statements.at(-1)!.text).toBe("ROLLBACK");
    expect(client.ended).toBe(true);

    const refusing = createSqlDatabaseConnector({
      createClient: () =>
        Object.assign(new FakeClient(), {
          connect: () => Promise.reject(pgError("28P01", 'password authentication failed for user "readonly"')),
        }),
    });
    expect(await refusing.test(ctx())).toMatchObject({ ok: false, details: { code: "auth" } });
  });

  it("lists and describes tables", async () => {
    const client = new FakeClient((text, values) => {
      if (text.includes("information_schema.tables")) return { rows: [{ table_schema: "public", table_name: "orders", table_type: "BASE TABLE" }] };
      if (text.includes("information_schema.columns")) {
        return values?.[1] === "orders" ? { rows: [{ column_name: "order_no", data_type: "text", is_nullable: "NO", column_default: null }] } : { rows: [] };
      }
      return { rows: [] };
    });
    const connector = createSqlDatabaseConnector({ createClient: () => client });
    expect(await run(connector, "list_tables", { schema: "public" }, ctx())).toEqual({ items: [{ table_schema: "public", table_name: "orders", table_type: "BASE TABLE" }], total: 1 });
    expect(client.statements.find((s) => s.text.includes("information_schema.tables"))!.values).toEqual(["public"]);
    expect(await run(connector, "describe_table", { table: "orders" }, ctx())).toMatchObject({ schema: "public", table: "orders", columns: [{ column_name: "order_no" }] });
    expect((await expectConnectorError(connector.execute("describe_table", { table: "nope" }, ctx()))).code).toBe("not_found");
  });

  it("test() reports the database and user", async () => {
    const client = new FakeClient((text) => (text.includes("current_database") ? { rows: [{ database: "reporting", db_user: "readonly", version: "PostgreSQL 17.2" }] } : { rows: [] }));
    const connector = createSqlDatabaseConnector({ createClient: () => client });
    expect(await connector.test(ctx())).toMatchObject({ ok: true, message: 'Connected to database "reporting" as readonly.' });
  });
});
