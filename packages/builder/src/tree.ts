import {
  RequirementNodeInput,
  RequirementSection,
  nowIso,
  type Condition,
  type NodeState,
  type RequirementNode,
  type RequirementTree,
  type StakeholderRole,
} from "@enterprise-brain/core";

/**
 * Pure operations on the requirement design tree. No I/O, no LLM: the
 * frontier is computed from prerequisites and conditions, so the interview
 * order is deterministic and testable.
 */

const SECTION_ORDER = RequirementSection.options;

export function createNode(input: RequirementNodeInput, source: RequirementNode["source"]): RequirementNode {
  return { ...RequirementNodeInput.parse(input), source };
}

export function createTree(nodes: RequirementNode[]): RequirementTree {
  const tree: RequirementTree = { nodes: [], states: {} };
  addNodes(tree, nodes);
  return tree;
}

/** Add nodes (skipping ids that already exist). Returns the ids actually added. */
export function addNodes(tree: RequirementTree, nodes: RequirementNode[]): string[] {
  const added: string[] = [];
  for (const node of nodes) {
    if (tree.nodes.some((n) => n.id === node.id)) continue;
    tree.nodes.push(node);
    tree.states[node.id] = { status: "open" };
    added.push(node.id);
  }
  return added;
}

/** Nodes grouped by section (in the interview's section order), keeping their order within a section. */
export function nodesInSectionOrder(tree: RequirementTree): RequirementNode[] {
  return tree.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.node.section) - SECTION_ORDER.indexOf(b.node.section) || a.index - b.index)
    .map((entry) => entry.node);
}

/** The node that answers `id`: itself, or the template question that replaces it (node.replaces). */
export function resolveId(tree: RequirementTree, id: string): string {
  if (tree.nodes.some((n) => n.id === id)) return id;
  return tree.nodes.find((n) => n.replaces?.includes(id))?.id ?? id;
}

export function getNode(tree: RequirementTree, id: string): RequirementNode | undefined {
  const target = resolveId(tree, id);
  return tree.nodes.find((n) => n.id === target);
}

export function stateOf(tree: RequirementTree, id: string): NodeState {
  return tree.states[resolveId(tree, id)] ?? { status: "open" };
}

export function valueOf(tree: RequirementTree, id: string): unknown {
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

export function evalCondition(tree: RequirementTree, condition: Condition | undefined): boolean {
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
  }
}

/** A node applies when its condition holds (nodes whose condition references unsettled nodes wait). */
export function isApplicable(tree: RequirementTree, node: RequirementNode): boolean {
  return evalCondition(tree, node.when);
}

export function isSettled(state: NodeState): boolean {
  return state.status === "answered" || state.status === "assumed" || state.status === "skipped";
}

function conditionNodes(condition: Condition | undefined, out: string[] = []): string[] {
  if (!condition) return out;
  if ("all" in condition) condition.all.forEach((c) => conditionNodes(c, out));
  else if ("any" in condition) condition.any.forEach((c) => conditionNodes(c, out));
  else if ("not" in condition) conditionNodes(condition.not, out);
  else out.push(condition.node);
  return out;
}

/** Everything a node depends on: explicit prerequisites plus the nodes its condition reads. */
export function dependenciesOf(node: RequirementNode): string[] {
  return [...new Set([...node.prerequisites, ...conditionNodes(node.when)])];
}

function dependencySettled(tree: RequirementTree, id: string, path: ReadonlySet<string> = new Set()): boolean {
  // Guard against cycles introduced by dynamic (LLM-proposed) nodes.
  if (path.has(id)) return true;
  const dep = getNode(tree, id);
  if (!dep) return true;
  if (isSettled(stateOf(tree, id))) return true;
  // A dependency that cannot apply (its own dependencies are settled and its condition is false) blocks nobody.
  const next = new Set(path).add(id);
  return dependenciesOf(dep).every((d) => dependencySettled(tree, d, next)) && !isApplicable(tree, dep);
}

export function isOpen(tree: RequirementTree, node: RequirementNode): boolean {
  const status = stateOf(tree, node.id).status;
  return status === "open" || status === "asked";
}

/**
 * The frontier: open, applicable nodes whose dependencies are all settled —
 * exactly the questions that can be asked now without guessing at answers
 * not yet heard. Sorted by section, then priority (lower first).
 */
export function frontier(tree: RequirementTree): RequirementNode[] {
  return tree.nodes
    .filter((node) => isOpen(tree, node))
    .filter((node) => dependenciesOf(node).every((dep) => dependencySettled(tree, dep)))
    .filter((node) => isApplicable(tree, node))
    .sort(
      (a, b) =>
        SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.priority - b.priority || a.id.localeCompare(b.id),
    );
}

/** Open nodes that only wait on answers delegated to stakeholders. */
export function waitingOnStakeholders(tree: RequirementTree): RequirementNode[] {
  return tree.nodes.filter((node) => {
    if (!isOpen(tree, node)) return false;
    return dependenciesOf(node).some((dep) => stateOf(tree, dep).status === "delegated");
  });
}

export function delegatedNodes(tree: RequirementTree): RequirementNode[] {
  return tree.nodes.filter((n) => stateOf(tree, n.id).status === "delegated");
}

export function applicableNodes(tree: RequirementTree): RequirementNode[] {
  return tree.nodes.filter((n) => dependenciesOf(n).every((d) => dependencySettled(tree, d)) ? isApplicable(tree, n) : true);
}

export interface TreeProgress {
  total: number;
  settled: number;
  delegated: number;
  open: number;
  percent: number;
  bySection: Record<string, { total: number; settled: number }>;
}

export function progress(tree: RequirementTree): TreeProgress {
  const nodes = applicableNodes(tree);
  const bySection: TreeProgress["bySection"] = {};
  let settled = 0;
  let delegated = 0;
  for (const node of nodes) {
    const state = stateOf(tree, node.id);
    const entry = (bySection[node.section] ??= { total: 0, settled: 0 });
    entry.total++;
    if (isSettled(state)) {
      settled++;
      entry.settled++;
    } else if (state.status === "delegated") delegated++;
  }
  const total = nodes.length;
  return { total, settled, delegated, open: total - settled - delegated, percent: total ? Math.round((settled / total) * 100) : 0, bySection };
}

type Patch = Partial<Omit<NodeState, "status" | "updatedAt">>;

function setState(tree: RequirementTree, id: string, status: NodeState["status"], patch: Patch = {}) {
  const node = getNode(tree, id);
  if (!node) throw new Error(`Unknown requirement node "${id}"`);
  tree.states[node.id] = { ...stateOf(tree, node.id), ...patch, status, updatedAt: nowIso() };
}

export function answer(tree: RequirementTree, id: string, value: unknown, patch: Patch = {}) {
  setState(tree, id, "answered", { answeredBy: "requester", ...patch, value, delegationId: undefined });
}

export function assume(tree: RequirementTree, id: string, value: unknown, patch: Patch = {}) {
  setState(tree, id, "assumed", { answeredBy: "system", ...patch, value });
}

export function markAsked(tree: RequirementTree, id: string, round: number) {
  const state = stateOf(tree, id);
  if (state.status === "open") setState(tree, id, "asked", { round });
}

export function delegate(tree: RequirementTree, id: string, delegationId: string) {
  setState(tree, id, "delegated", { delegationId });
}

export function skip(tree: RequirementTree, id: string, reason?: string) {
  setState(tree, id, "skipped", { answerText: reason, value: undefined });
}

export function reopen(tree: RequirementTree, id: string) {
  setState(tree, id, "open", { value: undefined, answerText: undefined, answeredBy: undefined, evidence: undefined, delegationId: undefined });
}

/** Stakeholder role that should answer a node the requester can't. */
export function defaultDelegate(node: RequirementNode): StakeholderRole {
  return node.owner !== "requester" ? node.owner : node.section === "integrations" ? "it" : node.section === "governance" ? "dpo" : "process-owner";
}

export function isDelegable(node: RequirementNode): boolean {
  return node.delegable ?? node.owner !== "requester";
}

/** True when nothing is left to ask the requester (delegated items may still be pending). */
export function interviewComplete(tree: RequirementTree): boolean {
  return frontier(tree).length === 0 && waitingOnStakeholders(tree).length === 0 && delegatedNodes(tree).length === 0;
}
