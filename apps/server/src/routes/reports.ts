import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PERFORMANCE_TARGETS,
  afterProbation,
  employmentOf,
  localDate,
  measure,
  monthStartIn,
  weekStart,
  weeksBefore,
  workingHoursOf,
  type AgentRecord,
} from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, requireAnyManager, viewerOf } from "../auth/viewer.ts";
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
const round = (usd: number) => Math.round(usd * 100) / 100;

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

  /**
   * Costs: this month's cost of each department and AI employee a manager runs (all for admins), against
   * their budgets, and the last six months by department.
   */
  app.get("/api/companies/:company/costs", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const departments = await platform.catalog.departments(company.id);
    const people = new Map((await platform.people.list(company.id)).map((p) => [p.id, p.name]));
    const agents = (await platform.agents.list(company.id)).filter((a) => canManageDepartment(viewer, a.row.departmentId));
    const hours = workingHoursOf(company.settings);
    const now = new Date();
    const visible = departments.filter((d) => canManageDepartment(viewer, d.id));
    const departmentRows = await Promise.all(
      visible.map(async (d) => {
        const cost = await platform.engine.departmentCostThisMonth(company.id, d.id, now);
        const budget = d.monthlyBudgetUsd ?? null;
        return {
          id: d.id,
          key: d.key,
          name: d.name,
          aiEmployees: agents.filter((a) => a.row.departmentId === d.id && a.row.status !== "archived").length,
          costThisMonthUsd: round(cost),
          monthlyBudgetUsd: budget,
          stoppedByBudget: budget !== null && cost >= budget,
        };
      }),
    );
    departmentRows.sort((a, b) => b.costThisMonthUsd - a.costThisMonthUsd || a.name.localeCompare(b.name));
    const stoppedDepartments = new Set(departmentRows.filter((d) => d.stoppedByBudget).map((d) => d.id));
    const rows = await Promise.all(
      agents.map(async (agent) => {
        const cost = await platform.engine.costThisMonth(company.id, agent.row.id, now);
        const budget = agent.row.monthlyBudgetUsd ?? null;
        return {
          slug: agent.row.slug,
          name: agent.definition.name,
          departmentId: agent.row.departmentId,
          department: agent.row.departmentId ? (departments.find((d) => d.id === agent.row.departmentId)?.name ?? null) : null,
          manager: agent.row.managerUserId ? (people.get(agent.row.managerUserId) ?? null) : null,
          status: agent.row.status,
          probation: employmentOf(agent.row).probation,
          costThisMonthUsd: round(cost),
          monthlyBudgetUsd: budget,
          stoppedByBudget: (budget !== null && cost >= budget) || stoppedDepartments.has(agent.row.departmentId ?? ""),
          /** Why it stopped: its own budget, or its department's. */
          stoppedBy: budget !== null && cost >= budget ? "own" : stoppedDepartments.has(agent.row.departmentId ?? "") ? "department" : null,
        };
      }),
    );
    rows.sort((a, b) => b.costThisMonthUsd - a.costThisMonthUsd || a.name.localeCompare(b.name));
    // The last six months, by department (company-wide AI employees apart), in the company's time zone.
    const months = [];
    for (let back = 5; back >= 0; back--) {
      const from = monthStartIn(now, hours.timeZone, -back);
      const to = back ? monthStartIn(now, hours.timeZone, -back + 1) : now;
      const costs = await platform.reports.costsByAgent(
        company.id,
        agents.map((a) => a.row.id),
        from,
        to,
      );
      const byDepartment: Record<string, number> = {};
      for (const agent of agents) {
        const usd = costs.get(agent.row.id) ?? 0;
        if (!usd) continue;
        const key = agent.row.departmentId ?? "company";
        byDepartment[key] = round((byDepartment[key] ?? 0) + usd);
      }
      months.push({
        month: localDate(from, hours.timeZone).slice(0, 7),
        totalUsd: round([...costs.values()].reduce((sum, usd) => sum + usd, 0)),
        byDepartment,
      });
    }
    return {
      month: localDate(now, hours.timeZone).slice(0, 7),
      totalUsd: round(rows.reduce((sum, r) => sum + r.costThisMonthUsd, 0)),
      departments: departmentRows,
      aiEmployees: rows,
      months,
    };
  });

  /** A department's monthly budget for its AI employees together: its managers and admins set it. */
  app.put("/api/companies/:company/departments/:department/budget", async (request) => {
    const company = await companyOf(platform, request);
    const { department: ref } = request.params as { department: string };
    const { monthlyBudgetUsd } = z.object({ monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable() }).parse(request.body);
    const department = (await platform.catalog.departments(company.id)).find((d) => d.id === ref || d.key === ref);
    const viewer = viewerOf(request);
    if (!department || !canSeeDepartment(viewer, department.id)) throw new HttpError(404, `Department "${ref}" not found`);
    if (!canManageDepartment(viewer, department.id)) throw new HttpError(403, "Only a manager of this department or an admin can set its budget");
    const row = await platform.catalog.setDepartmentBudget(company.id, department.id, monthlyBudgetUsd, actorOf(viewer));
    return { id: row.id, key: row.key, name: row.name, monthlyBudgetUsd: row.monthlyBudgetUsd };
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
