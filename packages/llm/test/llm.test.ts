import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicLlm,
  HALT_TEXT,
  LlmRefusalError,
  LocalHashEmbedder,
  ScriptedLlm,
  UnavailableLlm,
  createLlmFromEnv,
  extractJson,
} from "../src/index.ts";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

function message(partial: Partial<BetaMessage> & { content: BetaMessage["content"] }): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...partial,
  } as BetaMessage;
}

/** A fake Anthropic client capturing request params and replaying queued responses. */
function fakeClient(responses: BetaMessage[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("no more fake responses");
          const handlers: ((t: string) => void)[] = [];
          return {
            on(event: string, fn: (t: string) => void) {
              if (event === "text") handlers.push(fn);
              return this;
            },
            async finalMessage() {
              for (const block of next.content) if (block.type === "text") handlers.forEach((h) => h(block.text));
              return next;
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

describe("AnthropicLlm", () => {
  it("sends adaptive thinking, effort, fallbacks and prompt caching; computes cost", async () => {
    const { client, requests } = fakeClient([message({ content: [{ type: "text", text: "Hello", citations: null }] })]);
    const llm = new AnthropicLlm({ client });
    const result = await llm.complete({ purpose: "test", system: "sys", messages: [{ role: "user", content: "hi" }], effort: "low" });
    expect(result.text).toBe("Hello");
    const params = requests[0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    // 1000 in * $4/M + 200 out * $20/M
    expect(result.usage.costUsd).toBeCloseTo(0.008, 6);
  });

  it("sets effort explicitly when a call doesn't, and prices each model's cache reads", async () => {
    const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 };
    const { client, requests } = fakeClient([
      message({ content: [{ type: "text", text: "a", citations: null }], usage } as never),
      message({ model: "claude-opus-5", content: [{ type: "text", text: "b", citations: null }], usage } as never),
    ]);
    const llm = new AnthropicLlm({ client });
    const newer = await llm.complete({ purpose: "x", messages: [{ role: "user", content: "x" }] });
    expect(requests[0]!.output_config).toEqual({ effort: "medium" });
    // 1000 in * $4/M + 100k cache reads * $0.20/M
    expect(newer.usage.costUsd).toBeCloseTo(0.024, 6);
    const older = await llm.complete({ purpose: "x", model: "claude-opus-5", messages: [{ role: "user", content: "x" }] });
    // 1000 in * $5/M + 100k cache reads * $0.50/M
    expect(older.usage.costUsd).toBeCloseTo(0.055, 6);
  });

  it("asks tool loops for the notes between tool calls, on the models that write them as thinking", async () => {
    const note = { type: "thinking", thinking: "The order exists; checking the supplier next.", signature: "sig" };
    const { client, requests } = fakeClient([
      message({ stop_reason: "tool_use", content: [note, { type: "tool_use", id: "t1", name: "lookup", input: { q: "a" } }] as BetaMessage["content"] }),
      message({ content: [{ type: "text", text: "Done", citations: null }] }),
      message({ model: "claude-opus-5", content: [{ type: "text", text: "Done", citations: null }] }),
    ]);
    const llm = new AnthropicLlm({ client });
    const said: string[] = [];
    const loop = (model?: string) =>
      llm.runTools({
        purpose: "agent",
        ...(model ? { model } : {}),
        messages: [{ role: "user", content: "look it up" }],
        tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
        executeTool: async () => ({ content: "found" }),
        onEvent: (e) => {
          if (e.type === "assistant") said.push(e.text);
        },
      });
    const result = await loop();
    expect(requests[0]!.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(requests[0]!.betas).toEqual(["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"]);
    // The note is the turn's words in the timeline; the answer stays the text alone.
    expect(said).toEqual(["The order exists; checking the supplier next.", "Done"]);
    expect(result.text).toBe("Done");
    // Passed back unchanged.
    expect((requests[1]!.messages as { content: unknown }[])[1]!.content).toContainEqual(note);

    await loop("claude-opus-5");
    expect(requests[2]!.thinking).toEqual({ type: "adaptive" });
    expect(requests[2]!.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("requests structured output with a JSON schema", async () => {
    const { client, requests } = fakeClient([message({ content: [{ type: "text", text: '{"category":"invoice"}', citations: null }] })]);
    const llm = new AnthropicLlm({ client });
    const schema = { type: "object", properties: { category: { type: "string" } }, required: ["category"], additionalProperties: false };
    const result = await llm.structured<{ category: string }>({ purpose: "classify", messages: [{ role: "user", content: "x" }], schema });
    expect(result.data.category).toBe("invoice");
    expect((requests[0]!.output_config as { format: unknown }).format).toEqual({ type: "json_schema", schema });
  });

  it("throws on refusals", async () => {
    const { client } = fakeClient([
      message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "no" } } as never),
    ]);
    const llm = new AnthropicLlm({ client });
    await expect(llm.complete({ purpose: "x", messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("runs a tool loop with parallel tool calls answered in one user message", async () => {
    const { client, requests } = fakeClient([
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "lookup", input: { q: "a" } },
          { type: "tool_use", id: "t2", name: "lookup", input: { q: "b" } },
        ] as BetaMessage["content"],
      }),
      message({ content: [{ type: "text", text: "Done: A,B", citations: null }] }),
    ]);
    const llm = new AnthropicLlm({ client });
    const events: string[] = [];
    const result = await llm.runTools({
      purpose: "agent",
      messages: [{ role: "user", content: "look up a and b" }],
      tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
      executeTool: async (call) => ({ content: String((call.input as { q: string }).q).toUpperCase() }),
      onEvent: (e) => {
        events.push(e.type);
      },
    });
    expect(result.text).toBe("Done: A,B");
    expect(result.turns).toBe(2);
    const second = requests[1]!.messages as { role: string; content: { type: string; content: string }[] }[];
    const toolResultMessage = second[second.length - 1]!;
    expect(toolResultMessage.role).toBe("user");
    expect(toolResultMessage.content.map((c) => c.content)).toEqual(["A", "B"]);
    expect(events).toEqual(["assistant", "tool_result", "tool_result", "assistant"]);
    expect(result.usage.calls).toBe(2);
  });
});

describe("AnthropicLlm.operate (browser and computer use)", () => {
  it("runs a batch in order, halts it at a failure, and echoes the toolset on every result", async () => {
    const { client, requests } = fakeClient([
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "a1", name: "left_click", toolset_name: "browser", input: { target: { type: "ref", ref: "ref_2" } } },
          { type: "tool_use", id: "a2", name: "type", toolset_name: "browser", input: { text: "PO-4711" } },
          { type: "tool_use", id: "a3", name: "screenshot", toolset_name: "browser", input: {} },
        ] as BetaMessage["content"],
      }),
      message({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "f1", name: "finish", input: { outcome: "done", summary: "Found it" } }] as BetaMessage["content"],
      }),
    ]);
    const llm = new AnthropicLlm({ client });
    const ran: string[] = [];
    const result = await llm.operate({
      purpose: "screens.web",
      messages: [{ role: "user", content: "Look up PO-4711" }],
      toolset: "browser",
      tools: [{ name: "finish", description: "End", inputSchema: { type: "object", properties: { outcome: { type: "string" } } } }],
      execute: async (call) => {
        ran.push(call.name);
        if (call.name === "type") return { text: "Error: nothing has the keyboard", isError: true };
        return { text: "Clicked element ref_2.", browserState: { tabs: [{ tab_id: "tab-1", title: "Orders", url: "https://erp.example/orders", active: true }] } };
      },
      executeTool: async (call) => ({ content: "Finished.", stop: call.name === "finish" }),
    });

    expect(requests[0]!.tools).toEqual([{ type: "browser_toolset_20260801" }, { name: "finish", description: "End", input_schema: { type: "object", properties: { outcome: { type: "string" } } } }]);
    expect(ran).toEqual(["left_click", "type"]);
    const second = requests[1]!.messages as { role: string; content: Record<string, unknown>[] }[];
    const results = second.at(-1)!;
    expect(results.role).toBe("user");
    expect(results.content.map((r) => r.toolset_name)).toEqual(["browser", "browser", "browser"]);
    expect(results.content[0]!.content).toEqual([
      { type: "text", text: "Clicked element ref_2." },
      { type: "browser_state", tabs: [{ tab_id: "tab-1", title: "Orders", url: "https://erp.example/orders", active: true }] },
    ]);
    expect(results.content[1]).toMatchObject({ is_error: true, content: "Error: nothing has the keyboard" });
    expect(results.content[2]).toMatchObject({ is_error: true, content: HALT_TEXT.browser });
    expect(result).toMatchObject({ stopReason: "tool", stoppedBy: { name: "finish", input: { outcome: "done", summary: "Found it" } }, actions: 2, turns: 2 });
    expect(result.usage.calls).toBe(2);
  });

  it("returns screenshots as images, and ends when Claude answers in text", async () => {
    const { client, requests } = fakeClient([
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "c1", name: "left_click", toolset_name: "computer", input: { coordinate: [640, 400] } },
          { type: "tool_use", id: "c2", name: "screenshot", toolset_name: "computer", input: {} },
        ] as BetaMessage["content"],
      }),
      message({ content: [{ type: "text", text: "The stock is 42.", citations: null }] }),
    ]);
    const llm = new AnthropicLlm({ client });
    const result = await llm.operate({
      purpose: "screens.desktop",
      messages: [{ role: "user", content: "Read the stock" }],
      toolset: "computer",
      configs: { zoom: { enabled: false } },
      execute: async (call) => (call.name === "screenshot" ? { image: { data: "iVBORw0KGgo=", mediaType: "image/png" } } : {}),
    });
    expect(requests[0]!.tools).toEqual([{ type: "computer_toolset_20260801", configs: { zoom: { enabled: false } } }]);
    const results = (requests[1]!.messages as { content: Record<string, unknown>[] }[]).at(-1)!.content;
    expect(results[0]).toEqual({ type: "tool_result", tool_use_id: "c1", toolset_name: "computer", content: [{ type: "text", text: "OK" }] });
    expect(results[1]).toEqual({
      type: "tool_result",
      tool_use_id: "c2",
      toolset_name: "computer",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
    });
    expect(result).toMatchObject({ stopReason: "end_turn", text: "The stock is 42.", actions: 2 });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("is scripted for tests, with the same halt rule", async () => {
    const llm = new ScriptedLlm({
      "screens.": {
        operate: (_request, turn) =>
          turn === 1
            ? { actions: [{ name: "screenshot" }, { name: "key", input: { text: "Hyper" } }, { name: "wait", input: { duration: 1 } }] }
            : { tool: { name: "finish", input: { outcome: "done", summary: "ok" } } },
      },
    });
    const ran: string[] = [];
    const result = await llm.operate({
      purpose: "screens.web",
      messages: [{ role: "user", content: "x" }],
      toolset: "browser",
      execute: async (call) => {
        ran.push(call.name);
        return call.name === "key" ? { text: "Error: Unknown key", isError: true } : { text: "OK" };
      },
      executeTool: async () => ({ content: "Finished.", stop: true }),
    });
    expect(ran).toEqual(["screenshot", "key"]);
    expect(result).toMatchObject({ stopReason: "tool", stoppedBy: { name: "finish" }, actions: 2 });
    await expect(new UnavailableLlm().operate()).rejects.toThrow(/No LLM is configured/);
  });
});

describe("ScriptedLlm / factory", () => {
  it("routes by purpose prefix", async () => {
    const llm = new ScriptedLlm({ "builder.": { structured: () => ({ ok: true }) }, "*": { complete: () => "fallback" } });
    expect((await llm.structured({ purpose: "builder.plan", messages: [], schema: {} })).data).toEqual({ ok: true });
    expect((await llm.complete({ purpose: "other", messages: [] })).text).toBe("fallback");
  });

  it("creates an offline client without credentials", () => {
    expect(createLlmFromEnv({}).available).toBe(false);
    expect(createLlmFromEnv({ EB_LLM_PROVIDER: "offline", ANTHROPIC_API_KEY: "x" })).toBeInstanceOf(UnavailableLlm);
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: "sk-test" }).provider).toBe("anthropic");
  });
});

describe("embeddings", () => {
  it("produces normalized deterministic vectors where related text is closer", async () => {
    const e = new LocalHashEmbedder();
    const [a, b, c] = await e.embed(["annual leave policy for employees", "employees annual leave days", "invoice payment terms net 30"], "document");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(a!.length).toBe(1024);
    expect(dot(a!, a!)).toBeCloseTo(1, 5);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
});

describe("extractJson", () => {
  it("finds JSON in fenced or chatty text", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Result: {"b": [1, 2, "}"]} thanks')).toEqual({ b: [1, 2, "}"] });
    expect(extractJson("nothing here")).toBeUndefined();
  });
});
