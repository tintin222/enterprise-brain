import type { NamedAction } from "@enterprise-brain/core";
import { defineConnector, defineManifest } from "../define.ts";
import { readOp, str } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import { configNumber, configString, errorMessage, isRecord, optString, reqString, requireSecret, type Rec } from "../util.ts";

/**
 * SQL databases: PostgreSQL, SQL Server and MySQL. Ad-hoc queries are read-only, with defence in depth:
 * 1. guardReadOnlySql() accepts a single SELECT/WITH statement without
 *    data-modifying keywords, locking clauses or side-effect functions;
 * 2. the query runs in a transaction that is always rolled back (READ ONLY where the database has it)
 *    with a timeout;
 * 3. results are capped (LIMIT, or TOP on SQL Server);
 * 4. customers should still connect with a login that only has SELECT grants.
 * Changes go only through named actions IT writes (SQL with :params), each in its own transaction.
 */

export type SqlDialect = "postgres" | "sqlserver" | "mysql";

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
  dialect?: SqlDialect;
}

export interface SqlDatabaseDeps {
  createClient(config: SqlClientConfig): SqlClient | Promise<SqlClient>;
}

const defaultDeps: SqlDatabaseDeps = {
  async createClient(config) {
    if (config.dialect === "mysql") return mysqlClient(config);
    if (config.dialect === "sqlserver") return sqlServerClient(config);
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

/** MySQL through mysql2: `?` placeholders; a statement that changes data reports its affected rows. */
async function mysqlClient(config: SqlClientConfig): Promise<SqlClient> {
  const mysql = await import("mysql2/promise");
  let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  return {
    async connect() {
      connection = await mysql.createConnection({ uri: config.connectionString, connectTimeout: 10_000 });
    },
    async query(text, values = []) {
      const [rows, fields] = await connection!.query({ sql: text, values, timeout: config.statementTimeoutMs });
      if (Array.isArray(rows)) return { rows: rows as Rec[], fields: (fields ?? []).map((f) => ({ name: f.name })), rowCount: rows.length };
      return { rows: [], rowCount: (rows as { affectedRows?: number }).affectedRows ?? 0 };
    },
    async end() {
      await connection?.end();
    },
  };
}

/** SQL Server through mssql, on one connection (so a transaction holds): `@p1, @p2…` placeholders. */
async function sqlServerClient(config: SqlClientConfig): Promise<SqlClient> {
  const mssql = (await import("mssql")).default;
  let pool: InstanceType<typeof mssql.ConnectionPool> | undefined;
  return {
    async connect() {
      const parsed = mssql.ConnectionPool.parseConnectionString(config.connectionString) as unknown as Record<string, unknown>;
      if (!parsed.server) {
        throw new ConnectorError("SQL Server connection string: use Server=host,1433;Database=…;User Id=…;Password=…;Encrypt=true", "config");
      }
      pool = new mssql.ConnectionPool({
        ...(parsed as object),
        pool: { max: 1, min: 0 },
        requestTimeout: config.statementTimeoutMs,
        connectionTimeout: 10_000,
      } as ConstructorParameters<typeof mssql.ConnectionPool>[0]);
      await pool.connect();
    },
    async query(text, values = []) {
      const request = pool!.request();
      values.forEach((value, i) => request.input(`p${i + 1}`, value as never));
      const result = await request.query(text);
      const rows = (result.recordset ?? []) as unknown as Rec[];
      const columns = result.recordset?.columns ? Object.keys(result.recordset.columns).map((name) => ({ name })) : undefined;
      return { rows, fields: columns, rowCount: result.recordset ? rows.length : (result.rowsAffected?.[0] ?? 0) };
    },
    async end() {
      await pool?.close();
    },
  };
}

interface DialectRules {
  placeholder(index: number): string;
  limit(sql: string, maxRows: number): string;
  begin(readOnly: boolean, timeoutMs: number): string[];
  commit: string;
  rollback: string;
  systemSchemas: string[];
  defaultSchema: string | null;
  info: string;
}

const DIALECTS: Record<SqlDialect, DialectRules> = {
  postgres: {
    placeholder: (i) => `$${i}`,
    limit: (sql, n) => `SELECT * FROM (${sql}) AS q LIMIT ${Math.floor(n)}`,
    begin: (readOnly, t) => [readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN", `SET LOCAL statement_timeout = ${t}`],
    commit: "COMMIT",
    rollback: "ROLLBACK",
    systemSchemas: ["pg_catalog", "information_schema"],
    defaultSchema: "public",
    info: "SELECT current_database() AS database, current_user AS db_user, version() AS version",
  },
  mysql: {
    placeholder: () => "?",
    limit: (sql, n) => `SELECT * FROM (${sql}) AS q LIMIT ${Math.floor(n)}`,
    begin: (readOnly) => [readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION"],
    commit: "COMMIT",
    rollback: "ROLLBACK",
    systemSchemas: ["mysql", "information_schema", "performance_schema", "sys"],
    defaultSchema: null,
    info: "SELECT DATABASE() AS `database`, CURRENT_USER() AS db_user, VERSION() AS version",
  },
  sqlserver: {
    placeholder: (i) => `@p${i}`,
    limit: (sql, n) => `SELECT TOP (${Math.floor(n)}) * FROM (${sql}) AS q`,
    // SQL Server has no read-only transaction: reads run in one that is always rolled back.
    begin: () => ["BEGIN TRANSACTION"],
    commit: "COMMIT TRANSACTION",
    rollback: "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
    systemSchemas: ["sys", "INFORMATION_SCHEMA"],
    defaultSchema: "dbo",
    info: "SELECT DB_NAME() AS [database], SUSER_SNAME() AS db_user, @@VERSION AS version",
  },
};

function dialectOf(ctx: ConnectorContext): SqlDialect {
  const value = configString(ctx, "dialect", "postgres");
  return value === "sqlserver" || value === "mysql" ? value : "postgres";
}

export const DEFAULT_MAX_ROWS = 500;

/**
 * A single statement starting with SELECT/WITH can still modify data through
 * data-modifying CTEs (INSERT/UPDATE/DELETE/MERGE), SELECT INTO or locking
 * clauses. DDL words are listed too; other keywords are not blocked because
 * they are common column names (load, release, comment...).
 */
const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "into", "drop", "alter", "create", "truncate", "grant", "revoke", "copy", "vacuum", "execute", "exec", "waitfor",
];

const FORBIDDEN_FUNCTIONS =
  /\b(pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|set_config|lo_\w+|pg_read_\w*file|pg_ls_\w+|pg_stat_file|pg_file_\w+|dblink\w*|pg_advisory\w*|pg_try_advisory\w*|nextval|setval|pg_notify|txid_current|pg_current_xact_id|sleep|benchmark|load_file|get_lock|openrowset|opendatasource|openquery|xp_\w+)\s*\(/i;

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
export function limitQuery(sql: string, maxRows: number, dialect: SqlDialect = "postgres"): string {
  return DIALECTS[dialect].limit(sql, maxRows);
}

/**
 * `:name` parameters of a named action's SQL in the database's placeholder style, with their values
 * in order. Text in quotes and PostgreSQL casts (`::date`) are left alone; missing values bind as NULL.
 */
export function bindNamedParams(sql: string, dialect: SqlDialect, values: Record<string, unknown>): { text: string; params: unknown[] } {
  const { code, masked } = scan(sql);
  const params: unknown[] = [];
  const indexes = new Map<string, number>();
  let text = "";
  let last = 0;
  for (const match of masked.matchAll(/(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1]!;
    const value = values[name] ?? null;
    let index: number;
    if (dialect === "mysql") {
      params.push(value);
      index = params.length;
    } else {
      index = indexes.get(name) ?? params.push(value);
      indexes.set(name, index);
    }
    text += code.slice(last, match.index) + DIALECTS[dialect].placeholder(index);
    last = match.index! + match[0].length;
  }
  return { text: (text + code.slice(last)).trim().replace(/;\s*$/, ""), params };
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
  // MySQL and SQL Server
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ELOGIN") return new ConnectorError(`Database rejected the credentials: ${message}`, "auth");
  if (code === "ER_TABLEACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") return new ConnectorError(`Permission denied: ${message}`, "auth");
  if (code === "ER_NO_SUCH_TABLE") return new ConnectorError(`Unknown table: ${message}`, "validation");
  if (code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION") return new ConnectorError("Only read-only queries are allowed", "validation");
  if (code === "ER_PARSE_ERROR" || code === "ER_BAD_FIELD_ERROR" || code === "EREQUEST") return new ConnectorError(`Invalid query: ${message}`, "validation");
  if (code === "ETIMEOUT" || code === "PROTOCOL_SEQUENCE_TIMEOUT") return new ConnectorError("Query was cancelled (timeout)", "remote");
  return new ConnectorError(`Database error: ${message}`, "remote");
}

const manifest = defineManifest({
  type: "sql-database",
  name: "SQL database",
  vendor: "PostgreSQL · SQL Server · MySQL",
  category: "database",
  description:
    "Connects a PostgreSQL, SQL Server or MySQL database (reporting replicas, data warehouses, MES/WMS and ERP databases). Ad-hoc queries are read-only single SELECT/WITH statements with a row limit and timeout; IT saves named queries and changes as named actions.",
  auth: "basic",
  docsUrl: "https://www.postgresql.org/docs/current/sql-select.html",
  maturity: "preview",
  config: [
    {
      key: "dialect",
      label: "Database",
      type: "select",
      default: "postgres",
      options: [
        { value: "postgres", label: "PostgreSQL" },
        { value: "sqlserver", label: "Microsoft SQL Server" },
        { value: "mysql", label: "MySQL / MariaDB" },
      ],
    },
    {
      key: "connection_string",
      label: "Connection string",
      type: "password",
      required: true,
      secret: true,
      placeholder: "postgresql://readonly_user:password@db.acme.local:5432/reporting?sslmode=require",
      help: "SQL Server: Server=db.acme.local,1433;Database=erp;User Id=eb_reader;Password=…;Encrypt=true · MySQL: mysql://eb_reader:…@db.acme.local:3306/erp",
    },
    { key: "max_rows", label: "Maximum rows per query", type: "number", default: DEFAULT_MAX_ROWS },
    { key: "statement_timeout_ms", label: "Statement timeout (ms)", type: "number", default: 15_000 },
  ],
  operations: [
    readOp("run_query", "Run SQL query", `Run one read-only SELECT (or WITH ... SELECT) statement; at most ${DEFAULT_MAX_ROWS} rows are returned. Pass values with params and placeholders: $1, $2… (PostgreSQL), ? (MySQL) or @p1, @p2… (SQL Server).`, {
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
    "A connection string (host, port, database) with TLS: PostgreSQL, SQL Server or MySQL",
    "A dedicated read-only database login with SELECT grants on the required schemas/tables only, ideally on a read replica; a separate login with the needed grants for connections that run named write actions",
    "Network access from Enterprise Brain to the database port (firewall rule / private link)",
  ],
});

export function createSqlDatabaseConnector(deps: Partial<SqlDatabaseDeps> = {}): ConnectorImplementation {
  const factories: SqlDatabaseDeps = { ...defaultDeps, ...deps };

  /**
   * Runs statements in a transaction: reads are always rolled back (READ ONLY where the database has
   * it); writes (named actions) commit when they succeed.
   */
  async function session<T>(ctx: ConnectorContext, mode: "read" | "write", task: (client: SqlClient, rules: DialectRules) => Promise<T>): Promise<T> {
    const timeout = Math.max(1_000, Math.floor(configNumber(ctx, "statement_timeout_ms", 15_000)));
    const dialect = dialectOf(ctx);
    const rules = DIALECTS[dialect];
    const client = await factories.createClient({
      connectionString: requireSecret(ctx, "connection_string", "Connection string"),
      statementTimeoutMs: timeout,
      ...(dialect === "postgres" ? {} : { dialect }),
    });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw mapDbError(error);
    }
    let committed = false;
    try {
      for (const statement of rules.begin(mode === "read", timeout)) await client.query(statement);
      const result = await task(client, rules);
      if (mode === "write") {
        await client.query(rules.commit);
        committed = true;
      }
      return result;
    } catch (error) {
      throw mapDbError(error);
    } finally {
      if (!committed) await client.query(rules.rollback).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
  const readOnly = <T>(ctx: ConnectorContext, task: (client: SqlClient, rules: DialectRules) => Promise<T>) => session(ctx, "read", task);

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

  /**
   * A named action IT wrote: its SQL with :params bound for the database. Read actions run like ad-hoc
   * queries (rolled back, rows capped); write actions commit, and report the rows they changed.
   */
  async function runAction(action: NamedAction, values: Rec, ctx: ConnectorContext): Promise<unknown> {
    if (!action.sql) throw new ConnectorError(`${action.name} has no SQL statement`, "config");
    const { text, params } = bindNamedParams(action.sql, dialectOf(ctx), values);
    if (action.kind === "read") {
      const maxRows = Math.min(Math.max(1, Math.floor(configNumber(ctx, "max_rows", DEFAULT_MAX_ROWS))), 5_000);
      const result = await session(ctx, "read", (client) => client.query(text, params));
      return { ...toResult({ ...result, rows: result.rows.slice(0, maxRows) }), truncated: result.rows.length > maxRows, max_rows: maxRows };
    }
    const result = await session(ctx, "write", (client) => client.query(text, params));
    return { ok: true, affected_rows: result.rowCount ?? result.rows.length, ...(result.rows.length ? { rows: toResult(result).rows } : {}) };
  }

  const connector = defineConnector({
    manifest,

    async test(ctx) {
      const info = await readOnly(ctx, (client, rules) => client.query(rules.info));
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
        const result = await readOnly(ctx, (client) => client.query(limitQuery(sql, maxRows, dialectOf(ctx)), params));
        return toResult(result, maxRows);
      },

      async list_tables(input, ctx) {
        const schema = optString(input, "schema") ?? null;
        const dialect = dialectOf(ctx);
        const result = await readOnly(ctx, (client, rules) => {
          const system = rules.systemSchemas.map((name) => `'${name}'`).join(", ");
          const text = `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN (${system})${schema ? ` AND table_schema = ${rules.placeholder(1)}` : ""} ORDER BY table_schema, table_name`;
          return client.query(dialect === "postgres" ? `${text} LIMIT 1000` : limitQuery(text.replace(/ ORDER BY .*$/, ""), 1000, dialect), schema ? [schema] : []);
        });
        const items = toResult(result).rows as Rec[];
        return { items, total: items.length };
      },

      async describe_table(input, ctx) {
        const table = reqString(input, "table");
        const dialect = dialectOf(ctx);
        const schema = optString(input, "schema") ?? DIALECTS[dialect].defaultSchema ?? null;
        const result = await readOnly(ctx, (client, rules) =>
          client.query(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = ${schema ? rules.placeholder(1) : "DATABASE()"} AND table_name = ${rules.placeholder(schema ? 2 : 1)} ORDER BY ordinal_position`,
            schema ? [schema, table] : [table],
          ),
        );
        if (result.rows.length === 0) throw new ConnectorError(`Table ${schema}.${table} not found or not visible`, "not_found");
        return { schema, table, columns: toResult(result).rows };
      },
    },
  });
  return { ...connector, runAction };
}

export const sqlDatabaseConnector = createSqlDatabaseConnector();
