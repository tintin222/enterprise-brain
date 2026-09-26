import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, approvals, coachingNotes, runs, tasks, workItems } from "@enterprise-brain/db";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import {
  Platform,
  afterProbation,
  measure,
  median,
  monthStartIn,
  weekStart,
  weeksBefore,
  workingHoursBetween,
  workingHoursOf,
  type AgentRecord,
  type WorkingHours,
} from "../src/index.ts";

/**
 * Reports: what AI employees finish alone, how long people take to handle what they ask (in working
 * hours), what people later corrected and what the work cost.
 */

const istanbul: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", timeZone: "Europe/Istanbul" };
const at = (iso: string) => new Date(iso);

describe("working hours", () => {
  it("counts only the company's working hours, in its time zone", () => {
    // Friday 17:00 to Monday 10:00 in Istanbul (UTC+3): an hour on Friday and an hour on Monday.
    expect(workingHoursBetween(at("2026-09-25T14:00:00Z"), at("2026-09-28T07:00:00Z"), istanbul)).toBe(2);
    expect(workingHoursBetween(at("2026-09-22T06:30:00Z"), at("2026-09-22T08:00:00Z"), istanbul)).toBe(1.5);
    // Saturday to Sunday: none. Before opening to after closing: the whole day.
    expect(workingHoursBetween(at("2026-09-26T07:00:00Z"), at("2026-09-27T15:00:00Z"), istanbul)).toBe(0);
    expect(workingHoursBetween(at("2026-09-22T03:00:00Z"), at("2026-09-22T18:00:00Z"), istanbul)).toBe(9);
    expect(workingHoursBetween(at("2026-09-22T10:00:00Z"), at("2026-09-22T09:00:00Z"), istanbul)).toBe(0);
  });

  it("follows daylight saving time", () => {
    const berlin: WorkingHours = { ...istanbul, timeZone: "Europe/Berlin" };
    // Clocks go forward on Sunday 29 March 2026: Friday 17:00 CET (16:00Z) to Monday 10:00 CEST (08:00Z).
    expect(workingHoursBetween(at("2026-03-27T16:00:00Z"), at("2026-03-30T08:00:00Z"), berlin)).toBe(2);
    // A whole week of working days, over the change.
    expect(workingHoursBetween(at("2026-03-23T00:00:00Z"), at("2026-03-30T22:00:00Z"), berlin)).toBe(54);
  });

  it("reads the company's settings, with Monday to Friday 09:00 to 18:00 by default", () => {
    expect(workingHoursOf({})).toEqual({ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", timeZone: "Europe/Istanbul" });
    expect(workingHoursOf({ timeZone: "Europe/London", workingHours: { days: [0, 1, 2, 3, 4], start: "08:30", end: "17:30" } })).toEqual({
      days: [0, 1, 2, 3, 4],
      start: "08:30",
      end: "17:30",
      timeZone: "Europe/London",
    });
    expect(workingHoursOf({ timeZone: "Mars/Olympus", workingHours: { start: "25:00" } }).timeZone).toBe("Europe/Istanbul");
  });

  it("finds weeks and months in the time zone", () => {
    // Saturday 26 September 2026 in Istanbul: its week began Monday 21 September at midnight (21:00Z the day before).
    expect(weekStart(at("2026-09-26T12:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-09-20T21:00:00.000Z");
    // Monday 00:30 in Istanbul is still Sunday in UTC.
    expect(weekStart(at("2026-09-27T21:30:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-09-27T21:00:00.000Z");
    expect(monthStartIn(at("2026-09-26T12:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-08-31T21:00:00.000Z");
    expect(monthStartIn(at("2026-09-26T12:00:00Z"), "Europe/Istanbul", -1).toISOString()).toBe("2026-07-31T21:00:00.000Z");
    const weeks = weeksBefore(at("2026-09-26T12:00:00Z"), 3, "Europe/Istanbul");
    expect(weeks.map((w) => w.start)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(weeks.at(-1)!.to.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("performance measures", () => {
  let platform: Platform;
  let companyId: string;
  let trusted: AgentRecord;
  let supervised: AgentRecord;
  const period = { from: at("2026-09-21T00:00:00Z"), to: at("2026-09-28T00:00:00Z") };

  const task = async (agent: AgentRecord, values: { status: string; created: string; closed?: string; cost?: number; test?: boolean }) => {
    const [row] = await platform.handle.db
      .insert(tasks)
      .values({
        companyId,
        agentId: agent.row.id,
        ref: `EB-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        title: "Work",
        status: values.status,
        createdAt: at(values.created),
        updatedAt: at(values.closed ?? values.created),
        closedAt: values.closed ? at(values.closed) : null,
      })
      .returning();
    const [run] = await platform.handle.db
      .insert(runs)
      .values({ companyId, agentId: agent.row.id, taskId: row!.id, status: "succeeded", usage: { costUsd: values.cost ?? 0 }, createdAt: at(values.created) })
      .returning();
    return { task: row!, run: run! };
  };

  beforeAll(async () => {
    platform = await Platform.create({
      dataDir: mkdtempSync(join(tmpdir(), "eb-reports-")),
      inMemory: true,
      llm: new UnavailableLlm(),
      embedder: new LocalHashEmbedder(),
      env: {},
    });
    companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
    const definition = (slug: string) => ({ slug, name: slug, summary: "Works.", archetype: "process-automation" as const, instructions: "Work." });
    trusted = await platform.agents.create(companyId, { definition: definition("alone-desk"), status: "active", probation: "trusted" });
    supervised = await platform.agents.create(companyId, { definition: definition("asking-desk"), status: "active", probation: "supervised" });

    // The trusted one: three tasks finished alone this week, one of them corrected later; one asked a question.
    await task(trusted, { status: "done", created: "2026-09-22T07:00:00Z", closed: "2026-09-22T07:05:00Z", cost: 0.02 });
    await task(trusted, { status: "done", created: "2026-09-22T08:00:00Z", closed: "2026-09-22T08:03:00Z", cost: 0.04 });
    const wrong = await task(trusted, { status: "done", created: "2026-09-23T08:00:00Z", closed: "2026-09-23T08:02:00Z", cost: 0.03 });
    await platform.handle.db
      .insert(coachingNotes)
      .values({ companyId, agentId: trusted.row.id, taskId: wrong.task.id, kind: "task", note: "Wrong", by: "Elif" });
    const asked = await task(trusted, { status: "done", created: "2026-09-24T06:00:00Z", closed: "2026-09-24T12:00:00Z", cost: 0.03 });
    // Asked on Thursday 09:00, answered at 11:30 (Istanbul): 2.5 working hours.
    await platform.handle.db.insert(workItems).values({
      companyId,
      agentId: trusted.row.id,
      taskId: asked.task.id,
      kind: "question",
      title: "Which supplier?",
      status: "done",
      resolvedBy: "Elif",
      createdAt: at("2026-09-24T06:00:00Z"),
      resolvedAt: at("2026-09-24T08:30:00Z"),
    });
    // Last week's task and a test run: outside the period, and not real work.
    await task(trusted, { status: "done", created: "2026-09-15T07:00:00Z", closed: "2026-09-15T07:05:00Z", cost: 0.05 });
    await platform.handle.db
      .insert(runs)
      .values({ companyId, agentId: trusted.row.id, isTest: true, status: "succeeded", usage: { costUsd: 0.5 }, createdAt: at("2026-09-23T09:00:00Z") });

    // The supervised one: every change approved by a person. Asked Friday 17:00, decided Monday 10:00: 2 working hours.
    const first = await task(supervised, { status: "done", created: "2026-09-21T06:00:00Z", closed: "2026-09-21T06:30:00Z", cost: 0.1 });
    await platform.handle.db.insert(approvals).values({
      companyId,
      runId: first.run.id,
      agentId: supervised.row.id,
      stepId: "post",
      title: "Post it",
      status: "approved",
      decidedBy: "Burak",
      createdAt: at("2026-09-18T14:00:00Z"),
      decidedAt: at("2026-09-21T07:00:00Z"),
    });
    const second = await task(supervised, { status: "done", created: "2026-09-22T06:00:00Z", closed: "2026-09-22T12:00:00Z", cost: 0.1 });
    await platform.handle.db.insert(approvals).values({
      companyId,
      runId: second.run.id,
      agentId: supervised.row.id,
      stepId: "post",
      title: "Post it",
      status: "rejected",
      decidedBy: "Burak",
      createdAt: at("2026-09-22T06:00:00Z"),
      decidedAt: at("2026-09-22T12:00:00Z"),
    });
    await task(supervised, { status: "failed", created: "2026-09-25T06:00:00Z", closed: "2026-09-25T06:10:00Z", cost: 0.01 });
    await task(supervised, { status: "working", created: "2026-09-26T06:00:00Z", cost: 0 });
  });
  afterAll(async () => {
    await platform?.close();
  });

  it("counts what each AI employee finished alone, what people handled and how fast, what was corrected and what it cost", async () => {
    const facts = await platform.reports.facts(companyId, [trusted.row.id, supervised.row.id], at("2026-08-01T00:00:00Z"));
    expect(measure(facts, period, istanbul, new Set([trusted.row.id]))).toEqual({
      started: 4,
      finished: 4,
      failed: 0,
      finishedAlone: 3,
      aloneShare: 0.75,
      corrected: 1,
      correctedShare: 0.25,
      handled: 1,
      medianHandlingHours: 2.5,
      costUsd: 0.62,
      costPerTaskUsd: 0.03,
    });
    expect(measure(facts, period, istanbul, new Set([supervised.row.id]))).toMatchObject({
      started: 4,
      finished: 2,
      failed: 1,
      finishedAlone: 0,
      aloneShare: 0,
      handled: 2,
      // Monday 10:00 after Friday 17:00 is 2 working hours; Tuesday 09:00 to 15:00 is 6: the median is 4.
      medianHandlingHours: 4,
      costPerTaskUsd: 0.105,
    });
    const all = measure(facts, period, istanbul);
    expect(all).toMatchObject({ started: 8, finished: 6, finishedAlone: 3, aloneShare: 0.5, corrected: 1, handled: 3, medianHandlingHours: 2.5 });
    // The target for finishing alone is for AI employees past probation: the trusted one only.
    expect(afterProbation(facts, period, istanbul, [trusted, supervised])).toEqual({ aiEmployees: 1, finished: 4, finishedAlone: 3, aloneShare: 0.75 });
    // Last week, only the older task.
    expect(measure(facts, { from: at("2026-09-14T00:00:00Z"), to: period.from }, istanbul)).toMatchObject({ finished: 1, finishedAlone: 1, costUsd: 0.05 });
  });

  it("says how long hiring took: a ready-made one within a day, one from the Studio within a week", async () => {
    const readyMade = await platform.agents.create(companyId, {
      definition: { slug: "ready", name: "Ready", summary: "x", archetype: "search", instructions: "x" },
      source: "template",
      templateId: "shared-services.search-assistant",
      status: "draft",
    });
    await platform.handle.db
      .update(agents)
      .set({ createdAt: at("2026-09-21T06:00:00Z") })
      .where(eq(agents.id, readyMade.row.id));
    await platform.handle.db.insert(activityLog).values({
      companyId,
      actor: "Burak",
      action: "agent.active",
      entityType: "agent",
      entityId: readyMade.row.id,
      summary: "Ready → active",
      createdAt: at("2026-09-21T12:00:00Z"),
    });
    const rows = await platform.reports.hiring(
      companyId,
      [await platform.agents.get(companyId, "ready")],
      at("2026-09-01T00:00:00Z"),
      at("2026-09-26T12:00:00Z"),
    );
    expect(rows).toEqual([
      expect.objectContaining({ slug: "ready", source: "ready-made", hours: 6, targetHours: 24, met: true, atWorkAt: "2026-09-21T12:00:00.000Z" }),
    ]);
  });
});
