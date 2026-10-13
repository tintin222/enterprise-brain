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
    }
  | {
      type: "chat.send";
      /** A channel ("#finance"), a person's email, or "task" (the task's conversation). */
      to: string;
      via?: "chat" | "teams" | "google-chat";
      text: string;
      /** The AI employee it writes as. */
      agentId: string;
      taskId?: string;
      runId?: string;
    };

export interface RunContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  agent: { id: string; name: string; slug: string; department?: string };
  trigger: { type: string; ref?: string | null };
  /**
   * `date` is the run's start date (YYYY-MM-DD, server time zone), so "today" stays stable across resumes;
   * `callbackUrl` the address another system calls to wake a `wait` for a callback (jobs that have one).
   */
  run: { id: string; isTest: boolean; startedAt: string; date: string; callbackUrl?: string };
  /** The company's variables (Settings → Installation), read when the run (re)starts. */
  vars: Record<string, string | number | boolean>;
  /** Inside a loop: the current item (or batch) and its position from 0; a loop's own name for it too. */
  item?: unknown;
  index?: number;
  [alias: string]: unknown;
}

/** Where a branch or loop stands while the run is inside it (kept so a pause inside resumes in the right place). */
export interface FrameState {
  /** A branch: the case it took (its id or position), "else", or null when none held. */
  case?: string | number | null;
  /** A loop: its items (or batches), the next round, the rounds' results, how many failed and how many were left out. */
  items?: unknown[];
  index?: number;
  /** The round whose steps were last cleared for a fresh start. */
  round?: number;
  results?: unknown[];
  failed?: number;
  leftOut?: number;
}

/** Persisted in runs.context between executions (resume after approvals). */
export interface PersistedRunState {
  steps: Record<string, unknown>;
  /** Keys of the steps done: their id at the top, "loop#2/step" inside a loop's third round. */
  completed: string[];
  pending?: { stepId: string; stepKey?: string; approvalId?: string; kind: "decision" | "gated" | "wait"; for?: WaitFor };
  /** Branches and loops the run is inside, by key. */
  frames?: Record<string, FrameState>;
  /** The output step that ran last: its result is the run's output. */
  outputStepId?: string;
  /** Attempts used per step key while retrying (cleared when the step ends). */
  attempts?: Record<string, number>;
  /** The answer a waiting caller gets (the last `respond` step's). */
  response?: RunResponse;
  /** How deep in calls between AI employees the run is: 1 when another AI employee's step gave it the work. */
  callDepth?: number;
  /** The last call from another system the run took (its event's number): later ones are new. */
  callbackSeq?: number;
  /** A waiting step was woken: it ends with this result (or fails with this error) where the run picks up. */
  woken?: { key: string; result?: unknown; error?: string };
  warnings?: string[];
  /** Free-form task (e.g. a Paperclip issue): run one autonomous step instead of the workflow. */
  task?: string;
  /** Test runs only: a version of the job that isn't live (a coaching proposal replayed on a past task). */
  override?: Record<string, unknown>;
  /** Replays: what the steps that waited on people found in the original task (its replies), by step id. */
  recorded?: Record<string, unknown>;
  /** A turn in a conversation (no task): the AI employee answers what was said. */
  conversation?: ConversationScope;
}

/** The conversation a run answers in. */
export interface ConversationScope {
  id: string;
  /** The newest message the turn read. */
  upToSeq: number;
  /** Who is in the conversation, so the AI employee can ask one of them. */
  participants?: { kind: string; id: string; name: string }[];
  /** AI employees it may hand the matter to (only on a turn answering a person, and only ones that person sees). */
  colleagues?: { id: string; slug: string; name: string; title: string; summary: string }[];
}

/** What a `wait` step waits for: a reply, a time, a call from another system, or a colleague's answer. */
export type WaitFor = "reply" | "time" | "callback" | "colleague";

/** The answer a system that started the work and waits gets. */
export interface RunResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Where a chat.send step writes, and how. */
export interface ChatPostRequest {
  companyId: string;
  agentId: string;
  to: string;
  via?: "chat" | "teams" | "google-chat";
  text: string;
  taskId?: string;
  runId?: string;
}

export interface ChatPostResult {
  /** Where it went, in words ("#finance", "Selin Acar in Microsoft Teams"). */
  where: string;
  via: "chat" | "teams" | "google-chat";
  conversationId?: string;
  seq?: number;
}

/**
 * Writes as an AI employee: in a channel, a person's direct message with it, the task's conversation, or
 * a person's chat with the app in Teams or Google Chat. `check` finds the place without writing (test runs).
 */
export interface ChatPoster {
  post(request: ChatPostRequest, options?: { check?: boolean }): Promise<ChatPostResult>;
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
  /** A workflow `wait` step (or a call to a colleague): the task waits, then this step completes with what happened. */
  | { kind: "wait"; title: string; for: WaitFor; until?: Date; days?: number; taskId?: string };

export interface ExecutionScope {
  companyId: string;
  runId: string;
  agentId: string;
  /** Where the step being run is in the job (its id at the top, "loop#2/step" inside a loop's third round). */
  stepKey?: string;
  /** Aborted when the step runs out of time: a step that can stop early (the agent's tool loop) does. */
  signal?: AbortSignal;
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
  /** The conversation the run answers in (a turn, not a task). */
  conversation?: ConversationScope;
}
