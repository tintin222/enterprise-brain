import type { WorkflowStep } from "@enterprise-brain/core";

/**
 * Capability (tool) names understood by the runtime. They are used in
 * `tools`, `capabilities`, `agent` step tools and guardrail policies. Connector
 * capabilities are written `connector:<ref>` (every operation of a bound
 * connector) or `connector:<ref>.<operation>`.
 */
export const BUILTIN_CAPABILITIES = [
  "knowledge.search",
  "documents.read",
  "excel.read",
  "excel.write",
  "mail.draft",
  "mail.send",
  "web.search",
] as const;
export type BuiltinCapability = (typeof BUILTIN_CAPABILITIES)[number];

const BUILTIN = new Set<string>(BUILTIN_CAPABILITIES);

export function isBuiltinCapability(name: string): name is BuiltinCapability {
  return BUILTIN.has(name);
}

/** Parse "connector:ats" / "connector:ats.create_candidate" (same grammar as the runtime). */
export function parseConnectorCapability(name: string): { ref: string; operation?: string } | undefined {
  const match = name.match(/^connector:([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_.]+))?$/);
  if (!match) return undefined;
  return match[2] ? { ref: match[1]!, operation: match[2] } : { ref: match[1]! };
}

/** Guardrail policy tokens besides plain capability names. */
export const GUARDRAIL_CONNECTOR_POLICIES = ["connector:write", "connector:*"] as const;

/** Capabilities a workflow step needs at run time (LLM, approval and output steps need none). */
export function stepCapabilities(step: WorkflowStep): string[] {
  switch (step.type) {
    case "extract":
      return ["documents.read"];
    case "knowledge.search":
      return ["knowledge.search"];
    case "excel.read":
      return ["excel.read"];
    case "excel.write":
      return ["excel.write"];
    case "mail.send":
      return ["mail.send"];
    case "connector":
      return [`connector:${step.connector}.${step.operation}`];
    case "agent":
      return [...step.tools];
    default:
      return [];
  }
}

/** Does a declared capability list cover `needed` (e.g. "connector:ats" covers "connector:ats.create_candidate")? */
export function capabilityCovered(declared: readonly string[], needed: string): boolean {
  if (declared.includes(needed)) return true;
  const parsed = parseConnectorCapability(needed);
  return Boolean(parsed?.operation && declared.includes(`connector:${parsed.ref}`));
}
