import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { changeCalculation, writeCalculation } from "@enterprise-brain/builder";
import { buildingRulesOf, CALCULATION_SCHEDULES, CalculationOutput, type BuildingRules } from "@enterprise-brain/core";
import type { CalculationView } from "@enterprise-brain/runtime";
import { canBuildFor, canChangeBuilt, rulesOf } from "../auth/building.ts";
import { actorOf, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";
import { canSeeTable, notBuilding } from "./tables.ts";

/** Who sees a calculation and runs it: its department's people (everyone, for company-wide ones). */
export function canSeeCalculation(viewer: Viewer, calculation: Pick<CalculationView, "departmentId">): boolean {
  return canSeeDepartment(viewer, calculation.departmentId);
}

/**
 * Calculations: people say the rule; the Studio writes the code, tries it on the real rows and shows
 * the result; people keep it, run it or let it run by itself. The code is kept for IT, never shown to
 * people.
 */
export async function calculationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  const calculationFor = async (request: FastifyRequest, company: { id: string; settings: Record<string, unknown> }, ref: string, manage = false) => {
    const viewer = viewerOf(request);
    const found = await platform.calculations.get(company.id, ref).catch(() => undefined);
    if (!found || !canSeeCalculation(viewer, found)) throw new HttpError(404, `There is no calculation "${ref}"`);
    if (manage && !canChangeBuilt(viewer, found, rulesOf(company)))
      throw new HttpError(403, `Only a manager of its department (or whoever made it) changes ${found.name}`);
    return found;
  };
  const withRights = (viewer: Viewer, calculation: CalculationView, rules: BuildingRules = buildingRulesOf({})) => ({
    ...calculation,
    can: { run: true, design: canChangeBuilt(viewer, calculation, rules) },
  });

  app.get("/api/companies/:company/calculations", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { archived } = z.object({ archived: z.enum(["true", "false"]).optional() }).parse(request.query ?? {});
    const list = await platform.calculations.list(company.id, { archived: archived === "true" });
    return list.filter((c) => canSeeCalculation(viewer, c)).map((c) => withRights(viewer, c, rulesOf(company)));
  });

  /** The Studio writes the code for a rule and tries it on the real rows (nothing is kept yet). */
  app.post("/api/companies/:company/calculations/write", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z.object({ rule: z.string().trim().min(3).max(2000), tables: z.array(z.string()).max(10).optional() }).parse(request.body);
    const visible = (await platform.tables.list(company.id)).filter((t) => canSeeTable(viewer, t) && (!body.tables?.length || body.tables.includes(t.key)));
    if (!visible.length) throw new HttpError(400, "There is no table to calculate on yet");
    const samples = Object.fromEntries(
      await Promise.all(visible.map(async (t) => [t.key, (await platform.tables.rowsFor(company.id, t.key, 3)).slice(0, 3)] as const)),
    );
    const proposal = await writeCalculation(platform.llm, {
      rule: body.rule,
      tables: visible.map((t) => ({ key: t.key, name: t.name, fields: t.fields })),
      samples,
      trial: (draft) => platform.calculations.trial(company.id, { code: draft.code, tables: draft.tables, output: draft.output }),
    }).catch((error: unknown) => {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    });
    return proposal;
  });

  /** Keep a calculation (and run it once, so it has a result). */
  app.post("/api/companies/:company/calculations", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        rule: z.string().trim().min(3).max(2000),
        explanation: z.string().max(2000).optional(),
        tables: z.array(z.string()).min(1).max(10),
        code: z.string().min(1).max(20_000),
        output: CalculationOutput,
        schedule: z.enum(CALCULATION_SCHEDULES).nullable().optional(),
        departmentId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);
    if (!canBuildFor(viewer, body.departmentId, rulesOf(company))) throw new HttpError(403, notBuilding("calculations", body.departmentId, rulesOf(company)));
    for (const key of body.tables) {
      const table = await platform.tables.get(company.id, key).catch(() => undefined);
      if (!table || !canSeeTable(viewer, table)) throw new HttpError(400, `There is no table "${key}" to calculate on`);
    }
    const { schedule, ...rest } = body;
    const created = await platform.calculations.create(company.id, { ...rest, ...(schedule ? { schedule } : {}) }, actorOf(viewer));
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "calculation.created",
      entityType: "calculation",
      entityId: created.id,
      summary: `Kept the calculation ${created.name}`,
    });
    await platform.calculations.run(company.id, created.id, { by: actorOf(viewer) });
    return withRights(viewer, await platform.calculations.get(company.id, created.id), rulesOf(company));
  });

  /** A calculation with its recent runs; the code only for admins (IT). */
  app.get("/api/companies/:company/calculations/:calculation", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { calculation: ref } = request.params as { calculation: string };
    const found = await calculationFor(request, company, ref);
    return {
      calculation: withRights(viewer, found, rulesOf(company)),
      runs: await platform.calculations.runs(company.id, found.id, 20),
      ...(viewer.isAdmin ? { code: await platform.calculations.code(company.id, found.id) } : {}),
    };
  });

  app.patch("/api/companies/:company/calculations/:calculation", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { calculation: ref } = request.params as { calculation: string };
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        schedule: z.enum(CALCULATION_SCHEDULES).nullable().optional(),
        departmentId: z.string().uuid().nullable().optional(),
        // A rule written again by the Studio (its code tried on the real rows).
        rule: z.string().trim().min(3).max(2000).optional(),
        explanation: z.string().max(2000).optional(),
        tables: z.array(z.string()).min(1).max(10).optional(),
        code: z.string().min(1).max(20_000).optional(),
        output: CalculationOutput.optional(),
      })
      .parse(request.body);
    const found = await calculationFor(request, company, ref, true);
    if (body.departmentId !== undefined && body.departmentId !== found.departmentId && !canBuildFor(viewer, body.departmentId, rulesOf(company))) {
      throw new HttpError(403, "Only someone who builds for that department takes it over");
    }
    const changed = await platform.calculations.change(company.id, found.id, { ...body, by: viewer.name });
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "calculation.changed",
      entityType: "calculation",
      entityId: found.id,
      summary: `Changed the calculation ${changed.name}`,
      data: { changed: Object.keys(body) },
    });
    return withRights(viewer, changed, rulesOf(company));
  });

  /** Its versions, newest first: what each changed from the one before. */
  app.get("/api/companies/:company/calculations/:calculation/versions", async (request) => {
    const company = await companyOf(platform, request);
    const { calculation: ref } = request.params as { calculation: string };
    const found = await calculationFor(request, company, ref);
    const versions = await platform.versions.list(company.id, { type: "calculation", id: found.id });
    return versions.map((v, i) => {
      const previous = versions[i + 1]?.snapshot;
      const now = v.snapshot as { rule: string; code: string; name: string };
      const summary = !previous
        ? ["Made"]
        : [
            ...(previous.rule !== now.rule ? [`The rule: “${now.rule}”`] : []),
            ...(previous.rule === now.rule && previous.code !== now.code ? ["Worked out another way, by the same rule"] : []),
            ...(previous.name !== now.name ? [`Called ${now.name}`] : []),
          ];
      return { version: v.version, by: v.by, note: v.note, createdAt: v.createdAt, current: v.version === found.version, summary };
    });
  });

  /** Go back to an earlier version: a new version with its rule and code. */
  app.post("/api/companies/:company/calculations/:calculation/versions/:version/restore", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { calculation: ref, version } = request.params as { calculation: string; version: string };
    const found = await calculationFor(request, company, ref, true);
    const target = await platform.versions.get(company.id, { type: "calculation", id: found.id }, Number(version));
    if (!target) throw new HttpError(404, `${found.name} has no version ${version}`);
    if (target.version === found.version) throw new HttpError(400, `${found.name} is at version ${version} already`);
    const snapshot = target.snapshot as { name: string; rule: string; explanation: string; tables: string[]; code: string; output: CalculationOutput };
    const changed = await platform.calculations.change(company.id, found.id, {
      name: snapshot.name,
      rule: snapshot.rule,
      explanation: snapshot.explanation,
      tables: snapshot.tables,
      code: snapshot.code,
      output: snapshot.output,
      by: viewer.name,
      note: `Back to version ${target.version}`,
    });
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "calculation.restored",
      entityType: "calculation",
      entityId: found.id,
      summary: `${viewer.name} took ${found.name} back to version ${target.version}`,
    });
    return withRights(viewer, changed, rulesOf(company));
  });

  /** A change said in plain words: the rule as it becomes, worked out again on the real rows (nothing changes yet). */
  app.post("/api/companies/:company/calculations/:calculation/changes", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { calculation: ref } = request.params as { calculation: string };
    const body = z.object({ request: z.string().trim().min(3).max(2000) }).parse(request.body);
    const found = await calculationFor(request, company, ref, true);
    const visible = (await platform.tables.list(company.id)).filter((t) => canSeeTable(viewer, t));
    const samples = Object.fromEntries(await Promise.all(visible.map(async (t) => [t.key, await platform.tables.rowsFor(company.id, t.key, 3)] as const)));
    const proposal = await changeCalculation(platform.llm, {
      calculation: { rule: found.rule, code: await platform.calculations.code(company.id, found.id) },
      request: body.request,
      tables: visible.map((t) => ({ key: t.key, name: t.name, fields: t.fields })),
      samples,
      trial: (draft) => platform.calculations.trial(company.id, { code: draft.code, tables: draft.tables, output: draft.output }),
    }).catch((error: unknown) => {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    });
    return { ...proposal, before: found.last };
  });

  /** Run it now: its department's people. */
  app.post("/api/companies/:company/calculations/:calculation/run", async (request) => {
    const company = await companyOf(platform, request);
    const { calculation: ref } = request.params as { calculation: string };
    const found = await calculationFor(request, company, ref);
    return platform.calculations.run(company.id, found.id, { by: actorOf(viewerOf(request)) });
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post(`/api/companies/:company/calculations/:calculation/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const viewer = viewerOf(request);
      const { calculation: ref } = request.params as { calculation: string };
      const found = await calculationFor(request, company, ref, true);
      const done = await platform.calculations.archive(company.id, found.id, archived);
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: archived ? "calculation.archived" : "calculation.restored",
        entityType: "calculation",
        entityId: found.id,
        summary: `${archived ? "Archived" : "Brought back"} the calculation ${found.name}`,
      });
      return withRights(viewer, done, rulesOf(company));
    });
  }
}
