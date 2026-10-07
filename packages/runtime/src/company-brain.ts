import { AgentDefinition } from "@enterprise-brain/core";
import type { AgentRecord, AgentService } from "./agents.ts";

/**
 * The company brain as a participant: a hidden AI employee the app makes for every company. Asking the
 * brain ("@Company brain, who knows the 8D process?") is a conversation with it, run like any AI
 * employee's turn, so costs, audit and the same tools apply. `agents.list` leaves it out unless asked.
 */
export const COMPANY_BRAIN_SLUG = "company-brain";

export function companyBrainDefinition(): AgentDefinition {
  return AgentDefinition.parse({
    slug: COMPANY_BRAIN_SLUG,
    name: "Company brain",
    title: "What the company knows about itself",
    summary: "Answers questions about the company: people and what they know, processes, systems, data and reports, clients, projects and what is happening.",
    archetype: "conversational",
    instructions: [
      "You are the company brain: you answer colleagues' questions about the company itself, accurately and concisely.",
      "For people, roles, processes, systems, databases and tables, reports, clients, suppliers, projects and what is happening, look in the company brain;",
      "for policies and documents, search the knowledge base and cite sources as [n]. If the answer is in neither,",
      "say so and suggest who to ask. Answer in the language of the question.",
    ].join(" "),
    inputs: [],
    outputs: [],
    workflow: [],
    tools: ["knowledge.search", "company.lookup"],
    triggers: [{ type: "chat" }],
    knowledge: { collections: [] },
    connectors: [],
    guardrails: { approvalRequiredFor: [], personalData: "none" },
    ui: { layout: "chat" },
    kpis: [],
    tests: [],
  });
}

/** The company's brain participant, made on the first call and kept up to date with the app's version of it. */
export async function ensureCompanyBrain(agents: AgentService, companyId: string): Promise<AgentRecord> {
  const wanted = companyBrainDefinition();
  const existing = await agents.find(companyId, COMPANY_BRAIN_SLUG);
  if (!existing) {
    return agents.create(companyId, { definition: wanted, status: "active", source: "system", probation: "trusted", createdBy: "system" });
  }
  let record = existing;
  const differs = (a: AgentDefinition, b: AgentDefinition) =>
    a.instructions !== b.instructions || a.name !== b.name || a.summary !== b.summary || a.tools.join(",") !== b.tools.join(",");
  if (differs(existing.definition, wanted))
    record = await agents.update(companyId, existing.row.id, wanted, { note: "Updated with the app", createdBy: "system" });
  if (record.row.status !== "active") record = await agents.setStatus(companyId, record.row.id, "active");
  return record;
}

export function isCompanyBrain(agent: Pick<AgentRecord["row"], "slug" | "source">): boolean {
  return agent.source === "system" && agent.slug === COMPANY_BRAIN_SLUG;
}
