import { and, desc, eq, inArray } from "drizzle-orm";
import { truncate } from "@enterprise-brain/core";
import { workItems, type DatabaseHandle } from "@enterprise-brain/db";

export type WorkItemRow = typeof workItems.$inferSelect;

/** question: an AI employee asks · review: check a Shadow AI employee's finished task · failure · notice */
export type WorkItemKind = "question" | "review" | "failure" | "notice";

export interface WorkItemInput {
  kind: WorkItemKind;
  title: string;
  details?: string;
  suggestion?: string | null;
  reason?: string | null;
  options?: string[] | null;
  taskId?: string | null;
  agentId?: string | null;
  departmentId?: string | null;
  assigneeUserId?: string | null;
  data?: Record<string, unknown>;
}

export class WorkError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorkError";
  }
}

/** The work queue's own items (approvals live with the runs they pause). */
export class WorkService {
  constructor(private readonly handle: DatabaseHandle) {}

  async create(companyId: string, input: WorkItemInput): Promise<WorkItemRow> {
    const [row] = await this.handle.db
      .insert(workItems)
      .values({
        companyId,
        kind: input.kind,
        title: truncate(input.title.replace(/\s+/g, " ").trim(), 300),
        details: input.details ?? "",
        suggestion: input.suggestion ?? null,
        reason: input.reason ?? null,
        options: input.options?.length ? input.options : null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        departmentId: input.departmentId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        data: input.data ?? {},
      })
      .returning();
    return row!;
  }

  async get(companyId: string, id: string): Promise<WorkItemRow> {
    const [row] = await this.handle.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.companyId, companyId), eq(workItems.id, id)));
    if (!row) throw new WorkError(`Work item ${id} not found`, 404);
    return row;
  }

  async list(companyId: string, filter: { statuses?: string[]; taskId?: string; agentId?: string; kind?: WorkItemKind; limit?: number } = {}): Promise<WorkItemRow[]> {
    const conditions = [eq(workItems.companyId, companyId)];
    if (filter.statuses?.length) conditions.push(inArray(workItems.status, filter.statuses));
    if (filter.taskId) conditions.push(eq(workItems.taskId, filter.taskId));
    if (filter.agentId) conditions.push(eq(workItems.agentId, filter.agentId));
    if (filter.kind) conditions.push(eq(workItems.kind, filter.kind));
    return this.handle.db
      .select()
      .from(workItems)
      .where(and(...conditions))
      .orderBy(desc(workItems.createdAt))
      .limit(filter.limit ?? 200);
  }

  /** Close an item: done (answered, checked, handled) or dismissed. */
  async resolve(companyId: string, id: string, input: { status: "done" | "dismissed"; answer?: string | null; by: string; data?: Record<string, unknown> }): Promise<WorkItemRow> {
    const item = await this.get(companyId, id);
    if (item.status !== "open") throw new WorkError(`This was already ${item.status === "done" ? "handled" : "dismissed"}${item.resolvedBy ? ` by ${item.resolvedBy}` : ""}`, 409);
    const [row] = await this.handle.db
      .update(workItems)
      .set({ status: input.status, answer: input.answer ?? null, resolvedBy: input.by, resolvedAt: new Date(), data: { ...item.data, ...(input.data ?? {}) } })
      .where(eq(workItems.id, id))
      .returning();
    return row!;
  }

  /** Open questions (and other open items) of a task: while any is open, the task needs a person. */
  async openFor(taskId: string, kind?: WorkItemKind): Promise<WorkItemRow[]> {
    const conditions = [eq(workItems.taskId, taskId), eq(workItems.status, "open")];
    if (kind) conditions.push(eq(workItems.kind, kind));
    return this.handle.db
      .select()
      .from(workItems)
      .where(and(...conditions));
  }
}
