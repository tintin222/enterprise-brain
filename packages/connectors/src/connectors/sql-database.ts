import { defineConnector, defineManifest } from "../define.ts";
import { readOp, str } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import { configNumber, errorMessage, isRecord, optString, reqString, requireSecret, type Rec } from "../util.ts";

/**
 * PostgreSQL connector for read-only reporting queries. Defence in depth:
 * 1. guardReadOnlySql() accepts a single SELECT/WITH statement without
 *    data-modifying keywords, locking clauses or side-effect functions;
 * 2. the query runs in a READ ONLY transaction with a statement timeout;
 * 3. results are capped by wrapping: SELECT * FROM (<sql>) AS q LIMIT <n>;
 * 4. customers should still connect with a role that only has SELECT grants.
 */

export interface SqlQueryResult {
  rows: Rec[];
  fields?: Array<{ name: string }>;
  rowCount?: number | null;
}

/** The subset of pg.Client used by the connector. */
export interface SqlClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<SqlQueryResult>;
  end(): Promise<unknown>;
}

export interface SqlClientConfig {
  connectionString: string;
  statementTimeoutMs: number;
}

export interface SqlDatabaseDeps {
  createClient(config: SqlClientConfig): SqlClient | Promise<SqlClient>;
}

const defaultDeps: SqlDatabaseDeps = {
  async createClient(config) {
    const { Client } = await import("pg");
    return new Client({
      connectionString: config.connectionString,
      statement_timeout: config.statementTimeoutMs,
      query_timeout: config.statementTimeoutMs + 5_000,
      connectionTimeoutMillis: 10_000,
      application_name: "enterprise-brain",
    });
  },
};

export const DEFAULT_MAX_ROWS = 500;

/**
 * A single statement starting with SELECT/WITH can still modify data through
 * data-modifying CTEs (INSERT/UPDATE/DELETE/MERGE), SELECT INTO or locking
 * clauses. DDL words are listed too; other keywords are not blocked because
 * they are common column names (load, release, comment...).
 */
const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "into", "drop", "alter", "create", "truncate", "grant", "revoke", "copy", "vacuum", "execute",
];

const FORBIDDEN_FUNCTIONS =
  /\b(pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|set_config|lo_\w+|pg_read_\w*file|pg_ls_\w+|pg_stat_file|pg_file_\w+|dblink\w*|pg_advisory\w*|pg_try_advisory\w*|nextval|setval|pg_notify|txid_current|pg_current_xact_id)\s*\(/i;

interface Scanned {
  /** SQL with comments replaced by spaces (literals kept). */
  code: string;
  /** Same length as `code`, with string literals and quoted identifiers blanked out. */
  masked: string;
}

/** Splits SQL into code and literals; throws on unterminated strings or comments. */
function scan(sql: string): Scanned {
  let code = "";
  let masked = "";
  let i = 0;
  const push = (text: string, mask: string) => {
    code += text;
    masked += mask;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      push(" ".repeat(stop - i), " ".repeat(stop - i));
      i = stop;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) throw new ConnectorError("Unterminated block comment in SQL", "validation");
      push(" ".repeat(j - i), " ".repeat(j - i));
      i = j;
    } else if (ch === "'") {
      // E'...' strings allow backslash escapes; standard strings only ''.
      const escapes = /[eE]$/.test(code) && !/[A-Za-z0-9_][eE]$/.test(code);
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new ConnectorError("Unterminated string literal in SQL", "validation");
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      push(sql.slice(i, j + 1), `'${"_".repeat(j - i - 1)}'`);
      i = j + 1;
    } else if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new ConnectorError("Unterminated quoted identifier in SQL", "validation");
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      push(sql.slice(i, j + 1), `"${"_".repeat(j - i - 1)}"`);
      i = j + 1;
    } else if (ch === "$" && !/[A-Za-z0-9_]$/.test(code)) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new ConnectorError("Unterminated dollar-quoted string in SQL", "validation");
        const stop = end + tag.length;
        push(sql.slice(i, stop), `$${"_".repeat(stop - i - 2)}$`);
        i = stop;
      } else {
        push(ch, ch);
        i++;
      }
    } else {
      push(ch, ch);
      i++;
    }
  }
  return { code, masked };
}

/**
 * Validates that `sql` is a single read-only SELECT (or WITH ... SELECT)
 * statement and returns it without comments and trailing semicolons.
 * Throws a ConnectorError("validation") otherwise.
 */
export function guardReadOnlySql(sql: string): string {
  const { code, masked } = scan(sql);
  const trailing = /[\s;]*$/.exec(masked)?.[0].length ?? 0;
  const body = code.slice(0, code.length - trailing).trim();
  const bodyMasked = masked.slice(0, masked.length - trailing).trim();
  if (!bodyMasked) throw new ConnectorError("SQL query is empty", "validation");
  if (bodyMasked.includes(";")) throw new ConnectorError("Only a single SQL statement is allowed (found ';')", "validation");
  const first = /^[\s(]*([A-Za-z]+)/.exec(bodyMasked)?.[1]?.toLowerCase();
  if (first !== "select" && first !== "with") {
    throw new ConnectorError(`Only SELECT or WITH queries are allowed (statement starts with ${first ? first.toUpperCase() : "an unexpected token"})`, "validation");
  }
  const words = new Set(bodyMasked.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []);
  const forbidden = FORBIDDEN_KEYWORDS.find((keyword) => words.has(keyword));
  if (forbidden) throw new ConnectorError(`Read-only queries must not contain ${forbidden.toUpperCase()}`, "validation");
  if (/\bfor\s+(no\s+key\s+|key\s+)?share\b/i.test(bodyMasked)) throw new ConnectorError("Locking clauses (FOR SHARE) are not allowed", "validation");
  const fn = FORBIDDEN_FUNCTIONS.exec(bodyMasked);
  if (fn) throw new ConnectorError(`Function ${fn[1]} is not allowed in read-only queries`, "validation");
  let depth = 0;
  for (const ch of bodyMasked) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) break;
  }
  if (depth !== 0) throw new ConnectorError("Unbalanced parentheses in SQL", "validation");
  return body;
}

/** Wraps a guarded query so at most `maxRows` rows are returned. */
export function limitQuery(sql: string, maxRows: number): string {
  return `SELECT * FROM (${sql}) AS q LIMIT ${Math.floor(maxRows)}`;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  return value;
}

function mapDbError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const message = errorMessage(error);
  if (code === "28P01" || code === "28000") return new ConnectorError(`Database rejected the credentials: ${message}`, "auth");
  if (code === "42501") return new ConnectorError(`Permission denied: ${message}`, "auth");
  if (code === "25006") return new ConnectorError("Only read-only queries are allowed", "validation");
  if (code === "57014") return new ConnectorError("Query was cancelled (statement timeout)", "remote");
  if (code === "42P01") return new ConnectorError(`Unknown table: ${message}`, "validation");
  if (/^(22|42)/.test(code)) return new ConnectorError(`Invalid query: ${message}`, "validation");
  return new ConnectorError(`Database error: ${message}`, "remote");
}

const manifest = defineManifest({
  type: "sql-database",
  name: "SQL database (PostgreSQL)",
  vendor: "PostgreSQL",
  category: "database",
  description:
    "Runs read-only SQL queries against a PostgreSQL database (reporting replicas, data warehouses, MES/WMS databases). Only single SELECT/WITH statements are accepted, executed in a read-only transaction with a row limit and timeout.",
  auth: "basic",
  docsUrl: "https://www.postgresql.org/docs/current/sql-select.html",
  maturity: "preview",
  config: [
    {
      key: "connection_string",
      label: "Connection string",
      type: "password",
      required: true,
      secret: true,
      placeholder: "postgresql://readonly_user:password@db.acme.local:5432/reporting?sslmode=require",
    },
    { key: "max_rows", label: "Maximum rows per query", type: "number", default: DEFAULT_MAX_ROWS },
    { key: "statement_timeout_ms", label: "Statement timeout (ms)", type: "number", default: 15_000 },
  ],
  operations: [
    readOp("run_query", "Run SQL query", `Run one read-only SELECT (or WITH ... SELECT) statement; at most ${DEFAULT_MAX_ROWS} rows are returned. Use $1, $2... placeholders with params for values.`, {
      sql: str("SELECT statement, e.g. SELECT order_no, status FROM orders WHERE customer_id = $1 ORDER BY created_at DESC"),
      params: { type: "array", items: {}, description: "Values for $1, $2... placeholders (strings, numbers, booleans or null)" },
    }, ["sql"]),
    readOp("list_tables", "List tables", "Tables and views visible to the database user.", {
      schema: str("Only this schema, e.g. public"),
    }),
    readOp("describe_table", "Describe table", "Columns of a table or view with data types.", {
      table: str("Table or view name"),
      schema: str("Schema (default public)"),
    }, ["table"]),
  ],
  itRequirements: [
    "A PostgreSQL connection string (host, port, database) with TLS (sslmode=require)",
    "A dedicated read-only database role with CONNECT and SELECT grants on the required schemas/tables only, ideally on a read replica",
    "Network access from Enterprise Brain to the database port (firewall rule / private link)",
  ],
});

export function createSqlDatabaseConnector(deps: Partial<SqlDatabaseDeps> = {}): ConnectorImplementation {
  const factories: SqlDatabaseDeps = { ...defaultDeps, ...deps };

  /** Runs statements in a READ ONLY transaction that is always rolled back. */
  async function readOnly<T>(ctx: ConnectorContext, task: (client: SqlClient) => Promise<T>): Promise<T> {
    const timeout = Math.max(1_000, Math.floor(configNumber(ctx, "statement_timeout_ms", 15_000)));
    const client = await factories.createClient({
      connectionString: requireSecret(ctx, "connection_string", "Connection string"),
      statementTimeoutMs: timeout,
    });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw mapDbError(error);
    }
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      return await task(client);
    } catch (error) {
      throw mapDbError(error);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }

  function toResult(result: SqlQueryResult, maxRows?: number): Rec {
    const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonSafe(v)])));
    const columns = result.fields?.map((f) => f.name) ?? Object.keys(rows[0] ?? {});
    return {
      columns,
      rows,
      row_count: rows.length,
      ...(maxRows !== undefined ? { truncated: rows.length >= maxRows, max_rows: maxRows } : {}),
    };
  }

  return defineConnector({
    manifest,

    async test(ctx) {
      const info = await readOnly(ctx, (client) => client.query("SELECT current_database() AS database, current_user AS db_user, version() AS version"));
      const row = info.rows[0] ?? {};
      return {
        ok: true,
        message: `Connected to database "${String(row.database ?? "?")}" as ${String(row.db_user ?? "?")}.`,
        details: { version: row.version },
      };
    },

    operations: {
      async run_query(input, ctx) {
        const sql = guardReadOnlySql(reqString(input, "sql"));
        const maxRows = Math.min(Math.max(1, Math.floor(configNumber(ctx, "max_rows", DEFAULT_MAX_ROWS))), 5_000);
        const params = input.params === undefined || input.params === null ? [] : input.params;
        if (!Array.isArray(params) || params.some((p) => p !== null && typeof p === "object")) {
          throw new ConnectorError("params must be a list of strings, numbers, booleans or null", "validation");
        }
        const result = await readOnly(ctx, (client) => client.query(limitQuery(sql, maxRows), params));
        return toResult(result, maxRows);
      },

      async list_tables(input, ctx) {
        const schema = optString(input, "schema") ?? null;
        const result = await readOnly(ctx, (client) =>
          client.query(
            `SELECT table_schema, table_name, table_type FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND ($1::text IS NULL OR table_schema = $1)
             ORDER BY table_schema, table_name LIMIT 1000`,
            [schema],
          ),
        );
        const items = toResult(result).rows as Rec[];
        return { items, total: items.length };
      },

      async describe_table(input, ctx) {
        const table = reqString(input, "table");
        const schema = optString(input, "schema") ?? "public";
        const result = await readOnly(ctx, (client) =>
          client.query(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [schema, table],
          ),
        );
        if (result.rows.length === 0) throw new ConnectorError(`Table ${schema}.${table} not found or not visible`, "not_found");
        return { schema, table, columns: toResult(result).rows };
      },
    },
  });
}

export const sqlDatabaseConnector = createSqlDatabaseConnector();
