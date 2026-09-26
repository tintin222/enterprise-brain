import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, UnavailableLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The Studio as an agent, over HTTP with people signed in: a quality manager says what they need in
 * a sentence. Claude (scripted here) looks at the company and the mailbox, asks two questions, makes a
 * table and an AI employee, tries it on a real email, plans an app, and the manager puts it to work.
 */

const base = "/api/companies/acme";
const MAILBOX = "quality@acme.com.tr";
let firstEmailId = "";

/** The Studio: looks, asks, then builds and tries, turn by turn. */
function studioScript(request: ToolLoopRequest, turn: number) {
  const last = request.messages.at(-1);
  const answered = Array.isArray(last?.content) && last.content.some((b) => (b as { type: string }).type === "tool_result");
  if (!answered) {
    if (turn === 1)
      return {
        calls: [
          { name: "look_around", input: {} },
          { name: "read_mailbox", input: { mailbox: MAILBOX } },
        ],
      };
    return {
      calls: [
        {
          name: "ask_person",
          input: {
            questions: [
              { question: "Who confirms the root cause of a complaint?", recommended: "Kerem Yıldız, the quality engineer" },
              { question: "When should a complaint be escalated?", options: ["After two reminders", "After a week"], recommended: "After two reminders" },
            ],
          },
        },
      ],
    };
  }
  switch (turn) {
    case 1:
      return {
        calls: [
          {
            name: "save_table",
            input: {
              name: "Supplier complaints",
              department: "operations",
              description: "One supplier complaint",
              fields: [
                { label: "Supplier", type: "text", required: true },
                { label: "Order number", type: "text" },
                { label: "Problem", type: "long_text" },
                { label: "Status", type: "choice", choices: ["Open", "In progress", "Closed"], default: "Open" },
                { label: "Root cause", type: "long_text" },
              ],
              title_field: "Supplier",
            },
          },
        ],
      };
    case 2:
      return {
        calls: [
          {
            name: "save_ai_employee",
            input: {
              name: "Complaint Handler",
              role: "Handles the supplier complaints that come to quality@",
              department: "operations",
              job: "For each email to quality@ about a problem with a supplier's delivery: add it to Supplier complaints with the supplier, the order number and the problem. Ask the quality engineer to confirm the root cause. Leave other emails alone.",
              starts: [{ when: "email", mailbox: MAILBOX }],
              can: { documents: true, tables: [{ table: "supplier_complaints", can: ["find", "add", "update"] }], emails: "draft" },
            },
          },
        ],
      };
    case 3:
      return { calls: [{ name: "try_ai_employee", input: { key: "complaint-handler", email_id: firstEmailId } }] };
    case 4:
      return {
        calls: [
          {
            name: "save_app",
            input: {
              name: "Complaint desk",
              department: "operations",
              description: "A list of open complaints by supplier, and a form to log one by hand.",
              tables: ["supplier_complaints"],
              ai_employees: ["complaint-handler"],
            },
          },
        ],
      };
    default:
      return {
        text: "The Complaint Handler, its table and the Complaint desk are ready, and it handled last week's email well. Put it to work when you're happy.",
      };
  }
}

/** The AI employee made in the Studio: files the complaint, then asks for the root cause. */
function handlerScript(request: ToolLoopRequest, turn: number) {
  const add = request.tools.find((t) => t.name === "tables__add_supplier_complaints");
  if (turn === 1 && add) {
    const values: Record<string, string> = {};
    for (const key of Object.keys((add.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) {
      if (/supplier/.test(key)) values[key] = "Akın Metal";
      else if (/order/.test(key)) values[key] = "PO-4500012";
      else if (/problem/.test(key)) values[key] = "Cracked flanges";
    }
    return { calls: [{ name: add.name, input: values }] };
  }
  if (turn === 2)
    return { calls: [{ name: "task_ask_person", input: { question: "Is the root cause the heat treatment at Akın Metal?", suggestion: "Yes" } }] };
  return { text: "Filed the complaint and asked the quality engineer for the root cause." };
}

const llm = new ScriptedLlm({
  "studio.agent": { tools: studioScript },
  "runtime.agent:complaint-handler": { tools: handlerScript },
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

interface ThreadView {
  id: string;
  status: string;
  questions: { question: string }[];
  events: { seq: number; kind: string; data: Record<string, unknown> }[];
  solution: {
    employees: { key: string; name: string; status: string; duties: string[]; abilities: string[]; lastTry: { status: string; outcome: string } | null }[];
    tables: { key: string; name: string; draft: boolean }[];
    apps: { key: string; name: string; made: boolean }[];
  };
  built: { employees: string[]; tables: string[]; apps: string[] } | null;
}

describe("the Studio as an agent", () => {
  let t: TestApp;
  let companyId = "";
  const as: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const thread = async (who: string, id: string) => (await call(who, "GET", `/studio/threads/${id}`)).json() as ThreadView;

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    for (const local of ["selin.acar", "kerem.yildiz", "mehmet.oz"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
    const first = await t.platform.mail.ingest(companyId, {
      mailbox: MAILBOX,
      from: "kerem.yildiz@acme.com.tr",
      fromName: "Kerem Yıldız",
      subject: "Cracked flanges again",
      body: "The flanges Akın Metal delivered on order PO-4500012 are cracked, twelve of forty in lot 7.",
      attachmentFileIds: [],
    });
    firstEmailId = first.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("looks first, asks what only the person can say, then builds, tries and puts it to work", async () => {
    // Only people who hire use it.
    expect((await call("kerem.yildiz", "POST", "/studio/threads", { text: "Handle supplier complaints" })).statusCode).toBe(403);

    const operations = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "operations")!;
    const started = await call("selin.acar", "POST", "/studio/threads", {
      text: "Supplier complaints come to quality@acme.com.tr. I want each one handled and tracked.",
      departmentId: operations.id,
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as ThreadView).id;

    // 1. It looks at the company and the mailbox, then asks two questions and waits.
    let view = await until(
      () => thread("selin.acar", id),
      (v) => v.status === "asking",
      "the Studio's questions",
    );
    expect(view.events.map((e) => e.kind)).toEqual(["user", "step", "step", "question"]);
    expect(view.events[2]!.data.text).toBe(`Read 1 email in ${MAILBOX}`);
    expect(view.questions.map((q) => q.question)).toEqual(["Who confirms the root cause of a complaint?", "When should a complaint be escalated?"]);
    // Someone else's conversation is theirs.
    expect((await call("kerem.yildiz", "GET", `/studio/threads/${id}`)).statusCode).toBe(403);

    // 2. The answer goes back to it: it makes the table and the AI employee, tries it, plans the app.
    const answered = await call("selin.acar", "POST", `/studio/threads/${id}/messages`, { text: "Kerem confirms root causes. Escalate after two reminders." });
    expect(answered.statusCode, answered.body).toBe(200);
    view = await until(
      () => thread("selin.acar", id),
      (v) => v.status === "idle",
      "the Studio to build",
    );
    const kinds = view.events.map((e) => e.kind);
    expect(kinds.slice(4)).toEqual(["answer", "part", "part", "trying", "try", "part", "said"]);
    expect(view.questions).toEqual([]);

    const [employee] = view.solution.employees;
    expect(employee).toMatchObject({ key: "complaint-handler", name: "Complaint Handler", status: "draft", duties: [`Reads every email sent to ${MAILBOX}`] });
    expect(employee!.abilities).toEqual([
      "Reads attachments and files",
      "Drafts emails for people to send",
      "Finds, adds and changes records in Supplier complaints",
    ]);
    expect(employee!.lastTry).toMatchObject({ status: "succeeded", outcome: "Filed the complaint and asked the quality engineer for the root cause." });
    expect(view.solution.tables).toEqual([expect.objectContaining({ key: "supplier_complaints", name: "Supplier complaints", draft: true })]);
    expect(view.solution.apps).toEqual([expect.objectContaining({ key: "complaint_desk", name: "Complaint desk", made: false })]);

    // The try sent and changed nothing; the table waits with the conversation, out of the department's list.
    const table = await t.platform.tables.get(companyId, "supplier_complaints");
    expect(table.records).toBe(0);
    expect(table.settings.studio).toBe(id);
    const agent = await t.platform.agents.get(companyId, "complaint-handler");
    expect(agent.row.status).toBe("draft");
    expect(agent.definition.workflow).toEqual([]);
    expect(agent.definition.tools).toEqual(expect.arrayContaining(["documents.read", "mail.draft", "connector:tables.add_supplier_complaints"]));

    // 3. Put to work: the AI employee starts its duty, the table and the app join Operations.
    const built = await call("selin.acar", "POST", `/studio/threads/${id}/put-to-work`);
    expect(built.statusCode, built.body).toBe(200);
    view = built.json() as ThreadView;
    expect(view.built).toMatchObject({ employees: ["complaint-handler"], tables: ["supplier_complaints"], apps: ["complaint_desk"] });
    expect((await t.platform.agents.get(companyId, "complaint-handler")).row.status).toBe("active");
    expect((await t.platform.tables.get(companyId, "supplier_complaints")).settings.studio).toBeUndefined();
    expect((await t.platform.apps.get(companyId, "complaint_desk")).tables).toEqual(["supplier_complaints"]);
    expect((await call("selin.acar", "POST", `/studio/threads/${id}/messages`, { text: "One more thing" })).statusCode).toBe(409);

    // 4. A new complaint comes in: it files it, with a person's approval, and asks for the root cause.
    const sent = await call("mehmet.oz", "POST", "/mail/messages", {
      mailbox: MAILBOX,
      from: "kerem.yildiz@acme.com.tr",
      fromName: "Kerem Yıldız",
      subject: "Cracked flanges, lot 9",
      body: "More cracked flanges from Akın Metal on PO-4500012.",
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const approvals = await until(
      async () => (await call("kerem.yildiz", "GET", "/approvals?status=pending")).json() as { id: string; agentName: string }[],
      (list) => list.length === 1,
      "the approval to add the record",
    );
    expect(approvals[0]!.agentName).toBe("Complaint Handler");
    expect((await call("kerem.yildiz", "POST", `/approvals/${approvals[0]!.id}/decide`, { approved: true })).statusCode).toBe(200);
    const records = await until(
      () => t.platform.tables.records(companyId, "supplier_complaints"),
      (r) => r.records.length === 1,
      "the record",
    );
    expect(records.records[0]!.values).toMatchObject({ status: "Open" });
  });

  it("needs Claude, and keeps the guided interview for offline installs", async () => {
    const offline = await createTestApp({ llm: new UnavailableLlm() });
    try {
      const response = await offline.app.inject({ method: "POST", url: `${base}/studio/threads`, payload: { text: "Handle supplier complaints" } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: expect.stringContaining("guided interview") });
    } finally {
      await offline.close();
    }
  });
});
