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
  /** Shown only when another field has one of these values (e.g. the fields of the chosen sign-in). */
  showWhen: z.object({ key: z.string(), values: z.array(z.string()) }).optional(),
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
  /** IT's rule: a person approves every use, whatever the AI employee's level (named actions). */
  requiresApproval: z.boolean().optional(),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

/** A value a named action takes: `{customer_id}` in a path, `:customer_id` in SQL. */
export const ActionParam = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "integer", "boolean", "date"]).default("string"),
  description: z.string().optional(),
  required: z.boolean().default(false),
});
export type ActionParam = z.infer<typeof ActionParam>;

/** A value an action on screens brings back, read from the screens (e.g. an order's status). */
export const ActionReturn = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "integer", "boolean", "date"]).default("string"),
  description: z.string().optional(),
});
export type ActionReturn = z.infer<typeof ActionReturn>;

/**
 * A named action: one thing AI employees may do in a connected system, named and described in plain
 * words by IT and marked read or write. A web service action is a method, a path and templates
 * (`/customers/{customer_id}`); a database action is a SQL statement with `:params`; an action on an
 * old system's screens says what to do there in plain words ("Open order {order_number} and read its
 * status"). Business users and AI employees see only these, never raw calls.
 */
export const NamedAction = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Use lower-case letters, digits and _ (e.g. get_customer)"),
    name: z.string().min(1),
    description: z.string().default(""),
    kind: z.enum(["read", "write"]),
    /** A person approves every use, at every probation level. */
    requiresApproval: z.boolean().optional(),
    params: z.array(ActionParam).default([]),
    // Web services
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    path: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    // Databases
    sql: z.string().optional(),
    // MCP servers: the tool the action calls, and its input as the server describes it.
    tool: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // Old systems through their screens: what to do there in plain words, with {params}, and the values to bring back.
    goal: z.string().optional(),
    returns: z.array(ActionReturn).optional(),
    // The company's own tables: which table, and what the action does with its records.
    table: z.object({ key: z.string().min(1), operation: z.enum(["find", "get", "add", "update"]) }).optional(),
    /**
     * Watch it for new rows or items (by cursorField, e.g. created_at or id): each new one starts the
     * duties that listen for "new:<id>". The action receives the last value seen as `since`.
     */
    watch: z
      .object({
        cursorField: z.string().min(1),
        idField: z.string().optional(),
        /** Where watching starts: "now" (default, an ISO time) or a value such as 0. */
        start: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((action, ctx) => {
    if (!action.sql && !(action.method && action.path) && !action.tool && !action.goal?.trim() && !action.table) {
      ctx.addIssue({
        code: "custom",
        message: `${action.id}: give a method and a path (web service), a SQL statement (database), a tool (MCP server) or what to do (screens)`,
      });
    }
    const keys = new Set(action.params.map((p) => p.key));
    if (keys.size !== action.params.length) ctx.addIssue({ code: "custom", message: `${action.id}: parameter names must be unique` });
    if (action.watch && !keys.has("since")) ctx.addIssue({ code: "custom", message: `${action.id}: a watched action takes a "since" parameter` });
  });
export type NamedAction = z.infer<typeof NamedAction>;

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
  /** The platform sets it up and keeps it in step (the company's tables): nobody adds or changes it. */
  managed: z.boolean().optional(),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;
