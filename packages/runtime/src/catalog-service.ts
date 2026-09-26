import { and, eq } from "drizzle-orm";
import { AgentDefinition, humanizeKey, type AgentTemplate, type Catalog } from "@enterprise-brain/core";
import { companies, departments, processes, type DatabaseHandle } from "@enterprise-brain/db";
import type { KnowledgeService } from "@enterprise-brain/knowledge";
import type { ActivityService } from "./activity.ts";
import type { AgentRecord, AgentService } from "./agents.ts";

export type DepartmentRow = typeof departments.$inferSelect;
export type ProcessRow = typeof processes.$inferSelect;

/** Strip catalog-only metadata from an agent template to get a runnable AgentDefinition. */
export function templateToDefinition(template: AgentTemplate): AgentDefinition {
  const { id, capabilities, reportsTo, builder, tags, ...definition } = template;
  void capabilities;
  void builder;
  void tags;
  return AgentDefinition.parse({
    ...definition,
    templateId: id,
    paperclip: { ...(definition.paperclip ?? {}), reportsTo: definition.paperclip?.reportsTo ?? reportsTo },
  });
}

/** Placeholder domain the catalog uses for mailboxes and addresses (careers@company.com). */
export const CATALOG_MAIL_DOMAIN = "company.com";

/** Replace the catalog's placeholder mail domain with the company's own (mailboxes, recipients, instructions). */
export function localizeMailDomain(definition: AgentDefinition, mailDomain: string | undefined): AgentDefinition {
  if (!mailDomain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(mailDomain)) return definition;
  const json = JSON.stringify(definition).replace(/@company\.com\b/gi, `@${mailDomain.toLowerCase()}`);
  return AgentDefinition.parse(JSON.parse(json));
}

/** Installs catalog templates (departments, processes, agents, use cases) into a company. */
export class CatalogService {
  constructor(
    private readonly handle: DatabaseHandle,
    readonly catalog: Catalog,
    private readonly agents: AgentService,
    private readonly knowledge: KnowledgeService,
    private readonly activity: ActivityService,
  ) {}

  private async ensureDepartment(companyId: string, departmentId: string): Promise<DepartmentRow> {
    const template = this.catalog.departments.find((d) => d.id === departmentId);
    if (!template) throw new Error(`Unknown department template "${departmentId}"`);
    const [existing] = await this.handle.db
      .select()
      .from(departments)
      .where(and(eq(departments.companyId, companyId), eq(departments.key, template.id)));
    if (existing) return existing;
    const [row] = await this.handle.db
      .insert(departments)
      .values({
        companyId,
        key: template.id,
        templateId: template.id,
        name: template.name,
        summary: template.summary,
        icon: template.icon ?? null,
        data: template as unknown as Record<string, unknown>,
      })
      .returning();
    return row!;
  }

  private async ensureProcess(companyId: string, department: DepartmentRow, processId: string): Promise<ProcessRow> {
    const template = this.catalog.processes.find((p) => p.id === processId);
    if (!template) throw new Error(`Unknown process template "${processId}"`);
    const [existing] = await this.handle.db
      .select()
      .from(processes)
      .where(and(eq(processes.companyId, companyId), eq(processes.key, template.id)));
    if (existing) return existing;
    const [row] = await this.handle.db
      .insert(processes)
      .values({
        companyId,
        departmentId: department.id,
        key: template.id,
        templateId: template.id,
        name: template.name,
        summary: template.summary,
        data: template as unknown as Record<string, unknown>,
      })
      .returning();
    return row!;
  }

  async installAgentTemplate(
    companyId: string,
    templateId: string,
    options: { activate?: boolean; actor?: string } = {},
  ): Promise<AgentRecord> {
    const template = this.catalog.agents.find((a) => a.id === templateId);
    if (!template) throw new Error(`Unknown agent template "${templateId}"`);
    const installed = (await this.agents.list(companyId)).find((a) => a.row.templateId === templateId && a.row.source === "template");
    if (installed) return installed;
    const department = await this.ensureDepartment(companyId, template.department);
    const process = template.process ? await this.ensureProcess(companyId, department, template.process) : undefined;
    for (const key of template.knowledge.collections) {
      await this.knowledge.ensureCollection(companyId, {
        key,
        name: humanizeKey(key),
        description: `Knowledge used by ${template.name}`,
        departmentId: department.id,
      });
    }
    const [company] = await this.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const mailDomain = typeof company?.settings.mailDomain === "string" ? company.settings.mailDomain : undefined;
    const record = await this.agents.create(companyId, {
      definition: localizeMailDomain(templateToDefinition(template), mailDomain),
      status: options.activate ? "active" : "draft",
      source: "template",
      templateId: template.id,
      departmentId: department.id,
      processId: process?.id ?? null,
      createdBy: options.actor ?? "system",
    });
    await this.activity.record(companyId, {
      actor: options.actor ?? "system",
      action: "agent.installed",
      entityType: "agent",
      entityId: record.row.id,
      summary: `Installed ${template.name} from the catalog`,
      data: { templateId },
    });
    return record;
  }

  async installDepartment(
    companyId: string,
    departmentId: string,
    options: { processes?: string[]; activate?: boolean; actor?: string } = {},
  ) {
    const template = this.catalog.departments.find((d) => d.id === departmentId);
    if (!template) throw new Error(`Unknown department template "${departmentId}"`);
    const department = await this.ensureDepartment(companyId, departmentId);
    const processIds = options.processes?.length ? options.processes : template.processes;
    const installedProcesses: ProcessRow[] = [];
    const installedAgents: AgentRecord[] = [];
    for (const processId of processIds) {
      installedProcesses.push(await this.ensureProcess(companyId, department, processId));
      const processTemplate = this.catalog.processes.find((p) => p.id === processId);
      for (const agentId of processTemplate?.agents ?? []) {
        installedAgents.push(await this.installAgentTemplate(companyId, agentId, options));
      }
    }
    await this.activity.record(companyId, {
      actor: options.actor ?? "system",
      action: "department.installed",
      entityType: "department",
      entityId: department.id,
      summary: `Installed ${template.name} (${installedProcesses.length} processes, ${installedAgents.length} agents)`,
    });
    return { department, processes: installedProcesses, agents: installedAgents };
  }

  async installUseCase(companyId: string, useCaseId: string, options: { actor?: string } = {}) {
    const useCase = this.catalog.useCases.find((u) => u.id === useCaseId);
    if (!useCase) throw new Error(`Unknown use case "${useCaseId}"`);
    if (!useCase.defaultAgent) return { useCase, agent: undefined };
    const agent = await this.installAgentTemplate(companyId, useCase.defaultAgent, { activate: true, actor: options.actor });
    return { useCase, agent };
  }

  async departments(companyId: string): Promise<DepartmentRow[]> {
    return this.handle.db.select().from(departments).where(eq(departments.companyId, companyId));
  }

  /** A department's monthly budget for its AI employees together (null: none). */
  async setDepartmentBudget(companyId: string, departmentId: string, monthlyBudgetUsd: number | null, actor: string): Promise<DepartmentRow> {
    if (monthlyBudgetUsd !== null && !(monthlyBudgetUsd >= 0)) throw new Error("The monthly budget must be zero or more");
    const [row] = await this.handle.db
      .update(departments)
      .set({ monthlyBudgetUsd })
      .where(and(eq(departments.companyId, companyId), eq(departments.id, departmentId)))
      .returning();
    if (!row) throw new Error(`Department ${departmentId} not found`);
    await this.activity.record(companyId, {
      actor,
      action: "department.budget_set",
      entityType: "department",
      entityId: row.id,
      summary: monthlyBudgetUsd === null ? `${row.name}: no monthly budget` : `${row.name}: monthly budget $${monthlyBudgetUsd.toFixed(2)}`,
      data: { monthlyBudgetUsd },
    });
    return row;
  }

  async processes(companyId: string): Promise<ProcessRow[]> {
    return this.handle.db.select().from(processes).where(eq(processes.companyId, companyId));
  }
}
