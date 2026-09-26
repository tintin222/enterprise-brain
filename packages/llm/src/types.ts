import type Anthropic from "@anthropic-ai/sdk";
import type { JsonSchema } from "@enterprise-brain/core";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export function emptyUsage(): LlmUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

export interface LlmRequest {
  /** What the call is for, e.g. "builder.plan-round" or "runtime.extract". Used for logs, cost attribution and test scripting. */
  purpose: string;
  system?: string;
  messages: MessageParam[];
  model?: string;
  maxTokens?: number;
  effort?: Effort;
}

export interface CompleteRequest extends LlmRequest {
  /** Receives streamed text deltas. */
  onText?: (delta: string) => void;
}

export interface StructuredRequest extends LlmRequest {
  /** JSON Schema the response must follow (structured outputs). */
  schema: JsonSchema;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolExecution {
  content: string;
  isError?: boolean;
}

export type ToolLoopEvent =
  | { type: "assistant"; turn: number; text: string; toolCalls: ToolCall[] }
  | { type: "tool_result"; turn: number; call: ToolCall; result: ToolExecution; durationMs: number };

export interface ToolLoopRequest extends LlmRequest {
  tools: ToolDefinition[];
  /** Anthropic server tools passed through as-is, e.g. { type: "web_search_20260209", name: "web_search" }. */
  serverTools?: Record<string, unknown>[];
  executeTool: (call: ToolCall) => Promise<ToolExecution>;
  maxTurns?: number;
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>;
  onText?: (delta: string) => void;
}

/** Claude's client toolsets for working screens: "browser" (web pages) and "computer" (a whole display). */
export type ToolsetName = "browser" | "computer";

/** A call to one of a toolset's members (screenshot, left_click, read_page…), run by the caller in order. */
export interface ToolsetCall {
  id: string;
  toolset: ToolsetName;
  name: string;
  input: Record<string, unknown>;
}

/** The browser's tabs after a call, and the tabs it opened (browser toolset only). */
export interface BrowserState {
  tabs: { tab_id: string; title: string; url: string; active?: boolean }[];
  state_changes?: { type: "tab_opened"; tab_id: string }[];
}

/** What a member call returns: text, an image, the browser's tabs; errors carry text only. */
export interface ToolsetResult {
  text?: string;
  image?: { data: string; mediaType: "image/png" | "image/jpeg" };
  browserState?: BrowserState;
  isError?: boolean;
}

export type OperateEvent =
  | { type: "assistant"; turn: number; text: string; calls: ToolsetCall[]; toolCalls: ToolCall[] }
  | { type: "action"; turn: number; call: ToolsetCall; result: ToolsetResult; durationMs: number };

export interface OperateRequest extends LlmRequest {
  toolset: ToolsetName;
  /** Members switched on or off (e.g. { zoom: { enabled: false } }). */
  configs?: Record<string, { enabled?: boolean }>;
  /** Run one member call. Throwing counts as a failed call. */
  execute: (call: ToolsetCall) => Promise<ToolsetResult>;
  /** The caller's own tools besides the toolset (e.g. one that ends the job with its outcome). */
  tools?: ToolDefinition[];
  /** Run one of those tools; `stop` ends the loop with that call as the outcome. */
  executeTool?: (call: ToolCall) => Promise<ToolExecution & { stop?: boolean }>;
  maxTurns?: number;
  onEvent?: (event: OperateEvent) => void | Promise<void>;
}

export interface OperateResult {
  /** "tool": one of the caller's tools ended it (stoppedBy); "end_turn": Claude answered in text; "max_turns". */
  stopReason: string;
  stoppedBy?: ToolCall;
  text: string;
  turns: number;
  /** Member calls run. */
  actions: number;
  /** The conversation, to carry on from. */
  messages: MessageParam[];
  usage: LlmUsage;
  model: string;
}

export interface CompleteResult {
  text: string;
  stopReason: string;
  usage: LlmUsage;
  model: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

export interface ToolLoopResult {
  text: string;
  stopReason: string;
  turns: number;
  messages: MessageParam[];
  usage: LlmUsage;
  model: string;
}

/**
 * The LLM port used everywhere in Enterprise Brain. `available` is false when no
 * model is configured; callers then use their deterministic fallbacks and tell
 * the user they are in offline mode.
 */
export interface LlmClient {
  readonly available: boolean;
  readonly provider: string;
  readonly model: string;
  complete(request: CompleteRequest): Promise<CompleteResult>;
  structured<T>(request: StructuredRequest): Promise<StructuredResult<T>>;
  runTools(request: ToolLoopRequest): Promise<ToolLoopResult>;
  /** Work screens with one of Claude's client toolsets (browser use, computer use): the caller runs each action. */
  operate(request: OperateRequest): Promise<OperateResult>;
}

export class LlmUnavailableError extends Error {
  constructor(message = "No LLM is configured. Set ANTHROPIC_API_KEY (or EB_LLM_PROVIDER=anthropic with an `ant auth login` profile).") {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`The model declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.name = "LlmRefusalError";
  }
}

export class LlmOutputError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** Convenience: a user message with plain text. */
export function userText(text: string): MessageParam {
  return { role: "user", content: text };
}
