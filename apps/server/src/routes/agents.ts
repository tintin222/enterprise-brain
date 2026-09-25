import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentStatus, Probation, TrustLimits, type AgentDefinition } from "@enterprise-brain/core";
import { actorOf, canManageDepartment, canSeeDepartment, requireAdmin, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart, sse } from "../http.ts";

function inputFromMultipart(
  definition: AgentDefinition,
  fields: Record<string, string>,
  files: { field: string; id: string }[],
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of definition.inputs) {
    const uploaded = files.filter((f) => f.field === field.key).map((f) => f.id);
    if (field.type === "file" && uploaded.length) input[field.key] = uploaded[0];
    else if (field.type === "files" && uploaded.length) input[field.key] = uploaded;
    else if (fields[field.key] !== undefined && fields[field.key] !== "") {
      const raw = fields[field.key]!;
      if (field.type === "number" || field.type === "integer") input[field.key] = Number(raw);
      else if (field.type === "boolean") input[field.key] = raw === "true" || raw === "on";
      else if (field.type === "multiselect" || field.type === "list") input[field.key] = raw.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
      else if (field.type === "object") {
        try {
          input[field.key] = JSON.parse(raw);
        } catch {
          input[field.key] = raw;
        }
      } else input[field.key] = raw;
    }
  }
  if (fields.input) {
    try {
      Object.assign(input, JSON.parse(fields.input));
    } catch {
      // ignore malformed extra input
    }
  }
  return input;
}

/** Events after which a live run stream ends, and the run status they leave behind. */
const RUN_STATUS_AFTER: Record<string, string> = {
  "run.succeeded": "succeeded",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "approval.requested": "waiting_approval",
};

export async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** An AI employee the viewer may see (404 otherwise), or manage (403 otherwise). */
  const agentFor = async (request: FastifyRequest, companyId: string, ref: string, manage = false) => {
    const agent = await platform.agents.get(companyId, ref);
    const viewer = viewerOf(request);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${ref}" not found`);
    if (manage && !canManageDepartment(viewer, agent.row.departmentId)) throw new HttpError(403, "Only a manager of this department can change this AI employee");
    return agent;
  };
  /** The AI employees the viewer may see, by id. */
  const visibleAgents = async (request: FastifyRequest, companyId: string) => {
    const viewer = viewerOf(request);
    const list = await platform.agents.list(companyId);
    return new Map(list.filter((a) => canSeeDepartment(viewer, a.row.departmentId)).map((a) => [a.row.id, a]));
  };

  app.get("/api/companies/:company/agents", async (request) => {
    const company = await companyOf(platform, request);
    const { status } = z.object({ status: z.string().optional() }).parse(request.query);
    const viewer = viewerOf(request);
    const list = (await platform.agents.list(company.id, { status })).filter((a) => canSeeDepartment(viewer, a.row.departmentId));
    return list.map((a) => ({
      ...a.row,
      definition: undefined,
      title: a.definition.title,
      department: a.definition.department,
      triggers: a.definition.triggers,
      ui: a.definition.ui,
      steps: a.definition.workflow.length,
    }));
  });

  app.post("/api/companies/:company/agents", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const body = z.object({ definition: z.record(z.string(), z.unknown()), status: AgentStatus.optional() }).parse(request.body);
    const agent = await platform.agents.create(company.id, { definition: body.definition as never, status: body.status, source: "manual", createdBy: actorOf(viewer) });
    await platform.employment.assignDefaultManagers(company.id, { by: viewer.userId, agentIds: [agent.row.id] });
    return (await platform.agents.get(company.id, agent.row.id)).row;
  });

  app.get("/api/companies/:company/agents/:agent", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await agentFor(request, company.id, ref);
    const canManage = canManageDepartment(viewerOf(request), agent.row.departmentId);
    const [versions, recentRuns, employment, managers] = await Promise.all([
      platform.agents.versions(company.id, ref),
      platform.engine.list(company.id, { agentId: agent.row.id, limit: 20 }),
      platform.employment.view(company.id, agent),
      canManage ? platform.employment.candidates(company.id, agent) : Promise.resolve([]),
    ]);
    return {
      agent: agent.row,
      definition: agent.definition,
      versions: versions.map((v) => ({ version: v.version, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt })),
      recentRuns: recentRuns.map((r) => ({ ...r, context: undefined })),
      employment,
      canManage,
      /** Who may be its manager (for those who may change it). */
      managerCandidates: managers.map((p) => ({ id: p.id, name: p.name, title: p.title })),
    };
  });

  app.put("/api/companies/:company/agents/:agent", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const body = z.object({ definition: z.record(z.string(), z.unknown()), note: z.string().optional() }).parse(request.body);
    await agentFor(request, company.id, ref, true);
    const agent = await platform.agents.update(company.id, ref, body.definition as never, { note: body.note, createdBy: "user" });
    await platform.activity.record(company.id, { actor: "user", action: "agent.updated", entityType: "agent", entityId: agent.row.id, summary: `Updated ${agent.definition.name} (v${agent.row.version})` });
    return { agent: agent.row, definition: agent.definition };
  });

  app.post("/api/companies/:company/agents/:agent/status", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const { status } = z.object({ status: AgentStatus }).parse(request.body);
    await agentFor(request, company.id, ref, true);
    const agent = await platform.agents.setStatus(company.id, ref, status);
    await platform.activity.record(company.id, { actor: "user", action: `agent.${status}`, entityType: "agent", entityId: agent.row.id, summary: `${agent.definition.name} → ${status}` });
    return agent.row;
  });

  /** Its manager, probation level, limits and monthly budget: set by a manager of its department. */
  app.put("/api/companies/:company/agents/:agent/employment", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const body = z
      .object({
        managerUserId: z.string().uuid().nullable().optional(),
        probation: Probation.optional(),
        limits: TrustLimits.optional(),
        monthlyBudgetUsd: z.number().min(0).nullable().optional(),
      })
      .parse(request.body);
    await agentFor(request, company.id, ref, true);
    const agent = await platform.employment.update(company.id, ref, body, actorOf(viewerOf(request)));
    return { agent: agent.row, employment: await platform.employment.view(company.id, agent) };
  });

  app.post("/api/companies/:company/agents/:agent/rollback", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);
    await agentFor(request, company.id, ref, true);
    const agent = await platform.agents.rollback(company.id, ref, version);
    return { agent: agent.row, definition: agent.definition };
  });

  app.delete("/api/companies/:company/agents/:agent", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    await agentFor(request, company.id, ref, true);
    await platform.agents.remove(company.id, ref);
    return { ok: true };
  });

  /** Start a run. JSON {input, wait, test} or multipart (file fields + text fields). */
  app.post("/api/companies/:company/agents/:agent/runs", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await agentFor(request, company.id, ref);
    let input: Record<string, unknown>;
    let wait = true;
    let isTest = false;
    let trigger = "manual";
    let task: string | undefined;
    if (request.isMultipart()) {
      const { fields, files } = await readMultipart(platform, company.id, request);
      input = inputFromMultipart(agent.definition, fields, files);
      wait = fields.wait !== "false";
      isTest = fields.test === "true";
      trigger = fields.trigger || "form";
    } else {
      const body = z
        .object({
          input: z.record(z.string(), z.unknown()).default({}),
          task: z.string().optional(),
          wait: z.boolean().default(true),
          test: z.boolean().default(false),
          trigger: z.string().optional(),
        })
        .parse(request.body ?? {});
      input = body.input;
      task = body.task;
      wait = body.wait;
      isTest = body.test;
      trigger = body.trigger ?? "manual";
    }
    const run = await platform.engine.start(company.id, agent.row.id, input, { trigger, isTest, wait, task, actor: "user" });
    return { ...run, context: undefined };
  });

  app.get("/api/companies/:company/runs", async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({ agent: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().positive().max(200).default(50) })
      .parse(request.query);
    const agentId = query.agent ? (await agentFor(request, company.id, query.agent)).row.id : undefined;
    const visible = await visibleAgents(request, company.id);
    const list = (await platform.engine.list(company.id, { agentId, status: query.status as never, limit: query.limit })).filter((r) => visible.has(r.agentId));
    return list.map((r) => ({ ...r, context: undefined, agentName: visible.get(r.agentId)?.row.name, agentSlug: visible.get(r.agentId)?.row.slug }));
  });

  app.get("/api/companies/:company/runs/:run", async (request) => {
    const company = await companyOf(platform, request);
    const { run: runId } = request.params as { run: string };
    const detail = await platform.engine.get(company.id, runId);
    const agent = await agentFor(request, company.id, detail.run.agentId);
    return { ...detail, agent: agent ? { id: agent.row.id, slug: agent.row.slug, name: agent.row.name, outputs: agent.definition.outputs, ui: agent.definition.ui } : null };
  });

  app.post("/api/companies/:company/runs/:run/cancel", async (request) => {
    const company = await companyOf(platform, request);
    const { run: runId } = request.params as { run: string };
    const run = await platform.engine.getRow(company.id, runId);
    await agentFor(request, company.id, run.agentId);
    return platform.engine.cancel(company.id, runId);
  });

  /** Live run events (SSE). */
  app.get("/api/companies/:company/runs/:run/stream", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { run: runId } = request.params as { run: string };
    const detail = await platform.engine.get(company.id, runId);
    await agentFor(request, company.id, detail.run.agentId);
    const stream = sse(reply);
    for (const event of detail.events) stream.send("event", event);
    if (!["running"].includes(detail.run.status)) {
      stream.send("end", { status: detail.run.status });
      stream.close();
      return;
    }
    const unsubscribe = platform.engine.subscribe(
      runId,
      (event) => {
        stream.send("event", event);
        // `end` always carries the run's status, whether the run finished live or before the client connected.
        const status = RUN_STATUS_AFTER[event.type];
        if (status) {
          stream.send("end", { status });
          stream.close();
        }
      },
      (delta) => stream.send("delta", { delta }),
    );
    stream.onClose(unsubscribe);
  });

  app.get("/api/companies/:company/approvals", async (request) => {
    const company = await companyOf(platform, request);
    const { status } = z.object({ status: z.string().optional() }).parse(request.query);
    const visible = await visibleAgents(request, company.id);
    const list = (await platform.engine.listApprovals(company.id, { status })).filter((a) => visible.has(a.agentId));
    return list.map((a) => ({ ...a, agentName: visible.get(a.agentId)?.row.name ?? "Agent" }));
  });

  app.post("/api/companies/:company/approvals/:approval/decide", async (request) => {
    const company = await companyOf(platform, request);
    const { approval } = request.params as { approval: string };
    const body = z.object({ approved: z.boolean(), note: z.string().optional(), decidedBy: z.string().optional(), wait: z.boolean().default(true) }).parse(request.body);
    const viewer = viewerOf(request);
    const pending = (await platform.engine.listApprovals(company.id)).find((a) => a.id === approval);
    if (pending) await agentFor(request, company.id, pending.agentId);
    const decidedBy = viewer.kind === "session" ? viewer.name : (body.decidedBy ?? "user");
    return platform.engine.decide(company.id, approval, { approved: body.approved, note: body.note, decidedBy }, { wait: body.wait });
  });

  app.post("/api/companies/:company/files", async (request) => {
    const company = await companyOf(platform, request);
    if (!request.isMultipart()) throw new HttpError(400, "Upload files as multipart/form-data");
    const { files } = await readMultipart(platform, company.id, request);
    return files;
  });

  app.get("/api/companies/:company/files", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    return platform.files.list(company.id);
  });

  app.get("/api/companies/:company/files/:file", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { file: fileId } = request.params as { file: string };
    const file = await platform.files.get(company.id, fileId);
    const inline = (request.query as { inline?: string }).inline === "1";
    reply
      .header("content-type", file.mimeType)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.send(file.data);
  });

  app.get("/api/companies/:company/files/:file/meta", async (request) => {
    const company = await companyOf(platform, request);
    const { file: fileId } = request.params as { file: string };
    return platform.files.meta(company.id, fileId);
  });
}
