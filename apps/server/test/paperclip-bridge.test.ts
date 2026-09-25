import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm } from "@enterprise-brain/llm";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Enterprise Brain agents as Paperclip employees, against a stand-in Paperclip that records what it
 * receives: push creates an API key per agent; a finished run sets the issue's disposition as the
 * agent (inside the Paperclip run); approvals decided later close the issue with the board key.
 */
interface Recorded {
  method: string;
  path: string;
  auth?: string;
  runId?: string;
  body: Record<string, unknown>;
}

const issue = { id: "iss-1", identifier: "ACM-9", title: "Register the Kaya Çelik invoice", description: "Invoice INV-TEST-1 from SUP-1001 arrived by post.", status: "todo" };
const calls: Recorded[] = [];
let paperclip: Server;
let paperclipUrl = "";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const llm = new ScriptedLlm({
  "runtime.agent:hr-policy-assistant": { tools: () => ({ text: "New employees get 14 working days of annual leave." }) },
  "runtime.agent:finance-invoice-processor": {
    tools: (request, turn) => {
      const post = request.tools.find((t) => t.name.endsWith("post_supplier_invoice"));
      return turn === 1 && post
        ? {
            calls: [
              {
                name: post.name,
                input: { supplier_id: "SUP-1001", invoice_number: "INV-TEST-1", invoice_date: "2026-09-15", currency: "TRY", net_amount: 1000, tax_amount: 200, total_amount: 1200 },
              },
            ],
          }
        : { text: "I prepared the posting of INV-TEST-1; it waits for approval." };
    },
  },
});

let t: TestApp;
const hermesKey = "test-hermes-key";

beforeAll(async () => {
  paperclip = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://paperclip.test");
    const body = request.method === "GET" ? {} : await readBody(request);
    calls.push({ method: request.method ?? "GET", path: url.pathname, auth: request.headers.authorization, runId: request.headers["x-paperclip-run-id"] as string | undefined, body });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/api/companies/import") {
      const files = ((body.source as { files?: Record<string, string> })?.files ?? {}) as Record<string, string>;
      const slugs = Object.keys(files).map((path) => path.match(/^agents\/([^/]+)\/AGENTS\.md$/)?.[1]).filter(Boolean) as string[];
      return json(200, { company: { id: "pc-co", action: "created" }, agents: slugs.map((slug) => ({ slug, id: `pc-${slug}`, action: "created" })) });
    }
    const key = url.pathname.match(/^\/api\/agents\/([^/]+)\/keys$/);
    if (request.method === "POST" && key) return json(201, { id: `key-${key[1]}`, token: `tok-${key[1]}` });
    if (url.pathname === `/api/issues/${issue.id}`) {
      if (request.method === "PATCH" && typeof body.status === "string") issue.status = body.status;
      return json(200, issue);
    }
    if (url.pathname === `/api/issues/${issue.id}/comments`) return json(200, [{ id: "c1", body: "Please post it today.", authorUserId: "u1" }]);
    return json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => paperclip.listen(0, "127.0.0.1", resolve));
  paperclipUrl = `http://127.0.0.1:${(paperclip.address() as AddressInfo).port}`;
  t = await createTestApp({ llm, config: { paperclip: { url: paperclipUrl }, hermesApiKey: hermesKey } });
});

afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => paperclip?.close(() => resolve()));
});

async function hermesRun(agent: string, paperclipAgentId: string, paperclipRunId: string) {
  const headers = {
    authorization: `Bearer ${hermesKey}`,
    "idempotency-key": paperclipRunId,
    "x-hermes-session-key": `paperclip:company:pc-co:agent:${paperclipAgentId}:issue:${issue.id}`,
  };
  const created = await t.app.inject({ method: "POST", url: "/api/hermes/v1/runs", headers, payload: { agent, company: "acme", input: "You are an AI agent employee in a Paperclip-managed company. …" } });
  expect(created.statusCode, created.body).toBe(200);
  const runId = created.json().run_id as string;
  for (let i = 0; i < 50; i++) {
    const status = await t.app.inject({ method: "GET", url: `/api/hermes/v1/runs/${runId}`, headers });
    if (status.json().status !== "running" && status.json().status !== "queued") return { runId, final: status.json() };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not finish");
}

const patches = () => calls.filter((c) => c.method === "PATCH" && c.path === `/api/issues/${issue.id}`);

describe("Enterprise Brain agents as Paperclip employees", () => {
  it("creates a Paperclip API key for every Enterprise Brain agent on push", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/companies/acme/paperclip/push", payload: { target: "new_company" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().agentKeys).toBeGreaterThan(0);
    expect(calls.some((c) => c.path === "/api/agents/pc-hr-policy-assistant/keys")).toBe(true);
    const connection = (await t.app.inject("/api/companies/acme/paperclip/connection")).json();
    expect(connection.paperclip.agentsWithKeys).toBe(res.json().agentKeys);
    expect(connection.hermes.apiKey).toBe(hermesKey);
  });

  it("works from the issue itself and marks it done as the agent, inside the Paperclip run", async () => {
    const { final } = await hermesRun("hr-policy-assistant", "pc-hr-policy-assistant", "pc-run-1");
    expect(final.status).toBe("completed");
    const prompt = JSON.stringify(llm.calls.find((c) => c.purpose === "runtime.agent:hr-policy-assistant.task")?.request);
    expect(prompt).toContain("Task ACM-9 assigned to you in Paperclip: Register the Kaya Çelik invoice");
    expect(prompt).toContain("Please post it today.");
    const [patch] = patches();
    expect(patch).toMatchObject({ auth: "Bearer tok-pc-hr-policy-assistant", runId: "pc-run-1", body: { status: "done" } });
  });

  it("blocks the issue while an action waits for approval, and closes it once approved", async () => {
    issue.status = "todo";
    calls.length = 0;
    const { final } = await hermesRun("finance-invoice-processor", "pc-finance-invoice-processor", "pc-run-2");
    expect(final.status).toBe("completed");
    const [blocked] = patches();
    expect(blocked).toMatchObject({ auth: "Bearer tok-pc-finance-invoice-processor", runId: "pc-run-2", body: { status: "blocked" } });
    expect(String(blocked!.body.comment)).toMatch(/Waiting for approval in Enterprise Brain: \*\*.+\*\*/);

    const [approval] = (await t.app.inject("/api/companies/acme/approvals?status=pending")).json();
    const decided = await t.app.inject({ method: "POST", url: `/api/companies/acme/approvals/${approval.id}/decide`, payload: { approved: true, note: "OK" } });
    expect(decided.statusCode, decided.body).toBe(200);
    for (let i = 0; i < 50 && patches().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const closed = patches()[1];
    expect(closed?.runId).toBeUndefined(); // the Paperclip run has ended: the board closes the issue
    expect(closed?.body.status).toBe("done");
    expect(String(closed?.body.comment)).toMatch(/^Approved in Enterprise Brain by /);
    expect(issue.status).toBe("done");
  });
});
