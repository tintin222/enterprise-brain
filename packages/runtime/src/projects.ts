import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { BrainError, type BrainService } from "@enterprise-brain/brain";
import { brainKind, channelName, truncate, type Actor, type BrainRelationKey } from "@enterprise-brain/core";
import { builderSessions, projectAssets, projects, studioThreads, type DatabaseHandle } from "@enterprise-brain/db";
import type { KnowledgeService } from "@enterprise-brain/knowledge";
import type { ActivityService } from "./activity.ts";
import type { AgentService } from "./agents.ts";
import type { AppService } from "./apps.ts";
import type { CalculationService } from "./calculations.ts";
import type { ConnectorService } from "./connectors.ts";
import type { ConversationService } from "./conversations.ts";
import type { FileService } from "./files.ts";
import type { TableService } from "./tables.ts";
import type { TodoService } from "./todos.ts";

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectAssetRow = typeof projectAssets.$inferSelect;

export const PROJECT_STATUSES = ["planned", "active", "on_hold", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
/** How a status reads; also how the project's thing in the brain carries it. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  done: "Done",
  cancelled: "Cancelled",
};
/** A project at these statuses is over: its channel is archived. */
export const CLOSED_PROJECT_STATUSES: ProjectStatus[] = ["done", "cancelled"];

export const PROJECT_ASSET_KINDS = ["thing", "table", "app", "calculation", "document", "file", "connection", "agent"] as const;
export type ProjectAssetKind = (typeof PROJECT_ASSET_KINDS)[number];
export const PROJECT_ASSET_LABELS: Record<ProjectAssetKind, string> = {
  thing: "In the brain",
  table: "Table",
  app: "App",
  calculation: "Calculation",
  document: "Document",
  file: "File",
  connection: "Connection",
  agent: "AI employee",
};

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export interface ProjectInput {
  name: string;
  summary?: string;
  client?: string | null;
  status?: ProjectStatus;
}

export interface ProjectPatch {
  name?: string;
  summary?: string;
  client?: string | null;
  status?: ProjectStatus;
  ownerUserId?: string | null;
}

/** Who acts on a project: how they take part in conversations, their account when signed in, their email (to find them in the brain). */
export interface ProjectActor {
  actor: Actor;
  userId: string | null;
  email: string | null;
}

/** An export of the development package, as the project remembers it. */
export interface ProjectExport {
  at: string;
  by: string;
  files: number;
}

/** A project in a list, with what it holds. */
export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  client: string | null;
  ownerUserId: string | null;
  thingId: string | null;
  conversationId: string | null;
  lastExportedAt: string | null;
  exports: number;
  counts: { assets: number; designs: number; openTodos: number };
  createdAt: Date;
  updatedAt: Date;
}

/** An asset as a page shows it: what it is, named, and whether it still exists. */
export interface ProjectAssetView {
  id: string;
  kind: ProjectAssetKind;
  /** The thing's, document's, file's, connection's or AI employee's id; a table's, app's or calculation's key. */
  ref: string;
  note: string;
  addedBy: Actor;
  createdAt: Date;
  name: string;
  /** A line about it: a thing's kind and summary, a table's fields and records, a file's type and size. */
  detail: string;
  /** False when what it points to is gone. */
  exists: boolean;
  /** For tables, apps, calculations and AI employees: the department it belongs to (null: company-wide). */
  departmentId: string | null;
  /** True when everyone in the company may see it (company-wide, or shared with the company). */
  shared: boolean;
}

/** The designs made inside a project: Studio conversations, guided interviews and the AI employees they made (or attached by hand). */
export interface ProjectDesigns {
  threads: { id: string; title: string; status: string; ownerId: string | null; owner: string; builtAt: Date | null; updatedAt: Date; agentIds: string[] }[];
  interviews: {
    id: string;
    title: string;
    status: string;
    requesterEmail: string | null;
    department: string | null;
    agentId: string | null;
    updatedAt: Date;
  }[];
  agents: { id: string; slug: string; name: string; status: string; departmentId: string | null; from: "studio" | "interview" | "attached" }[];
}

export interface ProjectDeps {
  handle: DatabaseHandle;
  brain: BrainService;
  conversations: ConversationService;
  activity: ActivityService;
  todos: TodoService;
  agents: AgentService;
  tables: TableService;
  apps: AppService;
  calculations: CalculationService;
  knowledge: KnowledgeService;
  files: FileService;
  connectors: ConnectorService;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How someone reads in the brain's audit trail: "Name <email>". */
function brainActor(by: ProjectActor): string {
  return by.email ? `${by.actor.name} <${by.email}>` : by.actor.name;
}

function cleanName(name: string): string {
  const clean = truncate(name.replace(/\s+/g, " ").trim(), 120);
  if (!clean) throw new ProjectError("A project needs a name");
  return clean;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Projects: client work and the AI employees designed for it. A project is a row here (slug, owner,
 * channel, assets, exports) and a thing of kind `project` in the company brain (what the company knows
 * about it: links, timeline), kept in step. Its designs are the Studio conversations and interviews
 * started inside it; its assets are what the person or the Studio picked from the brain and the
 * company's systems, which the development package carries.
 */
export class ProjectService {
  constructor(private readonly deps: ProjectDeps) {}

  private get db() {
    return this.deps.handle.db;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** The company's projects, newest change first; `userId` counts that person's open to-dos in each. */
  async list(companyId: string, options: { status?: ProjectStatus | "open" | "all"; userId?: string | null } = {}): Promise<ProjectSummary[]> {
    const status = options.status ?? "all";
    const conditions = [eq(projects.companyId, companyId)];
    if (status === "open") conditions.push(inArray(projects.status, ["planned", "active", "on_hold"]));
    else if (status !== "all") conditions.push(eq(projects.status, status));
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.updatedAt));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [assets, threads, interviews] = await Promise.all([
      this.db
        .select({ projectId: projectAssets.projectId, n: sql<number>`count(*)::int` })
        .from(projectAssets)
        .where(inArray(projectAssets.projectId, ids))
        .groupBy(projectAssets.projectId),
      this.db
        .select({ projectId: studioThreads.projectId, n: sql<number>`count(*)::int` })
        .from(studioThreads)
        .where(inArray(studioThreads.projectId, ids))
        .groupBy(studioThreads.projectId),
      this.db
        .select({ projectId: builderSessions.projectId, n: sql<number>`count(*)::int` })
        .from(builderSessions)
        .where(inArray(builderSessions.projectId, ids))
        .groupBy(builderSessions.projectId),
    ]);
    const openTodos = options.userId ? await this.deps.todos.openByProject(companyId, options.userId, ids) : new Map<string, number>();
    const count = (list: { projectId: string | null; n: number }[], id: string) => list.find((c) => c.projectId === id)?.n ?? 0;
    return rows.map((row) => ({
      ...this.summaryOf(row),
      counts: { assets: count(assets, row.id), designs: count(threads, row.id) + count(interviews, row.id), openTodos: openTodos.get(row.id) ?? 0 },
    }));
  }

  private summaryOf(row: ProjectRow): Omit<ProjectSummary, "counts"> {
    const exports = Array.isArray(row.data.exports) ? (row.data.exports as ProjectExport[]) : [];
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      status: row.status as ProjectStatus,
      client: row.client,
      ownerUserId: row.ownerUserId,
      thingId: row.thingId,
      conversationId: row.conversationId,
      lastExportedAt: typeof row.data.lastExportedAt === "string" ? row.data.lastExportedAt : null,
      exports: exports.length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** A project by its id or slug. */
  async get(companyId: string, ref: string): Promise<ProjectRow> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, companyId), UUID.test(ref) ? eq(projects.id, ref) : eq(projects.slug, ref)));
    if (!row) throw new ProjectError("No such project", 404);
    return row;
  }

  async find(companyId: string, ref: string): Promise<ProjectRow | undefined> {
    return this.get(companyId, ref).catch((error) => {
      if (error instanceof ProjectError && error.status === 404) return undefined;
      throw error;
    });
  }

  /** The project whose channel this is. */
  async byConversation(companyId: string, conversationId: string): Promise<ProjectRow | undefined> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.conversationId, conversationId)));
    return row;
  }

  /** `base` as a project slug (and channel name), or `base-2`, `base-3`… when either is taken. */
  private async freeSlug(companyId: string, base: string): Promise<string> {
    const root = channelName(base) || "project";
    const taken = new Set((await this.db.select({ slug: projects.slug }).from(projects).where(eq(projects.companyId, companyId))).map((r) => r.slug));
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? root : `${channelName(root.slice(0, 60 - `-${n}`.length))}-${n}`;
      if (taken.has(candidate)) continue;
      if (await this.deps.conversations.findByName(companyId, candidate)) continue;
      return candidate;
    }
  }

  /**
   * A new project: its row, its thing in the brain (an existing project thing with the same name is
   * adopted), the owner leading it there, its client's link, and its private channel with the owner in it.
   */
  async create(companyId: string, input: ProjectInput, by: ProjectActor): Promise<ProjectRow> {
    const name = cleanName(input.name);
    const summary = (input.summary ?? "").trim();
    const client = input.client?.trim() || null;
    const status = input.status ?? "active";
    const slug = await this.freeSlug(companyId, name);
    const actor = brainActor(by);
    const thingId = await this.ensureThing(companyId, { name, summary, status, client }, actor);
    let conversationId: string | null = null;
    try {
      const channel = await this.deps.conversations.createChannel(companyId, { name: slug, title: name, visibility: "participants", createdBy: by.actor });
      conversationId = channel.conversation.id;
    } catch {
      // A project is still a project without its channel.
    }
    const [row] = await this.db
      .insert(projects)
      .values({ companyId, slug, name, summary, status, client, ownerUserId: by.userId, thingId, conversationId, data: {} })
      .returning();
    await this.deps.activity.record(companyId, {
      actor,
      action: "project.created",
      entityType: "project",
      entityId: row!.id,
      summary: `Created project "${name}"`,
    });
    return row!;
  }

  /** The project's thing in the brain: made, or adopted when a project of that name is already known. */
  private async ensureThing(companyId: string, input: { name: string; summary: string; status: ProjectStatus; client: string | null }, actor: string) {
    const data: Record<string, unknown> = {
      status: PROJECT_STATUS_LABELS[input.status],
      start: new Date().toISOString().slice(0, 10),
      ...(input.client ? { type: "Customer project" } : {}),
    };
    let thingId: string | null = null;
    try {
      const thing = await this.deps.brain.create(companyId, { kind: "project", name: input.name, summary: input.summary, data }, actor);
      thingId = thing.id;
    } catch (error) {
      if (!(error instanceof BrainError && error.status === 409)) throw error;
      const existing = await this.deps.brain.find(companyId, input.name, "project");
      thingId = existing?.id ?? null;
    }
    if (!thingId) return null;
    // Who leads it, and whom it is for: links the brain draws from (best effort: the people and clients may not be in it yet).
    const email = /<([^>]+)>\s*$/.exec(actor)?.[1];
    if (email) {
      const [me] = await this.deps.brain.list(companyId, { kind: "person", q: email, limit: 1 });
      if (me) await this.deps.brain.link(companyId, { from: me.id, relation: "leads", to: thingId }, actor).catch(() => undefined);
    }
    if (input.client) {
      const client = await this.deps.brain.find(companyId, input.client, "client");
      if (client) await this.deps.brain.link(companyId, { from: thingId, relation: "for_client", to: client.id }, actor).catch(() => undefined);
    }
    return thingId;
  }

  /** Changes a project; its thing and its channel follow (name, summary, status). A finished or cancelled project's channel is archived. */
  async update(companyId: string, ref: string, patch: ProjectPatch, by: ProjectActor): Promise<ProjectRow> {
    const current = await this.get(companyId, ref);
    const changes: Partial<typeof projects.$inferInsert> = {};
    if (patch.name !== undefined) changes.name = cleanName(patch.name);
    if (patch.summary !== undefined) changes.summary = patch.summary.trim();
    if (patch.client !== undefined) changes.client = patch.client?.trim() || null;
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.ownerUserId !== undefined) changes.ownerUserId = patch.ownerUserId;
    if (!Object.keys(changes).length) return current;
    const [row] = await this.db
      .update(projects)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(projects.id, current.id))
      .returning();
    const actor = brainActor(by);
    if (current.thingId && (changes.name !== undefined || changes.summary !== undefined || changes.status !== undefined)) {
      await this.deps.brain
        .update(
          companyId,
          current.thingId,
          {
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.summary !== undefined ? { summary: changes.summary } : {}),
            ...(changes.status !== undefined ? { data: { status: PROJECT_STATUS_LABELS[changes.status as ProjectStatus] } } : {}),
          },
          actor,
        )
        .catch(() => undefined);
    }
    if (current.conversationId) {
      if (changes.name !== undefined && changes.name !== current.name)
        await this.deps.conversations.rename(companyId, current.conversationId, { title: changes.name }, by.actor).catch(() => undefined);
      if (changes.status !== undefined && CLOSED_PROJECT_STATUSES.includes(changes.status as ProjectStatus))
        await this.deps.conversations.archive(companyId, current.conversationId, by.actor).catch(() => undefined);
    }
    await this.deps.activity.record(companyId, {
      actor,
      action: "project.changed",
      entityType: "project",
      entityId: current.id,
      summary: `Changed project "${row!.name}"`,
      data: { changed: Object.keys(changes) },
    });
    return row!;
  }

  /** Removes a project: its assets go with it; its designs stay (no longer in a project); its thing stays in the brain; its channel is archived. */
  async remove(companyId: string, ref: string, by: ProjectActor): Promise<void> {
    const current = await this.get(companyId, ref);
    if (current.conversationId) await this.deps.conversations.archive(companyId, current.conversationId, by.actor).catch(() => undefined);
    await this.db.delete(projects).where(eq(projects.id, current.id));
    const actor = brainActor(by);
    if (current.thingId)
      await this.deps.brain
        .addEvent(companyId, { kind: "note", title: `Project "${current.name}" was removed from the app`, about: [current.thingId] }, actor, by.email)
        .catch(() => undefined);
    await this.deps.activity.record(companyId, {
      actor,
      action: "project.removed",
      entityType: "project",
      entityId: current.id,
      summary: `Removed project "${current.name}"`,
    });
  }

  /** The development package was downloaded: the project remembers when, and its thing's timeline says so. */
  async recordExport(companyId: string, ref: string, by: ProjectActor, files: number): Promise<ProjectRow> {
    const current = await this.get(companyId, ref);
    const at = new Date().toISOString();
    const exports = [...(Array.isArray(current.data.exports) ? (current.data.exports as ProjectExport[]) : []), { at, by: by.actor.name, files }].slice(-20);
    const [row] = await this.db
      .update(projects)
      .set({ data: { ...current.data, lastExportedAt: at, exports }, updatedAt: new Date() })
      .where(eq(projects.id, current.id))
      .returning();
    const actor = brainActor(by);
    if (current.thingId)
      await this.deps.brain
        .addEvent(
          companyId,
          {
            kind: "update",
            title: "Development package exported",
            body: `${by.actor.name} downloaded the package (${files} files).`,
            about: [current.thingId],
          },
          actor,
          by.email,
          { origin: "manual", ref: `project-export:${current.id}:${at}` },
        )
        .catch(() => undefined);
    await this.deps.activity.record(companyId, {
      actor,
      action: "project.exported",
      entityType: "project",
      entityId: current.id,
      summary: `Exported the development package of "${current.name}"`,
    });
    return row!;
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  /** What a project uses, grouped by kind as a page shows it (things first, then tables, apps…). */
  async assets(companyId: string, ref: string): Promise<ProjectAssetView[]> {
    const project = await this.get(companyId, ref);
    const rows = await this.db.select().from(projectAssets).where(eq(projectAssets.projectId, project.id)).orderBy(asc(projectAssets.createdAt));
    const views = await Promise.all(rows.map((row) => this.viewOf(companyId, row)));
    const order = new Map(PROJECT_ASSET_KINDS.map((k, i) => [k as string, i]));
    return views.sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.name.localeCompare(b.name));
  }

  /** One line per asset, for the Studio agent's brief and the development plan. */
  async cards(companyId: string, ref: string): Promise<string[]> {
    const views = await this.assets(companyId, ref);
    return views.map((v) => `${PROJECT_ASSET_LABELS[v.kind]}: ${v.name}${v.detail ? ` — ${v.detail}` : ""}${v.note ? ` (${v.note})` : ""}`);
  }

  /** The projects that hold this asset. */
  async projectsOf(companyId: string, kind: ProjectAssetKind, ref: string): Promise<Pick<ProjectRow, "id" | "slug" | "name" | "status">[]> {
    const rows = await this.db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, status: projects.status })
      .from(projectAssets)
      .innerJoin(projects, eq(projects.id, projectAssets.projectId))
      .where(and(eq(projectAssets.companyId, companyId), eq(projectAssets.kind, kind), eq(projectAssets.ref, ref)))
      .orderBy(asc(projects.name));
    return rows;
  }

  /**
   * Adds something to a project: a thing of the brain, a table, an app, a calculation, a document, a
   * file, a connection or an AI employee. It must exist (404 otherwise); adding it twice changes nothing.
   * A thing is also linked to the project's thing in the brain, as fits its kind.
   */
  async addAsset(companyId: string, ref: string, input: { kind: ProjectAssetKind; ref: string; note?: string }, by: ProjectActor): Promise<ProjectAssetView> {
    const project = await this.get(companyId, ref);
    if (!PROJECT_ASSET_KINDS.includes(input.kind)) throw new ProjectError(`"${input.kind}" is not something a project holds`);
    const resolved = await this.resolve(companyId, input.kind, input.ref.trim());
    if (!resolved) throw new ProjectError(`No such ${PROJECT_ASSET_LABELS[input.kind].toLowerCase()}: ${input.ref}`, 404);
    const note = truncate((input.note ?? "").replace(/\s+/g, " ").trim(), 300);
    const inserted = await this.db
      .insert(projectAssets)
      .values({ companyId, projectId: project.id, kind: input.kind, ref: resolved.ref, note, addedBy: by.actor })
      .onConflictDoNothing({ target: [projectAssets.projectId, projectAssets.kind, projectAssets.ref] })
      .returning();
    let row = inserted[0];
    if (!row) {
      [row] = await this.db
        .select()
        .from(projectAssets)
        .where(and(eq(projectAssets.projectId, project.id), eq(projectAssets.kind, input.kind), eq(projectAssets.ref, resolved.ref)));
      return this.viewOf(companyId, row!);
    }
    if (input.kind === "thing" && project.thingId) await this.linkThing(companyId, resolved.ref, project.thingId, resolved.thingKind ?? "", brainActor(by));
    await this.deps.activity.record(companyId, {
      actor: brainActor(by),
      action: "project.asset_added",
      entityType: "project",
      entityId: project.id,
      summary: `Added ${PROJECT_ASSET_LABELS[input.kind].toLowerCase()} "${resolved.name}" to project "${project.name}"`,
    });
    return this.viewOf(companyId, row);
  }

  /** The relation a thing of this kind has to a project, in the brain; `part_of` (any to any) when none fits better. */
  private async linkThing(companyId: string, thingId: string, projectThingId: string, kind: string, actor: string): Promise<void> {
    const candidates: { from: string; relation: BrainRelationKey; to: string }[] = [];
    if (kind === "client") candidates.push({ from: projectThingId, relation: "for_client", to: thingId });
    if (kind === "person" || kind === "ai_employee" || kind === "department") candidates.push({ from: thingId, relation: "works_on", to: projectThingId });
    if (["system", "database", "data_store", "document"].includes(kind)) candidates.push({ from: projectThingId, relation: "uses", to: thingId });
    if (kind === "data_table" || kind === "dataset") candidates.push({ from: projectThingId, relation: "uses_data", to: thingId });
    if (kind === "policy") candidates.push({ from: projectThingId, relation: "follows", to: thingId });
    candidates.push({ from: thingId, relation: "part_of", to: projectThingId });
    for (const candidate of candidates) {
      try {
        await this.deps.brain.link(companyId, candidate, actor);
        return;
      } catch {
        // The next relation that fits.
      }
    }
  }

  async removeAsset(companyId: string, ref: string, assetId: string, by: ProjectActor): Promise<void> {
    const project = await this.get(companyId, ref);
    const [row] = await this.db
      .select()
      .from(projectAssets)
      .where(and(eq(projectAssets.projectId, project.id), eq(projectAssets.id, assetId)));
    if (!row) throw new ProjectError("This is not in the project", 404);
    await this.db.delete(projectAssets).where(eq(projectAssets.id, row.id));
    await this.deps.activity.record(companyId, {
      actor: brainActor(by),
      action: "project.asset_removed",
      entityType: "project",
      entityId: project.id,
      summary: `Took ${PROJECT_ASSET_LABELS[row.kind as ProjectAssetKind]?.toLowerCase() ?? row.kind} "${row.ref}" out of project "${project.name}"`,
    });
  }

  /** What an asset reference points to, by its kind: its canonical reference and how it reads; undefined when it does not exist. */
  async resolve(
    companyId: string,
    kind: ProjectAssetKind,
    ref: string,
  ): Promise<{ ref: string; name: string; detail: string; departmentId: string | null; shared: boolean; thingKind?: string } | undefined> {
    if (!ref) return undefined;
    try {
      switch (kind) {
        case "thing": {
          const row = await this.deps.brain.find(companyId, ref);
          if (!row) return undefined;
          const kindName = brainKind(row.kind)?.name ?? row.kind;
          return {
            ref: row.id,
            name: row.name,
            detail: [kindName, row.summary.replace(/\s+/g, " ").slice(0, 160)].filter(Boolean).join(" · "),
            departmentId: null,
            shared: true,
            thingKind: row.kind,
          };
        }
        case "table": {
          const table = await this.deps.tables.get(companyId, ref);
          return {
            ref: table.key,
            name: table.name,
            detail: `${table.fields.length} fields · ${table.records} records`,
            departmentId: table.departmentId,
            shared: table.settings.visibility === "company",
          };
        }
        case "app": {
          const app = await this.deps.apps.get(companyId, ref);
          return {
            ref: app.key,
            name: app.name,
            detail: app.description.slice(0, 160),
            departmentId: app.departmentId,
            shared: app.settings.visibility === "company",
          };
        }
        case "calculation": {
          const calculation = await this.deps.calculations.get(companyId, ref);
          return {
            ref: calculation.key,
            name: calculation.name,
            detail: calculation.rule.slice(0, 160),
            departmentId: calculation.departmentId,
            shared: !calculation.departmentId,
          };
        }
        case "document": {
          const document = await this.deps.knowledge.getDocument(companyId, ref);
          if (!document) return undefined;
          const collection = await this.deps.knowledge.getCollection(companyId, document.collectionId);
          return {
            ref: document.id,
            name: document.title,
            detail: [collection?.name, document.chunkCount ? `${document.chunkCount} parts` : document.status].filter(Boolean).join(" · "),
            departmentId: collection?.departmentId ?? null,
            shared: !collection?.departmentId,
          };
        }
        case "file": {
          const file = await this.deps.files.meta(companyId, ref);
          return { ref: file.id, name: file.name, detail: `${file.mimeType} · ${formatBytes(file.size)}`, departmentId: null, shared: true };
        }
        case "connection": {
          const connection = await this.deps.connectors.get(companyId, ref);
          return {
            ref: connection.id,
            name: connection.name,
            detail: `${connection.type}${connection.sandbox ? " (demo system)" : ""}`,
            departmentId: null,
            shared: true,
          };
        }
        case "agent": {
          const agent = await this.deps.agents.find(companyId, ref);
          if (!agent) return undefined;
          return {
            ref: agent.row.id,
            name: agent.definition.name,
            detail: [agent.definition.title, agent.row.status].filter(Boolean).join(" · "),
            departmentId: agent.row.departmentId,
            shared: !agent.row.departmentId,
          };
        }
      }
    } catch {
      return undefined;
    }
  }

  private async viewOf(companyId: string, row: ProjectAssetRow): Promise<ProjectAssetView> {
    const kind = row.kind as ProjectAssetKind;
    const resolved = await this.resolve(companyId, kind, row.ref);
    return {
      id: row.id,
      kind,
      ref: row.ref,
      note: row.note,
      addedBy: row.addedBy as Actor,
      createdAt: row.createdAt,
      name: resolved?.name ?? row.ref,
      detail: resolved?.detail ?? "No longer exists",
      exists: Boolean(resolved),
      departmentId: resolved?.departmentId ?? null,
      shared: resolved?.shared ?? true,
    };
  }

  // -------------------------------------------------------------------------
  // Designs
  // -------------------------------------------------------------------------

  /** The Studio conversations and interviews started in the project, and the AI employees they made or that were attached. */
  async designs(companyId: string, ref: string): Promise<ProjectDesigns> {
    const project = await this.get(companyId, ref);
    const [threadRows, interviewRows, attached] = await Promise.all([
      this.db.select().from(studioThreads).where(eq(studioThreads.projectId, project.id)).orderBy(desc(studioThreads.updatedAt)),
      this.db.select().from(builderSessions).where(eq(builderSessions.projectId, project.id)).orderBy(desc(builderSessions.updatedAt)),
      this.db
        .select()
        .from(projectAssets)
        .where(and(eq(projectAssets.projectId, project.id), eq(projectAssets.kind, "agent"))),
    ]);
    const threads = threadRows.map((row) => {
      const solution = row.solution as { employees?: { agentId?: string | null }[] };
      const owner = row.owner as { name?: string };
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        ownerId: row.ownerId,
        owner: owner.name ?? "",
        builtAt: row.builtAt,
        updatedAt: row.updatedAt,
        agentIds: (solution.employees ?? []).map((e) => e.agentId).filter((id): id is string => Boolean(id)),
      };
    });
    const interviews = interviewRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      requesterEmail: row.requesterEmail,
      department: row.department,
      agentId: row.agentId,
      updatedAt: row.updatedAt,
    }));
    const wanted: { id: string; from: ProjectDesigns["agents"][number]["from"] }[] = [
      ...threads.flatMap((t) => t.agentIds.map((id) => ({ id, from: "studio" as const }))),
      ...interviews.flatMap((i) => (i.agentId ? [{ id: i.agentId, from: "interview" as const }] : [])),
      ...attached.map((a) => ({ id: a.ref, from: "attached" as const })),
    ];
    const agents: ProjectDesigns["agents"] = [];
    for (const { id, from } of wanted) {
      if (agents.some((a) => a.id === id)) continue;
      const agent = await this.deps.agents.find(companyId, id);
      if (agent)
        agents.push({
          id: agent.row.id,
          slug: agent.row.slug,
          name: agent.definition.name,
          status: agent.row.status,
          departmentId: agent.row.departmentId,
          from,
        });
    }
    return { threads, interviews, agents };
  }

  /** Puts an existing Studio conversation or interview into the project (404 when there is none). */
  async attachDesign(companyId: string, ref: string, design: { kind: "thread" | "interview"; id: string }): Promise<void> {
    const project = await this.get(companyId, ref);
    const updated =
      design.kind === "thread"
        ? await this.db
            .update(studioThreads)
            .set({ projectId: project.id })
            .where(and(eq(studioThreads.companyId, companyId), eq(studioThreads.id, design.id)))
            .returning({ id: studioThreads.id })
        : await this.db
            .update(builderSessions)
            .set({ projectId: project.id })
            .where(and(eq(builderSessions.companyId, companyId), eq(builderSessions.id, design.id)))
            .returning({ id: builderSessions.id });
    if (!updated.length) throw new ProjectError(design.kind === "thread" ? "No such Studio conversation" : "No such interview", 404);
  }
}
