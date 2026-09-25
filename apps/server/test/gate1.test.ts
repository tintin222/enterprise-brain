import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundQuestion } from "@enterprise-brain/core";
import { DEMO_CVS, renderCv } from "../src/demo/documents.ts";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * Gate 1 of phase 1, end to end over HTTP with people signed in (offline mode):
 * the HR manager hires a CV Screener in the Studio; it follows careers@ on its own at the Supervised
 * level; a recruiter handles what it hands over (the shortlist decision) from their work queue.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const base = "/api/companies/acme";

const ANSWERS: Record<string, string> = {
  "purpose.goal": "Screen every CV sent to careers@ against the open position and shortlist the best candidates for our recruiters.",
  "users.primary": "Recruiters work with the shortlist; I am accountable.",
  "inputs.mailbox": "careers@acme.com.tr",
  "processing.reference": "Job descriptions in our ATS.",
  "outputs.system": "Our applicant tracking system (ATS).",
  "actions.follow_up": "Create shortlisted candidates in the ATS.",
  "purpose.out_of_scope": "Never reject a candidate on its own.",
  "governance.access": "HR only",
  "operations.success": "Shortlist within a day",
};

function answerFor(q: RoundQuestion) {
  if (q.nodeId.startsWith("integration.")) return { nodeId: q.nodeId, action: "delegate" as const, delegateTo: "it" as const };
  if (q.nodeId === "inputs.channels") return { nodeId: q.nodeId, action: "answer" as const, value: ["email", "upload"] };
  if (q.nodeId === "outputs.destination") return { nodeId: q.nodeId, action: "answer" as const, value: ["screen", "system"] };
  if (ANSWERS[q.nodeId]) return { nodeId: q.nodeId, action: "answer" as const, value: ANSWERS[q.nodeId] };
  if (q.recommended !== undefined && q.recommended !== "" && !(Array.isArray(q.recommended) && q.recommended.length === 0)) {
    return { nodeId: q.nodeId, action: "accept" as const };
  }
  if (q.answerType === "single" && q.options?.[0]) return { nodeId: q.nodeId, action: "answer" as const, value: q.options[0].value };
  if (q.answerType === "multi" && q.options?.[0]) return { nodeId: q.nodeId, action: "answer" as const, value: [q.options[0].value] };
  return { nodeId: q.nodeId, action: "skip" as const };
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("Gate 1: a CV Screener hired in the Studio follows careers@ alone, and a recruiter handles its exceptions", () => {
  let t: TestApp;
  let ayse = "";
  let can = "";
  let view: Record<string, any> = {};
  let slug = "";
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const call = async (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return res;
  };

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS, seed: false });
    const company = (await t.platform.company("acme"))!;
    // The departments the demo people work in; no ready-made AI employees are put to work.
    for (const department of ["hr", "it", "finance"]) await t.platform.catalog.installDepartment(company.id, department, { activate: false });
    await seedDemoPeople(t.platform, company);
    ayse = await as("ayse.yilmaz@acme.com.tr");
    can = await as("can.demir@acme.com.tr");
  });
  afterAll(() => t?.close());

  it("interviews the HR manager in the Studio, and writes the job description as she answers", async () => {
    const started = await call(ayse, "POST", "/builder/sessions", {
      description:
        "Every week we receive dozens of CVs at careers@acme.com.tr. I want an AI employee that reads each CV, scores it against the open position and shortlists the best ones for our recruiters.",
      language: "en",
    });
    expect(started.statusCode, started.body).toBe(200);
    view = started.json();
    // Signed in, the Studio knows who hires, and for which department.
    expect(view.session).toMatchObject({
      requesterName: "Ayşe Yılmaz",
      requesterEmail: "ayse.yilmaz@acme.com.tr",
      requesterRole: "HR Manager",
      department: "hr",
      templateId: "hr.cv-screener",
    });

    for (let round = 0; round < 12 && view.session.status === "interviewing" && view.currentRound; round++) {
      const questions: RoundQuestion[] = view.currentRound.questions;
      if (questions.some((q) => q.answerType === "files")) {
        const files = await Promise.all(DEMO_CVS.map(async (cv) => ({ cv, ...(await renderCv(cv)) })));
        const body = multipart(
          {},
          files.map(({ cv, data, mimeType }) => ({ field: "files", name: cv.fileName, data, type: mimeType })),
        );
        const uploaded = await t.app.inject({
          method: "POST",
          url: `${base}/builder/sessions/${view.session.id}/samples`,
          headers: { cookie: ayse, ...body.headers },
          payload: body.payload,
        });
        expect(uploaded.statusCode, uploaded.body).toBe(200);
        view = uploaded.json();
        if (!view.currentRound) continue;
      }
      const open = (view.currentRound.questions as RoundQuestion[]).filter((q) => q.answerType !== "files");
      if (!open.length) continue;
      const replied = await call(ayse, "POST", `/builder/sessions/${view.session.id}/reply`, { answers: open.map(answerFor) });
      expect(replied.statusCode, replied.body).toBe(200);
      view = replied.json();
    }
    expect(view.job).toMatchObject({
      manager: "Ayşe Yılmaz",
      duties: expect.arrayContaining(["Reads every email sent to careers@acme.com.tr with an attachment"]),
      never: ["Never reject a candidate on its own"],
      level: { value: "supervised", label: "Supervised" },
      samples: 3,
    });
    // Mailbox access is IT's to give: the Studio drafted the request.
    expect(view.job.needs).toContainEqual({ text: "careers@acme.com.tr", status: "to-ask", who: "IT" });
  });

  it("keeps the interview to the HR manager (and admins), not other departments' managers", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    expect((await call(burak, "GET", "/builder/sessions")).json()).toEqual([]);
    expect((await call(burak, "GET", `/builder/sessions/${view.session.id}`)).statusCode).toBe(404);
    expect((await call(burak, "POST", `/builder/sessions/${view.session.id}/reply`, { text: "confirm" })).statusCode).toBe(404);
    expect((await call(ayse, "GET", "/builder/sessions")).json().map((s: { id: string }) => s.id)).toEqual([view.session.id]);
  });

  it("hires it on trial at the Supervised level, with the HR manager as its manager", async () => {
    if (view.session.status === "awaiting-stakeholders") view = (await call(ayse, "POST", `/builder/sessions/${view.session.id}/proceed`)).json();
    expect(view.session.status).toBe("confirming");
    const hired = await call(ayse, "POST", `/builder/sessions/${view.session.id}/confirm`);
    expect(hired.statusCode, hired.body).toBe(200);
    view = hired.json();
    slug = view.agent.slug;
    const detail = (await call(ayse, "GET", `/agents/${slug}`)).json();
    expect(detail.agent.status).toBe("testing");
    expect(detail.employment).toMatchObject({ probation: "supervised", manager: { name: "Ayşe Yılmaz" } });
    expect(detail.employment.duties).toContainEqual({ kind: "mailbox", text: "Reads every email sent to careers@acme.com.tr with an attachment" });
    expect(detail.canManage).toBe(true);
  });

  it("puts it to work: from then on, careers@ is its duty", async () => {
    const working = await call(ayse, "POST", `/builder/sessions/${view.session.id}/activate`);
    expect(working.statusCode, working.body).toBe(200);
    view = working.json();
    expect(view.agent.status).toBe("active");
    expect(view.messages.at(-1).content).toMatch(/From now on it .*reads every email sent to careers@acme\.com\.tr with an attachment, on its own\./);
  });

  it("screens an application that arrives at careers@ by itself, and hands the shortlist decision to the recruiters", async () => {
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const cv = DEMO_CVS[0]!;
    const rendered = await renderCv(cv);
    const email = multipart(
      {
        mailbox: "careers@acme.com.tr",
        from: "candidate@example.com",
        fromName: "A Candidate",
        subject: "Application: Senior Accountant",
        body: "Please find my CV attached.",
      },
      [{ field: "files", name: cv.fileName, data: rendered.data, type: rendered.mimeType }],
    );
    const delivered = await t.app.inject({
      method: "POST",
      url: `${base}/mail/messages`,
      headers: { cookie: mehmet, ...email.headers },
      payload: email.payload,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json().runs).toHaveLength(1);

    // Nobody started it: the email became a task of the CV Screener, which now needs a person.
    const [task] = await until(
      async () => (await call(ayse, "GET", `/tasks?agent=${slug}`)).json() as { ref: string; status: string; source: string }[],
      (tasks) => tasks.length > 0 && tasks[0]!.status !== "working",
      "the CV Screener to finish screening",
    );
    expect(task).toMatchObject({ source: "mailbox", status: "needs_person" });

    // Can, a recruiter in HR, sees it on his list, and may decide it.
    const mine = (await call(can, "GET", "/work")).json() as {
      type: string;
      id: string;
      title: string;
      forMe: boolean;
      canHandle: boolean;
      task: { ref: string };
    }[];
    const decision = mine.find((w) => w.task?.ref === task!.ref);
    expect(decision).toMatchObject({ type: "approval", forMe: true, canHandle: true });
    expect(decision!.title).toMatch(/^Shortlist .+\? Score \d+\/100/);
    const home = (await call(can, "GET", "/home")).json();
    expect(home.aiEmployees.find((a: { slug: string }) => a.slug === slug)).toMatchObject({ today: { started: 1, needsPerson: 1 } });

    const decided = await call(can, "POST", `/approvals/${decision!.id}/decide`, { approved: true, note: "Strong profile, invite to interview" });
    expect(decided.statusCode, decided.body).toBe(200);

    // It continues alone: the recruiter's decision covers creating the candidate in the ATS.
    const detail = await until(
      async () => (await call(can, "GET", `/tasks/${task!.ref}`)).json() as { task: { status: string }; events: { type: string; message: string }[] },
      (d) => d.task.status !== "working",
      "the task to finish",
    );
    expect(detail.task.status).toBe("done");
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(["created", "needs_person", "decided", "done"]));
    expect(detail.events.find((e) => e.type === "decided")!.message).toMatch(/^Can Demir approved: Shortlist/);
    expect((await call(can, "GET", "/work")).json().filter((w: { task: { ref: string } | null }) => w.task?.ref === task!.ref)).toEqual([]);
  });
});
