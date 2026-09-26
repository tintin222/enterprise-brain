import { and, desc, eq } from "drizzle-orm";
import { dataVersions, type DatabaseHandle } from "@enterprise-brain/db";

/** What keeps versions: tables, apps and calculations (AI employees keep their own). */
export type VersionedType = "table" | "app" | "calculation";

export interface VersionView {
  version: number;
  /** The design at this version. */
  snapshot: Record<string, unknown>;
  note: string;
  by: string;
  createdAt: Date;
}

/**
 * Every version of what people build, kept as it was: to see what changed from one to the next and to
 * go back to an earlier one (which makes a new version, so nothing is lost either way).
 */
export class VersionService {
  constructor(private readonly handle: DatabaseHandle) {}

  /** Keep a version (once: a version already kept stays as it was). */
  async record(
    companyId: string,
    item: { type: VersionedType; id: string },
    version: number,
    snapshot: Record<string, unknown>,
    by = "",
    note = "",
  ): Promise<void> {
    await this.handle.db.insert(dataVersions).values({ companyId, itemType: item.type, itemId: item.id, version, snapshot, by, note }).onConflictDoNothing();
  }

  /** Its versions, newest first. */
  async list(companyId: string, item: { type: VersionedType; id: string }): Promise<VersionView[]> {
    const rows = await this.handle.db
      .select()
      .from(dataVersions)
      .where(and(eq(dataVersions.companyId, companyId), eq(dataVersions.itemType, item.type), eq(dataVersions.itemId, item.id)))
      .orderBy(desc(dataVersions.version));
    return rows.map((r) => ({ version: r.version, snapshot: r.snapshot, note: r.note, by: r.by, createdAt: r.createdAt }));
  }

  async get(companyId: string, item: { type: VersionedType; id: string }, version: number): Promise<VersionView | undefined> {
    return (await this.list(companyId, item)).find((v) => v.version === version);
  }
}
