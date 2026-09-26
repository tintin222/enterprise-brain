import { PROBATION_LEVELS, describeDuties, type Duty, type Probation, type TrustLimits } from "@enterprise-brain/core";
import type { ActivityService } from "./activity.ts";
import { employmentOf, type AgentRecord, type AgentService, type EmploymentPatch } from "./agents.ts";
import type { ConnectorService } from "./connectors.ts";
import type { RunEngine } from "./engine.ts";
import { PeopleError, type PeopleService, type Person } from "./people.ts";

/** An AI employee's employment as its page shows it. */
export interface EmploymentView {
  manager: { id: string; name: string; email: string; title: string | null } | null;
  probation: Probation;
  limits: TrustLimits;
  monthlyBudgetUsd: number | null;
  costThisMonthUsd: number;
  /** It reached its budget: it starts no new work this month until its manager raises it. */
  stoppedByBudget: boolean;
  /** Changes it made alone today (its daily limit counts these). */
  changesToday: number;
  duties: Duty[];
}

/**
 * Employment of AI employees: who manages each one, how much it may do alone, what it may spend,
 * and its standing duties. Kept apart from the job definition so a rollback never changes them.
 */
export class EmploymentService {
  constructor(
    private readonly agents: AgentService,
    private readonly people: PeopleService,
    private readonly engine: RunEngine,
    private readonly activity: ActivityService,
    /** To name the connected systems its duties watch. */
    private readonly connectors?: ConnectorService,
  ) {}

  /** The connected systems its duties watch, by the ref the duty names ("files" → "Scanned invoices"). */
  private async watchedNames(companyId: string, agent: AgentRecord): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    if (!this.connectors) return names;
    for (const trigger of agent.definition.triggers) {
      if (trigger.type !== "connector-event" || trigger.connector in names) continue;
      const binding = agent.definition.connectors.find((c) => c.ref === trigger.connector);
      if (!binding) continue;
      const resolved = await this.connectors.resolve(companyId, binding).catch(() => undefined);
      names[trigger.connector] = resolved ? resolved.name : `${trigger.connector} (not connected yet)`;
    }
    return names;
  }

  async view(companyId: string, agent: AgentRecord): Promise<EmploymentView> {
    const { probation, limits } = employmentOf(agent.row);
    const manager = agent.row.managerUserId ? await this.people.get(companyId, agent.row.managerUserId).catch(() => undefined) : undefined;
    const [cost, changesToday] = await Promise.all([this.engine.costThisMonth(agent.row.id), this.engine.changesToday(agent.row.id)]);
    const budget = agent.row.monthlyBudgetUsd ?? null;
    return {
      manager: manager ? { id: manager.id, name: manager.name, email: manager.email, title: manager.title } : null,
      probation,
      limits,
      monthlyBudgetUsd: budget,
      costThisMonthUsd: Math.round(cost * 100) / 100,
      stoppedByBudget: budget !== null && cost >= budget,
      changesToday,
      duties: describeDuties(agent.definition.triggers, await this.watchedNames(companyId, agent)),
    };
  }

  /** Who may manage an AI employee: the managers of its department, and the admins. */
  async candidates(companyId: string, agent: AgentRecord): Promise<Person[]> {
    const everyone = await this.people.list(companyId);
    return everyone.filter((p) => p.status === "active" && this.mayManage(p, agent.row.departmentId));
  }

  private mayManage(person: Person, departmentId: string | null): boolean {
    return person.role === "admin" || (Boolean(departmentId) && person.departments.some((d) => d.departmentId === departmentId && d.role === "manager"));
  }

  async update(companyId: string, ref: string, patch: EmploymentPatch, actor: string): Promise<AgentRecord> {
    const agent = await this.agents.get(companyId, ref);
    const name = agent.definition.name;
    const changes: string[] = [];
    if (patch.managerUserId) {
      const person = await this.people.get(companyId, patch.managerUserId);
      if (person.status !== "active") throw new PeopleError(`${person.name} can't sign in, so can't manage an AI employee`, 400);
      if (!this.mayManage(person, agent.row.departmentId)) {
        throw new PeopleError(`${person.name} doesn't manage this AI employee's department. Choose one of its managers or an admin.`, 400);
      }
      if (person.id !== agent.row.managerUserId) changes.push(`manager: ${person.name}`);
    } else if (patch.managerUserId === null && agent.row.managerUserId) changes.push("no manager");
    if (patch.probation && patch.probation !== agent.row.probation) changes.push(`level: ${PROBATION_LEVELS[patch.probation].label}`);
    if (patch.monthlyBudgetUsd !== undefined) {
      if (patch.monthlyBudgetUsd !== null && !(patch.monthlyBudgetUsd >= 0)) throw new PeopleError("The monthly budget must be zero or more", 400);
      if (patch.monthlyBudgetUsd !== agent.row.monthlyBudgetUsd) {
        changes.push(patch.monthlyBudgetUsd === null ? "no monthly budget" : `monthly budget: $${patch.monthlyBudgetUsd}`);
      }
    }
    if (patch.limits !== undefined && JSON.stringify(patch.limits) !== JSON.stringify(agent.row.limits ?? {})) changes.push("limits");
    const updated = await this.agents.setEmployment(companyId, ref, patch);
    if (changes.length) {
      await this.activity.record(companyId, {
        actor,
        action: "agent.employment",
        entityType: "agent",
        entityId: agent.row.id,
        summary: `${name}: ${changes.join(", ")}`,
        data: { ...patch },
      });
    }
    return updated;
  }

  /**
   * Give AI employees without a manager one. Those just hired report to the person who hired them when
   * that person manages their department; any AI employee gets its department's first manager; failing
   * that, one just hired by an admin reports to that admin.
   */
  async assignDefaultManagers(companyId: string, hired: { by?: string | null; agentIds?: string[] } = {}): Promise<number> {
    const hirer = hired.by ? await this.people.get(companyId, hired.by).catch(() => undefined) : undefined;
    const justHired = new Set(hired.agentIds ?? []);
    const unmanaged = (await this.agents.list(companyId)).filter((a) => !a.row.managerUserId);
    const departmentManagers = new Map<string, string | undefined>();
    let assigned = 0;
    for (const agent of unmanaged) {
      const departmentId = agent.row.departmentId;
      const isNew = justHired.has(agent.row.id);
      let managerUserId: string | undefined;
      if (isNew && hirer?.status === "active" && departmentId && hirer.departments.some((d) => d.departmentId === departmentId && d.role === "manager")) {
        managerUserId = hirer.id;
      } else if (departmentId) {
        if (!departmentManagers.has(departmentId)) {
          const people = await this.people.departmentPeople(companyId, departmentId);
          departmentManagers.set(departmentId, people.find((p) => p.membership === "manager" && p.status === "active")?.id);
        }
        managerUserId = departmentManagers.get(departmentId);
      }
      if (!managerUserId && isNew && hirer?.status === "active" && hirer.role === "admin") managerUserId = hirer.id;
      if (!managerUserId) continue;
      await this.agents.setEmployment(companyId, agent.row.id, { managerUserId });
      assigned += 1;
    }
    return assigned;
  }
}
