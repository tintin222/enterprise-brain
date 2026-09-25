import type { AgentDefinition } from "@enterprise-brain/core";
import type { LlmUsage } from "@enterprise-brain/llm";
import type { Employment } from "./policy.ts";

export type RunStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

/** An action that a human approves before it runs (connector writes, outgoing mail). */
export type ApprovalAction =
  | { type: "decision" }
  | {
      type: "connector";
      ref: string;
      category: string;
      instanceId?: string;
      operation: string;
      operationName?: string;
      system?: string;
      input: Record<string, unknown>;
    }
  | {
      type: "mail.send";
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string;
      mailbox?: string;
    };

export interface RunContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  agent: { id: string; name: string; slug: string; department?: string };
  trigger: { type: string; ref?: string | null };
  /** `date` is the run's start date (YYYY-MM-DD, server time zone), so "today" stays stable across resumes. */
  run: { id: string; isTest: boolean; startedAt: string; date: string };
}

/** Persisted in runs.context between executions (resume after approvals). */
export interface PersistedRunState {
  steps: Record<string, unknown>;
  completed: string[];
  pending?: { stepId: string; approvalId: string; kind: "decision" | "gated" };
  warnings?: string[];
  /** Free-form task (e.g. a Paperclip issue): run one autonomous step instead of the workflow. */
  task?: string;
}

export interface RunEventInput {
  type: string;
  stepId?: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunEventRecord extends RunEventInput {
  runId: string;
  seq: number;
  createdAt: string;
}

export type StepOutcome =
  | { kind: "done"; result: unknown; usage?: LlmUsage; message?: string }
  | { kind: "pause"; title: string; details: string; assigneeRole?: string; action: ApprovalAction; reason?: string };

export interface ExecutionScope {
  companyId: string;
  runId: string;
  agentId: string;
  definition: AgentDefinition;
  /** Its level and limits, read when the run (re)starts: the manager's latest decision applies. */
  employment: Employment;
  context: RunContext;
  emit: (event: RunEventInput) => Promise<void>;
  onText?: (delta: string) => void;
}
