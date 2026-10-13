import { walkSteps, type AgentDefinition, type BranchCase, type WorkflowStep } from "./agent.ts";
import { evaluateCondition, resolveTemplate, TEMPLATE_FILTER_NAMES, TEMPLATE_FUNCTION_NAMES } from "./expressions.ts";
import { isRecord } from "./util.ts";

/**
 * Checks of a job's steps that need no company data: every step id once in the whole job, branches and
 * loops with steps in them, and every template and condition readable, starting from what the run gives
 * (input, steps, agent, trigger, run, vars; item and index inside a loop), naming steps that have run by
 * then, inputs the job declares, and only the filters and functions there are.
 */

/** Roots a template expression may start from (the run context). */
export const TEMPLATE_ROOTS = ["input", "steps", "agent", "trigger", "run", "vars"] as const;
const LOOP_ROOTS = ["item", "index"] as const;
const EXPRESSION_WORDS = new Set(["true", "false", "null", "undefined", "and", "or", "not", "in", "contains"]);
const FILTERS = new Set(TEMPLATE_FILTER_NAMES);
const FUNCTIONS = new Set(TEMPLATE_FUNCTION_NAMES);
const DRY_RUN_CONTEXT = { input: {}, steps: {}, agent: {}, trigger: {}, run: {}, vars: {}, item: {}, index: 0 };

/** Step keys whose values are used verbatim by the runtime (a `{{ }}` there would never be resolved), or checked on their own. */
export const LITERAL_STEP_KEYS = new Set([
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
  // Checked on their own: nested steps, loop settings, the step's code, transform operations.
  "cases",
  "else",
  "steps",
  "as",
  "batchSize",
  "maxItems",
  "onItemError",
  "collect",
  "retry",
  "timeoutSeconds",
  "colleague",
  "via",
  "status",
  "code",
  "ops",
]);

/** What a template may name at one place in a job. */
export interface ExpressionScope {
  /** Step ids that complete before the step being checked. */
  earlierSteps: ReadonlySet<string>;
  allSteps: ReadonlySet<string>;
  /** Declared inputs; an empty set leaves `input.*` unchecked unless `strictInputs`. */
  inputs: ReadonlySet<string>;
  strictInputs?: boolean;
  /** Roots that exist here besides the run context's (item, index and a loop's own name). */
  extraRoots?: ReadonlySet<string>;
}

/** The expressions inside `{{ … }}` of a template string. */
export function templateExpressions(text: string): string[] {
  return [...text.matchAll(/\{\{([\s\S]+?)\}\}/g)].map((m) => m[1]!.trim());
}

/** Split an expression on filter pipes (single `|` outside quotes and parentheses; `||` is logical or). */
function splitPipes(expression: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let current = "";
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "|" && expression[i + 1] === "|") {
      current += "||";
      i++;
    } else if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

/** Dotted identifiers of an expression (string literals and function names removed). */
function identifiers(expression: string): string[] {
  const withoutStrings = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, " ");
  const out: string[] = [];
  for (const match of withoutStrings.matchAll(/[A-Za-z_$][A-Za-z0-9_$.]*/g)) {
    const name = match[0].replace(/\.+$/, "");
    const after = withoutStrings.slice((match.index ?? 0) + match[0].length).trimStart();
    if (after.startsWith("(") && !name.includes(".")) {
      if (!FUNCTIONS.has(name)) out.push(`${name}()`);
      continue;
    }
    out.push(name);
  }
  return out;
}

/** Check one expression (from `{{ }}` or a condition); returns problem messages. */
export function checkExpression(expression: string, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  const [main = "", ...filters] = splitPipes(expression);
  const operands = [main];
  for (const filter of filters) {
    const colon = filter.indexOf(":");
    const name = (colon < 0 ? filter : filter.slice(0, colon)).trim();
    if (!FILTERS.has(name)) problems.push(`unknown filter "${name}" in "{{ ${expression} }}" (known: ${[...FILTERS].join(", ")})`);
    if (colon >= 0) operands.push(filter.slice(colon + 1));
  }
  const roots = new Set<string>([...TEMPLATE_ROOTS, ...(scope.extraRoots ?? [])]);
  for (const operand of operands) {
    for (const id of identifiers(operand)) {
      if (id.endsWith("()")) {
        problems.push(
          `unknown function "${id.slice(0, -2)}" in "${expression}" (known: ${[...FUNCTIONS].filter((f) => !FILTERS.has(f)).join(", ")} and the filters)`,
        );
        continue;
      }
      const [root = "", second] = id.split(".");
      if (EXPRESSION_WORDS.has(root.toLowerCase())) continue;
      if (!roots.has(root)) {
        problems.push(`unknown reference "${id}" in "${expression}" (expressions start from ${[...roots].join(", ")})`);
      } else if (root === "steps" && second !== undefined) {
        if (!scope.allSteps.has(second)) problems.push(`references unknown step "steps.${second}"`);
        else if (!scope.earlierSteps.has(second)) problems.push(`references "steps.${second}", which has not run yet at this point`);
      } else if (root === "input" && second !== undefined && (scope.strictInputs || scope.inputs.size > 0) && !scope.inputs.has(second)) {
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

/** A condition (bare or in `{{ }}`): its references, and that it reads. */
function checkCondition(value: string, label: string, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  const expressions = value.includes("{{") ? templateExpressions(value) : [value];
  for (const expression of expressions) problems.push(...checkExpression(expression, scope).map((p) => `${label}: ${p}`));
  try {
    evaluateCondition(value, DRY_RUN_CONTEXT);
  } catch (error) {
    problems.push(`${label}: invalid condition "${value}": ${(error as Error).message}`);
  }
  return problems;
}

/** Template strings somewhere in a value: their references, and that they read. */
function checkTemplates(value: unknown, path: string, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  for (const [where, text] of stringsIn(value, path)) {
    if (!text.includes("{{")) continue;
    for (const expression of templateExpressions(text)) problems.push(...checkExpression(expression, scope).map((p) => `${where}: ${p}`));
    try {
      resolveTemplate(text, DRY_RUN_CONTEXT);
    } catch (error) {
      problems.push(`${where}: invalid template: ${(error as Error).message}`);
    }
  }
  return problems;
}

/** The templates and condition of one step, without the steps it holds. */
export function checkStepTemplates(step: WorkflowStep, scope: ExpressionScope): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(step)) {
    if (key === "when") {
      if (typeof value === "string") problems.push(...checkCondition(value, "when", scope));
      continue;
    }
    if (LITERAL_STEP_KEYS.has(key)) {
      // Checked on their own: the steps a branch or loop holds, transform operations, what a loop collects.
      if (["ops", "collect", "cases", "else", "steps"].includes(key)) continue;
      for (const [path, text] of stringsIn(value, key)) {
        if (text.includes("{{")) problems.push(`${path}: templates are not resolved in "${key}"`);
      }
      continue;
    }
    problems.push(...checkTemplates(value, key, scope));
  }
  if (step.type === "transform") {
    const inItem: ExpressionScope = { ...scope, extraRoots: new Set([...(scope.extraRoots ?? []), ...LOOP_ROOTS]) };
    step.ops.forEach((op, i) => {
      if (op.op === "set") problems.push(...checkTemplates(op.fields, `ops[${i}].fields`, inItem));
      if (op.op === "filter") problems.push(...checkCondition(op.where, `ops[${i}].where`, inItem));
    });
  }
  return problems;
}

/** Repeated values of a list. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) (seen.has(v) ? dupes : seen).add(v);
  return [...dupes];
}

export interface WorkflowCheckOptions {
  /** The job's declared inputs (`input.*` is checked against them when given). */
  inputs?: Iterable<string>;
  /** Check `input.*` even when no inputs are declared (templates must declare what they read). */
  strictInputs?: boolean;
}

/**
 * Everything wrong with a job's steps that can be told without the company's data, as plain messages
 * (`workflow step "<id>": …`). Empty when the steps are sound.
 */
export function checkWorkflow(workflow: readonly WorkflowStep[], options: WorkflowCheckOptions = {}): string[] {
  const problems: string[] = [];
  const ids = [...walkSteps(workflow)].map((v) => v.step.id);
  for (const id of duplicates(ids)) problems.push(`workflow: duplicate step id "${id}"`);
  const allSteps = new Set(ids);
  const inputs = new Set(options.inputs ?? []);
  const strictInputs = options.strictInputs ?? false;
  const earlier = new Set<string>();

  const visit = (steps: readonly WorkflowStep[], extraRoots: ReadonlySet<string>) => {
    for (const step of steps) {
      const where = `workflow step "${step.id}"`;
      const scope: ExpressionScope = { earlierSteps: earlier, allSteps, inputs, strictInputs, extraRoots };
      for (const p of checkStepTemplates(step, scope)) problems.push(`${where}: ${p}`);
      if (step.type === "branch") {
        step.cases.forEach((c: BranchCase, i: number) => {
          problems.push(...checkCondition(c.when, `cases[${i}].when`, scope).map((p) => `${where}: ${p}`));
          if (!c.steps.length) problems.push(`${where}: case ${c.id ?? i} has no steps`);
          visit(c.steps, extraRoots);
        });
        if (step.else) visit(step.else, extraRoots);
      } else if (step.type === "each") {
        const inner = new Set([...extraRoots, ...LOOP_ROOTS, ...(step.as ? [step.as] : [])]);
        visit(step.steps, inner);
        if (step.collect !== undefined) {
          problems.push(
            ...checkTemplates(step.collect, "collect", { earlierSteps: earlier, allSteps, inputs, strictInputs, extraRoots: inner }).map(
              (p) => `${where}: ${p}`,
            ),
          );
        }
      }
      earlier.add(step.id);
    }
  };
  visit(workflow, new Set());
  return problems;
}

/** The same for a whole definition: its steps against its declared inputs. */
export function checkDefinitionWorkflow(definition: Pick<AgentDefinition, "workflow" | "inputs">): string[] {
  return checkWorkflow(definition.workflow, { inputs: definition.inputs.map((f) => f.key) });
}
