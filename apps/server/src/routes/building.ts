import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { BUILDERS, BUILDERS_LABELS, describeRepeat, type BuildingRules } from "@enterprise-brain/core";
import { companies } from "@enterprise-brain/db";
import type { Platform, ReviewView, TableView } from "@enterprise-brain/runtime";
import { buildsFor, canChangeBuilt, decidesPersonalData, rulesOf } from "../auth/building.ts";
import { actorOf, canSeeDepartment, requireAdmin, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/**
 * After a table is made or changed: its personal-data fields not yet approved wait for the data
 * protection officer (a request is opened or brought up to date). The officer's own tables are approved
 * as they make them; with no personal data left, a waiting request is withdrawn.
 */
export async function personalDataAfterDesign(
  platform: Platform,
  companyId: string,
  viewer: Viewer,
  rules: BuildingRules,
  table: TableView,
): Promise<{ table: TableView; review: ReviewView | null }> {
  if (table.personal.waiting.length && decidesPersonalData(viewer, rules)) {
    const approved = await platform.tables.approvePersonal(companyId, table.id, table.personal.waiting);
    await platform.reviews.personalData(companyId, approved, viewer.name);
    await platform.activity.record(companyId, {
      actor: actorOf(viewer),
      action: "review.personal-data",
      entityType: "table",
      entityId: table.id,
      summary: `${viewer.name} approved the personal data of ${table.name} as they made it`,
    });
    return { table: approved, review: null };
  }
  return { table, review: await platform.reviews.personalData(companyId, table, viewer.name) };
}

/**
 * Going back to an earlier version of a table: choice values renamed since then are renamed back
 * (newest first), so the records fit the earlier list again. `newer`: the versions after the one
 * gone back to, newest first.
 */
export function renamesBack(newer: { snapshot: Record<string, unknown> }[]): Record<string, Record<string, string>> {
  const back: Record<string, Record<string, string>> = {};
  for (const version of newer) {
    const renames = (version.snapshot.renames ?? {}) as Record<string, Record<string, string>>;
    for (const [field, map] of Object.entries(renames)) {
      const now = (back[field] ??= {});
      for (const [from, to] of Object.entries(map)) {
        // Values that are `to` after this version were `from` before it.
        let chained = false;
        for (const [current, mapped] of Object.entries(now)) {
          if (mapped === to) {
            now[current] = from;
            chained = true;
          }
        }
        if (!chained && !(to in now)) now[to] = from;
      }
    }
  }
  for (const [field, map] of Object.entries(back)) {
    for (const [current, earlier] of Object.entries(map)) if (current === earlier) delete map[current];
    if (!Object.keys(map).length) delete back[field];
  }
  return back;
}

/**
 * The rules for building (IT sets them), the decisions they ask for, and the list of everything
 * people built, with its owner, for IT.
 */
export async function buildingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  const person = async (companyId: string, id: string | null) => {
    if (!id) return null;
    const found = (await platform.people.list(companyId)).find((p) => p.id === id);
    return found ? { id: found.id, name: found.name } : null;
  };
  /** Whether the viewer decides a request: personal data, the data protection officer (IT when none); sharing, IT. */
  const decides = (viewer: Viewer, rules: BuildingRules, review: ReviewView) =>
    review.kind === "personal-data" ? decidesPersonalData(viewer, rules) : viewer.isAdmin;

  /** The rules as they apply to the viewer: where they may build, who decides. */
  app.get("/api/companies/:company/building", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const rules = rulesOf(company);
    const departments = await platform.catalog.departments(company.id);
    const people = await platform.people.list(company.id);
    return {
      who: rules.who,
      label: BUILDERS_LABELS[rules.who],
      builders: rules.builders.map((id) => people.find((p) => p.id === id)).flatMap((p) => (p ? [{ id: p.id, name: p.name }] : [])),
      dpo: await person(company.id, rules.dpo),
      buildsFor: buildsFor(viewer, rules, departments),
      decides: { personalData: decidesPersonalData(viewer, rules), sharing: viewer.isAdmin },
    };
  });

  /** IT sets who may build and names the data protection officer. */
  app.put("/api/companies/:company/building", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const body = z
      .object({ who: z.enum(BUILDERS).optional(), builders: z.array(z.string().uuid()).max(200).optional(), dpo: z.string().uuid().nullable().optional() })
      .parse(request.body);
    const people = new Set((await platform.people.list(company.id)).map((p) => p.id));
    for (const id of [...(body.builders ?? []), ...(body.dpo ? [body.dpo] : [])]) if (!people.has(id)) throw new HttpError(400, "Choose people of the company");
    const rules = { ...rulesOf(company), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    const settings = { ...company.settings, building: rules };
    await platform.handle.db.update(companies).set({ settings }).where(eq(companies.id, company.id));
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "settings.building",
      entityType: "company",
      entityId: company.id,
      summary: `Rules for building: ${BUILDERS_LABELS[rules.who as BuildingRules["who"]].toLowerCase()}${rules.dpo ? "; a data protection officer named" : ""}`,
    });
    return { ok: true };
  });

  /** Requests the viewer decides, and their own: waiting ones by default. */
  app.get("/api/companies/:company/reviews", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const rules = rulesOf(company);
    const { status } = z.object({ status: z.enum(["waiting", "approved", "declined", "withdrawn", "all"]).optional() }).parse(request.query ?? {});
    const all = await platform.reviews.list(company.id, status === "all" ? {} : { status: status ?? "waiting" });
    return all
      .filter((r) => decides(viewer, rules, r) || r.requestedBy === viewer.name || canSeeDepartment(viewer, r.departmentId))
      .map((r) => ({ ...r, canDecide: decides(viewer, rules, r) }));
  });

  for (const [path, approve] of [
    ["approve", true],
    ["decline", false],
  ] as const) {
    app.post(`/api/companies/:company/reviews/:id/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const viewer = viewerOf(request);
      const rules = rulesOf(company);
      const { id } = request.params as { id: string };
      const body = z.object({ note: z.string().trim().max(1000).optional() }).parse(request.body ?? {});
      const review = await platform.reviews.get(company.id, id);
      if (!decides(viewer, rules, review)) {
        throw new HttpError(
          403,
          review.kind === "personal-data" ? "The data protection officer decides on personal data" : "IT decides what is shared beyond a department",
        );
      }
      const decided = await platform.reviews.decide(company.id, id, { approve, by: viewer.name, ...(body.note ? { note: body.note } : {}) });
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: `review.${approve ? "approved" : "declined"}`,
        entityType: decided.itemType,
        entityId: decided.itemId,
        summary: `${viewer.name} ${approve ? "approved" : "declined"}: ${decided.what}${body.note ? ` (${body.note})` : ""}`,
      });
      return { ...decided, canDecide: false };
    });
  }

  /** Everything people built, with its owner, department, version and what waits: for IT. */
  app.get("/api/companies/:company/built", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const rules = rulesOf(company);
    const [tables, apps, calculations, agents, recurring, reviews] = await Promise.all([
      platform.tables.list(company.id, { archived: false }).then(async (live) => [...live, ...(await platform.tables.list(company.id, { archived: true }))]),
      platform.apps.list(company.id, { archived: false }).then(async (live) => [...live, ...(await platform.apps.list(company.id, { archived: true }))]),
      platform.calculations
        .list(company.id, { archived: false })
        .then(async (live) => [...live, ...(await platform.calculations.list(company.id, { archived: true }))]),
      platform.agents.list(company.id),
      platform.recurring.list(company.id),
      platform.reviews.list(company.id, { status: "waiting" }),
    ]);
    const people = await platform.people.list(company.id);
    const agentName = new Map(agents.map((a) => [a.row.id, a.definition.name]));
    const waiting = (id: string) => reviews.filter((r) => r.itemId === id).map((r) => r.what);
    const items = [
      ...tables.map((t) => ({
        type: "table" as const,
        id: t.id,
        key: t.key,
        name: t.name,
        departmentId: t.departmentId,
        owner: t.createdBy,
        version: t.version,
        updatedAt: t.updatedAt,
        archived: Boolean(t.archivedAt),
        shared: t.settings.visibility === "company" || !t.departmentId,
        personal: t.fields.filter((f) => f.personal).map((f) => ({ label: f.label, approved: t.personal.approved.includes(f.key) })),
        detail: `${t.records} record${t.records === 1 ? "" : "s"}`,
        waiting: waiting(t.id),
        link: `/tables/${t.key}`,
      })),
      ...apps.map((a) => ({
        type: "app" as const,
        id: a.id,
        key: a.key,
        name: a.name,
        departmentId: a.departmentId,
        owner: a.createdBy,
        version: a.version,
        updatedAt: a.updatedAt,
        archived: Boolean(a.archivedAt),
        shared: a.settings.visibility === "company" || !a.departmentId,
        personal: [],
        detail: `${a.pages.length} page${a.pages.length === 1 ? "" : "s"}`,
        waiting: waiting(a.id),
        link: `/apps/${a.key}`,
      })),
      ...calculations.map((c) => ({
        type: "calculation" as const,
        id: c.id,
        key: c.key,
        name: c.name,
        departmentId: c.departmentId,
        owner: c.createdBy,
        version: c.version,
        updatedAt: c.updatedAt,
        archived: Boolean(c.archivedAt),
        shared: !c.departmentId,
        personal: [],
        detail: c.schedule ? `Runs ${c.schedule}` : "Runs when someone asks",
        waiting: [],
        link: `/calculations/${c.key}`,
      })),
      ...agents.map((a) => ({
        type: "ai-employee" as const,
        id: a.row.id,
        key: a.row.slug,
        name: a.definition.name,
        departmentId: a.row.departmentId,
        owner: people.find((p) => p.id === a.row.managerUserId)?.name ?? "",
        version: a.row.version,
        updatedAt: a.row.updatedAt,
        archived: a.row.status === "archived",
        shared: !a.row.departmentId,
        personal: [],
        detail: a.row.status,
        waiting: [],
        link: `/ai/${a.row.slug}`,
      })),
      ...recurring.map((r) => ({
        type: "recurring" as const,
        id: r.id,
        key: r.id,
        name: r.text,
        departmentId: agents.find((a) => a.row.id === r.agentId)?.row.departmentId ?? null,
        owner: r.by,
        version: 1,
        updatedAt: r.createdAt,
        archived: false,
        shared: false,
        personal: [],
        detail: `${agentName.get(r.agentId) ?? "An AI employee"}, ${describeRepeat(r.schedule)}`,
        waiting: [],
        link: `/ai/${agents.find((a) => a.row.id === r.agentId)?.row.slug ?? ""}?tab=duties`,
      })),
    ];
    return {
      rules: { who: rules.who, dpo: await person(company.id, rules.dpo) },
      items: items.map((item) => ({
        ...item,
        changeable:
          item.type === "ai-employee" || item.type === "recurring"
            ? true
            : canChangeBuilt(viewer, { departmentId: item.departmentId, createdBy: item.owner }, rules),
      })),
      reviews: reviews.map((r) => ({ ...r, canDecide: decides(viewer, rules, r) })),
    };
  });
}
