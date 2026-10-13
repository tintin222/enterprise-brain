import { z } from "zod";
import { TransformOp, type ConnectorBinding, type FieldSpec, type WorkflowStep, type WorkflowStepInput } from "@enterprise-brain/core";

/**
 * A procedure as the Studio writes it: the fixed steps an AI employee follows, in plain kinds with
 * plain fields, nested where a step holds steps (for each item, if). It compiles into the job's real
 * steps: ids from the steps' names, systems and tables resolved like the AI employee's abilities.
 */

export const PROCEDURE_KINDS = [
  "read_file",
  "extract",
  "classify",
  "evaluate",
  "write",
  "look_up",
  "work_it_out",
  "do_in_system",
  "ask_person",
  "send_email",
  "wait_for_reply",
  "wait_for_time",
  "wait_for_call",
  "ask_colleague",
  "post_in_chat",
  "for_each",
  "if",
  "transform",
  "code",
  "answer_caller",
  "result",
] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];

const PLAIN_FIELD_TYPES = ["text", "long_text", "number", "date", "email", "choice", "yes_no"] as const;
const PLAIN_TO_FIELD: Record<(typeof PLAIN_FIELD_TYPES)[number], FieldSpec["type"]> = {
  text: "string",
  long_text: "text",
  number: "number",
  date: "date",
  email: "email",
  choice: "select",
  yes_no: "boolean",
};

/** One step as written: what it does, its name, when it runs, and the fields its kind needs. */
export interface ProcedureStep {
  do: ProcedureKind;
  name: string;
  key?: string;
  only_when?: string;
  retry?: number;
  on_error?: "stop" | "continue" | "skip_rest";
  from?: string;
  fields?: { label: string; type?: (typeof PLAIN_FIELD_TYPES)[number]; required?: boolean; description?: string; choices?: string[] }[];
  categories?: (string | { value: string; description?: string })[];
  criteria?: { label: string; kind?: "must" | "nice" | "deal_breaker"; description?: string }[];
  pass_score?: number;
  instructions?: string;
  text?: string;
  query?: string;
  task?: string;
  system?: string;
  action?: string;
  values?: Record<string, unknown>;
  ask_first?: boolean;
  question?: string;
  who?: string;
  to?: string;
  subject?: string;
  via?: "chat" | "teams" | "google-chat";
  days?: number;
  until?: string;
  colleague?: string;
  request?: string;
  over?: string;
  as?: string;
  at_most?: number;
  steps?: ProcedureStep[];
  when?: string;
  then?: ProcedureStep[];
  otherwise?: ProcedureStep[];
  cases?: { when: string; then: ProcedureStep[] }[];
  ops?: unknown[];
  code?: string;
  status?: number;
  body?: unknown;
  value?: Record<string, unknown>;
}

const steps = (): z.ZodType<ProcedureStep[]> => z.array(z.lazy(() => ProcedureStepSchema)).max(60);

export const ProcedureStepSchema: z.ZodType<ProcedureStep> = z.object({
  do: z.enum(PROCEDURE_KINDS),
  name: z.string().trim().min(2).max(80),
  key: z.string().max(40).optional(),
  only_when: z.string().max(1000).optional(),
  retry: z.number().int().min(1).max(5).optional(),
  on_error: z.enum(["stop", "continue", "skip_rest"]).optional(),
  from: z.string().max(500).optional(),
  fields: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        type: z.enum(PLAIN_FIELD_TYPES).optional(),
        required: z.boolean().optional(),
        description: z.string().max(300).optional(),
        choices: z.array(z.string().max(80)).max(30).optional(),
      }),
    )
    .max(40)
    .optional(),
  categories: z
    .array(z.union([z.string().min(1).max(80), z.object({ value: z.string().min(1).max(80), description: z.string().max(300).optional() })]))
    .max(30)
    .optional(),
  criteria: z
    .array(
      z.object({ label: z.string().min(1).max(200), kind: z.enum(["must", "nice", "deal_breaker"]).optional(), description: z.string().max(500).optional() }),
    )
    .max(30)
    .optional(),
  pass_score: z.number().min(0).max(100).optional(),
  instructions: z.string().max(6000).optional(),
  text: z.string().max(20_000).optional(),
  query: z.string().max(2000).optional(),
  task: z.string().max(20_000).optional(),
  system: z.string().max(120).optional(),
  action: z.string().max(120).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  ask_first: z.boolean().optional(),
  question: z.string().max(500).optional(),
  who: z.string().max(120).optional(),
  to: z.string().max(500).optional(),
  subject: z.string().max(500).optional(),
  via: z.enum(["chat", "teams", "google-chat"]).optional(),
  days: z.number().positive().max(365).optional(),
  until: z.string().max(200).optional(),
  colleague: z.string().max(120).optional(),
  request: z.string().max(6000).optional(),
  over: z.string().max(500).optional(),
  as: z.string().max(40).optional(),
  at_most: z.number().int().min(1).max(1000).optional(),
  steps: steps().optional(),
  when: z.string().max(1000).optional(),
  then: steps().optional(),
  otherwise: steps().optional(),
  cases: z
    .array(z.object({ when: z.string().min(1).max(1000), then: steps() }))
    .max(10)
    .optional(),
  ops: z.array(z.unknown()).max(20).optional(),
  code: z.string().max(20_000).optional(),
  status: z.number().int().min(100).max(599).optional(),
  body: z.unknown().optional(),
  value: z.record(z.string(), z.unknown()).optional(),
});

export const Procedure = z.array(ProcedureStepSchema).max(60);

/** A system a step may act in, as the Studio lists them. */
export interface ProcedureSystem {
  key: string;
  name: string;
  category: string;
  instanceId?: string;
  demo: boolean;
  actions: { id: string; name: string; kind: "read" | "write" }[];
}

export interface ProcedureContext {
  systems: ProcedureSystem[];
  tables: { key: string; name: string }[];
  tablesConnectionId?: string;
  /** The AI employee's connections so far (from its abilities): steps add what they act on. */
  connectors: ConnectorBinding[];
  /** Its abilities, for the steps that work things out with its tools. */
  tools: string[];
  /** Turns a system into the connection alias its steps use. */
  refOf: (system: ProcedureSystem) => string;
}

/** A step id from a name: check_the_total, check_the_total_2. */
function stepIdOf(text: string, taken: Set<string>): string {
  const base =
    text
      .toLocaleLowerCase("tr")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "s_$1")
      .slice(0, 40) || "step";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/**
 * Compile a procedure into the job's steps. Problems say, in plain words, what a step is missing or
 * names wrongly; notes say what the person should know (a system it now acts in).
 */
export function compileProcedure(procedure: ProcedureStep[], ctx: ProcedureContext): { workflow: WorkflowStepInput[]; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();

  const act = (system: string, action: string, label: string): string | undefined => {
    if (system.trim().toLowerCase() === "tables") {
      const match = /^(find|get|add|update)_(.+)$/.exec(action);
      if (!match || !ctx.tables.some((t) => t.key === match[2])) {
        problems.push(`${label}: tables has no action "${action}" (use find_, add_ or update_ with a table's key).`);
        return undefined;
      }
      const ops = match[1] === "update" ? [action, `find_${match[2]}`, `get_${match[2]}`] : match[1] === "find" ? [action, `get_${match[2]}`] : [action];
      const binding = ctx.connectors.find((c) => c.ref === "tables");
      if (binding) binding.operations = [...new Set([...(binding.operations ?? []), ...ops])];
      else
        ctx.connectors.push({
          ref: "tables",
          category: "tables",
          ...(ctx.tablesConnectionId ? { instanceId: ctx.tablesConnectionId } : {}),
          purpose: "Keeps the company's tables",
          operations: ops,
        });
      return "tables";
    }
    const found = ctx.systems.find((s) => s.key === system || s.instanceId === system || s.name.toLowerCase() === system.toLowerCase());
    if (!found) {
      problems.push(`${label}: there is no connected system "${system}"; use a key from look_around, or ask IT with ask_it.`);
      return undefined;
    }
    if (!found.actions.some((a) => a.id === action)) {
      problems.push(`${label}: ${found.name} has no action "${action}". Its actions: ${found.actions.map((a) => a.id).join(", ") || "none"}.`);
      return undefined;
    }
    const ref = ctx.refOf(found);
    const binding = ctx.connectors.find((c) => c.ref === ref);
    if (binding) {
      if (!(binding.operations ?? []).includes(action)) binding.operations = [...(binding.operations ?? []), action];
    } else {
      ctx.connectors.push({
        ref,
        category: found.category,
        ...(found.instanceId ? { instanceId: found.instanceId } : {}),
        purpose: found.name,
        operations: [action],
      });
      notes.push(`It acts in ${found.name} in its steps (${action}).`);
    }
    return ref;
  };

  const compile = (list: ProcedureStep[]): WorkflowStepInput[] => {
    const out: WorkflowStepInput[] = [];
    for (const step of list) {
      const label = `Step "${step.name}" (${step.do})`;
      const need = (value: unknown, what: string): boolean => {
        if (value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) {
          problems.push(`${label}: give ${what}.`);
          return false;
        }
        return true;
      };
      const id = stepIdOf(step.key || step.name, taken);
      const base = {
        id,
        name: step.name,
        ...(step.only_when ? { when: step.only_when } : {}),
        ...(step.retry ? { retry: { times: step.retry, waitSeconds: 30, backoff: "double" as const } } : {}),
        ...(step.on_error === "continue" ? { onError: "continue" as const } : step.on_error === "skip_rest" ? { onError: "skip" as const } : {}),
      };
      let made: WorkflowStepInput | undefined;
      switch (step.do) {
        case "read_file":
          if (need(step.from, "where the file is (from), e.g. {{ input.<field key> }}")) made = { ...base, type: "extract", from: step.from! };
          break;
        case "extract": {
          if (!need(step.from, "what to read (from)") || !need(step.fields, "the fields to find")) break;
          const keys = new Set<string>();
          made = {
            ...base,
            type: "llm.extract",
            from: step.from!,
            fields: step.fields!.map((f) => ({
              key: stepIdOf(f.label, keys),
              label: f.label,
              type: PLAIN_TO_FIELD[f.type ?? "text"],
              ...(f.required ? { required: true } : {}),
              ...(f.description ? { description: f.description } : {}),
              ...(f.type === "choice" && f.choices?.length ? { options: f.choices.map((value) => ({ value })) } : {}),
            })),
            ...(step.instructions ? { instructions: step.instructions } : {}),
          };
          break;
        }
        case "classify":
          if (!need(step.from, "what to read (from)") || !need(step.categories, "the categories")) break;
          made = {
            ...base,
            type: "llm.classify",
            from: step.from!,
            categories: step.categories!.map((c) =>
              typeof c === "string" ? { value: c } : { value: c.value, ...(c.description ? { description: c.description } : {}) },
            ),
            ...(step.instructions ? { instructions: step.instructions } : {}),
          };
          break;
        case "evaluate": {
          if (!need(step.from, "what to judge (from)") || !need(step.criteria, "the criteria")) break;
          const ids = new Set<string>();
          made = {
            ...base,
            type: "llm.evaluate",
            from: step.from!,
            criteria: step.criteria!.map((c) => ({
              id: stepIdOf(c.label, ids),
              label: c.label,
              kind: c.kind === "deal_breaker" ? "knockout" : (c.kind ?? "nice"),
              ...(c.description ? { description: c.description } : {}),
            })),
            ...(step.pass_score !== undefined ? { passScore: step.pass_score } : {}),
            ...(step.instructions ? { instructions: step.instructions } : {}),
          };
          break;
        }
        case "write":
          if (need(step.text, "what to write (text)")) made = { ...base, type: "llm.generate", prompt: step.text!, format: "markdown" };
          break;
        case "look_up":
          if (need(step.query, "what to look up (query)")) made = { ...base, type: "knowledge.search", query: step.query! };
          break;
        case "work_it_out":
          if (need(step.task, "what to work out (task)")) made = { ...base, type: "agent", task: step.task!, tools: ctx.tools };
          break;
        case "do_in_system": {
          if (!need(step.system, "the system") || !need(step.action, "the action")) break;
          const ref = act(step.system!, step.action!, label);
          if (ref)
            made = {
              ...base,
              type: "connector",
              connector: ref,
              operation: step.action!,
              input: step.values ?? {},
              ...(step.ask_first !== undefined ? { requiresApproval: step.ask_first } : {}),
            };
          break;
        }
        case "ask_person":
          if (need(step.question, "the question"))
            made = {
              ...base,
              type: "approval",
              title: step.question!,
              ...(step.text ? { details: step.text } : {}),
              ...(step.who ? { assigneeRole: step.who } : {}),
            };
          break;
        case "send_email":
          if (need(step.to, "to whom (to)") && need(step.subject, "the subject") && need(step.text, "the text"))
            made = { ...base, type: "mail.send", to: step.to!, subject: step.subject!, body: step.text! };
          break;
        case "wait_for_reply":
          made = { ...base, type: "wait", for: "reply", days: step.days ?? 3 };
          break;
        case "wait_for_time":
          if (step.days === undefined && !step.until) problems.push(`${label}: give the days to wait, or the date (until).`);
          else made = { ...base, type: "wait", for: "time", ...(step.days ? { days: step.days } : {}), ...(step.until ? { until: step.until } : {}) };
          break;
        case "wait_for_call":
          made = { ...base, type: "wait", for: "callback", ...(step.days ? { days: step.days } : {}) };
          break;
        case "ask_colleague":
          if (need(step.colleague, "the colleague (its key)") && need(step.request, "what to ask (request)"))
            made = {
              ...base,
              type: "call",
              colleague: step.colleague!,
              request: step.request!,
              ...(step.values ? { input: step.values } : {}),
              ...(step.days ? { days: step.days } : {}),
            };
          break;
        case "post_in_chat":
          if (need(step.to, 'where to write (to): a channel "#name", a person\'s email, or "task"') && need(step.text, "the message (text)"))
            made = { ...base, type: "chat.send", to: step.to!, text: step.text!, ...(step.via ? { via: step.via } : {}) };
          break;
        case "for_each":
          if (need(step.over, "the list to go through (over)") && need(step.steps, "the steps for each item"))
            made = {
              ...base,
              type: "each",
              over: step.over!,
              ...(step.as ? { as: step.as } : {}),
              ...(step.at_most ? { maxItems: step.at_most } : {}),
              steps: compile(step.steps!),
            };
          break;
        case "if": {
          const cases = step.cases?.length ? step.cases : step.when && step.then?.length ? [{ when: step.when, then: step.then }] : [];
          if (!cases.length) {
            problems.push(`${label}: give the condition (when) and the steps (then), or cases.`);
            break;
          }
          made = {
            ...base,
            type: "branch",
            cases: cases.map((c) => ({ when: c.when, steps: compile(c.then) })),
            ...(step.otherwise?.length ? { else: compile(step.otherwise) } : {}),
          };
          break;
        }
        case "transform": {
          if (!need(step.from, "the list (from)") || !need(step.ops, "what to do with it (ops)")) break;
          const ops = z.array(TransformOp).safeParse(step.ops);
          if (!ops.success) {
            problems.push(`${label}: ${ops.error.issues.map((i) => `ops.${i.path.join(".")}: ${i.message}`).join("; ")}`);
            break;
          }
          made = { ...base, type: "transform", from: step.from!, ops: ops.data };
          break;
        }
        case "code":
          if (need(step.code, "the program (code)")) made = { ...base, type: "code", code: step.code!, ...(step.values ? { input: step.values } : {}) };
          break;
        case "answer_caller":
          made = { ...base, type: "respond", ...(step.status ? { status: step.status } : {}), ...(step.body !== undefined ? { body: step.body } : {}) };
          break;
        case "result":
          if (need(step.value, "what the result holds (value)")) made = { ...base, type: "output", value: step.value! };
          break;
      }
      if (made) out.push(made);
    }
    return out;
  };

  return { workflow: compile(procedure), problems, notes };
}

/** The steps of a job in a few words each, holders with what they hold. */
export function procedureOutline(
  workflow: readonly WorkflowStep[],
): { key: string; name: string; type: string; holds?: ReturnType<typeof procedureOutline> }[] {
  return workflow.map((step) => {
    const nested = step.type === "branch" ? [...step.cases.flatMap((c) => c.steps), ...(step.else ?? [])] : step.type === "each" ? step.steps : undefined;
    return { key: step.id, name: step.name ?? step.id, type: step.type, ...(nested ? { holds: procedureOutline(nested) } : {}) };
  });
}
