import { describe, expect, it } from "vitest";
import {
  cronForFrequency,
  escapeTemplateBraces,
  exportCompanyPackage,
  hermesRunBody,
  parseHermesRunRequest,
  parseSessionKey,
  PaperclipClient,
  sseFrame,
  toYaml,
  type ExportAgent,
  type ExportDepartment,
  type ExportProcess,
} from "../src/index.ts";
import { parseFrontmatterMarkdown, parseYamlFile } from "./fixtures/paperclip-yaml.ts";

const departments: ExportDepartment[] = [
  { id: "hr", name: "Human Resources", summary: "People operations", mission: "Hire and support great people", kpis: [{ id: "tth", name: "Time to hire", target: "< 30 days" }] },
  { id: "finance", name: "Finance", summary: "Money matters" },
];
const agents: ExportAgent[] = [
  { id: "hr.cv-screener", slug: "hr-cv-screener", name: "CV Screener", department: "hr", summary: "Screens CVs", instructions: 'You screen CVs.\nQuote: "fair" — ünicode', archetype: "document-processing" },
  { id: "finance.reconciliation-analyst", slug: "finance-reconciliation-analyst", name: "Reconciliation Analyst", department: "finance", summary: "Reconciles", instructions: "Reconcile accounts.", archetype: "excel-automation" },
];
const processes: ExportProcess[] = [
  {
    id: "hr.recruitment",
    department: "hr",
    name: "Recruitment",
    summary: "From application to shortlist",
    trigger: { type: "mail", description: "A CV arrives" },
    steps: [
      { id: "screen", name: "Screen CV", actor: "agent:hr.cv-screener" },
      { id: "review", name: "Recruiter review", actor: "human:recruiter", approval: true },
    ],
    agents: ["hr.cv-screener"],
  },
  {
    id: "finance.month-end-close",
    department: "finance",
    name: "Month-end close",
    summary: "Close the books",
    trigger: { type: "schedule", description: "First working day of the month" },
    frequency: "monthly",
    steps: [{ id: "reconcile", name: "Reconcile", actor: "agent:finance.reconciliation-analyst" }],
    agents: ["finance.reconciliation-analyst"],
  },
];

describe("YAML emitter", () => {
  it("round-trips through Paperclip's own parser", () => {
    const value = {
      schema: "paperclip/v1",
      agents: {
        "hr-cv-screener": {
          adapter: { type: "hermes_gateway", config: { apiBaseUrl: "http://x/api/hermes", timeoutSec: 900, payloadTemplate: { agent: "hr-cv-screener" } } },
          capabilities: 'Multi\nline "quoted" text',
          empty: {},
          list: [],
        },
      },
      routines: { r: { triggers: [{ kind: "schedule", cronExpression: "0 8 1 * *", timezone: "Europe/Istanbul" }], flag: true, n: null } },
    };
    expect(parseYamlFile(toYaml(value))).toEqual(value);
  });
});

describe("company package export", () => {
  const result = exportCompanyPackage(
    { departments, processes, agents },
    { company: { name: "Acme Endüstri", slug: "acme" }, enterpriseBrain: { url: "http://127.0.0.1:3200", companySlug: "acme" } },
  );

  it("produces the Agent Companies layout", () => {
    expect(Object.keys(result.files).sort()).toEqual(
      [
        ".paperclip.yaml",
        "COMPANY.md",
        "README.md",
        "agents/ceo/AGENTS.md",
        "agents/finance-lead/AGENTS.md",
        "agents/finance-reconciliation-analyst/AGENTS.md",
        "agents/hr-cv-screener/AGENTS.md",
        "agents/hr-lead/AGENTS.md",
        "projects/finance/PROJECT.md",
        "projects/hr/PROJECT.md",
        "skills/enterprise-brain/SKILL.md",
        "tasks/finance-month-end-close/TASK.md",
      ].sort(),
    );
    expect(result.summary).toEqual({ departments: 2, agents: 5, routines: 1 });
  });

  it("writes frontmatter Paperclip can read", () => {
    const company = parseFrontmatterMarkdown(result.files["COMPANY.md"]!);
    expect(company.frontmatter).toMatchObject({ schema: "agentcompanies/v1", name: "Acme Endüstri", slug: "acme" });
    const screener = parseFrontmatterMarkdown(result.files["agents/hr-cv-screener/AGENTS.md"]!);
    expect(screener.frontmatter).toMatchObject({ name: "CV Screener", slug: "hr-cv-screener", reportsTo: "hr-lead", skills: ["enterprise-brain"] });
    expect(screener.body).toContain('Quote: "fair" — ünicode');
    const lead = parseFrontmatterMarkdown(result.files["agents/hr-lead/AGENTS.md"]!);
    expect(lead.frontmatter).toMatchObject({ reportsTo: "ceo" });
    const ceo = parseFrontmatterMarkdown(result.files["agents/ceo/AGENTS.md"]!);
    expect(ceo.frontmatter.reportsTo).toBeNull();
    const task = parseFrontmatterMarkdown(result.files["tasks/finance-month-end-close/TASK.md"]!);
    expect(task.frontmatter).toMatchObject({ assignee: "finance-reconciliation-analyst", project: "finance", recurring: true });
    const skill = parseFrontmatterMarkdown(result.files["skills/enterprise-brain/SKILL.md"]!);
    expect(skill.frontmatter.name).toBe("enterprise-brain");
  });

  it("configures hermes_gateway adapters, project leads and routines", () => {
    const extension = parseYamlFile(result.files[".paperclip.yaml"]!) as {
      schema: string;
      agents: Record<string, { adapter?: { type: string; config: { apiBaseUrl: string; payloadTemplate: { agent: string } } } }>;
      projects: Record<string, { leadAgentSlug: string }>;
      routines: Record<string, { status: string; triggers: { kind: string; cronExpression: string }[] }>;
    };
    expect(extension.schema).toBe("paperclip/v1");
    expect(extension.agents["hr-cv-screener"]?.adapter).toMatchObject({
      type: "hermes_gateway",
      config: { apiBaseUrl: "http://127.0.0.1:3200/api/hermes", payloadTemplate: { agent: "hr-cv-screener" } },
    });
    expect(extension.agents["hr-lead"]?.adapter).toBeUndefined();
    expect(extension.projects.hr?.leadAgentSlug).toBe("hr-lead");
    expect(extension.routines["finance-month-end-close"]).toMatchObject({ status: "paused", triggers: [{ kind: "schedule", cronExpression: "0 8 1 * *" }] });
    expect(result.files[".paperclip.yaml"]).not.toMatch(/apiKey|secret/i);
  });

  it("maps frequencies to cron", () => {
    expect(cronForFrequency("weekly")).toBe("0 8 * * 1");
    expect(cronForFrequency("Every day at 8")).toBe("0 8 * * 1-5");
    expect(cronForFrequency(undefined)).toBe("0 8 * * 1");
  });
});

describe("hermes gateway contract", () => {
  it("parses run requests and session keys", () => {
    const request = parseHermesRunRequest(
      { agent: "hr-cv-screener", company: "acme", input: "Screen the attached CV", instructions: "Follow the wake", session_id: "paperclip:company:c1:agent:a1:issue:i1", extra: 1 },
      { "idempotency-key": "run-9" },
    );
    expect(request).toMatchObject({ agent: "hr-cv-screener", company: "acme", idempotencyKey: "run-9", paperclip: { companyId: "c1", agentId: "a1", issueId: "i1" } });
    expect(request.extra).toEqual({ extra: 1 });
    expect(parseSessionKey("paperclip:run:r1")).toEqual({ runId: "r1" });
    expect(() => parseHermesRunRequest({ input: "x" }, {})).toThrow(/agent/);
  });

  it("maps runs to hermes status bodies", () => {
    const base = { id: "r1", output: null, error: null, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.01 } };
    expect(hermesRunBody({ ...base, status: "running" })).toMatchObject({ status: "running", output: null });
    expect(hermesRunBody({ ...base, status: "succeeded", output: { summary: "Shortlisted" } })).toMatchObject({
      status: "completed",
      output: "Shortlisted",
      usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
      cost_usd: 0.01,
    });
    expect(hermesRunBody({ ...base, status: "waiting_approval", pendingApproval: { id: "a1", title: "Create candidate" } }).output).toContain("Create candidate");
    expect(hermesRunBody({ ...base, status: "failed", error: "boom" })).toMatchObject({ status: "failed", output: "boom" });
    expect(sseFrame("message.delta", { delta: "hi" })).toBe('event: message.delta\ndata: {"delta":"hi"}\n\n');
    expect(escapeTemplateBraces("{{ x }}")).toBe("{ { x } }");
  });
});

describe("paperclip client", () => {
  it("posts inline packages with adapter overrides", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new PaperclipClient("http://pc:3100/", "tok", async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ jobId: "j1" }), { status: 200 });
    });
    const out = await client.importCompany({
      files: { "COMPANY.md": "x" },
      rootPath: "acme",
      target: { mode: "new_company" },
      adapterOverrides: { "hr-cv-screener": { adapterType: "hermes_gateway", adapterConfig: { apiKey: "k" } } },
    });
    expect(out).toEqual({ jobId: "j1" });
    expect(calls[0]!.url).toBe("http://pc:3100/api/companies/import");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.source).toEqual({ type: "inline", rootPath: "acme", files: { "COMPANY.md": "x" } });
    expect(body.include.company).toBe(true);
    expect(body.adapterOverrides["hr-cv-screener"].adapterConfig.apiKey).toBe("k");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
});
