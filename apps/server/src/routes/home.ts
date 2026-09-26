import type { FastifyInstance } from "fastify";
import { OPEN_TASK_STATUSES, employmentOf, type AgentRecord } from "@enterprise-brain/runtime";
import { canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { companyOf } from "../http.ts";

const round = (usd: number) => Math.round(usd * 100) / 100;

/** Home: what the viewer's AI employees did today, and what it cost. */
export async function homeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** The AI employees a person works with: those of their departments (all for admins without one). */
  const theirs = (viewer: Viewer, agents: AgentRecord[]) => {
    const visible = agents.filter((a) => canSeeDepartment(viewer, a.row.departmentId) && a.row.status !== "archived");
    if (!viewer.departments.length) return viewer.isAdmin ? visible : visible.filter((a) => !a.row.departmentId);
    const mine = new Set(viewer.departments.map((d) => d.departmentId));
    return visible.filter((a) => (a.row.departmentId && mine.has(a.row.departmentId)) || a.row.managerUserId === viewer.userId);
  };

  app.get("/api/companies/:company/home", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const agents = theirs(viewer, await platform.agents.list(company.id));
    const departments = new Map((await platform.catalog.departments(company.id)).map((d) => [d.id, d.name]));
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const tasks = await platform.tasks.list(company.id, { agentIds: agents.map((a) => a.row.id), limit: 2000 });
    const aiEmployees = await Promise.all(
      agents.map(async (agent) => {
        const own = tasks.filter((t) => t.agentId === agent.row.id);
        return {
          id: agent.row.id,
          slug: agent.row.slug,
          name: agent.definition.name,
          title: agent.definition.title ?? null,
          department: agent.row.departmentId ? (departments.get(agent.row.departmentId) ?? null) : null,
          departmentId: agent.row.departmentId,
          status: agent.row.status,
          probation: employmentOf(agent.row).probation,
          today: {
            started: own.filter((t) => t.createdAt >= midnight).length,
            done: own.filter((t) => t.status === "done" && t.closedAt && t.closedAt >= midnight).length,
            open: own.filter((t) => OPEN_TASK_STATUSES.includes(t.status as never)).length,
            needsPerson: own.filter((t) => t.status === "needs_person").length,
            failed: own.filter((t) => t.status === "failed").length,
          },
          costTodayUsd: round(await platform.engine.costSince(agent.row.id, midnight)),
        };
      }),
    );
    aiEmployees.sort((a, b) => b.today.needsPerson - a.today.needsPerson || b.today.started - a.today.started || a.name.localeCompare(b.name));
    return {
      person: {
        name: viewer.name,
        departments: viewer.departments.map((d) => d.name),
        isManager: viewer.isAdmin || viewer.departments.some((d) => d.role === "manager"),
      },
      aiEmployees,
      /** Where people forward email to give an AI employee work (Settings → Installation). */
      aiMailbox: typeof company.settings.aiMailbox === "string" ? company.settings.aiMailbox : null,
    };
  });
}
