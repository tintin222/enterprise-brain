import { and, desc, eq, isNull } from "drizzle-orm";
import { describeRepeat, RepeatSchedule } from "@enterprise-brain/core";
import { companies, recurringWork, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import { RunError, type RunEngine, type RunRow } from "./engine.ts";
import { localDate, workingHoursOf, zonedInstant } from "./working-hours.ts";

/** Work a person asked for regularly: "every Monday at 08:00: send me the open complaints". */
export interface RecurringWorkView {
  id: string;
  agentId: string;
  text: string;
  schedule: RepeatSchedule;
  /** The schedule in plain words: "every Monday at 08:00". */
  when: string;
  userId: string | null;
  by: string;
  lastRunAt: string | null;
  lastTaskId: string | null;
  createdAt: string;
  stoppedAt: string | null;
  stoppedBy: string | null;
}

export class RecurringWorkError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A late run still happens within this long of its time (the server was down); later, it waits for the next one. */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;

/**
 * Recurring work people ask for in plain words. On its schedule, in the company's time zone, the AI
 * employee gets the work as a task, asked by the person, as if they had given it that morning.
 */
export class RecurringWorkService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly agents: AgentService,
    private readonly engine: RunEngine,
  ) {}

  async list(companyId: string, filter: { agentId?: string; userId?: string; stopped?: boolean } = {}): Promise<RecurringWorkView[]> {
    const rows = await this.handle.db
      .select()
      .from(recurringWork)
      .where(
        and(
          eq(recurringWork.companyId, companyId),
          filter.agentId ? eq(recurringWork.agentId, filter.agentId) : undefined,
          filter.userId ? eq(recurringWork.userId, filter.userId) : undefined,
          filter.stopped ? undefined : isNull(recurringWork.stoppedAt),
        ),
      )
      .orderBy(desc(recurringWork.createdAt));
    return rows.map(toView);
  }

  async get(companyId: string, id: string): Promise<RecurringWorkView> {
    const [row] = await this.handle.db
      .select()
      .from(recurringWork)
      .where(and(eq(recurringWork.companyId, companyId), eq(recurringWork.id, id)));
    if (!row) throw new RecurringWorkError("There is no such recurring work", 404);
    return toView(row);
  }

  async create(
    companyId: string,
    input: { agentId: string; text: string; schedule: RepeatSchedule; userId?: string | null; by: string },
  ): Promise<RecurringWorkView> {
    const text = input.text.trim();
    if (text.length < 3) throw new RecurringWorkError("Say what it should do");
    const agent = await this.agents.get(companyId, input.agentId);
    if (agent.row.status === "archived") throw new RecurringWorkError(`${agent.definition.name} no longer works here`);
    const [row] = await this.handle.db
      .insert(recurringWork)
      .values({
        companyId,
        agentId: agent.row.id,
        text,
        schedule: RepeatSchedule.parse(input.schedule),
        userId: input.userId ?? null,
        by: input.by,
      })
      .returning();
    return toView(row!);
  }

  async stop(companyId: string, id: string, by: string): Promise<RecurringWorkView> {
    const found = await this.get(companyId, id);
    if (found.stoppedAt) return found;
    const [row] = await this.handle.db
      .update(recurringWork)
      .set({ stoppedAt: new Date(), stoppedBy: by })
      .where(and(eq(recurringWork.companyId, companyId), eq(recurringWork.id, id)))
      .returning();
    return toView(row!);
  }

  /** Give the work whose time came (called each minute by the scheduler). */
  async runDue(now = new Date()): Promise<RunRow[]> {
    const rows = await this.handle.db.select().from(recurringWork).where(isNull(recurringWork.stoppedAt));
    const zones = new Map<string, string>();
    const started: RunRow[] = [];
    for (const row of rows) {
      if (!zones.has(row.companyId)) zones.set(row.companyId, await this.timeZone(row.companyId));
      const schedule = RepeatSchedule.safeParse(row.schedule);
      if (!schedule.success) continue;
      const due = latestOccurrence(schedule.data, now, zones.get(row.companyId)!);
      const since = row.lastRunAt ?? row.createdAt;
      if (!due || since >= due || now.getTime() - due.getTime() > CATCH_UP_MS) continue;
      // Marked first, so a slow start or a failure doesn't give the same work twice.
      await this.handle.db.update(recurringWork).set({ lastRunAt: now }).where(eq(recurringWork.id, row.id));
      try {
        const run = await this.engine.start(
          row.companyId,
          row.agentId,
          {},
          {
            task: row.text,
            trigger: "recurring",
            triggerRef: row.id,
            requestedBy: row.by,
            actor: row.by,
            wait: false,
          },
        );
        await this.handle.db.update(recurringWork).set({ lastTaskId: run.taskId }).where(eq(recurringWork.id, row.id));
        started.push(run);
      } catch (error) {
        // Paused, or its budget reached: this time is skipped, and the next one comes as usual.
        if (!(error instanceof RunError)) console.error("[recurring]", error);
      }
    }
    return started;
  }

  private async timeZone(companyId: string): Promise<string> {
    const [company] = await this.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    return workingHoursOf(company?.settings ?? {}).timeZone;
  }
}

/** The last moment, at or before `now`, the schedule came due in the time zone (within the last five weeks). */
export function latestOccurrence(schedule: RepeatSchedule, now: Date, timeZone: string): Date | undefined {
  const [year, month, day] = localDate(now, timeZone).split("-").map(Number) as [number, number, number];
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  for (let back = 0; back <= 35; back++) {
    const date = new Date(Date.UTC(year, month - 1, day - back));
    const weekday = date.getUTCDay();
    const fits =
      schedule.every === "day" ||
      (schedule.every === "weekday" && weekday >= 1 && weekday <= 5) ||
      (schedule.every === "week" && weekday === (schedule.weekday ?? 1)) ||
      (schedule.every === "month" && date.getUTCDate() === (schedule.day ?? 1));
    if (!fits) continue;
    const moment = new Date(zonedInstant(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour * 60 + minute));
    if (moment <= now) return moment;
  }
  return undefined;
}

function toView(row: typeof recurringWork.$inferSelect): RecurringWorkView {
  const schedule = RepeatSchedule.parse(row.schedule);
  return {
    id: row.id,
    agentId: row.agentId,
    text: row.text,
    schedule,
    when: describeRepeat(schedule),
    userId: row.userId,
    by: row.by,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastTaskId: row.lastTaskId,
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    stoppedBy: row.stoppedBy,
  };
}
