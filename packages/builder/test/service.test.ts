import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundQuestion } from "@enterprise-brain/core";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { Platform } from "@enterprise-brain/runtime";
import { BuilderService, parseRoundReply } from "../src/index.ts";

let platform: Platform;
let builder: BuilderService;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-builder-svc-")), inMemory: true, llm: new UnavailableLlm(), embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme", settings: { mailDomain: "acme.com.tr" } })).id;
  builder = new BuilderService(platform, { publicBaseUrl: "http://brain.test" });
});
afterAll(async () => {
  await platform?.close();
});

describe("builder service (offline)", () => {
  it("recommends the template's mailbox on the company's own domain", async () => {
    const view = await builder.start(companyId, { description: "I want an agent that screens the CVs we receive and scores candidates against the open position." });
    expect(view.session.templateId).toBe("hr.cv-screener");
    expect(view.tree.nodes.find((n) => n.id === "inputs.mailbox")?.recommended).toBe("careers@acme.com.tr");
  });

  it("keeps text sent with uploaded files as a note instead of an answer", async () => {
    let view = await builder.start(companyId, { description: "I want an agent that screens the CVs we receive and scores candidates against the open position." });
    const open = () => view.currentRound!.questions.filter((q) => ["open", "asked"].includes(view.tree.states[q.nodeId]?.status ?? "open")).map((q) => q.nodeId);
    const before = open();
    const file = await platform.files.put(companyId, { name: "note.txt", data: Buffer.from("Deniz Kaya\nBackend developer, 8 years of Node.js"), mimeType: "text/plain" });
    view = await builder.reply(companyId, view.session.id, { text: "Here is one of the CVs we got last week.", fileIds: [file.id] });
    expect(open()).toEqual(before.filter((id) => id !== "inputs.samples"));
    expect(view.messages.some((m) => m.role === "user" && m.content === "Here is one of the CVs we got last week.")).toBe(true);
  });

  it("asks for numbers when an unnumbered reply fits no single question", async () => {
    let view = await builder.start(companyId, { description: "I want an agent that screens the CVs we receive and scores candidates against the open position." });
    view = await builder.reply(companyId, view.session.id, { text: "We are a mid-sized manufacturer in Gebze." });
    expect(view.messages.at(-1)?.content).toMatch(/couldn't tell which question it answers/);
  });
});

describe("unnumbered offline replies", () => {
  const q = (number: number, nodeId: string, extra: Partial<RoundQuestion> = {}): RoundQuestion => ({ number, nodeId, title: nodeId, question: "?", answerType: "text", owner: "requester", delegable: false, ...extra });
  const choice = q(2, "ui.layout", { answerType: "single", options: [{ value: "chat", label: "A chat" }, { value: "table", label: "A results table" }] });

  it("attribute only unambiguous replies", () => {
    expect(parseRoundReply("Our recruiters", [q(1, "users.primary")]).map((a) => a.nodeId)).toEqual(["users.primary"]);
    expect(parseRoundReply("a chat please", [q(1, "users.primary"), choice]).map((a) => [a.nodeId, a.value])).toEqual([["ui.layout", "chat"]]);
    expect(parseRoundReply("Our recruiters", [q(1, "users.primary"), q(3, "purpose.out_of_scope")])).toEqual([]);
  });
});
