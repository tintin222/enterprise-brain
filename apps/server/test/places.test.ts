import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * What the five places of the app read: Home (what my AI employees did today), Company (departments,
 * with only one's own departments' AI employees), costs for managers, private conversations, and each
 * AI employee's history of coaching notes.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("the places of the app", () => {
  let t: TestApp;
  let companyId: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const get = async (url: string, cookie: string) => t.app.inject({ url: `/api/companies/acme${url}`, headers: { cookie } });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(companyId, {
      definition: {
        slug: "reminder-clerk",
        name: "Reminder Clerk",
        summary: "Reminds customers of overdue invoices.",
        archetype: "process-automation",
        instructions: "Remind customers.",
        inputs: [{ key: "customer", type: "email", required: true }],
        workflow: [{ id: "remind", type: "mail.send", to: "{{ input.customer }}", subject: "Overdue invoice", body: "Please pay invoice INV-9." }],
      },
      status: "active",
      departmentId: finance.id,
    });
    await t.platform.employment.assignDefaultManagers(companyId);
  });
  afterAll(() => t?.close());

  it("shows a worker their department's AI employees on Home, with what they did today", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    await t.platform.engine.start(companyId, "reminder-clerk", { customer: "ap@customer.example" });
    const home = (await get("/home", elif)).json();
    expect(home.person).toMatchObject({ name: "Elif Arslan", departments: ["Finance & Accounting"], isManager: false });
    const clerk = home.aiEmployees.find((a: { slug: string }) => a.slug === "reminder-clerk");
    expect(clerk).toMatchObject({ department: "Finance & Accounting", probation: "supervised", today: { started: 1, needsPerson: 1 } });
    expect(home.aiEmployees.every((a: { department: string | null }) => a.department === "Finance & Accounting")).toBe(true);
    expect(home.aiMailbox).toBeNull();

    const mehmet = await as("mehmet.oz@acme.com.tr");
    const set = await t.app.inject({
      method: "PUT",
      url: "/api/companies/acme/settings",
      headers: { cookie: mehmet },
      payload: { aiMailbox: "AI@acme.com.tr" },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await get("/home", elif)).json().aiMailbox).toBe("ai@acme.com.tr");
  });

  it("lists every department, but only one's own departments' AI employees", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const departments = (await get("/departments", elif)).json() as { key: string; visible: boolean; agents: unknown[] }[];
    const finance = departments.find((d) => d.key === "finance")!;
    const hr = departments.find((d) => d.key === "hr")!;
    expect(finance.visible).toBe(true);
    expect(finance.agents.length).toBeGreaterThan(0);
    expect(hr).toMatchObject({ visible: false, agents: [] });
  });

  it("shows managers the month's costs of the AI employees they run", async () => {
    expect((await get("/costs", await as("elif.arslan@acme.com.tr"))).statusCode).toBe(403);
    const costs = (await get("/costs", await as("burak.sahin@acme.com.tr"))).json();
    expect(costs.month).toMatch(/^\d{4}-\d{2}$/);
    expect(costs.aiEmployees.every((a: { department: string }) => a.department === "Finance & Accounting")).toBe(true);
    expect(costs.aiEmployees.find((a: { slug: string }) => a.slug === "reminder-clerk")).toMatchObject({
      manager: "Burak Şahin",
      monthlyBudgetUsd: null,
      stoppedByBudget: false,
    });
  });

  it("keeps conversations private, and only with one's own AI employees", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const burak = await as("burak.sahin@acme.com.tr");
    const started = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/chat/conversations",
      headers: { cookie: elif },
      payload: { agent: "reminder-clerk" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = started.json().id as string;
    expect((await get("/chat/conversations?agent=reminder-clerk", elif)).json().map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await get("/chat/conversations?agent=reminder-clerk", burak)).json()).toEqual([]);
    expect((await get(`/chat/conversations/${id}/messages`, burak)).statusCode).toBe(404);
    const send = await t.app.inject({
      method: "POST",
      url: `/api/companies/acme/chat/conversations/${id}/messages`,
      headers: { cookie: burak },
      payload: { text: "Hello" },
    });
    expect(send.statusCode).toBe(404);

    const hrAgent = (await t.platform.agents.list(companyId)).find((a) => a.definition.department === "hr")!;
    const withHr = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/chat/conversations",
      headers: { cookie: elif },
      payload: { agent: hrAgent.row.slug },
    });
    expect(withHr.statusCode).toBe(404);
  });

  it("keeps corrections and reasoned rejections as coaching notes on the AI employee", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    await t.platform.engine.start(companyId, "reminder-clerk", { customer: "ar@other.example" });
    const pending = (await t.platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.title.startsWith("Send email"));
    expect(pending.length).toBe(2);
    const [first, second] = pending;
    const decide = (id: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url: `/api/companies/acme/approvals/${id}/decide`, headers: { cookie: elif }, payload });
    expect((await decide(first!.id, { approved: false, note: "We never remind on Fridays" })).statusCode).toBe(200);
    expect((await decide(second!.id, { approved: true, edits: { subject: "Reminder: invoice INV-9" } })).statusCode).toBe(200);

    const detail = (await get("/agents/reminder-clerk", await as("burak.sahin@acme.com.tr"))).json();
    const notes = detail.activity.filter((a: { action: string }) => a.action === "agent.coaching_note").map((a: { summary: string }) => a.summary);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Elif Arslan rejected “Send email to .*”: We never remind on Fridays$/),
        expect.stringMatching(/^Elif Arslan corrected “Send email to .*” before approving \(subject\)$/),
      ]),
    );
  });

  it("offers everyone the demo samples, but not the company's files", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await get("/files", elif)).statusCode).toBe(403);
    const samples = (await get("/files/demo", elif)).json() as { name: string; metadata: { demoSet?: string } }[];
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((f) => typeof f.metadata.demoSet === "string")).toBe(true);
    expect(new Set(samples.map((f) => f.metadata.demoSet))).toEqual(new Set(["cv", "invoice"]));
  });

  it("records the person who paused an AI employee", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const paused = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/agents/reminder-clerk/status",
      headers: { cookie: burak },
      payload: { status: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    const detail = (await get("/agents/reminder-clerk", burak)).json();
    expect(detail.activity[0]).toMatchObject({ action: "agent.paused", actor: "Burak Şahin <burak.sahin@acme.com.tr>" });
  });
});
