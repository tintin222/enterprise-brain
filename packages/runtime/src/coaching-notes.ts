import { and, desc, eq, inArray } from "drizzle-orm";
import { truncate } from "@enterprise-brain/core";
import { coachingNotes, type DatabaseHandle } from "@enterprise-brain/db";
import type { ActivityService } from "./activity.ts";

export type CoachingNoteRow = typeof coachingNotes.$inferSelect;
export type CoachingNoteKind = "task" | "check" | "correction" | "rejection";
export type CoachingNoteStatus = "open" | "applied" | "kept";

export class CoachingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CoachingError";
  }
}

/**
 * Corrections from people, kept on the AI employee they correct: a finished task marked wrong and
 * why, a check marked wrong, a change corrected before approving, a reasoned "no". Each is open until
 * a new version takes it in as a rule (applied), or its manager keeps the version it corrected (kept).
 */
export class CoachingNotes {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly activity: ActivityService,
  ) {}

  async record(
    companyId: string,
    input: {
      agentId: string;
      taskId?: string | null;
      kind: CoachingNoteKind;
      note: string;
      by: string;
      data?: Record<string, unknown>;
      /** How the activity log puts it ("Elif Arslan rejected …"); "by: note" otherwise. */
      summary?: string;
    },
  ): Promise<CoachingNoteRow> {
    const note = input.note.trim();
    if (!note) throw new CoachingError("Say what was wrong, in plain words");
    const [row] = await this.handle.db
      .insert(coachingNotes)
      .values({
        companyId,
        agentId: input.agentId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        note: truncate(note, 2000),
        by: input.by,
        data: input.data ?? {},
      })
      .returning();
    await this.activity.record(companyId, {
      actor: input.by,
      action: "agent.coaching_note",
      entityType: "agent",
      entityId: input.agentId,
      summary: truncate(input.summary ?? `${input.by}: ${note}`, 400),
      data: { noteId: row!.id, kind: input.kind, taskId: input.taskId ?? null, note, ...(input.data ?? {}) },
    });
    return row!;
  }

  async list(companyId: string, agentId: string, filter: { status?: CoachingNoteStatus[] } = {}): Promise<CoachingNoteRow[]> {
    return this.handle.db
      .select()
      .from(coachingNotes)
      .where(
        and(
          eq(coachingNotes.companyId, companyId),
          eq(coachingNotes.agentId, agentId),
          filter.status ? inArray(coachingNotes.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(coachingNotes.createdAt));
  }

  async ofTask(companyId: string, taskId: string): Promise<CoachingNoteRow[]> {
    return this.handle.db
      .select()
      .from(coachingNotes)
      .where(and(eq(coachingNotes.companyId, companyId), eq(coachingNotes.taskId, taskId)))
      .orderBy(desc(coachingNotes.createdAt));
  }

  async byIds(companyId: string, ids: string[]): Promise<CoachingNoteRow[]> {
    if (!ids.length) return [];
    return this.handle.db
      .select()
      .from(coachingNotes)
      .where(and(eq(coachingNotes.companyId, companyId), inArray(coachingNotes.id, ids)));
  }

  async update(
    companyId: string,
    ids: string[],
    patch: { status?: CoachingNoteStatus; proposalId?: string | null; appliedVersion?: number | null },
  ): Promise<void> {
    if (!ids.length) return;
    await this.handle.db
      .update(coachingNotes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(coachingNotes.companyId, companyId), inArray(coachingNotes.id, ids)));
  }
}
