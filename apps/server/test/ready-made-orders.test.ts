import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunRow } from "@enterprise-brain/runtime";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The ready-made Order Intake and Order Follow-up, as a demo installation puts them to work: the web shop
 * gets its answer in the same call, a big order waits for the finance manager and a declined one is left
 * unpriced, the finance team hears of each order in Chat, and the follow-up gives the order to Order
 * Intake, then waits for the shop's call with the delivery date. People try procedures by hand with them.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const LINES = [
  { sku: "A-1", qty: 4, price: 300 },
  { sku: "B-2", qty: 2, price: 600 },
  { sku: "A-1", qty: 1, price: 50 },
];

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

type Posted = { conversationId: string; seq: number };

describe("ready-made order AI employees", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    // As the server does when it starts: #general and a channel per department, #finance among them.
    await t.platform.syncChannels(t.companyId, { force: true });
  });
  afterAll(() => t?.close());

  const hook = async (body: Record<string, unknown>) => {
    const agent = await t.platform.agents.get(t.companyId, "finance-order-intake");
    const endpoint = await t.platform.endpoints.ensure(t.companyId, agent.row.id, "webhook");
    return t.app.inject({
      method: "POST",
      url: `/api/hooks/t/${endpoint.token}`,
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  };
  const stepsOf = (run: RunRow) => (run.context as { steps: Record<string, unknown> }).steps;
  const textOf = async (posted: unknown) => {
    const { conversationId, seq } = posted as Posted;
    return (await t.platform.conversations.messageAt(t.companyId, conversationId, seq))?.text;
  };
  const latestRun = async (slug: string) => {
    const agent = await t.platform.agents.get(t.companyId, slug);
    const [run] = await t.platform.engine.list(t.companyId, { agentId: agent.row.id, limit: 1 });
    return t.platform.engine.getRow(t.companyId, run!.id);
  };
  const decide = async (runId: string, approved: boolean) => {
    const [approval] = (await t.platform.engine.listApprovals(t.companyId, { status: "pending" })).filter((a) => a.runId === runId);
    expect(approval).toBeDefined();
    await t.platform.engine.decide(t.companyId, approval!.id, { approved, decidedBy: "Burak Şahin" }, { wait: true });
    return approval!;
  };

  it("are at work in Finance on a demo installation", async () => {
    const finance = (await t.platform.catalog.departments(t.companyId)).find((d) => d.key === "finance")!;
    for (const slug of ["finance-order-intake", "finance-order-follow-up"]) {
      const agent = await t.platform.agents.get(t.companyId, slug);
      expect(agent.row).toMatchObject({ status: "active", departmentId: finance.id, source: "template" });
    }
  });

  it("answers the web shop in the same call and tells the finance team", async () => {
    const answered = await hook({ order: "SO-1001", customer: "Akın Metal", total: 2450, lines: LINES });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({
      order: "SO-1001",
      accepted: true,
      lines: [
        { sku: "A-1", amount: 1250 },
        { sku: "B-2", amount: 1200 },
      ],
      total: 2450,
    });
    const run = await until(
      () => latestRun("finance-order-intake"),
      (r) => r.status === "succeeded",
      "the order to finish",
    );
    expect(run.output).toMatchObject({ order: "SO-1001", accepted: true, order_total: 2450, summary: "Order SO-1001 accepted: 2,450.00 for A-1, B-2." });
    expect(await textOf(stepsOf(run).tell)).toBe("Order SO-1001 from Akın Metal: 2,450.00 for A-1, B-2.");
    // Each line was priced in its own round of the loop.
    const steps = await t.platform.engine.stepsOf(t.companyId, run.id);
    expect(steps.filter((s) => s.stepId === "price").map((s) => s.key)).toEqual(["price_lines#0/price", "price_lines#1/price", "price_lines#2/price"]);
  });

  it("waits for the finance manager on a big order, and leaves a declined one unpriced", async () => {
    const waiting = await hook({ order: "SO-2001", customer: "Petrokim", total: 15000, lines: [{ sku: "C-3", qty: 10, price: 1500 }] });
    expect(waiting.statusCode, waiting.body).toBe(202);
    expect(waiting.json()).toMatchObject({ ok: true, status: "waiting_approval", taskRef: expect.stringMatching(/^EB-/) });
    const approval = await decide(waiting.json().runId, true);
    expect(approval.title).toBe("Accept order SO-2001 of 15,000.00 from Petrokim?");
    const approved = await t.platform.engine.getRow(t.companyId, waiting.json().runId);
    expect(approved.status).toBe("succeeded");
    expect(approved.output).toMatchObject({ accepted: true, order_total: 15000, summary: "Order SO-2001 accepted: 15,000.00 for C-3." });

    const declined = await hook({ order: "SO-2002", customer: "Petrokim", total: 20000, lines: [{ sku: "C-3", qty: 10, price: 2000 }] });
    expect(declined.statusCode, declined.body).toBe(202);
    await decide(declined.json().runId, false);
    const done = await t.platform.engine.getRow(t.companyId, declined.json().runId);
    expect(done.status).toBe("succeeded");
    expect(done.output).toMatchObject({ accepted: false, summary: "Order SO-2002 declined by the finance manager." });
    const statuses = Object.fromEntries((await t.platform.engine.stepsOf(t.companyId, done.id)).map((s) => [s.key, s.status]));
    expect(statuses).toMatchObject({ price_lines: "skipped", totals: "skipped", answer: "succeeded", tell: "succeeded" });
    expect(await textOf(stepsOf(done).tell)).toBe("Order SO-2002 from Petrokim: declined by the finance manager.");
  });

  it("follows an order up: Order Intake takes it, then the shop's call gives the delivery date", async () => {
    const burak = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "burak.sahin@acme.com.tr" } }));
    const started = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/agents/finance-order-follow-up/runs",
      headers: { cookie: burak },
      payload: { input: { order: "SO-3001", customer: "Akın Metal", total: 900, lines: [{ sku: "A-1", qty: 3, price: 300 }] } },
    });
    expect(started.statusCode, started.body).toBe(200);
    const runId = started.json().id as string;

    // It gives the order to Order Intake, which finishes it alone, then asks the shop and waits for its call.
    const waiting = await until(
      () => t.platform.engine.getRow(t.companyId, runId),
      (r) => r.status === "waiting" && Boolean(stepsOf(r).ask_shop),
      "the follow-up to wait for the shop",
    );
    const given = await t.platform.tasks.byId((await latestRun("finance-order-intake")).taskId!);
    expect(given).toMatchObject({ source: "colleague", requestedBy: "Order Follow-up", status: "done" });
    const asked = await textOf(stepsOf(waiting).ask_shop);
    expect(asked).toContain("Order SO-3001 accepted: 900.00 for A-1. Web shop: send the delivery date");
    const address = asked!.match(/https?:\/\/\S+\/api\/hooks\/callback\/[\w-]+/)?.[0];
    expect(address).toBeDefined();

    const called = await t.app.inject({
      method: "POST",
      url: new URL(address!).pathname,
      payload: JSON.stringify({ date: "2026-10-20" }),
      headers: { "content-type": "application/json" },
    });
    expect(called.statusCode, called.body).toBe(200);
    expect(called.json()).toEqual({ ok: true, outcome: "continued" });
    const done = await until(
      () => t.platform.engine.getRow(t.companyId, runId),
      (r) => r.status === "succeeded",
      "the follow-up to finish",
    );
    expect(done.output).toEqual({
      order: "SO-3001",
      intake: "Order SO-3001 accepted: 900.00 for A-1.",
      delivery: "2026-10-20",
      summary: "Order SO-3001 accepted: 900.00 for A-1. Delivery: 2026-10-20.",
    });
    // The work is over: the address answers no more.
    const again = await t.app.inject({ method: "POST", url: new URL(address!).pathname, payload: "{}", headers: { "content-type": "application/json" } });
    expect(again.statusCode).toBe(410);
  });

  it("tries the follow-up without sending anything or waiting", async () => {
    const tried = await t.platform.engine.start(
      t.companyId,
      "finance-order-follow-up",
      { order: "SO-4001", total: 900, lines: [{ sku: "A-1", qty: 3, price: 300 }] },
      { isTest: true, wait: true },
    );
    expect(tried.status, tried.error ?? "").toBe("succeeded");
    const steps = stepsOf(tried);
    expect(steps.intake).toMatchObject({ done: true, test: true, colleague: "Order Intake", answer: "Order SO-4001 accepted: 900.00 for A-1." });
    expect(steps.ask_shop).toMatchObject({ dryRun: true });
    expect(steps.delivery).toEqual({ received: false, skipped: true });
    expect(tried.output).toMatchObject({ delivery: "not confirmed" });
  });
});
