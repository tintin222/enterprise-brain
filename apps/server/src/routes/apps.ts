import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { proposeApp, type AppTable } from "@enterprise-brain/builder";
import { AppPage, AppSettings, describeBlock, TableDesign, type AppDesign } from "@enterprise-brain/core";
import type { AppView, TableView } from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";
import { canDesignTable, canEditRecords, canSeeTable } from "./tables.ts";

/** Who uses an app: its department's people, or everyone when it is shared with the company. */
export function canUseApp(viewer: Viewer, app: Pick<AppView, "departmentId" | "settings">): boolean {
  return app.settings.visibility === "company" || canSeeDepartment(viewer, app.departmentId);
}

const Design = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  icon: z.string().max(40).optional(),
  pages: z.array(AppPage).min(1).max(8),
  departmentId: z.string().uuid().nullable().optional(),
  settings: AppSettings.partial().optional(),
});

/**
 * Apps: people describe the screens they need; the Studio proposes pages of blocks on the company's
 * tables (and the table itself when there is none), and the platform draws them.
 */
export async function appRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  const appFor = async (request: FastifyRequest, companyId: string, ref: string) => {
    const found = await platform.apps.get(companyId, ref).catch(() => undefined);
    if (!found || !canUseApp(viewerOf(request), found)) throw new HttpError(404, `There is no app "${ref}"`);
    return found;
  };
  const designable = async (request: FastifyRequest, companyId: string, ref: string) => {
    const found = await appFor(request, companyId, ref);
    if (!canManageDepartment(viewerOf(request), found.departmentId)) throw new HttpError(403, `Only a manager of its department changes ${found.name}`);
    return found;
  };
  const assertMayCreate = (viewer: Viewer, departmentId: string | null | undefined) => {
    if (!canManageDepartment(viewer, departmentId)) {
      throw new HttpError(
        403,
        departmentId ? "Only a manager of this department makes its apps" : "Only an admin makes company-wide apps; choose a department",
      );
    }
  };
  /** The tables and AI employees the viewer may build on. */
  const materials = async (request: FastifyRequest, companyId: string) => {
    const viewer = viewerOf(request);
    const tables = (await platform.tables.list(companyId)).filter((t) => canSeeTable(viewer, t));
    const agents = (await platform.agents.list(companyId)).filter((a) => a.row.status !== "archived" && canSeeDepartment(viewer, a.row.departmentId));
    return { tables, agents };
  };
  /** Each block in plain words, for people to check what they'll get. */
  const outline = (
    design: Pick<AppDesign, "pages">,
    tables: Pick<AppTable, "key" | "name" | "fields">[],
    agents: { slug: string; name: string }[],
    calculations: { key: string; name: string }[] = [],
  ) => {
    const byKey = new Map(tables.map((t) => [t.key, t]));
    const names = {
      table: (key: string) => byKey.get(key)?.name ?? key,
      field: (table: string, key: string) => byKey.get(table)?.fields.find((f) => f.key === key)?.label ?? key,
      agent: (slug: string) => agents.find((a) => a.slug === slug)?.name ?? slug,
      calculation: (key: string) => calculations.find((c) => c.key === key)?.name ?? key,
    };
    return design.pages.map((page) => ({ key: page.key, title: page.title, blocks: page.blocks.map((block) => describeBlock(block, names)) }));
  };

  app.get("/api/companies/:company/apps", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { archived } = z.object({ archived: z.enum(["true", "false"]).optional() }).parse(request.query ?? {});
    const apps = await platform.apps.list(company.id, { archived: archived === "true" });
    return apps.filter((a) => canUseApp(viewer, a)).map((a) => ({ ...a, can: { design: canManageDepartment(viewer, a.departmentId) } }));
  });

  /** The Studio's proposal: the app's pages, the tables it needs made, and each block in plain words. */
  app.post("/api/companies/:company/apps/propose", async (request) => {
    const company = await companyOf(platform, request);
    const body = z.object({ description: z.string().trim().min(3).max(4000) }).parse(request.body);
    const { tables, agents } = await materials(request, company.id);
    const proposal = await proposeApp(platform.llm, {
      description: body.description,
      tables: tables.map((t) => ({ key: t.key, name: t.name, fields: t.fields, titleField: t.titleField })),
      agents: agents.map((a) => ({ slug: a.row.slug, name: a.definition.name, summary: a.definition.summary })),
    });
    const people = agents.map((a) => ({ slug: a.row.slug, name: a.definition.name }));
    return { ...proposal, outline: outline(proposal.design, [...tables, ...proposal.tables], people) };
  });

  /** Make an app, and first the tables it needs ({ tables }); if the app can't be made, they are taken back. */
  app.post("/api/companies/:company/apps", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = Design.extend({ tables: z.array(TableDesign).max(5).optional() }).parse(request.body);
    assertMayCreate(viewer, body.departmentId);
    const made: TableView[] = [];
    const renamed = new Map<string, string>();
    try {
      for (const design of body.tables ?? []) {
        const { key, ...rest } = design;
        const taken = await platform.tables.get(company.id, key).catch(() => undefined);
        const table = await platform.tables.create(
          company.id,
          { ...rest, ...(taken ? {} : { key }), departmentId: body.departmentId ?? null },
          actorOf(viewer),
        );
        made.push(table);
        if (table.key !== key) renamed.set(key, table.key);
      }
      // A table made under another key (the one proposed was taken): its blocks follow it.
      const pages = renamed.size ? (JSON.parse(JSON.stringify(body.pages)) as typeof body.pages) : body.pages;
      for (const page of pages) for (const block of page.blocks) if ("table" in block && renamed.has(block.table)) block.table = renamed.get(block.table)!;
      const { tables: _tables, ...input } = body;
      const created = await platform.apps.create(company.id, { ...input, pages }, actorOf(viewer));
      for (const table of made) {
        await platform.activity.record(company.id, {
          actor: actorOf(viewer),
          action: "table.created",
          entityType: "table",
          entityId: table.id,
          summary: `Made the table ${table.name}`,
        });
      }
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: "app.created",
        entityType: "app",
        entityId: created.id,
        summary: `Made the app ${created.name}`,
      });
      return { ...created, can: { design: true }, madeTables: made.map((t) => t.key) };
    } catch (error) {
      for (const table of made) await platform.tables.remove(company.id, table.id).catch(() => undefined);
      throw error;
    }
  });

  /** An app with what it needs to draw: its tables (with the viewer's rights) and the AI employees its buttons ask. */
  app.get("/api/companies/:company/apps/:app", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { app: ref } = request.params as { app: string };
    const found = await appFor(request, company.id, ref);
    const tables = [];
    for (const key of found.tables) {
      const table = await platform.tables.get(company.id, key).catch(() => undefined);
      if (table && canSeeTable(viewer, table)) tables.push({ ...table, can: { edit: canEditRecords(viewer, table), design: canDesignTable(viewer, table) } });
    }
    const agents = [];
    for (const slug of found.agents) {
      const agent = await platform.agents.find(company.id, slug);
      if (agent && canSeeDepartment(viewer, agent.row.departmentId))
        agents.push({ slug: agent.row.slug, name: agent.definition.name, status: agent.row.status });
    }
    const calculations = [];
    for (const key of found.calculations) {
      const calculation = await platform.calculations.get(company.id, key).catch(() => undefined);
      if (calculation && canSeeDepartment(viewer, calculation.departmentId)) calculations.push(calculation);
    }
    return {
      app: { ...found, can: { design: canManageDepartment(viewer, found.departmentId) } },
      tables,
      agents,
      calculations,
      outline: outline(found, tables, agents, calculations),
    };
  });

  app.patch("/api/companies/:company/apps/:app", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { app: ref } = request.params as { app: string };
    const body = Design.partial().parse(request.body);
    const found = await designable(request, company.id, ref);
    if (body.departmentId !== undefined && body.departmentId !== found.departmentId) assertMayCreate(viewer, body.departmentId);
    const changed = await platform.apps.change(company.id, found.id, body);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "app.changed",
      entityType: "app",
      entityId: found.id,
      summary: `Changed the app ${changed.name}`,
      data: { changed: Object.keys(body) },
    });
    return { ...changed, can: { design: true } };
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post(`/api/companies/:company/apps/:app/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const viewer = viewerOf(request);
      const { app: ref } = request.params as { app: string };
      const found = await designable(request, company.id, ref);
      const done = await platform.apps.archive(company.id, found.id, archived);
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: archived ? "app.archived" : "app.restored",
        entityType: "app",
        entityId: found.id,
        summary: `${archived ? "Archived" : "Brought back"} the app ${found.name}`,
      });
      return { ...done, can: { design: true } };
    });
  }
}
