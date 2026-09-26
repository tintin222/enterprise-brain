import { describe, expect, it } from "vitest";
import { actionsFromMcpTools, mcpServerConnector, mcpTools, withNamedActions } from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx, run, type RecordedRequest } from "./helpers.ts";

/**
 * MCP servers as connections: the client speaks Streamable HTTP (JSON or event-stream answers, a
 * session id once initialized), IT imports the server's tools as actions, and each action calls its
 * tool with the tool's own input.
 */

const URL_ = "https://mcp.acme.example/mcp";

const TOOLS = [
  {
    name: "get-nonconformance",
    title: "Get a nonconformance",
    description: "Reads a nonconformance report.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "Create.NCR",
    description: "Opens a nonconformance report.",
    inputSchema: { type: "object", properties: { part: { type: "string" }, defect: { type: "string" } }, required: ["part"] },
  },
  { name: "delete_ncr", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } },
];

/** A stand-in MCP server. `expire` makes it forget the session once. */
function server(options: { expire?: boolean } = {}) {
  let sessions = 0;
  let forget = options.expire ?? false;
  const fake = new FakeFetch();
  const current = () => `session-${sessions}`;
  fake.on("POST", URL_, (request: RecordedRequest) => {
    const message = request.json as { id?: number; method: string; params?: Record<string, unknown> };
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    if (message.method === "initialize") {
      sessions++;
      return json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Quality MCP", version: "1.2.0" } },
        },
        200,
        {
          "mcp-session-id": current(),
        },
      );
    }
    if (request.headers.get("mcp-session-id") !== current()) return json({ error: "unknown session" }, 400);
    if (forget && message.method !== "notifications/initialized") {
      forget = false;
      return new Response("session not found", { status: 404 });
    }
    expect(request.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      const second = message.params?.cursor === "page-2";
      return json({ jsonrpc: "2.0", id: message.id, result: second ? { tools: TOOLS.slice(2) } : { tools: TOOLS.slice(0, 2), nextCursor: "page-2" } });
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params as { name: string; arguments: Record<string, unknown> };
      const result =
        name === "delete_ncr"
          ? { content: [{ type: "text", text: "NCR-9 is closed and can't be deleted" }], isError: true }
          : { content: [{ type: "text", text: `${name} ok` }], structuredContent: { tool: name, args } };
      // Answered as an event stream, after a progress notification.
      const stream = [
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`,
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}`,
      ].join("\n\n");
      return new Response(`${stream}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });
  fake.on("DELETE", URL_, new Response(null, { status: 200 }));
  return { fake, sessions: () => sessions };
}

const ctxFor = (fake: FakeFetch) =>
  makeCtx({ fetch: fake.fetch, config: { url: URL_, auth_type: "bearer", system_name: "Quality system" }, secrets: { bearer_token: "mcp-token" } });

describe("MCP servers", () => {
  it("connects, and lists the tools across pages", async () => {
    const { fake } = server();
    expect(await mcpServerConnector.test(ctxFor(fake))).toMatchObject({ ok: true, message: "Connected to Quality MCP 1.2.0: 3 tools" });
    const { tools } = await mcpTools(ctxFor(fake));
    expect(tools.map((t) => t.name)).toEqual(["get-nonconformance", "Create.NCR", "delete_ncr"]);
    expect(fake.calls.every((c) => c.headers.get("authorization") === "Bearer mcp-token")).toBe(true);
    // The session ends when done.
    expect(fake.callsTo("DELETE", URL_).length).toBeGreaterThan(0);
  });

  it("proposes one action per tool: read when the tool only reads, writes asking when destructive", () => {
    const { actions } = actionsFromMcpTools(TOOLS);
    expect(actions.map((a) => [a.id, a.name, a.kind, a.requiresApproval ?? false, a.tool])).toEqual([
      ["get_nonconformance", "Get a nonconformance", "read", false, "get-nonconformance"],
      ["create_ncr", "Create ncr", "write", false, "Create.NCR"],
      ["delete_ncr", "Delete ncr", "write", true, "delete_ncr"],
    ]);
    expect(actions[0]!.inputSchema).toEqual(TOOLS[0]!.inputSchema);
  });

  it("calls the tool behind an action with the tool's own input, and reports the tool's failures", async () => {
    const { fake } = server();
    const connector = withNamedActions(mcpServerConnector, actionsFromMcpTools(TOOLS).actions);
    expect(connector.manifest.operations.find((o) => o.id === "get_nonconformance")!.input).toMatchObject({ required: ["id"] });
    const result = await run(connector, "get_nonconformance", { id: "NC-7" }, ctxFor(fake));
    expect(result).toEqual({ ok: true, text: "get-nonconformance ok", data: { tool: "get-nonconformance", args: { id: "NC-7" } } });
    expect((await expectConnectorError(run(connector, "get_nonconformance", {}, ctxFor(fake)))).message).toBe("Get a nonconformance: id is required");
    expect((await expectConnectorError(run(connector, "delete_ncr", { id: "NCR-9" }, ctxFor(fake)))).message).toBe(
      "Delete ncr failed: NCR-9 is closed and can't be deleted",
    );
  });

  it("starts a new session when the server forgot it", async () => {
    const { fake, sessions } = server({ expire: true });
    const { tools } = await mcpTools(ctxFor(fake));
    expect(tools).toHaveLength(3);
    expect(sessions()).toBe(2);
  });
});
