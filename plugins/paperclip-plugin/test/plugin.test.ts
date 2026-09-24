import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { EnterpriseBrainClient } from "../src/eb-client.ts";
import manifest, { TOOL_NAMES } from "../src/manifest.ts";
import plugin, { setClientFactory } from "../src/worker.ts";

function fakeFetch(calls: { url: string; init?: RequestInit }[]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const path = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path.endsWith("/knowledge/search")) return json({ hits: [{ title: "Annual Leave Policy", collectionKey: "hr-policies", content: "14 days", score: 1 }] });
    if (path.endsWith("/agents")) return json([{ slug: "hr-cv-screener", name: "CV Screener", status: "active", summary: "Screens CVs", archetype: "document-processing" }]);
    if (path.includes("/runs") && init?.method === "POST") return json({ id: "run-1", status: "succeeded", output: { verdict: "pass" }, error: null });
    if (path.includes("/approvals")) return json([]);
    if (path.endsWith("/dashboard")) return json({ counts: { activeAgents: 3 }, costMonthUsd: 1.5 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
}

async function setup(config: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  setClientFactory((baseUrl, company, apiKey) => new EnterpriseBrainClient(baseUrl, company, apiKey, fakeFetch(calls) as typeof fetch));
  const harness = createTestHarness({ manifest, config });
  await plugin.definition.setup(harness.ctx);
  return { harness, calls };
}

describe("Enterprise Brain Paperclip plugin", () => {
  it("declares tools and UI slots consistently", () => {
    expect(manifest.tools?.map((t) => t.name).sort()).toEqual(Object.values(TOOL_NAMES).sort());
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.ui?.slots?.map((s) => s.exportName)).toEqual(["EnterpriseBrainPage", "EnterpriseBrainSidebarLink", "EnterpriseBrainWidget"]);
  });

  it("searches knowledge through the Enterprise Brain API", async () => {
    const { harness, calls } = await setup({ enterpriseBrainUrl: "http://brain.local:3200/", company: "acme" });
    const result = await harness.executeTool<{ content?: string; error?: string }>(TOOL_NAMES.knowledgeSearch, { query: "annual leave" }, { companyId: "c1" });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("[1] Annual Leave Policy");
    expect(calls[0]!.url).toBe("http://brain.local:3200/api/companies/acme/knowledge/search");
  });

  it("runs an agent with a task and lists active agents", async () => {
    const { harness, calls } = await setup({ enterpriseBrainUrl: "http://brain.local:3200", company: "acme" });
    const agents = await harness.executeTool<{ content?: string }>(TOOL_NAMES.listAgents, {}, { companyId: "c1" });
    expect(agents.content).toContain("hr-cv-screener");
    const run = await harness.executeTool<{ content?: string }>(TOOL_NAMES.runAgent, { agent: "hr-cv-screener", task: "Screen the attached CV" }, { companyId: "c1" });
    expect(run.content).toContain("run-1");
    const body = JSON.parse(String(calls.at(-1)!.init!.body));
    expect(body).toMatchObject({ task: "Screen the attached CV", wait: true });
  });

  it("reports a clear error when not configured", async () => {
    const { harness } = await setup({});
    const result = await harness.executeTool<{ error?: string }>(TOOL_NAMES.knowledgeSearch, { query: "x" }, { companyId: "c1" });
    expect(result.error).toMatch(/Enterprise Brain URL/);
  });

  it("serves UI data without secrets", async () => {
    const { harness } = await setup({ enterpriseBrainUrl: "http://brain.local:3200", company: "acme" });
    expect(await harness.getData("config", { companyId: "c1" })).toEqual({ url: "http://brain.local:3200", company: "acme" });
    expect(await harness.getData("summary", { companyId: "c1" })).toMatchObject({ ok: true, counts: { activeAgents: 3 } });
  });
});
