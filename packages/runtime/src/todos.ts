import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { truncate, type Actor } from "@enterprise-brain/core";
import { todos, type DatabaseHandle } from "@enterprise-brain/db";

export type TodoRow = typeof todos.$inferSelect;

export const TODO_STATUSES = ["open", "done", "dismissed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** manual: written by hand · mail: made from the person's mail · studio: the Studio agent asked for it · project: added on a project's page */
export const TODO_SOURCES = ["manual", "mail", "studio", "project"] as const;
export type TodoSource = (typeof TODO_SOURCES)[number];

export interface TodoInput {
  userId: string;
  projectId?: string | null;
  title: string;
  details?: string;
  dueAt?: Date | null;
  source?: TodoSource;
  /** What it came from (a mail's id; a Studio thread and title): the same thing never makes two to-dos. */
  sourceRef?: string | null;
  /** Where to go for it: the mail in Gmail, the Studio conversation. */
  link?: string | null;
  data?: Record<string, unknown>;
}

export interface TodoPatch {
  title?: string;
  details?: string;
  dueAt?: Date | null;
  projectId?: string | null;
  status?: TodoStatus;
}

export class TodoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TodoError";
  }
}

/**
 * A person's to-dos: what they must do themselves, from their mail, from a project, from the Studio
 * or written by hand. Each belongs to one person and is theirs alone (an AI employee's work is a task;
 * what an AI employee needs from a person is a work item).
 */
export class TodoService {
  constructor(private readonly handle: DatabaseHandle) {}

  private get db() {
    return this.handle.db;
  }

  /** A person's to-dos: the open ones due soonest first, then the newest; done ones newest first. */
  async listFor(
    companyId: string,
    userId: string,
    filter: { status?: TodoStatus | "all"; projectId?: string | null; limit?: number } = {},
  ): Promise<TodoRow[]> {
    const status = filter.status ?? "open";
    const conditions = [eq(todos.companyId, companyId), eq(todos.userId, userId)];
    if (status !== "all") conditions.push(eq(todos.status, status));
    if (filter.projectId) conditions.push(eq(todos.projectId, filter.projectId));
    const rows = await this.db
      .select()
      .from(todos)
      .where(and(...conditions))
      .orderBy(status === "open" ? sql`${todos.dueAt} asc nulls last` : desc(todos.doneAt), desc(todos.createdAt))
      .limit(filter.limit ?? 500);
    return rows;
  }

  async countOpen(companyId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(todos)
      .where(and(eq(todos.companyId, companyId), eq(todos.userId, userId), eq(todos.status, "open")));
    return row?.n ?? 0;
  }

  /** How many open to-dos the person has in each of these projects. */
  async openByProject(companyId: string, userId: string, projectIds: string[]): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const rows = await this.db
      .select({ projectId: todos.projectId, n: sql<number>`count(*)::int` })
      .from(todos)
      .where(and(eq(todos.companyId, companyId), eq(todos.userId, userId), eq(todos.status, "open"), inArray(todos.projectId, projectIds)))
      .groupBy(todos.projectId);
    return new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId!, r.n]));
  }

  /** Everyone's open to-dos in a project (for the project's development plan), oldest first. */
  async openInProject(companyId: string, projectId: string): Promise<TodoRow[]> {
    return this.db
      .select()
      .from(todos)
      .where(and(eq(todos.companyId, companyId), eq(todos.projectId, projectId), eq(todos.status, "open")))
      .orderBy(sql`${todos.dueAt} asc nulls last`, asc(todos.createdAt));
  }

  /**
   * Adds a to-do. One with the same source and reference for the same person already there is
   * returned instead (`created` false): a mail read twice makes one to-do.
   */
  async add(companyId: string, input: TodoInput, createdBy: Actor): Promise<{ todo: TodoRow; created: boolean }> {
    const title = truncate(input.title.replace(/\s+/g, " ").trim(), 300);
    if (!title) throw new TodoError("A to-do needs a title");
    const source = input.source ?? "manual";
    const sourceRef = input.sourceRef?.trim() || null;
    if (sourceRef) {
      const existing = await this.bySource(companyId, input.userId, source, sourceRef);
      if (existing) return { todo: existing, created: false };
    }
    try {
      const [row] = await this.db
        .insert(todos)
        .values({
          companyId,
          userId: input.userId,
          projectId: input.projectId ?? null,
          title,
          details: (input.details ?? "").trim(),
          dueAt: input.dueAt ?? null,
          status: "open",
          source,
          sourceRef,
          link: input.link ?? null,
          data: input.data ?? {},
          createdBy,
        })
        .returning();
      return { todo: row!, created: true };
    } catch (error) {
      // Two at once: the unique index let one through.
      const again = sourceRef ? await this.bySource(companyId, input.userId, source, sourceRef) : undefined;
      if (again) return { todo: again, created: false };
      throw error;
    }
  }

  private async bySource(companyId: string, userId: string, source: string, sourceRef: string): Promise<TodoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(todos)
      .where(and(eq(todos.companyId, companyId), eq(todos.userId, userId), eq(todos.source, source), eq(todos.sourceRef, sourceRef)));
    return row;
  }

  /** A person's to-do (404 for anyone else's: a to-do is its person's alone). */
  async get(companyId: string, id: string, userId: string): Promise<TodoRow> {
    const [row] = await this.db
      .select()
      .from(todos)
      .where(and(eq(todos.companyId, companyId), eq(todos.id, id), eq(todos.userId, userId)));
    if (!row) throw new TodoError("No such to-do", 404);
    return row;
  }

  async update(companyId: string, id: string, userId: string, patch: TodoPatch): Promise<TodoRow> {
    const current = await this.get(companyId, id, userId);
    const changes: Partial<typeof todos.$inferInsert> = {};
    if (patch.title !== undefined) {
      const title = truncate(patch.title.replace(/\s+/g, " ").trim(), 300);
      if (!title) throw new TodoError("A to-do needs a title");
      changes.title = title;
    }
    if (patch.details !== undefined) changes.details = patch.details.trim();
    if (patch.dueAt !== undefined) changes.dueAt = patch.dueAt;
    if (patch.projectId !== undefined) changes.projectId = patch.projectId;
    if (patch.status !== undefined && patch.status !== current.status) {
      changes.status = patch.status;
      changes.doneAt = patch.status === "open" ? null : new Date();
    }
    if (!Object.keys(changes).length) return current;
    const [row] = await this.db.update(todos).set(changes).where(eq(todos.id, current.id)).returning();
    return row!;
  }

  async remove(companyId: string, id: string, userId: string): Promise<void> {
    const current = await this.get(companyId, id, userId);
    await this.db.delete(todos).where(eq(todos.id, current.id));
  }
}
