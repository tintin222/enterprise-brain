import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import JSZip from "jszip";
import { z } from "zod";
import { approvals, runs } from "@enterprise-brain/db";
import { hermesRunBody, parseHermesRunRequest, toHermesStatus, type EbRunSnapshot } from "@enterprise-brain/paperclip";
import type { AppContext } from "../context.ts";
import { HttpError, bearer, companyOf, sse } from "../http.ts";
import { PaperclipBridge } from "../paperclip-bridge.ts";
import { PaperclipConnector } from "../paperclip-connect.ts";
import { buildPackage, packageModel, pushCompany } from "../paperclip-package.ts";

export async function paperclipRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, config } = ctx;
  const bridge = new PaperclipBridge(platform, config);
  const stopBridge = bridge.start();
  // EB_PAPERCLIP_AUTOCONNECT: connect once the server listens (Paperclip calls back into it).
  const connector = new PaperclipConnector(ctx, bridge);
  let stopConnector = () => {};
  app.addHook("onListen", async () => {
    stopConnector = connector.start();
  });
  app.addHook("onClose", async () => {
    stopBridge();
    stopConnector();
  });
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
    const result = await pushCompany(ctx, bridge, company, {
      url,
      apiKey: body.paperclipApiKey,
      target: body.target,
      paperclipCompanyId: body.paperclipCompanyId,
      departments: body.departments,
    });
    return { ok: true, summary: result.summary, warnings: result.warnings, agentKeys: result.agentKeys, paperclip: result.paperclip };
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
      autoConnect: connector.status(),
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
