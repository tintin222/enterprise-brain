import type { JsonSchema } from "@enterprise-brain/core";

/**
 * Structured outputs accept a subset of JSON Schema: every object needs
 * `additionalProperties: false`, and numeric, length and array-size constraints
 * are not supported. These keywords are validated client-side instead.
 */
const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
] as const;

type Node = Record<string, unknown>;

/**
 * Claude accepts at most this many parameters with a union (`anyOf`, or a list of types such as
 * `["string", "null"]`) across a structured-output schema.
 */
export const MAX_UNION_PARAMETERS = 16;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const isObjectType = (node: Node) => node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || isNode(node.properties);

function children(node: Node): [string, Node][] {
  const out: [string, Node][] = [];
  if (isNode(node.properties)) for (const [key, value] of Object.entries(node.properties)) if (isNode(value)) out.push([`.properties.${key}`, value]);
  if (isNode(node.items)) out.push([".items", node.items]);
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const list = node[keyword];
    if (Array.isArray(list)) list.forEach((value, i) => isNode(value) && out.push([`.${keyword}[${i}]`, value]));
  }
  return out;
}

/** Problems that would make the API reject a structured-output schema (or silently change its meaning). */
export function structuredOutputProblems(schema: JsonSchema | Node, path = "$"): string[] {
  const problems = nodeProblems(schema as Node, path);
  const unions = unionCount(schema as Node);
  if (unions > MAX_UNION_PARAMETERS) {
    problems.push(`${path}: ${unions} parameters use anyOf or a list of types; Claude accepts at most ${MAX_UNION_PARAMETERS}`);
  }
  return problems;
}

function nodeProblems(node: Node, path: string): string[] {
  const problems: string[] = [];
  if (isObjectType(node) && node.additionalProperties !== false) problems.push(`${path}: objects need additionalProperties: false`);
  for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in node) problems.push(`${path}: "${keyword}" is not supported`);
  if ("oneOf" in node) problems.push(`${path}: use anyOf instead of oneOf`);
  if ("$ref" in node) problems.push(`${path}: $ref is not used by Enterprise Brain schemas (recursion is not supported)`);
  if (Array.isArray(node.type) && ("enum" in node || "const" in node)) problems.push(`${path}: a list of types with enum or const is rejected; use anyOf`);
  for (const [suffix, child] of children(node)) problems.push(...nodeProblems(child, `${path}${suffix}`));
  return problems;
}

/** How many parameters, at any depth, use anyOf or a list of types. */
function unionCount(node: Node): number {
  let count = Array.isArray(node.type) || Array.isArray(node.anyOf) ? 1 : 0;
  for (const [, child] of children(node)) count += unionCount(child);
  return count;
}

const nullableAs = (node: Node): "string" | "array" | undefined => {
  if (!Array.isArray(node.type) || !node.type.includes("null")) return undefined;
  const types = node.type.filter((t) => t !== "null");
  return types.length === 1 && (types[0] === "string" || types[0] === "array") ? types[0] : undefined;
};

/**
 * Copy of `schema` the API accepts: unsupported keywords dropped, objects closed, oneOf as anyOf. A value
 * that may be null is sent without a union where it can be, to stay under Claude's union limit: an empty
 * string or list stands for null (`fromStructuredOutput` turns it back). Another type that may be null
 * keeps its list of types, and one with choices becomes anyOf, since Claude rejects a list of types with
 * enum.
 */
export function toStructuredOutputSchema(schema: JsonSchema | Node): JsonSchema {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isNode(value)) return value;
    const out: Node = {};
    for (const [key, child] of Object.entries(value)) {
      if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue;
      if (key === "properties" && isNode(child)) out.properties = Object.fromEntries(Object.entries(child).map(([k, v]) => [k, walk(v)]));
      else out[key === "oneOf" ? "anyOf" : key] = walk(child);
    }
    const as = nullableAs(out);
    if (as) {
      out.type = as;
      if (Array.isArray(out.enum)) out.enum = [...new Set([...out.enum.filter((v) => v !== null), ""])];
      const empty = as === "string" ? "Empty when not known." : "An empty list when there is none.";
      out.description = typeof out.description === "string" && out.description.trim() ? `${out.description.trim().replace(/\.$/, "")}. ${empty}` : empty;
    } else if (Array.isArray(out.type) && out.type.includes("null") && ("enum" in out || "const" in out)) {
      const { type, enum: values, const: constant, description, ...rest } = out;
      const types = (type as unknown[]).filter((t) => t !== "null");
      const choice: Node = { ...rest, type: types.length === 1 ? types[0] : types };
      if (Array.isArray(values)) choice.enum = values.filter((v) => v !== null);
      if (constant !== undefined && constant !== null) choice.const = constant;
      return { ...(description !== undefined ? { description } : {}), anyOf: [choice, { type: "null" }] };
    }
    if (isObjectType(out)) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as JsonSchema;
}

/**
 * Data that came back for a schema sent through `toStructuredOutputSchema`, as the schema describes it:
 * an empty string or list is null again wherever the schema allowed null.
 */
export function fromStructuredOutput<T>(schema: JsonSchema | Node, data: T): T {
  const walk = (node: unknown, value: unknown): unknown => {
    if (!isNode(node)) return value;
    const as = nullableAs(node);
    if (as === "string" && value === "") return null;
    if (as === "array" && Array.isArray(value) && value.length === 0) return null;
    if (Array.isArray(value) && isNode(node.items)) return value.map((item) => walk(node.items, item));
    if (isNode(value) && isNode(node.properties)) {
      const out: Node = { ...value };
      for (const [key, child] of Object.entries(node.properties)) if (key in out) out[key] = walk(child, out[key]);
      return out;
    }
    return value;
  };
  return walk(schema, data) as T;
}
