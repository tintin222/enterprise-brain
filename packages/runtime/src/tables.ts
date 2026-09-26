import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  checkRecordValues,
  RecordValueError,
  sameData,
  TableDesign,
  TableSettings,
  tableKeyOf,
  titleFieldOf,
  type TableDesignInput,
  type TableField,
  type ValueResolvers,
} from "@enterprise-brain/core";
import { ConnectorError, tableActions, type TableStore } from "@enterprise-brain/connectors";
import { agents, dataRecordChanges, dataRecords, dataTables, users, type DatabaseHandle } from "@enterprise-brain/db";
import type { ConnectorService } from "./connectors.ts";
import type { FileService } from "./files.ts";

/**
 * Tables: business data people describe in plain words, kept in the company's database. Every value
 * is checked against its field, every record is numbered in its table (#1, #2…) and every change is
 * kept with who made it. AI employees reach the tables through the company's Tables connection, whose
 * actions this service keeps in step with the tables.
 */

export class TableError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TableError";
  }
}

type TableRow = typeof dataTables.$inferSelect;
type RecordRow = typeof dataRecords.$inferSelect;

export interface TableView {
  id: string;
  key: string;
  name: string;
  description: string;
  /** The department it belongs to; null = company-wide. */
  departmentId: string | null;
  fields: TableField[];
  /** The field that names a record. */
  titleField: string;
  settings: TableSettings;
  version: number;
  /** Its records (not counting archived ones). */
  records: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface RecordView {
  id: string;
  number: number;
  /** What names it: its title field's value, else "#12". */
  title: string;
  /** Its values by field key, as stored: a link holds the record's id, a person their email. */
  values: Record<string, unknown>;
  /** How links and people read: "#3 Akın Metal", "Zeynep Kaya". */
  display: Record<string, string>;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface RecordChangeView {
  id: string;
  /** created | updated | archived | restored | imported */
  action: string;
  /** Each field's value before and after (links and people as they read). */
  changes: { key: string; label: string; from: unknown; to: unknown }[];
  by: string;
  /** Made by an AI employee. */
  ai: boolean;
  runId: string | null;
  createdAt: Date;
}

export interface RecordQuery {
  /** Words that must all appear in the record (or its number: "#12"). */
  search?: string;
  /** Field values it must have (a choice, a person, a linked record, a date, yes or no). */
  where?: Record<string, unknown>;
  /** A field key, or number | created_at | updated_at (default: number, newest first). */
  sort?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
  /** The archived records instead. */
  archived?: boolean;
}

/** Who makes a change: a person ("Name <email>"), an AI employee ("agent:<id>"), and the run it was in. */
export interface ChangeBy {
  actor: string;
  runId?: string;
}

export type NewTable = Omit<TableDesignInput, "key"> & {
  key?: string;
  departmentId?: string | null;
  settings?: Partial<TableSettings>;
};

export type TableChanges = Partial<Pick<TableDesignInput, "name" | "description" | "fields" | "titleField">> & {
  departmentId?: string | null;
  settings?: Partial<TableSettings>;
  /** Choice values renamed in every record: { field key: { old value: new value } }. */
  renames?: Record<string, Record<string, string>>;
};

/** What a chart or a number shows: records counted, or a number field added up or averaged, by a field. */
export interface SummaryQuery {
  groupBy?: string;
  measure?: { of: "count" | "sum" | "average"; field?: string };
  where?: Record<string, unknown>;
  /** Only the largest this many groups; the rest together as "Other". */
  limit?: number;
}

export interface Summary {
  /** In the order of a choice's list, of dates, else largest first. `key` null: records without a value. */
  groups: { key: string | null; label: string; value: number }[];
  /** All records together (the average of all, for an average). */
  total: number;
}

export interface ImportResult {
  /** Which field each column went to (column → field key). */
  columns: Record<string, string>;
  /** Columns that match no field. */
  ignored: string[];
  /** Rows that can be (or were) added. */
  ready: number;
  added: number;
  /** Rows with problems, by their row in the sheet (its first row holds the column names). */
  problems: { row: number; problems: string[] }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 500;

function designOf(row: TableRow): TableDesign {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    fields: row.fields as unknown as TableField[],
    ...(row.titleField ? { titleField: row.titleField } : {}),
  };
}

function settingsOf(row: TableRow): TableSettings {
  return TableSettings.parse(row.settings ?? {});
}

/** What changed between two sets of values: { field: { from, to } }. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) out[key] = { from, to };
  }
  return out;
}

/** "%word%" for ILIKE, with the word's own % and _ taken literally. */
function like(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

/** How an actor reads when it isn't an AI employee of the company. */
function actorLabel(actor: string): string {
  if (actor === "agent:company-assistant") return "Company assistant";
  if (actor.startsWith("agent:")) return "An AI employee";
  if (actor === "system") return "Enterprise Brain";
  if (actor === "api") return "API";
  if (actor === "user") return "Someone";
  return actor.replace(/\s*<.*>$/, "");
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load();
    cache.set(key, hit);
  }
  return hit;
}

export class TableService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly connectors: ConnectorService,
    private readonly files: FileService,
  ) {}

  // -------------------------------------------------------------------------
  // Designs
  // -------------------------------------------------------------------------

  async list(companyId: string, options: { archived?: boolean } = {}): Promise<TableView[]> {
    const rows = await this.handle.db
      .select()
      .from(dataTables)
      .where(and(eq(dataTables.companyId, companyId), options.archived ? isNotNull(dataTables.archivedAt) : isNull(dataTables.archivedAt)))
      .orderBy(asc(dataTables.name));
    const counts = await this.handle.db
      .select({ tableId: dataRecords.tableId, n: sql<number>`count(*)::int` })
      .from(dataRecords)
      .where(and(eq(dataRecords.companyId, companyId), isNull(dataRecords.archivedAt)))
      .groupBy(dataRecords.tableId);
    const byTable = new Map(counts.map((c) => [c.tableId, c.n]));
    return rows.map((row) => this.view(row, byTable.get(row.id) ?? 0));
  }

  /** A table by its key or id. */
  async get(companyId: string, ref: string): Promise<TableView> {
    const row = await this.row(companyId, ref);
    return this.view(row, await this.count(row.id));
  }

  async create(companyId: string, input: NewTable, by: string): Promise<TableView> {
    const key = input.key ?? (await this.freeKey(companyId, tableKeyOf(input.name)));
    const design = TableDesign.parse({ ...input, key });
    const settings = TableSettings.parse(input.settings ?? {});
    const [taken] = await this.handle.db
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(and(eq(dataTables.companyId, companyId), eq(dataTables.key, design.key)));
    if (taken) throw new TableError(`There is already a table called ${design.key}`, 409);
    await this.checkLinks(companyId, design);
    const [row] = await this.handle.db
      .insert(dataTables)
      .values({
        companyId,
        key: design.key,
        name: design.name,
        description: design.description,
        departmentId: input.departmentId ?? null,
        fields: design.fields as unknown as Record<string, unknown>[],
        titleField: design.titleField ?? null,
        settings,
        createdBy: by,
      })
      .returning();
    await this.syncActions(companyId);
    return this.view(row!, 0);
  }

  /**
   * Change a table: its name, fields, department or settings. When a field's kind changes, the
   * records' values are converted; when some can't be, nothing changes and the problem says which.
   */
  async change(companyId: string, ref: string, changes: TableChanges): Promise<TableView> {
    const row = await this.row(companyId, ref);
    const before = designOf(row);
    const design = this.designAfter(row, changes);
    await this.checkLinks(companyId, design);
    const redesigned = !sameData(design.fields, before.fields) || design.titleField !== before.titleField;
    if (changes.fields) {
      const problems = await this.convertValues(companyId, row, before, design, changes.renames ?? {}, true);
      if (problems.length) {
        throw new TableError(
          `Some records don't fit the change (${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}). Correct them first.`,
          409,
        );
      }
    }
    const [updated] = await this.handle.db
      .update(dataTables)
      .set({
        name: design.name,
        description: design.description,
        fields: design.fields as unknown as Record<string, unknown>[],
        titleField: design.titleField ?? null,
        ...(changes.departmentId !== undefined ? { departmentId: changes.departmentId } : {}),
        ...(changes.settings ? { settings: TableSettings.parse({ ...settingsOf(row), ...changes.settings }) } : {}),
        ...(redesigned ? { version: row.version + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dataTables.id, row.id))
      .returning();
    await this.syncActions(companyId);
    return this.view(updated!, await this.count(row.id));
  }

  /** The records that wouldn't fit a change, as it would be made (nothing changes): empty when all do. */
  async checkChange(companyId: string, ref: string, changes: TableChanges): Promise<string[]> {
    const row = await this.row(companyId, ref);
    const design = this.designAfter(row, changes);
    await this.checkLinks(companyId, design);
    return changes.fields ? this.convertValues(companyId, row, designOf(row), design, changes.renames ?? {}, false) : [];
  }

  private designAfter(row: TableRow, changes: TableChanges): TableDesign {
    const before = designOf(row);
    return TableDesign.parse({
      key: row.key,
      name: changes.name ?? before.name,
      description: changes.description ?? before.description,
      fields: changes.fields ?? before.fields,
      titleField: changes.titleField === undefined ? before.titleField : changes.titleField || undefined,
    });
  }

  /** Put a table away (its records are kept; AI employees no longer reach it), or bring it back. */
  async archive(companyId: string, ref: string, archived = true): Promise<TableView> {
    const row = await this.row(companyId, ref);
    const [updated] = await this.handle.db
      .update(dataTables)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(dataTables.id, row.id))
      .returning();
    await this.syncActions(companyId);
    return this.view(updated!, await this.count(row.id));
  }

  /** Take back a table nobody has used yet (no records): what making an app undoes when the app can't be made. */
  async remove(companyId: string, ref: string): Promise<void> {
    const row = await this.row(companyId, ref);
    const [used] = await this.handle.db.select({ id: dataRecords.id }).from(dataRecords).where(eq(dataRecords.tableId, row.id)).limit(1);
    if (used) throw new TableError(`${row.name} has records; archive it instead`, 409);
    await this.handle.db.delete(dataTables).where(eq(dataTables.id, row.id));
    await this.syncActions(companyId);
  }

  private async row(companyId: string, ref: string): Promise<TableRow> {
    const [row] = await this.handle.db
      .select()
      .from(dataTables)
      .where(and(eq(dataTables.companyId, companyId), UUID.test(ref) ? eq(dataTables.id, ref) : eq(dataTables.key, ref)));
    if (!row) throw new TableError(`There is no table "${ref}"`, 404);
    return row;
  }

  /** A table whose records can change (not archived). */
  private async live(companyId: string, ref: string): Promise<TableRow> {
    const row = await this.row(companyId, ref);
    if (row.archivedAt) throw new TableError(`${row.name} is archived; bring it back first`, 409);
    return row;
  }

  private async count(tableId: string): Promise<number> {
    const [row] = await this.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dataRecords)
      .where(and(eq(dataRecords.tableId, tableId), isNull(dataRecords.archivedAt)));
    return row?.n ?? 0;
  }

  private view(row: TableRow, records: number): TableView {
    const design = designOf(row);
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      departmentId: row.departmentId,
      fields: design.fields,
      titleField: titleFieldOf(design),
      settings: settingsOf(row),
      version: row.version,
      records,
      createdBy: actorLabel(row.createdBy),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }

  /** "supplier_complaints", else "supplier_complaints_2"… */
  private async freeKey(companyId: string, base: string): Promise<string> {
    const rows = await this.handle.db.select({ key: dataTables.key }).from(dataTables).where(eq(dataTables.companyId, companyId));
    const taken = new Set(rows.map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  /** Link fields must point at a table of the company (or the table itself). */
  private async checkLinks(companyId: string, design: TableDesign): Promise<void> {
    const targets = [...new Set(design.fields.filter((f) => f.type === "link" && f.table !== design.key).map((f) => f.table!))];
    if (!targets.length) return;
    const rows = await this.handle.db
      .select({ key: dataTables.key })
      .from(dataTables)
      .where(and(eq(dataTables.companyId, companyId), inArray(dataTables.key, targets)));
    const missing = targets.filter((t) => !rows.some((r) => r.key === t));
    if (missing.length) throw new TableError(`There is no table ${missing.join(", ")} to point at`);
  }

  /** Convert the records' values of fields whose kind or choices changed; refuse if some don't fit. */
  /**
   * Convert the records' values of fields whose kind or choices changed (a renamed choice value first
   * becomes its new name); what doesn't fit is returned, and nothing is written unless all fit and `apply`.
   */
  private async convertValues(
    companyId: string,
    row: TableRow,
    before: TableDesign,
    after: TableDesign,
    renames: Record<string, Record<string, string>>,
    apply: boolean,
  ): Promise<string[]> {
    const old = new Map(before.fields.map((f) => [f.key, f]));
    const changed = after.fields.filter((f) => {
      const was = old.get(f.key);
      return (
        !was || was.type !== f.type || !sameData(was.choices ?? [], f.choices ?? []) || was.table !== f.table || was.currency !== f.currency || renames[f.key]
      );
    });
    if (!changed.length) return [];
    const records = await this.handle.db
      .select({ id: dataRecords.id, number: dataRecords.number, data: dataRecords.data })
      .from(dataRecords)
      .where(eq(dataRecords.tableId, row.id));
    const resolvers = this.resolvers(companyId);
    const problems: string[] = [];
    const updates: { id: string; data: Record<string, unknown> }[] = [];
    for (const record of records) {
      const given = Object.fromEntries(
        changed
          .filter((f) => record.data[f.key] !== undefined && record.data[f.key] !== null)
          .map((f) => {
            const value = record.data[f.key];
            return [f.key, typeof value === "string" && renames[f.key]?.[value] !== undefined ? renames[f.key]![value] : value];
          }),
      );
      if (!Object.keys(given).length) continue;
      try {
        const converted = await checkRecordValues(after, given, resolvers, { partial: true });
        if (!sameData(converted, Object.fromEntries(Object.keys(given).map((k) => [k, record.data[k]]))))
          updates.push({ id: record.id, data: { ...record.data, ...converted } });
      } catch (error) {
        if (!(error instanceof RecordValueError)) throw error;
        problems.push(...error.problems.map((p) => `#${record.number}: ${p}`));
      }
    }
    if (problems.length || !apply) return problems;
    for (const update of updates) await this.handle.db.update(dataRecords).set({ data: update.data }).where(eq(dataRecords.id, update.id));
    return [];
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async records(companyId: string, ref: string, query: RecordQuery = {}): Promise<{ table: TableView; records: RecordView[]; total: number }> {
    const row = await this.row(companyId, ref);
    const conditions = await this.conditions(companyId, row, query);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? 50)));
    const rows = await this.handle.db
      .select()
      .from(dataRecords)
      .where(and(...conditions))
      .orderBy(...this.order(row, query))
      .limit(limit)
      .offset(Math.max(0, Math.floor(query.offset ?? 0)));
    const [total] = await this.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dataRecords)
      .where(and(...conditions));
    return { table: this.view(row, await this.count(row.id)), records: await this.views(companyId, row, rows), total: total?.n ?? 0 };
  }

  /** One record by its number ("12", "#12") or id. */
  async record(companyId: string, ref: string, recordRef: string): Promise<RecordView> {
    const row = await this.row(companyId, ref);
    return (await this.views(companyId, row, [await this.recordRow(row, recordRef)]))[0]!;
  }

  async add(companyId: string, ref: string, input: Record<string, unknown>, by: ChangeBy): Promise<RecordView> {
    const row = await this.live(companyId, ref);
    const values = withoutEmpty(await checkRecordValues(designOf(row), input, this.resolvers(companyId)));
    const number = await this.reserve(row.id, 1);
    const [record] = await this.handle.db
      .insert(dataRecords)
      .values({ companyId, tableId: row.id, number, data: values, createdBy: by.actor, updatedBy: by.actor })
      .returning();
    await this.remember(companyId, row.id, record!.id, "created", diff({}, values), by);
    return (await this.views(companyId, row, [record!]))[0]!;
  }

  /** Change some of a record's values; the others stay. An empty value clears its field. */
  async update(companyId: string, ref: string, recordRef: string, input: Record<string, unknown>, by: ChangeBy): Promise<RecordView> {
    const row = await this.live(companyId, ref);
    const current = await this.recordRow(row, recordRef);
    if (current.archivedAt) throw new TableError(`#${current.number} is archived; bring it back first`, 409);
    const values = await checkRecordValues(designOf(row), input, this.resolvers(companyId), { partial: true });
    const next = { ...current.data };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const changes = diff(current.data, next);
    if (!Object.keys(changes).length) return (await this.views(companyId, row, [current]))[0]!;
    // Merged in the database, so two changes to different fields at once both stay.
    const set = withoutEmpty(values);
    let data: SQL = sql`(${dataRecords.data} || ${JSON.stringify(set)}::jsonb)`;
    for (const [key, value] of Object.entries(values)) if (value === null) data = sql`(${data} - ${key}::text)`;
    const [updated] = await this.handle.db
      .update(dataRecords)
      .set({ data, updatedBy: by.actor, updatedAt: new Date() })
      .where(eq(dataRecords.id, current.id))
      .returning();
    await this.remember(companyId, row.id, current.id, "updated", changes, by);
    return (await this.views(companyId, row, [updated!]))[0]!;
  }

  /** Put a record away (it stays in the history and can be brought back), or bring it back. */
  async archiveRecord(companyId: string, ref: string, recordRef: string, by: ChangeBy, archived = true): Promise<RecordView> {
    const row = await this.live(companyId, ref);
    const current = await this.recordRow(row, recordRef);
    if (Boolean(current.archivedAt) === archived) return (await this.views(companyId, row, [current]))[0]!;
    const [updated] = await this.handle.db
      .update(dataRecords)
      .set({ archivedAt: archived ? new Date() : null, updatedBy: by.actor, updatedAt: new Date() })
      .where(eq(dataRecords.id, current.id))
      .returning();
    await this.remember(companyId, row.id, current.id, archived ? "archived" : "restored", {}, by);
    return (await this.views(companyId, row, [updated!]))[0]!;
  }

  /** Every change to a record, newest first: who, when, and each field before and after. */
  async history(companyId: string, ref: string, recordRef: string): Promise<RecordChangeView[]> {
    const row = await this.row(companyId, ref);
    const record = await this.recordRow(row, recordRef);
    const changes = await this.handle.db
      .select()
      .from(dataRecordChanges)
      .where(eq(dataRecordChanges.recordId, record.id))
      .orderBy(sql`${dataRecordChanges.createdAt} desc`);
    const design = designOf(row);
    const fields = new Map(design.fields.map((f) => [f.key, f]));
    const links = changes.flatMap((c) =>
      Object.entries(c.changes as Record<string, { from: unknown; to: unknown }>)
        .filter(([key]) => fields.get(key)?.type === "link")
        .flatMap(([, v]) => [v.from, v.to]),
    );
    const people = changes.flatMap((c) =>
      Object.entries(c.changes as Record<string, { from: unknown; to: unknown }>)
        .filter(([key]) => fields.get(key)?.type === "person")
        .flatMap(([, v]) => [v.from, v.to]),
    );
    const linked = await this.linkedTitles(
      companyId,
      links.filter((v): v is string => typeof v === "string"),
    );
    const names = await this.peopleNames(
      companyId,
      people.filter((v): v is string => typeof v === "string"),
    );
    const actors = await this.actorNames(
      companyId,
      changes.map((c) => c.by),
    );
    const shown = (key: string, value: unknown): unknown => {
      if (typeof value !== "string") return value;
      const type = fields.get(key)?.type;
      if (type === "link") return linked.get(value) ?? "(a removed record)";
      if (type === "person") return names.get(value) ?? value;
      return value;
    };
    // In the table's order of fields (the database keeps them in its own).
    const position = (key: string) => {
      const index = design.fields.findIndex((f) => f.key === key);
      return index < 0 ? design.fields.length : index;
    };
    return changes.map((c) => ({
      id: c.id,
      action: c.action,
      changes: Object.entries(c.changes as Record<string, { from: unknown; to: unknown }>)
        .sort(([a], [b]) => position(a) - position(b))
        .map(([key, v]) => ({
          key,
          label: fields.get(key)?.label ?? key,
          from: shown(key, v.from),
          to: shown(key, v.to),
        })),
      by: actors.get(c.by) ?? actorLabel(c.by),
      ai: c.by.startsWith("agent:"),
      runId: c.runId,
      createdAt: c.createdAt,
    }));
  }

  /**
   * Rows from a sheet as records: each column goes to the field of its name (key or label). With
   * `dryRun` nothing is added: what would be added and each row's problems are returned.
   */
  async importRows(
    companyId: string,
    ref: string,
    rows: Record<string, unknown>[],
    by: ChangeBy,
    options: { dryRun?: boolean; /** Each row's number in the sheet (else counted from 2, below the column names). */ rowNumbers?: number[] } = {},
  ): Promise<ImportResult> {
    const row = await this.live(companyId, ref);
    const design = designOf(row);
    const columns: Record<string, string> = {};
    const ignored: string[] = [];
    for (const header of new Set(rows.flatMap((r) => Object.keys(r)))) {
      const name = header.trim().toLowerCase();
      const field = design.fields.find((f) => f.key === name || f.label.toLowerCase() === name);
      if (field && !Object.values(columns).includes(field.key)) columns[header] = field.key;
      else ignored.push(header);
    }
    const resolvers = this.resolvers(companyId);
    const ready: Record<string, unknown>[] = [];
    const problems: ImportResult["problems"] = [];
    for (const [index, source] of rows.entries()) {
      const input = Object.fromEntries(Object.entries(columns).map(([header, key]) => [key, source[header]]));
      if (Object.values(input).every((v) => v === undefined || v === null || String(v).trim() === "")) continue;
      try {
        ready.push(withoutEmpty(await checkRecordValues(design, input, resolvers)));
      } catch (error) {
        if (!(error instanceof RecordValueError)) throw error;
        problems.push({ row: options.rowNumbers?.[index] ?? index + 2, problems: error.problems });
      }
    }
    if (options.dryRun || !ready.length) return { columns, ignored, ready: ready.length, added: 0, problems };
    const first = await this.reserve(row.id, ready.length);
    for (let start = 0; start < ready.length; start += 200) {
      const chunk = ready.slice(start, start + 200);
      const inserted = await this.handle.db
        .insert(dataRecords)
        .values(chunk.map((data, i) => ({ companyId, tableId: row.id, number: first + start + i, data, createdBy: by.actor, updatedBy: by.actor })))
        .returning({ id: dataRecords.id, data: dataRecords.data });
      await this.handle.db.insert(dataRecordChanges).values(
        inserted.map((r) => ({
          companyId,
          tableId: row.id,
          recordId: r.id,
          action: "imported",
          changes: diff({}, r.data),
          by: by.actor,
          runId: by.runId && UUID.test(by.runId) ? by.runId : null,
        })),
      );
    }
    return { columns, ignored, ready: ready.length, added: ready.length, problems };
  }

  private async recordRow(table: TableRow, recordRef: string): Promise<RecordRow> {
    const ref = recordRef.trim();
    const number = /^#?(\d+)$/.exec(ref);
    if (!number && !UUID.test(ref)) throw new TableError(`Give the record's number (e.g. 12), not "${recordRef}"`);
    const [row] = await this.handle.db
      .select()
      .from(dataRecords)
      .where(and(eq(dataRecords.tableId, table.id), number ? eq(dataRecords.number, Number(number[1])) : eq(dataRecords.id, ref)));
    if (!row) throw new TableError(`${table.name} has no record ${number ? `#${number[1]}` : ref}`, 404);
    return row;
  }

  /** Numbers for the next records of a table: the first of `count` in a row. */
  private async reserve(tableId: string, count: number): Promise<number> {
    const [row] = await this.handle.db
      .update(dataTables)
      .set({ nextNumber: sql`${dataTables.nextNumber} + ${count}` })
      .where(eq(dataTables.id, tableId))
      .returning({ next: dataTables.nextNumber });
    return row!.next - count;
  }

  private async remember(companyId: string, tableId: string, recordId: string, action: string, changes: Record<string, unknown>, by: ChangeBy): Promise<void> {
    await this.handle.db.insert(dataRecordChanges).values({
      companyId,
      tableId,
      recordId,
      action,
      changes,
      by: by.actor,
      runId: by.runId && UUID.test(by.runId) ? by.runId : null,
    });
  }

  private async conditions(companyId: string, row: TableRow, query: RecordQuery): Promise<SQL[]> {
    const design = designOf(row);
    const conditions: SQL[] = [eq(dataRecords.tableId, row.id), query.archived ? isNotNull(dataRecords.archivedAt) : isNull(dataRecords.archivedAt)];
    const words = (query.search ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length) {
      // Words are looked for in what people read: not in links' ids or files' ids.
      const searchable = design.fields.filter((f) => f.type !== "link" && f.type !== "file");
      const text = searchable.length
        ? sql`concat_ws(' ', ${sql.join(
            searchable.map((f) => sql`${dataRecords.data} ->> ${f.key}::text`),
            sql`, `,
          )})`
        : sql`''`;
      for (const word of words) {
        const number = /^#?(\d+)$/.exec(word);
        conditions.push(number ? sql`(${text} ilike ${like(word)} or ${dataRecords.number} = ${Number(number[1])})` : sql`${text} ilike ${like(word)}`);
      }
    }
    const where = Object.fromEntries(Object.entries(query.where ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    if (Object.keys(where).length) {
      const values = await checkRecordValues(design, where, this.resolvers(companyId), { partial: true });
      for (const [key, value] of Object.entries(values)) conditions.push(sql`${dataRecords.data} -> ${key}::text = ${JSON.stringify(value)}::jsonb`);
    }
    return conditions;
  }

  private order(row: TableRow, query: RecordQuery): SQL[] {
    const desc = query.direction !== "asc";
    const dir = desc ? sql`desc` : sql`asc`;
    const field = designOf(row).fields.find((f) => f.key === query.sort);
    if (query.sort === "created_at") return [sql`${dataRecords.createdAt} ${dir}`, sql`${dataRecords.number} ${dir}`];
    if (query.sort === "updated_at") return [sql`${dataRecords.updatedAt} ${dir}`, sql`${dataRecords.number} ${dir}`];
    if (!field) return [sql`${dataRecords.number} ${dir}`];
    let value: SQL;
    if (field.type === "choice" && field.choices?.length) {
      // In the order of the list (Open, In progress, Closed), not alphabetically.
      value = sql`case ${dataRecords.data} ->> ${field.key}::text ${sql.join(
        field.choices.map((choice, i) => sql`when ${choice}::text then ${i}::int`),
        sql` `,
      )} end`;
    } else if (["number", "money", "yes_no"].includes(field.type)) value = sql`${dataRecords.data} -> ${field.key}::text`;
    else value = sql`lower(${dataRecords.data} ->> ${field.key}::text)`;
    return [sql`${value} ${dir} nulls last`, sql`${dataRecords.number} desc`];
  }

  private async views(companyId: string, table: TableRow, rows: RecordRow[]): Promise<RecordView[]> {
    const design = designOf(table);
    const title = titleFieldOf(design);
    const links = design.fields.filter((f) => f.type === "link");
    const people = design.fields.filter((f) => f.type === "person");
    const strings = (fields: TableField[]) => rows.flatMap((r) => fields.map((f) => r.data[f.key])).filter((v): v is string => typeof v === "string");
    const linked = await this.linkedTitles(companyId, strings(links));
    const names = await this.peopleNames(companyId, strings(people));
    const actors = await this.actorNames(
      companyId,
      rows.flatMap((r) => [r.createdBy, r.updatedBy]),
    );
    return rows.map((r) => {
      const display: Record<string, string> = {};
      for (const f of links) if (typeof r.data[f.key] === "string") display[f.key] = linked.get(r.data[f.key] as string) ?? "(a removed record)";
      for (const f of people) if (typeof r.data[f.key] === "string") display[f.key] = names.get(r.data[f.key] as string) ?? (r.data[f.key] as string);
      const values = Object.fromEntries(design.fields.filter((f) => r.data[f.key] !== undefined).map((f) => [f.key, r.data[f.key]]));
      return {
        id: r.id,
        number: r.number,
        title: display[title] ?? (textOf(r.data[title]) || `#${r.number}`),
        values,
        display,
        createdBy: actors.get(r.createdBy) ?? actorLabel(r.createdBy),
        updatedBy: actors.get(r.updatedBy) ?? actorLabel(r.updatedBy),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        archivedAt: r.archivedAt,
      };
    });
  }

  /** Linked records as they read: "#3 Akın Metal", by id. */
  private async linkedTitles(companyId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id) => UUID.test(id)))];
    if (!unique.length) return new Map();
    const rows = await this.handle.db
      .select({ id: dataRecords.id, number: dataRecords.number, data: dataRecords.data, fields: dataTables.fields, titleField: dataTables.titleField })
      .from(dataRecords)
      .innerJoin(dataTables, eq(dataTables.id, dataRecords.tableId))
      .where(and(eq(dataRecords.companyId, companyId), inArray(dataRecords.id, unique)));
    return new Map(
      rows.map((r) => {
        const title = textOf(r.data[titleFieldOf({ fields: r.fields as unknown as TableField[], ...(r.titleField ? { titleField: r.titleField } : {}) })]);
        return [r.id, title ? `#${r.number} ${title}` : `#${r.number}`];
      }),
    );
  }

  private async peopleNames(companyId: string, emails: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(emails)];
    if (!unique.length) return new Map();
    const rows = await this.handle.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(and(eq(users.companyId, companyId), inArray(users.email, unique)));
    return new Map(rows.map((r) => [r.email, r.name]));
  }

  /** How the people and AI employees who made changes read. */
  private async actorNames(companyId: string, actors: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(actors)];
    const ids = unique.map((a) => /^agent:(.+)$/.exec(a)?.[1]).filter((id): id is string => Boolean(id && UUID.test(id)));
    const rows = ids.length
      ? await this.handle.db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)))
      : [];
    const named = new Map(rows.map((r) => [`agent:${r.id}`, r.name]));
    return new Map(unique.map((a) => [a, named.get(a) ?? actorLabel(a)]));
  }

  /** Looks up people, linked records and files for values; each answer is kept for the rest of the call. */
  private resolvers(companyId: string): ValueResolvers {
    const people = new Map<string, Promise<string | undefined>>();
    const links = new Map<string, Promise<string | undefined>>();
    const files = new Map<string, Promise<boolean>>();
    return {
      person: (value) => memo(people, value.toLowerCase(), () => this.findPerson(companyId, value)),
      link: (tableKey, value) => memo(links, `${tableKey}\n${value}`, () => this.findLinked(companyId, tableKey, value)),
      file: (id) =>
        memo(files, id, async () =>
          UUID.test(id)
            ? this.files.meta(companyId, id).then(
                () => true,
                () => false,
              )
            : false,
        ),
    };
  }

  /** A person of the company by email, "Name <email>" or name (when only one person has it). */
  private async findPerson(companyId: string, value: string): Promise<string | undefined> {
    const email = (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
    if (email.includes("@")) {
      const [row] = await this.handle.db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.email, email)));
      return row?.email;
    }
    const rows = await this.handle.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.companyId, companyId), sql`lower(${users.name}) = ${value.trim().toLowerCase()}`))
      .limit(2);
    return rows.length === 1 ? rows[0]!.email : undefined;
  }

  /** A record of a table by id, number ("12", "#12", "#12 Akın Metal") or title (when only one has it). */
  private async findLinked(companyId: string, tableKey: string, value: string): Promise<string | undefined> {
    const table = await this.row(companyId, tableKey).catch(() => undefined);
    if (!table) return undefined;
    const text = value.trim();
    const number = /^#(\d+)\b/.exec(text) ?? /^(\d+)$/.exec(text);
    const match = UUID.test(text)
      ? eq(dataRecords.id, text)
      : number
        ? eq(dataRecords.number, Number(number[1]))
        : sql`lower(${dataRecords.data} ->> ${titleFieldOf(designOf(table))}::text) = ${text.toLowerCase()}`;
    const rows = await this.handle.db
      .select({ id: dataRecords.id })
      .from(dataRecords)
      .where(and(eq(dataRecords.tableId, table.id), isNull(dataRecords.archivedAt), match))
      .limit(2);
    return rows.length === 1 ? rows[0]!.id : undefined;
  }

  /** Records counted, or a number field added up or averaged, in groups by a field (a date by month). */
  async summarize(companyId: string, ref: string, query: SummaryQuery = {}): Promise<Summary> {
    const row = await this.row(companyId, ref);
    const design = designOf(row);
    const conditions = await this.conditions(companyId, row, { where: query.where });
    const of = query.measure?.of ?? "count";
    let value: SQL<number> = sql<number>`count(*)::float8`;
    if (of !== "count") {
      const field = design.fields.find((f) => f.key === query.measure?.field);
      if (!field || (field.type !== "number" && field.type !== "money"))
        throw new TableError(`To ${of === "sum" ? "add up" : "average"}, name a number field of ${row.name}`);
      const number = sql`(${dataRecords.data} ->> ${field.key}::text)::numeric`;
      value = of === "sum" ? sql<number>`coalesce(sum(${number}), 0)::float8` : sql<number>`coalesce(avg(${number}), 0)::float8`;
    }
    const [all] = await this.handle.db
      .select({ value })
      .from(dataRecords)
      .where(and(...conditions));
    const total = all?.value ?? 0;
    if (!query.groupBy) return { groups: [], total };
    const group = design.fields.find((f) => f.key === query.groupBy);
    if (!group) throw new TableError(`${row.name} has no field "${query.groupBy}"`);
    const bucket = group.type === "date" ? sql`substr(${dataRecords.data} ->> ${group.key}::text, 1, 7)` : sql`${dataRecords.data} ->> ${group.key}::text`;
    // Grouped by the first column: the same expression written twice would be two different parameters.
    const rows = (await this.handle.db
      .select({ key: sql<string | null>`${bucket}`, value })
      .from(dataRecords)
      .where(and(...conditions))
      .groupBy(sql.raw("1"))) as { key: string | null; value: number }[];
    const linked =
      group.type === "link"
        ? await this.linkedTitles(
            companyId,
            rows.flatMap((r) => (r.key ? [r.key] : [])),
          )
        : new Map<string, string>();
    const names =
      group.type === "person"
        ? await this.peopleNames(
            companyId,
            rows.flatMap((r) => (r.key ? [r.key] : [])),
          )
        : new Map<string, string>();
    const label = (key: string | null): string => {
      if (key === null) return "Not given";
      if (group.type === "yes_no") return key === "true" ? "Yes" : "No";
      if (group.type === "link") return linked.get(key) ?? "(a removed record)";
      if (group.type === "person") return names.get(key) ?? key;
      return key;
    };
    let groups = rows.map((r) => ({ key: r.key, label: label(r.key), value: r.value }));
    const position = (key: string | null) => (key === null ? Infinity : (group.choices ?? []).indexOf(key) >= 0 ? (group.choices ?? []).indexOf(key) : 1000);
    if (group.type === "choice") groups.sort((a, b) => position(a.key) - position(b.key));
    else if (group.type === "date") groups.sort((a, b) => (a.key ?? "9999").localeCompare(b.key ?? "9999"));
    else groups.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const limit = query.limit;
    if (limit && groups.length > limit && group.type !== "date") {
      const kept = [...groups].sort((a, b) => b.value - a.value).slice(0, limit - 1);
      const rest = groups.filter((g) => !kept.includes(g));
      groups = [
        ...groups.filter((g) => kept.includes(g)),
        {
          key: "__other__",
          label: "Other",
          value: of === "average" ? rest.reduce((sum, g) => sum + g.value, 0) / rest.length : rest.reduce((sum, g) => sum + g.value, 0),
        },
      ];
    }
    return { groups, total };
  }

  /**
   * A table's records as plain rows, for calculations: each field by key (a person by name, a linked
   * record by its name), with "number" and "created_at". At most `limit` rows, oldest first.
   */
  async rowsFor(companyId: string, ref: string, limit = 20_000): Promise<Record<string, unknown>[]> {
    const row = await this.row(companyId, ref);
    const design = designOf(row);
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; rows.length < limit; offset += 500) {
      const page = await this.handle.db
        .select()
        .from(dataRecords)
        .where(and(eq(dataRecords.tableId, row.id), isNull(dataRecords.archivedAt)))
        .orderBy(asc(dataRecords.number))
        .limit(Math.min(500, limit - rows.length))
        .offset(offset);
      for (const view of await this.views(companyId, row, page)) {
        const out: Record<string, unknown> = { number: view.number, created_at: view.createdAt.toISOString() };
        for (const field of design.fields) {
          const value = view.values[field.key];
          if (value === undefined) out[field.key] = null;
          else if (field.type === "person") out[field.key] = view.display[field.key] ?? value;
          else if (field.type === "link") out[field.key] = (view.display[field.key] ?? String(value)).replace(/^#\d+\s*/, "");
          else out[field.key] = value;
        }
        rows.push(out);
      }
      if (page.length < 500) break;
    }
    return rows;
  }

  /** Problems with values for a table's fields (a filter, an action's values), without saving anything. */
  async checkValues(companyId: string, ref: string, values: Record<string, unknown>): Promise<string[]> {
    const row = await this.row(companyId, ref);
    try {
      await checkRecordValues(designOf(row), values, this.resolvers(companyId), { partial: true });
      return [];
    } catch (error) {
      if (error instanceof RecordValueError) return error.problems;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // AI employees
  // -------------------------------------------------------------------------

  /** The company's tables as AI employees reach them through the Tables connection. */
  storeFor(companyId: string): TableStore {
    const plain = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        // Problems an AI employee can correct come back as such.
        if (error instanceof RecordValueError) throw new ConnectorError(error.message, "validation");
        if (error instanceof TableError) throw new ConnectorError(error.message, error.status === 404 ? "not_found" : "validation");
        throw error;
      }
    };
    return {
      find: (table, query) =>
        plain(async () => {
          const found = await this.records(companyId, table, { ...query, limit: query.limit ?? 20 });
          return { records: found.records.map((r) => forAi(r, found.table)), total: found.total };
        }),
      get: (table, record) =>
        plain(async () => {
          const row = await this.row(companyId, table);
          const view = (await this.views(companyId, row, [await this.recordRow(row, record)]))[0]!;
          return forAi(view, this.view(row, 0));
        }),
      add: (table, values, by) =>
        plain(async () => {
          const view = await this.add(companyId, table, values, by);
          return forAi(view, await this.get(companyId, table));
        }),
      update: (table, record, values, by) =>
        plain(async () => {
          const view = await this.update(companyId, table, record, values, by);
          return forAi(view, await this.get(companyId, table));
        }),
    };
  }

  /**
   * Keep the company's Tables connection in step with its tables: made with the first table, and
   * offering each table's actions (archived tables' are taken away).
   */
  async syncActions(companyId: string): Promise<void> {
    const tables = await this.list(companyId);
    let connection = (await this.connectors.list(companyId)).find((c) => c.type === "tables");
    if (!connection) {
      if (!tables.length) return;
      connection = await this.connectors.create(companyId, { type: "tables", name: "Tables", values: {} });
      await this.connectors.test(companyId, connection.id);
    }
    await this.connectors.setActions(
      companyId,
      connection.id,
      tables.flatMap((t) => tableActions(t)),
    );
  }

  /** The id of the company's Tables connection (made when missing), for AI employees' bindings. */
  async connectionId(companyId: string): Promise<string | undefined> {
    const connection = (await this.connectors.list(companyId)).find((c) => c.type === "tables");
    if (connection) return connection.id;
    await this.syncActions(companyId);
    return (await this.connectors.list(companyId)).find((c) => c.type === "tables")?.id;
  }
}

/** Values stored: cleared fields are simply absent. */
function withoutEmpty(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

/** A record as an AI employee reads it: its number, each field (links and people as they read) and when. */
function forAi(record: RecordView, table: Pick<TableView, "fields">): Record<string, unknown> {
  const out: Record<string, unknown> = { number: record.number };
  for (const field of table.fields) {
    const value = record.values[field.key];
    if (value === undefined) continue;
    if (field.type === "person")
      out[field.key] = record.display[field.key] && record.display[field.key] !== value ? `${record.display[field.key]} <${String(value)}>` : value;
    else if (field.type === "link") out[field.key] = record.display[field.key] ?? value;
    else out[field.key] = value;
  }
  out.created_at = record.createdAt.toISOString();
  out.updated_at = record.updatedAt.toISOString();
  if (record.archivedAt) out.archived = true;
  return out;
}
