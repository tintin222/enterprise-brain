import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { activityLog, approvals, builderSessions, coachingNotes, runs, tasks, workItems, type DatabaseHandle } from "@enterprise-brain/db";
import { employmentOf, type AgentRecord } from "./agents.ts";
import { median, weekStart, workingHoursBetween, localDate, type WorkingHours } from "./working-hours.ts";

/** The targets the product sets for AI employees at work. */
export const PERFORMANCE_TARGETS = {
  /** Tasks finished with no person involved, after probation (Trusted AI employees). */
  aloneShare: 0.7,
  /** Time for a person to handle a work-queue item: median, in working hours. */
  medianHandlingHours: 4,
  /** Finished tasks later corrected. */
  correctedShare: 0.05,
  /** A ready-made AI employee put to work after it is hired (hours). */
  readyMadeHours: 24,
  /** A new AI employee built in the Studio, IT's part included (hours). */
  studioHours: 168,
} as const;

export interface PerformanceMeasures {
  /** Tasks started in the period. */
  started: number;
  /** Tasks finished in the period. */
  finished: number;
  /** Tasks that stopped with a problem in the period. */
  failed: number;
  /** Finished tasks nobody had to approve, answer, check or retry. */
  finishedAlone: number;
  aloneShare: number | null;
  /** Finished tasks people later marked as wrong (a finished task, or a check). */
  corrected: number;
  correctedShare: number | null;
  /** Work-queue items people handled in the period: approvals decided, questions answered, checks, failures. */
  handled: number;
  /** How long people took to handle them (median, in working hours). */
  medianHandlingHours: number | null;
  /** Model cost of all its work in the period, tests included. */
  costUsd: number;
  /** Cost of real work (not tests) per finished task. */
  costPerTaskUsd: number | null;
}

/** Finishing alone among the AI employees past probation (Trusted), which the target is for. */
export interface AfterProbation {
  aiEmployees: number;
  finished: number;
  finishedAlone: number;
  aloneShare: number | null;
}

export interface HiringRow {
  id: string;
  slug: string;
  name: string;
  departmentId: string | null;
  /** ready-made (from the catalog), studio (built in the Studio), other (made by hand). */
  source: "ready-made" | "studio" | "other";
  /** When hiring started: the Studio interview, or the ready-made one's hiring. */
  startedAt: string;
  atWorkAt: string | null;
  hours: number | null;
  targetHours: number | null;
  met: boolean | null;
}

interface TaskFact {
  id: string;
  agentId: string;
  status: string;
  createdAt: number;
  closedAt: number | null;
  updatedAt: number;
}

interface HandledFact {
  agentId: string;
  createdAt: Date;
  resolvedAt: Date;
}

interface CostFact {
  agentId: string;
  createdAt: number;
  costUsd: number;
  isTest: boolean;
}

/** What the reports count, read once for a set of AI employees since a moment. */
export interface ReportFacts {
  tasks: TaskFact[];
  /** Tasks a person had to approve, answer, check or retry. */
  involved: Set<string>;
  /** Tasks people marked as wrong after they finished. */
  corrected: Set<string>;
  handled: HandledFact[];
  costs: CostFact[];
}

const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
const money = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Performance and cost of AI employees: what they finished alone, how fast people helped, what was corrected, what it cost. */
export class ReportService {
  constructor(private readonly handle: DatabaseHandle) {}

  async facts(companyId: string, agentIds: string[], since: Date): Promise<ReportFacts> {
    if (!agentIds.length) return { tasks: [], involved: new Set(), corrected: new Set(), handled: [], costs: [] };
    const db = this.handle.db;
    const taskRows = await db
      .select({ id: tasks.id, agentId: tasks.agentId, status: tasks.status, createdAt: tasks.createdAt, closedAt: tasks.closedAt, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          inArray(tasks.agentId, agentIds),
          or(gte(tasks.createdAt, since), gte(tasks.closedAt, since), gte(tasks.updatedAt, since)),
        ),
      );
    const taskIds = taskRows.map((t) => t.id);
    const involved = new Set<string>();
    const corrected = new Set<string>();
    for (let i = 0; i < taskIds.length; i += 500) {
      const chunk = taskIds.slice(i, i + 500);
      const asked = await db.select({ taskId: runs.taskId }).from(approvals).innerJoin(runs, eq(runs.id, approvals.runId)).where(inArray(runs.taskId, chunk));
      for (const row of asked) if (row.taskId) involved.add(row.taskId);
      const items = await db
        .select({ taskId: workItems.taskId })
        .from(workItems)
        .where(and(inArray(workItems.taskId, chunk), inArray(workItems.kind, ["question", "review", "failure"])));
      for (const row of items) if (row.taskId) involved.add(row.taskId);
      const notes = await db
        .select({ taskId: coachingNotes.taskId })
        .from(coachingNotes)
        .where(and(inArray(coachingNotes.taskId, chunk), inArray(coachingNotes.kind, ["task", "check"])));
      for (const row of notes) if (row.taskId) corrected.add(row.taskId);
    }
    const decided = await db
      .select({ agentId: approvals.agentId, createdAt: approvals.createdAt, resolvedAt: approvals.decidedAt })
      .from(approvals)
      .where(and(inArray(approvals.agentId, agentIds), gte(approvals.decidedAt, since), inArray(approvals.status, ["approved", "rejected"])));
    const resolved = await db
      .select({ agentId: workItems.agentId, createdAt: workItems.createdAt, resolvedAt: workItems.resolvedAt })
      .from(workItems)
      .where(
        and(
          inArray(workItems.agentId, agentIds),
          gte(workItems.resolvedAt, since),
          inArray(workItems.kind, ["question", "review", "failure"]),
          isNotNull(workItems.resolvedBy),
        ),
      );
    const costs = await db
      .select({ agentId: runs.agentId, createdAt: runs.createdAt, isTest: runs.isTest, costUsd: sql<number>`coalesce((${runs.usage}->>'costUsd')::float, 0)` })
      .from(runs)
      .where(and(inArray(runs.agentId, agentIds), gte(runs.createdAt, since)));
    return {
      tasks: taskRows.map((t) => ({
        id: t.id,
        agentId: t.agentId,
        status: t.status,
        createdAt: t.createdAt.getTime(),
        closedAt: t.closedAt?.getTime() ?? null,
        updatedAt: t.updatedAt.getTime(),
      })),
      involved,
      corrected,
      handled: [...decided, ...resolved]
        .filter((h): h is { agentId: string; createdAt: Date; resolvedAt: Date } => Boolean(h.agentId && h.resolvedAt))
        .map((h) => ({ agentId: h.agentId, createdAt: h.createdAt, resolvedAt: h.resolvedAt })),
      costs: costs.map((c) => ({ agentId: c.agentId, createdAt: c.createdAt.getTime(), costUsd: Number(c.costUsd) || 0, isTest: c.isTest })),
    };
  }

  /** Model cost of each AI employee's work between two moments (tests included). */
  async costsByAgent(companyId: string, agentIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
    if (!agentIds.length) return new Map();
    const rows = await this.handle.db
      .select({ agentId: runs.agentId, usd: sql<number>`coalesce(sum((${runs.usage}->>'costUsd')::numeric), 0)::float` })
      .from(runs)
      .where(and(eq(runs.companyId, companyId), inArray(runs.agentId, agentIds), gte(runs.createdAt, from), lt(runs.createdAt, to)))
      .groupBy(runs.agentId);
    return new Map(rows.map((r) => [r.agentId, Number(r.usd) || 0]));
  }

  /** When AI employees were hired, and when they were put to work. */
  async hiring(companyId: string, agents: AgentRecord[], since: Date, now = new Date()): Promise<HiringRow[]> {
    if (!agents.length) return [];
    const ids = agents.map((a) => a.row.id);
    const activations = await this.handle.db
      .select({ entityId: activityLog.entityId, at: sql<Date>`min(${activityLog.createdAt})` })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.action, ["agent.active", "agent.activated"]), inArray(activityLog.entityId, ids)))
      .groupBy(activityLog.entityId);
    const firstAtWork = new Map(activations.map((a) => [a.entityId!, new Date(a.at)]));
    const sessionIds = agents.map((a) => a.row.builderSessionId).filter((id): id is string => Boolean(id));
    const sessions = sessionIds.length
      ? await this.handle.db
          .select({ id: builderSessions.id, createdAt: builderSessions.createdAt })
          .from(builderSessions)
          .where(inArray(builderSessions.id, sessionIds))
      : [];
    const sessionStart = new Map(sessions.map((s) => [s.id, s.createdAt]));
    const rows: HiringRow[] = [];
    for (const agent of agents) {
      const source = agent.row.builderSessionId ? "studio" : agent.row.templateId || agent.row.source === "template" ? "ready-made" : "other";
      const startedAt = (agent.row.builderSessionId ? sessionStart.get(agent.row.builderSessionId) : undefined) ?? agent.row.createdAt;
      if (startedAt < since || startedAt > now) continue;
      // Hired at work (a ready-made one installed at work), or put to work later.
      const atWork =
        firstAtWork.get(agent.row.id) ?? (["active", "paused"].includes(agent.row.status) && source !== "studio" ? agent.row.createdAt : undefined);
      const hours = atWork ? Math.max(0, (atWork.getTime() - startedAt.getTime()) / 3_600_000) : null;
      const targetHours = source === "studio" ? PERFORMANCE_TARGETS.studioHours : source === "ready-made" ? PERFORMANCE_TARGETS.readyMadeHours : null;
      const waited = (now.getTime() - startedAt.getTime()) / 3_600_000;
      rows.push({
        id: agent.row.id,
        slug: agent.row.slug,
        name: agent.definition.name,
        departmentId: agent.row.departmentId,
        source,
        startedAt: startedAt.toISOString(),
        atWorkAt: atWork?.toISOString() ?? null,
        hours: hours === null ? null : Math.round(hours * 10) / 10,
        targetHours,
        // Not at work yet: missed once its time is up.
        met: targetHours === null ? null : hours !== null ? hours <= targetHours : waited > targetHours ? false : null,
      });
    }
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

/** The measures of some AI employees (all in the facts when none are given) over a period. */
export function measure(facts: ReportFacts, period: { from: Date; to: Date }, hours: WorkingHours, agentIds?: Set<string>): PerformanceMeasures {
  const from = period.from.getTime();
  const to = period.to.getTime();
  const within = (t: number | null) => t !== null && t >= from && t < to;
  const mine = (agentId: string) => !agentIds || agentIds.has(agentId);
  const own = facts.tasks.filter((t) => mine(t.agentId));
  const finished = own.filter((t) => t.status === "done" && within(t.closedAt));
  const finishedAlone = finished.filter((t) => !facts.involved.has(t.id)).length;
  const corrected = finished.filter((t) => facts.corrected.has(t.id)).length;
  const handled = facts.handled.filter((h) => mine(h.agentId) && within(h.resolvedAt.getTime()));
  const costs = facts.costs.filter((c) => mine(c.agentId) && within(c.createdAt));
  const cost = costs.reduce((sum, c) => sum + c.costUsd, 0);
  const realCost = costs.filter((c) => !c.isTest).reduce((sum, c) => sum + c.costUsd, 0);
  const handling = median(handled.map((h) => workingHoursBetween(h.createdAt, h.resolvedAt, hours)));
  return {
    started: own.filter((t) => within(t.createdAt)).length,
    finished: finished.length,
    failed: own.filter((t) => t.status === "failed" && within(t.closedAt ?? t.updatedAt)).length,
    finishedAlone,
    aloneShare: share(finishedAlone, finished.length),
    corrected,
    correctedShare: share(corrected, finished.length),
    handled: handled.length,
    medianHandlingHours: handling === null ? null : Math.round(handling * 100) / 100,
    costUsd: money(cost),
    costPerTaskUsd: finished.length ? money(realCost / finished.length) : null,
  };
}

/** Finishing alone among the Trusted ones of these AI employees. */
export function afterProbation(facts: ReportFacts, period: { from: Date; to: Date }, hours: WorkingHours, agents: AgentRecord[]): AfterProbation {
  const trusted = agents.filter((a) => employmentOf(a.row).probation === "trusted");
  const m = measure(facts, period, hours, new Set(trusted.map((a) => a.row.id)));
  return { aiEmployees: trusted.length, finished: m.finished, finishedAlone: m.finishedAlone, aloneShare: m.aloneShare };
}

/** The last `count` weeks up to `to` (Monday to Monday in the time zone), oldest first; the last one runs to `to`. */
export function weeksBefore(to: Date, count: number, timeZone: string): { start: string; from: Date; to: Date }[] {
  const weeks: { start: string; from: Date; to: Date }[] = [];
  let end = to;
  let start = weekStart(new Date(to.getTime() - 1), timeZone);
  for (let i = 0; i < count; i++) {
    weeks.unshift({ start: localDate(start, timeZone), from: start, to: end });
    end = start;
    start = weekStart(new Date(start.getTime() - 1), timeZone);
  }
  return weeks;
}
