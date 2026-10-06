import type { BrainEntityView } from "./types.ts";
import { BrainError, type BrainService, type TechnicalColumn } from "./service.ts";
import type { SourceBatch, SourceEntity, SourceLink } from "./types.ts";

/**
 * The company's data catalog in the brain: the tables of its databases, read from the databases
 * themselves, with what people write about them in business words.
 */

/** A database's catalog, as an SQL connection's read_schema returns it. */
export interface SchemaInput {
  tables: SchemaTableInput[];
  truncated?: boolean;
  notes?: string[];
}

export interface SchemaTableInput {
  schema: string | null;
  name: string;
  type: "Table" | "View";
  rows: number | null;
  comment: string;
  columns: { name: string; type: string; nullable: boolean; primary: boolean; comment: string }[];
  foreign_keys: { columns: string[]; ref_schema: string | null; ref_table: string; ref_columns: string[] }[];
}

export interface CatalogConnection {
  id: string;
  name: string;
  /** What it connects to: "Microsoft SQL Server". */
  detail?: string;
}

export interface CatalogDeps {
  /** The company's SQL database connections (Settings → Connections). */
  connections(companyId: string): Promise<CatalogConnection[]>;
  /** A connection's catalog, read through it: only the catalog, never a row of data. */
  readSchema(companyId: string, connectionId: string, schema?: string): Promise<SchemaInput>;
  /** A demo database's catalog, by the database's key, where a demo stands in for the real one. */
  demoSchema?(databaseKey: string): SchemaInput | undefined;
}

export interface ReadTablesResult {
  /** Tables and views the database has (or the first ones, when there are very many). */
  tables: number;
  added: number;
  changed: number;
  /** Tables an earlier reading brought that the database no longer has: kept, with what people wrote. */
  gone: string[];
  links: number;
  /** Where they were read from: the connection's name, or the demo. */
  from: string;
  truncated: boolean;
  notes: string[];
}

/** A table's key in the brain: its database's key, its schema and its name ("mes-db.dbo.work_orders"). */
export function tableKey(databaseKey: string, schema: string | null, table: string): string {
  return `${databaseKey}.${schema ? `${schema}.` : ""}${table}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/**
 * Each database's tables (or one schema's, when only that schema is read) come in under their own
 * origin, so reading one never touches what another reading brought.
 */
export function schemaOrigin(databaseId: string, schema?: string | null): string {
  return schema ? `schema:${databaseId}:${schema.toLowerCase()}` : `schema:${databaseId}`;
}

function refOf(schema: string | null, table: string): string {
  return `${schema ?? ""}.${table}`.toLowerCase();
}

/** "PK", "FK → KNA1.KUNNR", "PK, FK → VBAK.VBELN". */
function keyOf(table: SchemaTableInput, column: SchemaTableInput["columns"][number]): string {
  const parts = column.primary ? ["PK"] : [];
  for (const key of table.foreign_keys) {
    const at = key.columns.findIndex((c) => c.toLowerCase() === column.name.toLowerCase());
    if (at >= 0) parts.push(`FK → ${key.ref_table}.${key.ref_columns[at] ?? key.ref_columns[0] ?? ""}`.replace(/\.$/, ""));
  }
  return parts.join(", ");
}

/** A database's catalog as things the brain keeps: a table each, in its database, pointing to the tables it refers to. */
export function schemaBatch(database: { key: string }, schema: SchemaInput): { batch: SourceBatch; columns: Map<string, TechnicalColumn[]> } {
  const entities: SourceEntity[] = [];
  const links: SourceLink[] = [];
  const columns = new Map<string, TechnicalColumn[]>();
  for (const table of schema.tables) {
    const ref = refOf(table.schema, table.name);
    const key = tableKey(database.key, table.schema, table.name);
    entities.push({
      kind: "data_table",
      ref,
      key,
      name: table.name,
      summary: table.comment || undefined,
      data: { type: table.type, schema: table.schema ?? undefined, rows: table.rows ?? undefined },
    });
    columns.set(
      key,
      table.columns.map((column) => ({ name: column.name, type: column.type, key: keyOf(table, column), nullable: column.nullable, comment: column.comment })),
    );
    // By the table's ref in this database, else its key: a table the catalog brought first resolves too.
    const me = { kind: "data_table" as const, ref, key };
    links.push({ from: me, relation: "table_of", to: { kind: "database", key: database.key } });
    for (const foreign of table.foreign_keys) {
      const schemaName = foreign.ref_schema ?? table.schema;
      links.push({
        from: me,
        relation: "references",
        to: { kind: "data_table", ref: refOf(schemaName, foreign.ref_table), key: tableKey(database.key, schemaName, foreign.ref_table) },
        detail: foreign.columns.join(", "),
      });
    }
  }
  return { batch: { entities, links }, columns };
}

export class BrainCatalog {
  constructor(
    private readonly brain: BrainService,
    private readonly deps: CatalogDeps,
  ) {}

  /** The SQL database connections a database's tables can be read through. */
  connections(companyId: string): Promise<CatalogConnection[]> {
    return this.deps.connections(companyId);
  }

  /** Does the brain have a demo catalog for this database (the demo company's databases)? */
  hasDemo(database: Pick<BrainEntityView, "key">): boolean {
    return Boolean(this.deps.demoSchema?.(database.key));
  }

  /** How a database's tables can be read: the connections, the one used last time, and whether a demo stands in. */
  async readOptions(companyId: string, databaseId: string): Promise<{ connections: CatalogConnection[]; connectionId: string | null; demo: boolean }> {
    const database = await this.brain.get(companyId, databaseId);
    if (database.kind !== "database") throw new BrainError("Tables are read from a database", 400);
    const connections = await this.deps.connections(companyId);
    const remembered = typeof database.data.connection_id === "string" ? database.data.connection_id : null;
    return { connections, connectionId: connections.some((c) => c.id === remembered) ? remembered : null, demo: this.hasDemo(database) };
  }

  /**
   * Reads a database's tables and views (through a connection, or its demo) into the brain: each a
   * table thing in its database, with its columns, keys and size, pointing to the tables it refers
   * to. What people wrote about a table or a column stays; the technical part follows the database.
   */
  async readTables(companyId: string, databaseId: string, options: { connectionId?: string; schema?: string; actor: string }): Promise<ReadTablesResult> {
    const database = await this.brain.get(companyId, databaseId);
    if (database.kind !== "database") throw new BrainError("Tables are read from a database", 400);
    const remembered = typeof database.data.connection_id === "string" ? database.data.connection_id : undefined;
    const connectionId = options.connectionId || remembered;
    const only = options.schema?.trim() || undefined;
    let schema: SchemaInput;
    let from: string;
    if (connectionId) {
      const connection = (await this.deps.connections(companyId)).find((c) => c.id === connectionId);
      if (!connection) throw new BrainError("That is not one of the company's SQL database connections", 400);
      try {
        schema = await this.deps.readSchema(companyId, connectionId, only);
      } catch (error) {
        throw new BrainError(`${connection.name} could not be read: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
      from = connection.name;
      if (remembered !== connectionId) await this.brain.update(companyId, database.id, { data: { connection_id: connectionId } }, options.actor);
    } else {
      const demo = this.deps.demoSchema?.(database.key);
      if (!demo) throw new BrainError("Choose the connection to read it through: an SQL database connection in Settings → Connections", 400);
      schema = only ? { ...demo, tables: demo.tables.filter((t) => (t.schema ?? "").toLowerCase() === only.toLowerCase()) } : demo;
      from = "the demo database";
    }
    const origin = schemaOrigin(database.id, only);
    const { batch, columns } = schemaBatch(database, schema);
    const before = new Map((await this.brain.stored(companyId, "data_table")).map((t) => [t.key, t]));
    const result = await this.brain.apply(companyId, origin, batch);
    const ids = new Map((await this.brain.stored(companyId, "data_table")).map((t) => [t.key, t.id]));
    for (const [key, technical] of columns) {
      const id = ids.get(key);
      if (id) await this.brain.mergeColumns(companyId, id, technical, origin);
    }
    const after = await this.brain.stored(companyId, "data_table");
    const refs = new Set((batch.entities ?? []).map((e) => e.ref));
    const read = after.filter((t) => columns.has(t.key));
    const outcome: ReadTablesResult = {
      tables: schema.tables.length,
      added: read.filter((t) => !before.has(t.key)).length,
      changed: read.filter((t) => before.has(t.key) && before.get(t.key)!.fingerprint !== t.fingerprint).length,
      // A partial reading (very many tables) can't tell what is gone.
      gone: schema.truncated
        ? []
        : after
            .filter((t) => t.refs[origin] && !refs.has(t.refs[origin]))
            .map((t) => t.name)
            .sort(),
      links: result.links.added,
      from,
      truncated: Boolean(schema.truncated),
      notes: schema.notes ?? [],
    };
    const words = [
      outcome.added ? `${outcome.added} new` : "",
      outcome.changed ? `${outcome.changed} changed` : "",
      outcome.gone.length ? `${outcome.gone.length} no longer there` : "",
    ].filter(Boolean);
    await this.brain.apply(companyId, origin, {
      events: [
        {
          ref: `read:${Date.now()}`,
          at: new Date(),
          kind: "update",
          title: `Read ${outcome.tables} tables and views from ${database.name}${only ? ` (schema ${only})` : ""}: ${words.length ? words.join(", ") : "no changes"}`,
          body: outcome.gone.length ? `No longer in the database: ${outcome.gone.join(", ")}.` : undefined,
          actor: options.actor,
          about: [{ kind: "database", key: database.key }],
        },
      ],
    });
    return outcome;
  }
}
