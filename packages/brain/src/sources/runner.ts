import { and, eq } from "drizzle-orm";
import { brainSources, type DatabaseHandle } from "@enterprise-brain/db";
import { BrainError, type BrainService } from "../service.ts";
import { emptyResult, type SyncResult } from "../types.ts";
import type { BrainSourceDefinition, BrainSourceDeps } from "./types.ts";

export interface BrainSourceView {
  key: string;
  name: string;
  system: string;
  description: string;
  brings: string[];
  icon: string;
  demo: boolean;
  /** connected · off · new (never connected) */
  status: "connected" | "off" | "new";
  syncs: number;
  lastSyncAt: string | null;
  lastResult: SyncResult | null;
  lastError: string | null;
}

/**
 * The sources the brain learns from: connect one, read it now, or read them all in an order where
 * each finds what the ones before it brought (people before the systems they look after, systems
 * before the processes that use them). Readings of one company run one at a time.
 */
export class BrainSources {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly brain: BrainService,
    private readonly deps: BrainSourceDeps,
    readonly definitions: BrainSourceDefinition[],
  ) {}

  private get db() {
    return this.handle.db;
  }

  definition(key: string): BrainSourceDefinition {
    const found = this.definitions.find((d) => d.key === key);
    if (!found) throw new BrainError(`There is no source "${key}"`, 404);
    return found;
  }

  private async serialized<T>(companyId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(companyId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.queues.set(companyId, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(companyId) === tail) this.queues.delete(companyId);
    }
  }

  private async rowOf(companyId: string, key: string) {
    const [row] = await this.db
      .select()
      .from(brainSources)
      .where(and(eq(brainSources.companyId, companyId), eq(brainSources.key, key)));
    return row;
  }

  async list(companyId: string): Promise<BrainSourceView[]> {
    const rows = await this.db.select().from(brainSources).where(eq(brainSources.companyId, companyId));
    return this.definitions.map((d) => {
      const row = rows.find((r) => r.key === d.key);
      return {
        key: d.key,
        name: d.name,
        system: d.system,
        description: d.description,
        brings: d.brings,
        icon: d.icon,
        demo: d.demo,
        status: row ? (row.status === "connected" ? "connected" : "off") : "new",
        syncs: row?.syncs ?? 0,
        lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
        lastResult: row && Object.keys(row.lastResult).length ? (row.lastResult as unknown as SyncResult) : null,
        lastError: row?.lastError ?? null,
      };
    });
  }

  async connect(companyId: string, key: string): Promise<void> {
    this.definition(key);
    await this.db
      .insert(brainSources)
      .values({ companyId, key, status: "connected" })
      .onConflictDoUpdate({ target: [brainSources.companyId, brainSources.key], set: { status: "connected", updatedAt: new Date() } });
  }

  /** Stops reading it; what it brought stays. */
  async disconnect(companyId: string, key: string): Promise<void> {
    this.definition(key);
    await this.db
      .update(brainSources)
      .set({ status: "off", updatedAt: new Date() })
      .where(and(eq(brainSources.companyId, companyId), eq(brainSources.key, key)));
  }

  /** Reads a source now (connecting it first). `again` reads what it had last time, to place what was waiting for others. */
  async sync(companyId: string, key: string, options: { now?: Date; again?: boolean } = {}): Promise<SyncResult> {
    return this.serialized(companyId, () => this.read(companyId, key, options));
  }

  private async read(companyId: string, key: string, options: { now?: Date; again?: boolean }): Promise<SyncResult> {
    const definition = this.definition(key);
    await this.connect(companyId, key);
    const row = await this.rowOf(companyId, key);
    const syncs = Math.max(0, (row?.syncs ?? 0) - (options.again ? 1 : 0));
    const company = await this.deps.company(companyId);
    try {
      const batch = await definition.read({
        companyId,
        companyName: company.name,
        domain: company.mailDomain,
        deps: this.deps,
        syncs,
        now: options.now ?? new Date(),
      });
      const result = await this.brain.apply(companyId, key, batch);
      await this.db
        .update(brainSources)
        .set({
          syncs: options.again ? (row?.syncs ?? 1) : syncs + 1,
          lastSyncAt: new Date(),
          lastResult: result as unknown as Record<string, unknown>,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(brainSources.companyId, companyId), eq(brainSources.key, key)));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(brainSources)
        .set({ lastSyncAt: new Date(), lastError: message, updatedAt: new Date() })
        .where(and(eq(brainSources.companyId, companyId), eq(brainSources.key, key)));
      throw new BrainError(`${definition.name} could not be read: ${message}`, 502);
    }
  }

  /**
   * Connects and reads every source, in order; then reads again the ones that named something only a
   * later source brought, so their links find it. `only: "connected"` reads the connected ones;
   * `only: "not-off"` also the ones never connected, and leaves alone those a person turned off.
   */
  async syncAll(companyId: string, options: { now?: Date; only?: "connected" | "not-off" } = {}): Promise<Record<string, SyncResult>> {
    return this.serialized(companyId, async () => {
      const rows = await this.db.select().from(brainSources).where(eq(brainSources.companyId, companyId));
      const status = (key: string) => rows.find((r) => r.key === key)?.status ?? "new";
      const keys = this.definitions
        .map((d) => d.key)
        .filter((key) => (options.only === "connected" ? status(key) === "connected" : options.only === "not-off" ? status(key) !== "off" : true));
      const results: Record<string, SyncResult> = {};
      for (const key of keys) {
        try {
          results[key] = await this.read(companyId, key, { now: options.now });
        } catch (error) {
          results[key] = { ...emptyResult(), skipped: [error instanceof Error ? error.message : String(error)] };
        }
      }
      for (const key of keys) {
        const first = results[key];
        if (!first?.skipped.some((s) => s.endsWith("not in the brain"))) continue;
        const again = await this.read(companyId, key, { now: options.now, again: true }).catch(() => undefined);
        if (!again) continue;
        results[key] = {
          ...again,
          added: first.added + again.added,
          updated: first.updated + again.updated,
          links: { added: first.links.added + again.links.added, removed: again.links.removed },
          events: first.events + again.events,
          changes: first.changes + again.changes,
          byKind: Object.fromEntries(
            [...new Set([...Object.keys(first.byKind), ...Object.keys(again.byKind)])].map((k) => [k, (first.byKind[k] ?? 0) + (again.byKind[k] ?? 0)]),
          ),
        };
        await this.db
          .update(brainSources)
          .set({ lastResult: results[key] as unknown as Record<string, unknown> })
          .where(and(eq(brainSources.companyId, companyId), eq(brainSources.key, key)));
      }
      return results;
    });
  }
}
