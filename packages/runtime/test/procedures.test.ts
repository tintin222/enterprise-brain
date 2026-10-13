import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { LocalHashEmbedder, ScriptedLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * Procedures: a branch takes the first case that holds, a loop runs its steps for each item and resumes
 * in the right round after an approval inside it, a failing round can be kept or left out, and every
 * step's attempt is kept with its input and output for the run's inspector. Steps also write in Chat,
 * answer a waiting caller, wait for another system's call and give work to a colleague.
 */

const orderChecker: AgentDefinitionInput = {
  slug: "order-checker",
  name: "Order Checker",
  summary: "Checks each line of an order; big quantities need a person.",
  archetype: "process-automation",
  instructions: "Check order lines.",
  inputs: [
    { key: "lines", type: "list", itemType: "object", required: true },
    { key: "total", type: "number", required: true },
  ],
  outputs: [{ key: "size", type: "string" }],
  workflow: [
    {
      id: "route",
      type: "branch",
      cases: [{ id: "big", when: "input.total > 1000", steps: [{ id: "label_big", type: "output", value: { size: "big" } }] }],
      else: [{ id: "label_small", type: "output", value: { size: "small" } }],
    },
    {
      id: "lines",
      type: "each",
      over: "{{ input.lines }}",
      as: "line",
      steps: [
        { id: "check", type: "approval", title: "Approve {{ line.sku }} × {{ line.qty }}", when: "line.qty > 10" },
        {
          id: "line_result",
          type: "output",
          value: { sku: "{{ line.sku }}", approved: "{{ coalesce(steps.check.approved, 'not needed') }}", position: "{{ index }}" },
        },
      ],
    },
    {
      id: "result",
      type: "output",
      value: { size: "{{ coalesce(steps.label_big.size, steps.label_small.size) }}", route: "{{ steps.route.case }}", lines: "{{ steps.lines.items }}" },
    },
  ],
};

const roundFailer: AgentDefinitionInput = {
  slug: "round-failer",
  name: "Round Failer",
  summary: "One round of its loop fails.",
  archetype: "process-automation",
  instructions: "Go through the numbers.",
  workflow: [
    {
      id: "numbers",
      type: "each",
      over: "3",
      onItemError: "skip",
      steps: [
        { id: "boom", type: "connector", connector: "nowhere", operation: "explode", when: "item == 2" },
        { id: "keep", type: "output", value: { n: "{{ item }}" } },
      ],
    },
    { id: "broken", type: "connector", connector: "nowhere", operation: "explode", onError: "skip" },
    { id: "left_out", type: "approval", title: "Never asked: the step before it failed" },
    { id: "result", type: "output", value: { kept: "{{ steps.numbers.items | pluck:'n' }}", failed: "{{ steps.numbers.failed }}" } },
  ],
};

const priceList: AgentDefinitionInput = {
  slug: "price-list",
  name: "Price List",
  summary: "Totals an order by customer and works out a discount in code.",
  archetype: "process-automation",
  instructions: "Total the order.",
  inputs: [{ key: "lines", type: "list", itemType: "object", required: true }],
  workflow: [
    {
      id: "totals",
      type: "transform",
      from: "{{ input.lines }}",
      ops: [
        { op: "filter", where: "item.qty > 0" },
        { op: "set", fields: { amount: "{{ item.qty * item.price }}", "meta.position": "{{ index }}" } },
        { op: "aggregate", groupBy: ["customer"], values: { total: { fn: "sum", field: "amount" }, lines: { fn: "count" } } },
        { op: "sort", by: "total", order: "desc" },
      ],
    },
    {
      id: "discount",
      type: "code",
      input: { threshold: "{{ vars.discount_from }}" },
      code: "const best = ctx.steps.totals.first; console.log('best', best.customer); return { customer: best.customer, discount: best.total >= ctx.values.threshold ? Math.round(best.total * 0.05) : 0 };",
    },
    { id: "slow", type: "code", code: "while (true) {}", timeoutSeconds: 1, onError: "continue" },
    { id: "result", type: "output", value: { totals: "{{ steps.totals.items }}", discount: "{{ steps.discount }}", slow: "{{ steps.slow.error }}" } },
  ],
};

const fragile: AgentDefinitionInput = {
  slug: "fragile",
  name: "Fragile Poster",
  summary: "Posts to a system that is down.",
  archetype: "process-automation",
  instructions: "Post the entry.",
  workflow: [
    { id: "prepare", type: "output", value: { ready: true } },
    { id: "post", type: "connector", connector: "nowhere", operation: "post", retry: { times: 2, waitSeconds: 0 } },
    { id: "result", type: "output", value: { done: true, prepared: "{{ steps.prepare.ready }}" } },
  ],
  onFailure: { tell: "selin@acme.test", giveTo: "fixer", note: "Check the ERP connection." },
};

const fixer: AgentDefinitionInput = {
  slug: "fixer",
  name: "Fixer",
  summary: "Looks into failures.",
  archetype: "conversational",
  instructions: "Look into what failed.",
  tools: ["knowledge.search"],
};

const notifier: AgentDefinitionInput = {
  slug: "notifier",
  name: "Notifier",
  summary: "Tells people in Chat and answers the caller.",
  archetype: "process-automation",
  instructions: "Tell people.",
  inputs: [{ key: "order", type: "string", required: true }],
  workflow: [
    { id: "channel", type: "chat.send", to: "#general", text: "Order {{ input.order }} is in." },
    { id: "person", type: "chat.send", to: "selin@acme.test", text: "Please look at order {{ input.order }}." },
    { id: "in_task", type: "chat.send", to: "task", text: "Working on {{ input.order }}." },
    { id: "answer", type: "respond", status: 201, headers: { "X-Order": "{{ input.order }}", "Set-Cookie": "never=1" }, body: { order: "{{ input.order }}" } },
    { id: "result", type: "output", value: { told: "{{ steps.channel.where }}" } },
  ],
};

const announcer: AgentDefinitionInput = {
  slug: "announcer",
  name: "Announcer",
  summary: "Announces what a person approves.",
  archetype: "process-automation",
  instructions: "Announce.",
  workflow: [{ id: "announce", type: "chat.send", to: "#general", text: "Holiday on Friday.", requiresApproval: true }],
};

const waiter: AgentDefinitionInput = {
  slug: "waiter",
  name: "Waiter",
  summary: "Asks another system and waits for its call.",
  archetype: "process-automation",
  instructions: "Wait for the other system.",
  workflow: [
    { id: "hand", type: "output", value: { url: "{{ run.callbackUrl }}" } },
    { id: "check", type: "approval", title: "Ask the other system?", when: "input.ask == true" },
    { id: "wait_call", type: "wait", for: "callback", days: 2 },
    { id: "result", type: "output", value: { received: "{{ steps.wait_call.received }}", status: "{{ steps.wait_call.payload.status }}" } },
  ],
};

const asker: AgentDefinitionInput = {
  slug: "asker",
  name: "Asker",
  summary: "Gives part of the work to a colleague.",
  archetype: "process-automation",
  instructions: "Ask the fixer.",
  inputs: [{ key: "order", type: "string", required: true }],
  workflow: [
    { id: "ask", type: "call", colleague: "Fixer", request: "Check the ERP connection for order {{ input.order }}", input: { order: "{{ input.order }}" } },
    { id: "result", type: "output", value: { answer: "{{ steps.ask.answer }}", done: "{{ steps.ask.done }}" } },
  ],
};

const selfish: AgentDefinitionInput = {
  slug: "selfish",
  name: "Selfish",
  summary: "Tries to give work to itself.",
  archetype: "process-automation",
  instructions: "Ask yourself.",
  workflow: [{ id: "ask", type: "call", colleague: "selfish", request: "Do it" }],
};

let platform: Platform;
let companyId: string;

/** Wait until the check holds (work that continues in the background: a colleague's answer). */
async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-procedures-")),
    inMemory: true,
    llm: new ScriptedLlm({ "runtime.agent": { tools: () => ({ text: "Looked into it; the ERP connection needs IT." }) } }),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.agents.create(companyId, { definition: orderChecker, status: "active" });
  await platform.agents.create(companyId, { definition: roundFailer, status: "active" });
  await platform.agents.create(companyId, { definition: priceList, status: "active" });
  await platform.agents.create(companyId, { definition: fragile, status: "active" });
  await platform.agents.create(companyId, { definition: fixer, status: "active" });
  for (const definition of [notifier, announcer, waiter, asker, selfish]) await platform.agents.create(companyId, { definition, status: "active" });
  await platform.people.create(companyId, { name: "Selin Acar", email: "selin@acme.test" });
  await platform.handle.db.execute(sql`update companies set settings = jsonb_set(settings, '{variables}', '{"discount_from": 500}') where id = ${companyId}`);
});
afterAll(async () => {
  await platform?.close();
});

describe("branches and loops", () => {
  const lines = [
    { sku: "A-1", qty: 2 },
    { sku: "B-2", qty: 20 },
    { sku: "C-3", qty: 1 },
  ];

  it("takes the case that holds, and resumes a loop in the round where a person was asked", async () => {
    const run = await platform.engine.start(companyId, "order-checker", { lines, total: 1500 }, { wait: true });
    expect(run.status).toBe("waiting_approval");
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    expect(approval?.title).toBe("Approve B-2 × 20");

    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Selin" }, { wait: true });
    const done = await platform.engine.getRow(companyId, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({
      size: "big",
      route: "big",
      lines: [
        { sku: "A-1", approved: "not needed", position: 0 },
        { sku: "B-2", approved: true, position: 1 },
        // The round after the approval starts clean: its skipped approval shows nothing.
        { sku: "C-3", approved: "not needed", position: 2 },
      ],
    });

    // The inspector keeps every step, round by round, with its input as resolved.
    const steps = await platform.engine.stepsOf(companyId, run.id);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(Object.keys(byKey)).toEqual(
      expect.arrayContaining([
        "route",
        "label_big",
        "lines",
        "lines#0/check",
        "lines#0/line_result",
        "lines#1/check",
        "lines#1/line_result",
        "lines#2/line_result",
        "result",
      ]),
    );
    expect(byKey["label_small"]).toBeUndefined();
    expect(byKey["lines#0/check"]).toMatchObject({ status: "skipped", iteration: 0 });
    expect(byKey["lines#1/check"]).toMatchObject({ status: "succeeded", output: { approved: true, decidedBy: "Selin" } });
    expect(byKey["lines#1/line_result"]).toMatchObject({ status: "succeeded", iteration: 1, input: { value: { sku: "B-2", approved: true, position: 1 } } });
    expect(byKey["route"]).toMatchObject({ status: "succeeded", output: { case: "big", matched: true } });
    expect(byKey["lines"]).toMatchObject({ status: "succeeded", output: { count: 3, failed: 0 } });
  });

  it("takes the otherwise case when no case holds", async () => {
    const run = await platform.engine.start(companyId, "order-checker", { lines: [{ sku: "A-1", qty: 1 }], total: 50 }, { wait: true });
    expect(run.status).toBe("succeeded");
    expect(run.output).toMatchObject({ size: "small", route: "else" });
  });

  it("leaves a failed round out, and the steps after a failure with onError skip (an output at the end still runs)", async () => {
    const run = await platform.engine.start(companyId, "round-failer", {}, { wait: true });
    expect(run.status).toBe("succeeded");
    expect(run.output).toEqual({ kept: [1, 3], failed: 1 });
    const steps = await platform.engine.stepsOf(companyId, run.id);
    expect(steps.find((s) => s.key === "numbers#1/boom")).toMatchObject({ status: "failed" });
    expect(steps.find((s) => s.key === "broken")).toMatchObject({ status: "failed" });
    expect(steps.find((s) => s.key === "left_out")).toMatchObject({ status: "skipped" });
  });
});

describe("reshaping data and code", () => {
  it("filters, sets, totals by group and sorts a list, and works a result out in the sandbox with the company's variables", async () => {
    const lines = [
      { customer: "Petrokim", qty: 10, price: 40 },
      { customer: "Hansa", qty: 1, price: 100 },
      { customer: "Petrokim", qty: 5, price: 30 },
      { customer: "Hansa", qty: 0, price: 999 },
    ];
    const run = await platform.engine.start(companyId, "price-list", { lines }, { wait: true });
    expect(run.status).toBe("succeeded");
    expect(run.output).toMatchObject({
      totals: [
        { customer: "Petrokim", total: 550, lines: 2 },
        { customer: "Hansa", total: 100, lines: 1 },
      ],
      discount: { customer: "Petrokim", discount: 28 },
      slow: expect.stringMatching(/ran too long/),
    });
    const steps = await platform.engine.stepsOf(companyId, run.id);
    expect(steps.find((s) => s.key === "discount")).toMatchObject({ status: "succeeded", input: { input: { threshold: 500 } } });
    expect(steps.find((s) => s.key === "slow")).toMatchObject({ status: "failed" });
  });
});

describe("when a step fails", () => {
  it("tries again, then tells the person the job names and gives the failure to a colleague; a run starts again from a later step", async () => {
    const run = await platform.engine.start(companyId, "fragile", {}, { wait: true });
    expect(run.status).toBe("failed");
    const { events } = await platform.engine.get(companyId, run.id);
    expect(events.filter((e) => e.type === "step.retried").map((e) => (e.data as { attempt: number }).attempt)).toEqual([2, 3]);
    const attempts = (await platform.engine.stepsOf(companyId, run.id)).filter((s) => s.key === "post");
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);

    // The person the job names gets the failure, with its note; the colleague gets it as work.
    const selin = await platform.people.findByEmail(companyId, "selin@acme.test");
    const [failure] = await platform.work.list(companyId, { kind: "failure", taskId: run.taskId! });
    expect(failure).toMatchObject({ assigneeUserId: selin!.id, details: expect.stringContaining("Check the ERP connection.") });
    const given = (await platform.tasks.list(companyId, { limit: 20 })).find((t) => t.source === "failure");
    expect(given).toMatchObject({ title: expect.stringContaining("Failed:"), sourceRef: run.taskId });
    for (const colleagueRun of await platform.tasks.runsOf(given!.id)) await platform.engine.waitForSettled(companyId, colleagueRun.id);

    // Again from the last step: what the steps before it found is reused, they don't run again.
    const again = await platform.engine.rerunFrom(companyId, run.id, "result", "Selin", { wait: true });
    expect(again.status).toBe("succeeded");
    expect(again.output).toEqual({ done: true, prepared: true });
    expect((await platform.engine.stepsOf(companyId, again.id)).map((s) => s.key)).toEqual(["result"]);
    await expect(platform.engine.rerunFrom(companyId, run.id, "nowhere", "Selin")).rejects.toThrow(/no step "nowhere"/);
  });
});

describe("writing in Chat and answering the caller", () => {
  it("writes in a channel, to a person and in the task's conversation, and keeps the answer for the caller", async () => {
    const run = await platform.engine.start(companyId, "notifier", { order: "SO-7" }, { wait: true });
    expect(run.status).toBe("succeeded");
    expect(run.output).toEqual({ told: "#general" });
    const steps = (run.context as { steps: Record<string, { conversationId: string; seq: number; where: string }> }).steps;
    const text = async (id: string) => (await platform.conversations.messageAt(companyId, steps[id]!.conversationId, steps[id]!.seq))?.text;
    expect(await text("channel")).toBe("Order SO-7 is in.");
    expect(await text("person")).toBe("Please look at order SO-7.");
    expect(steps.person!.where).toBe("Selin Acar (direct message)");
    expect(await text("in_task")).toBe("Working on SO-7.");
    const message = await platform.conversations.messageAt(companyId, steps.channel!.conversationId, steps.channel!.seq);
    expect(message).toMatchObject({ authorKind: "ai_employee", runId: run.id });

    // The answer a waiting caller gets: the server's own headers are left out.
    expect((run.context as { response?: unknown }).response).toEqual({ status: 201, headers: { "X-Order": "SO-7" }, body: { order: "SO-7" } });
    const { events } = await platform.engine.get(companyId, run.id);
    expect(events.some((e) => e.type === "run.responded")).toBe(true);
  });

  it("finds the place in a test run without writing, and fails on a channel that does not exist", async () => {
    const test = await platform.engine.start(companyId, "notifier", { order: "SO-8" }, { isTest: true, wait: true });
    expect(test.status).toBe("succeeded");
    const steps = (test.context as { steps: Record<string, unknown> }).steps;
    expect(steps.channel).toEqual({ dryRun: true, wouldSend: { to: "#general", where: "#general", via: "chat", text: "Order SO-8 is in." } });
    expect(steps.in_task).toMatchObject({ dryRun: true, wouldSend: { where: "the task's conversation" } });

    const broken = { ...notifier, workflow: [{ id: "channel", type: "chat.send" as const, to: "#nowhere", text: "Hello" }] };
    const failed = await platform.engine.start(companyId, "notifier", { order: "SO-9" }, { isTest: true, definition: broken as never, wait: true });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/no open channel #nowhere/);
  });

  it("asks a person before writing when the step says so, and writes what they corrected", async () => {
    const run = await platform.engine.start(companyId, "announcer", {}, { wait: true });
    expect(run.status).toBe("waiting_approval");
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    expect(approval).toMatchObject({ title: "Write to #general", action: { type: "chat.send", to: "#general", text: "Holiday on Friday." } });
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Selin", edits: { text: "Holiday on Monday." } }, { wait: true });
    const done = await platform.engine.getRow(companyId, run.id);
    expect(done.status).toBe("succeeded");
    const result = (done.context as { steps: { announce: { conversationId: string; seq: number; approvedBy: string } } }).steps.announce;
    expect(result.approvedBy).toBe("Selin");
    expect((await platform.conversations.messageAt(companyId, result.conversationId, result.seq))?.text).toBe("Holiday on Monday.");
  });
});

describe("waiting for another system", () => {
  const tokenOf = (run: { context: unknown }) => {
    const url = (run.context as { steps: { hand: { url: string } } }).steps.hand.url;
    expect(url).toMatch(/^\/api\/hooks\/callback\/[\w-]{20,}$/);
    return url.split("/").at(-1)!;
  };

  it("gives the run an address, waits, and continues with what the other system sends", async () => {
    const run = await platform.engine.start(companyId, "waiter", {}, { wait: true });
    expect(run.status).toBe("waiting");
    const task = await platform.tasks.byId(run.taskId!);
    expect(task).toMatchObject({ status: "waiting", waitingFor: { kind: "callback", stepKey: "wait_call" } });

    await expect(platform.engine.receiveCallback("not-a-token", {})).rejects.toThrow(/Nothing waits/);
    expect(await platform.engine.receiveCallback(tokenOf(run), { status: "approved" })).toEqual({ outcome: "continued", runId: run.id });
    const done = await platform.engine.waitForSettled(companyId, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ received: true, status: "approved" });
    expect((await platform.engine.stepsOf(companyId, run.id)).find((s) => s.key === "wait_call")).toMatchObject({
      status: "succeeded",
      output: { received: true, payload: { status: "approved" } },
    });
    // The work is over: later calls are refused.
    await expect(platform.engine.receiveCallback(tokenOf(run), { status: "again" })).rejects.toThrow(/over/);
  });

  it("keeps a call that comes before the run gets to its wait, and ends the wait when its time runs out", async () => {
    const early = await platform.engine.start(companyId, "waiter", { ask: true }, { wait: true });
    expect(early.status).toBe("waiting_approval");
    expect(await platform.engine.receiveCallback(tokenOf(early), { status: "early" })).toEqual({ outcome: "kept", runId: early.id });
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === early.id);
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Selin" }, { wait: true });
    const took = await platform.engine.getRow(companyId, early.id);
    expect(took.status).toBe("succeeded");
    expect(took.output).toEqual({ received: true, status: "early" });

    const late = await platform.engine.start(companyId, "waiter", {}, { wait: true });
    expect(late.status).toBe("waiting");
    await platform.engine.wakeDueTasks(new Date(Date.now() + 3 * 86_400_000));
    const over = await platform.engine.waitForSettled(companyId, late.id);
    expect(over.status).toBe("succeeded");
    expect((over.context as { steps: { wait_call: unknown } }).steps.wait_call).toEqual({ received: false, timedOut: true });
  });
});

describe("giving work to a colleague", () => {
  it("gives the colleague a task, waits, and continues with its answer when the task is done", async () => {
    const run = await platform.engine.start(companyId, "asker", { order: "SO-11" }, { wait: true });
    expect(run.status).toBe("waiting");
    const task = await platform.tasks.byId(run.taskId!);
    const wait = task!.waitingFor as { kind: string; taskId: string };
    expect(wait.kind).toBe("colleague");
    const given = await platform.tasks.byId(wait.taskId);
    expect(given).toMatchObject({ source: "colleague", sourceRef: task!.id, requestedBy: "Asker", title: "Check the ERP connection for order SO-11" });

    await until(async () => (await platform.engine.getRow(companyId, run.id)).status === "succeeded");
    const done = await platform.engine.getRow(companyId, run.id);
    expect(done.output).toEqual({ answer: "Looked into it; the ERP connection needs IT.", done: true });
    expect((await platform.tasks.byId(given!.id))?.status).toBe("done");
  });

  it("runs the colleague as a test run in a test run, and never gives work to itself", async () => {
    const test = await platform.engine.start(companyId, "asker", { order: "SO-12" }, { isTest: true, wait: true });
    expect(test.status).toBe("succeeded");
    expect((test.context as { steps: { ask: unknown } }).steps.ask).toMatchObject({ done: true, test: true, colleague: "Fixer" });

    const selfish = await platform.engine.start(companyId, "selfish", {}, { wait: true });
    expect(selfish.status).toBe("failed");
    expect(selfish.error).toMatch(/can't give work to itself/);
  });
});
