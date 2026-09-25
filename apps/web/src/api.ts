/**
 * Tiny HTTP client for the Enterprise Brain API (same origin; Vite proxies
 * /api and /mcp in development). Adds the console API key when one is stored,
 * turns JSON error bodies into Errors and speaks Server-Sent Events both over
 * fetch (POST streams, or GET streams that need an Authorization header) and
 * through EventSource (GET streams in local trusted mode).
 */

const API_KEY_STORAGE = "eb.apiKey";

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable (private mode) — the key simply isn't remembered
  }
}

/** The server's answer when a request needs a signed-in person. */
const SIGN_IN_ERROR = "Sign in to continue";
/** Fired on window when the server stops accepting this browser's session. */
export const SIGNED_OUT_EVENT = "eb:signed-out";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong";
}

function buildHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  const key = getApiKey();
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return headers;
}

async function toError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText || "Request failed"}`;
  let issues: { path: string; message: string }[] | undefined;
  try {
    const text = await response.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown; issues?: { path: string; message: string }[] };
        if (typeof body.error === "string") message = body.error;
        else if (typeof body.message === "string") message = body.message;
        if (Array.isArray(body.issues) && body.issues.length) {
          issues = body.issues;
          const detail = body.issues
            .slice(0, 3)
            .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
            .join("; ");
          message = `${message} — ${detail}`;
        }
      } catch {
        if (text.length < 300) message = text;
      }
    }
  } catch {
    // ignore unreadable bodies
  }
  if (response.status === 401 && message.startsWith("401")) message = "Missing or invalid API key";
  // The session ended (expired, signed out in another tab, account disabled): show sign-in.
  if (response.status === 401 && message === SIGN_IN_ERROR) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  return new ApiError(message, response.status, issues);
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: buildHeaders(body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw error;
    throw new ApiError("Can't reach the Enterprise Brain server. Is it running?", 0);
  }
  return parse<T>(response);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => send<T>("GET", path, undefined, signal),
  post: <T>(path: string, body: unknown = {}, signal?: AbortSignal) => send<T>("POST", path, body, signal),
  put: <T>(path: string, body: unknown = {}) => send<T>("PUT", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
  /** multipart/form-data POST (the browser sets the boundary). */
  async upload<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, { method: "POST", headers: buildHeaders({ accept: "application/json" }), body: form, signal });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw error;
      throw new ApiError("Can't reach the Enterprise Brain server. Is it running?", 0);
    }
    return parse<T>(response);
  },
  /** Fetch a binary resource (with auth) and return it as a Blob. */
  async blob(path: string): Promise<Blob> {
    const response = await fetch(path, { headers: buildHeaders() });
    if (!response.ok) throw await toError(response);
    return response.blob();
  },
};

/** `/api/companies/:company/...` */
export function companyPath(company: string, path = ""): string {
  return `/api/companies/${encodeURIComponent(company)}${path}`;
}

export function fileUrl(company: string, fileId: string, inline = false): string {
  return `${companyPath(company, `/files/${encodeURIComponent(fileId)}`)}${inline ? "?inline=1" : ""}`;
}

/** Build a query string from defined values: qs({ a: 1, b: undefined }) → "?a=1". */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

export type SseHandler = (event: string, data: unknown) => void;

function parseData(raw: string): unknown {
  if (!raw) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function dispatchFrame(frame: string, onEvent: SseHandler) {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return;
  onEvent(event, parseData(data.join("\n")));
}

/** Read an SSE body (`event:` / `data:` frames separated by blank lines). */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: SseHandler): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Normalise line endings, but hold back a trailing \r: its \n may arrive in the next chunk.
    const heldCr = buffer.endsWith("\r");
    buffer = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n") + (heldCr ? "\r" : "");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchFrame(frame, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer = (buffer + decoder.decode()).replace(/\r\n?/g, "\n");
  for (const frame of buffer.split("\n\n")) if (frame.trim()) dispatchFrame(frame, onEvent);
}

/** POST a JSON body and consume the text/event-stream response. Resolves when the stream ends. */
export async function streamPost(path: string, body: unknown, onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: buildHeaders({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw error;
    throw new ApiError("Can't reach the Enterprise Brain server. Is it running?", 0);
  }
  if (!response.ok) throw await toError(response);
  if (!response.body) throw new Error("This browser does not support streaming responses");
  await readSse(response.body, onEvent);
}

/**
 * Subscribe to a GET event stream. Uses EventSource when no API key is needed
 * (EventSource cannot send headers), otherwise streams over fetch.
 * The stream is closed after an `end` event (no automatic reconnect loops).
 * Returns an unsubscribe function.
 */
export function subscribe(path: string, events: string[], onEvent: SseHandler, onClose?: (error?: unknown) => void): () => void {
  let closed = false;
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    onClose?.(error);
  };

  if (!getApiKey() && typeof EventSource !== "undefined") {
    const source = new EventSource(path);
    for (const name of events) {
      source.addEventListener(name, (e) => {
        if (closed) return;
        onEvent(name, parseData((e as MessageEvent<string>).data));
        if (name === "end") {
          source.close();
          finish();
        }
      });
    }
    source.onerror = () => {
      // The server closes finished streams; don't let EventSource reconnect and replay.
      source.close();
      finish(new Error("stream closed"));
    };
    return () => {
      source.close();
      closed = true;
    };
  }

  const controller = new AbortController();
  fetch(path, { headers: buildHeaders({ accept: "text/event-stream" }), signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw await toError(response);
      if (!response.body) throw new Error("Streaming not supported");
      await readSse(response.body, (event, data) => {
        if (closed) return;
        if (events.includes(event)) onEvent(event, data);
      });
      finish();
    })
    .catch((error) => {
      if ((error as { name?: string }).name !== "AbortError") finish(error);
    });
  return () => {
    closed = true;
    controller.abort();
  };
}

/** Trigger a browser download for an authenticated resource. */
export async function downloadWithAuth(path: string, fileName: string): Promise<void> {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
