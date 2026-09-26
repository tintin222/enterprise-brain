import { ConnectorError } from "./types.ts";
import { isRecord, truncate, type Rec } from "./util.ts";

/**
 * A client for MCP servers over Streamable HTTP: JSON-RPC messages are POSTed to the server's
 * endpoint, which answers with JSON or with an event stream carrying the answer. The server may give a
 * session id when initialized; it goes with every later request.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Rec;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  instructions?: string;
}

class SessionExpired extends Error {}

/** JSON-RPC messages in an event stream: each event's data lines, as JSON. */
function streamMessages(text: string): Rec[] {
  const messages: Rec[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) if (isRecord(message)) messages.push(message);
    } catch {
      // Not JSON: not a message.
    }
  }
  return messages;
}

export class McpClient {
  private session: string | undefined;
  private version = MCP_PROTOCOL_VERSION;
  private initialized: Promise<McpServerInfo> | undefined;
  private nextId = 1;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly url: string,
    /** Headers for each request (sign-in); asked each time so tokens stay fresh. */
    private readonly headers: () => Promise<Record<string, string>> = async () => ({}),
    private readonly name = "MCP server",
  ) {}

  private async send(message: Rec, answer: boolean, initialized: boolean): Promise<Rec | undefined> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...(initialized ? { "mcp-protocol-version": this.version } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(120_000),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    if (response.status === 404 && this.session && initialized) throw new SessionExpired();
    if (!response.ok) {
      const body = truncate((await response.text().catch(() => "")).trim(), 300);
      const code = response.status === 401 || response.status === 403 ? "auth" : response.status === 404 ? "not_found" : "remote";
      throw new ConnectorError(`${this.name} answered HTTP ${response.status}${body ? `: ${body}` : ""}`, code, response.status);
    }
    if (!answer) return undefined;
    const type = response.headers.get("content-type") ?? "";
    const messages = type.includes("text/event-stream") ? streamMessages(await response.text()) : [await response.json()].flat().filter(isRecord);
    const reply = messages.find((m) => m.id === message.id && ("result" in m || "error" in m));
    if (!reply) throw new ConnectorError(`${this.name} gave no answer to ${String(message.method)}`, "remote");
    if (isRecord(reply.error)) {
      throw new ConnectorError(
        `${this.name}: ${String(reply.error.message ?? "error")}${reply.error.code !== undefined ? ` (${String(reply.error.code)})` : ""}`,
        "remote",
      );
    }
    return isRecord(reply.result) ? reply.result : {};
  }

  /** Start (once): agree on the protocol version, and say the client is ready. */
  initialize(): Promise<McpServerInfo> {
    this.initialized ??= (async () => {
      const result = (await this.send(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "enterprise-brain", title: "Enterprise Brain", version: "0.1.0" },
          },
        },
        true,
        false,
      ))!;
      const version = typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
      if (!SUPPORTED_VERSIONS.has(version))
        throw new ConnectorError(`${this.name} speaks MCP ${version}; supported: ${[...SUPPORTED_VERSIONS].join(", ")}`, "unsupported");
      this.version = version;
      await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, false, true);
      const info = isRecord(result.serverInfo) ? result.serverInfo : {};
      return {
        name: typeof info.name === "string" ? info.name : this.name,
        version: typeof info.version === "string" ? info.version : "",
        protocolVersion: version,
        ...(typeof result.instructions === "string" ? { instructions: result.instructions } : {}),
      };
    })();
    this.initialized.catch(() => (this.initialized = undefined));
    return this.initialized;
  }

  /** A request; when the server forgot the session, it starts again once. */
  async request(method: string, params: Rec = {}): Promise<Rec> {
    for (let attempt = 0; ; attempt++) {
      await this.initialize();
      try {
        return (await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, true, true))!;
      } catch (error) {
        if (!(error instanceof SessionExpired) || attempt > 0)
          throw error instanceof SessionExpired ? new ConnectorError(`${this.name} ended the session`, "remote") : error;
        this.session = undefined;
        this.initialized = undefined;
      }
    }
  }

  async listTools(max = 500): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      for (const tool of Array.isArray(page.tools) ? page.tools : []) {
        if (isRecord(tool) && typeof tool.name === "string") {
          tools.push({
            name: tool.name,
            ...(typeof tool.title === "string" ? { title: tool.title } : {}),
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
            inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
            ...(isRecord(tool.annotations) ? { annotations: tool.annotations as McpTool["annotations"] } : {}),
          });
        }
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor && tools.length < max);
    return tools.slice(0, max);
  }

  async callTool(name: string, args: Rec): Promise<Rec> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** End the session (best effort). */
  async close(): Promise<void> {
    if (!this.session) return;
    await this.fetchImpl(this.url, {
      method: "DELETE",
      headers: { ...(await this.headers()), "mcp-session-id": this.session },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    this.session = undefined;
  }
}

/** A tool's answer for an AI employee: its text, and its structured data when it gives some. */
export function toolAnswer(result: Rec, tool: string): Rec {
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content
    .map((part) => {
      if (part.type === "text") return String(part.text ?? "");
      if (part.type === "resource" && isRecord(part.resource))
        return typeof part.resource.text === "string" ? part.resource.text : `[resource ${String(part.resource.uri ?? "")}]`;
      if (part.type === "resource_link") return `[${String(part.name ?? part.uri ?? "link")}] ${String(part.uri ?? "")}`;
      return `[${String(part.type ?? "content")}]`;
    })
    .join("\n")
    .trim();
  if (result.isError === true) throw new ConnectorError(`${tool} failed: ${truncate(text || "no details", 1000)}`, "remote");
  return { ok: true, text: truncate(text, 50_000), ...(isRecord(result.structuredContent) ? { data: result.structuredContent } : {}) };
}
