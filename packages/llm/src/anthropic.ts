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
  type StructuredRequest,
  type StructuredResult,
  type ToolCall,
  type ToolLoopRequest,
  type ToolLoopResult,
} from "./types.ts";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

export const DEFAULT_MODEL = "claude-opus-5";

/** USD per million tokens: [input, output]. Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x. */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

function priceFor(model: string): [number, number] {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`) || model.endsWith(k));
  return key ? PRICES[key]! : [5, 25];
}

/** Models on which `thinking: {type: "adaptive"}` and `output_config.effort` are supported. */
function supportsAdaptiveThinking(model: string): boolean {
  return !/haiku/.test(model);
}

/** Server-side refusal fallbacks ("default" routing) for the model families that ship safety classifiers. */
function supportsDefaultFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5|mythos-5)/.test(model);
}

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
  private readonly defaultEffort: Effort | undefined;

  constructor(options: AnthropicLlmOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = options.client ?? (options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic());
    this.fallbacks = options.fallbacks ?? true;
    this.defaultEffort = options.defaultEffort;
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

  private usageOf(message: BetaMessage): LlmUsage {
    const [inPrice, outPrice] = priceFor(message.model ?? this.model);
    const u = message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cost =
      (u.input_tokens * inPrice + cacheRead * inPrice * 0.1 + cacheWrite * inPrice * 1.25 + u.output_tokens * outPrice) / 1_000_000;
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
    params.output_config = { ...(params.output_config ?? {}), format: { type: "json_schema", schema: request.schema } };
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
      const params = this.baseParams({ ...request, messages }, 32000);
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
      await request.onEvent?.({ type: "assistant", turn, text, toolCalls: calls });

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
      const results = await Promise.all(
        calls.map(async (call): Promise<BetaToolResultBlockParam> => {
          const started = Date.now();
          let result;
          try {
            result = await request.executeTool(call);
          } catch (error) {
            result = { content: error instanceof Error ? error.message : String(error), isError: true };
          }
          await request.onEvent?.({ type: "tool_result", turn, call, result, durationMs: Date.now() - started });
          return { type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError ?? false };
        }),
      );
      messages.push({ role: "user", content: results });
    }
    return { text: lastText, stopReason: "max_turns", turns: maxTurns, messages, usage, model };
  }
}
