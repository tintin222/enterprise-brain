import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicLlm,
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
    model: "claude-opus-5",
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
    expect(params.model).toBe("claude-opus-5");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    // 1000 in * $5/M + 200 out * $25/M
    expect(result.usage.costUsd).toBeCloseTo(0.01, 6);
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
