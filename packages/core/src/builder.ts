import { z } from "zod";

/**
 * The Agent Builder interviews a (non-technical) requester the way an
 * experienced business analyst would, using the "grilling" technique:
 *
 * - The requirements form a DESIGN TREE of nodes. Each node is a decision (the
 *   requester's to make) or a fact (the system's job to find out, e.g. by
 *   analysing uploaded samples or checking configured connectors).
 * - The FRONTIER is every open node whose prerequisites are settled. Each ROUND
 *   asks the frontier (bounded for non-technical users), each question with a
 *   recommended answer.
 * - Answers settle nodes, push the frontier outwards and may add new nodes.
 * - A node the requester can't answer is DELEGATED to a stakeholder (IT, legal,
 *   data protection...) through a generated questionnaire/email; downstream
 *   nodes wait for it.
 * - When the frontier is empty, the builder presents the shared understanding
 *   and waits for explicit CONFIRMATION before generating anything.
 */

export const RequirementSection = z.enum([
  "purpose",
  "users",
  "inputs",
  "processing",
  "outputs",
  "actions",
  "integrations",
  "governance",
  "ui",
  "operations",
]);
export type RequirementSection = z.infer<typeof RequirementSection>;

export const SECTION_LABELS: Record<RequirementSection, string> = {
  purpose: "Purpose & scope",
  users: "Users & stakeholders",
  inputs: "Inputs & data sources",
  processing: "Rules & decision logic",
  outputs: "Outputs",
  actions: "Actions & follow-ups",
  integrations: "System integrations",
  governance: "Governance, privacy & approvals",
  ui: "User interface",
  operations: "Volume, SLAs & success",
};

export const StakeholderRole = z.enum([
  "requester",
  "it",
  "security",
  "legal",
  "dpo",
  "finance",
  "process-owner",
  "data-owner",
  "management",
]);
export type StakeholderRole = z.infer<typeof StakeholderRole>;

export const STAKEHOLDER_LABELS: Record<StakeholderRole, string> = {
  requester: "Requester",
  it: "IT / Integration team",
  security: "Information security",
  legal: "Legal",
  dpo: "Data protection officer",
  finance: "Finance",
  "process-owner": "Process owner",
  "data-owner": "Data owner",
  management: "Management",
};

export const AnswerType = z.enum([
  "single",
  "multi",
  "text",
  "number",
  "boolean",
  "files",
  "fields",
  "criteria",
  "categories",
]);
export type AnswerType = z.infer<typeof AnswerType>;

export type Condition =
  | { node: string; op: "answered" | "truthy" | "falsy" }
  | { node: string; op: "eq" | "neq" | "includes" | "excludes"; value: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const ConditionSchema: z.ZodType<Condition, Condition> = z.lazy(() =>
  z.union([
    z.object({ node: z.string(), op: z.enum(["answered", "truthy", "falsy"]) }),
    z.object({ node: z.string(), op: z.enum(["eq", "neq", "includes", "excludes"]), value: z.unknown() }),
    z.object({ all: z.array(ConditionSchema) }),
    z.object({ any: z.array(ConditionSchema) }),
    z.object({ not: ConditionSchema }),
  ]),
);

export const RequirementOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type RequirementOption = z.infer<typeof RequirementOption>;

export const RequirementNodeInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  section: RequirementSection,
  title: z.string(),
  question: z.string(),
  why: z.string().optional(),
  kind: z.enum(["decision", "fact"]).default("decision"),
  answerType: AnswerType.default("text"),
  options: z.array(RequirementOption).optional(),
  /** Choice questions: also accept an answer that matches none of the options (kept in the user's words). */
  allowOther: z.boolean().optional(),
  /**
   * Template questions: generic checklist questions this one supersedes (e.g. docs.criteria). They are not
   * asked, and wherever the builder reads them it gets this question's answer instead.
   */
  replaces: z.array(z.string()).optional(),
  recommended: z.unknown().optional(),
  recommendationReason: z.string().optional(),
  prerequisites: z.array(z.string()).default([]),
  when: ConditionSchema.optional(),
  /** Who can typically answer this. Non-requester owners make the node delegable by default. */
  owner: StakeholderRole.default("requester"),
  delegable: z.boolean().optional(),
  /** Where the answer lands in the generated agent, for traceability (documentation only). */
  specPath: z.string().optional(),
  priority: z.number().int().default(50),
});
export type RequirementNodeInput = z.input<typeof RequirementNodeInput>;
export type RequirementNode = z.infer<typeof RequirementNodeInput> & {
  source: "base" | "archetype" | "template" | "dynamic";
};

export const NodeStatus = z.enum(["open", "asked", "answered", "assumed", "delegated", "skipped"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export interface NodeState {
  status: NodeStatus;
  value?: unknown;
  /** The raw words the answer came from, kept for the audit trail. */
  answerText?: string;
  answeredBy?: "requester" | "stakeholder" | "system" | "default";
  /** For facts: what evidence settled it (e.g. "analysed 4 sample CVs"). */
  evidence?: string;
  round?: number;
  delegationId?: string;
  updatedAt?: string;
}

export interface RequirementTree {
  nodes: RequirementNode[];
  states: Record<string, NodeState>;
}

export interface RoundQuestion {
  number: number;
  nodeId: string;
  title: string;
  question: string;
  why?: string;
  answerType: AnswerType;
  options?: RequirementOption[];
  recommended?: unknown;
  recommendationText?: string;
  owner: StakeholderRole;
  delegable: boolean;
}

export interface BuilderRound {
  number: number;
  questions: RoundQuestion[];
  intro?: string;
  askedAt: string;
  answeredAt?: string;
}

export const BuilderStatus = z.enum([
  "interviewing",
  "awaiting-stakeholders",
  "confirming",
  "generating",
  "testing",
  "deployed",
  "archived",
]);
export type BuilderStatus = z.infer<typeof BuilderStatus>;

export interface StakeholderQuestion {
  nodeId: string;
  question: string;
  why?: string;
  answer?: string;
}

export interface StakeholderRequestData {
  role: StakeholderRole;
  recipientName?: string;
  recipientEmail?: string;
  subject: string;
  /** Email body (plain text) the requester can send as-is. */
  body: string;
  /** Questionnaire (markdown) — same questions, structured for async answers. */
  questionnaire: string;
  questions: StakeholderQuestion[];
}

export interface SampleAnalysis {
  fileId: string;
  fileName: string;
  mimeType: string;
  pages?: number;
  language?: string;
  needsOcr?: boolean;
  documentType?: string;
  detectedFields?: string[];
  summary?: string;
}

/** Chat transcript entry of a builder session. */
export interface BuilderMessage {
  id: string;
  role: "user" | "analyst" | "system";
  content: string;
  round?: number;
  attachments?: { fileId: string; name: string }[];
  createdAt: string;
}
