import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentRecord, TaskRow } from "@enterprise-brain/runtime";
import { canHandleWork, canSeeDepartment, isForViewer, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/**
 * The work queue: everything that needs a person, in one list. Approvals of AI employees' changes,
 * questions they ask, checks of Shadow AI employees' work, failed tasks and notices.
 */
export async function workRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  app.get("/api/companies/:company/work", async (request) => {
    const company = await companyOf(platform, request);
    const query = z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: z.enum(["open", "closed"]).default("open"), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const viewer = viewerOf(request);
    const agents = new Map((await platform.agents.list(company.id)).map((a) => [a.row.id, a]));
    const people = new Map((await platform.people.list(company.id)).map((p) => [p.id, p]));
    const tasks = new Map<string, TaskRow | undefined>();
    const taskOf = async (id: string | null | undefined) => {
      if (!id) return null;
      if (!tasks.has(id)) tasks.set(id, await platform.tasks.byId(id));
      const task = tasks.get(id);
      return task ? { id: task.id, ref: task.ref, title: task.title, status: task.status } : null;
    };
    const agentView = (agent: AgentRecord | undefined) => (agent ? { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name } : null);
    const visible = (departmentId: string | null, assigneeUserId: string | null) =>
      canSeeDepartment(viewer, departmentId) && (departmentId !== null || viewer.isAdmin || viewer.userId === assigneeUserId);

    const entries: WorkEntry[] = [];
    const approvals = await platform.engine.listApprovals(company.id, { status: query.status === "open" ? "pending" : undefined, limit: query.limit });
    for (const approval of approvals) {
      if (query.status === "closed" && approval.status === "pending") continue;
      const agent = agents.get(approval.agentId);
      const departmentId = agent?.row.departmentId ?? null;
      if (!agent || !visible(departmentId, null)) continue;
      const run = approval.runId ? await platform.engine.getRow(company.id, approval.runId).catch(() => undefined) : undefined;
      entries.push({
        type: "approval",
        id: approval.id,
        title: approval.title,
        details: approval.details,
        reason: approval.reason,
        suggestion: null,
        options: null,
        action: approval.action,
        task: await taskOf(run?.taskId),
        agent: agentView(agent),
        departmentId,
        assignee: null,
        forMe: isForViewer(viewer, departmentId, null) || agent.row.managerUserId === viewer.userId,
        canHandle: canHandleWork(viewer, departmentId, null),
        status: approval.status,
        resolvedBy: approval.decidedBy,
        createdAt: approval.createdAt,
      });
    }
    const items = await platform.work.list(company.id, { statuses: query.status === "open" ? ["open"] : ["done", "dismissed"], limit: query.limit });
    for (const item of items) {
      if (!visible(item.departmentId, item.assigneeUserId)) continue;
      const assignee = item.assigneeUserId ? people.get(item.assigneeUserId) : undefined;
      entries.push({
        type: item.kind as WorkEntry["type"],
        id: item.id,
        title: item.title,
        details: item.details,
        reason: item.reason,
        suggestion: item.suggestion,
        options: item.options,
        action: null,
        task: await taskOf(item.taskId),
        agent: agentView(item.agentId ? agents.get(item.agentId) : undefined),
        departmentId: item.departmentId,
        assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        forMe: isForViewer(viewer, item.departmentId, item.assigneeUserId),
        canHandle: canHandleWork(viewer, item.departmentId, item.assigneeUserId),
        status: item.status,
        resolvedBy: item.resolvedBy,
        createdAt: item.createdAt,
      });
    }
    const list = query.scope === "mine" ? entries.filter((e) => e.forMe) : entries;
    return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, query.limit);
  });

  /** Handle a queue item: answer a question, check work (right/wrong), retry a failed task, or dismiss. */
  app.post("/api/companies/:company/work/:id", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        answer: z.string().optional(),
        verdict: z.enum(["right", "wrong"]).optional(),
        note: z.string().optional(),
        retry: z.boolean().optional(),
        dismiss: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    const viewer = viewerOf(request);
    const item = await platform.work.get(company.id, id);
    if (!canSeeDepartment(viewer, item.departmentId) || (!item.departmentId && !viewer.isAdmin && viewer.userId !== item.assigneeUserId)) {
      throw new HttpError(404, `Work item ${id} not found`);
    }
    if (!canHandleWork(viewer, item.departmentId, item.assigneeUserId)) throw new HttpError(403, "This is for someone else");
    return platform.engine.resolveWorkItem(company.id, id, body, byName(viewer), { wait: false });
  });
}

function byName(viewer: Viewer): string {
  return viewer.kind === "session" ? viewer.name : viewer.kind === "api-key" ? "api" : "user";
}

interface WorkEntry {
  type: "approval" | "question" | "review" | "failure" | "notice";
  id: string;
  title: string;
  details: string;
  reason: string | null;
  suggestion: string | null;
  options: string[] | null;
  action: Record<string, unknown> | null;
  task: { id: string; ref: string; title: string; status: string } | null;
  agent: { id: string; slug: string; name: string } | null;
  departmentId: string | null;
  assignee: { id: string; name: string } | null;
  /** It is the viewer's to do: assigned to them, or unassigned in a department they work in. */
  forMe: boolean;
  canHandle: boolean;
  status: string;
  resolvedBy: string | null;
  createdAt: Date;
}
