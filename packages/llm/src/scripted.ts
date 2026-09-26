import { structuredOutputProblems } from "./schema.ts";
import {
  LlmUnavailableError,
  emptyUsage,
  type CompleteRequest,
  type CompleteResult,
  type LlmClient,
  type OperateRequest,
  type OperateResult,
  type StructuredRequest,
  type StructuredResult,
  type ToolCall,
  type ToolLoopRequest,
  type ToolLoopResult,
  type ToolsetCall,
  type ToolsetResult,
} from "./types.ts";
import { HALT_TEXT } from "./anthropic.ts";

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
  async operate(): Promise<OperateResult> {
    throw new LlmUnavailableError();
  }
}

/** One scripted turn on screens: member calls (run in order), then optionally one of the caller's tools, or a text answer. */
export type ScriptedOperateTurn = { actions?: { name: string; input?: Record<string, unknown> }[]; tool?: { name: string; input: unknown }; text?: string };

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
  /** For screens: called once per turn with every action so far and what it returned. */
  operate?: (request: OperateRequest, turn: number, history: { call: ToolsetCall; result: ToolsetResult }[]) => ScriptedOperateTurn | Promise<ScriptedOperateTurn>;
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
    // Tests exercise every Claude path through here: fail on schemas the real API would reject or reinterpret.
    const problems = structuredOutputProblems(request.schema);
    if (problems.length) throw new Error(`ScriptedLlm: schema for "${request.purpose}" is not valid for structured outputs:\n${problems.join("\n")}`);
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

  async operate(request: OperateRequest): Promise<OperateResult> {
    this.calls.push({ purpose: request.purpose, kind: "operate", request });
    const handler = this.handlerFor(request.purpose);
    if (!handler.operate) throw new Error(`ScriptedLlm: no operate() handler for "${request.purpose}"`);
    const history: { call: ToolsetCall; result: ToolsetResult }[] = [];
    const maxTurns = request.maxTurns ?? 40;
    let actions = 0;
    let text = "";
    const usage = (turns: number) => ({ ...emptyUsage(), calls: turns, costUsd: Math.round(turns * 0.002 * 1e6) / 1e6 });
    for (let turn = 1; turn <= maxTurns; turn++) {
      const step = await handler.operate(request, turn, history);
      const calls = (step.actions ?? []).map((a, i) => ({ id: `act_${turn}_${i}`, toolset: request.toolset, name: a.name, input: a.input ?? {} }));
      const toolCall: ToolCall | undefined = step.tool ? { id: `tool_${turn}`, name: step.tool.name, input: step.tool.input } : undefined;
      if (step.text) text = step.text;
      await request.onEvent?.({ type: "assistant", turn, text: step.text ?? "", calls, toolCalls: toolCall ? [toolCall] : [] });
      if (!calls.length && !toolCall) return { stopReason: "end_turn", text, turns: turn, actions, messages: request.messages, usage: usage(turn), model: this.model };
      let failed = false;
      for (const call of calls) {
        let result: ToolsetResult;
        if (failed) result = { text: HALT_TEXT[request.toolset], isError: true };
        else {
          const started = Date.now();
          try {
            result = await request.execute(call);
          } catch (error) {
            result = { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
          }
          actions++;
          failed = Boolean(result.isError);
          await request.onEvent?.({ type: "action", turn, call, result, durationMs: Date.now() - started });
        }
        history.push({ call, result });
      }
      if (toolCall && !failed && request.executeTool) {
        const out = await request.executeTool(toolCall);
        if (out.stop && !out.isError) return { stopReason: "tool", stoppedBy: toolCall, text, turns: turn, actions, messages: request.messages, usage: usage(turn), model: this.model };
      }
    }
    return { stopReason: "max_turns", text, turns: maxTurns, actions, messages: request.messages, usage: usage(maxTurns), model: this.model };
  }
}
