import { ConnectorError, type ConnectorContext } from "./types.ts";

/** Operation input as received from agents and workflows. */
export type Input = Record<string, unknown>;
export type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Input readers. Operation inputs are validated against the manifest schema
// before handlers run; these readers normalise values (trim, empty -> absent)
// and guard the few cases a schema cannot express.
// ---------------------------------------------------------------------------

/** Optional string; numbers are accepted for id-like values, empty strings count as absent. */
export function optString(input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") throw new ConnectorError(`${key} must be a string`, "validation");
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function reqString(input: Input, key: string): string {
  const value = optString(input, key);
  if (value === undefined) throw new ConnectorError(`${key} is required`, "validation");
  return value;
}

export function optNumber(input: Input, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConnectorError(`${key} must be a number`, "validation");
  }
  return value;
}

export function reqNumber(input: Input, key: string): number {
  const value = optNumber(input, key);
  if (value === undefined) throw new ConnectorError(`${key} is required`, "validation");
  return value;
}

export function optBoolean(input: Input, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConnectorError(`${key} must be a boolean`, "validation");
}

/** Optional integer clamped to [min, max]; used for page sizes. */
export function optLimit(input: Input, key: string, fallback: number, max: number): number {
  const value = optNumber(input, key);
  if (value === undefined) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

export function optRecord(input: Input, key: string): Rec | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConnectorError(`${key} must be an object`, "validation");
  return value;
}

export function reqRecord(input: Input, key: string): Rec {
  const value = optRecord(input, key);
  if (value === undefined) throw new ConnectorError(`${key} is required`, "validation");
  return value;
}

/** A list of strings given either as an array or as a comma/semicolon separated string. */
export function optStringList(input: Input, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : undefined;
  if (!items) throw new ConnectorError(`${key} must be a string or a list of strings`, "validation");
  const out = items.map((item) => (typeof item === "string" ? item.trim() : String(item))).filter((item) => item !== "");
  return out.length ? out : undefined;
}

function enumKey(value: string): string {
  return normalizeText(value).trim().replace(/[\s-]+/g, "_");
}

/**
 * Maps a value onto one of `allowed` (case-, accent- and separator-insensitive),
 * also accepting documented synonyms ("vacation" -> "annual"). Reports the
 * allowed values when nothing matches.
 */
export function toEnum<T extends string>(value: string, key: string, allowed: readonly T[], synonyms: Readonly<Record<string, T>> = {}): T {
  const wanted = enumKey(value);
  const direct = allowed.find((candidate) => enumKey(candidate) === wanted);
  if (direct) return direct;
  if (Object.hasOwn(synonyms, wanted)) return synonyms[wanted] as T;
  throw new ConnectorError(`${key} must be one of: ${allowed.join(", ")} (got "${value}")`, "validation");
}

export function optEnum<T extends string>(input: Input, key: string, allowed: readonly T[], synonyms?: Readonly<Record<string, T>>): T | undefined {
  const value = optString(input, key);
  return value === undefined ? undefined : toEnum(value, key, allowed, synonyms);
}

export function reqEnum<T extends string>(input: Input, key: string, allowed: readonly T[], synonyms?: Readonly<Record<string, T>>): T {
  const value = optEnum(input, key, allowed, synonyms);
  if (value === undefined) throw new ConnectorError(`${key} is required`, "validation");
  return value;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

export function normalizeEmail(value: string, key = "email"): string {
  const email = value.trim().toLowerCase();
  if (!isEmail(email)) throw new ConnectorError(`${key} is not a valid e-mail address: "${value}"`, "validation");
  return email;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a calendar date in YYYY-MM-DD form (also accepts a full ISO timestamp and keeps the date part). */
export function parseIsoDate(value: string, key: string): string {
  const candidate = value.length > 10 && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
  const match = ISO_DATE.exec(candidate);
  if (match) {
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)) {
      return candidate;
    }
  }
  throw new ConnectorError(`${key} must be a date in YYYY-MM-DD format (got "${value}")`, "validation");
}

/** Validates an ISO 8601 timestamp and returns it normalised to UTC. */
export function parseIsoDateTime(value: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    throw new ConnectorError(`${key} must be an ISO 8601 date-time, e.g. 2026-10-05T09:30:00Z (got "${value}")`, "validation");
  }
  const time = Date.parse(value.replace(" ", "T"));
  if (Number.isNaN(time)) throw new ConnectorError(`${key} is not a valid date-time: "${value}"`, "validation");
  return new Date(time).toISOString();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Midnight UTC of the given date (or today). */
export function startOfDay(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

/** Case- and accent-insensitive form used for searching (handles Turkish dotted/dotless i). */
export function normalizeText(value: string): string {
  return value
    .replace(/[İIı]/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** True when every whitespace-separated token of `query` occurs in one of the values. */
export function matchesQuery(values: unknown[], query: string | undefined): boolean {
  if (!query) return true;
  const haystack = normalizeText(values.filter((v) => v !== undefined && v !== null).map(String).join(" \u0001 "));
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sum(values: number[]): number {
  return round2(values.reduce((acc, v) => acc + v, 0));
}

// ---------------------------------------------------------------------------
// Connector configuration
// ---------------------------------------------------------------------------

export function configString(ctx: ConnectorContext, key: string, fallback?: string): string | undefined {
  const value = ctx.config[key];
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

export function requireConfig(ctx: ConnectorContext, key: string, label = key): string {
  const value = configString(ctx, key);
  if (value === undefined) throw new ConnectorError(`Missing configuration: ${label}`, "config");
  return value;
}

export function configBoolean(ctx: ConnectorContext, key: string, fallback: boolean): boolean {
  const value = ctx.config[key];
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

export function configNumber(ctx: ConnectorContext, key: string, fallback: number): number {
  const value = ctx.config[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Secrets are only read from ctx.secrets (decrypted by the platform), never from plain config. */
export function optionalSecret(ctx: ConnectorContext, key: string): string | undefined {
  const value = ctx.secrets[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function requireSecret(ctx: ConnectorContext, key: string, label = key): string {
  const value = optionalSecret(ctx, key);
  if (value === undefined) throw new ConnectorError(`Missing secret: ${label}`, "config");
  return value;
}

/** Validates and normalises an http(s) base URL (no trailing slash). */
export function normalizeBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError(`${label} is not a valid URL: "${value}"`, "config");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConnectorError(`${label} must be an http(s) URL`, "config");
  }
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** Runs async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
