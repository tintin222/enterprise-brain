import Anthropic from "@anthropic-ai/sdk";
import {
  LlmOutputError,
  LlmRefusalError,
  addUsage,
  emptyUsage,
  type CompleteRequest,
  type CompleteResult,
  type Effort,
  type LlmClient,
  type LlmRequest,
  type LlmUsage,
  type MessageParam,
  type OperateRequest,
  type OperateResult,
  type StructuredRequest,
  type StructuredResult,
  type ToolCall,
  type ToolExecution,
  type ToolLoopRequest,
  type ToolLoopResult,
  type ToolResultParam,
  type ToolsetName,
  type ToolsetResult,
} from "./types.ts";
import { toStructuredOutputSchema } from "./schema.ts";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaToolResultContent = Exclude<BetaToolResultBlockParam["content"], string | undefined>[number];

const TOOLSET_TYPES: Record<ToolsetName, string> = { browser: "browser_toolset_20260801", computer: "computer_toolset_20260801" };

/** What answers the calls after a failed one in a batch: each toolset has its own exact text. */
export const HALT_TEXT: Record<ToolsetName, string> = {
  browser: "Not executed: an earlier action in this turn failed.",
  computer: "Not executed: an earlier computer action in this turn failed.",
};

/** A member call's result as the API takes it: echoing the toolset, text/image/browser_state content, none of it on errors. */
export function toolsetResultBlock(id: string, toolset: ToolsetName, result: ToolsetResult): BetaToolResultBlockParam {
  if (result.isError) return { type: "tool_result", tool_use_id: id, toolset_name: toolset, is_error: true, content: result.text || "Error" };
  const content: BetaToolResultContent[] = [];
  if (result.text) content.push({ type: "text", text: result.text });
  if (result.image) content.push({ type: "image", source: { type: "base64", media_type: result.image.mediaType, data: result.image.data } });
  if (result.browserState && toolset === "browser") {
    const { tabs, state_changes } = result.browserState;
    content.push({ type: "browser_state", tabs, ...(state_changes?.length ? { state_changes } : {}) });
  }
  if (!content.length) content.push({ type: "text", text: "OK" });
  return { type: "tool_result", tool_use_id: id, toolset_name: toolset, content };
}

/**
 * A loop stopped by a call waiting for a person: that call, and the results the turn's other calls
 * got (a second waiting call is told its answer comes with the first's).
 */
export function stoppedAt(call: ToolCall, waiting: ToolCall[], results: ToolResultParam[]): { call: ToolCall; results: ToolResultParam[] } {
  return {
    call,
    results: results
      .filter((r) => r.tool_use_id !== call.id)
      .map((r) =>
        waiting.some((w) => w.id === r.tool_use_id)
          ? { type: "tool_result", tool_use_id: r.tool_use_id, content: "Asked together with the other question of this turn: the answer is in its result." }
          : r,
      ),
  };
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Effort when neither the request nor the installation sets one (set explicitly: the API's default differs by model). */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * USD per million tokens: [input, output, cache reads as a share of input]. Cache reads bill at 0.1x input
 * unless a model says otherwise, 5-minute cache writes at 1.25x.
 */
const PRICES: Record<string, [number, number, number?]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20, 0.05],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

function priceFor(model: string): [number, number, number] {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`) || model.endsWith(k));
  const [input, output, cacheRead = 0.1] = key ? PRICES[key]! : [5, 25];
  return [input, output, cacheRead];
}

/** Models on which `thinking: {type: "adaptive"}` and `output_config.effort` are supported. */
function supportsAdaptiveThinking(model: string): boolean {
  return !/haiku/.test(model);
}

/** Server-side refusal fallbacks ("default" routing) for the model families that ship safety classifiers. */
function supportsDefaultFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5|mythos-5)/.test(model);
}

/**
 * Models whose notes between tool calls (what they found, what they do next) come back as thinking blocks,
 * empty unless the request asks for them with `display: "updates"`.
 */
function writesProgressUpdates(model: string): boolean {
  return /^claude-(opus-5-5|fable-5|mythos-5)/.test(model);
}

/** The text of a progress block that stands in for work a stopped response didn't finish. */
const INTERRUPTED = "This part of the response was interrupted before it finished.";

export interface AnthropicLlmOptions {
  model?: string;
  apiKey?: string;
  /** Re-run declined requests on Anthropic's recommended fallback model (default true, Claude API only). */
  fallbacks?: boolean;
  /** Default effort when a request does not set one. */
  defaultEffort?: Effort;
  client?: Anthropic;
}

export class AnthropicLlm implements LlmClient {
  readonly available = true;
  readonly provider = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;
  private readonly defaultEffort: Effort;

  constructor(options: AnthropicLlmOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = options.client ?? (options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic());
    this.fallbacks = options.fallbacks ?? true;
    this.defaultEffort = options.defaultEffort ?? DEFAULT_EFFORT;
  }

  private baseParams(request: LlmRequest, maxTokens: number): BetaCreateParams {
    const model = request.model ?? this.model;
    const effort = request.effort ?? this.defaultEffort;
    const params: BetaCreateParams = {
      model,
      max_tokens: request.maxTokens ?? maxTokens,
      messages: request.messages,
      // Auto-cache the stable prefix (tools + system + earlier turns) across repeated calls.
      cache_control: { type: "ephemeral" },
    };
    if (request.system) params.system = request.system;
    if (supportsAdaptiveThinking(model)) {
      params.thinking = { type: "adaptive" };
      if (effort) params.output_config = { effort };
    }
    if (this.fallbacks && supportsDefaultFallbacks(model)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }

  /** Tool loops: get the model's notes between tool calls back as text, for the run's timeline. */
  private withProgressUpdates(params: BetaCreateParams): BetaCreateParams {
    if (params.thinking && writesProgressUpdates(params.model)) {
      params.thinking = { type: "adaptive", display: "updates" };
      params.betas = [...(params.betas ?? []), "thinking-display-updates-2026-08-18"];
    }
    return params;
  }

  /** What the model said in a turn: its progress notes (non-empty thinking blocks under "updates"), then its text. */
  private saidIn(message: BetaMessage, text: string): string {
    const notes = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking.trim())
      .filter((note) => note && note !== INTERRUPTED);
    return [...notes, ...(text ? [text] : [])].join("\n");
  }

  private usageOf(message: BetaMessage): LlmUsage {
    const [inPrice, outPrice, cacheReadShare] = priceFor(message.model ?? this.model);
    const u = message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cost = (u.input_tokens * inPrice + cacheRead * inPrice * cacheReadShare + cacheWrite * inPrice * 1.25 + u.output_tokens * outPrice) / 1_000_000;
    return {
      calls: 1,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: Math.round(cost * 1e6) / 1e6,
    };
  }

  private assertNotRefused(message: BetaMessage): void {
    if (message.stop_reason === "refusal") {
      const details = message.stop_details;
      throw new LlmRefusalError(details?.category ?? null, details?.explanation ?? null);
    }
  }

  private textOf(message: BetaMessage): string {
    return message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  /** Stream every request (long outputs never hit HTTP timeouts) and collect the final message. */
  private async send(params: BetaCreateParams, onText?: (delta: string) => void): Promise<BetaMessage> {
    const stream = this.client.beta.messages.stream(params);
    if (onText) stream.on("text", (delta) => onText(delta));
    return stream.finalMessage();
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const message = await this.send(this.baseParams(request, 16000), request.onText);
    this.assertNotRefused(message);
    return { text: this.textOf(message), stopReason: message.stop_reason ?? "end_turn", usage: this.usageOf(message), model: message.model };
  }

  async structured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const params = this.baseParams(request, 16000);
    params.output_config = { ...(params.output_config ?? {}), format: { type: "json_schema", schema: toStructuredOutputSchema(request.schema) } };
    const message = await this.send(params);
    this.assertNotRefused(message);
    if (message.stop_reason === "max_tokens") {
      throw new LlmOutputError(`Structured output for "${request.purpose}" was truncated at max_tokens`);
    }
    const raw = this.textOf(message);
    try {
      return { data: JSON.parse(raw) as T, usage: this.usageOf(message), model: message.model };
    } catch {
      throw new LlmOutputError(`Structured output for "${request.purpose}" was not valid JSON`, raw);
    }
  }

  async runTools(request: ToolLoopRequest): Promise<ToolLoopResult> {
    // Tool inputs here are small (ids, queries, short payloads), so eager input
    // streaming is left off and the API validates inputs against each schema.
    const tools: BetaTool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool["input_schema"],
    }));
    const messages: MessageParam[] = [...request.messages];
    const maxTurns = request.maxTurns ?? 12;
    let usage = emptyUsage();
    let lastText = "";
    let stopReason = "end_turn";
    let model = request.model ?? this.model;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const params = this.withProgressUpdates(this.baseParams({ ...request, messages }, 32000));
      params.tools = [...tools, ...((request.serverTools ?? []) as unknown as BetaTool[])];
      const message = await this.send(params, request.onText);
      usage = addUsage(usage, this.usageOf(message));
      model = message.model;
      stopReason = message.stop_reason ?? "end_turn";
      // A refusal can cut a tool_use off mid-input: never run that turn's tools.
      this.assertNotRefused(message);

      const text = this.textOf(message);
      if (text) lastText = text;
      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const calls: ToolCall[] = toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input }));
      await request.onEvent?.({ type: "assistant", turn, text: this.saidIn(message, text), toolCalls: calls });

      // Keep the full assistant content (thinking blocks included) in the history.
      messages.push({ role: "assistant", content: message.content });

      if (stopReason === "pause_turn") continue;
      if (calls.length === 0) {
        return { text: lastText, stopReason, turns: turn, messages, usage, model };
      }
      if (stopReason === "max_tokens") {
        throw new LlmOutputError("A tool call was truncated at max_tokens; increase maxTokens for this agent");
      }

      // Parallel tool calls: run concurrently, return all results in ONE user message.
      const waiting: ToolCall[] = [];
      const results = await Promise.all(
        calls.map(async (call): Promise<BetaToolResultBlockParam> => {
          const started = Date.now();
          let result: ToolExecution;
          try {
            result = await request.executeTool(call);
          } catch (error) {
            result = { content: error instanceof Error ? error.message : String(error), isError: true };
          }
          if (result.stop && !result.isError) waiting.push(call);
          await request.onEvent?.({ type: "tool_result", turn, call, result, durationMs: Date.now() - started });
          return { type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError ?? false };
        }),
      );
      const stopper = calls.find((c) => waiting.includes(c));
      if (stopper) return { text: lastText, stopReason: "tool", turns: turn, messages, usage, model, stopped: stoppedAt(stopper, waiting, results) };
      messages.push({ role: "user", content: results });
    }
    return { text: lastText, stopReason: "max_turns", turns: maxTurns, messages, usage, model };
  }

  /**
   * Work screens with a client toolset: Claude returns member calls (often several in a turn, a batch),
   * which run in order; after a failure the rest of the batch is answered with the halt text. Every
   * result echoes the toolset's name. Screenshots stay in the history: on current models removing one
   * invalidates the later thinking, and each job is bounded by maxTurns.
   */
  async operate(request: OperateRequest): Promise<OperateResult> {
    const toolset = { type: TOOLSET_TYPES[request.toolset], ...(request.configs ? { configs: request.configs } : {}) } as unknown as BetaToolUnion;
    const tools: BetaTool[] = (request.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool["input_schema"] }));
    const messages: MessageParam[] = [...request.messages];
    const maxTurns = request.maxTurns ?? 40;
    let usage = emptyUsage();
    let text = "";
    let actions = 0;
    let model = request.model ?? this.model;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const params = this.withProgressUpdates(this.baseParams({ ...request, messages }, 16000));
      params.tools = [toolset, ...tools];
      const message = await this.send(params);
      usage = addUsage(usage, this.usageOf(message));
      model = message.model;
      this.assertNotRefused(message);
      const said = this.textOf(message);
      if (said) text = said;
      const uses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const members = (use: BetaToolUseBlock) => use.toolset_name === request.toolset;
      await request.onEvent?.({
        type: "assistant",
        turn,
        text: this.saidIn(message, said),
        calls: uses.filter(members).map((u) => ({ id: u.id, toolset: request.toolset, name: u.name, input: (u.input ?? {}) as Record<string, unknown> })),
        toolCalls: uses.filter((u) => !members(u)).map((u) => ({ id: u.id, name: u.name, input: u.input })),
      });
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (!uses.length) return { stopReason: message.stop_reason ?? "end_turn", text, turns: turn, actions, messages, usage, model };
      if (message.stop_reason === "max_tokens") throw new LlmOutputError("An action was truncated at max_tokens");

      const results: BetaToolResultBlockParam[] = [];
      let failed = false;
      let stoppedBy: ToolCall | undefined;
      for (const use of uses) {
        if (members(use)) {
          if (failed || stoppedBy) {
            results.push(toolsetResultBlock(use.id, request.toolset, { text: HALT_TEXT[request.toolset], isError: true }));
            continue;
          }
          const call = { id: use.id, toolset: request.toolset, name: use.name, input: (use.input ?? {}) as Record<string, unknown> };
          const started = Date.now();
          let result: ToolsetResult;
          try {
            result = await request.execute(call);
          } catch (error) {
            result = { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
          }
          actions++;
          if (result.isError) failed = true;
          await request.onEvent?.({ type: "action", turn, call, result, durationMs: Date.now() - started });
          results.push(toolsetResultBlock(use.id, request.toolset, result));
          continue;
        }
        const call: ToolCall = { id: use.id, name: use.name, input: use.input };
        if (failed) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: HALT_TEXT[request.toolset] });
          continue;
        }
        let out: { content: string; isError?: boolean; stop?: boolean };
        try {
          out = request.executeTool ? await request.executeTool(call) : { content: `Unknown tool ${use.name}`, isError: true };
        } catch (error) {
          out = { content: error instanceof Error ? error.message : String(error), isError: true };
        }
        if (out.stop && !out.isError) stoppedBy = call;
        results.push({ type: "tool_result", tool_use_id: use.id, content: out.content, is_error: out.isError ?? false });
      }
      if (stoppedBy) return { stopReason: "tool", stoppedBy, text, turns: turn, actions, messages, usage, model };
      messages.push({ role: "user", content: results });
    }
    return { stopReason: "max_turns", text, turns: maxTurns, actions, messages, usage, model };
  }
}
