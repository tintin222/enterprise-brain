import { createHash } from "node:crypto";
import { ConnectorError } from "./types.ts";
import { errorMessage, isRecord, truncate, type Rec } from "./util.ts";

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

/**
 * Encodes query parameters with encodeURIComponent (spaces become %20, which
 * OData and most APIs require; URLSearchParams would produce "+"). `$` stays
 * literal in keys so OData system options read naturally ($filter, $top...).
 */
export function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    const values: readonly QueryValue[] = Array.isArray(raw) ? raw : [raw as QueryValue];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      parts.push(`${encodeURIComponent(key).replace(/%24/g, "$")}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}

export function withQuery(url: string, query?: Query): string {
  const qs = encodeQuery(query);
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/** Joins URL segments with exactly one slash between them. */
export function joinUrl(base: string, ...segments: string[]): string {
  let url = base.replace(/\/+$/, "");
  for (const segment of segments) {
    if (!segment) continue;
    url += `/${segment.replace(/^\/+/, "")}`;
  }
  return url;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Requests and error mapping
// ---------------------------------------------------------------------------

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string | undefined>;
  query?: Query;
  /** JSON body (serialised with content-type application/json). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** Raw body. */
  body?: string | Uint8Array;
  /** How to read a successful response; "json" falls back to text for non-JSON bodies. */
  responseType?: "json" | "text" | "bytes";
  /** Name of the remote system used in error messages. */
  service?: string;
  timeoutMs?: number;
  /** Non-2xx statuses that should be returned instead of thrown. */
  acceptStatus?: number[];
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  url: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Pulls a human-readable message out of the error payloads of common enterprise APIs. */
export function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text ? truncate(text, 300) : undefined;
  }
  if (Array.isArray(body)) {
    // Salesforce: [{ message, errorCode, fields }]
    const messages = body
      .map((item) => (isRecord(item) ? [item.errorCode, item.message].filter(Boolean).join(": ") : undefined))
      .filter((m): m is string => Boolean(m));
    return messages.length ? messages.join("; ") : undefined;
  }
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (isRecord(error)) {
    // OData v2 (SAP): { error: { code, message: { value } } }; OData v4 / Graph / Google: { error: { code, message } }
    const message = isRecord(error.message) ? error.message.value : error.message;
    const code = typeof error.code === "string" ? error.code : typeof error.status === "string" ? error.status : undefined;
    if (typeof message === "string") return code ? `${code}: ${message}` : message;
  }
  // OAuth 2.0 token endpoint: { error, error_description }
  if (typeof error === "string") {
    return typeof body.error_description === "string" ? `${error}: ${body.error_description}` : error;
  }
  // HubSpot and generic APIs: { message } / { detail } / { title }
  for (const key of ["message", "detail", "title", "errorMessage"]) {
    if (typeof body[key] === "string") return body[key] as string;
  }
  return undefined;
}

/**
 * Maps an HTTP error status to a ConnectorError: 401/403 -> auth, 404 ->
 * not_found, other 4xx -> validation, 5xx -> remote. 408 and 429 are
 * transient and reported as remote so callers can retry later.
 */
export function httpError(status: number, body: unknown, service: string, statusText = ""): ConnectorError {
  const detail = extractErrorMessage(body) ?? statusText;
  const message = `${service} returned HTTP ${status}${detail ? `: ${truncate(detail, 500)}` : ""}`;
  if (status === 401 || status === 403) return new ConnectorError(message, "auth", status);
  if (status === 404) return new ConnectorError(message, "not_found", status);
  if (status === 408 || status === 429) return new ConnectorError(message, "remote", status);
  if (status >= 400 && status < 500) return new ConnectorError(message, "validation", status);
  return new ConnectorError(message, "remote", status);
}

async function readBody(response: Response, responseType: "json" | "text" | "bytes"): Promise<unknown> {
  if (responseType === "bytes") return new Uint8Array(await response.arrayBuffer());
  const text = await response.text();
  if (responseType === "text") return text;
  if (text === "") return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Performs an HTTP request with timeout, JSON handling and error mapping. */
export async function httpRequest<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const service = options.service ?? "Remote system";
  const headers = new Headers();
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) continue;
    try {
      headers.set(key, value);
    } catch {
      throw new ConnectorError(`Invalid HTTP header "${key}" for ${service}`, "config");
    }
  }
  let body: RequestInit["body"];
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString();
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (options.body !== undefined) {
    body = options.body;
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  const fullUrl = withQuery(url, options.query);
  let response: Response;
  try {
    response = await fetchImpl(fullUrl, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "request timed out" : errorMessage(error);
    throw new ConnectorError(`Could not reach ${service}: ${reason}`, "remote");
  }
  const ok = response.ok || (options.acceptStatus?.includes(response.status) ?? false);
  let data: unknown;
  try {
    data = await readBody(response, ok ? (options.responseType ?? "json") : "json");
  } catch (error) {
    // An unreadable error body still yields the status-based error below.
    if (ok) throw new ConnectorError(`Could not read the response of ${service}: ${errorMessage(error)}`, "remote");
  }
  if (!ok) throw httpError(response.status, data, service, response.statusText);
  return { status: response.status, headers: response.headers, data: data as T, url: fullUrl };
}

/** Convenience wrapper returning only the parsed body. */
export async function requestJson<T = unknown>(fetchImpl: typeof fetch, url: string, options: HttpRequestOptions = {}): Promise<T> {
  return (await httpRequest<T>(fetchImpl, url, options)).data;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 tokens
// ---------------------------------------------------------------------------

export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  /** Epoch milliseconds after which the token must not be used. */
  expiresAt: number;
  /** Other fields of the token response (e.g. Salesforce instance_url), without tokens. */
  extra: Rec;
  /** True when served from the in-memory cache (a 401 may then warrant one refresh). */
  fromCache: boolean;
}

interface CacheEntry {
  token?: Omit<OAuthToken, "fromCache">;
  pending?: Promise<Omit<OAuthToken, "fromCache">>;
}

const tokenCache = new Map<string, CacheEntry>();
/** Tokens are refreshed this long before they expire. */
const EXPIRY_SKEW_MS = 60_000;
/** Used when a token response has no expires_in (e.g. Salesforce). */
const DEFAULT_TOKEN_TTL_S = 900;

/**
 * Cache key for a token: token URL + client id (+ scope/grant), plus a hash of
 * the credential so rotated or different secrets never share a token.
 */
export function tokenCacheKey(parts: { tokenUrl: string; clientId: string; grant: string; scope?: string; credential: string }): string {
  const credentialHash = createHash("sha256").update(parts.credential).digest("hex").slice(0, 24);
  return [parts.grant, parts.tokenUrl, parts.clientId, parts.scope ?? "", credentialHash].join("|");
}

/**
 * Returns a cached token for `key` or obtains a new one via `fetcher`.
 * Concurrent callers share one in-flight token request.
 */
export async function cachedToken(
  key: string,
  fetcher: () => Promise<Omit<OAuthToken, "fromCache">>,
  forceRefresh = false,
): Promise<OAuthToken> {
  const entry = tokenCache.get(key) ?? {};
  if (!forceRefresh && entry.token && entry.token.expiresAt > Date.now()) {
    return { ...entry.token, fromCache: true };
  }
  if (!entry.pending) {
    entry.pending = fetcher()
      .then((token) => {
        entry.token = token;
        return token;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    tokenCache.set(key, entry);
  }
  return { ...(await entry.pending), fromCache: false };
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export interface TokenRequestOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  /** "body" (default) sends client_id/client_secret as form fields, "basic" uses HTTP Basic (RFC 6749 §2.3.1). */
  clientAuth?: "body" | "basic";
  params: Record<string, string>;
  service?: string;
}

/** POSTs a token request and parses the standard OAuth 2.0 token response. */
export async function requestToken(fetchImpl: typeof fetch, options: TokenRequestOptions): Promise<Omit<OAuthToken, "fromCache">> {
  const service = options.service ?? "OAuth token endpoint";
  const form: Record<string, string> = { ...options.params };
  const headers: Record<string, string> = {};
  if (options.clientAuth === "basic") {
    headers.authorization = basicAuth(encodeURIComponent(options.clientId), encodeURIComponent(options.clientSecret ?? ""));
  } else {
    form.client_id = options.clientId;
    if (options.clientSecret !== undefined) form.client_secret = options.clientSecret;
  }
  let data: unknown;
  try {
    data = await requestJson(fetchImpl, options.tokenUrl, { method: "POST", form, headers, service });
  } catch (error) {
    // Token endpoints answer bad credentials with 400 invalid_client/invalid_grant: that is an auth problem.
    if (error instanceof ConnectorError && error.code === "validation") {
      throw new ConnectorError(error.message, "auth", error.status);
    }
    throw error;
  }
  if (!isRecord(data) || typeof data.access_token !== "string") {
    throw new ConnectorError(`${service} did not return an access token`, "auth");
  }
  const { access_token, refresh_token: _refresh, id_token: _id, ...extra } = data;
  const expiresIn = Number(data.expires_in);
  const ttlMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_TTL_S) * 1000;
  return {
    accessToken: access_token,
    tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
    expiresAt: Date.now() + Math.max(ttlMs - EXPIRY_SKEW_MS, ttlMs / 2),
    extra,
  };
}

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  clientAuth?: "body" | "basic";
  extraParams?: Record<string, string>;
  service?: string;
}

/** OAuth 2.0 client credentials grant with in-memory caching (respects expires_in). */
export function getClientCredentialsToken(
  fetchImpl: typeof fetch,
  options: ClientCredentialsOptions,
  forceRefresh = false,
): Promise<OAuthToken> {
  const key = tokenCacheKey({
    grant: "client_credentials",
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    scope: options.scope,
    credential: options.clientSecret,
  });
  return cachedToken(
    key,
    () =>
      requestToken(fetchImpl, {
        tokenUrl: options.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        clientAuth: options.clientAuth,
        service: options.service,
        params: {
          grant_type: "client_credentials",
          ...(options.scope ? { scope: options.scope } : {}),
          ...options.extraParams,
        },
      }),
    forceRefresh,
  );
}

export interface RefreshTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
  clientAuth?: "body" | "basic";
  service?: string;
}

/** OAuth 2.0 refresh token grant with in-memory caching of the access token. */
export function getRefreshTokenAccessToken(
  fetchImpl: typeof fetch,
  options: RefreshTokenOptions,
  forceRefresh = false,
): Promise<OAuthToken> {
  const key = tokenCacheKey({
    grant: "refresh_token",
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    scope: options.scope,
    credential: `${options.clientSecret ?? ""}\u0000${options.refreshToken}`,
  });
  return cachedToken(
    key,
    () =>
      requestToken(fetchImpl, {
        tokenUrl: options.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        clientAuth: options.clientAuth,
        service: options.service,
        params: {
          grant_type: "refresh_token",
          refresh_token: options.refreshToken,
          ...(options.scope ? { scope: options.scope } : {}),
        },
      }),
    forceRefresh,
  );
}

/**
 * Runs `request` with a token from `getToken`; when the API answers 401 and the
 * token came from the cache (it may have been revoked or rotated), fetches a
 * fresh token once and retries.
 */
export async function withTokenRetry<T>(
  getToken: (forceRefresh: boolean) => Promise<OAuthToken>,
  request: (token: OAuthToken) => Promise<T>,
): Promise<T> {
  const token = await getToken(false);
  try {
    return await request(token);
  } catch (error) {
    if (token.fromCache && error instanceof ConnectorError && error.status === 401) {
      return request(await getToken(true));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// OData helpers (SAP OData V2, Dataverse / Microsoft Graph OData V4)
// ---------------------------------------------------------------------------

/** OData string literal: 'O''Reilly'. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Key predicate segment for a single-key entity: A_PurchaseOrder('4500000001'). */
export function odataKey(entitySet: string, key: string | Record<string, string>): string {
  const predicate =
    typeof key === "string"
      ? odataString(key)
      : Object.entries(key)
          .map(([name, value]) => `${name}=${odataString(value)}`)
          .join(",");
  return `${entitySet}(${encodeURIComponent(predicate).replace(/%27/g, "'").replace(/%3D/g, "=").replace(/%2C/g, ",")})`;
}

/** OData V2 datetime literal for $filter: datetime'2026-01-31T00:00:00'. */
export function odataV2DateTimeLiteral(isoDate: string): string {
  const value = isoDate.length === 10 ? `${isoDate}T00:00:00` : isoDate.replace(/(\.\d+)?Z$/, "");
  return `datetime'${value}'`;
}

/** OData V2 JSON date value for request payloads: /Date(1767139200000)/. */
export function toODataV2Date(isoDate: string): string {
  const time = Date.parse(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  if (Number.isNaN(time)) throw new ConnectorError(`Invalid date "${isoDate}"`, "validation");
  return `/Date(${time})/`;
}

const V2_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** Converts an OData V2 "/Date(ms)/" value to an ISO date (or timestamp when it has a time part). */
export function fromODataV2Date(value: string): string {
  const match = V2_DATE.exec(value);
  if (!match) return value;
  const iso = new Date(Number(match[1])).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/**
 * Normalises an OData V2 payload for consumers: removes __metadata and
 * unexpanded __deferred navigation links, unwraps expanded { results: [] }
 * collections and converts /Date(...)/ values to ISO strings.
 */
export function cleanODataV2(value: unknown): unknown {
  if (typeof value === "string") return V2_DATE.test(value) ? fromODataV2Date(value) : value;
  if (Array.isArray(value)) return value.map(cleanODataV2);
  if (!isRecord(value)) return value;
  if (Array.isArray(value.results) && Object.keys(value).every((k) => k === "results" || k.startsWith("__"))) {
    return value.results.map(cleanODataV2);
  }
  const out: Rec = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "__metadata") continue;
    if (isRecord(child) && isRecord(child.__deferred)) continue;
    out[key] = cleanODataV2(child);
  }
  return out;
}

/** Reads an OData V2 collection response ({ d: { results, __next } }). */
export function odataV2Collection(body: unknown): { items: Rec[]; next?: string; count?: number } {
  const d = isRecord(body) ? body.d : undefined;
  const results = isRecord(d) ? d.results : Array.isArray(d) ? d : undefined;
  if (!Array.isArray(results)) throw new ConnectorError("Unexpected OData response (no results collection)", "remote");
  const items = results.filter(isRecord).map((item) => cleanODataV2(item) as Rec);
  const next = isRecord(d) && typeof d.__next === "string" ? d.__next : undefined;
  const count = isRecord(d) && d.__count !== undefined ? Number(d.__count) : undefined;
  return { items, next, count };
}

/** Reads an OData V2 single-entity response ({ d: { ... } }). */
export function odataV2Entity(body: unknown): Rec {
  const d = isRecord(body) ? body.d : undefined;
  if (!isRecord(d)) throw new ConnectorError("Unexpected OData response (no entity)", "remote");
  return cleanODataV2(d) as Rec;
}

/** Reads an OData V4 collection response ({ value, @odata.nextLink, @odata.count }). */
export function odataV4Collection(body: unknown): { items: Rec[]; nextLink?: string; count?: number } {
  if (!isRecord(body) || !Array.isArray(body.value)) {
    throw new ConnectorError("Unexpected OData response (no value collection)", "remote");
  }
  const nextLink = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
  const count = typeof body["@odata.count"] === "number" ? body["@odata.count"] : undefined;
  return { items: body.value.filter(isRecord), nextLink, count };
}

/** Removes OData V4 control annotations (@odata.context, @odata.etag...) but keeps formatted-value annotations. */
export function stripODataControl(record: Rec): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("@odata.")) continue;
    out[key] = value;
  }
  return out;
}
