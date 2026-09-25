import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { OPEN_TASK_STATUSES } from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/**
 * Tasks: every piece of work an AI employee does, from start to finish. People see the tasks of the
 * AI employees they can see; managers pause, resume and stop them; anyone can give their AI employees work.
 */
export async function taskRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** A task the viewer may see through its AI employee's department (404 otherwise), or manage (403). */
  const taskFor = async (request: FastifyRequest, companyId: string, ref: string, manage = false) => {
    const task = await platform.tasks.get(companyId, ref);
    const agent = await platform.agents.get(companyId, task.agentId);
    const viewer = viewerOf(request);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Task ${ref} not found`);
    if (manage && !canManageDepartment(viewer, agent.row.departmentId)) throw new HttpError(403, "Only a manager of this AI employee's department can do this");
    return { task, agent };
  };

  app.get("/api/companies/:company/tasks", async (request) => {
    const company = await companyOf(platform, request);
    const query = z.object({ status: z.string().optional(), agent: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query);
    const viewer = viewerOf(request);
    const agents = (await platform.agents.list(company.id)).filter((a) => canSeeDepartment(viewer, a.row.departmentId));
    const chosen = query.agent ? agents.filter((a) => a.row.slug === query.agent || a.row.id === query.agent) : agents;
    const statuses = query.status === "open" ? OPEN_TASK_STATUSES : query.status ? query.status.split(",") : undefined;
    const rows = await platform.tasks.list(company.id, { statuses, agentIds: chosen.map((a) => a.row.id), limit: query.limit });
    const byId = new Map(agents.map((a) => [a.row.id, a]));
    return rows.map((task) => {
      const agent = byId.get(task.agentId);
      return { ...task, plan: undefined, agent: agent ? { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name, departmentId: agent.row.departmentId } : null };
    });
  });

  app.get("/api/companies/:company/tasks/:task", async (request) => {
    const company = await companyOf(platform, request);
    const { task: ref } = request.params as { task: string };
    const { task, agent } = await taskFor(request, company.id, ref);
    const [events, runs, mails, approvals] = await Promise.all([
      platform.tasks.events(task.id),
      platform.tasks.runsOf(task.id),
      platform.tasks.mailsOf(task.id),
      platform.tasks.approvalsOf(task.id),
    ]);
    return {
      task,
      agent: { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name, departmentId: agent.row.departmentId, status: agent.row.status },
      events,
      runs: runs.map((r) => ({ ...r, context: undefined })),
      mails: mails.map((m) => ({ id: m.id, direction: m.direction, from: m.fromAddress, to: m.toAddresses, subject: m.subject, body: m.bodyText, receivedAt: m.receivedAt })),
      approvals,
      canManage: canManageDepartment(viewerOf(request), agent.row.departmentId),
    };
  });

  /** Give an AI employee work in plain words: it becomes a task. */
  app.post("/api/companies/:company/tasks", async (request) => {
    const company = await companyOf(platform, request);
    const body = z.object({ agent: z.string(), text: z.string().min(3), wait: z.boolean().optional() }).parse(request.body);
    const viewer = viewerOf(request);
    const agent = await platform.agents.get(company.id, body.agent);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${body.agent}" not found`);
    const run = await platform.engine.start(company.id, agent.row.id, {}, {
      task: body.text,
      trigger: "request",
      actor: actorOf(viewer),
      requestedBy: viewer.kind === "session" ? viewer.name : null,
      wait: body.wait ?? false,
    });
    return { task: await platform.tasks.get(company.id, run.taskId!), run: { ...run, context: undefined } };
  });

  app.post("/api/companies/:company/tasks/:task/retry", async (request) => {
    const company = await companyOf(platform, request);
    const { task: ref } = request.params as { task: string };
    const { task } = await taskFor(request, company.id, ref, true);
    return platform.engine.retryTask(company.id, task.id, viewerOf(request).name, { wait: false });
  });

  for (const action of ["pause", "resume", "stop"] as const) {
    app.post(`/api/companies/:company/tasks/:task/${action}`, async (request) => {
      const company = await companyOf(platform, request);
      const { task: ref } = request.params as { task: string };
      const { task } = await taskFor(request, company.id, ref, true);
      const by = viewerOf(request).name;
      const engine = platform.engine;
      const updated =
        action === "pause" ? await engine.pauseTask(company.id, task.id, by) : action === "resume" ? await engine.resumeTask(company.id, task.id, by, { wait: false }) : await engine.stopTask(company.id, task.id, by);
      await platform.activity.record(company.id, { actor: actorOf(viewerOf(request)), action: `task.${action}`, entityType: "task", entityId: task.id, summary: `${by} ${action === "stop" ? "stopped" : `${action}d`} ${task.ref}: ${task.title}` });
      return updated;
    });
  }
}
