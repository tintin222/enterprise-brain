import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PERFORMANCE_TARGETS,
  afterProbation,
  employmentOf,
  measure,
  monthStartIn,
  weekStart,
  weeksBefore,
  workingHoursOf,
  type AgentRecord,
} from "@enterprise-brain/runtime";
import { canManageDepartment, canSeeDepartment, requireAnyManager, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

export const REPORT_PERIODS = ["last-4-weeks", "this-week", "last-week", "this-month", "last-month"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const LABELS: Record<ReportPeriod, string> = {
  "last-4-weeks": "Last 4 weeks",
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
};

/** A named period in the company's time zone. */
export function periodOf(key: ReportPeriod, now: Date, timeZone: string): { key: ReportPeriod; label: string; from: Date; to: Date } {
  const thisWeek = weekStart(now, timeZone);
  const [from, to] =
    key === "this-week"
      ? [thisWeek, now]
      : key === "last-week"
        ? [weekStart(new Date(thisWeek.getTime() - 1), timeZone), thisWeek]
        : key === "this-month"
          ? [monthStartIn(now, timeZone), now]
          : key === "last-month"
            ? [monthStartIn(now, timeZone, -1), monthStartIn(now, timeZone)]
            : [new Date(now.getTime() - 28 * 86_400_000), now];
  return { key, label: LABELS[key], from, to };
}

const TREND_WEEKS = 8;

/** Performance reports: what AI employees finish alone, how fast people help them, what is corrected, what it costs. */
export async function reportRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const query = z.object({ period: z.enum(REPORT_PERIODS).default("last-4-weeks"), department: z.string().optional() });

  /** Company, departments and AI employees a manager runs (all for admins), against the targets, with the weekly trend. */
  app.get("/api/companies/:company/reports/performance", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { period: key, department } = query.parse(request.query);
    const departments = await platform.catalog.departments(company.id);
    const chosen = department ? departments.find((d) => d.key === department || d.id === department) : undefined;
    if (department && (!chosen || !canManageDepartment(viewer, chosen.id))) throw new HttpError(404, `Department "${department}" not found`);
    const agents = (await platform.agents.list(company.id)).filter(
      (a) => a.row.status !== "archived" && canManageDepartment(viewer, a.row.departmentId) && (!chosen || a.row.departmentId === chosen.id),
    );
    const hours = workingHoursOf(company.settings);
    const now = new Date();
    const period = periodOf(key, now, hours.timeZone);
    const weeks = weeksBefore(period.to, TREND_WEEKS, hours.timeZone);
    const since = new Date(Math.min(period.from.getTime(), weeks[0]!.from.getTime()));
    const facts = await platform.reports.facts(
      company.id,
      agents.map((a) => a.row.id),
      since,
    );
    const ids = (list: AgentRecord[]) => new Set(list.map((a) => a.row.id));
    const groups = new Map<string | null, AgentRecord[]>();
    for (const agent of agents) groups.set(agent.row.departmentId, [...(groups.get(agent.row.departmentId) ?? []), agent]);
    const names = new Map(departments.map((d) => [d.id, d]));
    return {
      period: { key: period.key, label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
      workingHours: hours,
      targets: PERFORMANCE_TARGETS,
      total: { measures: measure(facts, period, hours), afterProbation: afterProbation(facts, period, hours, agents) },
      departments: [...groups.entries()]
        .map(([id, members]) => ({
          id,
          key: id ? (names.get(id)?.key ?? null) : null,
          name: id ? (names.get(id)?.name ?? "Department") : "Company-wide",
          aiEmployees: members.length,
          measures: measure(facts, period, hours, ids(members)),
          afterProbation: afterProbation(facts, period, hours, members),
        }))
        .sort((a, b) => b.measures.finished - a.measures.finished || a.name.localeCompare(b.name)),
      aiEmployees: agents
        .map((agent) => ({
          id: agent.row.id,
          slug: agent.row.slug,
          name: agent.definition.name,
          departmentId: agent.row.departmentId,
          status: agent.row.status,
          probation: employmentOf(agent.row).probation,
          measures: measure(facts, period, hours, new Set([agent.row.id])),
        }))
        .sort((a, b) => b.measures.finished - a.measures.finished || a.name.localeCompare(b.name)),
      weeks: weeks.map((week) => ({ start: week.start, measures: measure(facts, week, hours), afterProbation: afterProbation(facts, week, hours, agents) })),
      hiring: await platform.reports.hiring(company.id, agents, new Date(now.getTime() - 90 * 86_400_000), now),
    };
  });

  /** One AI employee's measures and weekly trend (for everyone who may see it). */
  app.get("/api/companies/:company/agents/:agent/performance", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await platform.agents.get(company.id, ref);
    if (!canSeeDepartment(viewerOf(request), agent.row.departmentId)) throw new HttpError(404, `Agent "${ref}" not found`);
    const { period: key } = query.parse(request.query);
    const hours = workingHoursOf(company.settings);
    const period = periodOf(key, new Date(), hours.timeZone);
    const weeks = weeksBefore(period.to, TREND_WEEKS, hours.timeZone);
    const facts = await platform.reports.facts(company.id, [agent.row.id], new Date(Math.min(period.from.getTime(), weeks[0]!.from.getTime())));
    return {
      period: { key: period.key, label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
      workingHours: hours,
      targets: PERFORMANCE_TARGETS,
      probation: employmentOf(agent.row).probation,
      measures: measure(facts, period, hours),
      weeks: weeks.map((week) => ({ start: week.start, measures: measure(facts, week, hours) })),
    };
  });
}
