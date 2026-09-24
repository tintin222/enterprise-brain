import { z } from "zod";

/**
 * FieldSpec is the business-friendly way to describe data shapes (agent inputs,
 * outputs, extraction targets, generated form fields). Non-technical users and
 * the Agent Builder author FieldSpecs; JSON Schema is derived from them for LLM
 * structured outputs and validation.
 */
export const FieldType = z.enum([
  "string",
  "text",
  "number",
  "integer",
  "boolean",
  "date",
  "email",
  "phone",
  "url",
  "select",
  "multiselect",
  "file",
  "files",
  "list",
  "object",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldOption = z.object({
  value: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
});
export type FieldOption = z.infer<typeof FieldOption>;

export interface FieldSpec {
  key: string;
  label?: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  options?: FieldOption[];
  /** For `list`: the item type; for `list` of objects, use `fields`. */
  itemType?: FieldType;
  /** For `object` and `list` of objects. */
  fields?: FieldSpec[];
  /** Accepted mime types / extensions for `file(s)` fields, e.g. [".pdf", ".docx"]. */
  accept?: string[];
  /** Hints for the offline heuristic extractor, e.g. keywords that locate the value. */
  hints?: string[];
  example?: unknown;
}

// Input = output (no defaults or transforms), so z.input<> of containing schemas stays typed.
export const FieldSpecSchema: z.ZodType<FieldSpec, FieldSpec> = z.lazy(() =>
  z.object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field keys must be identifiers (letters, digits, underscore)"),
    label: z.string().optional(),
    type: FieldType,
    description: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(FieldOption).optional(),
    itemType: FieldType.optional(),
    fields: z.array(FieldSpecSchema).optional(),
    accept: z.array(z.string()).optional(),
    hints: z.array(z.string()).optional(),
    example: z.unknown().optional(),
  }),
);

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  format?: string;
  additionalProperties?: boolean;
  [k: string]: unknown;
};

function fieldToJsonSchema(field: FieldSpec, forLlm: boolean): JsonSchema {
  const description = [field.label, field.description].filter(Boolean).join(" — ") || undefined;
  const base: JsonSchema = description ? { description } : {};
  switch (field.type) {
    case "string":
    case "text":
    case "phone":
      return { ...base, type: "string" };
    case "email":
      return { ...base, type: "string", ...(forLlm ? {} : { format: "email" }) };
    case "url":
      return { ...base, type: "string", ...(forLlm ? {} : { format: "uri" }) };
    case "date":
      return { ...base, type: "string", description: [description, "ISO 8601 date (YYYY-MM-DD)"].filter(Boolean).join(". ") };
    case "number":
      return { ...base, type: "number" };
    case "integer":
      return { ...base, type: "integer" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "select":
      return field.options?.length
        ? { ...base, type: "string", enum: field.options.map((o) => o.value) }
        : { ...base, type: "string" };
    case "multiselect":
      return {
        ...base,
        type: "array",
        items: field.options?.length ? { type: "string", enum: field.options.map((o) => o.value) } : { type: "string" },
      };
    case "file":
      return { ...base, type: "string", description: [description, "file id"].filter(Boolean).join(" — ") };
    case "files":
      return { ...base, type: "array", items: { type: "string" } };
    case "list": {
      if (field.fields?.length) {
        return { ...base, type: "array", items: fieldsToJsonSchema(field.fields, { forLlm }) };
      }
      const itemField: FieldSpec = { key: "item", type: field.itemType ?? "string", options: field.options };
      return { ...base, type: "array", items: fieldToJsonSchema(itemField, forLlm) };
    }
    case "object":
      return { ...base, ...fieldsToJsonSchema(field.fields ?? [], { forLlm }) };
  }
}

/**
 * Convert FieldSpecs to a JSON Schema object. With `forLlm`, the schema follows
 * the structured-output constraints (every property required, no extra props);
 * optional fields become nullable instead.
 */
export function fieldsToJsonSchema(fields: FieldSpec[], opts: { forLlm?: boolean } = {}): JsonSchema {
  const forLlm = opts.forLlm ?? false;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    let schema = fieldToJsonSchema(field, forLlm);
    if (forLlm) {
      required.push(field.key);
      if (!field.required && typeof schema.type === "string") {
        schema = { ...schema, type: [schema.type, "null"] };
        if (schema.enum) schema = { ...schema, enum: [...schema.enum, null] };
      }
    } else if (field.required) {
      required.push(field.key);
    }
    properties[field.key] = schema;
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export function fieldLabel(field: FieldSpec): string {
  return field.label ?? humanizeKey(field.key);
}
