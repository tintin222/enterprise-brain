import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { changeApp, describeAppChanges, namesOf, proposeApp, type AppTable } from "@enterprise-brain/builder";
import { AppPage, AppSettings, describeBlock, TableDesign, type AppDesign, type BuildingRules } from "@enterprise-brain/core";
import type { AppView, TableView } from "@enterprise-brain/runtime";
import { canBuildFor, canChangeBuilt, rulesOf } from "../auth/building.ts";
import { actorOf, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";
import { personalDataAfterDesign } from "./building.ts";
import { canDesignTable, canEditRecords, canSeeTable, notBuilding } from "./tables.ts";

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
  const designable = async (request: FastifyRequest, company: { id: string; settings: Record<string, unknown> }, ref: string) => {
    const found = await appFor(request, company.id, ref);
    if (!canChangeBuilt(viewerOf(request), found, rulesOf(company)))
      throw new HttpError(403, `Only a manager of its department (or whoever made it) changes ${found.name}`);
    return found;
  };
  const assertMayCreate = (viewer: Viewer, departmentId: string | null | undefined, rules: BuildingRules) => {
    if (!canBuildFor(viewer, departmentId, rules)) throw new HttpError(403, notBuilding("apps", departmentId, rules));
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
    const rules = rulesOf(company);
    return apps.filter((a) => canUseApp(viewer, a)).map((a) => ({ ...a, can: { design: canChangeBuilt(viewer, a, rules) } }));
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
    const rules = rulesOf(company);
    assertMayCreate(viewer, body.departmentId, rules);
    // Shared with the whole company only once IT says so.
    const share = body.settings?.visibility === "company" && !viewer.isAdmin;
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
      const created = await platform.apps.create(
        company.id,
        { ...input, pages, ...(share ? { settings: { ...input.settings, visibility: "department" as const } } : {}) },
        actorOf(viewer),
      );
      if (share) await platform.reviews.sharing(company.id, { type: "app", id: created.id, departmentId: created.departmentId }, viewer.name);
      for (const table of made) {
        await personalDataAfterDesign(platform, company.id, viewer, rules, table);
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
      return {
        ...created,
        can: { design: true },
        madeTables: made.map((t) => t.key),
        reviews: (await platform.reviews.list(company.id, { status: "waiting" })).filter((r) => r.itemId === created.id || made.some((t) => t.id === r.itemId)),
      };
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
    const rules = rulesOf(company);
    const tables = [];
    for (const key of found.tables) {
      const table = await platform.tables.get(company.id, key).catch(() => undefined);
      if (table && canSeeTable(viewer, table))
        tables.push({ ...table, can: { edit: canEditRecords(viewer, table), design: canDesignTable(viewer, table, rules) } });
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
      app: { ...found, can: { design: canChangeBuilt(viewer, found, rules) } },
      reviews: await platform.reviews.list(company.id, { status: "waiting", itemId: found.id }),
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
    const rules = rulesOf(company);
    const found = await designable(request, company, ref);
    if (body.departmentId !== undefined && body.departmentId !== found.departmentId) assertMayCreate(viewer, body.departmentId, rules);
    const share = body.settings?.visibility === "company" && found.settings.visibility !== "company" && !viewer.isAdmin;
    const { visibility: _asked, ...otherSettings } = body.settings ?? {};
    const changed = await platform.apps.change(company.id, found.id, { ...(share ? { ...body, settings: otherSettings } : body), by: viewer.name });
    if (share) await platform.reviews.sharing(company.id, { type: "app", id: found.id, departmentId: changed.departmentId }, viewer.name);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "app.changed",
      entityType: "app",
      entityId: found.id,
      summary: `Changed the app ${changed.name}`,
      data: { changed: Object.keys(body) },
    });
    return { ...changed, can: { design: true }, reviews: await platform.reviews.list(company.id, { status: "waiting", itemId: found.id }) };
  });

  /** Its versions, newest first, each with what changed from the one before, in plain words. */
  app.get("/api/companies/:company/apps/:app/versions", async (request) => {
    const company = await companyOf(platform, request);
    const { app: ref } = request.params as { app: string };
    const found = await appFor(request, company.id, ref);
    const { tables, agents } = await materials(request, company.id);
    const calculations = await platform.calculations.list(company.id);
    const names = namesOf(
      tables.map((t) => ({ key: t.key, name: t.name, fields: t.fields, titleField: t.titleField })),
      agents.map((a) => ({ slug: a.row.slug, name: a.definition.name })),
      calculations.map((c) => ({ key: c.key, name: c.name })),
    );
    const versions = await platform.versions.list(company.id, { type: "app", id: found.id });
    return versions.map((v, i) => {
      const previous = versions[i + 1];
      const pages = (snapshot: Record<string, unknown>) => (snapshot.pages ?? []) as AppPage[];
      return {
        version: v.version,
        by: v.by,
        note: v.note,
        createdAt: v.createdAt,
        current: v.version === found.version,
        summary: previous ? describeAppChanges(pages(previous.snapshot), pages(v.snapshot), names) : ["Made"],
      };
    });
  });

  /** Go back to an earlier version: a new version with its pages (checked against the tables as they are now). */
  app.post("/api/companies/:company/apps/:app/versions/:version/restore", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { app: ref, version } = request.params as { app: string; version: string };
    const found = await designable(request, company, ref);
    const target = await platform.versions.get(company.id, { type: "app", id: found.id }, Number(version));
    if (!target) throw new HttpError(404, `${found.name} has no version ${version}`);
    if (target.version === found.version) throw new HttpError(400, `${found.name} is at version ${version} already`);
    const snapshot = target.snapshot as { name: string; description?: string; icon?: string; pages: AppPage[] };
    const changed = await platform.apps.change(company.id, found.id, {
      name: snapshot.name,
      description: snapshot.description ?? "",
      icon: snapshot.icon ?? "",
      pages: snapshot.pages,
      by: viewer.name,
      note: `Back to version ${target.version}`,
    });
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "app.restored",
      entityType: "app",
      entityId: found.id,
      summary: `${viewer.name} took ${found.name} back to version ${target.version}`,
    });
    return { ...changed, can: { design: true } };
  });

  /** A change said in plain words: the pages as they would be, what changes, and what wouldn't work (nothing changes yet). */
  app.post("/api/companies/:company/apps/:app/changes", async (request) => {
    const company = await companyOf(platform, request);
    const { app: ref } = request.params as { app: string };
    const body = z.object({ request: z.string().trim().min(3).max(2000) }).parse(request.body);
    const found = await designable(request, company, ref);
    const { tables, agents } = await materials(request, company.id);
    const viewer = viewerOf(request);
    const calculations = (await platform.calculations.list(company.id)).filter((c) => canSeeDepartment(viewer, c.departmentId));
    const change = await changeApp(platform.llm, {
      design: { key: found.key, name: found.name, description: found.description, ...(found.icon ? { icon: found.icon } : {}), pages: found.pages },
      request: body.request,
      tables: tables.map((t) => ({ key: t.key, name: t.name, fields: t.fields, titleField: t.titleField })),
      agents: agents.map((a) => ({ slug: a.row.slug, name: a.definition.name, summary: a.definition.summary })),
      calculations: calculations.map((c) => ({ key: c.key, name: c.name })),
    });
    const people = agents.map((a) => ({ slug: a.row.slug, name: a.definition.name }));
    return {
      ...change,
      outline: outline({ pages: change.pages }, tables, people, calculations),
      problems: change.pages.length ? await platform.apps.check(company.id, { pages: change.pages }) : ["The app would have no pages"],
    };
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post(`/api/companies/:company/apps/:app/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const viewer = viewerOf(request);
      const { app: ref } = request.params as { app: string };
      const found = await designable(request, company, ref);
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
