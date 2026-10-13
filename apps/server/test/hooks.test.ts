import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Addresses other systems call without signing in: a run's callback address takes JSON, a form or
 * text, answers while the gate of a demo installation is locked, and refuses an address nothing waits at.
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
