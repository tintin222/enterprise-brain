import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.ts";

/** An MCP server connected from Settings: its tools imported as actions, saved, and tried. */

const MCP = "https://mcp.quality.example/mcp";

describe("an MCP server connection", () => {
  let t: TestApp;
  const realFetch = globalThis.fetch;
  const calls: { method: string; name?: string; args?: unknown }[] = [];

  beforeAll(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== MCP) return realFetch(input, init);
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      calls.push({ method: message.method, name: message.params?.name, args: message.params?.arguments });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": "s1" } });
      if (message.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "Quality", version: "2" } });
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "find_batches",
              description: "Batches by status",
              inputSchema: { type: "object", properties: { status: { type: "string" } } },
              annotations: { readOnlyHint: true },
            },
            {
              name: "hold_batch",
              description: "Puts a batch on hold",
              inputSchema: { type: "object", properties: { batch: { type: "string" } }, required: ["batch"] },
            },
          ],
        });
      }
      return reply({ content: [{ type: "text", text: "3 batches" }], structuredContent: { count: 3 } });
    }) as typeof fetch;
    t = await createTestApp();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await t?.close();
  });

  it("imports the tools, saves them as actions and tries one", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/connectors",
      payload: { type: "mcp-server", name: "Quality system", values: { url: MCP } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    expect((await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${id}/test` })).json()).toMatchObject({
      ok: true,
      message: "Connected to Quality 2: 2 tools",
    });

    const proposed = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${id}/actions/import`, payload: { mcp: true } });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const actions = proposed.json().actions as { id: string; kind: string; tool: string }[];
    expect(actions.map((a) => [a.id, a.kind, a.tool])).toEqual([
      ["find_batches", "read", "find_batches"],
      ["hold_batch", "write", "hold_batch"],
    ]);

    const saved = await t.app.inject({ method: "PUT", url: `/api/companies/acme/connectors/${id}/actions`, payload: { actions } });
    expect(saved.statusCode, saved.body).toBe(200);
    const tried = await t.app.inject({
      method: "POST",
      url: `/api/companies/acme/connectors/${id}/actions/find_batches/test`,
      payload: { input: { status: "open" } },
    });
    expect(tried.json()).toMatchObject({ ok: true, result: { ok: true, text: "3 batches", data: { count: 3 } } });
    expect(calls.at(-1)).toEqual({ method: "tools/call", name: "find_batches", args: { status: "open" } });
    // A write needs confirming, as for any system.
    expect(
      (await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${id}/actions/hold_batch/test`, payload: { input: { batch: "B-1" } } }))
        .statusCode,
    ).toBe(400);
  });
});
