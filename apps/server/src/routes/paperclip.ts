import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import JSZip from "jszip";
import { z } from "zod";
import type { DepartmentTemplate, ProcessTemplate } from "@enterprise-brain/core";
import { approvals, runs } from "@enterprise-brain/db";
import {
  PaperclipClient,
  exportCompanyPackage,
  hermesRunBody,
  parseHermesRunRequest,
  toHermesStatus,
  type EbRunSnapshot,
  type ExportAgent,
  type ExportDepartment,
  type ExportProcess,
} from "@enterprise-brain/paperclip";
import type { CompanyRow } from "@enterprise-brain/runtime";
import type { AppContext } from "../context.ts";
import { HttpError, bearer, companyOf, sse } from "../http.ts";
import { PaperclipBridge } from "../paperclip-bridge.ts";

type Model = { departments: ExportDepartment[]; processes: ExportProcess[]; agents: ExportAgent[] };

async function packageModel(ctx: AppContext, company: CompanyRow, scope: "installed" | "catalog", only?: string[]): Promise<Model> {
  const { platform } = ctx;
  const keep = (dept: string | undefined) => !only?.length || (dept !== undefined && only.includes(dept));
  if (scope === "catalog") {
    const c = platform.catalog.catalog;
    return {
      departments: c.departments.filter((d) => keep(d.id)),
      processes: c.processes.filter((p) => keep(p.department)),
      agents: c.agents.filter((a) => keep(a.department)).map((a) => ({ ...a, id: a.id })),
    };
  }
  const [departmentRows, processRows, agentRecords] = await Promise.all([
    platform.catalog.departments(company.id),
    platform.catalog.processes(company.id),
    platform.agents.list(company.id),
  ]);
  const deptKeyById = new Map(departmentRows.map((d) => [d.id, d.key]));
  return {
    departments: departmentRows
      .filter((d) => keep(d.key))
      .map((d) => {
        const data = d.data as unknown as Partial<DepartmentTemplate>;
        return { id: d.key, name: d.name, summary: d.summary, mission: data.mission, kpis: data.kpis };
      }),
    processes: processRows
      .map((p) => ({ row: p, data: p.data as unknown as ProcessTemplate }))
      .filter(({ row }) => keep(deptKeyById.get(row.departmentId ?? "")))
      .map(({ row, data }) => ({
        id: row.key,
        department: deptKeyById.get(row.departmentId ?? "") ?? data.department,
        name: row.name,
        summary: row.summary,
        description: data.description,
        trigger: data.trigger,
        frequency: data.frequency,
        steps: data.steps ?? [],
        agents: data.agents ?? [],
        kpis: data.kpis,
      })),
    agents: agentRecords
      .filter((a) => a.row.status !== "archived")
      .map((a) => ({
        id: a.row.templateId ?? a.row.slug,
        slug: a.row.slug,
        name: a.definition.name,
        title: a.definition.title,
        department: (a.row.departmentId ? deptKeyById.get(a.row.departmentId) : undefined) ?? a.definition.department,
        process: a.definition.process,
        summary: a.definition.summary,
        instructions: a.definition.instructions,
        archetype: a.definition.archetype,
        triggers: a.definition.triggers,
      }))
      .filter((a) => keep(a.department)),
  };
}

function buildPackage(ctx: AppContext, company: CompanyRow, model: Model, includeCeo: boolean) {
  return exportCompanyPackage(model, {
    company: { name: company.name, slug: company.slug },
    enterpriseBrain: { url: ctx.config.publicUrl, companySlug: company.slug },
    includeCeo,
  });
}

export async function paperclipRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, config } = ctx;
  const bridge = new PaperclipBridge(platform, config);
  const stopBridge = bridge.start();
  app.addHook("onClose", async () => stopBridge());
  const PackageQuery = z.object({
    scope: z.enum(["installed", "catalog"]).default("installed"),
    departments: z.string().optional(),
    ceo: z.enum(["true", "false"]).default("true"),
  });

  app.get("/api/companies/:company/paperclip/package", async (request) => {
    const company = await companyOf(platform, request);
    const q = PackageQuery.parse(request.query);
    const model = await packageModel(ctx, company, q.scope, q.departments?.split(",").filter(Boolean));
    return buildPackage(ctx, company, model, q.ceo === "true");
  });

  app.get("/api/companies/:company/paperclip/package.zip", async (request, reply) => {
    const company = await companyOf(platform, request);
    const q = PackageQuery.parse(request.query);
    const model = await packageModel(ctx, company, q.scope, q.departments?.split(",").filter(Boolean));
    const result = buildPackage(ctx, company, model, q.ceo === "true");
    const zip = new JSZip();
    const root = zip.folder(company.slug)!;
    for (const [path, content] of Object.entries(result.files)) root.file(path, content);
    const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${company.slug}-paperclip.zip"`);
    return reply.send(data);
  });

  /** Import the package into a Paperclip instance, wiring the hermes_gateway API key via adapterOverrides. */
  app.post("/api/companies/:company/paperclip/push", async (request) => {
    const company = await companyOf(platform, request);
    const body = z
      .object({
        paperclipUrl: z.string().url().optional(),
        paperclipApiKey: z.string().optional(),
        target: z.enum(["new_company", "existing_company"]).default("new_company"),
        paperclipCompanyId: z.string().optional(),
        departments: z.array(z.string()).optional(),
      })
      .parse(request.body ?? {});
    const url = body.paperclipUrl ?? config.paperclip?.url;
    if (!url) throw new HttpError(400, "Set PAPERCLIP_URL (or pass paperclipUrl) to push to Paperclip");
    if (!config.hermesApiKey) throw new HttpError(400, "Enterprise Brain has no Hermes gateway key: set EB_HERMES_API_KEY to a long random secret (Paperclip sends it to Enterprise Brain)");
    if (body.target === "existing_company" && !body.paperclipCompanyId) throw new HttpError(400, "paperclipCompanyId is required for existing_company");
    const model = await packageModel(ctx, company, "installed", body.departments);
    const result = buildPackage(ctx, company, model, body.target === "new_company");
    const hermesBase = `${config.publicUrl}/api/hermes`;
    const adapterOverrides = Object.fromEntries(
      result.specialists.map(({ paperclipSlug, ebSlug }) => [
        paperclipSlug,
        {
          adapterType: "hermes_gateway",
          adapterConfig: {
            apiBaseUrl: hermesBase,
            apiKey: config.hermesApiKey,
            sessionKeyStrategy: "issue",
            timeoutSec: 900,
            payloadTemplate: { agent: ebSlug, company: company.slug },
          },
        },
      ]),
    );
    const client = new PaperclipClient(url, body.paperclipApiKey ?? config.paperclip?.apiKey);
    const response = (await client.importCompany({
      files: result.files,
      rootPath: company.slug,
      target: body.target === "new_company" ? { mode: "new_company" } : { mode: "existing_company", companyId: body.paperclipCompanyId! },
      adapterOverrides,
    })) as { company?: { id?: string }; agents?: { slug?: string; id?: string | null }[] } | null;
    // Each Enterprise Brain agent gets its own Paperclip API key, so it can close its issues like any employee.
    const imported = new Map((response?.agents ?? []).filter((a) => a.slug && a.id).map((a) => [a.slug!, a.id!]));
    const keys: { paperclipAgentId: string; slug: string; token: string }[] = [];
    const keyWarnings: string[] = [];
    for (const { paperclipSlug, ebSlug } of result.specialists) {
      const paperclipAgentId = imported.get(paperclipSlug);
      if (!paperclipAgentId) continue;
      try {
        const { token } = await client.createAgentKey(paperclipAgentId, "enterprise-brain");
        keys.push({ paperclipAgentId, slug: ebSlug, token });
      } catch (error) {
        keyWarnings.push(`No Paperclip key for ${paperclipSlug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await bridge.remember(company.id, {
      url,
      companyId: response?.company?.id ?? (body.target === "existing_company" ? body.paperclipCompanyId : undefined),
      boardKey: body.paperclipApiKey,
      agents: keys,
    });
    await platform.activity.record(company.id, {
      actor: "user",
      action: "paperclip.pushed",
      entityType: "company",
      entityId: company.id,
      summary: `Pushed ${result.summary.agents} agents to Paperclip (${url})`,
    });
    return { ok: true, summary: result.summary, warnings: [...result.warnings, ...keyWarnings], agentKeys: keys.length, paperclip: response };
  });

  /** What Paperclip needs to call Enterprise Brain, and what is known about the linked Paperclip company. */
  app.get("/api/companies/:company/paperclip/connection", async (request) => {
    const company = await companyOf(platform, request);
    const link = await bridge.link(company.id);
    return {
      hermes: { apiBaseUrl: `${config.publicUrl}/api/hermes`, apiKey: config.hermesApiKey ?? null, keySource: config.hermesApiKeySource ?? null },
      paperclip: {
        url: link?.url ?? config.paperclip?.url ?? null,
        configured: Boolean(config.paperclip?.url),
        companyId: link?.companyId ?? null,
        agentsWithKeys: Object.keys(link?.agents ?? {}).length,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Hermes gateway: Paperclip's hermes_gateway adapter runs our agents here.
  // -------------------------------------------------------------------------

  const authorize = (request: FastifyRequest) => {
    if (!config.hermesApiKey) return;
    if (bearer(request) !== config.hermesApiKey) throw new HttpError(401, "Invalid Hermes API key");
  };

  const snapshot = async (runId: string): Promise<{ snap: EbRunSnapshot; companyId: string }> => {
    const [run] = await platform.handle.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw new HttpError(404, `Run ${runId} not found`);
    const [pending] = await platform.handle.db
      .select({ id: approvals.id, title: approvals.title })
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
    return {
      companyId: run.companyId,
      snap: {
        id: run.id,
        status: run.status,
        output: run.output ?? null,
        error: run.error,
        usage: run.usage,
        pendingApproval: pending ?? null,
        approvalsUrl: `${config.publicUrl}/approvals`,
        model: platform.llm.model,
      },
    };
  };

  app.get("/api/hermes/health", async (request) => {
    authorize(request);
    return { ok: true, name: "Enterprise Brain", llm: platform.llm.available };
  });

  app.post("/api/hermes/v1/runs", async (request) => {
    authorize(request);
    const hermes = parseHermesRunRequest(request.body, request.headers);
    const company = await platform.company(hermes.company ?? config.defaultCompany.slug);
    if (!company) throw new HttpError(404, `Company "${hermes.company}" not found in Enterprise Brain`);
    if (hermes.idempotencyKey) {
      const [existing] = await platform.handle.db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(and(eq(runs.companyId, company.id), eq(runs.trigger, "paperclip"), eq(runs.triggerRef, hermes.idempotencyKey)));
      if (existing) return { run_id: existing.id, status: toHermesStatus({ id: existing.id, status: existing.status, output: null, error: null, usage: {} }) };
    }
    const brief = await bridge.taskBrief(company.id, hermes.paperclip);
    const run = await platform.engine.start(
      company.id,
      hermes.agent,
      { paperclip: hermes.paperclip },
      { trigger: "paperclip", triggerRef: hermes.idempotencyKey ?? hermes.paperclip.runId ?? null, wait: false, task: brief ?? hermes.input, actor: "paperclip" },
    );
    return { run_id: run.id, status: "running" };
  });

  app.get("/api/hermes/v1/runs/:id", async (request) => {
    authorize(request);
    const { id } = request.params as { id: string };
    let { snap } = await snapshot(id);
    if (toHermesStatus(snap) !== "running" && toHermesStatus(snap) !== "queued") {
      await bridge.settleDuringRun(id);
      ({ snap } = await snapshot(id));
    }
    return hermesRunBody(snap);
  });

  app.get("/api/hermes/v1/runs/:id/events", async (request, reply) => {
    authorize(request);
    const { id } = request.params as { id: string };
    const { snap } = await snapshot(id);
    const stream = sse(reply);
    const finish = async () => {
      // The issue gets its disposition while the Paperclip run is still open.
      await bridge.settleDuringRun(id);
      const { snap: final } = await snapshot(id);
      const body = hermesRunBody(final);
      stream.send(`run.${body.status}`, body);
      stream.close();
    };
    if (toHermesStatus(snap) !== "running" && toHermesStatus(snap) !== "queued") {
      await finish();
      return;
    }
    const unsubscribe = platform.engine.subscribe(
      id,
      (event) => {
        stream.send("run.progress", { type: event.type, message: event.message });
        // A workflow pause ends the Paperclip run; a deferred approval (task mode) doesn't stop the run.
        const pause = event.type === "approval.requested" && !(event.data as { deferred?: boolean } | undefined)?.deferred;
        if (pause || ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type)) void finish();
      },
      (delta) => stream.send("message.delta", { delta }),
    );
    stream.onClose(unsubscribe);
  });

  app.post("/api/hermes/v1/runs/:id/stop", async (request) => {
    authorize(request);
    const { id } = request.params as { id: string };
    const { companyId } = await snapshot(id);
    await platform.engine.cancel(companyId, id);
    const { snap } = await snapshot(id);
    return hermesRunBody(snap);
  });
}
