import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PROJECT_ASSET_KINDS,
  PROJECT_STATUSES,
  type ProjectActor,
  type ProjectAssetView,
  type ProjectDesigns,
  type ProjectRow,
  type ProjectSummary,
  type TodoRow,
} from "@enterprise-brain/runtime";
import { actorOfViewer } from "../auth/conversations.ts";
import { canEditProject, canSeeDepartment, requirePerson, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";
import { StudioService } from "../studio/service.ts";
import { mayOpenInterview } from "./builder.ts";
import { parseDue, todoView } from "./todos.ts";

const ProjectBody = z.object({
  name: z.string().trim().min(1).max(120),
  summary: z.string().max(4000).optional(),
  client: z.string().max(200).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

const PatchBody = ProjectBody.partial().extend({ ownerUserId: z.string().uuid().nullish() });

const AssetBody = z.object({ kind: z.enum(PROJECT_ASSET_KINDS), ref: z.string().trim().min(1).max(300), note: z.string().max(300).optional() });

const DesignBody = z.object({ kind: z.enum(["thread", "interview", "agent"]), id: z.string().min(1) });

const TodoBody = z.object({ title: z.string().trim().min(1).max(300), details: z.string().max(4000).optional(), dueAt: z.string().nullish() });

/** How the viewer acts on projects: as they take part in conversations, with their account and email. */
export function projectActor(viewer: Viewer): ProjectActor {
  return { actor: actorOfViewer(viewer), userId: viewer.userId, email: viewer.email };
}

/** Who sees an asset: everyone when it is company-wide or shared with the company; else its department's people. */
export function canSeeAsset(viewer: Viewer, asset: { departmentId: string | null; shared: boolean }): boolean {
  return asset.shared || canSeeDepartment(viewer, asset.departmentId);
}

/** A project as its page shows it: its summary and counts, who owns it, its thing and its channel, and what the viewer may do. */
export interface ProjectView extends ProjectSummary {
  owner: { id: string; name: string } | null;
  channel: { id: string; name: string | null; status: string } | null;
  canEdit: boolean;
}

/**
 * Projects: client work and the AI employees designed for it. Everyone signed in reads every project
 * and may start one; its owner, admins and managers change it. A project holds assets (things of the
 * brain, tables, apps, calculations, documents, files, connections, AI employees), designs (Studio
 * conversations and interviews started inside it) and the person's own to-dos for it.
 */
export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, builder } = ctx;
  const base = "/api/companies/:company/projects";
  const studio = () => (ctx.studio ??= new StudioService(platform, { publicUrl: ctx.config.publicUrl }));

  const projectOf = async (request: FastifyRequest, companyId: string): Promise<ProjectRow> => {
    const { ref } = request.params as { ref: string };
    return platform.projects.get(companyId, ref);
  };

  const editable = async (request: FastifyRequest, companyId: string): Promise<{ project: ProjectRow; viewer: Viewer }> => {
    const viewer = viewerOf(request);
    const project = await projectOf(request, companyId);
    if (!canEditProject(viewer, project)) throw new HttpError(403, "Only the project's owner, a manager or an admin can change it");
    return { project, viewer };
  };

  const view = async (companyId: string, project: ProjectRow, viewer: Viewer): Promise<ProjectView> => {
    const summary = (await platform.projects.list(companyId, { userId: viewer.userId })).find((p) => p.id === project.id);
    if (!summary) throw new HttpError(404, "No such project");
    const owner = project.ownerUserId ? await platform.people.get(companyId, project.ownerUserId).catch(() => undefined) : undefined;
    const channel = project.conversationId ? await platform.conversations.find(companyId, project.conversationId) : undefined;
    return {
      ...summary,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      channel: channel ? { id: channel.conversation.id, name: channel.conversation.name, status: channel.conversation.status } : null,
      canEdit: canEditProject(viewer, project),
    };
  };

  /** The projects; `holding=<kind>:<ref>` keeps only those with that asset (where a thing already is). */
  app.get(base, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const query = z
      .object({ status: z.enum([...PROJECT_STATUSES, "open", "all"]).default("all"), holding: z.string().max(400).optional() })
      .parse(request.query);
    const list = await platform.projects.list(company.id, { status: query.status, userId: viewer.userId });
    if (!query.holding) return list;
    const [kind, ...rest] = query.holding.split(":");
    const ref = rest.join(":");
    if (!PROJECT_ASSET_KINDS.includes(kind as never) || !ref) throw new HttpError(400, "holding is <kind>:<ref>");
    const holders = new Set((await platform.projects.projectsOf(company.id, kind as (typeof PROJECT_ASSET_KINDS)[number], ref)).map((p) => p.id));
    return list.filter((p) => holders.has(p.id));
  });

  app.post(base, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = ProjectBody.parse(request.body);
    const project = await platform.projects.create(company.id, body, projectActor(viewer));
    return view(company.id, project, viewer);
  });

  app.get(`${base}/:ref`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    return view(company.id, await projectOf(request, company.id), viewer);
  });

  app.patch(`${base}/:ref`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    const body = PatchBody.parse(request.body);
    const updated = await platform.projects.update(company.id, project.id, body, projectActor(viewer));
    return view(company.id, updated, viewer);
  });

  app.delete(`${base}/:ref`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    await platform.projects.remove(company.id, project.id, projectActor(viewer));
    return { removed: true };
  });

  // ---------------------------------------------------------------------------
  // Assets

  /** What the project uses, as the viewer may see it; `hidden` counts the assets of departments they are not in. */
  app.get(`${base}/:ref/assets`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const project = await projectOf(request, company.id);
    const all = await platform.projects.assets(company.id, project.id);
    const assets = all.filter((a) => canSeeAsset(viewer, a));
    return { assets, hidden: all.length - assets.length };
  });

  app.post(`${base}/:ref/assets`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    const body = AssetBody.parse(request.body);
    const resolved = await platform.projects.resolve(company.id, body.kind, body.ref);
    if (!resolved || !canSeeAsset(viewer, resolved))
      throw new HttpError(404, `No such ${body.kind === "agent" ? "AI employee" : body.kind === "thing" ? "thing in the brain" : body.kind}`);
    return platform.projects.addAsset(company.id, project.id, body, projectActor(viewer));
  });

  app.delete(`${base}/:ref/assets/:asset`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    const { asset } = request.params as { asset: string };
    await platform.projects.removeAsset(company.id, project.id, asset, projectActor(viewer));
    return { removed: true };
  });

  /** Files uploaded straight into the project (stored, then added as file assets). */
  app.post(`${base}/:ref/files`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    if (!request.isMultipart()) throw new HttpError(400, "Upload files as multipart/form-data");
    const { files } = await readMultipart(platform, company.id, request, "project");
    const added: ProjectAssetView[] = [];
    for (const file of files) added.push(await platform.projects.addAsset(company.id, project.id, { kind: "file", ref: file.id }, projectActor(viewer)));
    return added;
  });

  // ---------------------------------------------------------------------------
  // Designs

  /** The designs made in the project; `canOpen` says whether the viewer may open each (its owner and admins; an interview's hiring manager too). */
  app.get(`${base}/:ref/designs`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const project = await projectOf(request, company.id);
    const designs: ProjectDesigns = await platform.projects.designs(company.id, project.id);
    return {
      threads: designs.threads.map((t) => ({ ...t, canOpen: viewer.isAdmin || (Boolean(t.ownerId) && t.ownerId === viewer.userId) })),
      interviews: designs.interviews.map((i) => ({ ...i, canOpen: mayOpenInterview(viewer, i) })),
      agents: designs.agents.filter((a) => canSeeDepartment(viewer, a.departmentId)),
    };
  });

  /** Puts an existing design in the project: a Studio conversation or interview of the viewer's, or an AI employee they may see. */
  app.post(`${base}/:ref/designs`, async (request) => {
    const company = await companyOf(platform, request);
    const { project, viewer } = await editable(request, company.id);
    const body = DesignBody.parse(request.body);
    if (body.kind === "agent") {
      const resolved = await platform.projects.resolve(company.id, "agent", body.id);
      if (!resolved || !canSeeAsset(viewer, resolved)) throw new HttpError(404, "No such AI employee");
      await platform.projects.addAsset(company.id, project.id, { kind: "agent", ref: body.id }, projectActor(viewer));
    } else {
      if (body.kind === "thread") await studio().mine(company.id, body.id, viewer);
      else if (!mayOpenInterview(viewer, await builder.find(company.id, body.id))) throw new HttpError(404, "No such interview");
      await platform.projects.attachDesign(company.id, project.id, { kind: body.kind, id: body.id });
    }
    return { attached: true };
  });

  // ---------------------------------------------------------------------------
  // The person's to-dos for the project

  app.get(`${base}/:ref/todos`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const project = await projectOf(request, company.id);
    const { status } = z.object({ status: z.enum(["open", "done", "dismissed", "all"]).default("open") }).parse(request.query);
    const rows: TodoRow[] = await platform.todos.listFor(company.id, viewer.userId, { status, projectId: project.id });
    const named = { id: project.id, slug: project.slug, name: project.name };
    return rows.map((row) => todoView(row, named));
  });

  app.post(`${base}/:ref/todos`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const project = await projectOf(request, company.id);
    const body = TodoBody.parse(request.body);
    const { todo } = await platform.todos.add(
      company.id,
      { userId: viewer.userId, projectId: project.id, title: body.title, details: body.details, dueAt: parseDue(body.dueAt), source: "project" },
      actorOfViewer(viewer),
    );
    return todoView(todo, { id: project.id, slug: project.slug, name: project.name });
  });
}
