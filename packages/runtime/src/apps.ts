import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  agentsOfApp,
  AppDesign,
  calculationsOfApp,
  AppSettings,
  sameData,
  tableKeyOf,
  tablesOfApp,
  type AppBlock,
  type AppDesignInput,
  type AppPage,
  type BlockFilter,
  type RecordAction,
  type TableField,
} from "@enterprise-brain/core";
import { dataApps, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import type { CalculationService } from "./calculations.ts";
import type { TableService, TableView } from "./tables.ts";
import type { VersionService } from "./versions.ts";

/**
 * Apps: pages of blocks on the company's tables, drawn by the platform from their description. Every
 * block is checked against its table (its fields exist, a board's columns are a choice, a sum is of a
 * number) and every button against the AI employee it gives work to, so an app that is saved works.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "AppError";
  }
}

type AppRow = typeof dataApps.$inferSelect;

export interface AppView {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string | null;
  departmentId: string | null;
  pages: AppPage[];
  settings: AppSettings;
  version: number;
  /** The tables its blocks show (keys). */
  tables: string[];
  /** The AI employees its buttons give work to (slugs). */
  agents: string[];
  /** The calculations whose results it shows (keys). */
  calculations: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export type NewApp = Omit<AppDesignInput, "key"> & { key?: string; departmentId?: string | null; settings?: Partial<AppSettings> };
export type AppChanges = Partial<Pick<AppDesignInput, "name" | "description" | "icon" | "pages">> & {
  departmentId?: string | null;
  settings?: Partial<AppSettings>;
  /** Who changed it, and why (kept with the version). */
  by?: string;
  note?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUPABLE: TableField["type"][] = ["choice", "person", "link", "yes_no", "date", "text", "email"];

export class AppService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly tables: TableService,
    private readonly agents: AgentService,
    private readonly calculations?: CalculationService,
    private readonly versions?: VersionService,
  ) {}

  async list(companyId: string, options: { archived?: boolean } = {}): Promise<AppView[]> {
    const rows = await this.handle.db
      .select()
      .from(dataApps)
      .where(and(eq(dataApps.companyId, companyId), options.archived ? isNotNull(dataApps.archivedAt) : isNull(dataApps.archivedAt)))
      .orderBy(asc(dataApps.name));
    return rows.map((row) => this.view(row));
  }

  /** An app by its key or id. */
  async get(companyId: string, ref: string): Promise<AppView> {
    return this.view(await this.row(companyId, ref));
  }

  async create(companyId: string, input: NewApp, by: string): Promise<AppView> {
    const key = input.key ?? (await this.freeKey(companyId, tableKeyOf(input.name)));
    const design = AppDesign.parse({ ...input, key });
    const [taken] = await this.handle.db
      .select({ id: dataApps.id })
      .from(dataApps)
      .where(and(eq(dataApps.companyId, companyId), eq(dataApps.key, design.key)));
    if (taken) throw new AppError(`There is already an app called ${design.key}`, 409);
    await this.assertWorks(companyId, design);
    const [row] = await this.handle.db
      .insert(dataApps)
      .values({
        companyId,
        key: design.key,
        name: design.name,
        description: design.description,
        icon: design.icon ?? null,
        departmentId: input.departmentId ?? null,
        pages: design.pages as unknown as Record<string, unknown>[],
        settings: AppSettings.parse(input.settings ?? {}),
        createdBy: by,
      })
      .returning();
    await this.versions?.record(companyId, { type: "app", id: row!.id }, 1, appSnapshot(row!), by.replace(/\s*<[^>]*>$/, ""));
    return this.view(row!);
  }

  async change(companyId: string, ref: string, changes: AppChanges): Promise<AppView> {
    const row = await this.row(companyId, ref);
    const before = this.view(row);
    const design = AppDesign.parse({
      key: row.key,
      name: changes.name ?? before.name,
      description: changes.description ?? before.description,
      icon: changes.icon === undefined ? (before.icon ?? undefined) : changes.icon || undefined,
      pages: changes.pages ?? before.pages,
    });
    if (changes.pages) await this.assertWorks(companyId, design);
    const redesigned = !sameData(design.pages, before.pages);
    const [updated] = await this.handle.db
      .update(dataApps)
      .set({
        name: design.name,
        description: design.description,
        icon: design.icon ?? null,
        pages: design.pages as unknown as Record<string, unknown>[],
        ...(changes.departmentId !== undefined ? { departmentId: changes.departmentId } : {}),
        ...(changes.settings ? { settings: AppSettings.parse({ ...before.settings, ...changes.settings }) } : {}),
        ...(redesigned ? { version: row.version + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dataApps.id, row.id))
      .returning();
    if (redesigned && this.versions) {
      await this.versions.record(companyId, { type: "app", id: row.id }, row.version, appSnapshot(row), row.createdBy.replace(/\s*<[^>]*>$/, ""));
      await this.versions.record(companyId, { type: "app", id: row.id }, updated!.version, appSnapshot(updated!), changes.by ?? "", changes.note ?? "");
    }
    return this.view(updated!);
  }

  async archive(companyId: string, ref: string, archived = true): Promise<AppView> {
    const row = await this.row(companyId, ref);
    const [updated] = await this.handle.db
      .update(dataApps)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(dataApps.id, row.id))
      .returning();
    return this.view(updated!);
  }

  /** What in a design doesn't work with the company's tables and AI employees (empty when it all does). */
  async check(companyId: string, design: Pick<AppDesign, "pages">): Promise<string[]> {
    const problems: string[] = [];
    const tables = new Map<string, TableView | undefined>();
    for (const key of tablesOfApp(design)) tables.set(key, await this.tables.get(companyId, key).catch(() => undefined));
    for (const key of calculationsOfApp(design)) {
      const calculation = await this.calculations?.get(companyId, key).catch(() => undefined);
      if (!calculation) problems.push(`There is no calculation "${key}" to show`);
    }
    for (const slug of agentsOfApp(design)) {
      const agent = await this.agents.find(companyId, slug);
      if (!agent || agent.row.status === "archived") problems.push(`There is no AI employee "${slug}" to give work to`);
    }
    for (const page of design.pages) {
      for (const [index, block] of page.blocks.entries()) {
        const where = `${page.title}, ${block.title ?? `block ${index + 1}`}`;
        if (!("table" in block)) continue;
        const table = tables.get(block.table);
        if (!table) {
          problems.push(`${where}: there is no table "${block.table}"`);
          continue;
        }
        if (table.archivedAt) problems.push(`${where}: ${table.name} is archived`);
        problems.push(...(await this.checkBlock(companyId, block, table)).map((p) => `${where}: ${p}`));
      }
    }
    return problems;
  }

  private async checkBlock(companyId: string, block: Extract<AppBlock, { table: string }>, table: TableView): Promise<string[]> {
    const problems: string[] = [];
    const fields = new Map(table.fields.map((f) => [f.key, f]));
    const known = (key: string | undefined, what: string) => {
      if (key !== undefined && !fields.has(key)) problems.push(`${table.name} has no field "${key}" (${what})`);
      return key === undefined ? undefined : fields.get(key);
    };
    const values = async (given: BlockFilter | Record<string, unknown> | undefined, what: string) => {
      if (!given || !Object.keys(given).length) return;
      for (const key of Object.keys(given)) known(key, what);
      if (Object.keys(given).every((k) => fields.has(k)))
        problems.push(...(await this.tables.checkValues(companyId, table.key, given)).map((p) => `${what}: ${p}`));
    };
    const actions = async (list: RecordAction[] | undefined) => {
      for (const action of list ?? []) if (action.set) await values(action.set, `"${action.label}"`);
    };
    const measure = (m: { of: string; field?: string }) => {
      if (m.of === "count") return;
      const field = known(m.field, `what to ${m.of === "sum" ? "add up" : "average"}`);
      if (field && field.type !== "number" && field.type !== "money")
        problems.push(`${field.label} is not a number to ${m.of === "sum" ? "add up" : "average"}`);
      if (!m.field) problems.push(`name the number to ${m.of === "sum" ? "add up" : "average"}`);
    };
    switch (block.type) {
      case "list":
        for (const key of block.fields ?? []) known(key, "shown");
        known(block.sort?.field, "order");
        known(block.groupBy, "groups");
        await values(block.filter, "filter");
        await actions(block.actions);
        break;
      case "form":
        for (const key of block.fields ?? []) known(key, "asked");
        await values(block.values, "values it gives");
        break;
      case "board": {
        const group = known(block.groupBy, "columns");
        if (group && group.type !== "choice") problems.push(`a board's columns are one of a list; ${group.label} is not`);
        for (const key of block.fields ?? []) known(key, "shown");
        await values(block.filter, "filter");
        await actions(block.actions);
        break;
      }
      case "chart": {
        const group = known(block.groupBy, "bars");
        if (group && !GROUPABLE.includes(group.type)) problems.push(`records can't be grouped by ${group.label}`);
        measure(block.measure);
        await values(block.filter, "filter");
        break;
      }
      case "number":
        measure(block.measure);
        await values(block.filter, "filter");
        break;
    }
    return problems;
  }

  private async assertWorks(companyId: string, design: Pick<AppDesign, "pages">): Promise<void> {
    const problems = await this.check(companyId, design);
    if (problems.length)
      throw new AppError(
        `The app doesn't work yet: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}`,
        400,
        problems,
      );
  }

  private async row(companyId: string, ref: string): Promise<AppRow> {
    const [row] = await this.handle.db
      .select()
      .from(dataApps)
      .where(and(eq(dataApps.companyId, companyId), UUID.test(ref) ? eq(dataApps.id, ref) : eq(dataApps.key, ref)));
    if (!row) throw new AppError(`There is no app "${ref}"`, 404);
    return row;
  }

  private async freeKey(companyId: string, base: string): Promise<string> {
    const rows = await this.handle.db.select({ key: dataApps.key }).from(dataApps).where(eq(dataApps.companyId, companyId));
    const taken = new Set(rows.map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  private view(row: AppRow): AppView {
    const pages = row.pages as unknown as AppPage[];
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      icon: row.icon,
      departmentId: row.departmentId,
      pages,
      settings: AppSettings.parse(row.settings ?? {}),
      version: row.version,
      tables: tablesOfApp({ pages }),
      agents: agentsOfApp({ pages }),
      calculations: calculationsOfApp({ pages }),
      createdBy: row.createdBy.replace(/\s*<.*>$/, ""),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
}

/** An app's design as a version keeps it. */
function appSnapshot(row: typeof dataApps.$inferSelect): Record<string, unknown> {
  return { name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}), pages: row.pages };
}
