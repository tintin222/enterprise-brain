import { InMemorySandboxStore } from "../src/sandbox/store.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../src/types.ts";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  /** Parsed JSON body (when the body is JSON). */
  json: unknown;
  /** Parsed form body (when the body is application/x-www-form-urlencoded). */
  form: URLSearchParams | undefined;
}

type Reply = Response | Record<string, unknown> | unknown[] | string | number | boolean | null;
type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;
type Matcher = string | RegExp | ((url: URL) => boolean);

interface Route {
  method: string;
  matcher: Matcher;
  handler: Handler;
  once: boolean;
}

function matches(matcher: Matcher, url: URL): boolean {
  if (typeof matcher === "function") return matcher(url);
  if (matcher instanceof RegExp) return matcher.test(decodeURIComponent(url.toString()));
  return `${url.origin}${url.pathname}` === matcher || decodeURIComponent(`${url.origin}${url.pathname}`) === matcher;
}

export function json(body: unknown, status = 200, headers: Record<string, string> | Array<[string, string]> = {}): Response {
  const init = new Headers(headers);
  if (!init.has("content-type")) init.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: init });
}

export function empty(status = 204, headers: Record<string, string> | Array<[string, string]> = {}): Response {
  return new Response(null, { status, headers });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

/**
 * Scriptable fetch: register routes with on()/once() (first match wins,
 * once-routes before persistent ones) and inspect `calls` afterwards.
 * Unmatched requests fail the test.
 */
export class FakeFetch {
  readonly calls: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  on(method: string, matcher: Matcher, handler: Handler | Reply): this {
    this.routes.push({ method: method.toUpperCase(), matcher, handler: toHandler(handler), once: false });
    return this;
  }

  once(method: string, matcher: Matcher, handler: Handler | Reply): this {
    this.routes.unshift({ method: method.toUpperCase(), matcher, handler: toHandler(handler), once: true });
    return this;
  }

  callsTo(method: string, matcher: Matcher): RecordedRequest[] {
    return this.calls.filter((c) => c.method === method.toUpperCase() && matches(matcher, c.url));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = init?.body;
    const body =
      rawBody === undefined || rawBody === null
        ? undefined
        : typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody).toString("utf8")
            : String(rawBody);
    let parsedJson: unknown;
    let form: URLSearchParams | undefined;
    const contentType = headers.get("content-type") ?? "";
    if (body !== undefined && contentType.includes("json")) parsedJson = JSON.parse(body);
    if (body !== undefined && contentType.includes("x-www-form-urlencoded")) form = new URLSearchParams(body);
    const request: RecordedRequest = { method, url, headers, body, json: parsedJson, form };
    this.calls.push(request);
    const index = this.routes.findIndex((r) => r.method === method && matches(r.matcher, url));
    const route = this.routes[index];
    if (!route) throw new Error(`FakeFetch: unexpected request ${method} ${url.toString()}`);
    if (route.once) this.routes.splice(index, 1);
    const reply = await route.handler(request);
    return reply instanceof Response ? reply : json(reply);
  };
}

function toHandler(handler: Handler | Reply): Handler {
  if (typeof handler === "function") return handler as Handler;
  // A Response body can only be read once: hand out a fresh copy per request.
  return () => (handler instanceof Response ? handler.clone() : handler);
}

export function makeCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    companyId: "acme-test",
    config: {},
    secrets: {},
    fetch: () => Promise.reject(new Error("fetch not expected in this test")),
    logger: { info() {}, warn() {} },
    sandbox: new InMemorySandboxStore(),
    ...overrides,
  };
}

/** Runs an operation and returns the ConnectorError it throws (fails when it does not throw one). */
export async function expectConnectorError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("Expected a ConnectorError, but the operation succeeded");
}

/** Convenience: execute an operation and cast the result for assertions. */
export async function run<T = Record<string, any>>(
  connector: ConnectorImplementation,
  operation: string,
  input: Record<string, unknown>,
  ctx: ConnectorContext,
): Promise<T> {
  return (await connector.execute(operation, input, ctx)) as T;
}

export function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}
