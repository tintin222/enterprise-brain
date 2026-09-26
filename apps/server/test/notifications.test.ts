import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Approvals by email: the button opens a page that shows the item and acts only on a click, for the
 * person the link was sent to, while they may still handle it. Each person chooses what reaches them.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("approvals by email", () => {
  let t: TestApp;
  let companyId: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const person = async (email: string) => (await t.platform.people.list(companyId)).find((p) => p.email === email)!;

  /** The action link in the latest approval email a person got. */
  const linkIn = async (email: string, subject: RegExp) => {
    const mails = (await t.platform.mail.list(companyId, { direction: "outbound" })).filter((m) => m.toAddresses.includes(email) && subject.test(m.subject));
    const match = /http:\/\/brain\.test\/act\/([\w.-]+)/.exec(mails[0]?.bodyText ?? "");
    if (!match) throw new Error(`no action link for ${email}`);
    return match[1]!;
  };

  const pendingApproval = async (customer: string) => {
    await t.platform.engine.start(companyId, "reminder-clerk", { customer });
    const approvals = await t.platform.engine.listApprovals(companyId, { status: "pending" });
    return approvals.find((a) => (a.action as { to?: string }).to === customer)!;
  };

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
    t.platform.notifications.configure({ publicUrl: t.config.publicUrl });
  });
  afterAll(() => t?.close());

  it("shows the item on opening the link, and acts only when the person confirms", async () => {
    const approval = await pendingApproval("ap@customer.example");
    await t.platform.notifications.dispatch(companyId);
    const token = await linkIn("elif.arslan@acme.com.tr", /^Approve\? Send email to ap@customer\.example/);

    const page = await t.app.inject({ url: `/api/public/act/${token}` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({
      company: { name: "Acme Endüstri A.Ş." },
      person: { name: "Elif Arslan" },
      canAct: true,
      item: {
        type: "approval",
        id: approval.id,
        status: "pending",
        agent: { name: "Reminder Clerk" },
        action: { type: "mail.send", to: "ap@customer.example" },
      },
    });
    // Opening it changed nothing (mail scanners open links too).
    expect((await t.platform.queue.entry(companyId, "approval", approval.id))!.status).toBe("pending");

    const approve = await t.app.inject({ method: "POST", url: `/api/public/act/${token}`, payload: { choice: "approve", note: "Customer agreed" } });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json().item).toMatchObject({ status: "approved", resolvedBy: "Elif Arslan", answer: "Customer agreed" });
    const audit = (await t.platform.activity.list(companyId, 50)).find((a) => a.action === "approval.approved" && a.entityId === approval.id);
    expect(audit).toMatchObject({ actor: "Elif Arslan", summary: "Approved in an email: Send email to ap@customer.example" });

    // Burak's link for the same approval now says who decided; it can't decide again.
    const burak = await linkIn("burak.sahin@acme.com.tr", /^Approve\? Send email to ap@customer\.example/);
    expect((await t.app.inject({ url: `/api/public/act/${burak}` })).json()).toMatchObject({
      canAct: false,
      item: { status: "approved", resolvedBy: "Elif Arslan" },
    });
    const again = await t.app.inject({ method: "POST", url: `/api/public/act/${burak}`, payload: { choice: "reject" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("Approval is already approved by Elif Arslan");
  });

  it("lets the person correct the change before approving it", async () => {
    const approval = await pendingApproval("billing@customer.example");
    await t.platform.notifications.dispatch(companyId);
    const token = await linkIn("burak.sahin@acme.com.tr", /billing@customer\.example/);
    const response = await t.app.inject({
      method: "POST",
      url: `/api/public/act/${token}`,
      payload: { choice: "approve", edits: { body: "Please pay invoice INV-9 by Friday." } },
    });
    expect(response.statusCode, response.body).toBe(200);
    const decided = (await t.platform.engine.listApprovals(companyId)).find((a) => a.id === approval.id)!;
    expect(decided.action).toMatchObject({ body: "Please pay invoice INV-9 by Friday.", correctedBy: "Burak Şahin" });
  });

  it("refuses links that were changed, and people who no longer have access", async () => {
    await pendingApproval("late@customer.example");
    await t.platform.notifications.dispatch(companyId);
    const token = await linkIn("elif.arslan@acme.com.tr", /late@customer\.example/);
    const forged = await t.app.inject({ url: `/api/public/act/${token.slice(0, 30)}${token[30] === "A" ? "B" : "A"}${token.slice(31)}` });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toBe("This link is not valid");

    // Elif moves to HR: the link no longer shows Finance's work.
    const elif = await person("elif.arslan@acme.com.tr");
    const hr = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "hr")!;
    await t.platform.people.update(companyId, elif.id, { departments: [{ departmentId: hr.id, role: "worker" }] });
    const moved = await t.app.inject({ url: `/api/public/act/${token}` });
    expect(moved.statusCode).toBe(403);
    await t.platform.people.update(companyId, elif.id, { departments: elif.departments.map((d) => ({ departmentId: d.departmentId, role: d.role })) });

    await t.platform.people.update(companyId, elif.id, { status: "disabled" });
    expect((await t.app.inject({ url: `/api/public/act/${token}` })).statusCode).toBe(403);
    await t.platform.people.update(companyId, elif.id, { status: "active" });
    expect((await t.app.inject({ url: `/api/public/act/${token}` })).statusCode).toBe(200);
  });

  it("answers a question from its link", async () => {
    const elif = await person("elif.arslan@acme.com.tr");
    const question = await t.platform.work.create(companyId, {
      kind: "question",
      title: "Which cost centre should INV-9 go to?",
      options: ["4200", "4300"],
      assigneeUserId: elif.id,
      departmentId: elif.departments[0]!.departmentId,
    });
    await t.platform.notifications.dispatch(companyId);
    const token = await linkIn("elif.arslan@acme.com.tr", /asks: Which cost centre/);
    expect((await t.app.inject({ method: "POST", url: `/api/public/act/${token}`, payload: {} })).json().error).toBe(
      "Write an answer, or dismiss the question",
    );
    const answered = await t.app.inject({ method: "POST", url: `/api/public/act/${token}`, payload: { answer: "4200" } });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json().item).toMatchObject({ id: question.id, status: "done", answer: "4200", resolvedBy: "Elif Arslan" });
  });

  it("lets each person choose what reaches them", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const current = await t.app.inject({ url: "/api/me/notifications", headers: { cookie: elif } });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      preferences: { deliver: "urgent", channel: "auto", summaryAt: "08:30", timeZone: "Europe/Istanbul" },
      email: "elif.arslan@acme.com.tr",
      channels: [
        { id: "email", reaches: true },
        { id: "teams", reaches: false },
        { id: "google-chat", reaches: false },
      ],
    });
    expect(current.json().recent.length).toBeGreaterThan(0);

    const changed = await t.app.inject({
      method: "PUT",
      url: "/api/me/notifications",
      headers: { cookie: elif },
      payload: { channel: "email", summaryAt: "09:15" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().preferences).toMatchObject({ deliver: "urgent", summaryAt: "09:15", channel: "email" });
    // One change leaves the others as they were.
    const again = await t.app.inject({ method: "PUT", url: "/api/me/notifications", headers: { cookie: elif }, payload: { deliver: "summary" } });
    expect(again.json().preferences).toEqual({ deliver: "summary", summaryAt: "09:15", channel: "email", timeZone: "Europe/Istanbul" });
    // The company's time zone applies to people who didn't choose their own.
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const zone = await t.app.inject({
      method: "PUT",
      url: "/api/companies/acme/settings",
      headers: { cookie: mehmet },
      payload: { timeZone: "Europe/Berlin" },
    });
    expect(zone.json()).toMatchObject({ timeZone: "Europe/Berlin" });
    expect((await t.app.inject({ url: "/api/me/notifications", headers: { cookie: elif } })).json().preferences.timeZone).toBe("Europe/Berlin");
    const unknown = await t.app.inject({
      method: "PUT",
      url: "/api/companies/acme/settings",
      headers: { cookie: mehmet },
      payload: { timeZone: "Nowhere/City" },
    });
    expect(unknown.statusCode).toBe(400);
    const invalid = await t.app.inject({ method: "PUT", url: "/api/me/notifications", headers: { cookie: elif }, payload: { timeZone: "Mars/Olympus" } });
    expect(invalid.statusCode).toBe(400);
    expect((await t.app.inject({ url: "/api/me/notifications" })).statusCode).toBe(401);
  });
});
