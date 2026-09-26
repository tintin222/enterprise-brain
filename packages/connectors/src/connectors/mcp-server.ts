import type { NamedAction } from "@enterprise-brain/core";
import { defineConnector, defineManifest } from "../define.ts";
import { getClientCredentialsToken } from "../http.ts";
import { McpClient, toolAnswer, type McpTool } from "../mcp-client.ts";
import type { ProposedActions } from "../named-actions.ts";
import { TLS_CONFIG } from "../tls.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import { configString, isRecord, requireConfig, requireSecret, type Rec } from "../util.ts";
import { secureUrl } from "./rest-api.ts";

/**
 * An MCP server as a connection: IT imports its tools, and each becomes a named action (read or write,
 * with the tool's own input), which AI employees use like any other, approvals included.
 */

const AUTH = { key: "auth_type" } as const;

function serverUrl(ctx: ConnectorContext): string {
  return secureUrl(requireConfig(ctx, "url", "Server URL"), "Server URL");
}

async function authHeaders(ctx: ConnectorContext): Promise<Record<string, string>> {
  const extra = configString(ctx, "default_headers");
  let headers: Record<string, string> = {};
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as unknown;
      if (!isRecord(parsed)) throw new Error("not an object");
      headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), String(v)]));
    } catch {
      throw new ConnectorError('Default headers must be a JSON object, e.g. {"X-Tenant": "acme"}', "config");
    }
  }
  switch (configString(ctx, "auth_type", "none")) {
    case "bearer":
      return { ...headers, authorization: `Bearer ${requireSecret(ctx, "bearer_token", "Bearer token")}` };
    case "header":
      return { ...headers, [requireConfig(ctx, "header_name", "Header name").toLowerCase()]: requireSecret(ctx, "header_value", "Header value") };
    case "oauth2_client_credentials": {
      const token = await getClientCredentialsToken(ctx.fetch, {
        tokenUrl: secureUrl(requireConfig(ctx, "token_url", "Token URL"), "Token URL"),
        clientId: requireConfig(ctx, "client_id", "Client ID"),
        clientSecret: requireSecret(ctx, "client_secret", "Client secret"),
        scope: configString(ctx, "scope"),
        service: "MCP server sign-in",
      });
      return { ...headers, authorization: `Bearer ${token.accessToken}` };
    }
    default:
      return headers;
  }
}

export function mcpClient(ctx: ConnectorContext): McpClient {
  return new McpClient(ctx.fetch, serverUrl(ctx), () => authHeaders(ctx), configString(ctx, "system_name", "MCP server") ?? "MCP server");
}

/** The server's tools. */
export async function mcpTools(ctx: ConnectorContext): Promise<{ server: string; tools: McpTool[] }> {
  const client = mcpClient(ctx);
  try {
    const info = await client.initialize();
    return { server: `${info.name}${info.version ? ` ${info.version}` : ""}`, tools: await client.listTools() };
  } finally {
    await client.close();
  }
}

function actionId(name: string, used: Set<string>): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = `tool_${id}`;
  let unique = id;
  for (let n = 2; used.has(unique); n++) unique = `${id}_${n}`;
  used.add(unique);
  return unique;
}

function humanize(name: string): string {
  const words = name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Actions from an MCP server's tools, for IT to review: read when the tool says it only reads, else
 * write (a person approves writes at the lower probation levels); destructive tools always ask.
 */
export function actionsFromMcpTools(tools: McpTool[]): ProposedActions {
  const used = new Set<string>();
  const warnings: string[] = [];
  const actions: NamedAction[] = tools.map((tool) => {
    const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
    if (schema.type !== undefined && schema.type !== "object") warnings.push(`${tool.name}: its input isn't an object; check it before saving`);
    const readOnly = tool.annotations?.readOnlyHint === true;
    return {
      id: actionId(tool.name, used),
      name: tool.title ?? tool.annotations?.title ?? humanize(tool.name),
      description: tool.description ?? "",
      kind: readOnly ? "read" : "write",
      ...(tool.annotations?.destructiveHint === true && !readOnly ? { requiresApproval: true } : {}),
      params: [],
      tool: tool.name,
      inputSchema: { type: "object", ...schema },
    };
  });
  if (!tools.length) warnings.push("The server offers no tools");
  return { actions, warnings };
}

const OAUTH = { ...AUTH, values: ["oauth2_client_credentials"] };

const mcpImplementation = defineConnector({
  manifest: defineManifest({
    type: "mcp-server",
    name: "MCP server",
    vendor: "Model Context Protocol",
    category: "other",
    description:
      "Any server that speaks the Model Context Protocol over HTTP (Streamable HTTP). Import its tools: each becomes an action AI employees may use, marked read or write, with approvals for writes like any other system.",
    auth: "custom",
    docsUrl: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports",
    maturity: "preview",
    config: [
      {
        key: "url",
        label: "Server URL",
        type: "url",
        required: true,
        placeholder: "https://mcp.acme.local/mcp",
        help: "The server's MCP endpoint (Streamable HTTP).",
      },
      { key: "system_name", label: "System name", type: "string", placeholder: "Quality system", help: "Shown in errors and approvals." },
      {
        key: "auth_type",
        label: "Authentication",
        type: "select",
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "bearer", label: "Bearer token" },
          { value: "header", label: "API key header" },
          { value: "oauth2_client_credentials", label: "OAuth 2.0 client credentials" },
        ],
      },
      { key: "bearer_token", label: "Bearer token", type: "password", secret: true, showWhen: { ...AUTH, values: ["bearer"] } },
      { key: "header_name", label: "Header name", type: "string", placeholder: "X-API-Key", showWhen: { ...AUTH, values: ["header"] } },
      { key: "header_value", label: "Header value", type: "password", secret: true, showWhen: { ...AUTH, values: ["header"] } },
      { key: "token_url", label: "OAuth token URL", type: "url", showWhen: OAUTH },
      { key: "client_id", label: "OAuth client ID", type: "string", showWhen: OAUTH },
      { key: "client_secret", label: "OAuth client secret", type: "password", secret: true, showWhen: OAUTH },
      { key: "scope", label: "OAuth scopes", type: "string", showWhen: OAUTH },
      { key: "default_headers", label: "Other headers (JSON)", type: "textarea", placeholder: '{"X-Tenant": "acme"}' },
      ...TLS_CONFIG,
    ],
    operations: [],
    itRequirements: [
      "The MCP server's URL (Streamable HTTP transport) reachable from Enterprise Brain",
      "Credentials for it: a bearer token, an API key header, or an OAuth 2.0 client",
      "A review of its tools after importing them: which only read, and which change data",
    ],
  }),
  async test(ctx) {
    const { server, tools } = await mcpTools(ctx);
    return { ok: true, message: `Connected to ${server}: ${tools.length} tool${tools.length === 1 ? "" : "s"}`, details: { tools: tools.map((t) => t.name) } };
  },
  operations: {},
});

/** The MCP connector: its named actions call the tools they were imported from. */
export const mcpServerConnector: ConnectorImplementation = {
  ...mcpImplementation,
  async runAction(action: NamedAction, values: Rec, ctx: ConnectorContext) {
    if (!action.tool) throw new ConnectorError(`${action.name} names no tool`, "config");
    const client = mcpClient(ctx);
    try {
      return toolAnswer(await client.callTool(action.tool, values), action.name);
    } finally {
      await client.close();
    }
  },
};
