import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES_HEADING } from "@enterprise-brain/builder";
import { ScriptedLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Gate 3 of phase 3, end to end over HTTP with people signed in (Claude scripted: it sorts emails as
 * its instructions say, and the Studio's coach proposes a rule): a customer service agent marks a
 * finished task of the Mail Triage AI employee as wrong and says why; the Studio turns it into a rule
 * and replays recent tasks with it, as tests, so nothing is sent or written; the customer service
 * lead sees what would change and publishes the new version, which new emails then follow.
 */

const base = "/api/companies/acme";
const text = (request: StructuredRequest) => request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

const llm = new ScriptedLlm({
  // Claude sorting an email: by its words, and by the rules its instructions carry.
  "runtime.classify": {
    structured: (request) => {
      const item = text(request).split("<item>")[1]?.split("</item>")[0] ?? "";
      const rules = (request.system ?? "").split(RULES_HEADING)[1] ?? "";
      if (/work stopped/i.test(rules) && /durdu|standing still|has stopped/i.test(item)) {
        return { category: "complaint", confidence: 0.92, reason: "A late delivery that stopped the customer's work (rule from coaching)." };
      }
      if (/datasheet|certificate/i.test(item)) return { category: "information_request", confidence: 0.88, reason: "Asks for product documents." };
      if (/sipariş|order|deliver|teslim|arrived/i.test(item)) return { category: "delivery", confidence: 0.84, reason: "Asks where the order is." };
      return { category: "other", confidence: 0.5, reason: "Nothing specific." };
    },
  },
  "runtime.extract": {
    structured: (request) => {
      const source = text(request);
      return {
        customer_name: /From: ([^<\n]+)</.exec(source)?.[1]?.trim() ?? null,
        company: null,
        order_number: /SO-\d+/.exec(source)?.[0] ?? null,
        invoice_number: null,
        product: null,
        serial_number: null,
        summary: "The customer asks about an order.",
        requested_action: "Answer the customer",
        urgency: /acil|urgent|standing still|stopped|durdu/i.test(source) ? "high" : "medium",
        sentiment: "neutral",
        language: /[ğüşıöç]/i.test(source) ? "tr" : "en",
      };
    },
  },
  "runtime.generate": {
    complete: () => "Dear customer,\n\nThank you for your message; your request is registered and we will get back to you today.\n\nCustomer Service Team",
  },
  // The Studio's coach: the correction as a rule, and the job's change that goes with it.
  "coaching.propose": {
    structured: (request) => {
      expect(text(request)).toContain("<corrections>");
      return {
        rules: ["A late delivery that has left the customer's work stopped is a complaint, not a status question: the team lead calls the same day."],
        operations: [
          {
            op: "replace",
            path: "/workflow/0/categories/6/description",
            valueJson: JSON.stringify("Dissatisfaction with service, repeated problems, or a late delivery that left the customer's work stopped."),
          },
        ],
        explanation: "Late deliveries that stop a customer's work now count as complaints, so the team lead sees them first.",
      };
    },
  },
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface TaskDetail {
  task: { ref: string; status: string; title: string };
  runs: { agentVersion: number; output: Record<string, unknown> | null }[];
  coaching: { status: string; appliedVersion: number | null }[];
  canCorrect: boolean;
}

describe("Gate 3: a correction is tested on past tasks, then goes live", () => {
  let t: TestApp;
  let companyId = "";
  let mehmet = "";
  let deniz = "";
  let zeynep = "";
  const refs = { late: "", line: "", datasheet: "" };
  const call = async (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const outbound = async () => (await t.platform.mail.list(companyId, { direction: "outbound" })).length;
  const cases = async () => ((await t.platform.connectors.executeByType(companyId, "sandbox-crm", "search_cases", {})) as { total: number }).total;

  /** A customer's email arrives at support@; the specialist approves the reply; the task finishes. */
  const email = async (name: string, from: string, subject: string, body: string) => {
    const delivered = await call(mehmet, "POST", "/mail/messages", { mailbox: "support@acme.com.tr", from, fromName: name, subject, body });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const task = await until(
      async () => ((await call(deniz, "GET", "/tasks")).json() as { ref: string; title: string; status: string }[]).find((x) => x.title.includes(subject)),
      (found) => Boolean(found) && found!.status !== "working",
      `Mail Triage to read "${subject}"`,
    );
    expect(task!.status).toBe("needs_person");
    const work = (await call(deniz, "GET", "/work")).json() as { type: string; id: string; task: { ref: string } | null }[];
    const approval = work.find((w) => w.type === "approval" && w.task?.ref === task!.ref)!;
    expect((await call(deniz, "POST", `/approvals/${approval.id}/decide`, { approved: true })).statusCode).toBe(200);
    const done = await until(
      async () => (await call(deniz, "GET", `/tasks/${task!.ref}`)).json() as TaskDetail,
      (d) => d.task.status === "done" || d.task.status === "failed",
      `the reply to "${subject}"`,
    );
    expect(done.task.status).toBe("done");
    return done;
  };

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const as = async (address: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: address } }));
    mehmet = await as("mehmet.oz@acme.com.tr");
    deniz = await as("deniz.aydin@acme.com.tr");
    zeynep = await as("zeynep.kaya@acme.com.tr");
    // After its probation, Mail Triage works alone but for the replies, which a support specialist approves.
    const trusted = await call(zeynep, "PUT", "/agents/customer-service-mail-triage/employment", { probation: "trusted" });
    expect(trusted.statusCode, trusted.body).toBe(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("finishes customer emails, and an agent marks one as wrong, saying why", async () => {
    const late = await email(
      "Ahmet Yılmaz",
      "a.yilmaz@yilmazinsaat.com.tr",
      "Siparişim hâlâ gelmedi - SO-80017",
      "Merhaba,\n\n3 hafta önce verdiğim SO-80017 numaralı sipariş hâlâ elime ulaşmadı. Şantiyede işler durdu, acil bilgi rica ediyorum.\n\nAhmet Yılmaz",
    );
    const line = await email(
      "Hakan Er",
      "ops@marmara-gida.com.tr",
      "Order SO-80023: production line standing still",
      "Hello,\n\nOur order SO-80023 was due last week and still hasn't arrived. Our filling line is standing still because of it.\n\nHakan Er",
    );
    const datasheet = await email(
      "Selin Kurt",
      "info@egepompa.com.tr",
      "Datasheet for the KP-40 pump",
      "Hi,\n\nCould you send us the datasheet and the certificate for the KP-40 pump?\n\nSelin",
    );
    refs.late = late.task.ref;
    refs.line = line.task.ref;
    refs.datasheet = datasheet.task.ref;
    expect(late.runs[0]!.output).toMatchObject({ category: "delivery", sent: true });
    expect(line.runs[0]!.output).toMatchObject({ category: "delivery" });
    expect(datasheet.runs[0]!.output).toMatchObject({ category: "information_request" });

    expect(late.canCorrect).toBe(true);
    const marked = await call(deniz, "POST", `/tasks/${refs.late}/correct`, {
      note: "This was a complaint, not a status question: the order is three weeks late and the customer's site has stopped work. The team lead should call them the same day.",
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().note).toMatchObject({ kind: "task", by: "Deniz Aydın", status: "open" });
  });

  it("turns the correction into a rule and replays recent tasks with it, without sending or writing anything", async () => {
    const coaching = (await call(zeynep, "GET", "/agents/customer-service-mail-triage/coaching")).json();
    expect(coaching.canDecide).toBe(true);
    expect(coaching.notes).toMatchObject([{ status: "open", taskRef: refs.late, by: "Deniz Aydın" }]);
    // An agent can't publish rules; the lead can.
    expect((await call(deniz, "POST", "/agents/customer-service-mail-triage/coaching/proposals", { wait: true })).statusCode).toBe(403);

    const [mailsBefore, casesBefore] = [await outbound(), await cases()];
    const tasksBefore = ((await call(zeynep, "GET", "/tasks")).json() as unknown[]).length;
    const proposed = await call(zeynep, "POST", "/agents/customer-service-mail-triage/coaching/proposals", { wait: true });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposal = proposed.json();
    expect(proposal).toMatchObject({ status: "ready", baseVersion: 1, stale: false });
    expect(proposal.rules[0]).toMatch(/^A late delivery that has left the customer's work stopped is a complaint/);
    expect(proposal.changes.map((c: { label: string }) => c.label)).toEqual(
      expect.arrayContaining(["Instructions", "Classify the email › categories › Complaint about service › description"]),
    );

    // The task marked wrong comes out right now, and so does another like it; the rest stay as they were.
    const items = new Map((proposal.replay.items as { ref: string }[]).map((item) => [item.ref, item]));
    expect(items.get(refs.late)).toMatchObject({
      corrected: true,
      status: "changed",
      changes: expect.arrayContaining([expect.objectContaining({ key: "category", before: "delivery", after: "complaint" })]),
    });
    expect(items.get(refs.line)).toMatchObject({ corrected: false, status: "changed" });
    expect(items.get(refs.datasheet)).toMatchObject({ status: "same" });
    expect(proposal.replay.summary).toMatchObject({ corrected: 1, correctedChanged: 1, failed: 0 });

    // Nothing reached a customer or the CRM, and no work was started.
    expect(await outbound()).toBe(mailsBefore);
    expect(await cases()).toBe(casesBefore);
    expect(((await call(zeynep, "GET", "/tasks")).json() as unknown[]).length).toBe(tasksBefore);
    // Until someone publishes, Mail Triage works as it did.
    expect((await call(zeynep, "GET", "/agents/customer-service-mail-triage")).json().agent.version).toBe(1);
  });

  it("goes live when the lead publishes it: new emails follow the rule", async () => {
    const { proposals } = (await call(zeynep, "GET", "/agents/customer-service-mail-triage/coaching")).json();
    const published = await call(zeynep, "POST", `/coaching/proposals/${proposals[0].id}/publish`);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ status: "published", publishedVersion: 2, decidedBy: "Zeynep Kaya" });
    const late = (await call(deniz, "GET", `/tasks/${refs.late}`)).json() as TaskDetail;
    expect(late.coaching).toMatchObject([{ status: "applied", appliedVersion: 2 }]);

    const next = await email(
      "Murat Can",
      "murat@karadeniz-yapi.com.tr",
      "SO-80031 hâlâ gelmedi",
      "Merhaba,\n\nSO-80031 numaralı siparişimiz gecikti, şantiyede işler durdu.\n\nMurat Can",
    );
    expect(next.runs[0]).toMatchObject({ agentVersion: 2, output: expect.objectContaining({ category: "complaint" }) });

    // The lead's report counts the correction.
    const report = (await call(zeynep, "GET", "/reports/performance?period=this-week")).json();
    expect(report.aiEmployees.find((a: { slug: string }) => a.slug === "customer-service-mail-triage").measures).toMatchObject({ finished: 4, corrected: 1 });
  });
});
