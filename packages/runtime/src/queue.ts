import { and, eq, inArray } from "drizzle-orm";
import { approvals, runs, tasks, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import type { QueueItemType } from "./events.ts";
import type { Person } from "./people.ts";
import type { WorkService } from "./work.ts";

/** One thing in the work queue, whatever its kind, as people and channels show it. */
export interface QueueEntry {
  type: QueueItemType;
  id: string;
  companyId: string;
  title: string;
  details: string;
  reason: string | null;
  suggestion: string | null;
  options: string[] | null;
  /** The change an approval would make (an email, a system action), or null. */
  action: Record<string, unknown> | null;
  agent: { id: string; slug: string; name: string; managerUserId: string | null } | null;
  departmentId: string | null;
  assigneeUserId: string | null;
  task: { id: string; ref: string; title: string; status: string } | null;
  /** pending / open while it needs a person. */
  status: string;
  resolvedBy: string | null;
  /** The answer or verdict once handled; an approval's decision note. */
  answer: string | null;
  createdAt: Date;
}

/** What an AI employee is waiting on: it arrives at once for people who want urgent items at once. */
export function isUrgent(entry: Pick<QueueEntry, "type">): boolean {
  return entry.type === "approval" || entry.type === "question";
}

export function isOpen(entry: Pick<QueueEntry, "status">): boolean {
  return entry.status === "pending" || entry.status === "open";
}

/**
 * Who an entry reaches (the app's "for me", limited to people who may handle it): its assignee; else
 * everyone who works in the AI employee's department; else, for company-wide AI employees, the admins.
 * The AI employee's manager too, when they are an admin. Disabled people get nothing.
 */
export function audienceOf(entry: Pick<QueueEntry, "assigneeUserId" | "departmentId" | "agent">, people: Person[]): Person[] {
  const active = people.filter((p) => p.status === "active");
  if (entry.assigneeUserId) return active.filter((p) => p.id === entry.assigneeUserId);
  const works = (p: Person) => (entry.departmentId ? p.departments.some((d) => d.departmentId === entry.departmentId) : p.role === "admin");
  return active.filter((p) => works(p) || (p.role === "admin" && p.id === entry.agent?.managerUserId));
}

/** The work queue as one list across its kinds, for notifications and chat channels. */
export class QueueService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly agents: AgentService,
    private readonly work: WorkService,
  ) {}

  /** Everything that needs a person now: pending approvals and open work items, oldest first. */
  async open(companyId: string): Promise<QueueEntry[]> {
    const pending = await this.handle.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    const items = await this.work.list(companyId, { statuses: ["open"], limit: 1000 });
    const entries = [...(await this.fromApprovals(companyId, pending)), ...(await this.fromWorkItems(companyId, items))];
    return entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** One entry by kind and id, open or not (undefined when it doesn't exist). */
  async entry(companyId: string, type: QueueItemType, id: string): Promise<QueueEntry | undefined> {
    if (type === "approval") {
      const rows = await this.handle.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, id)));
      return (await this.fromApprovals(companyId, rows))[0];
    }
    const item = await this.work.get(companyId, id).catch(() => undefined);
    return item ? (await this.fromWorkItems(companyId, [item]))[0] : undefined;
  }

  private async agentsById(companyId: string) {
    return new Map((await this.agents.list(companyId)).map((a) => [a.row.id, a]));
  }

  private async tasksById(ids: string[]) {
    if (!ids.length) return new Map<string, typeof tasks.$inferSelect>();
    const rows = await this.handle.db.select().from(tasks).where(inArray(tasks.id, ids));
    return new Map(rows.map((t) => [t.id, t]));
  }

  private async fromApprovals(companyId: string, rows: (typeof approvals.$inferSelect)[]): Promise<QueueEntry[]> {
    if (!rows.length) return [];
    const agents = await this.agentsById(companyId);
    const runIds = rows.map((r) => r.runId).filter((id): id is string => Boolean(id));
    const runRows = runIds.length ? await this.handle.db.select({ id: runs.id, taskId: runs.taskId }).from(runs).where(inArray(runs.id, runIds)) : [];
    const taskOfRun = new Map(runRows.map((r) => [r.id, r.taskId]));
    const taskRows = await this.tasksById([...new Set(runRows.map((r) => r.taskId).filter((id): id is string => Boolean(id)))]);
    return rows.map((row) => {
      const agent = agents.get(row.agentId);
      const task = row.runId ? taskRows.get(taskOfRun.get(row.runId) ?? "") : undefined;
      return {
        type: "approval" as const,
        id: row.id,
        companyId,
        title: row.title,
        details: row.details,
        reason: row.reason,
        suggestion: null,
        options: null,
        action: row.action,
        agent: agent ? { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name, managerUserId: agent.row.managerUserId } : null,
        departmentId: agent?.row.departmentId ?? null,
        assigneeUserId: null,
        task: task ? { id: task.id, ref: task.ref, title: task.title, status: task.status } : null,
        status: row.status,
        resolvedBy: row.decidedBy,
        answer: row.decisionNote,
        createdAt: row.createdAt,
      };
    });
  }

  private async fromWorkItems(companyId: string, rows: Awaited<ReturnType<WorkService["list"]>>): Promise<QueueEntry[]> {
    if (!rows.length) return [];
    const agents = await this.agentsById(companyId);
    const taskRows = await this.tasksById([...new Set(rows.map((r) => r.taskId).filter((id): id is string => Boolean(id)))]);
    return rows.map((row) => {
      const agent = row.agentId ? agents.get(row.agentId) : undefined;
      const task = row.taskId ? taskRows.get(row.taskId) : undefined;
      return {
        type: row.kind as QueueItemType,
        id: row.id,
        companyId,
        title: row.title,
        details: row.details,
        reason: row.reason,
        suggestion: row.suggestion,
        options: row.options,
        action: null,
        agent: agent ? { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name, managerUserId: agent.row.managerUserId } : null,
        departmentId: row.departmentId,
        assigneeUserId: row.assigneeUserId,
        task: task ? { id: task.id, ref: task.ref, title: task.title, status: task.status } : null,
        status: row.status,
        resolvedBy: row.resolvedBy,
        answer: row.answer,
        createdAt: row.createdAt,
      };
    });
  }
}
