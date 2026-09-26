import type { JsonSchema, NamedAction } from "@enterprise-brain/core";
import { fillPath, fillTemplate } from "../named-actions.ts";
import { defineConnector, defineManifest } from "../define.ts";
import {
  basicAuth,
  getClientCredentialsToken,
  getRefreshTokenAccessToken,
  httpRequest,
  withTokenRetry,
  type HttpRequestOptions,
  type HttpResponse,
  type OAuthToken,
  type Query,
} from "../http.ts";
import { anyObject, readOp, str, writeOp } from "../schema.ts";
import { TLS_CONFIG } from "../tls.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import {
  configNumber,
  configString,
  isRecord,
  normalizeBaseUrl,
  optionalSecret,
  optRecord,
  reqString,
  requireConfig,
  requireSecret,
  truncate,
  type Input,
  type Rec,
} from "../util.ts";

const SERVICE = "REST API";
const OAUTH = { key: "auth_type", values: ["oauth2_client_credentials", "oauth2_authorization_code"] };
const CODE = { key: "auth_type", values: ["oauth2_authorization_code"] };
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

const OAUTH_TYPES = new Set(["oauth2_client_credentials", "oauth2_authorization_code"]);

/** A sign-in address: https (plain http only on this machine, for trials). */
export function secureUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError(`${label} is not a URL`, "config");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ConnectorError(`${label} must use https`, "config");
  return url.toString();
}

/** What the OAuth 2.0 settings of a connection say (for the token requests and the sign-in). */
export function oauthSettings(ctx: ConnectorContext) {
  const audience = configString(ctx, "audience");
  return {
    tokenUrl: secureUrl(requireConfig(ctx, "token_url", "Token URL"), "Token URL"),
    clientId: requireConfig(ctx, "client_id", "Client ID"),
    clientSecret: optionalSecret(ctx, "client_secret"),
    scope: configString(ctx, "scope"),
    clientAuth: configString(ctx, "token_client_auth") === "basic" ? ("basic" as const) : ("body" as const),
    extraParams: audience ? { audience } : undefined,
  };
}

/**
 * An access token for the connection: its own (client credentials), or the one its sign-in allows
 * (authorization code: the refresh token is kept, and replaced when the provider issues a new one).
 */
async function oauthToken(ctx: ConnectorContext, force: boolean): Promise<OAuthToken> {
  const settings = oauthSettings(ctx);
  const service = `${configString(ctx, "system_name", SERVICE) ?? SERVICE} sign-in`;
  if (configString(ctx, "auth_type") === "oauth2_client_credentials") {
    return getClientCredentialsToken(ctx.fetch, { ...settings, clientSecret: requireSecret(ctx, "client_secret", "Client secret"), service }, force);
  }
  const refreshToken = optionalSecret(ctx, "refresh_token");
  if (!refreshToken) throw new ConnectorError("Nobody signed in to this connection yet: use Sign in on the connection", "auth");
  const token = await getRefreshTokenAccessToken(ctx.fetch, { ...settings, refreshToken, service }, force);
  if (token.refreshToken && token.refreshToken !== refreshToken) await ctx.saveSecrets?.({ refresh_token: token.refreshToken });
  return token;
}

/** Sends a request with the connection's authentication (a fresh token once when an OAuth token was refused). */
function send<T>(ctx: ConnectorContext, url: string, options: HttpRequestOptions): Promise<HttpResponse<T>> {
  if (OAUTH_TYPES.has(configString(ctx, "auth_type") ?? "")) {
    return withTokenRetry(
      (force) => oauthToken(ctx, force),
      (token) => httpRequest<T>(ctx.fetch, url, { ...options, headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` } }),
    );
  }
  return httpRequest<T>(ctx.fetch, url, { ...options, headers: { ...options.headers, ...authHeaders(ctx) } });
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
  const headers: Record<string, string> = { ...defaultHeaders(ctx) };
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
  return { ok: true, ...describe(await send(ctx, url, options)) };
}

const pathSchema = str("Path relative to the base URL, e.g. /orders/4711 or customers?active=true");
const bodySchema: JsonSchema = { description: "Request body: JSON object/array (sent as application/json) or a string" };

const manifest = defineManifest({
  type: "rest-api",
  name: "Generic REST API",
  vendor: "Enterprise Brain",
  category: "other",
  description:
    "Calls any HTTP/JSON API of an in-house or third-party system below a configured base URL, with an API key, a bearer token, basic authentication, OAuth 2.0 (client credentials, or a sign-in once) and client certificates. Use it for systems without a dedicated connector (MES, WMS, e-invoicing portals, internal services).",
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
        { value: "oauth2_client_credentials", label: "OAuth 2.0: the connection's own credentials (client credentials)" },
        { value: "oauth2_authorization_code", label: "OAuth 2.0: someone signs in once (authorization code)" },
      ],
      help: "With a client certificate, choose the sign-in the system asks for besides it (often None).",
    },
    { key: "api_key_header", label: "API key header name", type: "string", default: "X-API-Key", showWhen: { key: "auth_type", values: ["api_key"] } },
    { key: "api_key", label: "API key", type: "password", secret: true, showWhen: { key: "auth_type", values: ["api_key"] } },
    { key: "bearer_token", label: "Bearer token", type: "password", secret: true, showWhen: { key: "auth_type", values: ["bearer"] } },
    { key: "username", label: "Username", type: "string", showWhen: { key: "auth_type", values: ["basic"] } },
    { key: "password", label: "Password", type: "password", secret: true, showWhen: { key: "auth_type", values: ["basic"] } },
    { key: "token_url", label: "OAuth token URL", type: "url", placeholder: "https://login.example.com/oauth2/token", showWhen: OAUTH },
    { key: "authorize_url", label: "OAuth sign-in URL", type: "url", placeholder: "https://login.example.com/oauth2/authorize", help: "Where people sign in.", showWhen: CODE },
    { key: "client_id", label: "OAuth client ID", type: "string", showWhen: OAUTH },
    { key: "client_secret", label: "OAuth client secret", type: "password", secret: true, showWhen: OAUTH },
    { key: "scope", label: "OAuth scopes", type: "string", placeholder: "orders.read orders.write", help: "Separated by spaces.", showWhen: OAUTH },
    { key: "audience", label: "OAuth audience", type: "string", help: "Only when the provider asks for one (e.g. Auth0).", showWhen: OAUTH },
    {
      showWhen: OAUTH,
      key: "token_client_auth",
      label: "How the client identifies itself",
      type: "select",
      default: "body",
      options: [
        { value: "body", label: "In the request (client_secret_post)" },
        { value: "basic", label: "Basic authentication (client_secret_basic)" },
      ],
    },
    {
      key: "refresh_token",
      label: "Refresh token",
      type: "password",
      secret: true,
      help: "Filled in when someone signs in (Sign in, on the connection); replaced when the provider issues a new one.",
      showWhen: CODE,
    },
    ...TLS_CONFIG,
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
    "A technical account, API key or OAuth 2.0 client with the minimal permissions the agent needs (read-only unless write operations are required)",
    "For OAuth 2.0 sign-in: register the redirect URL the connection shows with the provider",
    "For client certificates: the certificate and its private key (PEM), and your authority's certificate when the system's certificate comes from it",
    "Network access from Enterprise Brain to the API host (firewall rule, VPN or reverse proxy for internal systems)",
  ],
});

const restImplementation: ConnectorImplementation = defineConnector({
  manifest,

  async test(ctx) {
    const base = normalizeBaseUrl(requireConfig(ctx, "base_url", "Base URL"), "Base URL");
    const healthPath = configString(ctx, "health_path");
    const url = healthPath ? resolveRestUrl(base, healthPath) : base;
    // Shown to the user: without query string (it may carry credentials).
    const shown = `${new URL(url).origin}${new URL(url).pathname}`;
    try {
      const response = await send(ctx, url, {
        service: configString(ctx, "system_name", SERVICE) ?? SERVICE,
        headers: defaultHeaders(ctx),
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

/**
 * The generic REST connector. With named actions IT defines on a connection, each action is a method,
 * a path below the base URL with {params}, and query/body templates.
 */
export const restApiConnector: ConnectorImplementation = {
  ...restImplementation,
  async runAction(action: NamedAction, values: Rec, ctx: ConnectorContext) {
    if (!action.method || !action.path) throw new ConnectorError(`${action.name} has no method and path`, "config");
    const query = action.query ? (fillTemplate(action.query, values) as Rec) : undefined;
    const body = action.body !== undefined ? fillTemplate(action.body, values) : undefined;
    return call(ctx, action.method, {
      path: fillPath(action.path, values),
      ...(query && Object.values(query).some((v) => v !== undefined && v !== "") ? { query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== "")) } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  },
};
