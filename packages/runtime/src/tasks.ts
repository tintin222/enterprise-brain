import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lte, ne, notInArray } from "drizzle-orm";
import { isRecord, truncate } from "@enterprise-brain/core";
import { agents, approvals, mailMessages, runs, taskEvents, tasks, type DatabaseHandle } from "@enterprise-brain/db";
import type { EmailInput, MailMessage } from "./mail.ts";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;

/**
 * working: a run is on it · waiting: for a reply or a date · needs_person: an approval or a question ·
 * paused: by its manager · done · stopped: by its manager · failed: it hit an error a person must look at.
 */
export type TaskStatus = "working" | "waiting" | "needs_person" | "paused" | "done" | "stopped" | "failed";
export const OPEN_TASK_STATUSES: TaskStatus[] = ["working", "waiting", "needs_person", "paused"];

/** What the AI employee does once no person is needed any more (set by its task tools). */
export type TaskPlan =
  | { next: "complete"; outcome: string }
  | { next: "wait_reply"; days: number; note?: string }
  | { next: "follow_up"; at: string; note?: string };

/** What a waiting task waits for. A workflow waiting at a `wait` step names its run and step. */
export interface TaskWait {
  kind: "reply" | "time";
  since: string;
  days?: number;
  note?: string;
  runId?: string;
  stepId?: string;
}

/** Why a task wakes up. */
export type WakeReason =
  | { kind: "reply"; email: EmailInput }
  | { kind: "time" }
  | {
      kind: "decisions";
      decisions: { title: string; approved: boolean; note: string | null; decidedBy: string | null }[];
      answers?: { question: string; answer: string; by: string | null }[];
    }
  | { kind: "resumed"; by: string };

// Letters and digits people don't confuse (no 0/O, 1/I/L).
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REF_PATTERN = /\bEB-([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5})\b/;

export function newTaskRef(): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `EB-${code}`;
}

/** The task reference in an email's subject or text ("Re: Invoice INV-7 [EB-7K2Q9]"). */
export function taskRefIn(text: string): string | undefined {
  const match = REF_PATTERN.exec(text.toUpperCase());
  return match ? `EB-${match[1]}` : undefined;
}

/** "Invoice INV-7" → "Invoice INV-7 [EB-7K2Q9]" (once). */
export function withTaskRef(subject: string, ref: string): string {
  return subject.includes(ref) ? subject : `${subject.trim()} [${ref}]`.trim();
}

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tasks: storage, history and reply matching. The engine moves them through their statuses. */
export class TaskService {
  constructor(private readonly handle: DatabaseHandle) {}

  async create(
    companyId: string,
    input: { agentId: string; title: string; source: string; sourceRef?: string | null; requestedBy?: string | null; input: Record<string, unknown> },
  ): Promise<TaskRow> {
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.handle.db
          .insert(tasks)
          .values({
            companyId,
            agentId: input.agentId,
            ref: newTaskRef(),
            title: truncate(input.title.replace(/\s+/g, " ").trim() || "Task", 200),
            source: input.source,
            sourceRef: input.sourceRef ?? null,
            requestedBy: input.requestedBy ?? null,
            input: input.input,
            status: "working",
          })
          .returning();
        return row!;
      } catch (error) {
        // A reference already in use (rare): draw another.
        if (attempt < 4 && /tasks_company_ref|unique/i.test(String((error as Error).message))) continue;
        throw error;
      }
    }
  }

  async get(companyId: string, ref: string): Promise<TaskRow> {
    const task = await this.find(companyId, ref);
    if (!task) throw new TaskError(`Task ${ref} not found`, 404);
    return task;
  }

  async find(companyId: string, ref: string): Promise<TaskRow | undefined> {
    const condition = UUID.test(ref) ? eq(tasks.id, ref) : eq(tasks.ref, ref.toUpperCase());
    const [row] = await this.handle.db.select().from(tasks).where(and(eq(tasks.companyId, companyId), condition));
    return row;
  }

  async byId(taskId: string): Promise<TaskRow | undefined> {
    const [row] = await this.handle.db.select().from(tasks).where(eq(tasks.id, taskId));
    return row;
  }

  async list(companyId: string, filter: { statuses?: string[]; agentIds?: string[]; limit?: number } = {}): Promise<TaskRow[]> {
    const conditions = [eq(tasks.companyId, companyId)];
    if (filter.statuses?.length) conditions.push(inArray(tasks.status, filter.statuses));
    if (filter.agentIds) {
      if (!filter.agentIds.length) return [];
      conditions.push(inArray(tasks.agentId, filter.agentIds));
    }
    return this.handle.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.updatedAt))
      .limit(filter.limit ?? 100);
  }

  async update(taskId: string, patch: Partial<Omit<TaskRow, "id" | "companyId" | "agentId" | "ref" | "createdAt">>): Promise<TaskRow> {
    const [row] = await this.handle.db
      .update(tasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  }

  async record(companyId: string, taskId: string, event: { type: string; message: string; actor?: string; runId?: string | null; data?: Record<string, unknown> }) {
    await this.handle.db.insert(taskEvents).values({
      companyId,
      taskId,
      type: event.type,
      message: event.message,
      actor: event.actor ?? "system",
      runId: event.runId ?? null,
      data: event.data ?? {},
    });
  }

  async events(taskId: string): Promise<TaskEventRow[]> {
    return this.handle.db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.createdAt));
  }

  async runsOf(taskId: string) {
    return this.handle.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
  }

  async mailsOf(taskId: string): Promise<MailMessage[]> {
    return this.handle.db.select().from(mailMessages).where(eq(mailMessages.taskId, taskId)).orderBy(asc(mailMessages.receivedAt));
  }

  /** Approvals of the task's runs (pending first when filtered). */
  async approvalsOf(taskId: string, status?: string) {
    const runIds = (await this.handle.db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId))).map((r) => r.id);
    if (!runIds.length) return [];
    const conditions = [inArray(approvals.runId, runIds)];
    if (status) conditions.push(eq(approvals.status, status));
    return this.handle.db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(asc(approvals.createdAt));
  }

  /** Waiting tasks whose next check has come, of AI employees that may work (not paused or archived). */
  async due(now: Date): Promise<TaskRow[]> {
    const rows = await this.handle.db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(agents, eq(agents.id, tasks.agentId))
      .where(and(eq(tasks.status, "waiting"), isNotNull(tasks.nextCheckAt), lte(tasks.nextCheckAt, now), notInArray(agents.status, ["paused", "archived"])))
      .orderBy(asc(tasks.nextCheckAt))
      .limit(50);
    return rows.map((r) => r.task);
  }

  /**
   * The task an inbound email answers: by the reference in its subject or text, else by its thread
   * (an email of the same thread already belongs to a task).
   */
  async matchReply(companyId: string, message: MailMessage): Promise<TaskRow | undefined> {
    const ref = taskRefIn(message.subject) ?? taskRefIn(message.bodyText.slice(0, 4000));
    if (ref) {
      const task = await this.find(companyId, ref);
      if (task) return task;
    }
    if (message.threadId) {
      const [linked] = await this.handle.db
        .select({ taskId: mailMessages.taskId })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.companyId, companyId),
            eq(mailMessages.threadId, message.threadId),
            isNotNull(mailMessages.taskId),
            ne(mailMessages.id, message.id),
          ),
        )
        .orderBy(desc(mailMessages.receivedAt))
        .limit(1);
      if (linked?.taskId) return this.byId(linked.taskId);
    }
    return undefined;
  }

  async linkMail(companyId: string, messageId: string, taskId: string): Promise<void> {
    await this.handle.db
      .update(mailMessages)
      .set({ taskId })
      .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.id, messageId)));
  }

  /**
   * The brief for a run that continues a task: the work as it arrived, what happened so far and why it
   * is looked at again.
   */
  async brief(task: TaskRow, reason: WakeReason): Promise<string> {
    const events = (await this.events(task.id)).filter((e) => e.type !== "woke").slice(-25);
    const history = events.map((e) => `- ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")} ${e.message}`).join("\n");
    const lines = [
      `You are continuing task ${task.ref}: "${task.title}".`,
      "",
      "The work as it arrived:",
      describeInput(task.input),
      "",
      "What happened so far:",
      history || "- (nothing recorded yet)",
      "",
      "Why you are looking at it again:",
      wakeText(reason, task),
      "",
      "Decide the next step and act. When you have to wait for someone, call task_wait_for_reply; to look again later, call task_follow_up; when the work is finished, call task_complete with the outcome.",
    ];
    return lines.join("\n");
  }
}

function describeInput(input: Record<string, unknown>): string {
  const email = isRecord(input.email) ? (input.email as Partial<EmailInput>) : undefined;
  if (email?.subject !== undefined) {
    return truncate(`Email from ${email.from ?? "?"}: "${email.subject}"\n${email.body ?? ""}`, 4000);
  }
  const text = typeof input.request === "string" ? input.request : JSON.stringify(input, null, 1);
  return truncate(text, 4000);
}

/** Plain words for why a task woke up (also its history line). */
export function wakeText(reason: WakeReason, task?: Pick<TaskRow, "waitingFor">): string {
  switch (reason.kind) {
    case "reply":
      return truncate(`A reply arrived from ${reason.email.from}: "${reason.email.subject}"\n${reason.email.body}`, 6000);
    case "time": {
      const wait = (task?.waitingFor ?? undefined) as TaskWait | undefined;
      if (wait?.kind === "reply") {
        return `Nobody replied since ${wait.since.slice(0, 10)}${wait.days ? ` (${wait.days} day${wait.days === 1 ? "" : "s"})` : ""}.${wait.note ? ` You noted: ${wait.note}` : ""}`;
      }
      return `It is time to follow up.${wait?.note ? ` You noted: ${wait.note}` : ""}`;
    }
    case "decisions":
      return [
        ...(reason.answers ?? []).map((a) => `${a.by ?? "A person"} answered "${a.question}": ${a.answer}`),
        ...reason.decisions.map((d) => `${d.decidedBy ?? "A person"} ${d.approved ? "approved" : "rejected"} "${d.title}"${d.note ? `: ${d.note}` : ""}`),
      ].join("\n");
    case "resumed":
      return `${reason.by} resumed the task.`;
  }
}
