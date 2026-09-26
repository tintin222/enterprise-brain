import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AgentDefinition, type AgentDefinitionInput } from "@enterprise-brain/core";
import { coachingProposals } from "@enterprise-brain/db";
import { LocalHashEmbedder, ScriptedLlm, UnavailableLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { Platform, type RunRow, type TaskRow } from "@enterprise-brain/runtime";
import { RULES_HEADING, StudioCoach, describeJobChanges, withCoachingRules } from "../src/index.ts";

/**
 * Coaching with replay: a person marks a finished task as wrong and says why, the Studio turns it into a
 * rule and replays recent tasks with it (as tests: nothing is sent or written), and the manager
 * publishes the new version or keeps the old one.
 */

const text = (request: StructuredRequest) => request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

/** A model that sorts emails, and follows the rules from coaching in its instructions. */
function classify(request: StructuredRequest) {
  const item = text(request).split("<item>")[1]?.split("</item>")[0] ?? "";
  const rules = (request.system ?? "").split(RULES_HEADING)[1] ?? "";
  if (/unacceptable|complain/i.test(item)) return { category: "complaint", confidence: 0.95, reason: "The customer complains." };
  if (/late deliver/i.test(rules) && /\blate\b|hasn't arrived/i.test(item))
    return { category: "complaint", confidence: 0.9, reason: "A late delivery is a complaint (rule from coaching)." };
  if (/order|deliver/i.test(item)) return { category: "delivery", confidence: 0.8, reason: "About an order." };
  return { category: "other", confidence: 0.6, reason: "Nothing specific." };
}

const proposals: Record<string, unknown>[] = [];
const llm = new ScriptedLlm({
  "runtime.classify": { structured: classify },
  "coaching.propose": {
    structured: (request) =>
      proposals.shift() ?? {
        rules: [`A generic rule from: ${text(request).split("<corrections>")[1]?.slice(0, 40)}`],
        operations: [],
        explanation: "Added the rule.",
      },
  },
});

const serviceDesk: AgentDefinitionInput = {
  slug: "service-desk",
  name: "Service Desk",
  summary: "Sorts customer emails, opens a CRM case and sends complaints to the team lead.",
  archetype: "mail-triage",
  instructions: "You sort customer emails for Acme.\n\n## Tone\nFriendly and short.",
  inputs: [
    { key: "subject", label: "Subject", type: "string", required: true },
    { key: "body", label: "Email", type: "text", required: true },
    { key: "from", label: "From", type: "email", required: true },
  ],
  outputs: [
    { key: "category", label: "Category", type: "string" },
    { key: "escalated", label: "Sent to the team lead", type: "boolean" },
    { key: "case_id", label: "CRM case", type: "string" },
    { key: "reason", label: "Why", type: "text" },
  ],
  connectors: [{ ref: "crm", category: "crm", purpose: "Service cases" }],
  workflow: [
    {
      id: "classify",
      name: "Sort the email",
      type: "llm.classify",
      from: "{{ input.subject }}\n{{ input.body }}",
      categories: [
        { value: "delivery", label: "Order and delivery", keywords: ["order", "delivery"] },
        { value: "complaint", label: "Complaint", keywords: ["unacceptable", "complaint"] },
        { value: "other", label: "Other" },
      ],
    },
    {
      id: "case",
      name: "Open the CRM case",
      type: "connector",
      connector: "crm",
      operation: "create_case",
      input: {
        contact_email: "{{ input.from }}",
        subject: "{{ input.subject }}",
        description: "{{ input.body }}",
        category: "{{ steps.classify.category }}",
        priority: "medium",
      },
    },
    {
      id: "escalate",
      name: "Team lead looks at the complaint",
      type: "approval",
      when: "steps.classify.category == 'complaint'",
      title: "Complaint from {{ input.from }}: {{ input.subject }}",
    },
    {
      id: "result",
      type: "output",
      value: {
        category: "{{ steps.classify.category }}",
        escalated: "{{ steps.escalate.approved || false }}",
        case_id: "{{ steps.case.case_id }}",
        reason: "{{ steps.classify.reason }}",
      },
    },
  ],
  guardrails: { approvalRequiredFor: [], personalData: "contains" },
  ui: { layout: "inbox", highlight: ["category", "escalated", "case_id", "reason"] },
};

const emails = {
  late: { subject: "Order SO-100", body: "Where is my order SO-100? It is two weeks late now.", from: "ayse@kuzey.example" },
  lateAgain: { subject: "SO-101 still missing", body: "Order SO-101 still hasn't arrived and it is late again.", from: "can@guney.example" },
  angry: { subject: "Unacceptable", body: "Unacceptable service, I want to complain about your call centre.", from: "deniz@bati.example" },
  prices: { subject: "Price list", body: "Could you send me your price list for 2027?", from: "ece@dogu.example" },
};

let platform: Platform;
let coach: StudioCoach;
let companyId: string;
const tasks: Record<keyof typeof emails, TaskRow> = {} as never;

async function work(input: Record<string, unknown>): Promise<TaskRow> {
  let run: RunRow = await platform.engine.start(companyId, "service-desk", input, { trigger: "mailbox", wait: true });
  if (run.status === "waiting_approval") {
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Kerem" }, { wait: true });
    run = await platform.engine.getRow(companyId, run.id);
  }
  expect(run.status).toBe("succeeded");
  return (await platform.tasks.byId(run.taskId!))!;
}

async function cases(): Promise<number> {
  const crm = await platform.connectors.resolve(companyId, { ref: "crm", category: "crm" });
  return ((await platform.connectors.execute(companyId, crm, "search_cases", {})) as { total: number }).total;
}

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-coach-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.agents.create(companyId, { definition: serviceDesk, status: "active" });
  coach = new StudioCoach(platform);
  for (const [name, email] of Object.entries(emails)) tasks[name as keyof typeof emails] = await work(email);
});
afterAll(async () => {
  await platform?.close();
});

describe("coaching with replay", () => {
  it("marks a finished task as wrong, with the person's words", async () => {
    const original = (await platform.tasks.runsOf(tasks.late.id))[0]!;
    expect(original.output).toMatchObject({ category: "delivery", escalated: false });

    await expect(coach.correctTask(companyId, tasks.late.ref, { note: "  ", by: "Elif" })).rejects.toThrow(/in plain words/);
    const note = await coach.correctTask(companyId, tasks.late.ref, {
      note: "This was a complaint: the order is two weeks late. Late deliveries are complaints and go to the team lead.",
      by: "Elif",
    });
    expect(note).toMatchObject({ kind: "task", status: "open", taskId: tasks.late.id, by: "Elif" });
    const events = await platform.tasks.events(tasks.late.id);
    expect(events.at(-1)).toMatchObject({ type: "corrected", actor: "Elif" });
    expect(events.at(-1)?.message).toMatch(/^Elif marked it as wrong: This was a complaint/);

    // Only finished tasks: one still being worked on can't be marked wrong.
    const waiting = await platform.engine.start(companyId, "service-desk", emails.angry, { wait: true });
    expect(waiting.status).toBe("waiting_approval");
    await expect(coach.correctTask(companyId, waiting.taskId!, { note: "wrong", by: "Elif" })).rejects.toMatchObject({ status: 409 });
    await platform.engine.stopTask(companyId, waiting.taskId!, "Elif");
  });

  it("turns the correction into a rule and replays recent tasks without writing anything", async () => {
    proposals.push({
      rules: ["A late delivery is a complaint, even when the customer only asks where the order is."],
      operations: [
        { op: "add", path: "/workflow/0/categories/1/keywords/-", valueJson: '"late"' },
        { op: "replace", path: "/workflow/0/categories/1/description", valueJson: '"Dissatisfaction, including late deliveries"' },
        { op: "replace", path: "/slug", valueJson: '"renamed"' },
        { op: "add", path: "/workflow/9/when", valueJson: '"true"' },
      ],
      explanation: "Late deliveries now count as complaints, so the team lead sees them.",
    });
    const casesBefore = await cases();
    const tasksBefore = (await platform.tasks.list(companyId)).length;
    const approvalsBefore = (await platform.engine.listApprovals(companyId, { status: "pending" })).length;

    const view = await coach.propose(companyId, "service-desk", { by: "Elif", wait: true });
    expect(view.status).toBe("ready");
    expect(view.baseVersion).toBe(1);
    expect(view.stale).toBe(false);
    expect(view.rules).toEqual(["A late delivery is a complaint, even when the customer only asks where the order is."]);
    // What doesn't fit the job (its address, a step that doesn't exist) is left out, and said so.
    expect(view.explanation).toMatch(/^Late deliveries now count as complaints/);
    expect(view.explanation).toMatch(/Left out.*\/slug can't change through coaching.*\/workflow\/9\/when/);
    expect(view.notes.map((n) => [n.taskRef, n.status])).toEqual([[tasks.late.ref, "open"]]);

    // The job's changes, in words.
    const labels = view.changes.map((c) => c.label);
    expect(labels).toContain("Sort the email › categories › Complaint › keywords");
    expect(view.changes.find((c) => c.label.endsWith("keywords"))?.added).toEqual(["late"]);
    expect(view.changes.find((c) => c.path === "/instructions")?.added).toEqual(["A late delivery is a complaint, even when the customer only asks where the order is."]);

    // Replays: the corrected task first, then the latest finished ones.
    const { items, summary } = view.replay;
    expect(items[0]).toMatchObject({ ref: tasks.late.ref, corrected: true, status: "changed" });
    expect(items[0]!.notes[0]).toMatch(/Late deliveries are complaints/);
    expect(items[0]!.changes.filter((c) => c.kind === "outcome").map((c) => [c.key, c.before, c.after])).toEqual([
      ["category", "delivery", "complaint"],
      ["escalated", false, true],
    ]);
    expect(items[0]!.changes.find((c) => c.key === "reason")?.kind).toBe("wording");
    expect(items[0]!.steps).toEqual([{ stepId: "escalate", name: "Team lead looks at the complaint", kind: "person", change: "added" }]);
    const byRef = new Map(items.map((item) => [item.ref, item]));
    expect(byRef.get(tasks.lateAgain.ref)).toMatchObject({ corrected: false, status: "changed" });
    expect(byRef.get(tasks.angry.ref)).toMatchObject({ status: "same", changes: [], steps: [] });
    expect(byRef.get(tasks.prices.ref)).toMatchObject({ status: "same" });
    expect(summary).toEqual({ total: 4, done: 4, changed: 2, failed: 0, corrected: 1, correctedChanged: 1 });

    // Nothing was written or asked: no CRM case, no task, no approval; the case number is the original one.
    expect(await cases()).toBe(casesBefore);
    expect((await platform.tasks.list(companyId)).length).toBe(tasksBefore);
    expect((await platform.engine.listApprovals(companyId, { status: "pending" })).length).toBe(approvalsBefore);
    const replayRun = await platform.engine.getRow(companyId, items[0]!.runId!);
    expect(replayRun).toMatchObject({ isTest: true, taskId: null, agentVersion: 1 });
    const original = await platform.engine.getRow(companyId, items[0]!.originalRunId!);
    expect(replayRun.output?.case_id).toBe(original.output?.case_id);
    const { events } = await platform.engine.get(companyId, replayRun.id);
    expect(events.some((e) => e.stepId === "case" && /not done in a test run/.test(e.message ?? ""))).toBe(true);
    // The complaint that was escalated before took the team lead's original decision.
    const angry = await platform.engine.get(companyId, byRef.get(tasks.angry.ref)!.runId!);
    expect(angry.events.some((e) => e.stepId === "escalate" && /as decided in the original task/.test(e.message ?? ""))).toBe(true);

    // The live AI employee is unchanged until the manager publishes.
    expect((await platform.agents.get(companyId, "service-desk")).row.version).toBe(1);
  });

  it("publishes the new version: the correction becomes a rule it follows from then on", async () => {
    const [proposal] = (await coach.overview(companyId, "service-desk")).proposals;
    const published = await coach.publish(companyId, proposal!.id, "Elif");
    expect(published).toMatchObject({ status: "published", publishedVersion: 2, decidedBy: "Elif" });
    expect(published.notes.map((n) => [n.status, n.appliedVersion])).toEqual([["applied", 2]]);
    const agent = await platform.agents.get(companyId, "service-desk");
    expect(agent.row.version).toBe(2);
    expect(agent.definition.slug).toBe("service-desk");
    expect(agent.definition.instructions).toContain(`${RULES_HEADING}\n- A late delivery is a complaint`);
    expect(agent.definition.workflow[0]).toMatchObject({
      categories: expect.arrayContaining([expect.objectContaining({ value: "complaint", keywords: ["unacceptable", "complaint", "late"] })]),
    });
    expect((await platform.agents.versions(companyId, "service-desk"))[0]).toMatchObject({
      version: 2,
      createdBy: "Elif",
      note: expect.stringMatching(/^Coaching: A late delivery/),
    });
    expect((await platform.tasks.events(tasks.late.id)).at(-1)).toMatchObject({ type: "coached", message: expect.stringMatching(/version 2 of Service Desk/) });
    await expect(coach.publish(companyId, proposal!.id, "Elif")).rejects.toMatchObject({ status: 409 });

    // New work follows the rule.
    const next = await work({ subject: "SO-102", body: "My order SO-102 is late.", from: "fatma@kuzey.example" });
    expect((await platform.tasks.runsOf(next.id))[0]!.output).toMatchObject({ category: "complaint", escalated: true });
  });

  it("keeps the old version when the manager says so", async () => {
    await coach.correctTask(companyId, tasks.prices.ref, { note: "Price list requests go to sales, not here.", by: "Kerem" });
    const view = await coach.propose(companyId, "service-desk", { by: "Kerem", wait: true });
    expect(view.status).toBe("ready");
    const kept = await coach.keep(companyId, view.id, "Kerem");
    expect(kept).toMatchObject({ status: "kept", decidedBy: "Kerem", publishedVersion: null });
    expect(kept.notes.map((n) => n.status)).toEqual(["kept"]);
    expect((await platform.agents.get(companyId, "service-desk")).row.version).toBe(2);
    await expect(coach.propose(companyId, "service-desk", { by: "Kerem" })).rejects.toThrow(/no open corrections/);
  });

  it("won't publish over a version that changed meanwhile", async () => {
    await coach.correctTask(companyId, tasks.angry.ref, { note: "Complaints about the call centre go to the call centre lead.", by: "Kerem" });
    const view = await coach.propose(companyId, "service-desk", { by: "Kerem", wait: true, limit: 1 });
    expect(view.replay.summary.total).toBe(1);
    const agent = await platform.agents.get(companyId, "service-desk");
    await platform.agents.update(companyId, "service-desk", { ...agent.definition, summary: "Changed by someone else." }, { createdBy: "Deniz" });
    expect((await coach.proposal(companyId, view.id)).stale).toBe(true);
    await expect(coach.publish(companyId, view.id, "Kerem")).rejects.toThrow(/changed since this proposal/);
    await coach.keep(companyId, view.id, "Kerem");
  });

  it("lets a newer proposal take the place of one nobody decided on, and resumes cut-short replays", async () => {
    await coach.correctTask(companyId, tasks.lateAgain.ref, { note: "Say sorry first when an order is late.", by: "Kerem" });
    const first = await coach.propose(companyId, "service-desk", { by: "Kerem", wait: true, limit: 1 });
    const second = await coach.propose(companyId, "service-desk", { by: "Kerem", wait: true, limit: 1 });
    expect((await coach.proposal(companyId, first.id)).status).toBe("superseded");
    expect(second.notes.map((n) => n.taskRef)).toEqual([tasks.lateAgain.ref]);
    await expect(coach.publish(companyId, first.id, "Kerem")).rejects.toThrow(/newer proposal/);

    // A replay cut short by a restart starts over.
    await platform.handle.db.update(coachingProposals).set({ status: "replaying" }).where(eq(coachingProposals.id, second.id));
    expect(await coach.resumeInterrupted()).toBe(1);
    await coach.settled(second.id);
    expect(await coach.proposal(companyId, second.id)).toMatchObject({ status: "ready", replay: { summary: { total: 1, done: 1 } } });
    await coach.keep(companyId, second.id, "Kerem");
  });

  it("keeps corrections from checks and approvals as notes too", async () => {
    // A reasoned "no" on an approval is coaching.
    const run = await platform.engine.start(
      companyId,
      "service-desk",
      { subject: "Complaint", body: "I want to complain about the invoice.", from: "gul@bati.example" },
      { wait: true },
    );
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    await platform.engine.decide(companyId, approval!.id, { approved: false, decidedBy: "Kerem", note: "Invoice complaints go to finance." }, { wait: true });
    const notes = await platform.coachingNotes.list(companyId, run.agentId, { status: ["open"] });
    expect(notes[0]).toMatchObject({ kind: "rejection", taskId: run.taskId, by: "Kerem", note: expect.stringMatching(/Invoice complaints go to finance/) });
  });
});

describe("coaching without a model", () => {
  it("adds the corrections to its instructions as people wrote them", async () => {
    const offline = new StudioCoach(platform, new UnavailableLlm());
    const view = await offline.propose(companyId, "service-desk", { by: "Kerem", wait: true, limit: 2 });
    expect(view.rules).toEqual(["Invoice complaints go to finance."]);
    expect(view.explanation).toMatch(/No language model is set up/);
    expect(view.changes.map((c) => c.path)).toEqual(["/instructions"]);
    expect(view.status).toBe("ready");
    await offline.keep(companyId, view.id, "Kerem");
  });
});

describe("rules and changes in words", () => {
  it("adds rules under their heading once, before the next section", () => {
    const once = withCoachingRules("Intro.\n\n## Tone\nShort.", ["Late deliveries are complaints."]);
    expect(once).toBe(`Intro.\n\n## Tone\nShort.\n\n${RULES_HEADING}\n- Late deliveries are complaints.\n`);
    expect(withCoachingRules(once, ["late deliveries are complaints."])).toBe(once);
    const inside = withCoachingRules(`${RULES_HEADING}\n- One.\n\n## Tone\nShort.`, ["Two."]);
    expect(inside).toBe(`${RULES_HEADING}\n- One.\n- Two.\n\n## Tone\nShort.`);
  });

  it("names steps, categories and lists the way people see them", () => {
    const before = AgentDefinition.parse(serviceDesk);
    const after = structuredClone(before);
    const step = after.workflow[0] as Extract<(typeof after.workflow)[number], { type: "llm.classify" }>;
    step.categories.push({ value: "sales", label: "Sales request" });
    after.workflow[2] = { ...after.workflow[2]!, when: "steps.classify.category == 'complaint' || steps.classify.category == 'sales'" };
    after.guardrails.approvalRequiredFor = ["mail.send"];
    const changes = describeJobChanges(before, after);
    expect(changes.map((c) => c.label)).toEqual([
      "Sort the email › categories › Sales request",
      "Team lead looks at the complaint › runs when",
      "Rules › Always asks a person before",
    ]);
    expect(changes[0]).toMatchObject({ added: ["Sales request"] });
    expect(changes[2]).toMatchObject({ added: ["mail.send"], removed: [] });
  });
});
