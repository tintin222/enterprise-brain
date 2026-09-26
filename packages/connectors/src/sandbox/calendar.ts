import { createHash } from "node:crypto";
import {
  bookedResult,
  CALENDAR_OPERATIONS,
  calendarZone,
  freeTimeQuery,
  freeTimeResult,
  isoInZone,
  meetingRequest,
  parseWhen,
  zonedInstant,
  type Interval,
} from "../connectors/calendar-common.ts";
import { defineManifest } from "../define.ts";
import { optString, reqString } from "../util.ts";
import { defineSandboxConnector } from "./common.ts";

const DAY = 24 * 3600_000;

/** The meetings people usually have: a few of these fill each demo day, differently for each person. */
const USUAL_MEETINGS: [string, string][] = [
  ["09:00", "09:30"],
  ["10:00", "11:00"],
  ["11:30", "12:30"],
  ["14:00", "15:00"],
  ["15:30", "16:30"],
  ["17:00", "17:30"],
];

interface SandboxEvent {
  event_id: string;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
  join_url: string | null;
  body: string;
  status: "confirmed" | "cancelled";
  created_at: string;
}

/** A person's usual meetings on a day (always the same for the same person and day), plus lunch. */
export function usualBusy(email: string, date: string, timeZone: string): Interval[] {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  const hash = createHash("sha256").update(`${email.toLowerCase()}|${date}`).digest();
  const busy = USUAL_MEETINGS.filter((_, i) => hash[i]! % 3 === 0);
  return [...busy, ["12:30", "13:30"] as [string, string]].map(([start, end]) => ({
    start: zonedInstant(date, start, timeZone),
    end: zonedInstant(date, end, timeZone),
  }));
}

function daysBetween(from: number, to: number): string[] {
  const days: string[] = [];
  for (let t = from - DAY; t <= to + DAY; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  return [...new Set(days)];
}

/**
 * The built-in demo calendar: everyone at the company has a few usual meetings a day, and meetings
 * booked here show up in their free/busy, so AI employees can find times and book meetings before a
 * real calendar is connected.
 */
export const sandboxCalendarConnector = defineSandboxConnector({
  manifest: defineManifest({
    type: "sandbox-calendar",
    name: "Sandbox Calendar",
    vendor: "Enterprise Brain",
    category: "calendar",
    description: "Built-in demo calendar: everyone has a few usual meetings a day, and meetings booked here count as busy. No credentials needed.",
    auth: "none",
    maturity: "sandbox",
    operations: CALENDAR_OPERATIONS,
  }),
  keys: { events: "event_id" },
  seed: () => ({ events: [] }),
  operations: {
    async find_free_times(input, db, ctx) {
      const query = freeTimeQuery(input, ctx);
      const booked = (await db.list<SandboxEvent>("events")).filter((e) => e.status === "confirmed");
      const busy: Interval[] = [];
      for (const attendee of query.attendees) {
        for (const day of daysBetween(query.from, query.to)) busy.push(...usualBusy(attendee, day, query.timeZone));
        for (const event of booked) if (event.attendees.includes(attendee)) busy.push({ start: Date.parse(event.start), end: Date.parse(event.end) });
      }
      return freeTimeResult(query, busy);
    },
    async book_meeting(input, db, ctx) {
      const request = meetingRequest(input, ctx);
      const id = await db.nextId("events", "EV-", 4);
      const joinUrl = request.online ? `https://meet.sandbox.example/${id}` : null;
      await db.put<SandboxEvent>("events", {
        event_id: id,
        subject: request.subject,
        start: isoInZone(request.start, request.timeZone),
        end: isoInZone(request.end, request.timeZone),
        attendees: [...request.attendees, ...request.optional],
        location: request.location ?? null,
        join_url: joinUrl,
        body: request.body,
        status: "confirmed",
        created_at: new Date().toISOString(),
      });
      return bookedResult(request, { id, joinUrl, webLink: null });
    },
    async cancel_meeting(input, db) {
      const id = reqString(input, "event_id");
      const event = await db.require<SandboxEvent>("events", id, "Meeting");
      await db.put("events", { ...event, status: "cancelled" });
      return { ok: true, cancelled: id };
    },
    async list_events(input, db, ctx) {
      const timeZone = calendarZone(ctx, input);
      const from = parseWhen(optString(input, "from"), Date.now(), timeZone);
      const to = parseWhen(optString(input, "to"), from + 7 * DAY, timeZone, true);
      const items = (await db.list<SandboxEvent>("events"))
        .filter((e) => e.status === "confirmed" && Date.parse(e.end) > from && Date.parse(e.start) < to)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .map(({ body: _body, status: _status, created_at: _created, ...event }) => event);
      return { time_zone: timeZone, count: items.length, items };
    },
  },
});
