import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Runs as executions: a filtered list in pages, insights over a period, each step's input and output on
 * the run's page, running again from a step and pinning a run as an example (a manager's), and the
 * minutes a task takes a person, which turn finished tasks into time saved.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("executions", () => {
  let t: TestApp;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const get = (cookie: string, url: string) => t.app.inject({ url, headers: { cookie } });
  const send = (cookie: string, method: "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(company.id, {
      definition: {
        slug: "totaler",
        name: "Totaler",
        summary: "Totals an order.",
        archetype: "process-automation",
        instructions: "Total the order.",
        inputs: [{ key: "lines", type: "list", itemType: "object", required: true }],
        workflow: [
          { id: "total", type: "transform", from: "{{ input.lines }}", ops: [{ op: "aggregate", values: { sum: { fn: "sum", field: "amount" } } }] },
          { id: "result", type: "output", value: { total: "{{ steps.total.first.sum }}" } },
        ],
      },
      status: "active",
      departmentId: finance.id,
    });
  });
  afterAll(() => t?.close());

  it("lists runs in pages with filters, and sums up a period", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    for (const amount of [10, 20, 30]) {
      const started = await send(burak, "POST", "/api/companies/acme/agents/totaler/runs", { input: { lines: [{ amount }, { amount: 1 }] } });
      expect(started.statusCode, started.body).toBe(200);
    }
    await send(burak, "POST", "/api/companies/acme/agents/totaler/runs", { input: { lines: [{ amount: 5 }] }, test: true });

    const first = (await get(burak, "/api/companies/acme/runs/page?agent=totaler&test=false&limit=2")).json();
    expect(first.runs).toHaveLength(2);
    expect(first.next).toEqual(expect.any(String));
    const second = (await get(burak, `/api/companies/acme/runs/page?agent=totaler&test=false&limit=2&cursor=${first.next}`)).json();
    expect(second.runs).toHaveLength(1);
    expect(second.next).toBeNull();
    const all = [...first.runs, ...second.runs] as { id: string; output: { total: number } }[];
    expect(new Set(all.map((r) => r.id)).size).toBe(3);
    expect(all.map((r) => r.output.total).sort()).toEqual([11, 21, 31]);
    expect((await get(burak, "/api/companies/acme/runs/page?agent=totaler&test=true")).json().runs).toHaveLength(1);
    expect((await get(burak, "/api/companies/acme/runs/page?agent=totaler&status=failed")).json().runs).toHaveLength(0);
    // The older list keeps its shape: an array.
    expect(Array.isArray((await get(burak, "/api/companies/acme/runs?agent=totaler")).json())).toBe(true);

    const insights = (await get(burak, "/api/companies/acme/runs/insights?agent=totaler")).json();
    expect(insights).toMatchObject({ runs: 3, succeeded: 3, failed: 0, testRuns: 1, tasksFinished: 3, finishedAlone: 3, minutesSaved: null });
    expect(insights.perDay.length).toBeGreaterThanOrEqual(7);
    expect(insights.perDay.reduce((sum: number, d: { succeeded: number }) => sum + d.succeeded, 0)).toBe(3);

    // The manager says a task takes a person 15 minutes: finished tasks become time saved.
    expect((await send(burak, "PUT", "/api/companies/acme/agents/totaler/settings", { minutesPerTask: 15 })).statusCode).toBe(200);
    expect((await get(burak, "/api/companies/acme/runs/insights?agent=totaler")).json().minutesSaved).toBe(45);
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await send(elif, "PUT", "/api/companies/acme/agents/totaler/settings", { minutesPerTask: 99 })).statusCode).toBe(403);
  });

  it("shows each step's input and output, runs again from a step and pins a run as an example (managers)", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const elif = await as("elif.arslan@acme.com.tr");
    const [run] = (await get(burak, "/api/companies/acme/runs/page?agent=totaler&test=false&limit=1")).json().runs as { id: string }[];
    const detail = (await get(burak, `/api/companies/acme/runs/${run!.id}`)).json();
    expect(detail).toMatchObject({ canManage: true, rerunFrom: ["total", "result"] });
    expect(detail.steps.map((s: { key: string; status: string }) => [s.key, s.status])).toEqual([
      ["total", "succeeded"],
      ["result", "succeeded"],
    ]);
    expect(detail.steps[0].input).toEqual({ from: [{ amount: 30 }, { amount: 1 }] });
    expect((await get(elif, `/api/companies/acme/runs/${run!.id}`)).json().canManage).toBe(false);

    expect((await send(elif, "POST", `/api/companies/acme/runs/${run!.id}/rerun`, { fromKey: "result" })).statusCode).toBe(403);
    const again = await send(burak, "POST", `/api/companies/acme/runs/${run!.id}/rerun`, { fromKey: "result", wait: true });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ status: "succeeded", trigger: "rerun", triggerRef: run!.id, output: { total: 31 } });

    expect((await send(elif, "POST", "/api/companies/acme/agents/totaler/examples", { name: "Big order", runId: run!.id })).statusCode).toBe(403);
    const pinned = await send(burak, "POST", "/api/companies/acme/agents/totaler/examples", { name: "Big order", runId: run!.id });
    expect(pinned.statusCode, pinned.body).toBe(200);
    const example = pinned.json().example as { id: string; input: unknown };
    expect(example.input).toEqual({ lines: [{ amount: 30 }, { amount: 1 }] });
    const agent = (await get(burak, "/api/companies/acme/agents/totaler")).json();
    expect(agent.settings).toMatchObject({ minutesPerTask: 15, examples: [{ id: example.id, name: "Big order", createdBy: "Burak Şahin" }] });
    expect((await send(burak, "DELETE", `/api/companies/acme/agents/totaler/examples/${example.id}`)).statusCode).toBe(200);
    expect((await get(burak, "/api/companies/acme/agents/totaler")).json().settings.examples).toEqual([]);
  });
});
