import { z } from "zod";
import { FieldSpecSchema } from "./fields.ts";

/**
 * Archetypes are the reusable "shapes" of enterprise agents. They drive the
 * Agent Builder's question tree, the default workflow, and the generated UI.
 * They map 1:1 onto the default use cases Enterprise Brain ships with.
 */
export const Archetype = z.enum([
  "document-processing",
  "mail-triage",
  "conversational",
  "excel-automation",
  "search",
  "process-automation",
  "report-generation",
]);
export type Archetype = z.infer<typeof Archetype>;

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  "document-processing": "Document & OCR processing",
  "mail-triage": "Mail reading, classification & replies",
  conversational: "Conversational assistant",
  "excel-automation": "Excel automation",
  search: "Enterprise search",
  "process-automation": "Process automation",
  "report-generation": "Report generation",
};

export const TriggerSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("form"), description: z.string().optional() }),
  z.object({
    type: z.literal("mailbox"),
    mailbox: z.string().describe("Mailbox address or alias, e.g. careers@acme.com"),
    filter: z
      .object({
        subjectContains: z.array(z.string()).optional(),
        fromDomains: z.array(z.string()).optional(),
        hasAttachment: z.boolean().optional(),
        categories: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("schedule"), cron: z.string(), timezone: z.string().optional() }),
  z.object({ type: z.literal("webhook"), description: z.string().optional() }),
  z.object({ type: z.literal("chat") }),
  z.object({ type: z.literal("paperclip"), description: z.string().optional() }),
  z.object({
    type: z.literal("connector-event"),
    connector: z.string(),
    event: z.string(),
  }),
]);
export type TriggerSpec = z.infer<typeof TriggerSpec>;

export const Criterion = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  kind: z.enum(["must", "nice", "knockout"]).default("nice"),
  weight: z.number().min(0).default(1),
  /** Keywords used by the offline heuristic evaluator (and as hints for the LLM). */
  keywords: z.array(z.string()).optional(),
  /** Phrases showing the criterion is NOT met ("requires visa sponsorship"); checked before keywords offline. */
  blockers: z.array(z.string()).optional(),
});
export type Criterion = z.infer<typeof Criterion>;

export const Category = z.object({
  value: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
export type Category = z.infer<typeof Category>;

const StepBase = {
  id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  name: z.string().optional(),
  /** Expression evaluated against the run context; the step is skipped when false. */
  when: z.string().optional(),
  onError: z.enum(["fail", "continue"]).optional(),
};

/**
 * Workflow steps. A value such as "{{input.cv}}" is a template resolved against
 * the run context: { input, steps, agent, trigger, run }.
 */
export const WorkflowStep = z.discriminatedUnion("type", [
  z.object({
    ...StepBase,
    type: z.literal("extract"),
    /** Template resolving to a file id or list of file ids. */
    from: z.string(),
    ocr: z.enum(["auto", "always", "never"]).optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("llm.extract"),
    from: z.string(),
    fields: z.array(FieldSpecSchema),
    instructions: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("llm.classify"),
    from: z.string(),
    categories: z.array(Category).min(1),
    multi: z.boolean().optional(),
    instructions: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("llm.evaluate"),
    from: z.string(),
    criteria: z.array(Criterion).min(1),
    /** Additional context (e.g. job description) as a template. */
    context: z.string().optional(),
    passScore: z.number().min(0).max(100).optional(),
    instructions: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("llm.generate"),
    prompt: z.string(),
    format: z.enum(["text", "markdown", "html"]).optional(),
    /** Fallback template used when no LLM is configured. */
    fallback: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("knowledge.search"),
    query: z.string(),
    collections: z.array(z.string()).optional(),
    topK: z.number().int().positive().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("connector"),
    /** Connector alias declared in agent.connectors[].ref */
    connector: z.string(),
    operation: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
    requiresApproval: z.boolean().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("approval"),
    title: z.string(),
    details: z.string().optional(),
    /** Why a person is asked (e.g. what makes it an exception); shown first wherever it reaches them. */
    reason: z.string().optional(),
    assigneeRole: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("mail.send"),
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    inReplyTo: z.string().optional(),
    requiresApproval: z.boolean().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("excel.read"),
    from: z.string(),
    sheet: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("excel.write"),
    /** Template resolving to an array of row objects or { sheets: {name: rows[]} }. */
    data: z.string(),
    fileName: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("agent"),
    /** Task prompt for the autonomous tool-use loop (template). */
    task: z.string(),
    tools: z.array(z.string()).default([]),
    maxTurns: z.number().int().positive().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("wait"),
    /**
     * reply: until someone answers the task's emails, at most `days` (the result says whether they did);
     * time: `days`, or until the date `until` resolves to. The task waits meanwhile, and wakes up here.
     */
    for: z.enum(["reply", "time"]),
    days: z.number().positive().optional(),
    /** Template resolving to a date or date-time (time waits), e.g. "{{ steps.order.delivery_date }}". */
    until: z.string().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("output"),
    /** Map of output field -> template. */
    value: z.record(z.string(), z.unknown()),
  }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;
export type WorkflowStepType = WorkflowStep["type"];

export const ConnectorBinding = z.object({
  /** Alias used by workflow steps, e.g. "ats" or "erp". */
  ref: z.string(),
  category: z.string(),
  /** Bound connector instance id (set when the company configures the integration). */
  instanceId: z.string().optional(),
  purpose: z.string().optional(),
  operations: z.array(z.string()).optional(),
});
export type ConnectorBinding = z.infer<typeof ConnectorBinding>;

export const ModelSettings = z.object({
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

export const UiSpec = z.object({
  layout: z.enum(["form-results", "chat", "inbox", "table", "none"]).default("form-results"),
  title: z.string().optional(),
  description: z.string().optional(),
  submitLabel: z.string().optional(),
  resultView: z.enum(["cards", "table", "json"]).optional(),
  /** Output keys shown as columns/cards headline. */
  highlight: z.array(z.string()).optional(),
});
export type UiSpec = z.infer<typeof UiSpec>;

export const Guardrails = z.object({
  /** Capabilities/steps that always need a human approval, e.g. ["mail.send", "connector:write"]. */
  approvalRequiredFor: z.array(z.string()).default(["mail.send", "connector:write"]),
  personalData: z.enum(["none", "contains", "sensitive"]).default("none"),
  retentionDays: z.number().int().positive().optional(),
  notes: z.array(z.string()).optional(),
});
export type Guardrails = z.infer<typeof Guardrails>;

export const AgentTest = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()).optional(),
});

export const AgentDefinition = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  title: z.string().optional(),
  summary: z.string(),
  department: z.string().optional(),
  process: z.string().optional(),
  archetype: Archetype,
  templateId: z.string().optional(),
  /** System instructions (markdown). */
  instructions: z.string(),
  model: ModelSettings.optional(),
  inputs: z.array(FieldSpecSchema).default([]),
  outputs: z.array(FieldSpecSchema).default([]),
  /** Deterministic workflow. When empty the agent runs as a single autonomous tool loop. */
  workflow: z.array(WorkflowStep).default([]),
  /** Capabilities available to autonomous (`agent`) steps and chat. */
  tools: z.array(z.string()).default([]),
  triggers: z.array(TriggerSpec).default([{ type: "manual" }]),
  knowledge: z.object({ collections: z.array(z.string()).default([]) }).default({ collections: [] }),
  connectors: z.array(ConnectorBinding).default([]),
  guardrails: Guardrails.default({ approvalRequiredFor: ["mail.send", "connector:write"], personalData: "none" }),
  ui: UiSpec.default({ layout: "form-results" }),
  kpis: z
    .array(z.object({ id: z.string(), name: z.string(), target: z.string().optional() }))
    .default([]),
  tests: z.array(AgentTest).default([]),
  paperclip: z
    .object({
      role: z.string().optional(),
      title: z.string().optional(),
      reportsTo: z.string().optional(),
      capabilities: z.string().optional(),
    })
    .optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
export type AgentDefinitionInput = z.input<typeof AgentDefinition>;

export const AgentStatus = z.enum(["draft", "testing", "active", "paused", "archived"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export function parseAgentDefinition(input: unknown): AgentDefinition {
  return AgentDefinition.parse(input);
}
