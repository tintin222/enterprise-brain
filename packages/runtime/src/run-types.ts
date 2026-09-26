import type { AgentDefinition } from "@enterprise-brain/core";
import type { LlmUsage } from "@enterprise-brain/llm";
import type { Employment } from "./policy.ts";

/** waiting: paused at a workflow `wait` step until a reply arrives or a date comes (its task wakes it). */
export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting" | "succeeded" | "failed" | "cancelled";

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
      /** The task it belongs to: the sent email joins the task's history, and replies find their way back. */
      taskId?: string;
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
  pending?: { stepId: string; approvalId?: string; kind: "decision" | "gated" | "wait" };
  warnings?: string[];
  /** Free-form task (e.g. a Paperclip issue): run one autonomous step instead of the workflow. */
  task?: string;
  /** Test runs only: a version of the job that isn't live (a coaching proposal replayed on a past task). */
  override?: Record<string, unknown>;
  /** Replays: what the steps that waited on people found in the original task (its replies), by step id. */
  recorded?: Record<string, unknown>;
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
  | { kind: "pause"; title: string; details: string; assigneeRole?: string; action: ApprovalAction; reason?: string }
  /** A workflow `wait` step: the task waits for a reply or a date, then this step completes with what happened. */
  | { kind: "wait"; title: string; for: "reply" | "time"; until?: Date; days?: number };

export interface ExecutionScope {
  companyId: string;
  runId: string;
  agentId: string;
  definition: AgentDefinition;
  /** Its level and limits, read when the run (re)starts: the manager's latest decision applies. */
  employment: Employment;
  /** The task the run works on (none in test runs). */
  task?: { id: string; ref: string };
  context: RunContext;
  emit: (event: RunEventInput) => Promise<void>;
  onText?: (delta: string) => void;
  /** Replays: what the original task's waits found, by step id. */
  recorded?: Record<string, unknown>;
}
