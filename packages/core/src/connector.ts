import { z } from "zod";
import { SystemCategory } from "./catalog.ts";

/** A configuration field of a connector (rendered as a form in the console). */
export const ConfigField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "password", "url", "number", "boolean", "select", "textarea"]).default("string"),
  required: z.boolean().default(false),
  /** Secret fields are encrypted at rest and never returned by the API. */
  secret: z.boolean().default(false),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type ConfigField = z.infer<typeof ConfigField>;

export const OperationManifest = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/),
  name: z.string(),
  description: z.string(),
  /** read = no side effects; write = changes data in the target system (approval-gated by default). */
  kind: z.enum(["read", "write"]),
  /** JSON Schema of the operation input (exposed to agents as a tool). */
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

export const ConnectorManifest = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  vendor: z.string(),
  category: SystemCategory,
  description: z.string(),
  auth: z.enum(["none", "api-key", "basic", "bearer", "oauth2-client-credentials", "oauth2-refresh-token", "custom"]),
  config: z.array(ConfigField).default([]),
  operations: z.array(OperationManifest).default([]),
  /** Events the connector can emit (poll or webhook based). */
  events: z
    .array(z.object({ id: z.string(), name: z.string(), description: z.string() }))
    .default([]),
  docsUrl: z.string().optional(),
  /** stable = tested against the live API; preview = implemented from API docs, verify in your tenant; sandbox = built-in demo data. */
  maturity: z.enum(["stable", "preview", "sandbox"]).default("preview"),
  /** What the customer's IT typically needs to provide, used by the Agent Builder when drafting IT requests. */
  itRequirements: z.array(z.string()).default([]),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;
