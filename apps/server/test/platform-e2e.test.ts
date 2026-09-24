import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.ts";

let t: TestApp;
const base = "/api/companies/acme";

beforeAll(async () => {
  t = await createTestApp({ config: { hermesApiKey: "hermes-secret" } });
});
afterAll(async () => {
  await t?.close();
});

describe("instance & catalog", () => {
  it("reports health, info and the demo company", async () => {
    expect((await t.app.inject("/api/health")).json()).toMatchObject({ ok: true });
    const info = (await t.app.inject("/api/info")).json();
    expect(info).toMatchObject({ defaultCompany: "acme", llm: { available: false }, database: "pglite" });
    const dashboard = (await t.app.inject(`${base}/dashboard`)).json();
    expect(dashboard.counts.activeAgents).toBeGreaterThan(5);
    expect(dashboard.counts.knowledgeDocuments).toBeGreaterThan(5);
  });

  it("answers 404 for unknown knowledge documents", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await t.app.inject(`${base}/knowledge/documents/${id}`);
      expect(res.statusCode, res.body).toBe(404);
    }
  });

  it("serves the catalog and installs a department", async () => {
    const catalog = (await t.app.inject("/api/catalog")).json();
    expect(catalog.departments.length).toBeGreaterThanOrEqual(10);
    expect(catalog.useCases.length).toBe(6);
    const legal = await t.app.inject({ method: "POST", url: `${base}/catalog/departments/legal/install`, payload: { activate: false } });
    expect(legal.statusCode, legal.body).toBe(200);
    expect(legal.json().agents.length).toBeGreaterThan(0);
    const departments = (await t.app.inject(`${base}/departments`)).json();
    expect(departments.map((d: any) => d.key)).toEqual(expect.arrayContaining(["hr", "finance", "legal"]));
  });
});

describe("knowledge & conversational AI", () => {
  it("answers from the knowledge base with citations (offline retrieval mode)", async () => {
    const search = (await t.app.inject({ method: "POST", url: `${base}/knowledge/search`, payload: { query: "how many days of annual leave" } })).json();
    expect(search.hits[0].title).toMatch(/leave/i);
    const conversation = (await t.app.inject({ method: "POST", url: `${base}/chat/conversations`, payload: {} })).json();
    const answer = (
      await t.app.inject({ method: "POST", url: `${base}/chat/conversations/${conversation.id}/messages`, payload: { text: "Yıllık izin hakkım kaç gün?" } })
    ).json();
    expect(answer.role).toBe("assistant");
    expect(answer.citations.length).toBeGreaterThan(0);
  });
});

describe("mail triage with approvals", () => {
  it("processes a customer email, drafts a reply and sends it only after approval", async () => {
    const agents = (await t.app.inject(`${base}/agents?status=active`)).json();
    const triage = agents.find((a: any) => a.templateId === "customer-service.mail-triage") ?? agents.find((a: any) => a.archetype === "mail-triage");
    expect(triage, "a mail triage agent is installed").toBeTruthy();
    const inbox = (await t.app.inject(`${base}/mail/messages?direction=inbound`)).json();
    const complaint = inbox.find((m: any) => m.subject.includes("SO-80017"));
    expect(complaint).toBeTruthy();
    const run = (await t.app.inject({ method: "POST", url: `${base}/mail/messages/${complaint.id}/process`, payload: { agent: triage.slug } })).json();
    expect(["succeeded", "waiting_approval"]).toContain(run.status);
    const detail = (await t.app.inject(`${base}/runs/${run.id}`)).json();
    expect(detail.events.some((e: any) => e.type === "step.completed")).toBe(true);

    const pending = (await t.app.inject(`${base}/approvals?status=pending`)).json().filter((a: any) => a.runId === run.id);
    for (const approval of pending) {
      const decided = await t.app.inject({ method: "POST", url: `${base}/approvals/${approval.id}/decide`, payload: { approved: true, note: "Looks good" } });
      expect(decided.statusCode, decided.body).toBe(200);
    }
    const after = (await t.app.inject(`${base}/runs/${run.id}`)).json();
    expect(["succeeded", "waiting_approval"]).toContain(after.run.status);
    const history = (await t.app.inject(`${base}/activity`)).json();
    expect(history.some((h: any) => h.action === "run.started")).toBe(true);
  });

  it("routes a newly delivered email to the agents listening on that mailbox", async () => {
    const boxes = (await t.app.inject(`${base}/mail/mailboxes`)).json();
    // Template placeholder addresses (careers@company.com) were localized to the company's mail domain on install.
    expect(boxes.map((b: any) => b.mailbox)).toContain("careers@acme.com.tr");
    expect(boxes.some((b: any) => b.mailbox.endsWith("@company.com"))).toBe(false);
    // The support mailbox's triage agent takes every email (the careers mailbox only takes emails with a CV attached).
    const listened = boxes.find((b: any) => b.agents.some((a: any) => a.status === "active" && /triage/.test(a.slug)));
    expect(listened, "the mail triage agent listens on a mailbox").toBeTruthy();
    const res = await t.app.inject({
      method: "POST",
      url: `${base}/mail/messages`,
      payload: { mailbox: listened.mailbox, from: "customer@example.com", subject: "Where is my order SO-80011?", body: "Please update me on my delivery." },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().runs.length).toBeGreaterThan(0);
  });
});

describe("Paperclip integration", () => {
  it("exports the installed organisation as an Agent Companies package", async () => {
    const pkg = (await t.app.inject(`${base}/paperclip/package?scope=installed`)).json();
    expect(pkg.files["COMPANY.md"]).toContain("schema: \"agentcompanies/v1\"");
    expect(pkg.files[".paperclip.yaml"]).toContain('type: "hermes_gateway"');
    expect(pkg.files[".paperclip.yaml"]).toContain('apiBaseUrl: "http://brain.test/api/hermes"');
    expect(Object.keys(pkg.files).some((f) => f.startsWith("agents/hr-lead/"))).toBe(true);
    const zip = await t.app.inject(`${base}/paperclip/package.zip`);
    expect(zip.headers["content-type"]).toBe("application/zip");
  });

  it("runs an agent for a Paperclip heartbeat through the Hermes gateway contract", async () => {
    const unauthorized = await t.app.inject({ method: "POST", url: "/api/hermes/v1/runs", payload: { agent: "x", input: "y" } });
    expect(unauthorized.statusCode).toBe(401);
    const headers = { authorization: "Bearer hermes-secret", "idempotency-key": "pc-run-1", "x-hermes-session-key": "paperclip:company:c1:agent:a1:issue:i1" };
    const agents = (await t.app.inject(`${base}/agents?status=active`)).json();
    const assistant = agents.find((a: any) => a.archetype === "conversational") ?? agents[0];
    const created = await t.app.inject({
      method: "POST",
      url: "/api/hermes/v1/runs",
      headers,
      payload: { agent: assistant.slug, company: "acme", input: "Summarise our remote work policy for a new employee.", instructions: "Follow the wake" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const runId = created.json().run_id;
    // Idempotent on Paperclip's run id.
    const again = await t.app.inject({ method: "POST", url: "/api/hermes/v1/runs", headers, payload: { agent: assistant.slug, input: "again" } });
    expect(again.json().run_id).toBe(runId);
    let status = "running";
    for (let i = 0; i < 50 && (status === "running" || status === "queued"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await t.app.inject({ method: "GET", url: `/api/hermes/v1/runs/${runId}`, headers })).json().status;
    }
    const final = (await t.app.inject({ method: "GET", url: `/api/hermes/v1/runs/${runId}`, headers })).json();
    expect(final.status).toBe("completed");
    expect(typeof final.output).toBe("string");
    expect(final.usage).toHaveProperty("input_tokens");
    const events = await t.app.inject({ method: "GET", url: `/api/hermes/v1/runs/${runId}/events`, headers });
    expect(events.body).toContain("event: run.completed");
  });

  it("exposes tools over MCP (stateless Streamable HTTP)", async () => {
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const init = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    });
    expect(init.statusCode, init.body).toBe(200);
    expect(init.body).toContain("enterprise-brain");
    const list = await t.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
    expect(list.body).toContain("knowledge_search");
    expect(list.body).toContain("erp__get_purchase_order");
    const call = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "knowledge_search", arguments: { query: "hotel limit" } } },
    });
    expect(call.body).toMatch(/Travel/);
  });
});
