import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "agent";
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Read a dotted path ("steps.extract.text", "items.0.name") from an object. */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "Finance's", "Human Resources'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A company variable's name: letters, digits and underscores, starting with a letter or underscore. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The company's variables (Settings → Installation), as jobs read them: `{{ vars.invoice_limit }}`.
 * Only names that fit and plain values (texts, numbers, true or false) count.
 */
export function companyVariables(settings: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> {
  const raw = settings && typeof settings === "object" ? (settings as { variables?: unknown }).variables : undefined;
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VARIABLE_NAME.test(name)) continue;
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[name] = value;
  }
  return out;
}
