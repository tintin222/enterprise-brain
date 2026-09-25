import { z } from "zod";
import { AgentDefinition, Archetype, TriggerSpec } from "./agent.ts";
import { RequirementNodeInput } from "./builder.ts";

/** Categories of enterprise systems an integration can target. */
export const SystemCategory = z.enum([
  "erp",
  "crm",
  "hris",
  "ats",
  "mail",
  "calendar",
  "dms",
  "storage",
  "itsm",
  "accounting",
  "bi",
  "ecommerce",
  "scm",
  "messaging",
  "database",
  "web",
  "esign",
  "other",
]);
export type SystemCategory = z.infer<typeof SystemCategory>;

export const Kpi = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string().optional(),
  target: z.string().optional(),
  description: z.string().optional(),
});
export type Kpi = z.infer<typeof Kpi>;

export const HumanRole = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
});
export type HumanRole = z.infer<typeof HumanRole>;

export const DepartmentTemplate = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  icon: z.string().optional(),
  summary: z.string(),
  mission: z.string(),
  kpis: z.array(Kpi).default([]),
  /** Human roles in the department: approvers, reviewers, stakeholders. */
  roles: z.array(HumanRole).default([]),
  /** Typical systems of record the department works with. */
  systems: z
    .array(
      z.object({
        category: SystemCategory,
        examples: z.array(z.string()).default([]),
        purpose: z.string().optional(),
      }),
    )
    .default([]),
  processes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Its AI employees serve the whole company (e.g. the company assistant): everyone may use them. */
  openToEveryone: z.boolean().default(false),
});
export type DepartmentTemplate = z.infer<typeof DepartmentTemplate>;

/** actor references: "agent:<agentTemplateId>", "human:<roleId>", "system:<category>" */
export const ActorRef = z.string().regex(/^(agent|human|system):[a-z0-9.-]+$/);

export const ProcessStep = z.object({
  id: z.string(),
  name: z.string(),
  actor: ActorRef,
  description: z.string().optional(),
  approval: z.boolean().optional(),
  sla: z.string().optional(),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

export const ProcessTemplate = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/, "process ids look like <department>.<process>"),
  department: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  trigger: z.object({
    type: z.enum(["mail", "form", "schedule", "event", "api", "chat", "manual"]),
    description: z.string(),
  }),
  frequency: z.string().optional(),
  steps: z.array(ProcessStep).min(1),
  agents: z.array(z.string()).default([]),
  kpis: z.array(Kpi).default([]),
  integrations: z
    .array(
      z.object({
        category: SystemCategory,
        purpose: z.string(),
        required: z.boolean().default(false),
      }),
    )
    .default([]),
  useCases: z.array(z.string()).default([]),
  value: z
    .object({
      hoursSavedPerMonth: z.number().optional(),
      description: z.string().optional(),
    })
    .optional(),
  maturity: z.enum(["ready", "beta", "concept"]).default("ready"),
});
export type ProcessTemplate = z.infer<typeof ProcessTemplate>;

/**
 * An agent template is an AgentDefinition plus catalog metadata and hints for
 * the Agent Builder. Authored as Markdown with YAML frontmatter; the Markdown
 * body becomes `instructions`.
 */
export const AgentTemplate = AgentDefinition.extend({
  id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/, "agent template ids look like <department>.<agent>"),
  department: z.string(),
  capabilities: z.array(z.string()).default([]),
  reportsTo: z.string().optional(),
  builder: z
    .object({
      /** Extra requirement-tree nodes asked when the Agent Builder matches this template. */
      questions: z.array(RequirementNodeInput).default([]),
      /** Phrases that make the builder match this template to a user's description. */
      matchPhrases: z.array(z.string()).default([]),
    })
    .default({ questions: [], matchPhrases: [] }),
  tags: z.array(z.string()).default([]),
});
export type AgentTemplate = z.infer<typeof AgentTemplate>;

export const UseCase = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  archetype: Archetype,
  summary: z.string(),
  description: z.string(),
  capabilities: z.array(z.string()).default([]),
  connectors: z.array(SystemCategory).default([]),
  /** Default agent template powering this use case. */
  defaultAgent: z.string().optional(),
  /** Console route of the ready-made app for the use case. */
  app: z.string().optional(),
  examples: z.array(z.string()).default([]),
  triggers: z.array(TriggerSpec).default([]),
});
export type UseCase = z.infer<typeof UseCase>;

export interface Catalog {
  departments: DepartmentTemplate[];
  processes: ProcessTemplate[];
  agents: AgentTemplate[];
  useCases: UseCase[];
}
