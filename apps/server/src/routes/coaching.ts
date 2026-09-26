import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentRecord } from "@enterprise-brain/runtime";
import { canHandleWork, canManageDepartment, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/** May the viewer mark this AI employee's finished work as wrong? Its department's people, whoever asked for it, admins. */
export function canCorrect(viewer: Viewer, agent: AgentRecord, requestedBy: string | null): boolean {
  if (canHandleWork(viewer, agent.row.departmentId)) return true;
  return viewer.kind === "session" && !!requestedBy && [viewer.name, viewer.email].includes(requestedBy);
}

/**
 * Coaching: people mark finished tasks as wrong and say why; the Studio turns their corrections into
 * rules, replays recent tasks with them, and the AI employee's manager publishes the new version or
 * keeps the old one.
 */
export async function coachingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, builder } = ctx;
  const coach = builder.coach;

  /** An AI employee the viewer may see (404 otherwise), or manage (403 otherwise). */
  const agentFor = async (request: FastifyRequest, agent: AgentRecord, manage = false) => {
    const viewer = viewerOf(request);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${agent.row.slug}" not found`);
    if (manage && !canManageDepartment(viewer, agent.row.departmentId))
      throw new HttpError(403, "Only a manager of this AI employee's department can decide on its coaching");
    return agent;
  };

  /** Mark a finished task as wrong, in plain words: a correction for its AI employee's next version. */
  app.post("/api/companies/:company/tasks/:task/correct", async (request) => {
    const company = await companyOf(platform, request);
    const { task: ref } = request.params as { task: string };
    const body = z.object({ note: z.string().max(4000) }).parse(request.body);
    const task = await platform.tasks.get(company.id, ref);
    const agent = await agentFor(request, await platform.agents.get(company.id, task.agentId)).catch(() => {
      throw new HttpError(404, `Task ${ref} not found`);
    });
    const viewer = viewerOf(request);
    if (!canCorrect(viewer, agent, task.requestedBy))
      throw new HttpError(403, "Only people of this AI employee's department, or who asked for the task, can mark it as wrong");
    const note = await coach.correctTask(company.id, task.id, { note: body.note, by: viewer.name });
    return { note };
  });

  app.get("/api/companies/:company/agents/:agent/coaching", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await agentFor(request, await platform.agents.get(company.id, ref));
    return { ...(await coach.overview(company.id, agent.row.id)), canDecide: canManageDepartment(viewerOf(request), agent.row.departmentId) };
  });

  /** Turn open corrections into rules and replay recent tasks with them (in the background unless `wait`). */
  app.post("/api/companies/:company/agents/:agent/coaching/proposals", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const body = z
      .object({ noteIds: z.array(z.string().uuid()).max(50).optional(), limit: z.number().int().min(1).max(20).optional(), wait: z.boolean().optional() })
      .parse(request.body ?? {});
    const agent = await agentFor(request, await platform.agents.get(company.id, ref), true);
    return coach.propose(company.id, agent.row.id, { ...body, by: viewerOf(request).name });
  });

  /**
   * A change asked for in plain words ("reply in Turkish when the customer writes in Turkish"): the
   * Studio turns it into rules and a new version of the job, and replays recent tasks with it, as
   * coaching does. Nothing goes live until its manager publishes it.
   */
  app.post("/api/companies/:company/agents/:agent/changes", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const body = z
      .object({ request: z.string().trim().min(3).max(2000), limit: z.number().int().min(1).max(20).optional(), wait: z.boolean().optional() })
      .parse(request.body);
    const agent = await agentFor(request, await platform.agents.get(company.id, ref), true);
    const by = viewerOf(request).name;
    const note = await platform.coachingNotes.record(company.id, {
      agentId: agent.row.id,
      kind: "change",
      note: body.request,
      by,
      summary: `${by} asked for a change to ${agent.definition.name}: ${body.request}`,
    });
    return coach.propose(company.id, agent.row.id, {
      by,
      noteIds: [note.id],
      ...(body.limit ? { limit: body.limit } : {}),
      ...(body.wait ? { wait: true } : {}),
    });
  });

  app.get("/api/companies/:company/coaching/proposals/:proposal", async (request) => {
    const company = await companyOf(platform, request);
    const { proposal: id } = request.params as { proposal: string };
    const agent = await agentFor(request, await coach.agentOf(company.id, id));
    return { ...(await coach.proposal(company.id, id)), canDecide: canManageDepartment(viewerOf(request), agent.row.departmentId) };
  });

  for (const decision of ["publish", "keep"] as const) {
    app.post(`/api/companies/:company/coaching/proposals/:proposal/${decision}`, async (request) => {
      const company = await companyOf(platform, request);
      const { proposal: id } = request.params as { proposal: string };
      await agentFor(request, await coach.agentOf(company.id, id), true);
      const by = viewerOf(request).name;
      return decision === "publish" ? coach.publish(company.id, id, by) : coach.keep(company.id, id, by);
    });
  }
}
