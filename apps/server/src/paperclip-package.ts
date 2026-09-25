import type { DepartmentTemplate, ProcessTemplate } from "@enterprise-brain/core";
import { PaperclipClient, exportCompanyPackage, type ExportAgent, type ExportDepartment, type ExportProcess } from "@enterprise-brain/paperclip";
import type { CompanyRow } from "@enterprise-brain/runtime";
import type { AppContext } from "./context.ts";
import { HttpError } from "./http.ts";
import type { PaperclipBridge } from "./paperclip-bridge.ts";

type Model = { departments: ExportDepartment[]; processes: ExportProcess[]; agents: ExportAgent[] };

/** Departments, processes and agents to export: the company's installed ones, or the whole catalog. */
export async function packageModel(ctx: AppContext, company: CompanyRow, scope: "installed" | "catalog", only?: string[]): Promise<Model> {
  const { platform } = ctx;
  const keep = (dept: string | undefined) => !only?.length || (dept !== undefined && only.includes(dept));
  if (scope === "catalog") {
    const c = platform.catalog.catalog;
    return {
      departments: c.departments.filter((d) => keep(d.id)),
      processes: c.processes.filter((p) => keep(p.department)),
      agents: c.agents.filter((a) => keep(a.department)).map((a) => ({ ...a, id: a.id })),
    };
  }
  const [departmentRows, processRows, agentRecords] = await Promise.all([
    platform.catalog.departments(company.id),
    platform.catalog.processes(company.id),
    platform.agents.list(company.id),
  ]);
  const deptKeyById = new Map(departmentRows.map((d) => [d.id, d.key]));
  return {
    departments: departmentRows
      .filter((d) => keep(d.key))
      .map((d) => {
        const data = d.data as unknown as Partial<DepartmentTemplate>;
        return { id: d.key, name: d.name, summary: d.summary, mission: data.mission, kpis: data.kpis };
      }),
    processes: processRows
      .map((p) => ({ row: p, data: p.data as unknown as ProcessTemplate }))
      .filter(({ row }) => keep(deptKeyById.get(row.departmentId ?? "")))
      .map(({ row, data }) => ({
        id: row.key,
        department: deptKeyById.get(row.departmentId ?? "") ?? data.department,
        name: row.name,
        summary: row.summary,
        description: data.description,
        trigger: data.trigger,
        frequency: data.frequency,
        steps: data.steps ?? [],
        agents: data.agents ?? [],
        kpis: data.kpis,
      })),
    agents: agentRecords
      .filter((a) => a.row.status !== "archived")
      .map((a) => ({
        id: a.row.templateId ?? a.row.slug,
        slug: a.row.slug,
        name: a.definition.name,
        title: a.definition.title,
        department: (a.row.departmentId ? deptKeyById.get(a.row.departmentId) : undefined) ?? a.definition.department,
        process: a.definition.process,
        summary: a.definition.summary,
        instructions: a.definition.instructions,
        archetype: a.definition.archetype,
        triggers: a.definition.triggers,
      }))
      .filter((a) => keep(a.department)),
  };
}

export function buildPackage(ctx: AppContext, company: CompanyRow, model: Model, includeCeo: boolean) {
  return exportCompanyPackage(model, {
    company: { name: company.name, slug: company.slug },
    enterpriseBrain: { url: ctx.config.publicUrl, companySlug: company.slug },
    includeCeo,
  });
}

export interface PushOptions {
  url: string;
  /**
   * Board API key given for this push, remembered (encrypted) for later updates. Defaults to
   * PAPERCLIP_API_KEY; none is needed for a Paperclip in local_trusted mode.
   */
  apiKey?: string;
  target: "new_company" | "existing_company";
  paperclipCompanyId?: string;
  departments?: string[];
  /** Who pushed, for the activity log. */
  actor?: string;
}

/**
 * Import the company's installed departments and agents into Paperclip, wire each agent's hermes_gateway
 * key, and give every Enterprise Brain agent its own Paperclip API key (so it can close its tasks).
 */
export async function pushCompany(ctx: AppContext, bridge: PaperclipBridge, company: CompanyRow, options: PushOptions) {
  const { platform, config } = ctx;
  if (!config.hermesApiKey) {
    throw new HttpError(400, "Enterprise Brain has no Hermes gateway key: set EB_HERMES_API_KEY to a long random secret (Paperclip sends it to Enterprise Brain)");
  }
  if (options.target === "existing_company" && !options.paperclipCompanyId) throw new HttpError(400, "paperclipCompanyId is required for existing_company");
  const url = options.url.replace(/\/$/, "");
  const model = await packageModel(ctx, company, "installed", options.departments);
  const result = buildPackage(ctx, company, model, options.target === "new_company");
  const hermesBase = `${config.publicUrl}/api/hermes`;
  const adapterOverrides = Object.fromEntries(
    result.specialists.map(({ paperclipSlug, ebSlug }) => [
      paperclipSlug,
      {
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl: hermesBase,
          apiKey: config.hermesApiKey,
          sessionKeyStrategy: "issue",
          timeoutSec: 900,
          payloadTemplate: { agent: ebSlug, company: company.slug },
        },
      },
    ]),
  );
  const client = new PaperclipClient(url, options.apiKey ?? config.paperclip?.apiKey);
  const response = (await client.importCompany({
    files: result.files,
    rootPath: company.slug,
    target: options.target === "new_company" ? { mode: "new_company" } : { mode: "existing_company", companyId: options.paperclipCompanyId! },
    adapterOverrides,
  })) as { company?: { id?: string }; agents?: { slug?: string; id?: string | null }[] } | null;
  // Each Enterprise Brain agent gets its own Paperclip API key, so it can close its issues like any employee.
  const imported = new Map((response?.agents ?? []).filter((a) => a.slug && a.id).map((a) => [a.slug!, a.id!]));
  const keys: { paperclipAgentId: string; slug: string; token: string }[] = [];
  const keyWarnings: string[] = [];
  for (const { paperclipSlug, ebSlug } of result.specialists) {
    const paperclipAgentId = imported.get(paperclipSlug);
    if (!paperclipAgentId) continue;
    try {
      const { token } = await client.createAgentKey(paperclipAgentId, "enterprise-brain");
      keys.push({ paperclipAgentId, slug: ebSlug, token });
    } catch (error) {
      keyWarnings.push(`No Paperclip key for ${paperclipSlug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const paperclipCompanyId = response?.company?.id ?? (options.target === "existing_company" ? options.paperclipCompanyId : undefined);
  await bridge.remember(company.id, { url, companyId: paperclipCompanyId, boardKey: options.apiKey, agents: keys });
  await platform.activity.record(company.id, {
    actor: options.actor ?? "user",
    action: "paperclip.pushed",
    entityType: "company",
    entityId: company.id,
    summary: `Pushed ${result.summary.agents} agents to Paperclip (${url})`,
  });
  return {
    summary: result.summary,
    warnings: [...result.warnings, ...keyWarnings],
    agentKeys: keys.length,
    paperclipCompanyId,
    paperclip: response,
  };
}
