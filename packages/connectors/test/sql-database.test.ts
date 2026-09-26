import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  bindNamedParams,
  createSqlDatabaseConnector,
  guardReadOnlySql,
  limitQuery,
  parseOracleConnection,
  sqlDatabaseConnector,
  withNamedActions,
  type SqlClient,
  type SqlQueryResult,
} from "../src/index.ts";
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

describe("Oracle databases", () => {
  const oracleCtx = (config: Record<string, unknown> = {}) =>
    makeCtx({ config: { dialect: "oracle", max_rows: 50, statement_timeout_ms: 15000, ...config }, secrets: { connection_string: "oracle://eb_reader:p%40ss@db.acme.example:1521/ERPPDB" } });
  const oracleError = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code, errorNum: Number(code.slice(4)) });

  it("reads the connection string in the forms Oracle people use", () => {
    expect(parseOracleConnection("oracle://eb_reader:p%40ss@db.acme.example:1521/ERPPDB")).toEqual({ user: "eb_reader", password: "p@ss", connectString: "db.acme.example:1521/ERPPDB" });
    expect(parseOracleConnection("oracle://eb:pw@db.acme.example:2484/ERPPDB?protocol=tcps").connectString).toBe("tcps://db.acme.example:2484/ERPPDB");
    expect(parseOracleConnection("eb_reader/p@ss/w@db.acme.example:1521/ERPPDB")).toEqual({ user: "eb_reader", password: "p@ss/w", connectString: "db.acme.example:1521/ERPPDB" });
    expect(
      parseOracleConnection("User Id=eb_reader;Password=pw;Data Source=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ERPPDB)))"),
    ).toEqual({ user: "eb_reader", password: "pw", connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ERPPDB)))" });
    expect(() => parseOracleConnection("db.acme.example:1521/ERPPDB")).toThrow(/Oracle connection string/);
  });

  it("keeps Oracle's packages that reach outside the query out of ad-hoc reads", () => {
    expect(rejects("SELECT dbms_lock.sleep(60) FROM dual").message).toMatch(/dbms_lock is not allowed/);
    expect(rejects("SELECT utl_http.request('http://attacker.example/') FROM dual").message).toMatch(/utl_http is not allowed/);
    expect(rejects("SELECT sys.dbms_pipe.receive_message('x', 5) FROM dual").message).toMatch(/sys\.dbms_pipe is not allowed/);
    expect(rejects("SELECT httpuritype('http://attacker.example/').getclob() FROM dual").message).toMatch(/httpuritype is not allowed/);
    expect(rejects("SELECT * FROM orders FOR UPDATE NOWAIT").message).toMatch(/UPDATE/);
    expect(guardReadOnlySql("SELECT order_no, TO_CHAR(created, 'YYYY-MM-DD') AS day, NVL(note, '-') AS note FROM orders WHERE ROWNUM <= 10")).toMatch(/^SELECT order_no/);
    expect(limitQuery("SELECT * FROM orders ORDER BY created DESC", 50, "oracle")).toBe("SELECT * FROM (SELECT * FROM orders ORDER BY created DESC) q FETCH FIRST 50 ROWS ONLY");
  });

  it("reads in a read-only transaction that is rolled back, with :1 binds and a row limit", async () => {
    const client = new FakeClient((text) =>
      text.startsWith("SELECT * FROM (") ? { fields: [{ name: "ORDER_NO" }, { name: "CREATED" }], rows: [{ ORDER_NO: "SO-1", CREATED: new Date("2026-09-01T08:00:00Z") }] } : { rows: [] },
    );
    let received: unknown;
    const connector = createSqlDatabaseConnector({
      createClient: (config) => {
        received = config;
        return client;
      },
    });
    const result = await run(connector, "run_query", { sql: "SELECT order_no, created FROM orders WHERE customer_id = :1", params: ["C-1"] }, oracleCtx());
    expect(received).toEqual({ connectionString: "oracle://eb_reader:p%40ss@db.acme.example:1521/ERPPDB", statementTimeoutMs: 15000, dialect: "oracle" });
    expect(client.statements.map((s) => s.text)).toEqual([
      "SET TRANSACTION READ ONLY",
      "SELECT * FROM (SELECT order_no, created FROM orders WHERE customer_id = :1) q FETCH FIRST 50 ROWS ONLY",
      "ROLLBACK",
    ]);
    expect(result).toMatchObject({ columns: ["ORDER_NO", "CREATED"], rows: [{ ORDER_NO: "SO-1", CREATED: "2026-09-01T08:00:00.000Z" }] });
  });

  it("binds a named action's :params once per use, and commits changes", async () => {
    expect(bindNamedParams("SELECT * FROM orders WHERE customer_id = :customer OR payer_id = :customer AND created > :since", "oracle", { customer: "C-1", since: "2026-01-01" })).toEqual({
      text: "SELECT * FROM orders WHERE customer_id = :1 OR payer_id = :2 AND created > :3",
      params: ["C-1", "C-1", "2026-01-01"],
    });
    const client = new FakeClient((text) => (text.startsWith("UPDATE") ? { rows: [], rowCount: 1 } : { rows: [] }));
    const connector = withNamedActions(createSqlDatabaseConnector({ createClient: () => client }), [
      { id: "block_order", name: "Block an order", description: "", kind: "write", params: [{ key: "order_no", type: "string", required: true }], sql: "UPDATE orders SET status = 'BLOCKED' WHERE order_no = :order_no" },
    ]);
    expect(await connector.execute("block_order", { order_no: "SO-1" }, oracleCtx())).toEqual({ ok: true, affected_rows: 1 });
    expect(client.statements.map((s) => [s.text, s.values])).toEqual([
      ["UPDATE orders SET status = 'BLOCKED' WHERE order_no = :1", ["SO-1"]],
      ["COMMIT", undefined],
    ]);
  });

  it("lists and describes tables from Oracle's catalog, in capitals", async () => {
    const client = new FakeClient((text) =>
      text.includes("all_tab_columns")
        ? { rows: [{ column_name: "ORDER_NO", data_type: "VARCHAR2", is_nullable: "NO", column_default: null }] }
        : { rows: [{ table_schema: "ERP", table_name: "ORDERS", table_type: "BASE TABLE" }] },
    );
    const connector = createSqlDatabaseConnector({ createClient: () => client });
    expect(await run(connector, "list_tables", { schema: "erp" }, oracleCtx())).toMatchObject({ items: [{ table_name: "ORDERS" }], total: 1 });
    expect(client.statements[1]!.text).toMatch(/FROM all_tables WHERE owner NOT IN \(SELECT username FROM all_users WHERE oracle_maintained = 'Y'\) AND owner = :1/);
    expect(client.statements[1]!.values).toEqual(["ERP", "ERP"]);
    expect(await run(connector, "describe_table", { table: "orders" }, oracleCtx())).toMatchObject({ table: "ORDERS", columns: [{ column_name: "ORDER_NO" }] });
    expect(client.statements.at(-2)!.values).toEqual(["ORDERS"]);
    expect(client.statements.at(-2)!.text).toMatch(/owner = SYS_CONTEXT\('USERENV', 'CURRENT_SCHEMA'\) AND table_name = :1/);
  });

  it("puts Oracle's errors in plain words", async () => {
    const failing = (error: Error) => createSqlDatabaseConnector({ createClient: () => new FakeClient((text) => (text.startsWith("SELECT * FROM (") ? error : { rows: [] })) });
    const ask = (connector: ReturnType<typeof failing>) => expectConnectorError(connector.execute("run_query", { sql: "SELECT * FROM ordrs" }, oracleCtx()));
    expect(await ask(failing(oracleError("ORA-00942", "table or view does not exist")))).toMatchObject({ code: "validation", message: /^Unknown table: ORA-00942/ });
    expect(await ask(failing(oracleError("ORA-01031", "insufficient privileges")))).toMatchObject({ code: "auth" });
    expect(await ask(failing(Object.assign(new Error("DPI-1067: call timeout of 15000 ms exceeded"), { code: "DPI-1067" })))).toMatchObject({ message: "Query was cancelled (timeout)" });
    const refusing = createSqlDatabaseConnector({
      createClient: () => Object.assign(new FakeClient(), { connect: () => Promise.reject(oracleError("ORA-01017", "invalid credential or not authorized; logon denied")) }),
    });
    expect(await refusing.test(oracleCtx())).toMatchObject({ ok: false, details: { code: "auth" } });
  });

  it("uses the real driver without Oracle's client software, and says when the database can't be reached", async () => {
    const ctx = makeCtx({ config: { dialect: "oracle" }, secrets: { connection_string: "oracle://eb:pw@127.0.0.1:1/NOWHERE" } });
    const outcome = await sqlDatabaseConnector.test(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/^Database error: .*(ECONNREFUSED|NJS-5\d\d|refused|connect)/i);
  });
});
