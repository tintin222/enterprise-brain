import { describe, expect, it } from "vitest";
import { sandboxAtsConnector } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

const ats = sandboxAtsConnector;

function futureSlot(days: number, hourUtc: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

describe("sandbox-ats", () => {
  it("lists open requisitions with pipeline counts", async () => {
    const open = await run(ats, "list_job_requisitions", { status: "open" }, makeCtx());
    expect(open.items.map((r: any) => r.title)).toEqual(
      expect.arrayContaining(["Senior Backend Engineer (Node.js)", "HR Business Partner", "Sales Development Representative", "Financial Analyst"]),
    );
    const backend = open.items.find((r: any) => r.requisition_id === "REQ-301");
    expect(backend).toMatchObject({ candidates_total: 5, active_candidates: 4 });
  });

  it("returns full requisitions with requirements and skills", async () => {
    const req = await run(ats, "get_job_requisition", { requisition_id: "REQ-301" }, makeCtx());
    expect(req.requirements).toMatch(/Node\.js and TypeScript/);
    expect(req.must_have_skills).toEqual(["Node.js", "TypeScript", "REST API design", "PostgreSQL", "Docker"]);
    expect(req.nice_to_have_skills).toContain("Kubernetes");
    expect(req.pipeline).toMatchObject({ interview: 1, screening: 1, assessment: 1, rejected: 1, applied: 1 });
    expect((await expectConnectorError(ats.execute("get_job_requisition", { requisition_id: "REQ-999" }, makeCtx()))).code).toBe("not_found");
  });

  it("searches candidates by requisition and stage, best score first", async () => {
    const ctx = makeCtx();
    const candidates = await run(ats, "search_candidates", { requisition_id: "REQ-301" }, ctx);
    expect(candidates.items.map((c: any) => c.candidate_id)).toEqual(["CAND-1001", "CAND-1003", "CAND-1002", "CAND-1004", "CAND-1005"]);
    expect((await run(ats, "search_candidates", { stage: "offer" }, ctx)).items[0].full_name).toBe("Lena Hoffmann");
    const candidate = await run(ats, "get_candidate", { candidate_id: "CAND-1001" }, ctx);
    expect(candidate.interviews[0]).toMatchObject({ interview_id: "INT-5001", interviewer_email: "can.ozturk@acme.example" });
  });

  it("creates candidates, returning an existing application instead of a duplicate", async () => {
    const ctx = makeCtx();
    const created = await run(
      ats,
      "create_candidate",
      { full_name: "Ece Yurt", email: "Ece.Yurt@mail.example", requisition_id: "REQ-301", score: 78, summary: "6 years Node.js, Kafka", cv_file_id: "file-123" },
      ctx,
    );
    expect(created).toMatchObject({ ok: true, duplicate: false, candidate_id: "CAND-1017", stage: "applied", requisition_title: "Senior Backend Engineer (Node.js)", cv_file_id: "file-123" });
    const again = await run(ats, "create_candidate", { full_name: "Ece Yurt", email: "ece.yurt@mail.example", requisition_id: "REQ-301" }, ctx);
    expect(again).toMatchObject({ ok: true, duplicate: true, candidate_id: "CAND-1017" });
    const otherJob = await run(ats, "create_candidate", { full_name: "Ece Yurt", email: "ece.yurt@mail.example", requisition_id: "REQ-304" }, ctx);
    expect(otherJob).toMatchObject({ duplicate: false, candidate_id: "CAND-1018" });
    const onHold = await run(ats, "create_candidate", { full_name: "Can Er", email: "can.er@mail.example", requisition_id: "REQ-306" }, ctx);
    expect(onHold.warnings).toEqual(["Requisition REQ-306 is on_hold"]);
    expect((await expectConnectorError(ats.execute("create_candidate", { full_name: "X", email: "x@mail.example", requisition_id: "REQ-307" }, ctx))).message).toMatch(/filled/);
    expect((await expectConnectorError(ats.execute("create_candidate", { full_name: "X", email: "x@mail.example", score: 140 }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(ats.execute("create_candidate", { full_name: "X" }, ctx))).code).toBe("validation");
  });

  it("moves candidates through stages and fills the requisition on hire", async () => {
    const ctx = makeCtx();
    expect((await run(ats, "update_candidate_stage", { candidate_id: "CAND-1002", stage: "Shortlisted" }, ctx)).stage).toBe("screening");
    expect((await expectConnectorError(ats.execute("update_candidate_stage", { candidate_id: "CAND-1002", stage: "limbo" }, ctx))).code).toBe("validation");
    const offer = await run(ats, "update_candidate_stage", { candidate_id: "CAND-1001", stage: "offer", note: "Strong technical interview" }, ctx);
    expect(offer).toMatchObject({ ok: true, stage: "offer", previous_stage: "interview" });
    const hired = await run(ats, "update_candidate_stage", { candidate_id: "CAND-1001", stage: "hired" }, ctx);
    expect(hired.requisition_status).toBe("filled");
    expect((await run(ats, "get_job_requisition", { requisition_id: "REQ-301" }, ctx)).status).toBe("filled");
    expect((await expectConnectorError(ats.execute("update_candidate_stage", { candidate_id: "CAND-1001", stage: "rejected" }, ctx))).message).toMatch(/already hired/);
  });

  it("schedules interviews, detecting interviewer conflicts", async () => {
    const ctx = makeCtx();
    const start = futureSlot(10, 8);
    const interview = await run(ats, "schedule_interview", { candidate_id: "CAND-1002", interviewer_email: "can.ozturk@acme.example", start, duration_minutes: 60 }, ctx);
    expect(interview).toMatchObject({ ok: true, interview_id: "INT-5009", duration_minutes: 60, status: "scheduled", candidate_stage: "interview" });
    expect(interview.meeting_link).toBe("https://meet.acme.example/int-5009");
    const conflict = await expectConnectorError(
      ats.execute("schedule_interview", { candidate_id: "CAND-1005", interviewer_email: "can.ozturk@acme.example", start: futureSlot(10, 8).replace(":00:00.000Z", ":30:00.000Z") }, ctx),
    );
    expect(conflict.message).toMatch(/already has interview INT-5009/);
    const other = await run(ats, "schedule_interview", { candidate_id: "CAND-1005", interviewer_email: "can.ozturk@acme.example", start: futureSlot(10, 10) }, ctx);
    expect(other.duration_minutes).toBe(45);
    expect((await expectConnectorError(ats.execute("schedule_interview", { candidate_id: "CAND-1004", interviewer_email: "a@acme.example", start: futureSlot(3, 9) }, ctx))).message).toMatch(/rejected/);
    expect((await expectConnectorError(ats.execute("schedule_interview", { candidate_id: "CAND-1002", interviewer_email: "a@acme.example", start: "2020-01-01T10:00:00Z" }, ctx))).message).toMatch(/in the past/);
  });
});
