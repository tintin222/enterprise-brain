import { and, desc, eq, type SQL } from "drizzle-orm";
import { buildReviews, type DatabaseHandle } from "@enterprise-brain/db";
import type { AppService } from "./apps.ts";
import type { TableService, TableView } from "./tables.ts";

export type ReviewKind = "personal-data" | "sharing";
export type ReviewStatus = "waiting" | "approved" | "declined" | "withdrawn";

export interface ReviewView {
  id: string;
  kind: ReviewKind;
  itemType: "table" | "app";
  itemId: string;
  /** What it is about, as it is called now. */
  item: { key: string; name: string } | null;
  departmentId: string | null;
  /** personal-data: the fields that keep personal data; sharing: who it would be shared with. */
  request: { fields?: { key: string; label: string }[]; visibility?: "company" };
  /** What is asked, in plain words. */
  what: string;
  status: ReviewStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  createdAt: Date;
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

type ReviewRow = typeof buildReviews.$inferSelect;

/**
 * Decisions the rules for building ask for. A table that keeps personal data waits for the data
 * protection officer: its personal fields take no values until approved (the rest of the table works).
 * Sharing a table or an app with the whole company waits for IT: it stays with its department until
 * approved. Nothing is lost either way: a declined request leaves things as they were.
 */
export class ReviewService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly tables: TableService,
    private readonly apps: AppService,
  ) {}

  async list(companyId: string, filter: { status?: ReviewStatus; itemId?: string } = {}): Promise<ReviewView[]> {
    const where: (SQL | undefined)[] = [
      eq(buildReviews.companyId, companyId),
      filter.status ? eq(buildReviews.status, filter.status) : undefined,
      filter.itemId ? eq(buildReviews.itemId, filter.itemId) : undefined,
    ];
    const rows = await this.handle.db
      .select()
      .from(buildReviews)
      .where(and(...where))
      .orderBy(desc(buildReviews.createdAt));
    return Promise.all(rows.map((row) => this.view(companyId, row)));
  }

  async get(companyId: string, id: string): Promise<ReviewView> {
    const [row] = await this.handle.db
      .select()
      .from(buildReviews)
      .where(and(eq(buildReviews.companyId, companyId), eq(buildReviews.id, id)));
    if (!row) throw new ReviewError("There is no such request", 404);
    return this.view(companyId, row);
  }

  /**
   * Keep a table's personal-data request in step with the table: its personal fields not approved yet
   * (a new request, or the waiting one brought up to date); none left, and a waiting request is withdrawn.
   */
  async personalData(companyId: string, table: TableView, by: string): Promise<ReviewView | null> {
    const fields = table.fields.filter((f) => table.personal.waiting.includes(f.key)).map((f) => ({ key: f.key, label: f.label }));
    const [open] = await this.waiting(companyId, "personal-data", table.id);
    if (!fields.length) {
      if (open) await this.close(open.id, "withdrawn", by, "No personal data waits any more");
      return null;
    }
    if (open) {
      const [updated] = await this.handle.db.update(buildReviews).set({ request: { fields } }).where(eq(buildReviews.id, open.id)).returning();
      return this.view(companyId, updated!);
    }
    const [row] = await this.handle.db
      .insert(buildReviews)
      .values({ companyId, kind: "personal-data", itemType: "table", itemId: table.id, departmentId: table.departmentId, request: { fields }, requestedBy: by })
      .returning();
    return this.view(companyId, row!);
  }

  /** Ask IT to share a table or an app with the whole company (once: a waiting request is kept). */
  async sharing(companyId: string, item: { type: "table" | "app"; id: string; departmentId: string | null }, by: string): Promise<ReviewView> {
    const [open] = await this.waiting(companyId, "sharing", item.id);
    if (open) return this.view(companyId, open);
    const [row] = await this.handle.db
      .insert(buildReviews)
      .values({
        companyId,
        kind: "sharing",
        itemType: item.type,
        itemId: item.id,
        departmentId: item.departmentId,
        request: { visibility: "company" },
        requestedBy: by,
      })
      .returning();
    return this.view(companyId, row!);
  }

  /** Approve (it happens now) or decline (things stay as they are), with a note. */
  async decide(companyId: string, id: string, decision: { approve: boolean; by: string; note?: string }): Promise<ReviewView> {
    const review = await this.get(companyId, id);
    if (review.status !== "waiting") throw new ReviewError(`It was already ${review.status}`, 409);
    if (decision.approve) {
      if (review.kind === "personal-data") {
        await this.tables.approvePersonal(
          companyId,
          review.itemId,
          (review.request.fields ?? []).map((f) => f.key),
        );
      } else if (review.itemType === "table") {
        await this.tables.change(companyId, review.itemId, { settings: { visibility: "company" }, by: decision.by });
      } else {
        await this.apps.change(companyId, review.itemId, { settings: { visibility: "company" }, by: decision.by });
      }
    }
    await this.close(id, decision.approve ? "approved" : "declined", decision.by, decision.note ?? null);
    return this.get(companyId, id);
  }

  private async waiting(companyId: string, kind: ReviewKind, itemId: string): Promise<ReviewRow[]> {
    return this.handle.db
      .select()
      .from(buildReviews)
      .where(and(eq(buildReviews.companyId, companyId), eq(buildReviews.kind, kind), eq(buildReviews.itemId, itemId), eq(buildReviews.status, "waiting")));
  }

  private async close(id: string, status: ReviewStatus, by: string, note: string | null): Promise<void> {
    await this.handle.db.update(buildReviews).set({ status, decidedBy: by, decidedAt: new Date(), note }).where(eq(buildReviews.id, id));
  }

  private async view(companyId: string, row: ReviewRow): Promise<ReviewView> {
    const found =
      row.itemType === "table"
        ? await this.tables.get(companyId, row.itemId).catch(() => undefined)
        : await this.apps.get(companyId, row.itemId).catch(() => undefined);
    const request = row.request as ReviewView["request"];
    const name = found?.name ?? `A ${row.itemType} no longer here`;
    const what =
      row.kind === "personal-data"
        ? `${name} keeps personal data: ${(request.fields ?? []).map((f) => f.label).join(", ")}`
        : `Share ${name} with the whole company`;
    return {
      id: row.id,
      kind: row.kind as ReviewKind,
      itemType: row.itemType as ReviewView["itemType"],
      itemId: row.itemId,
      item: found ? { key: found.key, name: found.name } : null,
      departmentId: row.departmentId,
      request,
      what,
      status: row.status as ReviewStatus,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}
