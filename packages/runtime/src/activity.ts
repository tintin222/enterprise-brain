import { desc, eq } from "drizzle-orm";
import { activityLog, type DatabaseHandle } from "@enterprise-brain/db";

export interface ActivityEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}

/** Durable audit trail of every mutating action (mirrors Paperclip's activity log). */
export class ActivityService {
  constructor(private readonly handle: DatabaseHandle) {}

  async record(companyId: string, entry: ActivityEntry): Promise<void> {
    await this.handle.db.insert(activityLog).values({
      companyId,
      actor: entry.actor,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary,
      data: entry.data ?? {},
    });
  }

  async list(companyId: string, limit = 100) {
    return this.handle.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
  }
}
