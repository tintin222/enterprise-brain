import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, runs, tasks } from "@enterprise-brain/db";
import { monthStartIn, weekStart } from "@enterprise-brain/runtime";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Performance reports over the API: managers see their departments' AI employees against the targets
 * (admins see all), with the weekly trend; everyone who sees an AI employee sees its own measures.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("performance reports over the API", () => {
  let t: TestApp;
  let financeSlug = "";
  // Work closed a minute ago falls in this week and month, unless they began within that minute.
  const closed = () => new Date(Date.now() - 60_000);
  let hrSlug = "";
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const get = async (cookie: string, url: string) => t.app.inject({ url: `/api/companies/acme${url}`, headers: { cookie } });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const agents = await t.platform.agents.list(company.id);
    const finance = agents.find((a) => a.row.templateId === "finance.collections-agent")!;
    const hr = agents.find((a) => a.row.templateId === "hr.cv-screener")!;
    financeSlug = finance.row.slug;
    hrSlug = hr.row.slug;
    const minutesAgo = (h: number) => new Date(Date.now() - h * 60_000);
    // Finance: two tasks finished minutes ago, one with an approval a person decided; HR: one finished alone.
    for (const [agent, asked] of [
      [finance, false],
      [finance, true],
      [hr, false],
    ] as const) {
      const [task] = await t.platform.handle.db
        .insert(tasks)
        .values({
          companyId: company.id,
          agentId: agent.row.id,
          ref: `EB-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
          title: "Work",
          status: "done",
          createdAt: minutesAgo(3),
          closedAt: minutesAgo(1),
        })
        .returning();
      const [run] = await t.platform.handle.db
        .insert(runs)
        .values({ companyId: company.id, agentId: agent.row.id, taskId: task!.id, status: "succeeded", usage: { costUsd: 0.02 }, createdAt: minutesAgo(3) })
        .returning();
      if (asked) {
        await t.platform.handle.db.insert(approvals).values({
          companyId: company.id,
          runId: run!.id,
          agentId: agent.row.id,
          stepId: "send",
          title: "Send the reminder",
          status: "approved",
          decidedBy: "Elif Arslan",
          createdAt: minutesAgo(2.5),
          decidedAt: minutesAgo(2),
        });
      }
    }
  });
  afterAll(() => t?.close());

  it("shows a manager their departments' AI employees against the targets, and admins all", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const response = await get(burak, "/reports/performance");
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json();
    expect(report.period).toMatchObject({ key: "last-4-weeks", label: "Last 4 weeks" });
    expect(report.targets).toMatchObject({ aloneShare: 0.7, medianHandlingHours: 4, correctedShare: 0.05 });
    expect(report.workingHours).toMatchObject({ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });
    expect(report.departments.map((d: { name: string }) => d.name)).toEqual(["Finance & Accounting"]);
    expect(report.total.measures).toMatchObject({ finished: 2, finishedAlone: 1, aloneShare: 0.5, handled: 1, costUsd: 0.04, costPerTaskUsd: 0.02 });
    expect(report.aiEmployees.find((a: { slug: string }) => a.slug === financeSlug).measures).toMatchObject({ finished: 2 });
    expect(report.aiEmployees.some((a: { slug: string }) => a.slug === hrSlug)).toBe(false);
    expect(report.weeks).toHaveLength(8);
    expect(report.weeks.at(-1).measures.finished).toBe(closed() >= weekStart(new Date(), "Europe/Istanbul") ? 2 : 0);
    expect(Array.isArray(report.hiring)).toBe(true);

    const mehmet = await as("mehmet.oz@acme.com.tr");
    const all = (await get(mehmet, "/reports/performance?period=this-month")).json();
    expect(all.period.key).toBe("this-month");
    expect(all.departments.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(["Finance & Accounting", "Human Resources"]));
    expect(all.total.measures.finished).toBe(closed() >= monthStartIn(new Date(), "Europe/Istanbul") ? 3 : 0);
    const onlyHr = (await get(mehmet, "/reports/performance?department=hr")).json();
    expect(onlyHr.departments.map((d: { name: string }) => d.name)).toEqual(["Human Resources"]);
    expect(onlyHr.total.measures).toMatchObject({ finished: 1, finishedAlone: 1, aloneShare: 1 });
  });

  it("keeps the reports to managers, and to their own departments", async () => {
    expect((await get(await as("can.demir@acme.com.tr"), "/reports/performance")).statusCode).toBe(403);
    expect((await get(await as("burak.sahin@acme.com.tr"), "/reports/performance?department=hr")).statusCode).toBe(404);
    expect((await get(await as("burak.sahin@acme.com.tr"), "/reports/performance?period=next-year")).statusCode).toBe(400);
  });

  it("shows an AI employee's own measures to everyone who sees it", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const own = await get(elif, `/agents/${financeSlug}/performance`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ probation: expect.any(String), measures: { finished: 2, handled: 1 }, weeks: expect.any(Array) });
    expect((await get(await as("ayse.yilmaz@acme.com.tr"), `/agents/${financeSlug}/performance`)).statusCode).toBe(404);
  });
});
