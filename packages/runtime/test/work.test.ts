import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { LocalHashEmbedder, ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { Platform, type TaskRow } from "../src/index.ts";

/**
 * The work queue from the engine's side: an AI employee asks a person and continues with the answer;
 * a Shadow AI employee's finished work gets a check; a failed task goes to its manager and retries
 * from the failed step; a person corrects an email before approving it.
 */

const firstMessage = (request: ToolLoopRequest) => String((request.messages[0] as { content: unknown }).content);
let flaky = true;

const llm = new ScriptedLlm({
  "runtime.generate": { complete: () => "Q3 sales rose 8%." },
  "runtime.agent": {
    tools: (request, turn) => {
      const brief = firstMessage(request);
      if (request.purpose.includes("flaky")) {
        if (flaky) throw new Error("The model service is unavailable");
        return { text: "Done after the retry." };
      }
      if (/answered/.test(brief)) {
        return turn === 1 ? { calls: [{ name: "task_complete", input: { outcome: "Posted to cost centre 4200 as the manager said." } }] } : { text: "Closed." };
      }
      if (/cost centre/.test(brief) && turn === 1) {
        return {
          calls: [
            {
              name: "task_ask_person",
              input: {
                question: "Which cost centre should the Nordic Bearings invoice go to?",
                context: "The order has no cost centre.",
                suggestion: "4200 (maintenance), like the last three orders",
                options: ["4200", "4300"],
                to_manager: true,
              },
            },
          ],
        };
      }
      if (/Email the customer/.test(brief) && turn === 1) {
        return { calls: [{ name: "mail_send", input: { to: "jane@customer.example", subject: "Your order", body: "Your order ships tomorow." } }] };
      }
      return { text: "Waiting for the answer." };
    },
  },
});

const clerk: AgentDefinitionInput = {
  slug: "ap-clerk",
  name: "AP Clerk",
  summary: "Handles supplier invoices.",
  archetype: "process-automation",
  instructions: "Handle invoices.",
  tools: ["mail.send"],
};
const flakyAgent: AgentDefinitionInput = { ...clerk, slug: "flaky", name: "Flaky" };
const summariser: AgentDefinitionInput = {
  slug: "summariser",
  name: "Summariser",
  summary: "Writes summaries.",
  archetype: "report-generation",
  instructions: "Summarise.",
  inputs: [{ key: "text", type: "text", required: true }],
  workflow: [
    { id: "write", type: "llm.generate", prompt: "Summarise {{ input.text }}", fallback: "Summary: {{ input.text }}" },
    { id: "result", type: "output", value: { summary: "{{ steps.write.text }}" } },
  ],
};

let platform: Platform;
let companyId: string;
let managerId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-work-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  const manager = await platform.people.create(companyId, { email: "burak@acme.test", name: "Burak Şahin", role: "admin" });
  managerId = manager.id;
  for (const definition of [clerk, flakyAgent, summariser]) {
    await platform.agents.create(companyId, { definition, status: "active", managerUserId: managerId });
  }
});
afterAll(async () => {
  await platform?.close();
});

const taskOf = async (runId: string): Promise<TaskRow> => platform.tasks.get(companyId, (await platform.engine.getRow(companyId, runId)).taskId!);

describe("questions", () => {
  it("asks its manager, waits, and continues with the answer", async () => {
    const run = await platform.engine.start(companyId, "ap-clerk", {}, { task: "Post the Nordic Bearings invoice; the cost centre is missing." });
    let task = await taskOf(run.id);
    expect(task.status).toBe("needs_person");
    const [question] = await platform.work.openFor(task.id);
    expect(question).toMatchObject({
      kind: "question",
      title: "Which cost centre should the Nordic Bearings invoice go to?",
      suggestion: "4200 (maintenance), like the last three orders",
      options: ["4200", "4300"],
      assigneeUserId: managerId,
    });

    await platform.engine.resolveWorkItem(companyId, question!.id, { answer: "4200" }, "Burak Şahin", { wait: true });
    const latest = (await platform.tasks.runsOf(task.id)).at(-1)!;
    await platform.engine.waitForSettled(companyId, latest.id);
    task = await platform.tasks.get(companyId, task.id);
    expect(task).toMatchObject({ status: "done", outcome: "Posted to cost centre 4200 as the manager said." });
    expect(String((latest.context as { task?: string }).task)).toContain('Burak Şahin answered "Which cost centre should the Nordic Bearings invoice go to?": 4200');
    expect((await platform.tasks.events(task.id)).map((e) => e.type)).toEqual(["created", "asked", "needs_person", "answered", "woke", "done"]);
  });
});

describe("checks, failures and corrections", () => {
  it("has a person check every finished task of a Shadow AI employee, and keeps a wrong verdict for coaching", async () => {
    await platform.employment.update(companyId, "summariser", { probation: "shadow" }, "Burak Şahin");
    const run = await platform.engine.start(companyId, "summariser", { text: "Q3 sales rose 8%." });
    expect(run.status, run.error ?? "").toBe("succeeded");
    const task = await taskOf(run.id);
    const [review] = await platform.work.openFor(task.id, "review");
    expect(review).toMatchObject({ title: `Check Summariser's work: Summariser: Q3 sales rose 8%.`, assigneeUserId: managerId });
    await platform.engine.resolveWorkItem(companyId, review!.id, { verdict: "wrong", note: "Mention the region" }, "Burak Şahin");
    const coaching = (await platform.activity.list(companyId, 100)).find((a) => a.action === "agent.coaching_note");
    expect(coaching).toMatchObject({ summary: "Burak Şahin: Mention the region" });
    expect((await platform.tasks.events(task.id)).at(-1)?.message).toBe("Burak Şahin checked the work: wrong (Mention the region)");
  });

  it("sends a failed task to its manager and retries it from the failed step", async () => {
    const run = await platform.engine.start(companyId, "flaky", {}, { task: "Summarise the open invoices." });
    expect(run.status).toBe("failed");
    const task = await taskOf(run.id);
    const [failure] = await platform.work.openFor(task.id, "failure");
    expect(failure).toMatchObject({ title: "Flaky couldn't finish: Summarise the open invoices.", assigneeUserId: managerId });
    expect(failure!.details).toContain("The model service is unavailable");

    flaky = false;
    await platform.engine.resolveWorkItem(companyId, failure!.id, { retry: true }, "Burak Şahin", { wait: true });
    expect((await platform.engine.getRow(companyId, run.id)).status).toBe("succeeded");
    expect(await platform.tasks.get(companyId, task.id)).toMatchObject({ status: "done" });
    expect((await platform.work.get(companyId, failure!.id)).status).toBe("done");
  });

  it("lets a person correct an email before approving it", async () => {
    const run = await platform.engine.start(companyId, "ap-clerk", {}, { task: "Email the customer that the order ships tomorrow." });
    const task = await taskOf(run.id);
    const [approval] = await platform.tasks.approvalsOf(task.id, "pending");
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Burak Şahin", edits: { body: "Your order ships tomorrow." } });
    const [sent] = (await platform.tasks.mailsOf(task.id)).filter((m) => m.direction === "outbound");
    expect(sent!.bodyText).toBe("Your order ships tomorrow.");
    expect((await platform.tasks.events(task.id)).some((e) => e.message === "Burak Şahin corrected and approved: Send email to jane@customer.example")).toBe(true);
  });

  it("tells the manager when an AI employee stops at its budget", async () => {
    await platform.employment.update(companyId, "summariser", { monthlyBudgetUsd: 0 }, "Burak Şahin");
    await expect(platform.engine.start(companyId, "summariser", { text: "x" })).rejects.toThrow(/monthly budget/);
    const agent = await platform.agents.get(companyId, "summariser");
    const [notice] = await platform.work.list(companyId, { agentId: agent.row.id, kind: "notice", statuses: ["open"] });
    expect(notice).toMatchObject({ title: "Summariser stopped: it reached its monthly budget", assigneeUserId: managerId });
  });
});
