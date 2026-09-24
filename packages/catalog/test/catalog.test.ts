import { beforeAll, describe, expect, it } from "vitest";
import type { AgentTemplate, Catalog } from "@enterprise-brain/core";
import {
  DEPARTMENT_ORDER,
  agentsForDepartment,
  agentsForProcess,
  findAgent,
  findDepartment,
  findProcess,
  findUseCase,
  loadCatalog,
  processesForDepartment,
  sourceOf,
  validateCatalog,
} from "../src/index.ts";

const FLAGSHIPS = [
  "hr.cv-screener",
  "finance.invoice-processor",
  "customer-service.mail-triage",
  "legal.contract-reviewer",
  "sales.lead-qualifier",
];

const TURKISH = /[çğışöüÇĞİŞÖÜ]/;

function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

let catalog: Catalog;

beforeAll(async () => {
  catalog = await loadCatalog();
});

describe("the shipped catalog", () => {
  it("loads with zero validation problems", () => {
    expect(validateCatalog(catalog)).toEqual([]);
  });

  it("has the expected size", () => {
    expect(catalog.departments.length).toBeGreaterThanOrEqual(11);
    expect(catalog.processes.length).toBeGreaterThanOrEqual(30);
    expect(catalog.agents.length).toBeGreaterThanOrEqual(35);
    expect(catalog.useCases).toHaveLength(6);
  });

  it("contains the eleven standard departments in presentation order", () => {
    expect(catalog.departments.map((d) => d.id)).toEqual([...DEPARTMENT_ORDER]);
  });

  it("keeps ids, slugs and files consistent", () => {
    for (const agent of catalog.agents) {
      const [department, name] = agent.id.split(".");
      expect(agent.department).toBe(department);
      expect(agent.slug).toBe(`${department}-${name}`);
      expect(sourceOf(agent)).toBe(`departments/${department}/agents/${name}.md`);
    }
    for (const process of catalog.processes) {
      const [department, name] = process.id.split(".");
      expect(sourceOf(process)).toBe(`departments/${department}/processes/${name}.yaml`);
    }
    expect(new Set(catalog.agents.map((a) => a.slug)).size).toBe(catalog.agents.length);
  });

  it("describes every department completely", () => {
    for (const department of catalog.departments) {
      expect(department.kpis.length, department.id).toBeGreaterThanOrEqual(3);
      expect(department.kpis.length, department.id).toBeLessThanOrEqual(5);
      expect(department.roles.length, department.id).toBeGreaterThanOrEqual(3);
      expect(department.systems.length, department.id).toBeGreaterThanOrEqual(3);
      expect(department.systems.every((s) => s.examples.length > 0), department.id).toBe(true);
      expect(department.processes.length, department.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("describes every process completely", () => {
    for (const process of catalog.processes) {
      expect(process.steps.length, process.id).toBeGreaterThanOrEqual(3);
      expect(process.steps.length, process.id).toBeLessThanOrEqual(7);
      expect(process.agents.length, process.id).toBeGreaterThan(0);
      expect(process.kpis.length, process.id).toBeGreaterThan(0);
      expect(process.integrations.length, process.id).toBeGreaterThan(0);
      expect(process.useCases.length, process.id).toBeGreaterThan(0);
      expect(process.value?.hoursSavedPerMonth, process.id).toBeGreaterThan(0);
    }
  });

  it("gives every agent instructions of 150-400 words and matching phrases", () => {
    for (const agent of catalog.agents) {
      const words = wordCount(agent.instructions);
      expect(words, agent.id).toBeGreaterThanOrEqual(150);
      expect(words, agent.id).toBeLessThanOrEqual(400);
      expect(agent.builder.matchPhrases.length, agent.id).toBeGreaterThan(0);
      expect(agent.kpis.length, agent.id).toBeGreaterThan(0);
    }
  });

  it("makes workflow agents executable and conversational agents tool-driven", () => {
    for (const agent of catalog.agents) {
      if (agent.workflow.length === 0) {
        expect(["conversational", "search"], agent.id).toContain(agent.archetype);
        expect(agent.tools.length, agent.id).toBeGreaterThan(0);
        expect(agent.triggers.map((t) => t.type), agent.id).toContain("chat");
        expect(agent.ui.layout, agent.id).toBe("chat");
        continue;
      }
      expect(agent.inputs.length, agent.id).toBeGreaterThan(0);
      expect(agent.outputs.length, agent.id).toBeGreaterThan(0);
      expect(agent.workflow.at(-1)?.type, agent.id).toBe("output");
      for (const step of agent.workflow) {
        if (step.type === "llm.generate") expect(step.fallback?.trim(), `${agent.id}.${step.id}`).toBeTruthy();
      }
    }
  });

  it("lets mail-triggered agents read input.email and shows them in the right layout", () => {
    const mailAgents = catalog.agents.filter((a) => a.triggers.some((t) => t.type === "mailbox"));
    expect(mailAgents.length).toBeGreaterThanOrEqual(12);
    for (const agent of mailAgents) {
      const email = agent.inputs.find((f) => f.key === "email");
      expect(email?.type, agent.id).toBe("object");
      expect(email?.fields?.map((f) => f.key), agent.id).toEqual(
        expect.arrayContaining(["id", "from", "subject", "body", "attachments", "attachmentNames"]),
      );
    }
    for (const agent of catalog.agents.filter((a) => a.archetype === "mail-triage")) {
      expect(agent.ui.layout, agent.id).toBe("inbox");
    }
  });

  it("protects personal data and gates side effects", () => {
    for (const agent of catalog.agents) {
      expect(agent.guardrails.approvalRequiredFor, agent.id).toContain("mail.send");
    }
    for (const id of ["hr.cv-screener", "hr.leave-assistant", "procurement.supplier-onboarding-agent"]) {
      expect(findAgent(catalog, id)?.guardrails.personalData, id).toBe("sensitive");
    }
    const cv = findAgent(catalog, "hr.cv-screener")!;
    const profile = cv.workflow.find((s) => s.id === "profile");
    expect(profile?.type === "llm.extract" && profile.instructions).toMatch(/military service/);
  });

  it("gives the flagship agents an analyst's question bank in English and Turkish", () => {
    for (const id of FLAGSHIPS) {
      const agent = findAgent(catalog, id) as AgentTemplate;
      expect(agent, id).toBeDefined();
      expect(agent.builder.questions.length, id).toBeGreaterThanOrEqual(3);
      expect(agent.builder.questions.length, id).toBeLessThanOrEqual(6);
      expect(agent.builder.matchPhrases.some((p) => TURKISH.test(p)), id).toBe(true);
      expect(agent.builder.matchPhrases.some((p) => /^[a-z0-9 -]+$/.test(p)), id).toBe(true);
      for (const question of agent.builder.questions) {
        expect(question.why, `${id}:${question.id}`).toBeTruthy();
      }
    }
    const cvQuestions = findAgent(catalog, "hr.cv-screener")!.builder.questions.map((q) => q.id);
    expect(cvQuestions).toEqual(expect.arrayContaining(["cv.criteria", "cv.knockouts", "cv.fairness", "cv.talent_pool"]));
  });

  it("backs every use case with a shared-services agent and an app", () => {
    const expected: Record<string, string> = {
      "conversational-ai": "/assistant",
      "excel-automation": "/excel",
      "enterprise-search": "/search",
      "knowledge-base": "/knowledge",
      "mail-triage": "/inbox",
      "document-processing": "/documents",
    };
    for (const [id, app] of Object.entries(expected)) {
      const useCase = findUseCase(catalog, id);
      expect(useCase?.app, id).toBe(app);
      expect(useCase?.defaultAgent?.startsWith("shared-services."), id).toBe(true);
      expect(useCase?.examples.length, id).toBeGreaterThanOrEqual(3);
      expect(findAgent(catalog, useCase!.defaultAgent!)?.archetype, id).toBe(useCase?.archetype);
    }
  });
});

describe("finders", () => {
  it("find templates by id or slug", () => {
    expect(findAgent(catalog, "hr.cv-screener")?.name).toBe("CV Screener");
    expect(findAgent(catalog, "finance-invoice-processor")?.id).toBe("finance.invoice-processor");
    expect(findAgent(catalog, "hr.unknown")).toBeUndefined();
    expect(findProcess(catalog, "finance.accounts-payable")?.agents).toContain("finance.invoice-processor");
    expect(findDepartment(catalog, "legal")?.roles.map((r) => r.id)).toContain("dpo");
  });

  it("list a department's processes and agents in catalog order", () => {
    expect(processesForDepartment(catalog, "hr").map((p) => p.id)).toEqual([
      "hr.recruitment",
      "hr.onboarding",
      "hr.leave-management",
      "hr.employee-helpdesk",
    ]);
    expect(agentsForDepartment(catalog, "hr").map((a) => a.id)).toEqual([
      "hr.cv-screener",
      "hr.interview-scheduler",
      "hr.onboarding-coordinator",
      "hr.leave-assistant",
      "hr.policy-assistant",
    ]);
    expect(agentsForProcess(catalog, "shared-services.knowledge-service").map((a) => a.id)).toEqual([
      "shared-services.company-assistant",
      "shared-services.search-assistant",
    ]);
    expect(agentsForDepartment(catalog, "nope")).toEqual([]);
  });
});
