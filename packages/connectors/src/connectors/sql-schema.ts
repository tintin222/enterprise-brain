import type { SqlClient, SqlDialect } from "./sql-database.ts";

/** A table or view as the database describes it: its columns, keys, the tables it points to, its size and comments. */
export interface SchemaTable {
  schema: string | null;
  name: string;
  type: "Table" | "View";
  /** About how many rows (the database's own estimate); null when it doesn't say. */
  rows: number | null;
  comment: string;
  columns: SchemaColumn[];
  foreign_keys: SchemaForeignKey[];
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  comment: string;
}

export interface SchemaForeignKey {
  columns: string[];
  ref_schema: string | null;
  ref_table: string;
  ref_columns: string[];
}

export interface DatabaseSchema {
  dialect: SqlDialect;
  tables: SchemaTable[];
  /** More tables than were read (only the first ones are). */
  truncated: boolean;
  /** What could not be read (comments or sizes the login may not see). */
  notes: string[];
}

export const MAX_SCHEMA_TABLES = 500;

type Row = Record<string, unknown>;

/** Column names in the case the database sent them (Oracle and SQL Server send capitals). */
function field(row: Row, name: string): unknown {
  if (name in row) return row[name];
  const upper = name.toUpperCase();
  if (upper in row) return row[upper];
  const found = Object.keys(row).find((key) => key.toLowerCase() === name);
  return found ? row[found] : undefined;
}

function text(row: Row, name: string): string {
  const value = field(row, name);
  return value === null || value === undefined ? "" : String(value).trim();
}

function count(row: Row, name: string): number | null {
  const value = Number(field(row, name));
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** "character varying" + 12 → "varchar(12)"; "numeric" + 8, 2 → "numeric(8,2)". */
function typeOf(row: Row, dialect: SqlDialect): string {
  const raw = text(row, "data_type");
  const lower = raw.toLowerCase();
  if (dialect === "mysql") return text(row, "column_type") || raw;
  const short: Record<string, string> = {
    "character varying": "varchar",
    character: "char",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz",
    "time without time zone": "time",
    "double precision": "double",
  };
  let base = dialect === "postgres" && (lower === "user-defined" || lower === "array") ? text(row, "udt_name") : (short[lower] ?? raw);
  const length = Number(field(row, dialect === "oracle" ? "data_length" : "character_maximum_length"));
  const precision = Number(field(row, dialect === "oracle" ? "data_precision" : "numeric_precision"));
  const scale = Number(field(row, dialect === "oracle" ? "data_scale" : "numeric_scale"));
  const textual = /char|binary|raw/i.test(base) && !/^(text|ntext)$/i.test(base);
  if (textual && Number.isFinite(length) && length !== 0) base += length < 0 ? "(max)" : `(${length})`;
  else if (/^(numeric|decimal|number)$/i.test(base) && Number.isFinite(precision) && precision > 0) {
    base += Number.isFinite(scale) && scale > 0 ? `(${precision},${scale})` : `(${precision})`;
  }
  return base;
}

class Assembly {
  readonly tables = new Map<string, SchemaTable>();
  /** Tables the database listed, also past the ones kept. */
  seen = 0;
  private readonly keys = new Map<string, { table: SchemaTable; columns: { name: string; at: number }[] }>();
  private readonly targets = new Map<string, { schema: string | null; table: string; columns: { name: string; at: number }[] }>();

  constructor(private readonly dialect: SqlDialect) {}

  private id(schema: string, table: string): string {
    return `${schema.toLowerCase()}.${table.toLowerCase()}`;
  }

  find(schema: string, table: string): SchemaTable | undefined {
    return this.tables.get(this.id(schema, table));
  }

  table(row: Row): void {
    const schema = text(row, "table_schema");
    const name = text(row, "table_name");
    if (!name) return;
    this.seen++;
    if (this.tables.size >= MAX_SCHEMA_TABLES) return;
    const type = /view/i.test(text(row, "table_type")) ? "View" : "Table";
    this.tables.set(this.id(schema, name), {
      schema: schema || null,
      name,
      type,
      rows: count(row, "table_rows"),
      comment: text(row, "table_comment"),
      columns: [],
      foreign_keys: [],
    });
  }

  column(row: Row): void {
    const table = this.find(text(row, "table_schema"), text(row, "table_name"));
    if (!table) return;
    table.columns.push({
      name: text(row, "column_name"),
      type: typeOf(row, this.dialect),
      nullable: /^(y|yes|true|1)$/i.test(text(row, "is_nullable")),
      primary: /^pri/i.test(text(row, "column_key")),
      comment: text(row, "column_comment"),
    });
  }

  /** A column of a primary key or a foreign key. */
  keyPart(row: Row): void {
    const table = this.find(text(row, "table_schema"), text(row, "table_name"));
    if (!table) return;
    const kind = text(row, "constraint_type").toUpperCase();
    const column = text(row, "column_name");
    if (kind === "PRIMARY KEY" || kind === "P") {
      const found = table.columns.find((c) => c.name === column);
      if (found) found.primary = true;
      return;
    }
    const id = `${text(row, "constraint_schema") || text(row, "table_schema")}.${text(row, "constraint_name")}`.toLowerCase();
    if (!this.keys.has(id)) this.keys.set(id, { table, columns: [] });
    this.keys.get(id)!.columns.push({ name: column, at: Number(field(row, "ordinal_position")) || 0 });
  }

  /** A column a foreign key points to. */
  target(row: Row): void {
    const id = `${text(row, "constraint_schema")}.${text(row, "constraint_name")}`.toLowerCase();
    if (!this.targets.has(id)) this.targets.set(id, { schema: text(row, "ref_schema") || null, table: text(row, "ref_table"), columns: [] });
    this.targets.get(id)!.columns.push({ name: text(row, "ref_column"), at: Number(field(row, "ordinal_position")) || 0 });
  }

  /** A foreign key given in one row per column, with what it points to (MySQL). */
  directKey(row: Row): void {
    this.keyPart({ ...row, constraint_type: "FOREIGN KEY", constraint_schema: text(row, "table_schema") });
    this.target({
      constraint_schema: text(row, "table_schema"),
      constraint_name: text(row, "constraint_name"),
      ref_schema: text(row, "ref_schema"),
      ref_table: text(row, "ref_table"),
      ref_column: text(row, "ref_column"),
      ordinal_position: field(row, "ordinal_position"),
    });
  }

  comment(row: Row): void {
    const table = this.find(text(row, "table_schema"), text(row, "table_name"));
    if (!table) return;
    const column = text(row, "column_name");
    const words = text(row, "comment");
    if (column) {
      const found = table.columns.find((c) => c.name === column);
      if (found && words) found.comment = words;
    } else if (words) table.comment = words;
  }

  size(row: Row): void {
    const table = this.find(text(row, "table_schema"), text(row, "table_name"));
    const rows = count(row, "rows");
    // A view has no rows of its own.
    if (table && table.type === "Table" && rows !== null) table.rows = rows;
  }

  finish(): SchemaTable[] {
    for (const [id, key] of this.keys) {
      const target = this.targets.get(id);
      if (!target?.table) continue;
      key.table.foreign_keys.push({
        columns: key.columns.sort((a, b) => a.at - b.at).map((c) => c.name),
        ref_schema: target.schema,
        ref_table: target.table,
        ref_columns: target.columns.sort((a, b) => a.at - b.at).map((c) => c.name),
      });
    }
    return [...this.tables.values()];
  }
}

type Query = (text: string, values?: unknown[]) => Promise<Row[]>;

/** Runs a query whose rows only add to what is known (comments, sizes); a login that can't see them doesn't stop the reading. */
async function optional(run: Query, notes: string[], what: string, textValue: string, values: unknown[] = []): Promise<Row[]> {
  try {
    return await run(textValue, values);
  } catch {
    notes.push(`Could not read ${what}`);
    return [];
  }
}

async function postgres(run: Query, a: Assembly, notes: string[], schema: string | null): Promise<void> {
  const where = (column: string) => (schema ? `${column} = $1` : `${column} NOT IN ('pg_catalog', 'information_schema') AND ${column} !~ '^pg_(temp|toast)'`);
  const values = schema ? [schema] : [];
  for (const row of await run(
    `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where("table_schema")} ORDER BY table_schema, table_name LIMIT ${MAX_SCHEMA_TABLES + 1}`,
    values,
  ))
    a.table(row);
  for (const row of await run(
    `SELECT table_schema, table_name, column_name, data_type, udt_name, character_maximum_length, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns WHERE ${where("table_schema")} ORDER BY table_schema, table_name, ordinal_position`,
    values,
  ))
    a.column(row);
  for (const row of await run(
    `SELECT tc.table_schema, tc.table_name, tc.constraint_schema, tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
     WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${where("tc.table_schema")}`,
    values,
  ))
    a.keyPart(row);
  for (const row of await run(
    `SELECT rc.constraint_schema, rc.constraint_name, kcu.table_schema AS ref_schema, kcu.table_name AS ref_table, kcu.column_name AS ref_column, kcu.ordinal_position
     FROM information_schema.referential_constraints rc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = rc.unique_constraint_schema AND kcu.constraint_name = rc.unique_constraint_name
     WHERE ${where("rc.constraint_schema")}`,
    values,
  ))
    a.target(row);
  for (const row of await optional(
    run,
    notes,
    "table comments and sizes",
    `SELECT n.nspname AS table_schema, c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment, c.reltuples AS rows
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND ${where("n.nspname")}`,
    values,
  )) {
    a.comment(row);
    a.size(row);
  }
  for (const row of await optional(
    run,
    notes,
    "column comments",
    `SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, col_description(c.oid, a.attnum) AS comment
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND ${where("n.nspname")} AND col_description(c.oid, a.attnum) IS NOT NULL`,
    values,
  ))
    a.comment(row);
}

async function mysql(run: Query, a: Assembly, schema: string | null): Promise<void> {
  // One MySQL connection is one database: the one it opened, unless a schema is named.
  const where = (column: string) => (schema ? `${column} = ?` : `${column} = DATABASE()`);
  const values = schema ? [schema] : [];
  for (const row of await run(
    `SELECT table_schema, table_name, table_type, table_rows, table_comment FROM information_schema.tables WHERE ${where("table_schema")} ORDER BY table_name LIMIT ${MAX_SCHEMA_TABLES + 1}`,
    values,
  ))
    a.table(row);
  for (const row of await run(
    `SELECT table_schema, table_name, column_name, data_type, column_type, is_nullable, column_key, column_comment
     FROM information_schema.columns WHERE ${where("table_schema")} ORDER BY table_name, ordinal_position`,
    values,
  ))
    a.column(row);
  for (const row of await run(
    `SELECT table_schema, table_name, constraint_name, column_name, ordinal_position, referenced_table_schema AS ref_schema,
       referenced_table_name AS ref_table, referenced_column_name AS ref_column
     FROM information_schema.key_column_usage WHERE ${where("table_schema")} AND referenced_table_name IS NOT NULL`,
    values,
  ))
    a.directKey(row);
}

async function sqlServer(run: Query, a: Assembly, notes: string[], schema: string | null): Promise<void> {
  const where = (column: string) => (schema ? `${column} = @p1` : `${column} NOT IN ('sys', 'INFORMATION_SCHEMA')`);
  const values = schema ? [schema] : [];
  for (const row of await run(
    `SELECT TOP (${MAX_SCHEMA_TABLES + 1}) TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
     FROM INFORMATION_SCHEMA.TABLES WHERE ${where("TABLE_SCHEMA")} ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    values,
  ))
    a.table(row);
  for (const row of await run(
    `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
       CHARACTER_MAXIMUM_LENGTH AS character_maximum_length, NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale, IS_NULLABLE AS is_nullable
     FROM INFORMATION_SCHEMA.COLUMNS WHERE ${where("TABLE_SCHEMA")} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    values,
  ))
    a.column(row);
  for (const row of await run(
    `SELECT tc.TABLE_SCHEMA AS table_schema, tc.TABLE_NAME AS table_name, tc.CONSTRAINT_SCHEMA AS constraint_schema, tc.CONSTRAINT_NAME AS constraint_name,
       tc.CONSTRAINT_TYPE AS constraint_type, kcu.COLUMN_NAME AS column_name, kcu.ORDINAL_POSITION AS ordinal_position
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${where("tc.TABLE_SCHEMA")}`,
    values,
  ))
    a.keyPart(row);
  for (const row of await run(
    `SELECT rc.CONSTRAINT_SCHEMA AS constraint_schema, rc.CONSTRAINT_NAME AS constraint_name, kcu.TABLE_SCHEMA AS ref_schema, kcu.TABLE_NAME AS ref_table,
       kcu.COLUMN_NAME AS ref_column, kcu.ORDINAL_POSITION AS ordinal_position
     FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
     WHERE ${where("rc.CONSTRAINT_SCHEMA")}`,
    values,
  ))
    a.target(row);
  for (const row of await optional(
    run,
    notes,
    "descriptions (MS_Description)",
    `SELECT s.name AS table_schema, o.name AS table_name, c.name AS column_name, CAST(ep.value AS nvarchar(1000)) AS comment
     FROM sys.extended_properties ep JOIN sys.objects o ON o.object_id = ep.major_id JOIN sys.schemas s ON s.schema_id = o.schema_id
     LEFT JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
     WHERE ep.class = 1 AND ep.name = 'MS_Description' AND ${where("s.name")}`,
    values,
  ))
    a.comment(row);
  for (const row of await optional(
    run,
    notes,
    "table sizes",
    `SELECT s.name AS table_schema, t.name AS table_name, SUM(p.rows) AS rows
     FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE ${where("s.name")} GROUP BY s.name, t.name`,
    values,
  ))
    a.size(row);
}

async function oracle(run: Query, a: Assembly, notes: string[], schema: string | null): Promise<void> {
  // The schema the login works in, unless another is named (Oracle keeps unquoted names in capitals).
  const owner = schema ? `= :1` : `= SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')`;
  const values = schema ? [schema.toUpperCase()] : [];
  for (const row of await run(
    `SELECT owner AS "table_schema", table_name AS "table_name", 'BASE TABLE' AS "table_type", num_rows AS "table_rows" FROM all_tables WHERE owner ${owner}
     UNION ALL SELECT owner, view_name, 'VIEW', NULL FROM all_views WHERE owner ${schema ? "= :2" : owner}
     ORDER BY 2 FETCH FIRST ${MAX_SCHEMA_TABLES + 1} ROWS ONLY`,
    schema ? [...values, ...values] : [],
  ))
    a.table(row);
  for (const row of await run(
    `SELECT owner AS "table_schema", table_name AS "table_name", column_name AS "column_name", data_type AS "data_type", data_length AS "data_length",
       data_precision AS "data_precision", data_scale AS "data_scale", nullable AS "is_nullable"
     FROM all_tab_columns WHERE owner ${owner} ORDER BY table_name, column_id`,
    values,
  ))
    a.column(row);
  for (const row of await run(
    `SELECT c.owner AS "table_schema", c.table_name AS "table_name", c.owner AS "constraint_schema", c.constraint_name AS "constraint_name",
       c.constraint_type AS "constraint_type", cc.column_name AS "column_name", cc.position AS "ordinal_position"
     FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     WHERE c.constraint_type IN ('P', 'R') AND c.owner ${owner}`,
    values,
  ))
    a.keyPart(row.constraint_type === "R" || row.CONSTRAINT_TYPE === "R" ? { ...row, constraint_type: "FOREIGN KEY" } : row);
  for (const row of await run(
    `SELECT c.owner AS "constraint_schema", c.constraint_name AS "constraint_name", t.owner AS "ref_schema", t.table_name AS "ref_table",
       tc.column_name AS "ref_column", tc.position AS "ordinal_position"
     FROM all_constraints c JOIN all_constraints t ON t.owner = c.r_owner AND t.constraint_name = c.r_constraint_name
     JOIN all_cons_columns tc ON tc.owner = t.owner AND tc.constraint_name = t.constraint_name
     WHERE c.constraint_type = 'R' AND c.owner ${owner}`,
    values,
  ))
    a.target(row);
  for (const row of await optional(
    run,
    notes,
    "table comments",
    `SELECT owner AS "table_schema", table_name AS "table_name", comments AS "comment" FROM all_tab_comments WHERE owner ${owner} AND comments IS NOT NULL`,
    values,
  ))
    a.comment(row);
  for (const row of await optional(
    run,
    notes,
    "column comments",
    `SELECT owner AS "table_schema", table_name AS "table_name", column_name AS "column_name", comments AS "comment"
     FROM all_col_comments WHERE owner ${owner} AND comments IS NOT NULL`,
    values,
  ))
    a.comment(row);
}

/**
 * Reads what a database says about itself: every table and view of a schema (or the ones the login
 * works in), each with its columns and types, primary and foreign keys, its size and its comments.
 * Only the database's catalog is read, never a row of data.
 */
export async function readSchema(client: SqlClient, dialect: SqlDialect, schema: string | null): Promise<DatabaseSchema> {
  const run: Query = async (textValue, values = []) => (await client.query(textValue, values)).rows;
  const assembly = new Assembly(dialect);
  const notes: string[] = [];
  if (dialect === "mysql") await mysql(run, assembly, schema);
  else if (dialect === "sqlserver") await sqlServer(run, assembly, notes, schema);
  else if (dialect === "oracle") await oracle(run, assembly, notes, schema);
  else await postgres(run, assembly, notes, schema);
  return { dialect, tables: assembly.finish(), truncated: assembly.seen > MAX_SCHEMA_TABLES, notes };
}
