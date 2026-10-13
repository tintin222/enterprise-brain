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
  z.object({
    type: z.literal("form"),
    description: z.string().optional(),
    /** A public page anyone with its link fills in (or anyone signed in, with `signIn`); each submission starts the work. */
    public: z
      .object({
        enabled: z.boolean(),
        title: z.string().optional(),
        intro: z.string().optional(),
        signIn: z.boolean().optional(),
        /** What the person reads after sending it. */
        thanks: z.string().optional(),
      })
      .optional(),
  }),
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
  z.object({
    type: z.literal("webhook"),
    description: z.string().optional(),
    /** How a caller proves itself: its secret in a header (the default), or a signature of the body with it (HMAC). */
    auth: z.enum(["secret", "hmac"]).optional(),
    /** The caller waits for the answer a `respond` step gives (or the run's output), instead of a receipt. */
    respond: z.boolean().optional(),
    /** How long a waiting caller waits, at most (default 25 seconds). */
    waitSeconds: z.number().int().min(1).max(55).optional(),
  }),
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
  /**
   * When the step fails (after its retries): fail stops the run (the default); continue keeps the error as
   * the step's result and goes on; skip leaves out the steps after it (an output step at the end still runs).
   */
  onError: z.enum(["fail", "continue", "skip"]).optional(),
  /** Try again when the step fails: how many more times, how long to wait first, and whether the wait doubles. */
  retry: z
    .object({
      times: z.number().int().min(1).max(5),
      waitSeconds: z.number().min(0).max(600).optional(),
      backoff: z.enum(["fixed", "double"]).optional(),
    })
    .optional(),
  /** The step fails when it takes longer than this. */
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
};

const StepBaseSchema = z.object(StepBase);
/** What every step has: its id, name, condition and error policy. */
export type StepBaseFields = z.infer<typeof StepBaseSchema>;

/** One change a transform step makes to a list, in order. Fields are paths in each item ("customer.name"). */
export const TransformOp = z.discriminatedUnion("op", [
  /** Set fields of each item from templates, which see the item as `item` (and its position as `index`). */
  z.object({ op: z.literal("set"), fields: z.record(z.string(), z.unknown()) }),
  /** Keep the items for which the condition holds (the item is `item`). */
  z.object({ op: z.literal("filter"), where: z.string() }),
  z.object({ op: z.literal("sort"), by: z.string(), order: z.enum(["asc", "desc"]).optional() }),
  /** Totals per group (or for the whole list): each value is a count, sum, average, smallest, largest, first, last or list of a field. */
  z.object({
    op: z.literal("aggregate"),
    groupBy: z.array(z.string()).optional(),
    values: z.record(
      z.string(),
      z.object({ fn: z.enum(["count", "sum", "avg", "min", "max", "first", "last", "list"]), field: z.string().optional() }),
    ),
  }),
  /** Drop repeated items: the same values in these fields (or the same item). */
  z.object({ op: z.literal("dedupe"), by: z.array(z.string()).optional() }),
  z.object({ op: z.literal("pick"), fields: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("rename"), fields: z.record(z.string(), z.string()) }),
  z.object({ op: z.literal("limit"), count: z.number().int().min(0), offset: z.number().int().min(0).optional() }),
]);
export type TransformOp = z.infer<typeof TransformOp>;

/**
 * The steps that do one thing. A value such as "{{input.cv}}" is a template resolved against the run
 * context: { input, steps, agent, trigger, run, vars } (and `item`, `index` inside a loop).
 */
export const LeafStep = z.discriminatedUnion("type", [
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
     * time: `days`, or until the date `until` resolves to; callback: until another system calls the address
     * the step gives it (at most `days`, 7 by default), the call's body becoming the step's result. The task
     * waits meanwhile, and wakes up here.
     */
    for: z.enum(["reply", "time", "callback"]),
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
  z.object({
    ...StepBase,
    type: z.literal("transform"),
    /** Template resolving to a list (an object counts as a list of one). */
    from: z.string(),
    ops: z.array(TransformOp).min(1),
  }),
  z.object({
    ...StepBase,
    type: z.literal("code"),
    /**
     * JavaScript, as the body of `function run(ctx)`: `ctx` holds input, steps, vars, item and index (and the
     * step's own `input`), and what it returns is the step's result. It runs in a sandbox: no network, files
     * or timers, five seconds at most.
     */
    code: z.string().min(1),
    /** Values the code gets as ctx.input, as templates. */
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("call"),
    /** The colleague AI employee given the work: its slug or name. */
    colleague: z.string(),
    /** What it should do (a template); its answer is the step's result. */
    request: z.string(),
    /** Values it gets as its input (templates). */
    input: z.record(z.string(), z.unknown()).optional(),
    /** How long to wait for its answer, at most (default 3 days). */
    days: z.number().positive().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("chat.send"),
    /** A channel ("#finance"), a person's email (their direct message with the AI employee) or "task" (the task's conversation); a template. */
    to: z.string(),
    /** For a person: where it reaches them (Chat by default). */
    via: z.enum(["chat", "teams", "google-chat"]).optional(),
    text: z.string(),
    requiresApproval: z.boolean().optional(),
  }),
  z.object({
    ...StepBase,
    type: z.literal("respond"),
    /** The answer a system that called the AI employee and waits gets: its status (200 by default), headers and body (templates). */
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
]);
export type LeafStep = z.infer<typeof LeafStep>;
type LeafStepInput = z.input<typeof LeafStep>;

/** One case of a branch: the steps that run when its condition holds. */
export interface BranchCase {
  id?: string;
  when: string;
  steps: WorkflowStep[];
}

/** A branch runs the steps of the first case whose condition holds, else its `else` steps (or none). */
export interface BranchStep extends StepBaseFields {
  type: "branch";
  cases: BranchCase[];
  else?: WorkflowStep[];
}

interface EachFields extends StepBaseFields {
  type: "each";
  over: string;
  as?: string;
  batchSize?: number;
  maxItems?: number;
  collect?: unknown;
  onItemError?: "fail" | "continue" | "skip";
}

/** A loop runs its steps once for each item of a list. */
export interface EachStep extends EachFields {
  steps: WorkflowStep[];
}

export type WorkflowStep = LeafStep | BranchStep | EachStep;
export type WorkflowStepType = WorkflowStep["type"];

/** The same, as written (before defaults are filled in). */
export interface BranchStepInput extends StepBaseFields {
  type: "branch";
  cases: { id?: string; when: string; steps: WorkflowStepInput[] }[];
  else?: WorkflowStepInput[];
}
export interface EachStepInput extends EachFields {
  steps: WorkflowStepInput[];
}
export type WorkflowStepInput = LeafStepInput | BranchStepInput | EachStepInput;

const nested = () => z.array(z.lazy(() => WorkflowStep));

const BranchStepSchema = z.object({
  ...StepBase,
  type: z.literal("branch"),
  cases: z.array(z.object({ id: z.string().optional(), when: z.string().min(1), steps: nested() })).min(1),
  else: nested().optional(),
});

const EachStepSchema = z.object({
  ...StepBase,
  type: z.literal("each"),
  /** Template resolving to the list to go through (a number: that many rounds). */
  over: z.string(),
  /** Another name for the current item in the steps' templates (it is always `item` too). */
  as: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .optional(),
  steps: nested().min(1),
  /** Items taken together per round: `item` is then a list of at most this many. */
  batchSize: z.number().int().min(1).max(100).optional(),
  /** The most items it goes through (200 by default, 1,000 at most); the rest are left out and counted. */
  maxItems: z.number().int().min(1).max(1000).optional(),
  /** What each round adds to the step's result (a template seeing `item` and the round's steps); the last step's result otherwise. */
  collect: z.unknown().optional(),
  /** When a round fails: fail the loop (the default), keep the error as the round's result, or leave the round out. */
  onItemError: z.enum(["fail", "continue", "skip"]).optional(),
});

/** Any step of a job: one that does something, or a branch or loop holding more steps. */
export const WorkflowStep: z.ZodType<WorkflowStep, WorkflowStepInput> = z.discriminatedUnion("type", [...LeafStep.options, BranchStepSchema, EachStepSchema]);

/** The steps a step holds, by where they are in it ("case 0", "else", "each"). */
export function childSequences(step: WorkflowStep): { slot: string; steps: WorkflowStep[] }[] {
  if (step.type === "branch") {
    const cases = step.cases.map((c: BranchCase, i: number) => ({ slot: `case ${c.id ?? i}`, steps: c.steps }));
    return [...cases, ...(step.else ? [{ slot: "else", steps: step.else }] : [])];
  }
  if (step.type === "each") return [{ slot: "each", steps: step.steps }];
  return [];
}

export interface StepVisit {
  step: WorkflowStep;
  depth: number;
  /** The branch or loop holding it. */
  parent?: WorkflowStep;
  /** Inside a loop (its steps run once per item). */
  inLoop: boolean;
}

/** Every step of a job, holders before what they hold, in the order they are written. */
export function* walkSteps(steps: readonly WorkflowStep[], depth = 0, parent?: WorkflowStep, inLoop = false): Generator<StepVisit> {
  for (const step of steps) {
    yield { step, depth, inLoop, ...(parent ? { parent } : {}) };
    for (const child of childSequences(step)) yield* walkSteps(child.steps, depth + 1, step, inLoop || step.type === "each");
  }
}

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
  /** When a task fails for good: the person told instead of its manager (an email), and a colleague AI employee given the failure as work (its slug). */
  onFailure: z
    .object({
      tell: z.string().optional(),
      giveTo: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
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
