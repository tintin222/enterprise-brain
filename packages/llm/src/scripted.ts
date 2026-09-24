import {
  LlmUnavailableError,
  emptyUsage,
  type CompleteRequest,
  type CompleteResult,
  type LlmClient,
  type StructuredRequest,
  type StructuredResult,
  type ToolLoopRequest,
  type ToolLoopResult,
} from "./types.ts";

/** Used when no model is configured: `available` is false and every call throws. */
export class UnavailableLlm implements LlmClient {
  readonly available = false;
  readonly provider = "offline";
  readonly model = "none";

  async complete(): Promise<CompleteResult> {
    throw new LlmUnavailableError();
  }
  async structured<T>(): Promise<StructuredResult<T>> {
    throw new LlmUnavailableError();
  }
  async runTools(): Promise<ToolLoopResult> {
    throw new LlmUnavailableError();
  }
}

export type ScriptHandler = {
  complete?: (request: CompleteRequest) => string | Promise<string>;
  structured?: (request: StructuredRequest) => unknown;
  /**
   * For tool loops: return a list of tool calls to make (executed in order), then
   * the final text. Called once per turn with the transcript so far.
   */
  tools?: (request: ToolLoopRequest, turn: number, previousResults: string[]) =>
    | { calls: { name: string; input: unknown }[] }
    | { text: string };
};

/**
 * Deterministic LLM for tests and demos: responses are scripted per `purpose`
 * (exact match, then longest prefix match, then the "*" handler).
 */
export class ScriptedLlm implements LlmClient {
  readonly available = true;
  readonly provider = "scripted";
  readonly model = "scripted";
  readonly calls: { purpose: string; kind: string; request: unknown }[] = [];

  constructor(private readonly handlers: Record<string, ScriptHandler>) {}

  private handlerFor(purpose: string): ScriptHandler {
    if (this.handlers[purpose]) return this.handlers[purpose]!;
    const prefix = Object.keys(this.handlers)
      .filter((k) => k !== "*" && purpose.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return this.handlers[prefix]!;
    if (this.handlers["*"]) return this.handlers["*"];
    throw new Error(`ScriptedLlm: no handler for purpose "${purpose}"`);
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    this.calls.push({ purpose: request.purpose, kind: "complete", request });
    const handler = this.handlerFor(request.purpose);
    if (!handler.complete) throw new Error(`ScriptedLlm: no complete() handler for "${request.purpose}"`);
    const text = await handler.complete(request);
    request.onText?.(text);
    return { text, stopReason: "end_turn", usage: { ...emptyUsage(), calls: 1 }, model: this.model };
  }

  async structured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    this.calls.push({ purpose: request.purpose, kind: "structured", request });
    const handler = this.handlerFor(request.purpose);
    if (!handler.structured) throw new Error(`ScriptedLlm: no structured() handler for "${request.purpose}"`);
    const data = (await handler.structured(request)) as T;
    return { data, usage: { ...emptyUsage(), calls: 1 }, model: this.model };
  }

  async runTools(request: ToolLoopRequest): Promise<ToolLoopResult> {
    this.calls.push({ purpose: request.purpose, kind: "tools", request });
    const handler = this.handlerFor(request.purpose);
    if (!handler.tools) throw new Error(`ScriptedLlm: no tools() handler for "${request.purpose}"`);
    const results: string[] = [];
    const maxTurns = request.maxTurns ?? 12;
    for (let turn = 1; turn <= maxTurns; turn++) {
      const step = handler.tools(request, turn, results);
      if ("text" in step) {
        await request.onEvent?.({ type: "assistant", turn, text: step.text, toolCalls: [] });
        request.onText?.(step.text);
        return { text: step.text, stopReason: "end_turn", turns: turn, messages: request.messages, usage: { ...emptyUsage(), calls: turn }, model: this.model };
      }
      const calls = step.calls.map((c, i) => ({ id: `call_${turn}_${i}`, name: c.name, input: c.input }));
      await request.onEvent?.({ type: "assistant", turn, text: "", toolCalls: calls });
      for (const call of calls) {
        const started = Date.now();
        const result = await request.executeTool(call);
        results.push(result.content);
        await request.onEvent?.({ type: "tool_result", turn, call, result, durationMs: Date.now() - started });
      }
    }
    return { text: "", stopReason: "max_turns", turns: maxTurns, messages: request.messages, usage: emptyUsage(), model: this.model };
  }
}
