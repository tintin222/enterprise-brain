import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  calculationParams,
  CalculationDesign,
  CalculationOutput,
  sameData,
  tableKeyOf,
  type CalculationDesignInput,
  type CalculationSchedule,
} from "@enterprise-brain/core";
import { companies, dataCalculationRuns, dataCalculations, type DatabaseHandle } from "@enterprise-brain/db";
import { runCalculation, type SandboxLimits } from "@enterprise-brain/sandbox";
import type { TableService } from "./tables.ts";
import { localDate, monthStartIn, weekStart, workingHoursOf, zonedInstant } from "./working-hours.ts";

/**
 * Calculations: a rule in plain words, and the code the Studio wrote for it, run in the sandbox on the
 * rows of the tables it names, when people ask or on its schedule. Every run is kept with its result,
 * or with what went wrong in plain words.
 */

export class CalculationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CalculationError";
  }
}

type CalculationRow = typeof dataCalculations.$inferSelect;
type RunRow = typeof dataCalculationRuns.$inferSelect;

export interface CalculationRunView {
  id: string;
  version: number;
  status: "succeeded" | "failed";
  result: unknown;
  error: string | null;
  durationMs: number;
  rows: number;
  trigger: string;
  by: string;
  createdAt: Date;
}

export interface CalculationView {
  id: string;
  key: string;
  name: string;
  rule: string;
  explanation: string;
  departmentId: string | null;
  tables: string[];
  output: CalculationOutput;
  schedule: CalculationSchedule | null;
  version: number;
  lastRunAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /** The latest run, with its result. */
  last: CalculationRunView | null;
}

/** What trying code on the real rows gives (nothing is kept). */
export interface CalculationTrial {
  ok: boolean;
  result: unknown;
  error: string | null;
  logs: string[];
  durationMs: number;
  rows: number;
}

export type NewCalculation = Omit<CalculationDesignInput, "key"> & { key?: string; departmentId?: string | null };
export type CalculationChanges = Partial<Omit<CalculationDesignInput, "key" | "schedule">> & {
  departmentId?: string | null;
  schedule?: CalculationSchedule | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows kept of a result (a ranking longer than this is cut, and says so). */
const MAX_RESULT_ROWS = 1000;
/** Calculations running at once on this server. */
const AT_ONCE = 2;
/** The hour scheduled calculations run, in the company's time zone. */
const RUN_AT_MINUTES = 7 * 60;

/** The result checked against what the calculation says it gives. */
export function checkResult(output: CalculationOutput, value: unknown): { result: unknown } | { error: string } {
  switch (output.kind) {
    case "number": {
      const n = typeof value === "number" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "number" ? value[0] : NaN;
      return Number.isFinite(n) ? { result: n } : { error: "The result should be a number" };
    }
    case "text":
      return typeof value === "string" ? { result: value } : { error: "The result should be a text" };
    case "rows": {
      if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return { error: "The result should be rows" };
      return { result: value.slice(0, MAX_RESULT_ROWS) };
    }
  }
}

export class CalculationService {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly tables: TableService,
    private readonly limits: SandboxLimits = {},
  ) {}

  async list(companyId: string, options: { archived?: boolean } = {}): Promise<CalculationView[]> {
    const rows = await this.handle.db
      .select()
      .from(dataCalculations)
      .where(and(eq(dataCalculations.companyId, companyId), options.archived ? isNotNull(dataCalculations.archivedAt) : isNull(dataCalculations.archivedAt)))
      .orderBy(asc(dataCalculations.name));
    return Promise.all(rows.map(async (row) => this.view(row, await this.lastRun(row.id))));
  }

  /** A calculation by key or id, with its latest run. */
  async get(companyId: string, ref: string): Promise<CalculationView> {
    const row = await this.row(companyId, ref);
    return this.view(row, await this.lastRun(row.id));
  }

  /** The code the Studio wrote (for IT; people see the rule and the result). */
  async code(companyId: string, ref: string): Promise<string> {
    return (await this.row(companyId, ref)).code;
  }

  async create(companyId: string, input: NewCalculation, by: string): Promise<CalculationView> {
    const key = input.key ?? (await this.freeKey(companyId, tableKeyOf(input.name)));
    const design = CalculationDesign.parse({ ...input, key });
    await this.assertTables(companyId, design.tables);
    const [taken] = await this.handle.db
      .select({ id: dataCalculations.id })
      .from(dataCalculations)
      .where(and(eq(dataCalculations.companyId, companyId), eq(dataCalculations.key, design.key)));
    if (taken) throw new CalculationError(`There is already a calculation called ${design.key}`, 409);
    const [row] = await this.handle.db
      .insert(dataCalculations)
      .values({
        companyId,
        key: design.key,
        name: design.name,
        rule: design.rule,
        explanation: design.explanation,
        departmentId: input.departmentId ?? null,
        tables: design.tables,
        code: design.code,
        output: design.output as unknown as Record<string, unknown>,
        schedule: design.schedule ?? null,
        createdBy: by,
      })
      .returning();
    return this.view(row!, null);
  }

  /** Change a calculation: its name, rule and code (a new version), schedule or department. */
  async change(companyId: string, ref: string, changes: CalculationChanges): Promise<CalculationView> {
    const row = await this.row(companyId, ref);
    const before = this.view(row, null);
    const design = CalculationDesign.parse({
      key: row.key,
      name: changes.name ?? before.name,
      rule: changes.rule ?? before.rule,
      explanation: changes.explanation ?? before.explanation,
      tables: changes.tables ?? before.tables,
      code: changes.code ?? row.code,
      output: changes.output ?? before.output,
      ...(changes.schedule === undefined ? (before.schedule ? { schedule: before.schedule } : {}) : changes.schedule ? { schedule: changes.schedule } : {}),
    });
    if (changes.tables) await this.assertTables(companyId, design.tables);
    const rewritten =
      design.code !== row.code || !sameData(design.tables, before.tables) || !sameData(design.output, before.output) || design.rule !== before.rule;
    const [updated] = await this.handle.db
      .update(dataCalculations)
      .set({
        name: design.name,
        rule: design.rule,
        explanation: design.explanation,
        tables: design.tables,
        code: design.code,
        output: design.output as unknown as Record<string, unknown>,
        schedule: design.schedule ?? null,
        ...(changes.departmentId !== undefined ? { departmentId: changes.departmentId } : {}),
        ...(rewritten ? { version: row.version + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dataCalculations.id, row.id))
      .returning();
    return this.view(updated!, await this.lastRun(row.id));
  }

  async archive(companyId: string, ref: string, archived = true): Promise<CalculationView> {
    const row = await this.row(companyId, ref);
    const [updated] = await this.handle.db
      .update(dataCalculations)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(dataCalculations.id, row.id))
      .returning();
    return this.view(updated!, await this.lastRun(row.id));
  }

  /** Its runs, newest first. */
  async runs(companyId: string, ref: string, limit = 20): Promise<CalculationRunView[]> {
    const row = await this.row(companyId, ref);
    const runs = await this.handle.db
      .select()
      .from(dataCalculationRuns)
      .where(eq(dataCalculationRuns.calculationId, row.id))
      .orderBy(desc(dataCalculationRuns.createdAt))
      .limit(limit);
    return runs.map((r) => this.runView(r));
  }

  /** Try code on the real rows of the tables (nothing is kept): what the Studio does before people see it. */
  async trial(companyId: string, input: { code: string; tables: string[]; output: CalculationOutput }, now = new Date()): Promise<CalculationTrial> {
    await this.assertTables(companyId, input.tables);
    const { tables, rows } = await this.inputOf(companyId, input.tables);
    const params = calculationParams(localDate(now, await this.timeZone(companyId)));
    const outcome = await this.limited(() => runCalculation(input.code, { tables, params }, this.limits));
    if (!outcome.ok) return { ok: false, result: null, error: outcome.error, logs: outcome.logs, durationMs: outcome.durationMs, rows };
    const checked = checkResult(input.output, outcome.value);
    if ("error" in checked) return { ok: false, result: outcome.value, error: checked.error, logs: outcome.logs, durationMs: outcome.durationMs, rows };
    return { ok: true, result: checked.result, error: null, logs: outcome.logs, durationMs: outcome.durationMs, rows };
  }

  /** Run a calculation now; the run is kept with its result or what went wrong. */
  async run(companyId: string, ref: string, options: { trigger?: "manual" | "schedule"; by: string }, now = new Date()): Promise<CalculationRunView> {
    const row = await this.row(companyId, ref);
    if (row.archivedAt) throw new CalculationError(`${row.name} is archived`, 409);
    const output = CalculationOutput.parse(row.output);
    let trial: CalculationTrial;
    try {
      trial = await this.trial(companyId, { code: row.code, tables: row.tables, output }, now);
    } catch (error) {
      // A table it reads is gone: a failed run that says so.
      trial = { ok: false, result: null, error: error instanceof Error ? error.message : String(error), logs: [], durationMs: 0, rows: 0 };
    }
    const [run] = await this.handle.db
      .insert(dataCalculationRuns)
      .values({
        companyId,
        calculationId: row.id,
        version: row.version,
        status: trial.ok ? "succeeded" : "failed",
        result: trial.ok ? trial.result : null,
        error: trial.error,
        durationMs: trial.durationMs,
        rows: trial.rows,
        trigger: options.trigger ?? "manual",
        by: options.by,
      })
      .returning();
    // The moment it ran for (the schedule's), so each period runs once.
    await this.handle.db.update(dataCalculations).set({ lastRunAt: now }).where(eq(dataCalculations.id, row.id));
    return this.runView(run!);
  }

  /**
   * Run the calculations whose time came: daily at 07:00, weekly on Monday at 07:00, monthly on the
   * first at 07:00, in the company's time zone; each once per period, and not before it was made.
   */
  async runDue(now = new Date()): Promise<CalculationRunView[]> {
    const done: CalculationRunView[] = [];
    const rows = await this.handle.db
      .select()
      .from(dataCalculations)
      .where(and(isNull(dataCalculations.archivedAt), isNotNull(dataCalculations.schedule)));
    const zones = new Map<string, string>();
    for (const row of rows) {
      if (!zones.has(row.companyId)) zones.set(row.companyId, await this.timeZone(row.companyId));
      const due = lastScheduled(row.schedule as CalculationSchedule, now, zones.get(row.companyId)!);
      const since = row.lastRunAt ?? row.createdAt;
      if (due > now || since >= due) continue;
      try {
        done.push(await this.run(row.companyId, row.id, { trigger: "schedule", by: "system" }, now));
      } catch (error) {
        console.error(`[calculations] ${row.name}:`, error);
      }
    }
    return done;
  }

  /** The rows of each table, as the calculation gets them. */
  private async inputOf(companyId: string, keys: string[]): Promise<{ tables: Record<string, Record<string, unknown>[]>; rows: number }> {
    const tables: Record<string, Record<string, unknown>[]> = {};
    let rows = 0;
    for (const key of keys) {
      tables[key] = await this.tables.rowsFor(companyId, key);
      rows += tables[key].length;
    }
    return { tables, rows };
  }

  /** At most a few calculations at once: each has its own engine and memory. */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= AT_ONCE) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async assertTables(companyId: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      const table = await this.tables.get(companyId, key).catch(() => undefined);
      if (!table) throw new CalculationError(`There is no table "${key}" to calculate on`);
    }
  }

  private async timeZone(companyId: string): Promise<string> {
    const [company] = await this.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    return workingHoursOf(company?.settings ?? {}).timeZone;
  }

  private async lastRun(calculationId: string): Promise<CalculationRunView | null> {
    const [run] = await this.handle.db
      .select()
      .from(dataCalculationRuns)
      .where(eq(dataCalculationRuns.calculationId, calculationId))
      .orderBy(desc(dataCalculationRuns.createdAt))
      .limit(1);
    return run ? this.runView(run) : null;
  }

  private async row(companyId: string, ref: string): Promise<CalculationRow> {
    const [row] = await this.handle.db
      .select()
      .from(dataCalculations)
      .where(and(eq(dataCalculations.companyId, companyId), UUID.test(ref) ? eq(dataCalculations.id, ref) : eq(dataCalculations.key, ref)));
    if (!row) throw new CalculationError(`There is no calculation "${ref}"`, 404);
    return row;
  }

  private async freeKey(companyId: string, base: string): Promise<string> {
    const rows = await this.handle.db.select({ key: dataCalculations.key }).from(dataCalculations).where(eq(dataCalculations.companyId, companyId));
    const taken = new Set(rows.map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  private view(row: CalculationRow, last: CalculationRunView | null): CalculationView {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      rule: row.rule,
      explanation: row.explanation,
      departmentId: row.departmentId,
      tables: row.tables,
      output: CalculationOutput.parse(row.output),
      schedule: (row.schedule as CalculationSchedule | null) ?? null,
      version: row.version,
      lastRunAt: row.lastRunAt,
      createdBy: row.createdBy.replace(/\s*<.*>$/, ""),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      last,
    };
  }

  private runView(run: RunRow): CalculationRunView {
    return {
      id: run.id,
      version: run.version,
      status: run.status as CalculationRunView["status"],
      result: run.result,
      error: run.error,
      durationMs: run.durationMs,
      rows: run.rows,
      trigger: run.trigger,
      by: run.by === "system" ? "On its schedule" : run.by.replace(/\s*<.*>$/, ""),
      createdAt: run.createdAt,
    };
  }
}

/** The latest moment a schedule came, at or before now: today, this Monday or the first of this month at 07:00. */
export function lastScheduled(schedule: CalculationSchedule, now: Date, timeZone: string): Date {
  const at = (start: Date) => {
    const day = localDate(start, timeZone).split("-").map(Number) as [number, number, number];
    return new Date(zonedInstant(timeZone, day[0], day[1], day[2], RUN_AT_MINUTES));
  };
  const today = localDate(now, timeZone).split("-").map(Number) as [number, number, number];
  switch (schedule) {
    case "daily": {
      const moment = new Date(zonedInstant(timeZone, today[0], today[1], today[2], RUN_AT_MINUTES));
      return moment <= now ? moment : new Date(zonedInstant(timeZone, today[0], today[1], today[2] - 1, RUN_AT_MINUTES));
    }
    case "weekly": {
      const moment = at(weekStart(now, timeZone));
      return moment <= now ? moment : at(weekStart(new Date(weekStart(now, timeZone).getTime() - 1), timeZone));
    }
    case "monthly": {
      const moment = at(monthStartIn(now, timeZone));
      return moment <= now ? moment : at(monthStartIn(now, timeZone, -1));
    }
  }
}
