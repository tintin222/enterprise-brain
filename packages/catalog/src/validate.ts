import {
  SystemCategory,
  evaluateCondition,
  isRecord,
  resolveTemplate,
  type AgentTemplate,
  type Catalog,
  type FieldSpec,
  type ProcessTemplate,
  type WorkflowStep,
} from "@enterprise-brain/core";
import {
  BUILTIN_CAPABILITIES,
  GUARDRAIL_CONNECTOR_POLICIES,
  capabilityCovered,
  isBuiltinCapability,
  parseConnectorCapability,
  stepCapabilities,
} from "./capabilities.ts";
import { SANDBOX_CATEGORIES, findSandboxOperation, isAllowedValue, sandboxOperationsFor } from "./sandbox-operations.ts";
import { sourceOf } from "./sources.ts";

/** Department whose agents (company-wide capabilities) may act in any department's processes. */
export const SHARED_SERVICES_DEPARTMENT = "shared-services";

/**
 * Generic Agent Builder questions a template question must never replace: their answers drive
 * triggers and integration questions, so a template-specific answer would break them.
 */
export const NON_REPLACEABLE_BUILDER_NODES = ["inputs.channels"] as const;

const SYSTEM_CATEGORIES = new Set<string>(SystemCategory.options);
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Roots a template expression may start from (the run context) and literal words of the expression language. */
const TEMPLATE_ROOTS = new Set(["input", "steps", "agent", "trigger", "run"]);
const EXPRESSION_WORDS = new Set(["true", "false", "null", "undefined", "and", "or", "not", "in", "contains"]);
const TEMPLATE_FILTERS = new Set(["json", "join", "default", "upper", "lower", "truncate", "length", "first", "round", "bullets"]);
const DRY_RUN_CONTEXT = { input: {}, steps: {}, agent: {}, trigger: {}, run: {} };

/** Step keys whose values are used verbatim by the runtime (a `{{ }}` there would never be resolved). */
const LITERAL_STEP_KEYS = new Set([
  "id",
  "type",
  "name",
  "onError",
  "ocr",
  "format",
  "connector",
  "operation",
  "assigneeRole",
  "collections",
  "criteria",
  "categories",
  "fields",
  "tools",
  "sheet",
]);

type Problems = string[];

function describe(kind: string, entity: { id: string }): string {
  return sourceOf(entity) ?? `${kind} ${entity.id}`;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) (seen.has(v) ? dupes : seen).add(v);
  return [...dupes];
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

// ---------------------------------------------------------------------------
// Template expressions
// ---------------------------------------------------------------------------

/** The expressions inside `{{ … }}` of a template string. */
function templateExpressions(text: string): string[] {
  return [...text.matchAll(/\{\{([\s\S]+?)\}\}/g)].map((m) => m[1]!.trim());
}

/** Split an expression on filter pipes (single `|` outside quotes; `||` is logical or). */
function splitPipes(expression: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "|" && expression[i + 1] === "|") {
      current += "||";
      i++;
    } else if (ch === "|") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

/** Dotted identifiers of an expression (string literals removed). */
function identifiers(expression: string): string[] {
  const withoutStrings = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, " ");
  return [...withoutStrings.matchAll(/[A-Za-z_$][A-Za-z0-9_$.]*/g)].map((m) => m[0].replace(/\.+$/, ""));
}

interface ExpressionScope {
  /** Step ids that complete before the step being checked. */
  earlierSteps: ReadonlySet<string>;
  allSteps: ReadonlySet<string>;
  inputs: ReadonlySet<string>;
}

/** Check one expression (from `{{ }}` or a `when` condition); returns problem messages. */
function checkExpression(expression: string, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  const [main = "", ...filters] = splitPipes(expression);
  const operands = [main];
  for (const filter of filters) {
    const colon = filter.indexOf(":");
    const name = (colon < 0 ? filter : filter.slice(0, colon)).trim();
    if (!TEMPLATE_FILTERS.has(name)) problems.push(`unknown filter "${name}" in "{{ ${expression} }}" (known: ${[...TEMPLATE_FILTERS].join(", ")})`);
    if (colon >= 0) operands.push(filter.slice(colon + 1));
  }
  for (const operand of operands) {
    for (const id of identifiers(operand)) {
      const [root = "", second] = id.split(".");
      if (EXPRESSION_WORDS.has(root.toLowerCase())) continue;
      if (!TEMPLATE_ROOTS.has(root)) {
        problems.push(`unknown reference "${id}" in "${expression}" (expressions start from input, steps, agent, trigger or run)`);
      } else if (root === "steps" && second !== undefined) {
        if (!scope.allSteps.has(second)) problems.push(`references unknown step "steps.${second}"`);
        else if (!scope.earlierSteps.has(second)) problems.push(`references "steps.${second}", which has not run yet at this point`);
      } else if (root === "input" && second !== undefined && !scope.inputs.has(second)) {
        problems.push(`references "input.${second}", which is not a declared input`);
      }
    }
  }
  return problems;
}

function* stringsIn(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* stringsIn(item, `${path}[${i}]`);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) yield* stringsIn(item, path ? `${path}.${key}` : key);
}

function checkStepTemplates(step: WorkflowStep, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(step)) {
    if (key === "when") {
      if (typeof value !== "string") continue;
      const expressions = value.includes("{{") ? templateExpressions(value) : [value];
      for (const expression of expressions) problems.push(...checkExpression(expression, scope).map((p) => `when: ${p}`));
      try {
        evaluateCondition(value, DRY_RUN_CONTEXT);
      } catch (error) {
        problems.push(`when: invalid condition "${value}": ${(error as Error).message}`);
      }
      continue;
    }
    for (const [path, text] of stringsIn(value, key)) {
      if (!text.includes("{{")) continue;
      if (LITERAL_STEP_KEYS.has(key)) {
        problems.push(`${path}: templates are not resolved in "${key}"`);
        continue;
      }
      for (const expression of templateExpressions(text)) problems.push(...checkExpression(expression, scope).map((p) => `${path}: ${p}`));
      try {
        resolveTemplate(text, DRY_RUN_CONTEXT);
      } catch (error) {
        problems.push(`${path}: invalid template: ${(error as Error).message}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

interface CatalogIndex {
  agents: Map<string, AgentTemplate>;
  processes: Map<string, ProcessTemplate>;
  departments: Set<string>;
  /** role id -> departments defining it */
  roles: Map<string, string[]>;
  useCases: Set<string>;
}

function fieldKeyProblems(fields: readonly FieldSpec[], where: string): string[] {
  const problems = duplicates(fields.map((f) => f.key)).map((k) => `${where}: duplicate field key "${k}"`);
  for (const field of fields) {
    if (field.fields?.length) problems.push(...fieldKeyProblems(field.fields, `${where}.${field.key}`));
  }
  return problems;
}

function validateAgent(agent: AgentTemplate, index: CatalogIndex): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(message);

  if (!index.departments.has(agent.department)) add(`department "${agent.department}" does not exist`);
  if (!agent.id.startsWith(`${agent.department}.`)) add(`id "${agent.id}" must start with its department "${agent.department}."`);
  const expectedSlug = agent.id.replace(".", "-");
  if (agent.slug !== expectedSlug) add(`slug "${agent.slug}" should be "${expectedSlug}" (<department>-<agent>)`);

  if (agent.process !== undefined) {
    const process = index.processes.get(agent.process);
    if (!process) add(`process "${agent.process}" does not exist`);
    else {
      if (process.department !== agent.department) add(`process "${agent.process}" belongs to department "${process.department}", not "${agent.department}"`);
      if (!process.agents.includes(agent.id)) add(`process "${agent.process}" does not list this agent in its agents`);
    }
  }
  if (agent.reportsTo !== undefined && !index.agents.has(agent.reportsTo) && !index.roles.has(agent.reportsTo)) {
    add(`reportsTo "${agent.reportsTo}" is neither an agent template nor a human role of any department`);
  }

  // Connector bindings
  const bindings = new Map(agent.connectors.map((b) => [b.ref, b]));
  for (const ref of duplicates(agent.connectors.map((b) => b.ref))) add(`connectors: duplicate ref "${ref}"`);
  for (const binding of agent.connectors) {
    if (!SYSTEM_CATEGORIES.has(binding.category)) {
      add(`connectors.${binding.ref}: unknown category "${binding.category}" (known: ${[...SYSTEM_CATEGORIES].join(", ")})`);
      continue;
    }
    if (!SANDBOX_CATEGORIES.includes(binding.category)) continue;
    for (const operation of binding.operations ?? []) {
      if (!findSandboxOperation(binding.category, operation)) {
        add(`connectors.${binding.ref}: operation "${operation}" does not exist for category "${binding.category}"`);
      }
    }
  }

  const capabilityProblem = (name: string, where: string): string | undefined => {
    if (isBuiltinCapability(name)) return undefined;
    const parsed = parseConnectorCapability(name);
    if (!parsed) return `${where}: unknown capability "${name}" (known: ${BUILTIN_CAPABILITIES.join(", ")}, connector:<ref>[.<operation>])`;
    const binding = bindings.get(parsed.ref);
    if (!binding) return `${where}: "${name}" refers to connector "${parsed.ref}", which is not declared in connectors`;
    if (parsed.operation && SANDBOX_CATEGORIES.includes(binding.category) && !findSandboxOperation(binding.category, parsed.operation)) {
      return `${where}: "${name}": category "${binding.category}" has no operation "${parsed.operation}"`;
    }
    return undefined;
  };
  for (const name of agent.capabilities) {
    const p = capabilityProblem(name, "capabilities");
    if (p) add(p);
  }
  for (const name of agent.tools) {
    const p = capabilityProblem(name, "tools");
    if (p) add(p);
    else if (!capabilityCovered(agent.capabilities, name)) add(`tools: "${name}" is not listed in capabilities`);
  }
  for (const policy of agent.guardrails.approvalRequiredFor) {
    if ((GUARDRAIL_CONNECTOR_POLICIES as readonly string[]).includes(policy)) continue;
    const p = capabilityProblem(policy, "guardrails.approvalRequiredFor");
    if (p) add(p);
  }

  // Inputs, outputs, triggers, UI
  problems.push(...fieldKeyProblems(agent.inputs, "inputs"), ...fieldKeyProblems(agent.outputs, "outputs"));
  const inputKeys = new Set(agent.inputs.map((f) => f.key));
  const outputKeys = new Set(agent.outputs.map((f) => f.key));
  for (const trigger of agent.triggers) {
    if (trigger.type === "mailbox") {
      const email = agent.inputs.find((f) => f.key === "email");
      if (!email || email.type !== "object") add(`triggers: a mailbox trigger needs an input field "email" of type "object" (runs receive input.email)`);
    } else if (trigger.type === "schedule") {
      if (trigger.cron.trim().split(/\s+/).length !== 5) add(`triggers: cron "${trigger.cron}" must have 5 fields`);
    } else if (trigger.type === "connector-event" && !bindings.has(trigger.connector)) {
      add(`triggers: connector-event refers to connector "${trigger.connector}", which is not declared in connectors`);
    }
  }
  for (const key of agent.ui.highlight ?? []) {
    if (!outputKeys.has(key)) add(`ui.highlight: "${key}" is not a declared output`);
  }
  for (const id of duplicates(agent.kpis.map((k) => k.id))) add(`kpis: duplicate id "${id}"`);
  const collections = new Set(agent.knowledge.collections);

  // Workflow
  if (agent.workflow.length === 0) {
    if (agent.tools.length === 0) add("an agent without a workflow runs as an autonomous tool loop and needs tools");
  } else {
    const stepIds = agent.workflow.map((s) => s.id);
    for (const id of duplicates(stepIds)) add(`workflow: duplicate step id "${id}"`);
    const allSteps = new Set(stepIds);
    const earlier = new Set<string>();
    const approvals: string[] = [];
    for (const step of agent.workflow) {
      const where = `workflow step "${step.id}"`;
      for (const p of checkStepTemplates(step, { earlierSteps: earlier, allSteps, inputs: inputKeys })) add(`${where}: ${p}`);
      for (const needed of stepCapabilities(step)) {
        const p = capabilityProblem(needed, where);
        if (p) add(p);
        else if (!capabilityCovered(agent.capabilities, needed)) add(`${where}: needs capability "${needed}", which is not listed in capabilities`);
      }

      let isWrite = step.type === "mail.send";
      switch (step.type) {
        case "connector": {
          const binding = bindings.get(step.connector);
          if (!binding) {
            add(`${where}: connector "${step.connector}" is not declared in connectors`);
            break;
          }
          if (!SANDBOX_CATEGORIES.includes(binding.category)) {
            add(`${where}: connector "${step.connector}" has category "${binding.category}", which has no sandbox operations (${SANDBOX_CATEGORIES.join(", ")} do)`);
            break;
          }
          const operation = findSandboxOperation(binding.category, step.operation);
          if (!operation) {
            add(
              `${where}: "${step.connector}" (${binding.category}) has no operation "${step.operation}" (available: ${sandboxOperationsFor(binding.category)
                .map((o) => o.id)
                .join(", ")})`,
            );
            break;
          }
          if (binding.operations?.length && !binding.operations.includes(step.operation)) {
            add(`${where}: operation "${step.operation}" is not in connectors.${binding.ref}.operations`);
          }
          const params = Object.keys(step.input);
          const unknown = params.filter((p) => !operation.required.includes(p) && !operation.optional.includes(p));
          if (unknown.length) {
            add(`${where}: unknown input ${quoteList(unknown)} for ${step.operation} (parameters: ${[...operation.required, ...operation.optional.map((o) => `${o}?`)].join(", ")})`);
          }
          const missing = operation.required.filter((p) => !(p in step.input));
          if (missing.length) add(`${where}: missing required input ${quoteList(missing)} for ${step.operation}`);
          for (const [param, value] of Object.entries(step.input)) {
            if (typeof value === "string" && !value.includes("{{") && !isAllowedValue(operation, param, value)) {
              add(`${where}: ${param} "${value}" is not allowed for ${step.operation} (allowed: ${(operation.enums[param] ?? []).join(", ")})`);
            }
          }
          isWrite = operation.kind === "write";
          break;
        }
        case "llm.generate":
          if (!step.fallback?.trim()) add(`${where}: llm.generate needs a fallback template so the agent still works offline`);
          break;
        case "llm.classify":
          for (const v of duplicates(step.categories.map((c) => c.value))) add(`${where}: duplicate category "${v}"`);
          break;
        case "llm.evaluate":
          for (const id of duplicates(step.criteria.map((c) => c.id))) add(`${where}: duplicate criterion id "${id}"`);
          for (const criterion of step.criteria) {
            const keywords = new Set((criterion.keywords ?? []).map((k) => k.toLowerCase()));
            const both = (criterion.blockers ?? []).filter((b) => keywords.has(b.toLowerCase()));
            if (both.length) add(`${where}: criterion "${criterion.id}" lists ${quoteList(both)} both as keyword and as blocker`);
          }
          break;
        case "llm.extract":
          problems.push(...fieldKeyProblems(step.fields, `${where}: fields`));
          break;
        case "knowledge.search":
          for (const c of step.collections ?? []) {
            if (!collections.has(c)) add(`${where}: collection "${c}" is not declared in knowledge.collections`);
          }
          break;
        case "approval":
          if (step.assigneeRole !== undefined && !index.roles.has(step.assigneeRole)) {
            add(`${where}: assigneeRole "${step.assigneeRole}" is not a human role of any department`);
          }
          approvals.push(step.id);
          break;
        case "output": {
          for (const key of Object.keys(step.value)) {
            if (!outputKeys.has(key)) add(`${where}: sets "${key}", which is not declared in outputs`);
          }
          for (const key of outputKeys) {
            if (!(key in step.value)) add(`${where}: declared output "${key}" is never set`);
          }
          break;
        }
        default:
          break;
      }

      const explicitNoApproval = (step.type === "connector" || step.type === "mail.send") && step.requiresApproval === false;
      if (explicitNoApproval && isWrite) {
        const gated = approvals.some((id) => new RegExp(`(?<![\\w.$])steps\\.${id}\\.approved\\b`).test(step.when ?? ""));
        if (!gated) {
          add(`${where}: requiresApproval is false but the step is not conditioned on an earlier approval step (when: steps.<approval>.approved)`);
        }
      }
      earlier.add(step.id);
    }
    const last = agent.workflow[agent.workflow.length - 1];
    if (last?.type !== "output") add(`workflow must end with an "output" step (last step is "${last?.id}")`);
  }

  // Builder hints
  const questions = agent.builder.questions;
  const questionIds = new Set(questions.map((q) => q.id));
  const namespaces = new Set(questions.map((q) => q.id.split(".")[0]));
  for (const id of duplicates(questions.map((q) => q.id))) add(`builder.questions: duplicate id "${id}"`);
  for (const id of duplicates(questions.flatMap((q) => q.replaces ?? []))) {
    add(`builder.questions: "${id}" is replaced by more than one question`);
  }
  for (const q of questions) {
    for (const replaced of q.replaces ?? []) {
      if ((NON_REPLACEABLE_BUILDER_NODES as readonly string[]).includes(replaced)) {
        add(`builder.questions.${q.id}: must not replace "${replaced}" (its answer drives triggers and integration questions)`);
      } else if (questionIds.has(replaced)) {
        add(`builder.questions.${q.id}: replaces "${replaced}", which is a question of this template`);
      }
    }
    const values = new Set((q.options ?? []).map((o) => o.value));
    if (values.size && q.recommended !== undefined) {
      const recommended = Array.isArray(q.recommended) ? q.recommended : [q.recommended];
      if (q.answerType === "single" || q.answerType === "multi") {
        for (const r of recommended) {
          if (!values.has(String(r))) add(`builder.questions.${q.id}: recommended "${String(r)}" is not one of its options`);
        }
      }
    }
    for (const prerequisite of q.prerequisites ?? []) {
      if (namespaces.has(prerequisite.split(".")[0]) && !questionIds.has(prerequisite)) {
        add(`builder.questions.${q.id}: prerequisite "${prerequisite}" does not exist`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Cross-reference checks over a loaded catalog. Returns human-readable
 * problems (empty when the catalog is consistent), each prefixed with the file
 * it concerns when the catalog was loaded from disk.
 */
export function validateCatalog(catalog: Catalog): string[] {
  const problems: Problems = [];
  const report = (location: string, message: string) => problems.push(`${location}: ${message}`);

  const roles = new Map<string, string[]>();
  for (const department of catalog.departments) {
    for (const role of department.roles) roles.set(role.id, [...(roles.get(role.id) ?? []), department.id]);
  }
  const index: CatalogIndex = {
    agents: new Map(catalog.agents.map((a) => [a.id, a])),
    processes: new Map(catalog.processes.map((p) => [p.id, p])),
    departments: new Set(catalog.departments.map((d) => d.id)),
    roles,
    useCases: new Set(catalog.useCases.map((u) => u.id)),
  };

  for (const id of duplicates(catalog.departments.map((d) => d.id))) problems.push(`duplicate department id "${id}"`);
  for (const id of duplicates(catalog.processes.map((p) => p.id))) problems.push(`duplicate process id "${id}"`);
  for (const id of duplicates(catalog.agents.map((a) => a.id))) problems.push(`duplicate agent id "${id}"`);
  for (const id of duplicates(catalog.useCases.map((u) => u.id))) problems.push(`duplicate use case id "${id}"`);
  for (const slug of duplicates(catalog.agents.map((a) => a.slug))) {
    const owners = catalog.agents.filter((a) => a.slug === slug).map((a) => a.id);
    problems.push(`duplicate agent slug "${slug}" (${owners.join(", ")})`);
  }

  // Departments
  for (const department of catalog.departments) {
    const where = describe("department", department);
    for (const role of department.roles) {
      if (!KEBAB.test(role.id)) report(where, `role id "${role.id}" must be kebab-case`);
    }
    for (const id of duplicates(department.roles.map((r) => r.id))) report(where, `duplicate role id "${id}"`);
    for (const id of duplicates(department.kpis.map((k) => k.id))) report(where, `duplicate KPI id "${id}"`);
    for (const id of duplicates(department.processes)) report(where, `process "${id}" is listed twice`);
    for (const processId of department.processes) {
      const process = index.processes.get(processId);
      if (!process) report(where, `process "${processId}" does not exist`);
      else if (process.department !== department.id) report(where, `process "${processId}" belongs to department "${process.department}"`);
    }
  }

  // Processes
  for (const process of catalog.processes) {
    const where = describe("process", process);
    const department = catalog.departments.find((d) => d.id === process.department);
    if (!department) report(where, `department "${process.department}" does not exist`);
    else if (!department.processes.includes(process.id)) report(where, `not listed in the processes of department "${department.id}"`);
    if (!process.id.startsWith(`${process.department}.`)) report(where, `id must start with its department "${process.department}."`);
    for (const id of duplicates(process.steps.map((s) => s.id))) report(where, `duplicate step id "${id}"`);
    for (const id of duplicates(process.kpis.map((k) => k.id))) report(where, `duplicate KPI id "${id}"`);
    for (const agentId of process.agents) {
      const agent = index.agents.get(agentId);
      if (!agent) report(where, `agent "${agentId}" does not exist`);
      else if (!process.steps.some((s) => s.actor === `agent:${agentId}`)) report(where, `agent "${agentId}" is listed but performs no step`);
    }
    const ownRoles = new Set(department?.roles.map((r) => r.id) ?? []);
    for (const step of process.steps) {
      const stepWhere = `step "${step.id}"`;
      const [kind, ref = ""] = step.actor.split(":") as [string, string?];
      if (kind === "agent") {
        const agent = index.agents.get(ref);
        if (!agent) report(where, `${stepWhere}: actor "${step.actor}" is not an agent template`);
        else {
          if (!process.agents.includes(ref)) report(where, `${stepWhere}: agent "${ref}" acts in a step but is not listed in agents`);
          if (agent.department !== process.department && agent.department !== SHARED_SERVICES_DEPARTMENT) {
            report(where, `${stepWhere}: agent "${ref}" belongs to department "${agent.department}"`);
          }
        }
        if (step.approval) report(where, `${stepWhere}: approvals must be performed by a human role, not an agent`);
      } else if (kind === "human") {
        if (!ownRoles.has(ref) && !roles.has(ref)) report(where, `${stepWhere}: actor "${step.actor}" is not a role of any department`);
      } else if (kind === "system") {
        if (!SYSTEM_CATEGORIES.has(ref)) report(where, `${stepWhere}: actor "${step.actor}" is not a known system category`);
        if (step.approval) report(where, `${stepWhere}: approvals must be performed by a human role, not a system`);
      }
    }
    for (const useCase of process.useCases) {
      if (!index.useCases.has(useCase)) report(where, `use case "${useCase}" does not exist`);
    }
  }

  // Agents
  for (const agent of catalog.agents) {
    const where = describe("agent", agent);
    for (const p of validateAgent(agent, index)) report(where, p);
  }

  // Use cases
  for (const useCase of catalog.useCases) {
    const where = describe("use case", useCase);
    if (useCase.defaultAgent !== undefined) {
      const agent = index.agents.get(useCase.defaultAgent);
      if (!agent) report(where, `defaultAgent "${useCase.defaultAgent}" does not exist`);
      else if (agent.archetype !== useCase.archetype) {
        report(where, `defaultAgent "${agent.id}" has archetype "${agent.archetype}" but the use case is "${useCase.archetype}"`);
      }
    }
    if (useCase.app !== undefined && !useCase.app.startsWith("/")) report(where, `app route "${useCase.app}" must start with "/"`);
    for (const capability of useCase.capabilities) {
      if (!isBuiltinCapability(capability) && !parseConnectorCapability(capability)) report(where, `unknown capability "${capability}"`);
    }
  }
  return problems;
}
