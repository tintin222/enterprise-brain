import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The work queue over the API: one list of what needs a person. Each person sees their department's
 * items ("mine": theirs to do), decides and corrects approvals, and answers what is for them.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Entry {
  type: string;
  id: string;
  title: string;
  forMe: boolean;
  canHandle: boolean;
  task: { ref: string } | null;
  assignee: { name: string } | null;
}

describe("the work queue", () => {
  let t: TestApp;
  let companyId: string;
  let taskRef: string;
  let questionId: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const work = async (cookie: string, scope = "mine") => (await t.app.inject({ url: `/api/companies/acme/work?scope=${scope}`, headers: { cookie } })).json() as Entry[];

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(companyId, {
      definition: {
        slug: "dunning-clerk",
        name: "Dunning Clerk",
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
    const run = await t.platform.engine.start(companyId, "dunning-clerk", { customer: "ap@customer.example" });
    const task = await t.platform.tasks.get(companyId, run.taskId!);
    taskRef = task.ref;
    const agent = await t.platform.agents.get(companyId, "dunning-clerk");
    const question = await t.platform.work.create(companyId, {
      kind: "question",
      title: "May I waive the late fee for a first-time delay?",
      taskId: task.id,
      agentId: agent.row.id,
      departmentId: finance.id,
      assigneeUserId: agent.row.managerUserId,
    });
    questionId = question.id;
  });
  afterAll(() => t?.close());

  it("shows each person what is theirs to do", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const mine = await work(elif);
    expect(mine.map((e) => e.type)).toEqual(["approval"]);
    expect(mine[0]).toMatchObject({ title: "Send email to ap@customer.example", forMe: true, canHandle: true, task: { ref: taskRef } });
    // The manager's question is visible to the department, but it is his to answer.
    const all = await work(elif, "all");
    expect(all.find((e) => e.type === "question")).toMatchObject({ forMe: false, canHandle: false, assignee: { name: "Burak Şahin" } });

    const burak = await as("burak.sahin@acme.com.tr");
    expect((await work(burak)).map((e) => e.type).sort()).toEqual(["approval", "question"]);
    expect(await work(await as("ayse.yilmaz@acme.com.tr"), "all")).toEqual([]);
  });

  it("lets a worker correct an email and approve it", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const [approval] = await work(elif);
    const decided = await t.app.inject({
      method: "POST",
      url: `/api/companies/acme/approvals/${approval!.id}/decide`,
      headers: { cookie: elif },
      payload: { approved: true, edits: { body: "Please pay invoice INV-9 by Friday." } },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const detail = (await t.app.inject({ url: `/api/companies/acme/tasks/${taskRef}`, headers: { cookie: elif } })).json();
    expect(detail.mails.find((m: { direction: string }) => m.direction === "outbound").body).toBe("Please pay invoice INV-9 by Friday.");
    expect(detail.events.some((e: { message: string }) => e.message === "Elif Arslan corrected and approved: Send email to ap@customer.example")).toBe(true);
  });

  it("keeps an item for the person it was meant for", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const answer = (cookie: string) => t.app.inject({ method: "POST", url: `/api/companies/acme/work/${questionId}`, headers: { cookie }, payload: { answer: "Yes, once." } });
    expect((await answer(elif)).statusCode).toBe(403);
    expect((await answer(await as("ayse.yilmaz@acme.com.tr"))).statusCode).toBe(404);
    const answered = await answer(await as("burak.sahin@acme.com.tr"));
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ status: "done", answer: "Yes, once.", resolvedBy: "Burak Şahin" });
    expect((await answer(await as("burak.sahin@acme.com.tr"))).statusCode).toBe(409);
  });
});
