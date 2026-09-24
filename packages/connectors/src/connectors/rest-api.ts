import type { JsonSchema } from "@enterprise-brain/core";
import { defineConnector, defineManifest } from "../define.ts";
import { basicAuth, httpRequest, type HttpRequestOptions, type HttpResponse, type Query } from "../http.ts";
import { anyObject, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import {
  configNumber,
  configString,
  isRecord,
  normalizeBaseUrl,
  optRecord,
  reqString,
  requireConfig,
  requireSecret,
  truncate,
  type Input,
  type Rec,
} from "../util.ts";

const SERVICE = "REST API";
const MAX_TEXT = 200_000;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Resolves an operation path against the configured base URL. Absolute URLs,
 * protocol-relative URLs and "../" escapes are rejected so agents can only
 * reach endpoints below the base URL the administrator configured.
 */
export function resolveRestUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.includes("\\")) {
    throw new ConnectorError(`path must be relative to the base URL (got "${path}")`, "validation");
  }
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  const resolved = new URL(path.replace(/^\/+/, ""), base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new ConnectorError(`path "${path}" points outside of the configured base URL`, "validation");
  }
  return resolved.toString();
}

function defaultHeaders(ctx: ConnectorContext): Record<string, string> {
  const raw = configString(ctx, "default_headers");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectorError("Default headers must be a JSON object, e.g. {\"X-Tenant\": \"acme\"}", "config");
  }
  if (!isRecord(parsed)) throw new ConnectorError("Default headers must be a JSON object", "config");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function authHeaders(ctx: ConnectorContext): Record<string, string> {
  switch (configString(ctx, "auth_type", "none")) {
    case "api_key":
      return { [(configString(ctx, "api_key_header", "X-API-Key") ?? "X-API-Key").toLowerCase()]: requireSecret(ctx, "api_key", "API key") };
    case "bearer":
      return { authorization: `Bearer ${requireSecret(ctx, "bearer_token", "Bearer token")}` };
    case "basic":
      return { authorization: basicAuth(requireConfig(ctx, "username", "Username"), requireSecret(ctx, "password", "Password")) };
    case "none":
      return {};
    default:
      throw new ConnectorError(`Unknown auth_type "${String(ctx.config.auth_type)}"`, "config");
  }
}

function queryParams(input: Input): Query | undefined {
  const query = optRecord(input, "query");
  if (!query) return undefined;
  const out: Query = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.map((v) => (isRecord(v) ? JSON.stringify(v) : String(v))) : isRecord(value) ? JSON.stringify(value) : String(value);
  }
  return out;
}

function describe(response: HttpResponse): Rec {
  const data = typeof response.data === "string" ? truncate(response.data, MAX_TEXT) : response.data;
  return {
    status: response.status,
    content_type: response.headers.get("content-type"),
    location: response.headers.get("location") ?? undefined,
    data: data ?? null,
  };
}

async function call(ctx: ConnectorContext, method: Method, input: Input): Promise<Rec> {
  const base = normalizeBaseUrl(requireConfig(ctx, "base_url", "Base URL"), "Base URL");
  const url = resolveRestUrl(base, reqString(input, "path"));
  const headers: Record<string, string> = { ...defaultHeaders(ctx), ...authHeaders(ctx) };
  const options: HttpRequestOptions = {
    method,
    service: configString(ctx, "system_name", SERVICE) ?? SERVICE,
    query: queryParams(input),
    headers,
    timeoutMs: configNumber(ctx, "timeout_ms", 30_000),
  };
  const body = input.body;
  if ((method === "POST" || method === "PUT" || method === "PATCH") && body !== undefined && body !== null) {
    if (typeof body === "string") {
      options.body = body;
      headers["content-type"] ??= "text/plain; charset=utf-8";
    } else {
      options.json = body;
    }
  }
  return { ok: true, ...describe(await httpRequest(ctx.fetch, url, options)) };
}

const pathSchema = str("Path relative to the base URL, e.g. /orders/4711 or customers?active=true");
const bodySchema: JsonSchema = { description: "Request body: JSON object/array (sent as application/json) or a string" };

const manifest = defineManifest({
  type: "rest-api",
  name: "Generic REST API",
  vendor: "Enterprise Brain",
  category: "other",
  description:
    "Calls any HTTP/JSON API of an in-house or third-party system below a configured base URL, with API key, bearer token or basic authentication. Use it for systems without a dedicated connector (MES, WMS, e-invoicing portals, internal services).",
  auth: "custom",
  maturity: "preview",
  config: [
    { key: "base_url", label: "Base URL", type: "url", required: true, placeholder: "https://erp-gateway.acme.local/api/v1" },
    { key: "system_name", label: "System name", type: "string", placeholder: "Warehouse API", help: "Shown in error messages." },
    {
      key: "auth_type",
      label: "Authentication",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "None" },
        { value: "api_key", label: "API key header" },
        { value: "bearer", label: "Bearer token" },
        { value: "basic", label: "Basic authentication" },
      ],
    },
    { key: "api_key_header", label: "API key header name", type: "string", default: "X-API-Key" },
    { key: "api_key", label: "API key", type: "password", secret: true },
    { key: "bearer_token", label: "Bearer token", type: "password", secret: true },
    { key: "username", label: "Username", type: "string" },
    { key: "password", label: "Password", type: "password", secret: true },
    { key: "default_headers", label: "Default headers (JSON)", type: "textarea", placeholder: "{\"X-Tenant\": \"acme\"}" },
    { key: "health_path", label: "Health check path", type: "string", placeholder: "/health", help: "Called by 'Test connection' (default: the base URL)." },
    { key: "timeout_ms", label: "Timeout (ms)", type: "number", default: 30_000 },
  ],
  operations: [
    readOp("http_get", "HTTP GET", "Read data: GET <base URL>/<path> with optional query parameters.", {
      path: pathSchema,
      query: anyObject("Query parameters, e.g. {\"status\": \"open\", \"limit\": 50}"),
    }, ["path"]),
    writeOp("http_post", "HTTP POST", "Create data / trigger an action: POST a body to <base URL>/<path>.", { path: pathSchema, body: bodySchema, query: anyObject("Query parameters") }, ["path", "body"]),
    writeOp("http_put", "HTTP PUT", "Replace a resource: PUT a body to <base URL>/<path>.", { path: pathSchema, body: bodySchema, query: anyObject("Query parameters") }, ["path", "body"]),
    writeOp("http_patch", "HTTP PATCH", "Partially update a resource: PATCH a body to <base URL>/<path>.", { path: pathSchema, body: bodySchema, query: anyObject("Query parameters") }, ["path", "body"]),
    writeOp("http_delete", "HTTP DELETE", "Delete a resource at <base URL>/<path>.", { path: pathSchema, query: anyObject("Query parameters") }, ["path"]),
  ],
  itRequirements: [
    "Base URL of the API and its documentation (OpenAPI/Swagger if available)",
    "A technical account or API key with the minimal permissions the agent needs (read-only unless write operations are required)",
    "Network access from Enterprise Brain to the API host (firewall rule, VPN or reverse proxy for internal systems)",
  ],
});

export const restApiConnector: ConnectorImplementation = defineConnector({
  manifest,

  async test(ctx) {
    const base = normalizeBaseUrl(requireConfig(ctx, "base_url", "Base URL"), "Base URL");
    const healthPath = configString(ctx, "health_path");
    const url = healthPath ? resolveRestUrl(base, healthPath) : base;
    // Shown to the user: without query string (it may carry credentials).
    const shown = `${new URL(url).origin}${new URL(url).pathname}`;
    try {
      const response = await httpRequest(ctx.fetch, url, {
        service: configString(ctx, "system_name", SERVICE) ?? SERVICE,
        headers: { ...defaultHeaders(ctx), ...authHeaders(ctx) },
        responseType: "text",
        timeoutMs: configNumber(ctx, "timeout_ms", 30_000),
      });
      return { ok: true, message: `Reached ${shown} (HTTP ${response.status}).`, details: { status: response.status } };
    } catch (error) {
      // Any answer other than an authentication failure or a server error proves connectivity.
      if (error instanceof ConnectorError && (error.code === "not_found" || error.code === "validation")) {
        return { ok: true, message: `Reached ${shown} (HTTP ${error.status ?? "?"}); set a health check path for a stricter test.`, details: { status: error.status } };
      }
      throw error;
    }
  },

  operations: {
    http_get: (input, ctx) => call(ctx, "GET", input),
    http_post: (input, ctx) => call(ctx, "POST", input),
    http_put: (input, ctx) => call(ctx, "PUT", input),
    http_patch: (input, ctx) => call(ctx, "PATCH", input),
    http_delete: (input, ctx) => call(ctx, "DELETE", input),
  },
});
