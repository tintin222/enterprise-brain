import { describe, expect, it } from "vitest";
import type { RoundQuestion } from "@enterprise-brain/core";
import { baseNodes, buildInitialNodes, integrationNodes } from "../src/nodes.ts";
import { durationInDays } from "../src/generate.ts";
import { coerceAnswer, parseRoundReply, splitNumbered } from "../src/parse.ts";
import { renderFollowUp } from "../src/render.ts";
import { composeStakeholderRequest, stakeholderQuestion } from "../src/stakeholders.ts";
import {
  answer,
  createNode,
  createTree,
  delegate,
  delegatedNodes,
  frontier,
  getNode,
  interviewComplete,
  isApplicable,
  progress,
  skip,
  waitingOnStakeholders,
} from "../src/tree.ts";

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

describe("requirement tree frontier", () => {
  it("asks only questions whose prerequisites are settled, in section order", () => {
    const tree = createTree(buildInitialNodes({ archetype: "document-processing" }));
    expect(ids(frontier(tree))).toEqual(["purpose.goal"]);
    answer(tree, "purpose.goal", "Screen CVs for open positions");
    const second = ids(frontier(tree));
    expect(second).toContain("purpose.name");
    expect(second).toContain("inputs.channels");
    expect(second).toContain("processing.reference");
    // outputs.fields waits on the samples; governance waits on channels.
    expect(second).not.toContain("outputs.fields");
    expect(second).not.toContain("governance.personal_data");
  });

  it("activates conditional nodes (mailbox, integrations) only when they apply", () => {
    const tree = createTree(buildInitialNodes({ archetype: "document-processing" }));
    answer(tree, "purpose.goal", "Screen CVs");
    answer(tree, "inputs.channels", ["upload"]);
    expect(isApplicable(tree, getNode(tree, "inputs.mailbox")!)).toBe(false);
    expect(ids(frontier(tree))).toContain("inputs.form");
    answer(tree, "inputs.channels", ["email", "upload"]);
    expect(ids(frontier(tree))).toContain("inputs.mailbox");
    answer(tree, "inputs.mailbox", "careers@acme.com");
    expect(ids(frontier(tree))).toContain("integration.mail");
  });

  it("treats non-applicable dependencies as settled and delegated ones as blocking", () => {
    const tree = createTree([
      createNode({ id: "a", section: "purpose", title: "A", question: "?", answerType: "text" }, "base"),
      createNode({ id: "b", section: "inputs", title: "B", question: "?", answerType: "text", prerequisites: ["a"] }, "base"),
      createNode({ id: "c", section: "inputs", title: "C", question: "?", answerType: "text", when: { node: "a", op: "eq", value: "x" } }, "base"),
      createNode({ id: "d", section: "outputs", title: "D", question: "?", answerType: "text", prerequisites: ["c", "b"] }, "base"),
    ]);
    answer(tree, "a", "y");
    expect(ids(frontier(tree))).toEqual(["b"]);
    delegate(tree, "b", "req-1");
    expect(frontier(tree)).toEqual([]);
    expect(ids(waitingOnStakeholders(tree))).toEqual(["d"]);
    expect(ids(delegatedNodes(tree))).toEqual(["b"]);
    expect(interviewComplete(tree)).toBe(false);
    answer(tree, "b", "done", { answeredBy: "stakeholder" });
    expect(ids(frontier(tree))).toEqual(["d"]);
    skip(tree, "d");
    expect(interviewComplete(tree)).toBe(true);
    expect(progress(tree).percent).toBe(100);
  });

  it("survives dependency cycles from dynamic nodes", () => {
    const tree = createTree([
      createNode({ id: "x", section: "purpose", title: "X", question: "?", prerequisites: ["y"] }, "dynamic"),
      createNode({ id: "y", section: "purpose", title: "Y", question: "?", prerequisites: ["x"] }, "dynamic"),
    ]);
    expect(() => frontier(tree)).not.toThrow();
  });

  it("includes archetype and integration questions", () => {
    const mail = buildInitialNodes({ archetype: "mail-triage" });
    expect(ids(mail)).toContain("mail.categories");
    expect(ids(mail)).toContain("mail.reply_policy");
    expect(ids(integrationNodes()).every((id) => id.startsWith("integration."))).toBe(true);
    expect(baseNodes({ archetype: "conversational" }).find((n) => n.id === "ui.layout")?.recommended).toBe("chat");
  });
});

const round: RoundQuestion[] = [
  {
    number: 1,
    nodeId: "inputs.channels",
    title: "Channels",
    question: "Where do inputs come from?",
    answerType: "multi",
    options: [
      { value: "email", label: "Email to a mailbox" },
      { value: "upload", label: "Someone uploads files in a form" },
      { value: "system", label: "From a business system" },
    ],
    recommended: ["upload"],
    owner: "requester",
    delegable: false,
  },
  {
    number: 2,
    nodeId: "governance.retention",
    title: "Retention",
    question: "How long may data be kept?",
    answerType: "single",
    options: [
      { value: "30", label: "30 days" },
      { value: "180", label: "6 months" },
    ],
    recommended: "180",
    owner: "dpo",
    delegable: true,
  },
  {
    number: 3,
    nodeId: "outputs.fields",
    title: "Fields",
    question: "What should the result contain?",
    answerType: "fields",
    recommended: ["Full name", "Email"],
    owner: "requester",
    delegable: false,
  },
  {
    number: 4,
    nodeId: "integration.mail",
    title: "Mailbox access",
    question: "How should we get access?",
    answerType: "single",
    options: [
      { value: "ask-it", label: "Ask IT on my behalf" },
      { value: "manual-for-now", label: "Start with manual upload" },
    ],
    recommended: "ask-it",
    owner: "it",
    delegable: true,
  },
];

describe("offline reply parsing", () => {
  it("splits numbered answers without confusing numbers inside answers", () => {
    const parts = splitNumbered("1 email and upload, 2 within 30 days\n3) ok plus Phone", 3);
    expect([...parts!.keys()]).toEqual([1, 2, 3]);
    expect(parts!.get(2)).toBe("within 30 days");
  });

  it("interprets choices, acceptance with additions and delegation (EN)", () => {
    const answers = parseRoundReply("1 email and upload, 2 I don't know, ask our DPO, 3 ok plus phone number, 4 a", round);
    const byNode = Object.fromEntries(answers.map((a) => [a.nodeId, a]));
    expect(byNode["inputs.channels"]).toMatchObject({ action: "answer", value: ["email", "upload"] });
    expect(byNode["governance.retention"]).toMatchObject({ action: "delegate", delegateTo: "dpo" });
    expect(byNode["outputs.fields"]).toMatchObject({ action: "accept", value: ["Full name", "Email", "phone number"] });
    expect(byNode["integration.mail"]).toMatchObject({ action: "delegate", value: "ask-it", delegateTo: "it" });
  });

  it("understands Turkish replies", () => {
    const answers = parseRoundReply("1 e-posta ile geliyor, 2 bilmiyorum KVKK sorumlusuna sor, 3 tamam", round);
    const byNode = Object.fromEntries(answers.map((a) => [a.nodeId, a]));
    expect(byNode["inputs.channels"]?.action).toBe("answer");
    expect(byNode["governance.retention"]).toMatchObject({ action: "delegate", delegateTo: "dpo" });
    expect(byNode["outputs.fields"]).toMatchObject({ action: "accept", value: ["Full name", "Email"] });
  });

  it("maps numbers to the round's question numbers when earlier questions are already settled", () => {
    const open = [3, 4, 5].map((number): RoundQuestion => ({ number, nodeId: `n${number}`, title: `Q${number}`, question: "?", answerType: "text", recommended: "rec", owner: "requester", delegable: false }));
    const answers = parseRoundReply("3 ok\n4 ok\n5 The job requisitions in our ATS have the requirements.", open);
    expect(answers.map((a) => [a.nodeId, a.action, a.value])).toEqual([
      ["n3", "accept", "rec"],
      ["n4", "accept", "rec"],
      ["n5", "answer", "The job requisitions in our ATS have the requirements."],
    ]);
  });

  it("accepts all recommendations at once", () => {
    const answers = parseRoundReply("hepsi tamam", round);
    expect(answers.map((a) => a.action)).toEqual(["accept", "accept", "accept", "accept"]);
  });
});

describe("answer validation", () => {
  const personalData = baseNodes({ archetype: "document-processing" }).find((n) => n.id === "governance.personal_data")!;
  const retention = baseNodes({ archetype: "document-processing" }).find((n) => n.id === "governance.retention")!;

  it("maps choice answers to option values by value, label or ordinal and rejects the rest", () => {
    expect(coerceAnswer(personalData, "contains")).toEqual({ ok: true, value: "contains" });
    expect(coerceAnswer(personalData, "No personal data")).toEqual({ ok: true, value: "none" });
    expect(coerceAnswer(personalData, "the third one")).toEqual({ ok: true, value: "sensitive" });
    expect(coerceAnswer(personalData, "whatever HR usually does")).toEqual({ ok: false });
    expect(coerceAnswer(personalData, "")).toEqual({ ok: false });
  });

  it("keeps the user's words for open-ended choices and parses durations from them", () => {
    expect(retention.allowOther).toBe(true);
    expect(coerceAnswer(retention, "2 years")).toEqual({ ok: true, value: "2 years" });
    expect(durationInDays("2 years")).toBe(730);
    expect(durationInDays("6 ay")).toBe(180);
    expect(durationInDays("180")).toBe(180);
    expect(durationInDays("policy")).toBeUndefined();
  });

  it("coerces numbers, yes/no and multi-choice lists", () => {
    expect(coerceAnswer({ answerType: "number" }, "about 40 a week")).toEqual({ ok: true, value: 40 });
    expect(coerceAnswer({ answerType: "number" }, "a lot")).toEqual({ ok: false });
    expect(coerceAnswer({ answerType: "boolean" }, "hayır")).toEqual({ ok: true, value: false });
    const channels = baseNodes({ archetype: "document-processing" }).find((n) => n.id === "inputs.channels")!;
    const result = coerceAnswer(channels, "email, WhatsApp");
    expect(result.ok && result.value).toEqual(["email", "WhatsApp"]);
  });

  it("follows up on unmatched and still-open questions", () => {
    const q = (number: number, nodeId: string, title: string): RoundQuestion => ({ number, nodeId, title, question: "?", answerType: "single", owner: "requester", delegable: false });
    const text = renderFollowUp({
      stillOpen: [q(2, "governance.personal_data", "Personal data"), q(3, "ui.layout", "How people use it")],
      unmatched: [{ question: q(2, "governance.personal_data", "Personal data"), node: personalData, said: "whatever HR usually does" }],
    });
    expect(text).toContain('I couldn\'t match "whatever HR usually does"');
    expect(text).toContain("a) No personal data");
    expect(text).toContain("Still open: **Q3 — How people use it**");
    expect(text).not.toContain("Still open: **Q2");
  });
});

describe("stakeholder requests", () => {
  it("drafts an IT integration request email and questionnaire", () => {
    const tree = createTree(buildInitialNodes({ archetype: "document-processing" }));
    answer(tree, "purpose.goal", "Screen incoming CVs against open positions");
    answer(tree, "inputs.channels", ["email"]);
    answer(tree, "inputs.mailbox", "careers@acme.com.tr");
    const question = stakeholderQuestion(getNode(tree, "integration.mail")!, tree);
    expect(question.question).toContain("careers@acme.com.tr");
    const request = composeStakeholderRequest("it", [question], {
      agentName: "CV Screener",
      goal: "Screen incoming CVs against open positions",
      requesterName: "Ayşe Yılmaz",
      requesterRole: "HR Manager",
      language: "en",
      answerUrl: "http://localhost:3200/answer/tok",
      recipientName: "Mehmet",
      technicalNotes: ["Entra ID app registration with Mail.Read"],
    });
    expect(request.subject).toContain("Integration request");
    expect(request.body).toContain("Hello Mehmet,");
    expect(request.body).toContain("http://localhost:3200/answer/tok");
    expect(request.body).toContain("Ayşe Yılmaz");
    expect(request.questionnaire).toContain("## Anything else?");
    const turkish = composeStakeholderRequest("it", [question], {
      agentName: "CV Tarayıcı",
      goal: "Gelen özgeçmişleri açık pozisyonlara göre değerlendirmek",
      requesterName: "Ayşe Yılmaz",
      language: "tr",
      answerUrl: "http://x/answer/t",
    });
    expect(turkish.subject).toContain("Entegrasyon talebi");
    expect(turkish.body).toContain("Teşekkürler");
  });
});
