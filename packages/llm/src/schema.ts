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
  const node = schema as Node;
  const problems: string[] = [];
  if (isObjectType(node) && node.additionalProperties !== false) problems.push(`${path}: objects need additionalProperties: false`);
  for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in node) problems.push(`${path}: "${keyword}" is not supported`);
  if ("oneOf" in node) problems.push(`${path}: use anyOf instead of oneOf`);
  if ("$ref" in node) problems.push(`${path}: $ref is not used by Enterprise Brain schemas (recursion is not supported)`);
  for (const [suffix, child] of children(node)) problems.push(...structuredOutputProblems(child, `${path}${suffix}`));
  return problems;
}

/** Copy of `schema` the API accepts: unsupported keywords dropped, objects closed, oneOf as anyOf. */
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
    if (isObjectType(out)) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as JsonSchema;
}
