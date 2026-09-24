import type { JsonSchema } from "@enterprise-brain/core";

/**
 * Small builders for the JSON Schemas of operation inputs. Schemas stay within
 * the keywords every tool-calling LLM API understands (type, description, enum,
 * format, properties, required, items).
 */

type Extra = Omit<JsonSchema, "type">;

export const str = (description?: string, extra: Extra = {}): JsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
  ...extra,
});

export const num = (description?: string, extra: Extra = {}): JsonSchema => ({
  type: "number",
  ...(description ? { description } : {}),
  ...extra,
});

export const int = (description?: string, extra: Extra = {}): JsonSchema => ({
  type: "integer",
  ...(description ? { description } : {}),
  ...extra,
});

export const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) });

export const date = (description?: string): JsonSchema => str(description, { format: "date" });

export const dateTime = (description?: string): JsonSchema => str(description, { format: "date-time" });

export const email = (description?: string): JsonSchema => str(description, { format: "email" });

export const oneOf = (values: readonly string[], description?: string): JsonSchema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});

export const arr = (items: JsonSchema, description?: string): JsonSchema => ({
  type: "array",
  items,
  ...(description ? { description } : {}),
});

/** A free-form object (e.g. a map of field values). */
export const anyObject = (description?: string): JsonSchema => ({
  type: "object",
  additionalProperties: true,
  ...(description ? { description } : {}),
});

export const obj = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema => ({
  type: "object",
  properties,
  required,
  ...(description ? { description } : {}),
});

export interface OperationSpec {
  id: string;
  name: string;
  kind: "read" | "write";
  description: string;
  input: JsonSchema;
}

export const readOp = (
  id: string,
  name: string,
  description: string,
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): OperationSpec => ({ id, name, kind: "read", description, input: obj(properties, required) });

export const writeOp = (
  id: string,
  name: string,
  description: string,
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): OperationSpec => ({ id, name, kind: "write", description, input: obj(properties, required) });
