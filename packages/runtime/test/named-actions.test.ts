import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * Named actions from the AI employees' side: a web service connection with IT's actions offers only
 * those, IT's "always ask" holds at every level, and a watched action starts duties.
 */

const orders: { number: string; created_at: string }[] = [];
const notes: unknown[] = [];
let server: Server;
let base: string;
let platform: Platform;
let companyId: string;
let connectionId: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/api/customers/C-1001") return reply(200, { id: "C-1001", name: "Kaya Çelik", balance: 1200 });
    if (request.method === "POST" && url.pathname === "/api/customers/C-1001/notes") {
      notes.push(JSON.parse(body));
      return reply(201, { saved: true });
    }
    if (request.method === "GET" && url.pathname === "/api/orders") {
      const after = url.searchParams.get("created_after") ?? "";
      return reply(200, { items: orders.filter((o) => o.created_at > after) });
    }
    return reply(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-actions-")), inMemory: true, llm: new UnavailableLlm(), embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  const crm = await platform.connectors.create(companyId, { type: "rest-api", name: "CRM", values: { base_url: base } });
  connectionId = crm.id;
  await platform.connectors.setActions(companyId, connectionId, [
    {
      id: "get_customer",
      name: "Get customer",
      description: "A customer's master data and open balance",
      kind: "read",
      method: "GET",
      path: "/customers/{customer_id}",
      params: [{ key: "customer_id", required: true }],
    },
    {
      id: "add_note",
      name: "Add a note to a customer",
      kind: "write",
      requiresApproval: true,
      method: "POST",
      path: "/customers/{customer_id}/notes",
      body: { text: "{text}" },
      params: [
        { key: "customer_id", required: true },
        { key: "text", required: true },
      ],
    },
    {
      id: "new_orders",
      name: "New orders",
      kind: "read",
      method: "GET",
      path: "/orders",
      query: { created_after: "{since}" },
      params: [{ key: "since" }],
      watch: { cursorField: "created_at", idField: "number" },
    },
  ]);
  const binding = [{ ref: "crm", category: "other" as const, instanceId: connectionId }];
  await platform.agents.create(companyId, {
    status: "active",
    probation: "trusted",
    definition: {
      slug: "account-helper",
      name: "Account Helper",
      summary: "Looks customers up and notes calls.",
      archetype: "process-automation",
      instructions: "Help account managers.",
      inputs: [{ key: "customer", type: "string", required: true }],
      connectors: binding,
      workflow: [
        { id: "lookup", type: "connector", connector: "crm", operation: "get_customer", input: { customer_id: "{{ input.customer }}" } },
        { id: "note", type: "connector", connector: "crm", operation: "add_note", input: { customer_id: "{{ input.customer }}", text: "Balance {{ steps.lookup.data.balance }} checked" } },
      ],
      guardrails: { approvalRequiredFor: [], personalData: "none" },
    },
  });
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "order-watcher",
      name: "Order Watcher",
      summary: "Welcomes every new order.",
      archetype: "process-automation",
      instructions: "Watch orders.",
      connectors: binding,
      triggers: [{ type: "connector-event", connector: "crm", event: "new:new_orders" }],
      workflow: [{ id: "result", type: "output", value: { order: "{{ input.event.number }}" } }],
    },
  });
});
afterAll(async () => {
  await platform?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("named actions in use", () => {
  it("offers AI employees only IT's actions on the connection", async () => {
    const resolved = await platform.connectors.resolve(companyId, { ref: "crm", category: "other", instanceId: connectionId });
    expect(resolved.impl.manifest.operations.map((o) => o.id)).toEqual(["get_customer", "add_note", "new_orders"]);
  });

  it("reads alone, but asks a person before an action IT marked, even when trusted", async () => {
    const run = await platform.engine.start(companyId, "account-helper", { customer: "C-1001" });
    expect(run.status).toBe("waiting_approval");
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    expect(approval).toMatchObject({ title: "Add a note to a customer in CRM", reason: "IT asks a person to approve every use of this action" });
    expect(approval!.action).toMatchObject({ operation: "add_note", input: { customer_id: "C-1001", text: "Balance 1200 checked" } });
    expect(notes).toEqual([]);
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Burak" });
    expect(notes).toEqual([{ text: "Balance 1200 checked" }]);
    expect((await platform.engine.getRow(companyId, run.id)).status).toBe("succeeded");
  });

  it("starts a duty for each new item a watched action reports", async () => {
    await platform.watchers.pollCompany(companyId, { wait: true });
    orders.push({ number: "SO-7000200", created_at: new Date(Date.now() + 60_000).toISOString() });
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 1, errors: [] });
    const task = (await platform.tasks.list(companyId)).find((t) => t.source === "connector-event");
    expect(task).toMatchObject({ title: "Order Watcher: SO-7000200", status: "done" });
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 0 });
  });

  it("refuses actions that don't fit the connection", async () => {
    await expect(platform.connectors.setActions(companyId, connectionId, [{ id: "x", name: "X", kind: "read", sql: "SELECT 1" }])).rejects.toThrow(/needs a method and a path/);
    await expect(
      platform.connectors.setActions(companyId, connectionId, [
        { id: "a", name: "A", kind: "read", method: "GET", path: "/a" },
        { id: "a", name: "A again", kind: "read", method: "GET", path: "/b" },
      ]),
    ).rejects.toThrow(/Two actions are called a/);
  });
});
