import { displayValue } from "../../lib/format.ts";
import type { NodeState, RequirementNode, RequirementOption, RequirementTree, RoundQuestion } from "../../types.ts";

type Condition =
  | { node: string; op: "answered" | "truthy" | "falsy" }
  | { node: string; op: "eq" | "neq" | "includes" | "excludes"; value: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export function stateOf(tree: RequirementTree, id: string): NodeState {
  return tree.states[id] ?? { status: "open" };
}

export function isSettled(state: NodeState): boolean {
  return state.status === "answered" || state.status === "assumed" || state.status === "skipped";
}

function valueOf(tree: RequirementTree, id: string): unknown {
  const state = stateOf(tree, id);
  return state.status === "answered" || state.status === "assumed" ? state.value : undefined;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function includesValue(container: unknown, value: unknown): boolean {
  if (Array.isArray(container)) return container.some((c) => String(c).toLowerCase() === String(value).toLowerCase());
  if (typeof container === "string") return container.toLowerCase().includes(String(value).toLowerCase());
  return false;
}

/** Client-side port of the builder's condition evaluation (used to hide requirements that don't apply). */
function evalCondition(tree: RequirementTree, condition: Condition | undefined): boolean {
  if (!condition) return true;
  if ("all" in condition) return condition.all.every((c) => evalCondition(tree, c));
  if ("any" in condition) return condition.any.some((c) => evalCondition(tree, c));
  if ("not" in condition) return !evalCondition(tree, condition.not);
  const value = valueOf(tree, condition.node);
  switch (condition.op) {
    case "answered":
      return isSettled(stateOf(tree, condition.node));
    case "truthy":
      return hasValue(value) && value !== false && value !== "no";
    case "falsy":
      return !hasValue(value) || value === false || value === "no";
    case "eq":
      return String(value ?? "").toLowerCase() === String(condition.value).toLowerCase();
    case "neq":
      return String(value ?? "").toLowerCase() !== String(condition.value).toLowerCase();
    case "includes":
      return includesValue(value, condition.value);
    case "excludes":
      return !includesValue(value, condition.value);
    default:
      return true;
  }
}

function conditionNodes(condition: Condition | undefined, out: string[] = []): string[] {
  if (!condition) return out;
  if ("all" in condition) condition.all.forEach((c) => conditionNodes(c, out));
  else if ("any" in condition) condition.any.forEach((c) => conditionNodes(c, out));
  else if ("not" in condition) conditionNodes(condition.not, out);
  else out.push(condition.node);
  return out;
}

/**
 * Whether a requirement is (still) relevant: its condition holds, or it
 * depends on answers not given yet. Settled nodes always show.
 */
export function isRelevant(tree: RequirementTree, node: RequirementNode): boolean {
  const state = stateOf(tree, node.id);
  if (state.status !== "open") return true;
  const condition = node.when as Condition | undefined;
  if (!condition) return true;
  const deps = conditionNodes(condition);
  const depsSettled = deps.every((d) => isSettled(stateOf(tree, d)) || !tree.nodes.some((n) => n.id === d));
  return depsSettled ? evalCondition(tree, condition) : true;
}

export function optionLabel(options: RequirementOption[] | undefined, value: unknown): string {
  return options?.find((o) => o.value === value)?.label ?? String(value);
}

/** Human text for a requirement value (option labels, lists, booleans). */
export function formatAnswer(node: Pick<RequirementNode, "options" | "answerType">, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((v) => optionLabel(node.options, v)).join(", ") : "none";
  if (typeof value === "string") return optionLabel(node.options, value);
  return displayValue(value);
}

/** Text for the recommendation box of a question. */
export function recommendationText(question: RoundQuestion): string | undefined {
  if (question.recommendationText?.trim()) return question.recommendationText.replace(/^➡️\s*/, "");
  if (question.recommended === undefined || question.recommended === null || question.recommended === "") return undefined;
  return `Recommended: ${formatAnswer(question, question.recommended)}`;
}

export function hasRecommendation(question: RoundQuestion): boolean {
  if (question.answerType === "files") return false;
  const r = question.recommended;
  if (r === undefined || r === null || r === "") return false;
  if (Array.isArray(r) && !r.length) return false;
  return true;
}
