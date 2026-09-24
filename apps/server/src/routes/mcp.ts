import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { operationToolName } from "@enterprise-brain/connectors";
import type { CompanyRow } from "@enterprise-brain/runtime";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";
import { VERSION } from "./core.ts";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Enterprise Brain as an MCP server: knowledge, agents, approvals and read-only
 * operations of the connected (or sandbox) enterprise systems. Paperclip can
 * attach it as a governed remote MCP connection; Claude Code / Claude Desktop
 * can use it directly. Writes stay inside Enterprise Brain's approval gates.
 */
async function toolsFor(ctx: AppContext, company: CompanyRow): Promise<McpTool[]> {
  const { platform } = ctx;
  const tools: McpTool[] = [
    {
      name: "knowledge_search",
      description: "Search the company knowledge base (policies, procedures, product docs). Returns numbered passages to cite.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, collections: { type: "array", items: { type: "string" } }, top_k: { type: "number" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, title: "Search knowledge" },
      run: async (args) => {
        const hits = await platform.knowledge.search(company.id, String(args.query), {
          collections: Array.isArray(args.collections) ? (args.collections as string[]) : undefined,
          topK: Number(args.top_k ?? 6),
        });
        return hits.map((h, i) => ({ n: i + 1, title: h.title, collection: h.collectionKey, content: h.content, score: h.score }));
      },
    },
    {
      name: "list_agents",
      description: "List the company's Enterprise Brain agents with their inputs, so you can pick one to run.",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
      annotations: { readOnlyHint: true, title: "List agents" },
      run: async (args) =>
        (await platform.agents.list(company.id, { status: args.status ? String(args.status) : undefined })).map((a) => ({
          slug: a.row.slug,
          name: a.row.name,
          status: a.row.status,
          summary: a.definition.summary,
          inputs: a.definition.inputs.map((f) => ({ key: f.key, type: f.type, required: f.required ?? false })),
        })),
    },
    {
      name: "run_agent",
      description:
        "Run an Enterprise Brain agent. Give structured `input` matching its inputs, or a free-form `task`. Actions that change other systems wait for human approval.",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string" }, input: { type: "object" }, task: { type: "string" } },
        required: ["agent"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Run agent" },
      run: async (args) => {
        const run = await platform.engine.start(company.id, String(args.agent), (args.input as Record<string, unknown>) ?? {}, {
          trigger: "mcp",
          task: args.task ? String(args.task) : undefined,
          wait: true,
          actor: "mcp",
        });
        return { run_id: run.id, status: run.status, output: run.output, error: run.error };
      },
    },
    {
      name: "get_run",
      description: "Get the status, output and timeline of an agent run.",
      inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      annotations: { readOnlyHint: true, title: "Get run" },
      run: async (args) => {
        const { run, events, approvals } = await platform.engine.get(company.id, String(args.run_id));
        return { status: run.status, output: run.output, error: run.error, events: events.map((e) => `${e.type}: ${e.message}`), approvals };
      },
    },
    {
      name: "list_approvals",
      description: "List actions waiting for a human decision.",
      inputSchema: { type: "object", properties: { status: { type: "string", default: "pending" } } },
      annotations: { readOnlyHint: true, title: "List approvals" },
      run: async (args) => platform.engine.listApprovals(company.id, { status: String(args.status ?? "pending") }),
    },
  ];

  const instances = await platform.connectors.list(company.id);
  const types = new Set([...instances.map((i) => i.type), ...platform.connectors.catalog().filter((m) => m.maturity === "sandbox").map((m) => m.type)]);
  for (const type of types) {
    const impl = platform.connectors.registry.get(type);
    if (!impl) continue;
    for (const op of impl.manifest.operations.filter((o) => o.kind === "read")) {
      tools.push({
        name: operationToolName(type.replace(/^sandbox-/, ""), op.id),
        description: `[${impl.manifest.name}] ${op.description}`,
        inputSchema: { type: "object", properties: {}, ...(op.input as Record<string, unknown>) },
        annotations: { readOnlyHint: true, title: `${impl.manifest.name}: ${op.name}` },
        run: (args) => platform.connectors.executeByType(company.id, type, op.id, args),
      });
    }
  }
  return tools;
}

export async function mcpRoutes(app: FastifyInstance, ctx: AppContext) {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const ref = (request.params as { company?: string }).company ?? ctx.config.defaultCompany.slug;
    const company = await ctx.platform.company(ref);
    if (!company) throw new HttpError(404, `Company "${ref}" not found`);
    const tools = await toolsFor(ctx, company);
    const server = new Server({ name: "enterprise-brain", version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" }, annotations: t.annotations })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = tools.find((t) => t.name === call.params.name);
      if (!tool) return { content: [{ type: "text", text: `Unknown tool ${call.params.name}` }], isError: true };
      try {
        const result = await tool.run((call.params.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
    // Stateless Streamable HTTP: one server/transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };
  for (const path of ["/mcp", "/mcp/:company"]) {
    app.post(path, handle);
    app.get(path, async (_request, reply) => reply.code(405).send({ error: "Use POST (stateless Streamable HTTP)" }));
    app.delete(path, async (_request, reply) => reply.code(405).send({ error: "Sessions are not used" }));
  }
}
