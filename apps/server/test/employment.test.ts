import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * AI employees' employment over the API: each reports to a manager, who sets its probation level,
 * limits and monthly budget; workers see it but can't change it; hiring gives new ones a manager.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("AI employees' managers, levels and budgets", () => {
  let t: TestApp;
  let financeAgent: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const detail = async (cookie: string, slug = financeAgent) => (await t.app.inject({ url: `/api/companies/acme/agents/${slug}`, headers: { cookie } })).json();
  const setEmployment = (cookie: string, payload: Record<string, unknown>, slug = financeAgent) =>
    t.app.inject({ method: "PUT", url: `/api/companies/acme/agents/${slug}/employment`, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    const companyId = (await t.platform.company("acme"))!.id;
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    financeAgent = (await t.platform.agents.list(companyId)).find((a) => a.row.departmentId === finance.id && a.row.templateId === "finance.invoice-processor")!.row.slug;
  });
  afterAll(() => t?.close());

  it("gives every demo AI employee its department's manager", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const view = await detail(burak);
    expect(view.employment).toMatchObject({ manager: { name: "Burak Şahin" }, probation: "supervised", monthlyBudgetUsd: null, stoppedByBudget: false });
    expect(view.employment.duties.map((d: { text: string }) => d.text)).toContain("Reads every email sent to invoices@acme.com.tr with an attachment");
    expect(view.canManage).toBe(true);
    expect(view.managerCandidates.map((p: { name: string }) => p.name).sort()).toEqual(["Burak Şahin", "Mehmet Öz"]);
  });

  it("lets the manager set the level, limits and budget, and records it", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const saved = await setEmployment(burak, { probation: "trusted", limits: { maxAmount: 10000, currency: "try", maxActionsPerDay: 50 }, monthlyBudgetUsd: 40 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().employment).toMatchObject({ probation: "trusted", limits: { maxAmount: 10000, currency: "TRY", maxActionsPerDay: 50 }, monthlyBudgetUsd: 40 });
    const activity = (await t.app.inject({ url: "/api/companies/acme/activity", headers: { cookie: await as("mehmet.oz@acme.com.tr") } })).json() as { action: string; actor: string; summary: string }[];
    expect(activity.find((a) => a.action === "agent.employment")).toMatchObject({ actor: "Burak Şahin <burak.sahin@acme.com.tr>", summary: expect.stringMatching(/level: Trusted.*monthly budget: \$40.*limits/) });
  });

  it("keeps workers and other departments' managers out", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await detail(elif)).canManage).toBe(false);
    expect((await detail(elif)).managerCandidates).toEqual([]);
    expect((await setEmployment(elif, { probation: "trusted" })).statusCode).toBe(403);
    expect((await setEmployment(await as("ayse.yilmaz@acme.com.tr"), { probation: "trusted" })).statusCode).toBe(404);
  });

  it("accepts only a manager of its department, or an admin, as its manager", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const people = (await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie: await as("mehmet.oz@acme.com.tr") } })).json() as { id: string; name: string }[];
    const id = (name: string) => people.find((p) => p.name === name)!.id;
    const ayse = await setEmployment(burak, { managerUserId: id("Ayşe Yılmaz") });
    expect(ayse.statusCode).toBe(400);
    expect(ayse.json().error).toMatch(/doesn't manage this AI employee's department/);
    const mehmet = await setEmployment(burak, { managerUserId: id("Mehmet Öz") });
    expect(mehmet.statusCode, mehmet.body).toBe(200);
    expect(mehmet.json().employment.manager.name).toBe("Mehmet Öz");
  });

  it("makes the person who hires an AI employee its manager when they run that department", async () => {
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const companyId = (await t.platform.company("acme"))!.id;
    const hr = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "hr")!;
    // A second HR manager hires; the first one (alphabetically) would be the default.
    const added = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/people",
      headers: { cookie: mehmet },
      payload: { name: "Zafer Tan", email: "zafer.tan@acme.com.tr", password: "hire-them-all", departments: [{ departmentId: hr.id, role: "manager" }] },
    });
    expect(added.statusCode, added.body).toBe(200);
    const zafer = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "zafer.tan@acme.com.tr", password: "hire-them-all" } }));
    const scheduler = (await t.platform.agents.list(companyId)).find((a) => a.row.templateId === "hr.interview-scheduler")!;
    await t.platform.agents.remove(companyId, scheduler.row.id);
    const hired = await t.app.inject({ method: "POST", url: "/api/companies/acme/catalog/agents/hr.interview-scheduler/install", headers: { cookie: zafer }, payload: {} });
    expect(hired.statusCode, hired.body).toBe(200);
    expect((await detail(zafer, hired.json().slug)).employment.manager.name).toBe("Zafer Tan");

    // A department without managers: the admin who hires is accountable.
    const legal = await t.app.inject({ method: "POST", url: "/api/companies/acme/catalog/agents/legal.nda-assistant/install", headers: { cookie: mehmet }, payload: {} });
    expect((await detail(mehmet, legal.json().slug)).employment.manager.name).toBe("Mehmet Öz");
  });

  it("keeps the Studio (Hire) for managers", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await t.app.inject({ url: "/api/companies/acme/builder/sessions", headers: { cookie: elif } })).statusCode).toBe(403);
    const started = await t.app.inject({ method: "POST", url: "/api/companies/acme/builder/sessions", headers: { cookie: elif }, payload: { description: "Screen CVs" } });
    expect(started.statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/companies/acme/builder/sessions", headers: { cookie: await as("ayse.yilmaz@acme.com.tr") } })).statusCode).toBe(200);
  });
});
