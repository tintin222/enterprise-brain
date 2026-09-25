import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { LocalHashEmbedder, ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { Platform, taskRefIn, type TaskRow } from "../src/index.ts";

/**
 * Tasks that last days: a workflow that emails a supplier and waits for the reply (or reminds them),
 * an AI employee that plans its own wait with task tools, wake-ups on replies, times and decisions,
 * and a manager pausing, resuming and stopping work.
 */

const firstMessage = (request: ToolLoopRequest) => String((request.messages[0] as { content: unknown }).content);

/** The autonomous AI employee: asks the supplier, waits for the answer, closes the task when it comes. */
const llm = new ScriptedLlm({
  "runtime.agent": {
    tools: (request, turn) => {
      const brief = firstMessage(request);
      if (/A reply arrived/.test(brief)) {
        return turn === 1 ? { calls: [{ name: "task_complete", input: { outcome: "The supplier confirmed the corrected price." } }] } : { text: "Closed." };
      }
      if (/rejected/.test(brief)) {
        return turn === 1 ? { calls: [{ name: "task_complete", input: { outcome: "Not sent: the manager rejected the email." } }] } : { text: "Closed." };
      }
      if (turn === 1) {
        return {
          calls: [
            { name: "task_note", input: { text: "Invoice price 12.50 differs from the order price 12.00." } },
            { name: "mail_send", input: { to: "billing@supplier.example", subject: "Price difference on invoice INV-77", body: "Please confirm the price." } },
            { name: "task_wait_for_reply", input: { days: 2, note: "Their answer on the price" } },
          ],
        };
      }
      return { text: "Asked the supplier; waiting for their answer." };
    },
  },
});

const chaser: AgentDefinitionInput = {
  slug: "supplier-chaser",
  name: "Supplier Chaser",
  summary: "Asks a supplier for a delivery date and reminds them when they don't answer.",
  archetype: "process-automation",
  instructions: "Chase suppliers.",
  inputs: [{ key: "order", type: "string", required: true }],
  workflow: [
    { id: "ask", type: "mail.send", to: "orders@supplier.example", subject: "Delivery date for {{ input.order }}", body: "When will {{ input.order }} ship?", requiresApproval: false },
    { id: "answer", type: "wait", for: "reply", days: 3 },
    {
      id: "remind",
      type: "mail.send",
      when: "!steps.answer.replied",
      to: "orders@supplier.example",
      subject: "Reminder: delivery date for {{ input.order }}",
      body: "We still need the delivery date.",
      requiresApproval: false,
    },
    { id: "result", type: "output", value: { replied: "{{ steps.answer.replied }}", reply: "{{ steps.answer.reply.body }}" } },
  ],
};

const clerk: AgentDefinitionInput = {
  slug: "invoice-clerk",
  name: "Invoice Clerk",
  summary: "Sorts out invoice problems with suppliers.",
  archetype: "process-automation",
  instructions: "Resolve invoice differences with the supplier by email.",
  tools: ["mail.send"],
};

let platform: Platform;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-tasks-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.agents.create(companyId, { definition: chaser, status: "active" });
  await platform.agents.create(companyId, { definition: clerk, status: "active" });
});
afterAll(async () => {
  await platform?.close();
});

const taskOf = async (runId: string): Promise<TaskRow> => {
  const run = await platform.engine.getRow(companyId, runId);
  return platform.tasks.get(companyId, run.taskId!);
};
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const reply = (subject: string, body: string, from = "orders@supplier.example") =>
  platform.mail.ingest(companyId, { mailbox: "purchasing@acme.test", from, subject, body });

describe("a workflow that waits for a reply", () => {
  it("emails with the task's reference, waits, and continues when the reply arrives", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-4500031" });
    expect(run.status).toBe("waiting");
    const task = await taskOf(run.id);
    expect(task).toMatchObject({ status: "waiting", title: "Supplier Chaser: PO-4500031", source: "request" });
    expect(task.nextCheckAt!.getTime()).toBeGreaterThan(inDays(2.9).getTime());
    const [sent] = await platform.tasks.mailsOf(task.id);
    expect(sent!.subject).toBe(`Delivery date for PO-4500031 [${task.ref}]`);

    const answer = await reply(`Re: ${sent!.subject}`, "It ships on Friday.");
    expect(await platform.triggers.routeInboundMail(companyId, answer, { wait: true })).toEqual([]);
    const done = await platform.engine.waitForSettled(companyId, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toMatchObject({ replied: true, reply: "It ships on Friday." });

    const closed = await platform.tasks.get(companyId, task.ref);
    expect(closed).toMatchObject({ status: "done", wakeups: 1 });
    const history = (await platform.tasks.events(task.id)).map((e) => e.type);
    expect(history).toEqual(["created", "waiting", "email", "woke", "done"]);
    // The reminder was skipped: they answered.
    expect((await platform.tasks.mailsOf(task.id)).map((m) => m.direction)).toEqual(["outbound", "inbound"]);
  });

  it("reminds the supplier when nobody answers in time", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-4500032" });
    const task = await taskOf(run.id);
    expect(await platform.engine.wakeDueTasks(inDays(1))).toBe(0);
    expect(await platform.engine.wakeDueTasks(inDays(4))).toBe(1);
    const done = await platform.engine.waitForSettled(companyId, run.id);
    expect(done.output).toMatchObject({ replied: false });
    const mails = await platform.tasks.mailsOf(task.id);
    expect(mails.map((m) => m.subject)).toEqual([`Delivery date for PO-4500032 [${task.ref}]`, `Reminder: delivery date for PO-4500032 [${task.ref}]`]);
    expect((await platform.tasks.get(companyId, task.id)).status).toBe("done");
  });

  it("recognises a reply by its thread when the reference was removed", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-4500033" });
    const task = await taskOf(run.id);
    const first = await platform.mail.ingest(companyId, { mailbox: "purchasing@acme.test", from: "orders@supplier.example", subject: "Delivery", body: "Checking.", threadId: "thread-33" });
    await platform.tasks.linkMail(companyId, first.id, task.id);
    const second = await platform.mail.ingest(companyId, { mailbox: "purchasing@acme.test", from: "orders@supplier.example", subject: "Delivery", body: "Monday.", threadId: "thread-33" });
    expect((await platform.tasks.matchReply(companyId, second))?.id).toBe(task.id);
    expect(taskRefIn("RE: price [eb-7k2q9]")).toBe("EB-7K2Q9");
    await platform.engine.stopTask(companyId, task.ref, "test");
  });
});

describe("an AI employee that plans its own wait", () => {
  it("asks a person before emailing, waits for the reply once approved, and closes the task", async () => {
    const run = await platform.engine.start(companyId, "invoice-clerk", {}, { task: "Invoice INV-77 has the wrong price. Sort it out with the supplier.", actor: "Elif Arslan" });
    expect(run.status).toBe("succeeded");
    let task = await taskOf(run.id);
    expect(task).toMatchObject({ status: "needs_person", title: "Invoice INV-77 has the wrong price. Sort it out with the supplier.", requestedBy: "Elif Arslan" });
    expect((task.plan as { next: string }).next).toBe("wait_reply");

    const [approval] = await platform.tasks.approvalsOf(task.id, "pending");
    expect(approval).toMatchObject({ title: "Send email to billing@supplier.example", reason: "Supervised: every change goes to a person" });
    expect((approval!.action as { subject: string }).subject).toBe(`Price difference on invoice INV-77 [${task.ref}]`);
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Burak Şahin" });
    task = await platform.tasks.get(companyId, task.id);
    expect(task.status).toBe("waiting");
    expect(task.nextCheckAt!.getTime()).toBeGreaterThan(inDays(1.9).getTime());

    const answer = await reply(`Re: Price difference on invoice INV-77 [${task.ref}]`, "Sorry, the price is 12.00. We'll send a corrected invoice.", "billing@supplier.example");
    await platform.triggers.routeInboundMail(companyId, answer, { wait: true });
    task = await platform.tasks.get(companyId, task.id);
    expect(task).toMatchObject({ status: "done", outcome: "The supplier confirmed the corrected price." });
    const history = await platform.tasks.events(task.id);
    expect(history.map((e) => e.type)).toEqual(["created", "note", "needs_person", "decided", "waiting", "email", "woke", "done"]);
    expect(history.find((e) => e.type === "decided")?.message).toBe("Burak Şahin approved: Send email to billing@supplier.example");
    // The second run got the reply in its brief.
    const [, second] = await platform.tasks.runsOf(task.id);
    expect(String((second!.context as { task?: string }).task)).toContain("Sorry, the price is 12.00");
  });

  it("wakes up to rethink when a person rejects its change", async () => {
    const run = await platform.engine.start(companyId, "invoice-clerk", {}, { task: "Invoice INV-78 is missing a PO number." });
    const task = await taskOf(run.id);
    const [approval] = await platform.tasks.approvalsOf(task.id, "pending");
    await platform.engine.decide(companyId, approval!.id, { approved: false, note: "Call them instead", decidedBy: "Burak Şahin" });
    const settled = await platform.engine.waitForSettled(companyId, (await platform.tasks.runsOf(task.id)).at(-1)!.id);
    expect(settled.status).toBe("succeeded");
    expect(await platform.tasks.get(companyId, task.id)).toMatchObject({ status: "done", outcome: "Not sent: the manager rejected the email." });
  });
});

describe("a manager holding and stopping work", () => {
  it("pauses a waiting task (no wake-ups), keeps a reply for later, and resumes it", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-4500034" });
    const task = await taskOf(run.id);
    await platform.engine.pauseTask(companyId, task.ref, "Burak Şahin");
    await platform.engine.wakeDueTasks(inDays(4));
    expect((await platform.tasks.get(companyId, task.id)).status).toBe("paused");

    const answer = await reply(`Re: Delivery date for PO-4500034 [${task.ref}]`, "Next Tuesday.");
    await platform.triggers.routeInboundMail(companyId, answer, { wait: true });
    expect((await platform.tasks.get(companyId, task.id)).status).toBe("paused");

    await platform.engine.resumeTask(companyId, task.ref, "Burak Şahin");
    expect((await platform.tasks.get(companyId, task.id)).status).toBe("waiting");
    expect(await platform.engine.wakeDueTasks(new Date())).toBe(1);
    const done = await platform.engine.waitForSettled(companyId, run.id);
    expect(done.output).toMatchObject({ replied: true, reply: "Next Tuesday." });
  });

  it("stops a task for good", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-4500035" });
    const task = await taskOf(run.id);
    const stopped = await platform.engine.stopTask(companyId, task.ref, "Burak Şahin");
    expect(stopped).toMatchObject({ status: "stopped" });
    expect((await platform.engine.getRow(companyId, run.id)).status).toBe("cancelled");
    await platform.engine.wakeDueTasks(inDays(10));
    expect((await platform.tasks.get(companyId, task.id)).wakeups).toBe(0);
    // A late reply to a stopped task is new work, not a wake-up.
    const late = await reply(`Re: Delivery date for PO-4500035 [${task.ref}]`, "Shipped.");
    expect((await platform.triggers.routeInboundMail(companyId, late, { wait: true })).length).toBe(0);
    expect((await platform.tasks.get(companyId, task.id)).status).toBe("stopped");
  });

  it("keeps test runs out of tasks", async () => {
    const run = await platform.engine.start(companyId, "supplier-chaser", { order: "PO-TEST" }, { isTest: true });
    expect(run).toMatchObject({ status: "succeeded", taskId: null });
    expect(run.output).toMatchObject({ replied: false });
  });
});
