import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundQuestion } from "@enterprise-brain/core";
import { DEMO_CVS, renderCv } from "../src/demo/documents.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * The HR manager scenario from the product brief, end to end over HTTP in offline mode:
 * describe → grilling rounds (samples, delegation to IT and the DPO) → stakeholder answers via the
 * public link → confirmation → generated agent tested on the samples → activated → used from its app.
 */
let t: TestApp;
const base = "/api/companies/acme";

const TEXT_ANSWERS: Record<string, string> = {
  "purpose.goal": "Screen incoming CVs against the open position and shortlist the best candidates for recruiters.",
  "users.primary": "Recruiters use the shortlist; I (HR manager) am accountable.",
  "inputs.mailbox": "careers@acme.com.tr",
  "inputs.system": "Our applicant tracking system (ATS)",
  "processing.reference": "Job requisitions with requirements live in our ATS.",
  "outputs.system": "Create shortlisted candidates in our ATS (applicant tracking system).",
  "actions.follow_up": "Create the candidate in the ATS and notify the recruiter.",
  "docs.types": "CVs as PDF and Word files",
  "governance.access": "HR team and the hiring manager only",
  "operations.success": "Time to shortlist under 2 days",
  "purpose.out_of_scope": "It must never reject a candidate on its own.",
};

function answerFor(q: RoundQuestion) {
  if (q.nodeId.startsWith("integration.")) return { nodeId: q.nodeId, action: "delegate" as const, delegateTo: "it" as const };
  if (q.nodeId === "governance.retention" || q.nodeId === "governance.legal_basis") {
    return { nodeId: q.nodeId, action: "delegate" as const, delegateTo: "dpo" as const };
  }
  if (q.nodeId === "inputs.channels") return { nodeId: q.nodeId, action: "answer" as const, value: ["email", "upload"] };
  if (q.nodeId === "outputs.destination") return { nodeId: q.nodeId, action: "answer" as const, value: ["screen", "system"] };
  if (TEXT_ANSWERS[q.nodeId]) return { nodeId: q.nodeId, action: "answer" as const, value: TEXT_ANSWERS[q.nodeId] };
  if (q.recommended !== undefined && q.recommended !== "" && !(Array.isArray(q.recommended) && q.recommended.length === 0)) {
    return { nodeId: q.nodeId, action: "accept" as const };
  }
  if (q.answerType === "single" && q.options?.[0]) return { nodeId: q.nodeId, action: "answer" as const, value: q.options[0].value };
  if (q.answerType === "multi" && q.options?.[0]) return { nodeId: q.nodeId, action: "answer" as const, value: [q.options[0].value] };
  return { nodeId: q.nodeId, action: "skip" as const };
}

async function cvFiles() {
  return Promise.all(DEMO_CVS.map(async (cv) => ({ cv, ...(await renderCv(cv)) })));
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe("Agent Builder: HR manager builds a CV analyser", () => {
  let sessionId = "";
  let view: Record<string, any>;

  async function reply(payload: Record<string, unknown>) {
    const res = await t.app.inject({ method: "POST", url: `${base}/builder/sessions/${sessionId}/reply`, payload });
    expect(res.statusCode, res.body).toBe(200);
    view = res.json();
  }

  async function answerRounds(maxRounds = 12) {
    for (let i = 0; i < maxRounds && view.session.status === "interviewing" && view.currentRound; i++) {
      const questions: RoundQuestion[] = view.currentRound.questions;
      const fileQuestion = questions.find((q) => q.answerType === "files");
      if (fileQuestion) {
        const files = await cvFiles();
        const body = multipart({}, files.map(({ cv, data, mimeType }) => ({ field: "files", name: cv.fileName, data, type: mimeType })));
        const res = await t.app.inject({ method: "POST", url: `${base}/builder/sessions/${sessionId}/samples`, ...body });
        expect(res.statusCode, res.body).toBe(200);
        view = res.json();
        if (!view.currentRound) continue;
      }
      const open: RoundQuestion[] = view.currentRound.questions.filter((q: RoundQuestion) => q.answerType !== "files");
      if (!open.length) continue;
      await reply({ answers: open.map(answerFor) });
    }
  }

  it("starts from the HR manager's description and matches the CV screener template", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `${base}/builder/sessions`,
      payload: {
        description:
          "I'm the HR manager. Every week we receive dozens of CVs by email at careers@acme.com.tr and through our careers page. I want an agent that reads each CV, scores the candidate against the open position and shortlists the best ones for our recruiters.",
        requesterName: "Ayşe Yılmaz",
        requesterRole: "HR Manager",
        requesterEmail: "ayse.yilmaz@acme.com.tr",
        language: "en",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    view = res.json();
    sessionId = view.session.id;
    expect(view.session.templateId).toBe("hr.cv-screener");
    expect(view.session.archetype).toBe("document-processing");
    expect(view.currentRound.questions.length).toBeGreaterThan(0);
    // The analyst asks in grilling format: numbered questions with recommendations.
    const roundMessage = view.messages.find((m: any) => m.data?.round);
    expect(roundMessage.content).toContain("❓ **Q1");
    // Facts from the description are not asked again.
    const mailbox = view.tree.states["inputs.mailbox"];
    expect(mailbox.status).toBe("answered");
  });

  it("interviews in rounds, analyses samples and routes gaps to IT and the DPO", async () => {
    await answerRounds();
    expect(view.session.samples.length).toBe(3);
    const sampleMessage = view.messages.find((m: any) => m.data?.samples);
    expect(sampleMessage.content).toMatch(/analysed 3 sample/i);
    const it = view.requests.find((r: any) => r.role === "it");
    expect(it, "an IT request is drafted").toBeTruthy();
    expect(it.body).toContain("careers@acme.com.tr");
    expect(it.body).toContain("http://brain.test/answer/");
    expect(it.body).toContain("Ayşe Yılmaz");
    expect(view.requests.some((r: any) => r.role === "dpo")).toBe(true);
    expect(["awaiting-stakeholders", "confirming"]).toContain(view.session.status);
  });

  it("lets the HR manager send the IT request and IT answer through the public link", async () => {
    const it = view.requests.find((r: any) => r.role === "it");
    const updated = await t.app.inject({
      method: "PUT",
      url: `${base}/builder/requests/${it.id}`,
      payload: { recipientName: "Mehmet Kaya", recipientEmail: "mehmet.kaya@acme.com.tr" },
    });
    expect(updated.json().body).toContain("Hello Mehmet Kaya,");
    const sent = await t.app.inject({ method: "POST", url: `${base}/builder/requests/${it.id}/send`, payload: { via: "mail" } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().status).toBe("sent");
    // The request went out through the (sandbox) outbox.
    const outbox = await t.app.inject({ method: "GET", url: `${base}/mail/messages?direction=outbound` });
    expect(outbox.json().some((m: any) => m.toAddresses.includes("mehmet.kaya@acme.com.tr"))).toBe(true);

    for (const request of (await t.app.inject({ method: "GET", url: `${base}/builder/sessions/${sessionId}` })).json().requests) {
      const page = await t.app.inject({ method: "GET", url: `/api/public/requests/${request.token}` });
      expect(page.statusCode).toBe(200);
      const answers = page.json().questions.map((q: any) => ({ nodeId: q.nodeId, answer: request.role === "it" ? "Done — app registration created, credentials shared with the platform team." : "Keep applicant data 6 months; privacy notice updated." }));
      const res = await t.app.inject({ method: "POST", url: `/api/public/requests/${request.token}/answers`, payload: { answers, answeredBy: request.role === "it" ? "Mehmet Kaya (IT Director)" : "DPO" } });
      expect(res.statusCode, res.body).toBe(200);
    }
    view = (await t.app.inject({ method: "GET", url: `${base}/builder/sessions/${sessionId}` })).json();
    expect(view.requests.every((r: any) => r.status === "answered")).toBe(true);
    expect(view.messages.some((m: any) => m.role === "system" && m.content.includes("Mehmet Kaya (IT Director)"))).toBe(true);
  });

  it("reaches the confirmation gate with a shared-understanding summary", async () => {
    await answerRounds();
    if (view.session.status === "awaiting-stakeholders") {
      view = (await t.app.inject({ method: "POST", url: `${base}/builder/sessions/${sessionId}/proceed` })).json();
      await answerRounds();
    }
    expect(view.session.status).toBe("confirming");
    const summary = view.messages.filter((m: any) => m.data?.summary).at(-1);
    expect(summary.content).toContain("### Its job");
    expect(summary.content).toContain("**At first:** Supervised");
    expect(view.draft.triggers.some((tr: any) => tr.type === "mailbox" && tr.mailbox === "careers@acme.com.tr")).toBe(true);
    // Nothing has been generated before confirmation.
    expect(view.agent).toBeUndefined();
  });

  it("generates the agent on confirmation and tests it on the samples", async () => {
    const res = await t.app.inject({ method: "POST", url: `${base}/builder/sessions/${sessionId}/confirm` });
    expect(res.statusCode, res.body).toBe(200);
    view = res.json();
    expect(view.session.status).toBe("testing");
    expect(view.agent.status).toBe("testing");
    const results = view.messages.find((m: any) => m.content.startsWith("**Test results:**"));
    expect(results, "test results are reported in the chat").toBeTruthy();
    expect(results.content.split("\n").filter((l: string) => l.startsWith("- **")).length).toBe(3);
    const agent = (await t.app.inject({ method: "GET", url: `${base}/agents/${view.agent.slug}` })).json();
    // Hired on trial at the level agreed in the interview (the recommended Supervised).
    expect(agent.employment.probation).toBe("supervised");
    expect(view.job).toMatchObject({ level: { value: "supervised" }, samples: 3, duties: expect.arrayContaining(["Reads every email sent to careers@acme.com.tr with an attachment"]) });
    expect(agent.definition.guardrails.personalData).not.toBe("none");
    expect(agent.definition.instructions).toContain("Requirements agreed with the business");
  });

  it("activates the agent and screens a CV from its generated app", async () => {
    view = (await t.app.inject({ method: "POST", url: `${base}/builder/sessions/${sessionId}/activate` })).json();
    expect(view.session.status).toBe("deployed");
    expect(view.agent.status).toBe("active");
    const agent = (await t.app.inject({ method: "GET", url: `${base}/agents/${view.agent.slug}` })).json();
    const fileField = agent.definition.inputs.find((f: any) => f.type === "file");
    expect(fileField).toBeTruthy();
    const [first] = await cvFiles();
    const body = multipart({}, [{ field: fileField.key, name: first!.cv.fileName, data: first!.data, type: first!.mimeType }]);
    const run = await t.app.inject({ method: "POST", url: `${base}/agents/${view.agent.slug}/runs`, ...body });
    expect(run.statusCode, run.body).toBe(200);
    const detail = (await t.app.inject({ method: "GET", url: `${base}/runs/${run.json().id}` })).json();
    expect(["succeeded", "waiting_approval"]).toContain(detail.run.status);
    expect(detail.events.some((e: any) => e.type === "step.completed")).toBe(true);
  });
});
