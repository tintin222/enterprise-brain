import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderInvoice, type DemoInvoice } from "../src/demo/documents.ts";
import { demoInvoices, seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";
import { cardOf, cardText, startTeamsStub, type SentActivity, type TeamsStub } from "./teams-stub.ts";

/**
 * Gate 2 of phase 2, end to end over HTTP with people signed in (offline mode, Teams played by a
 * stand-in for the Bot Framework): a supplier's invoice arrives 12% over its purchase order; the
 * Invoice Processor finds the exception by itself and asks the AP specialist in Microsoft Teams,
 * where she approves it on the card; it posts the invoice with her approval on record, and every
 * other copy of the question says who decided.
 */

const ELIF_AAD = "0f8fad5b-d9cb-469f-a165-70867728950e";
const base = "/api/companies/acme";

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

describe("Gate 2: an invoice exception is approved in a Teams card", () => {
  let t: TestApp;
  let teams: TeamsStub;
  let companyId = "";
  let mehmet = "";
  let elif = "";
  let invoices: DemoInvoice[] = [];
  let taskRef = "";
  let approvalId = "";
  let card: SentActivity | undefined;
  const realFetch = globalThis.fetch;

  const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const fromTeams = async (payload: Record<string, unknown>) =>
    t.app.inject({ method: "POST", url: "/api/channels/teams/acme/messages", headers: { authorization: `Bearer ${await teams.token()}` }, payload });
  const supplierEmail = async (invoice: DemoInvoice) => {
    const email = multipart(
      {
        mailbox: "invoices@acme.com.tr",
        from: invoice.supplierEmail,
        fromName: invoice.supplierName,
        subject: `Invoice ${invoice.invoiceNumber} for PO ${invoice.poNumber}`,
        body: `Dear Accounts Payable,\n\nPlease find attached invoice ${invoice.invoiceNumber} for purchase order ${invoice.poNumber}.\n\nBest regards,\n${invoice.supplierName}`,
      },
      [{ field: "files", name: invoice.fileName, data: await renderInvoice(invoice), type: "application/pdf" }],
    );
    const delivered = await t.app.inject({
      method: "POST",
      url: `${base}/mail/messages`,
      headers: { cookie: mehmet, ...email.headers },
      payload: email.payload,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    return delivered.json() as { runs: { id: string }[] };
  };
  const taskOf = (invoice: DemoInvoice) =>
    until(
      async () =>
        ((await call(elif, "GET", "/tasks")).json() as { ref: string; title: string; status: string }[]).find((x) => x.title.includes(invoice.invoiceNumber)),
      (task) => Boolean(task) && task!.status !== "working",
      `the Invoice Processor to check ${invoice.invoiceNumber}`,
    );

  beforeAll(async () => {
    teams = await startTeamsStub({ "29:elif": { email: "Elif.Arslan@acme.com.tr", name: "Elif Arslan", aadObjectId: ELIF_AAD } });
    // Microsoft's sign-in service is the stand-in's token endpoint.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith("https://login.microsoftonline.com/") ? realFetch(`${teams.base}/token`, init) : realFetch(input, init);
    }) as typeof fetch;
    t = await createTestApp({
      seed: false,
      config: { auth: { mode: "accounts", sessionHours: 1, providers: [] }, teams: { openIdUrl: `${teams.base}/openid` } },
    });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    // Finance at work: its AI employees follow their mailboxes, the Invoice Processor invoices@.
    await t.platform.catalog.installDepartment(companyId, "finance", { activate: true });
    await seedDemoPeople(t.platform, company);
    invoices = await demoInvoices(t.platform, companyId);
    mehmet = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "mehmet.oz@acme.com.tr" } }));
    elif = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "elif.arslan@acme.com.tr" } }));
    t.platform.notifications.configure({ publicUrl: t.config.publicUrl });
    t.platform.notifications.start(0);
  });
  afterAll(async () => {
    await t?.platform.notifications.stop();
    globalThis.fetch = realFetch;
    await t?.close();
    await teams?.close();
  });

  it("IT connects Microsoft Teams, and the AP specialist adds the app", async () => {
    const connected = await call(mehmet, "POST", "/connectors", {
      type: "microsoft-teams",
      values: { app_id: teams.appId, app_password: teams.password, tenant_id: teams.tenant, app_type: "single-tenant" },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect((await fromTeams(teams.activity("29:elif", { type: "conversationUpdate", membersAdded: [{ id: `28:${teams.appId}` }] }))).statusCode).toBe(200);
    const welcome = cardText(cardOf(teams.sent[0]));
    expect(welcome).toContain("Hi Elif, your AI employees work here with you");
    expect(welcome).toContain("Invoice Processor");
  });

  it("finds the exception in a supplier's invoice by itself, and asks in Teams why it asks", async () => {
    const exception = invoices[1]!;
    const before = teams.sent.length;
    expect((await supplierEmail(exception)).runs).toHaveLength(1);
    const task = await taskOf(exception);
    expect(task).toMatchObject({ status: "needs_person" });
    taskRef = task!.ref;

    // Elif's list: the exception, with what makes it one.
    const work = (await call(elif, "GET", "/work")).json() as {
      type: string;
      id: string;
      title: string;
      reason: string | null;
      forMe: boolean;
      task: { ref: string };
    }[];
    const item = work.find((w) => w.task?.ref === taskRef)!;
    expect(item).toMatchObject({ type: "approval", forMe: true });
    expect(item.title).toMatch(
      new RegExp(
        `^Invoice ${exception.invoiceNumber} from .+ is 12\\.0% \\([\\d,]+\\.\\d{2} TRY\\) above the goods received on ${exception.poNumber}\\. Post it anyway\\?$`,
      ),
    );
    expect(item.reason).toMatch(
      /^The invoice is 12\.0% .+ above the goods received on PO-\d+: posted without your approval, it would be blocked for payment\.$/,
    );
    approvalId = item.id;

    // It reached her in Teams at once, as a card whose buttons decide.
    await t.platform.notifications.idle();
    card = teams.sent.slice(before).find((s) => s.conversation === "a:elif-chat" && cardText(cardOf(s)).includes(exception.invoiceNumber));
    const text = cardText(cardOf(card));
    expect(card?.body.summary).toBe(`Approve? ${item.title}`);
    expect(text).toContain(`Why you are asked: ${item.reason}`);
    expect(text).toMatch(/3-way match in the ERP: it is 12\.0% /);
    const actions = cardOf(card)!.actions as { type: string; title: string; verb?: string; data?: Record<string, string> }[];
    expect(actions.map((a) => a.title)).toEqual(["Approve", "Reject", "Open in the app"]);
    expect(actions[0]).toMatchObject({ type: "Action.Execute", verb: "approve", data: { eb: "act", type: "approval", id: approvalId } });
    // The finance manager isn't in Teams: his copy came by email.
    const mail = (await t.platform.mail.list(companyId, { direction: "outbound" })).find(
      (m) => m.toAddresses.includes("burak.sahin@acme.com.tr") && m.subject.includes(exception.invoiceNumber),
    );
    expect(mail?.subject).toBe(`Approve? ${item.title}`);
  });

  it("she approves it on the card, and it posts the invoice with her approval on record", async () => {
    const exception = invoices[1]!;
    const actions = cardOf(card)!.actions as { verb?: string; data?: Record<string, string> }[];
    const note = "Steel surcharge agreed with purchasing";
    const pressed = await fromTeams(
      teams.activity("29:elif", {
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: { type: "Action.Execute", verb: "approve", data: { ...actions[0]!.data, note } } },
      }),
    );
    expect(pressed.statusCode, pressed.body).toBe(200);
    expect(cardText(pressed.json().value)).toContain("Approved by Elif Arslan");

    // It carries on alone: the invoice is posted, released for payment, with who approved the difference.
    const detail = await until(
      async () =>
        (await call(elif, "GET", `/tasks/${taskRef}`)).json() as {
          task: { status: string };
          events: { type: string; message: string }[];
          runs: { output: Record<string, unknown> | null }[];
        },
      (d) => d.task.status === "done" || d.task.status === "failed",
      "the invoice to be posted",
    );
    expect(detail.task.status).toBe("done");
    expect(detail.events.find((e) => e.type === "decided")?.message).toMatch(new RegExp(`^Elif Arslan approved: Invoice ${exception.invoiceNumber}`));
    const posted = (await t.platform.connectors.executeByType(companyId, "sandbox-erp", "get_invoice_status", { invoice_number: exception.invoiceNumber })) as {
      status: string;
      payment_block: boolean;
      match_status: string;
      history: { note: string }[];
    };
    expect(posted).toMatchObject({ status: "posted", payment_block: false, match_status: "price_mismatch" });
    expect(posted.history[0]!.note).toMatch(/Difference approved by Elif Arslan in Microsoft Teams\.$/);

    const approval = (await t.platform.engine.listApprovals(companyId)).find((a) => a.id === approvalId)!;
    expect(approval).toMatchObject({ status: "approved", decidedBy: "Elif Arslan", decisionNote: note });
    const audit = (await t.platform.activity.list(companyId, 100)).find((a) => a.action === "approval.approved" && a.entityId === approvalId);
    expect(audit?.summary).toBe(`Approved in Microsoft Teams: ${approval.title}`);
  });

  it("says who decided wherever else the question went", async () => {
    await t.platform.notifications.idle();
    // Her card, updated in place.
    const updated = teams.sent.find((s) => s.method === "PUT" && s.activityId === card!.returnedId);
    expect(cardText(cardOf(updated))).toContain("Approved by Elif Arslan");
    // The finance manager's email link now shows the decision instead of buttons.
    const mail = (await t.platform.mail.list(companyId, { direction: "outbound" })).find(
      (m) => m.toAddresses.includes("burak.sahin@acme.com.tr") && m.subject.includes(invoices[1]!.invoiceNumber),
    )!;
    const token = /\/act\/([\w-]{95})/.exec(mail.bodyText)?.[1];
    expect(token).toBeTruthy();
    const page = (await t.app.inject({ url: `/api/public/act/${token}` })).json();
    expect(page).toMatchObject({ canAct: false, item: { status: "approved", resolvedBy: "Elif Arslan" } });
    // And nothing waits on anyone any more.
    expect(((await call(elif, "GET", "/work")).json() as { task: { ref: string } | null }[]).filter((w) => w.task?.ref === taskRef)).toEqual([]);
  });

  it("asks the usual question for an invoice that matches its order", async () => {
    const matching = invoices[0]!;
    await supplierEmail(matching);
    await taskOf(matching);
    const work = (await call(elif, "GET", "/work")).json() as { type: string; title: string; reason: string | null; task: { title: string } | null }[];
    const item = work.find((w) => w.title.includes(matching.invoiceNumber))!;
    expect(item.title).toMatch(new RegExp(`^Post invoice ${matching.invoiceNumber} from .+: [\\d,]+\\.\\d{2} TRY\\?$`));
    expect(item.reason).toBeNull();
  });
});
