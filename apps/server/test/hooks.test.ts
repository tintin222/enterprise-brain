import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signWebhookPayload } from "@enterprise-brain/connectors";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { allowCall } from "../src/routes/hooks.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Addresses other systems call without signing in, answering while the gate of a demo installation is
 * locked: a run's callback address takes JSON, a form or text and refuses an address nothing waits at;
 * an AI employee's webhook takes its unguessable address alone, its readable one with its secret, a
 * signature when its duty says, and answers a waiting caller with what a respond step says.
 */

const GATED = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [], gate: { user: "admin", password: "KahveKeyfi+5" } } };

describe("callback addresses", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ config: GATED });
    await t.platform.agents.create(t.companyId, {
      definition: {
        slug: "status-waiter",
        name: "Status Waiter",
        summary: "Waits for the shipping system to call back.",
        archetype: "process-automation",
        instructions: "Wait for the shipping system.",
        workflow: [
          { id: "hand", type: "output", value: { url: "{{ run.callbackUrl }}" } },
          { id: "wait_call", type: "wait", for: "callback" },
          { id: "result", type: "output", value: { got: "{{ steps.wait_call.payload }}" } },
        ],
      },
      status: "active",
    });
  });
  afterAll(() => t?.close());

  const waiting = async () => {
    const run = await t.platform.engine.start(t.companyId, "status-waiter", {}, { wait: true });
    expect(run.status).toBe("waiting");
    const url = (run.context as { steps: { hand: { url: string } } }).steps.hand.url;
    expect(url.startsWith("http://brain.test/api/hooks/callback/")).toBe(true);
    return { run, path: new URL(url).pathname };
  };

  it("continues the run with a JSON body, a form or text, without a session", async () => {
    const bodies = [
      { headers: { "content-type": "application/json" }, payload: JSON.stringify({ status: "shipped" }), got: { status: "shipped" } },
      { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "status=shipped&box=2", got: { status: "shipped", box: "2" } },
      { headers: { "content-type": "text/plain" }, payload: "shipped", got: "shipped" },
    ];
    for (const body of bodies) {
      const { run, path } = await waiting();
      const called = await t.app.inject({ method: "POST", url: path, headers: body.headers, payload: body.payload });
      expect(called.statusCode, called.body).toBe(200);
      expect(called.json()).toEqual({ ok: true, outcome: "continued" });
      const done = await t.platform.engine.waitForSettled(t.companyId, run.id);
      expect(done.output).toEqual({ got: body.got });
    }
  });

  it("refuses an address nothing waits at, a body that is not JSON, and a call after the work is over", async () => {
    expect((await t.app.inject({ method: "POST", url: "/api/hooks/callback/unknown", payload: {} })).statusCode).toBe(404);
    const { run, path } = await waiting();
    const broken = await t.app.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(broken.statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: path, payload: { status: "done" } })).statusCode).toBe(200);
    await t.platform.engine.waitForSettled(t.companyId, run.id);
    expect((await t.app.inject({ method: "POST", url: path, payload: { status: "again" } })).statusCode).toBe(410);
  });
});

describe("an AI employee's webhook", () => {
  let t: TestApp;
  const webhookAgent = (slug: string, duty: Record<string, unknown>, workflow: AgentDefinitionInput["workflow"]): AgentDefinitionInput => ({
    slug,
    name: slug,
    summary: "Called by another system.",
    archetype: "process-automation",
    instructions: "Take the order.",
    triggers: [{ type: "webhook", ...duty } as never],
    workflow,
  });

  beforeAll(async () => {
    t = await createTestApp({ config: GATED });
    const take = [{ id: "result", type: "output" as const, value: { got: "{{ input.order }}" } }];
    await t.platform.agents.create(t.companyId, { definition: webhookAgent("intake", {}, take), status: "active" });
    await t.platform.agents.create(t.companyId, { definition: webhookAgent("signed", { auth: "hmac" }, take), status: "active" });
    await t.platform.agents.create(t.companyId, { definition: webhookAgent("resting", {}, take), status: "testing" });
    await t.platform.agents.create(t.companyId, {
      definition: { ...webhookAgent("no-duty", {}, take), triggers: [{ type: "manual" }] },
      status: "active",
    });
    await t.platform.agents.create(t.companyId, {
      definition: webhookAgent("answering", { respond: true, waitSeconds: 5 }, [
        { id: "answer", type: "respond", status: 201, headers: { "X-Order": "{{ input.order }}" }, body: { order: "{{ input.order }}", ok: true } },
        ...take,
      ]),
      status: "active",
    });
    await t.platform.agents.create(t.companyId, {
      definition: webhookAgent("asks-first", { respond: true, waitSeconds: 2 }, [{ id: "check", type: "approval", title: "Take {{ input.order }}?" }, ...take]),
      status: "active",
    });
  });
  afterAll(() => t?.close());

  const endpointOf = async (slug: string) => {
    const agent = await t.platform.agents.get(t.companyId, slug);
    return t.platform.endpoints.ensure(t.companyId, agent.row.id, "webhook");
  };
  const call = (url: string, body: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...headers } });

  it("takes the unguessable address alone, and the readable one with its secret", async () => {
    const endpoint = await endpointOf("intake");
    const taken = await call(`/api/hooks/t/${endpoint.token}`, JSON.stringify({ order: "SO-1" }));
    expect(taken.statusCode, taken.body).toBe(202);
    const { runId, taskRef } = taken.json();
    expect(taskRef).toMatch(/^EB-/);
    const run = await t.platform.engine.waitForSettled(t.companyId, runId);
    expect(run).toMatchObject({ status: "succeeded", trigger: "webhook", triggerRef: endpoint.id, output: { got: "SO-1" } });

    expect((await call("/api/hooks/acme/intake", "{}")).statusCode).toBe(401);
    const { secret } = await t.platform.endpoints.newSecret(endpoint.id);
    expect((await call("/api/hooks/acme/intake", "{}", { "x-webhook-secret": "wrong" })).statusCode).toBe(401);
    const readable = await call("/api/hooks/acme/intake", JSON.stringify({ order: "SO-2" }), { "x-webhook-secret": secret });
    expect(readable.statusCode, readable.body).toBe(202);
    expect((await t.platform.endpoints.forAgent(endpoint.agentId, "webhook"))?.uses).toBe(2);
    expect((await call("/api/hooks/t/not-a-real-address-at-all", "{}")).statusCode).toBe(404);
  });

  it("asks for a signature when its duty says, and refuses one that is not at work or has no such duty", async () => {
    const signed = await endpointOf("signed");
    const { secret } = await t.platform.endpoints.newSecret(signed.id);
    const body = JSON.stringify({ order: "SO-3" });
    expect((await call(`/api/hooks/t/${signed.token}`, body)).statusCode).toBe(401);
    expect((await call(`/api/hooks/t/${signed.token}`, body, { "x-signature": signWebhookPayload(secret, `${body} `) })).statusCode).toBe(401);
    expect((await call(`/api/hooks/t/${signed.token}`, body, { "x-signature": signWebhookPayload(secret, body) })).statusCode).toBe(202);

    expect((await call(`/api/hooks/t/${(await endpointOf("resting")).token}`, "{}")).statusCode).toBe(409);
    expect((await call(`/api/hooks/t/${(await endpointOf("no-duty")).token}`, "{}")).statusCode).toBe(409);
    const off = await endpointOf("intake");
    await t.platform.endpoints.setStatus(off.id, "off");
    expect((await call(`/api/hooks/t/${off.token}`, "{}")).statusCode).toBe(409);
    await t.platform.endpoints.setStatus(off.id, "on");
  });

  it("answers a waiting caller with what its respond step says, or a receipt when the work waits for a person", async () => {
    const answered = await call(`/api/hooks/t/${(await endpointOf("answering")).token}`, JSON.stringify({ order: "SO-4" }));
    expect(answered.statusCode, answered.body).toBe(201);
    expect(answered.headers["x-order"]).toBe("SO-4");
    expect(answered.json()).toEqual({ order: "SO-4", ok: true });

    const waiting = await call(`/api/hooks/t/${(await endpointOf("asks-first")).token}`, JSON.stringify({ order: "SO-5" }));
    expect(waiting.statusCode, waiting.body).toBe(202);
    expect(waiting.json()).toMatchObject({ ok: true, status: "waiting_approval", taskRef: expect.stringMatching(/^EB-/) });
  });

  it("takes at most so many calls a minute", () => {
    const now = Date.now();
    expect([1, 2, 3].map(() => allowCall("test-key", 2, now))).toEqual([true, true, false]);
    expect(allowCall("test-key", 2, now + 61_000)).toBe(true);
  });
});
