import { describe, expect, it } from "vitest";
import { MAX_SCHEMA_TABLES, createSqlDatabaseConnector, readSchema, type SqlClient, type SqlQueryResult } from "../src/index.ts";
import { makeCtx, run } from "./helpers.ts";

type Row = Record<string, unknown>;

/** A database that answers the catalog queries of a reading, by what each one reads. */
class CatalogClient implements SqlClient {
  readonly asked: { text: string; values?: unknown[] }[] = [];
  constructor(private readonly answers: [RegExp, Row[] | Error][]) {}
  async connect(): Promise<void> {}
  async query(text: string, values?: unknown[]): Promise<SqlQueryResult> {
    this.asked.push({ text, values });
    const found = this.answers.find(([pattern]) => pattern.test(text));
    if (found?.[1] instanceof Error) throw found[1];
    return { rows: (found?.[1] as Row[] | undefined) ?? [] };
  }
  async end(): Promise<void> {}
}

const PG_TABLES: Row[] = [
  { table_schema: "sales", table_name: "customers", table_type: "BASE TABLE" },
  { table_schema: "sales", table_name: "order_lines", table_type: "BASE TABLE" },
  { table_schema: "sales", table_name: "open_orders", table_type: "VIEW" },
];
const PG_COLUMNS: Row[] = [
  { table_schema: "sales", table_name: "customers", column_name: "id", data_type: "integer", is_nullable: "NO" },
  { table_schema: "sales", table_name: "customers", column_name: "name", data_type: "character varying", character_maximum_length: 120, is_nullable: "NO" },
  { table_schema: "sales", table_name: "customers", column_name: "email", data_type: "USER-DEFINED", udt_name: "citext", is_nullable: "YES" },
  {
    table_schema: "sales",
    table_name: "order_lines",
    column_name: "order_no",
    data_type: "character varying",
    character_maximum_length: 12,
    is_nullable: "NO",
  },
  { table_schema: "sales", table_name: "order_lines", column_name: "line", data_type: "smallint", is_nullable: "NO" },
  { table_schema: "sales", table_name: "order_lines", column_name: "customer_id", data_type: "integer", is_nullable: "NO" },
  {
    table_schema: "sales",
    table_name: "order_lines",
    column_name: "amount",
    data_type: "numeric",
    numeric_precision: 12,
    numeric_scale: 2,
    is_nullable: "YES",
  },
  { table_schema: "sales", table_name: "order_lines", column_name: "ordered_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  {
    table_schema: "sales",
    table_name: "open_orders",
    column_name: "order_no",
    data_type: "character varying",
    character_maximum_length: 12,
    is_nullable: "YES",
  },
];
const PG_KEYS: Row[] = [
  {
    table_schema: "sales",
    table_name: "customers",
    constraint_schema: "sales",
    constraint_name: "customers_pkey",
    constraint_type: "PRIMARY KEY",
    column_name: "id",
    ordinal_position: 1,
  },
  {
    table_schema: "sales",
    table_name: "order_lines",
    constraint_schema: "sales",
    constraint_name: "order_lines_pkey",
    constraint_type: "PRIMARY KEY",
    column_name: "line",
    ordinal_position: 2,
  },
  {
    table_schema: "sales",
    table_name: "order_lines",
    constraint_schema: "sales",
    constraint_name: "order_lines_pkey",
    constraint_type: "PRIMARY KEY",
    column_name: "order_no",
    ordinal_position: 1,
  },
  {
    table_schema: "sales",
    table_name: "order_lines",
    constraint_schema: "sales",
    constraint_name: "order_lines_customer_fk",
    constraint_type: "FOREIGN KEY",
    column_name: "customer_id",
    ordinal_position: 1,
  },
];
const PG_TARGETS: Row[] = [
  {
    constraint_schema: "sales",
    constraint_name: "order_lines_customer_fk",
    ref_schema: "sales",
    ref_table: "customers",
    ref_column: "id",
    ordinal_position: 1,
  },
];
const PG_SIZES: Row[] = [
  { table_schema: "sales", table_name: "customers", comment: "Companies that buy from us", rows: 4850 },
  { table_schema: "sales", table_name: "order_lines", comment: null, rows: 182400.0 },
  // A view's own estimate means nothing: it has no rows of its own.
  { table_schema: "sales", table_name: "open_orders", comment: "Lines not yet shipped", rows: 37 },
];
const PG_COLUMN_COMMENTS: Row[] = [{ table_schema: "sales", table_name: "customers", column_name: "email", comment: "Where invoices go" }];

function postgres(overrides: [RegExp, Row[] | Error][] = []): CatalogClient {
  return new CatalogClient([
    ...overrides,
    [/FROM information_schema\.tables/, PG_TABLES],
    [/FROM information_schema\.columns/, PG_COLUMNS],
    [/FROM information_schema\.table_constraints/, PG_KEYS],
    [/FROM information_schema\.referential_constraints/, PG_TARGETS],
    [/obj_description/, PG_SIZES],
    [/col_description/, PG_COLUMN_COMMENTS],
  ]);
}

describe("readSchema", () => {
  it("reads a PostgreSQL schema: tables and views, columns and types, composite and foreign keys, sizes and comments", async () => {
    const client = postgres();
    const schema = await readSchema(client, "postgres", null);
    expect(schema).toMatchObject({ dialect: "postgres", truncated: false, notes: [] });
    const [customers, lines, open] = schema.tables;
    expect(customers).toEqual({
      schema: "sales",
      name: "customers",
      type: "Table",
      rows: 4850,
      comment: "Companies that buy from us",
      columns: [
        { name: "id", type: "integer", nullable: false, primary: true, comment: "" },
        { name: "name", type: "varchar(120)", nullable: false, primary: false, comment: "" },
        { name: "email", type: "citext", nullable: true, primary: false, comment: "Where invoices go" },
      ],
      foreign_keys: [],
    });
    expect(lines!.columns.map((c) => [c.name, c.type, c.primary])).toEqual([
      ["order_no", "varchar(12)", true],
      ["line", "smallint", true],
      ["customer_id", "integer", false],
      ["amount", "numeric(12,2)", false],
      ["ordered_at", "timestamptz", false],
    ]);
    expect(lines!.foreign_keys).toEqual([{ columns: ["customer_id"], ref_schema: "sales", ref_table: "customers", ref_columns: ["id"] }]);
    expect(lines!.rows).toBe(182400);
    expect(open).toMatchObject({ name: "open_orders", type: "View", rows: null, comment: "Lines not yet shipped" });
    // Only the catalog: no query touches the tables themselves.
    expect(client.asked.every((q) => /information_schema|pg_class|pg_attribute/.test(q.text))).toBe(true);
    // The system schemas stay out.
    expect(client.asked[0]!.text).toMatch(/NOT IN \('pg_catalog', 'information_schema'\)/);
  });

  it("reads one schema when it is named, and carries on without what the login may not see", async () => {
    const client = postgres([
      [/obj_description/, new Error("permission denied for pg_class")],
      [/col_description/, new Error("permission denied for pg_attribute")],
    ]);
    const schema = await readSchema(client, "postgres", "sales");
    expect(client.asked[0]!.values).toEqual(["sales"]);
    expect(client.asked[0]!.text).toMatch(/table_schema = \$1/);
    expect(schema.tables).toHaveLength(3);
    expect(schema.tables[0]!.rows).toBeNull();
    expect(schema.notes).toEqual(["Could not read table comments and sizes", "Could not read column comments"]);
  });

  it(`keeps the first ${MAX_SCHEMA_TABLES} tables of a very large database, and says there are more`, async () => {
    const many = Array.from({ length: MAX_SCHEMA_TABLES + 1 }, (_, i) => ({
      table_schema: "dbo",
      table_name: `t${String(i).padStart(4, "0")}`,
      table_type: "BASE TABLE",
    }));
    const schema = await readSchema(new CatalogClient([[/information_schema\.tables/, many]]), "postgres", null);
    expect(schema.tables).toHaveLength(MAX_SCHEMA_TABLES);
    expect(schema.truncated).toBe(true);
  });

  it("reads MySQL: column types as the database writes them, keys and comments from the columns, foreign keys in one go", async () => {
    const client = new CatalogClient([
      [
        /FROM information_schema\.tables/,
        [
          { table_schema: "erp", table_name: "orders", table_type: "BASE TABLE", table_rows: 1200, table_comment: "Sales orders" },
          { table_schema: "erp", table_name: "customers", table_type: "BASE TABLE", table_rows: 90, table_comment: "" },
        ],
      ],
      [
        /FROM information_schema\.columns/,
        [
          { table_schema: "erp", table_name: "orders", column_name: "id", data_type: "int", column_type: "int unsigned", is_nullable: "NO", column_key: "PRI" },
          { table_schema: "erp", table_name: "orders", column_name: "customer_id", data_type: "int", column_type: "int", is_nullable: "NO", column_key: "MUL" },
          {
            table_schema: "erp",
            table_name: "orders",
            column_name: "total",
            data_type: "decimal",
            column_type: "decimal(12,2)",
            is_nullable: "YES",
            column_key: "",
            column_comment: "Before VAT",
          },
          { table_schema: "erp", table_name: "customers", column_name: "id", data_type: "int", column_type: "int", is_nullable: "NO", column_key: "PRI" },
        ],
      ],
      [
        /FROM information_schema\.key_column_usage/,
        [
          {
            table_schema: "erp",
            table_name: "orders",
            constraint_name: "fk_customer",
            column_name: "customer_id",
            ordinal_position: 1,
            ref_schema: "erp",
            ref_table: "customers",
            ref_column: "id",
          },
        ],
      ],
    ]);
    const schema = await readSchema(client, "mysql", null);
    expect(client.asked[0]!.text).toMatch(/table_schema = DATABASE\(\)/);
    const [orders] = schema.tables;
    expect(orders).toMatchObject({ name: "orders", rows: 1200, comment: "Sales orders" });
    expect(orders!.columns).toEqual([
      { name: "id", type: "int unsigned", nullable: false, primary: true, comment: "" },
      { name: "customer_id", type: "int", nullable: false, primary: false, comment: "" },
      { name: "total", type: "decimal(12,2)", nullable: true, primary: false, comment: "Before VAT" },
    ]);
    expect(orders!.foreign_keys).toEqual([{ columns: ["customer_id"], ref_schema: "erp", ref_table: "customers", ref_columns: ["id"] }]);
  });

  it("reads SQL Server and Oracle, whatever case their drivers send names in", async () => {
    const sqlServer = new CatalogClient([
      [/INFORMATION_SCHEMA\.TABLES/, [{ TABLE_SCHEMA: "dbo", TABLE_NAME: "work_orders", TABLE_TYPE: "BASE TABLE" }]],
      [
        /INFORMATION_SCHEMA\.COLUMNS/,
        [
          { TABLE_SCHEMA: "dbo", TABLE_NAME: "work_orders", COLUMN_NAME: "wo_id", DATA_TYPE: "int", IS_NULLABLE: "NO" },
          { TABLE_SCHEMA: "dbo", TABLE_NAME: "work_orders", COLUMN_NAME: "notes", DATA_TYPE: "nvarchar", CHARACTER_MAXIMUM_LENGTH: -1, IS_NULLABLE: "YES" },
        ],
      ],
      [
        /INFORMATION_SCHEMA\.TABLE_CONSTRAINTS/,
        [
          {
            TABLE_SCHEMA: "dbo",
            TABLE_NAME: "work_orders",
            CONSTRAINT_SCHEMA: "dbo",
            CONSTRAINT_NAME: "pk_wo",
            CONSTRAINT_TYPE: "PRIMARY KEY",
            COLUMN_NAME: "wo_id",
          },
        ],
      ],
      [/MS_Description/, [{ table_schema: "dbo", table_name: "work_orders", column_name: null, comment: "Production orders from SAP" }]],
      [/sys\.partitions/, [{ table_schema: "dbo", table_name: "work_orders", rows: 48210 }]],
    ]);
    const [workOrders] = (await readSchema(sqlServer, "sqlserver", null)).tables;
    expect(workOrders).toMatchObject({ schema: "dbo", name: "work_orders", rows: 48210, comment: "Production orders from SAP" });
    expect(workOrders!.columns).toEqual([
      { name: "wo_id", type: "int", nullable: false, primary: true, comment: "" },
      { name: "notes", type: "nvarchar(max)", nullable: true, primary: false, comment: "" },
    ]);

    const oracle = new CatalogClient([
      [/FROM all_tables/, [{ TABLE_SCHEMA: "ERP", TABLE_NAME: "INVOICES", TABLE_TYPE: "BASE TABLE", TABLE_ROWS: 880 }]],
      [
        /FROM all_tab_columns/,
        [
          { TABLE_SCHEMA: "ERP", TABLE_NAME: "INVOICES", COLUMN_NAME: "INVOICE_NO", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 20, IS_NULLABLE: "N" },
          { TABLE_SCHEMA: "ERP", TABLE_NAME: "INVOICES", COLUMN_NAME: "SUPPLIER_ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 10, IS_NULLABLE: "N" },
          { TABLE_SCHEMA: "ERP", TABLE_NAME: "INVOICES", COLUMN_NAME: "AMOUNT", DATA_TYPE: "NUMBER", DATA_PRECISION: 12, DATA_SCALE: 2, IS_NULLABLE: "Y" },
        ],
      ],
      [
        /FROM all_constraints c JOIN all_cons_columns/,
        [
          {
            TABLE_SCHEMA: "ERP",
            TABLE_NAME: "INVOICES",
            CONSTRAINT_SCHEMA: "ERP",
            CONSTRAINT_NAME: "INV_PK",
            CONSTRAINT_TYPE: "P",
            COLUMN_NAME: "INVOICE_NO",
            ORDINAL_POSITION: 1,
          },
          {
            TABLE_SCHEMA: "ERP",
            TABLE_NAME: "INVOICES",
            CONSTRAINT_SCHEMA: "ERP",
            CONSTRAINT_NAME: "INV_SUP_FK",
            CONSTRAINT_TYPE: "R",
            COLUMN_NAME: "SUPPLIER_ID",
            ORDINAL_POSITION: 1,
          },
        ],
      ],
      [
        /FROM all_constraints c JOIN all_constraints t/,
        [{ CONSTRAINT_SCHEMA: "ERP", CONSTRAINT_NAME: "INV_SUP_FK", REF_SCHEMA: "ERP", REF_TABLE: "SUPPLIERS", REF_COLUMN: "ID", ORDINAL_POSITION: 1 }],
      ],
      [/all_tab_comments/, [{ TABLE_SCHEMA: "ERP", TABLE_NAME: "INVOICES", COMMENT: "Supplier invoices" }]],
      [/all_col_comments/, new Error("ORA-00942: table or view does not exist")],
    ]);
    const read = await readSchema(oracle, "oracle", "erp");
    expect(oracle.asked[0]!.values).toEqual(["ERP", "ERP"]);
    expect(read.notes).toEqual(["Could not read column comments"]);
    expect(read.tables[0]).toEqual({
      schema: "ERP",
      name: "INVOICES",
      type: "Table",
      rows: 880,
      comment: "Supplier invoices",
      columns: [
        { name: "INVOICE_NO", type: "VARCHAR2(20)", nullable: false, primary: true, comment: "" },
        { name: "SUPPLIER_ID", type: "NUMBER(10)", nullable: false, primary: false, comment: "" },
        { name: "AMOUNT", type: "NUMBER(12,2)", nullable: true, primary: false, comment: "" },
      ],
      foreign_keys: [{ columns: ["SUPPLIER_ID"], ref_schema: "ERP", ref_table: "SUPPLIERS", ref_columns: ["ID"] }],
    });
  });
});

describe("sql-database read_schema", () => {
  it("reads the schema in a read-only transaction that is always rolled back", async () => {
    const client = postgres();
    const connector = createSqlDatabaseConnector({ createClient: () => client });
    expect(connector.manifest.operations.find((o) => o.id === "read_schema")).toMatchObject({ kind: "read" });
    const ctx = makeCtx({ config: { statement_timeout_ms: 15000 }, secrets: { connection_string: "postgresql://reader:pw@db.acme.example:5432/erp" } });
    const schema = await run<{ tables: { name: string }[] }>(connector, "read_schema", { schema: "sales" }, ctx);
    expect(schema.tables.map((t) => t.name)).toEqual(["customers", "order_lines", "open_orders"]);
    expect(client.asked[0]!.text).toMatch(/BEGIN/i);
    expect(client.asked.some((q) => /READ ONLY/i.test(q.text))).toBe(true);
    expect(client.asked.at(-1)!.text).toBe("ROLLBACK");
  });
});
