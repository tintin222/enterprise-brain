import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { isRecord } from "@enterprise-brain/core";
import { agents, runs, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentRecord, AgentService } from "./agents.ts";
import { measure, type ReportService } from "./reports.ts";
import { localDate, median, type WorkingHours } from "./working-hours.ts";

type RunRow = typeof runs.$inferSelect;

/** An example pinned from a run: what it was given, to try the AI employee with again. */
export interface RunExample {
  id: string;
  name: string;
  input: Record<string, unknown>;
  runId: string | null;
  createdBy: string;
  createdAt: string;
}

/** What a manager keeps on an AI employee besides its job: examples to try it with, and the minutes a task takes a person. */
export interface AgentSettings {
  examples: RunExample[];
  minutesPerTask: number | null;
}

export function agentSettingsOf(settings: Record<string, unknown> | null | undefined): AgentSettings {
  const examples = Array.isArray(settings?.examples)
    ? settings.examples.filter((e): e is RunExample => isRecord(e) && typeof e.id === "string" && typeof e.name === "string" && isRecord(e.input))
    : [];
  const minutes = settings?.minutesPerTask;
  return { examples, minutesPerTask: typeof minutes === "number" && minutes > 0 ? minutes : null };
}

/** Which runs to list. */
export interface RunFilter {
  /** Only these AI employees' runs (the ones the viewer may see); all when not given. */
  agentIds?: string[];
  /** A status, or "open" (queued, running or waiting). */
  status?: string;
  trigger?: string;
  /** Started from (inclusive) and to (exclusive). */
  from?: Date;
  to?: Date;
  /** Only test runs (true) or only real ones (false). */
  test?: boolean;
  minDurationMs?: number;
  minCostUsd?: number;
  /** Where the previous page ended. */
  cursor?: string;
  limit?: number;
}

/** What happened over a period. */
export interface RunInsights {
  /** Real runs (test runs are counted apart). */
  runs: number;
  succeeded: number;
  failed: number;
  /** Waiting for a person's approval now. */
  needsPerson: number;
  /** Waiting for a reply, a date, a call or a colleague. */
  waiting: number;
  running: number;
  testRuns: number;
  medianDurationMs: number | null;
  /** All runs' model cost, test runs included (budgets count them too). */
  costUsd: number;
  /** Tasks finished in the period, and those nobody had to approve, answer, check or retry. */
  tasksFinished: number;
  finishedAlone: number;
  /** The managers' estimate: finished tasks × the minutes each takes a person; null when no manager set minutes. */
  minutesSaved: number | null;
  perDay: { date: string; succeeded: number; failed: number; other: number }[];
}

const OPEN_STATUSES = ["queued", "running", "waiting", "waiting_approval"];
const MAX_EXAMPLES = 20;
const DAY_MS = 86_400_000;

/** Runs are paged by when they started, to the millisecond (what a cursor carries), then by id. */
const startedMs = sql`date_trunc('milliseconds', ${runs.createdAt})`;

function encodeCursor(run: Pick<RunRow, "createdAt" | "id">): string {
  return `${run.createdAt.getTime()}.${run.id}`;
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  const match = cursor ? /^(\d{10,16})\.([0-9a-f-]{36})$/i.exec(cursor) : null;
  return match ? { at: new Date(Number(match[1])), id: match[2]! } : undefined;
}

function durationOf(run: Pick<RunRow, "startedAt" | "createdAt" | "finishedAt">): number | null {
  return run.finishedAt ? run.finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime() : null;
}

function costOf(run: Pick<RunRow, "usage">): number {
  const cost = (run.usage as { costUsd?: unknown } | null)?.costUsd;
  return typeof cost === "number" ? cost : 0;
}

/**
 * The runs of AI employees as executions: a filtered list in pages, what happened over a period (with
 * the finished tasks the reports count), and the examples managers pin from runs to try them with again.
 */
export class ExecutionService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly agentService: AgentService,
    private readonly reports: ReportService,
  ) {}

  /** A page of runs, newest first, and where the next page starts (null at the end). */
  async page(companyId: string, filter: RunFilter = {}): Promise<{ runs: RunRow[]; next: string | null }> {
    const conditions: SQL[] = [eq(runs.companyId, companyId)];
    if (filter.agentIds) {
      if (!filter.agentIds.length) return { runs: [], next: null };
      conditions.push(inArray(runs.agentId, filter.agentIds));
    }
    if (filter.status === "open") conditions.push(inArray(runs.status, OPEN_STATUSES));
    else if (filter.status) conditions.push(eq(runs.status, filter.status));
    if (filter.trigger) conditions.push(eq(runs.trigger, filter.trigger));
    if (filter.from) conditions.push(gte(runs.createdAt, filter.from));
    if (filter.to) conditions.push(lt(runs.createdAt, filter.to));
    if (filter.test !== undefined) conditions.push(eq(runs.isTest, filter.test));
    if (filter.minDurationMs !== undefined) {
      conditions.push(
        sql`${runs.finishedAt} is not null and extract(epoch from (${runs.finishedAt} - coalesce(${runs.startedAt}, ${runs.createdAt}))) * 1000 >= ${filter.minDurationMs}`,
      );
    }
    if (filter.minCostUsd !== undefined) conditions.push(sql`coalesce((${runs.usage}->>'costUsd')::double precision, 0) >= ${filter.minCostUsd}`);
    const cursor = decodeCursor(filter.cursor);
    if (cursor) {
      const at = cursor.at.toISOString();
      conditions.push(or(sql`${startedMs} < ${at}::timestamptz`, and(sql`${startedMs} = ${at}::timestamptz`, lt(runs.id, cursor.id)))!);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.handle.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(startedMs), desc(runs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { runs: page, next: rows.length > limit && last ? encodeCursor(last) : null };
  }

  /** Runs by outcome, how long they took, what they cost, the tasks finished alone and the time the managers say it saved. */
  async insights(companyId: string, agentList: AgentRecord[], period: { from: Date; to: Date }, hours: WorkingHours): Promise<RunInsights> {
    const ids = agentList.map((a) => a.row.id);
    const rows = ids.length
      ? await this.handle.db
          .select({
            status: runs.status,
            isTest: runs.isTest,
            startedAt: runs.startedAt,
            finishedAt: runs.finishedAt,
            createdAt: runs.createdAt,
            usage: runs.usage,
          })
          .from(runs)
          .where(and(eq(runs.companyId, companyId), inArray(runs.agentId, ids), gte(runs.createdAt, period.from), lt(runs.createdAt, period.to)))
      : [];
    const real = rows.filter((r) => !r.isTest);
    const count = (status: string) => real.filter((r) => r.status === status).length;
    const durations = real.flatMap((r) => (r.status === "succeeded" ? [durationOf(r)] : [])).filter((d): d is number => d !== null);
    const middle = median(durations);

    const facts = await this.reports.facts(companyId, ids, period.from);
    const measured = measure(facts, period, hours);
    let minutesSaved: number | null = null;
    for (const agent of agentList) {
      const minutes = agentSettingsOf(agent.row.settings).minutesPerTask;
      if (!minutes) continue;
      minutesSaved = (minutesSaved ?? 0) + measure(facts, period, hours, new Set([agent.row.id])).finished * minutes;
    }

    // One bar a day in the company's time zone, days without runs included.
    const perDay = new Map<string, { date: string; succeeded: number; failed: number; other: number }>();
    const first = localDate(period.from, hours.timeZone);
    const last = localDate(new Date(period.to.getTime() - 1), hours.timeZone);
    for (let day = new Date(`${first}T00:00:00Z`); day.toISOString().slice(0, 10) <= last && perDay.size < 366; day = new Date(day.getTime() + DAY_MS)) {
      const date = day.toISOString().slice(0, 10);
      perDay.set(date, { date, succeeded: 0, failed: 0, other: 0 });
    }
    for (const run of real) {
      const bar = perDay.get(localDate(run.createdAt, hours.timeZone));
      if (!bar) continue;
      if (run.status === "succeeded") bar.succeeded++;
      else if (run.status === "failed") bar.failed++;
      else bar.other++;
    }

    return {
      runs: real.length,
      succeeded: count("succeeded"),
      failed: count("failed"),
      needsPerson: count("waiting_approval"),
      waiting: count("waiting"),
      running: count("running") + count("queued"),
      testRuns: rows.length - real.length,
      medianDurationMs: middle === null ? null : Math.round(middle),
      costUsd: Math.round(rows.reduce((sum, r) => sum + costOf(r), 0) * 10_000) / 10_000,
      tasksFinished: measured.finished,
      finishedAlone: measured.finishedAlone,
      minutesSaved,
      perDay: [...perDay.values()],
    };
  }

  /** Pin what a run of the AI employee was given as an example to try it with again (newest first, 20 at most). */
  async addExample(companyId: string, agentRef: string, input: { name: string; runId: string; by: string }): Promise<RunExample> {
    const agent = await this.agentService.get(companyId, agentRef);
    const [run] = await this.handle.db
      .select({ agentId: runs.agentId, input: runs.input })
      .from(runs)
      .where(and(eq(runs.companyId, companyId), eq(runs.id, input.runId)));
    if (!run || run.agentId !== agent.row.id) throw new ExecutionError(`Run ${input.runId} is not one of ${agent.definition.name}'s`, 404);
    const example: RunExample = {
      id: randomUUID(),
      name: input.name.trim() || "Example",
      input: run.input,
      runId: input.runId,
      createdBy: input.by,
      createdAt: new Date().toISOString(),
    };
    const settings = agentSettingsOf(agent.row.settings);
    await this.save(agent, { examples: [example, ...settings.examples].slice(0, MAX_EXAMPLES) });
    return example;
  }

  async removeExample(companyId: string, agentRef: string, id: string): Promise<void> {
    const agent = await this.agentService.get(companyId, agentRef);
    const settings = agentSettingsOf(agent.row.settings);
    if (!settings.examples.some((e) => e.id === id)) throw new ExecutionError("There is no such example", 404);
    await this.save(agent, { examples: settings.examples.filter((e) => e.id !== id) });
  }

  /** How many minutes a task takes a person (the manager's estimate, for the time it saves); null forgets it. */
  async setMinutesPerTask(companyId: string, agentRef: string, minutes: number | null): Promise<AgentSettings> {
    const agent = await this.agentService.get(companyId, agentRef);
    return this.save(agent, { minutesPerTask: minutes && minutes > 0 ? minutes : null });
  }

  private async save(agent: AgentRecord, patch: Partial<AgentSettings>): Promise<AgentSettings> {
    const settings = { ...(agent.row.settings ?? {}), ...patch };
    await this.handle.db.update(agents).set({ settings }).where(eq(agents.id, agent.row.id));
    return agentSettingsOf(settings);
  }
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
