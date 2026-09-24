import type { ConnectorManifest, JsonSchema } from "@enterprise-brain/core";
import { isRecord } from "./util.ts";

const TOOL_NAME_MAX = 64;

/** FNV-1a 32-bit hash; keeps truncated tool names unique without depending on node:crypto. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Tool name under which a connector operation is exposed to agents:
 * `<ref>__<operationId>`, restricted to /^[a-zA-Z0-9_-]{1,64}$/ as required by
 * LLM tool-calling APIs. Over-long names are truncated with a hash suffix so
 * they stay unique and stable.
 */
export function operationToolName(ref: string, operationId: string): string {
  const raw = `${ref}__${operationId}`;
  const name = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.length <= TOOL_NAME_MAX) return name;
  const suffix = fnv1a(raw).toString(36);
  return `${name.slice(0, TOOL_NAME_MAX - suffix.length - 1)}_${suffix}`;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Enum comparison tolerant to case and separators ("Closed Won" matches "closed_won"). */
function enumKey(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function label(path: string): string {
  return path || "input";
}

function checkFormat(value: string, format: string, path: string, problems: string[]): void {
  if (format === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match || Number.isNaN(Date.parse(`${match[0]}T00:00:00Z`))) problems.push(`${label(path)} must be a date (YYYY-MM-DD)`);
  } else if (format === "date-time") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
      problems.push(`${label(path)} must be an ISO 8601 date-time`);
    }
  } else if (format === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) problems.push(`${label(path)} must be an e-mail address`);
  }
}

function checkValue(value: unknown, schema: JsonSchema, path: string, problems: string[], depth: number): void {
  if (depth > 10 || value === undefined || value === null) return;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    problems.push(`${label(path)} must be ${types.join(" or ")} (got ${typeOf(value)})`);
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum.map(enumKey);
    if (!allowed.includes(enumKey(value))) {
      problems.push(`${label(path)} must be one of: ${schema.enum.map(String).join(", ")}`);
    }
  }
  if (typeof value === "string") {
    if (typeof schema.format === "string") checkFormat(value, schema.format, path, problems);
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength) {
      problems.push(`${label(path)} must be at least ${schema.minLength} characters`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${label(path)} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${label(path)} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${label(path)} must contain at least ${schema.minItems} item(s)`);
    }
    const items = schema.items;
    if (items) value.forEach((item, i) => checkValue(item, items, `${path}[${i}]`, problems, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (isAbsent(value[key])) problems.push(`${path ? `${path}.` : ""}${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      const childPath = path ? `${path}.${key}` : key;
      if (childSchema) {
        if (!isAbsent(child)) checkValue(child, childSchema, childPath, problems, depth + 1);
      } else if (schema.additionalProperties === false) {
        problems.push(`${childPath} is not a known property`);
      }
    }
  }
}

/**
 * Lightweight JSON Schema check of an operation input: required properties,
 * primitive types, enums (case-insensitive), formats (date, date-time, email)
 * and simple bounds, recursing into objects and arrays. `null` counts as
 * "not provided" (LLM structured outputs use null for missing optional values).
 * Returns human-readable problems; an empty list means the input is acceptable.
 */
export function validateOperationInput(manifest: ConnectorManifest, operationId: string, input: unknown): string[] {
  const operation = manifest.operations.find((op) => op.id === operationId);
  if (!operation) return [`Unknown operation "${operationId}" for connector ${manifest.type}`];
  const value = input ?? {};
  if (!isRecord(value)) return [`input must be an object (got ${typeOf(value)})`];
  const problems: string[] = [];
  checkValue(value, operation.input as JsonSchema, "", problems, 0);
  return problems;
}
