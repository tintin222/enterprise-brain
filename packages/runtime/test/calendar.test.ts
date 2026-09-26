import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedder, ScriptedLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * The ready-made Interview Scheduler with the demo calendar and ATS: it finds when the interviewer is
 * free on the days the recruiter named, asks the recruiter to confirm the first time (showing the
 * others), then books the meeting with a link in the calendar and the interview in the ATS.
 */

const DAY = 24 * 3600_000;
/** The next Monday at least a week away, as YYYY-MM-DD. */
function nextMonday(): string {
  const date = new Date(Date.now() + 7 * DAY);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
const monday = nextMonday();
const tuesday = new Date(Date.parse(`${monday}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

const llm = new ScriptedLlm({
  "runtime.extract:hr-interview-scheduler.window": {
    structured: () => ({ from: monday, to: tuesday, earliest: "13:00", latest: "18:00", assumption: "Afternoons, Europe/Istanbul" }),
  },
  "runtime.generate": { complete: () => "Dear Mert, we would like to invite you to a technical interview. Kind regards, Recruitment" },
});

let platform: Platform;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-calendar-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.catalog.installAgentTemplate(companyId, "hr.interview-scheduler", { activate: true });
});
afterAll(async () => {
  await platform?.close();
});

describe("interview scheduling with a calendar", () => {
  it("offers a time the interviewer is free, and books the meeting and the interview once the recruiter confirms", async () => {
    const run = await platform.engine.start(companyId, "hr-interview-scheduler", {
      candidate_id: "CAND-1002",
      interviewer_email: "can.demir@acme.com.tr",
      interview_type: "technical",
      preferred_slots: "Monday or Tuesday afternoon next week",
      duration_minutes: 45,
    });
    expect(run.status, run.error ?? "").toBe("waiting_approval");
    const [approval] = await platform.engine.listApprovals(companyId, { status: "pending" });
    // The first free afternoon time, and the others the recruiter could pick instead.
    expect(approval!.title).toMatch(/^Book a technical interview with Ayla Korkmaz on (Mon|Tue) \d+ \w+, 1[3-7]:[03]0–1[3-8]:[0-5][05]\?$/);
    expect(approval!.details).toContain("Other times can.demir@acme.com.tr is free:");
    const state = (await platform.engine.getRow(companyId, run.id)).context as { steps: Record<string, { slots?: { start: string; label: string }[] }> };
    const slots = state.steps.free!.slots!;
    expect(slots.length).toBeGreaterThan(1);
    for (const slot of slots) {
      expect(slot.start.slice(0, 10) === monday || slot.start.slice(0, 10) === tuesday).toBe(true);
      expect(Number(slot.start.slice(11, 13))).toBeGreaterThanOrEqual(13);
      expect(slot.start.endsWith("+03:00")).toBe(true);
    }

    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Ayşe Yılmaz" });
    const done = await platform.engine.getRow(companyId, run.id);
    expect(done.status, done.error ?? "").toBe("succeeded");
    expect(done.output).toMatchObject({
      candidate_name: "Ayla Korkmaz",
      interview_start: slots[0]!.start,
      scheduled: true,
      invitation_sent: true,
      meeting_link: "https://meet.sandbox.example/EV-0001",
    });
    // Booked in the calendar with both of them, so the next search avoids that time.
    const calendar = await platform.connectors.resolve(companyId, { ref: "calendar", category: "calendar" });
    const events = (await platform.connectors.execute(companyId, calendar, "list_events", { from: monday, to: tuesday })) as {
      items: { attendees: string[]; start: string }[];
    };
    expect(events.items).toEqual([expect.objectContaining({ start: slots[0]!.start, attendees: ["can.demir@acme.com.tr", "ayla.korkmaz@mail.example"] })]);
    const again = (await platform.connectors.execute(companyId, calendar, "find_free_times", {
      attendees: ["can.demir@acme.com.tr"],
      duration_minutes: 45,
      from: monday,
      to: tuesday,
      working_hours_start: "13:00",
    })) as { slots: { start: string }[] };
    expect(again.slots.map((s) => s.start)).not.toContain(slots[0]!.start);
  });
});
