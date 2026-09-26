import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScreenJob, ScreenOperator, ScreenOutcome } from "@enterprise-brain/connectors";
import { LocalHashEmbedder, ScriptedLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * AI employees working an old system through its screens: its actions are like any other connection's
 * (reads alone, changes approved as their probation level says, nothing changed in a test run), and what
 * working the screens cost counts in the run's cost, whether the job worked or not.
 */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

class FakeScreens implements ScreenOperator {
  readonly jobs: ScreenJob[] = [];
  statuses = new Map([["PO-4711", "Open"]]);
  async operate(job: ScreenJob): Promise<ScreenOutcome> {
    this.jobs.push(job);
    const usage = { calls: 4, inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 };
    const order = /“(PO-\d+)”/.exec(job.goal)?.[1] ?? "";
    const status = this.statuses.get(order);
    const base = { steps: 6, trail: [`Opened ${job.startUrl}`], lastScreen: PNG, usage };
    if (!status) return { ...base, done: false, summary: `There is no order ${order}.`, result: {} };
    if (!job.readOnly) {
      const next = /status to “([^”]+)”/.exec(job.goal)?.[1] ?? status;
      this.statuses.set(order, next);
      return { ...base, done: true, summary: `${order} is now ${next}.`, result: {} };
    }
    return { ...base, done: true, summary: `${order} is ${status}.`, result: { status } };
  }
  async check() {
    return { ok: true, message: "Opened." };
  }
}

let platform: Platform;
let companyId: string;
let connectionId: string;
const screens = new FakeScreens();

beforeAll(async () => {
  const llm = new ScriptedLlm({
    "runtime.agent:order-desk": {
      tools: (_request, turn) =>
        turn === 1 ? { calls: [{ name: "orders__look_up_order", input: { order_number: "PO-4711" } }] } : { text: "PO-4711 is open." },
    },
  });
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-screens-")),
    inMemory: true,
    llm,
    embedder: new LocalHashEmbedder(),
    screens,
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  const connection = await platform.connectors.create(companyId, {
    type: "screen",
    name: "Order system",
    values: { start_url: "https://orders.acme.local/login", system_name: "Order system", username: "robot", password: "s3cret" },
  });
  connectionId = connection.id;
  await platform.connectors.setActions(companyId, connectionId, [
    {
      id: "look_up_order",
      name: "Look up an order",
      kind: "read",
      goal: "Find order {order_number} and read its status.",
      params: [{ key: "order_number", required: true }],
      returns: [{ key: "status" }],
    },
    {
      id: "set_status",
      name: "Set an order's status",
      kind: "write",
      goal: "Open order {order_number} and set its status to {status}.",
      params: [
        { key: "order_number", required: true },
        { key: "status", required: true },
      ],
    },
  ]);
  const connectors = [{ ref: "orders", category: "other" as const, instanceId: connectionId }];
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "order-clerk",
      name: "Order Clerk",
      summary: "Marks orders delivered.",
      archetype: "process-automation",
      instructions: "Keep orders up to date.",
      inputs: [{ key: "order", type: "string", required: true }],
      connectors,
      workflow: [
        { id: "lookup", type: "connector", connector: "orders", operation: "look_up_order", input: { order_number: "{{ input.order }}" } },
        { id: "deliver", type: "connector", connector: "orders", operation: "set_status", input: { order_number: "{{ input.order }}", status: "Delivered" } },
      ],
    },
  });
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "order-desk",
      name: "Order Desk",
      summary: "Answers questions about orders.",
      archetype: "conversational",
      instructions: "Answer questions about orders.",
      connectors,
      tools: ["connector:orders.look_up_order"],
      workflow: [{ id: "answer", type: "agent", task: "Where is PO-4711?" }],
    },
  });
});
afterAll(async () => {
  await platform?.close();
});

describe("AI employees on an old system's screens", () => {
  it("checks the actions IT writes for screens", async () => {
    await expect(platform.connectors.setActions(companyId, connectionId, [{ id: "x", name: "X", kind: "read", method: "GET", path: "/x" }])).rejects.toThrow(
      /say what to do on the screens/,
    );
    await expect(
      platform.connectors.setActions(companyId, connectionId, [{ id: "x", name: "X", kind: "read", goal: "Read it", returns: [{ key: "summary" }] }]),
    ).rejects.toThrow(/"summary" is taken/);
  });

  it("reads alone, asks before changing, and counts what working the screens cost", async () => {
    const run = await platform.engine.start(companyId, "order-clerk", { order: "PO-4711" });
    expect(run.status).toBe("waiting_approval");
    expect(screens.jobs.map((j) => [j.action, j.readOnly])).toEqual([["Look up an order", true]]);
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    expect(approval).toMatchObject({ title: "Set an order's status in Order system" });
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Burak" });
    expect(screens.statuses.get("PO-4711")).toBe("Delivered");
    const row = await platform.engine.getRow(companyId, run.id);
    expect(row.status).toBe("succeeded");
    const state = row.context as { steps: Record<string, Record<string, unknown>> };
    expect(state.steps.lookup).toMatchObject({
      status: "Open",
      summary: "PO-4711 is Open.",
      screens: { steps: 6, trail: ["Opened https://orders.acme.local/login"] },
    });
    const fileId = (state.steps.lookup!.screens as { lastScreenFileId: string }).lastScreenFileId;
    expect((await platform.files.get(companyId, fileId)).mimeType).toBe("image/png");
    // Two jobs on the screens: the look-up in its step, the change when it was approved.
    expect((row.usage as { costUsd: number }).costUsd).toBeCloseTo(0.1);
  });

  it("changes nothing in a test run", async () => {
    screens.statuses.set("PO-4711", "Open");
    const before = screens.jobs.length;
    const run = await platform.engine.start(companyId, "order-clerk", { order: "PO-4711" }, { wait: true, isTest: true });
    expect(run.status).toBe("succeeded");
    expect(screens.jobs.slice(before).map((j) => j.readOnly)).toEqual([true]);
    expect(screens.statuses.get("PO-4711")).toBe("Open");
  });

  it("fails a step the screens don't allow, and still counts its cost", async () => {
    const run = await platform.engine.start(companyId, "order-clerk", { order: "PO-9999" }, { wait: true });
    expect(run.status).toBe("failed");
    const row = await platform.engine.getRow(companyId, run.id);
    expect(row.error).toContain("Order system: There is no order PO-9999.");
    expect((row.usage as { costUsd: number }).costUsd).toBeCloseTo(0.05);
  });

  it("counts a tool's screen work in an AI employee's own reasoning step", async () => {
    const run = await platform.engine.start(companyId, "order-desk", {}, { wait: true });
    expect(run.status).toBe("succeeded");
    const row = await platform.engine.getRow(companyId, run.id);
    expect((row.usage as { costUsd: number }).costUsd).toBeCloseTo(0.05);
    expect(screens.jobs.at(-1)).toMatchObject({ action: "Look up an order", readOnly: true, goal: "Find order “PO-4711” and read its status." });
  });
});
