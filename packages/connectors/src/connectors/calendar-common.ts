import { arr, bool, dateTime, email, int, readOp, str, writeOp, type OperationSpec } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { configString, isEmail, optNumber, optString, reqString, type Input } from "../util.ts";

/**
 * What every calendar offers AI employees, whichever system is behind it (Outlook, Google Calendar,
 * the demo calendar): find times when people are free, book a meeting with them, cancel it, and list
 * a calendar's events. Free times are worked out here from everyone's busy times, so every system
 * answers the same way: working hours in the time zone, weekdays, the soonest slots first, spread
 * over days.
 */

export interface Interval {
  start: number;
  end: number;
}

export const DEFAULT_TIME_ZONE = "Europe/Istanbul";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parts(instant: number, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => values.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/** A time zone's offset from UTC at an instant, in minutes (Istanbul: 180). */
export function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000) / MINUTE);
}

/** The instant of a wall-clock time ("2026-10-06", "09:30") in a time zone. */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const first = wall - zoneOffsetMinutes(wall, timeZone) * MINUTE;
  return wall - zoneOffsetMinutes(first, timeZone) * MINUTE;
}

/** An instant as ISO 8601 with the time zone's offset: "2026-10-06T10:00:00+03:00". */
export function isoInZone(instant: number, timeZone: string): string {
  const p = parts(instant, timeZone);
  const offset = zoneOffsetMinutes(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "Tue 6 Oct, 10:00–11:00" in the time zone. */
export function slotLabel(slot: Interval, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(slot.start));
  const time = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
  return `${day}, ${time(slot.start)}–${time(slot.end)}`;
}

function localDay(instant: number, timeZone: string): { date: string; weekday: number } {
  const p = parts(instant, timeZone);
  return { date: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`, weekday: p.weekday };
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Busy times merged and sorted. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export interface FreeSlotOptions {
  busy: Interval[];
  from: number;
  to: number;
  durationMinutes: number;
  timeZone: string;
  workdayStart: string;
  workdayEnd: string;
  /** Minutes slots start on (e.g. 30: 09:00, 09:30…). */
  stepMinutes?: number;
  max?: number;
  /** At most this many on one day, so the choice spans days. */
  perDay?: number;
  /** 0 = Sunday … 6 = Saturday; Monday to Friday by default. */
  weekdays?: Set<number>;
}

/** The soonest times, within working hours, when nobody is busy. */
export function freeSlots(options: FreeSlotOptions): Interval[] {
  const busy = mergeIntervals(options.busy);
  const step = (options.stepMinutes ?? 30) * MINUTE;
  const duration = options.durationMinutes * MINUTE;
  const max = options.max ?? 5;
  const perDay = options.perDay ?? 2;
  const weekdays = options.weekdays ?? WEEKDAYS;
  const slots: Interval[] = [];
  const last = localDay(options.to, options.timeZone).date;
  // Day by day in the time zone's calendar (not by 24 hours, which daylight saving would skew).
  for (let date = localDay(options.from, options.timeZone).date; date <= last && slots.length < max; date = nextDate(date)) {
    if (!weekdays.has(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
    const open = zonedInstant(date, options.workdayStart, options.timeZone);
    const close = Math.min(zonedInstant(date, options.workdayEnd, options.timeZone), options.to);
    let start = Math.max(open, options.from);
    start = open + Math.ceil((start - open) / step) * step;
    let today = 0;
    while (start + duration <= close && today < perDay && slots.length < max) {
      const end = start + duration;
      const clash = busy.find((b) => b.start < end && b.end > start);
      if (clash) {
        start = open + Math.ceil((clash.end - open) / step) * step;
        continue;
      }
      slots.push({ start, end });
      today++;
      start = open + Math.ceil((end + 60 * MINUTE - open) / step) * step;
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// The operations, the same for every calendar
// ---------------------------------------------------------------------------

const attendee = email("An attendee's email address");

export const CALENDAR_OPERATIONS: OperationSpec[] = [
  readOp(
    "find_free_times",
    "Find free times",
    "Times when all the given people are free for a meeting of the given length, within working hours, soonest first (spread over days).",
    {
      attendees: arr(attendee, "Everyone who must attend (email addresses)"),
      duration_minutes: int("Length of the meeting in minutes"),
      from: str("Earliest start: a date (2026-10-06) or date-time; default now"),
      to: str("Latest end: a date or date-time; default a week after `from`"),
      time_zone: str("IANA time zone, e.g. Europe/Istanbul (default: the connection's)"),
      working_hours_start: str("Start of the working day, HH:MM (default 09:00)"),
      working_hours_end: str("End of the working day, HH:MM (default 18:00)"),
      max_results: int("How many times to suggest (default 5, at most 20)"),
    },
    ["attendees", "duration_minutes"],
  ),
  writeOp(
    "book_meeting",
    "Book a meeting",
    "Book a meeting in the calendar and invite the attendees (with an online meeting link unless turned off).",
    {
      subject: str("Title of the meeting, e.g. 'Interview: Deniz Kaya (Welding Engineer)'"),
      start: dateTime("Start, ISO 8601 with offset, e.g. 2026-10-06T10:00:00+03:00"),
      duration_minutes: int("Length in minutes (default 60)"),
      attendees: arr(attendee, "People to invite"),
      optional_attendees: arr(attendee, "People invited as optional"),
      body: str("Invitation text"),
      location: str("Room or address"),
      online_meeting: bool("Add an online meeting link (default true)"),
      time_zone: str("IANA time zone the meeting is shown in (default: the connection's)"),
    },
    ["subject", "start", "attendees"],
  ),
  writeOp(
    "cancel_meeting",
    "Cancel a meeting",
    "Cancel a meeting booked earlier; the attendees are told.",
    { event_id: str("The meeting's id from book_meeting or list_events"), comment: str("A note to the attendees") },
    ["event_id"],
  ),
  readOp("list_events", "List events", "The events in the calendar between two times.", {
    from: str("Start: a date or date-time (default now)"),
    to: str("End: a date or date-time (default a week later)"),
  }),
];

/** A connection's time zone: its setting, else Europe/Istanbul. */
export function calendarZone(ctx: ConnectorContext, input: Input = {}): string {
  const zone = optString(input, "time_zone") ?? configString(ctx, "time_zone") ?? DEFAULT_TIME_ZONE;
  if (!validZone(zone)) throw new ConnectorError(`Unknown time zone "${zone}"`, "validation");
  return zone;
}

/** A date ("2026-10-06", the day's start in the zone) or a date-time, as an instant. */
export function parseWhen(value: string | undefined, fallback: number, timeZone: string, endOfDay = false): number {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return zonedInstant(value, endOfDay ? "23:59" : "00:00", timeZone);
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) throw new ConnectorError(`Not a date or time: ${value}`, "validation");
  return instant;
}

export function emails(input: Input, key: string, required: boolean): string[] {
  const value = input[key];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\s]+/) : [];
  const cleaned = [...new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  for (const address of cleaned) if (!isEmail(address)) throw new ConnectorError(`${key}: "${address}" is not an email address`, "validation");
  if (required && !cleaned.length) throw new ConnectorError(`${key}: give at least one email address`, "validation");
  return cleaned;
}

function hhmm(input: Input, key: string, fallback: string): string {
  const value = optString(input, key) ?? fallback;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ConnectorError(`${key}: use HH:MM, e.g. 09:00`, "validation");
  return value;
}

/** The search a find_free_times call asks for. */
export function freeTimeQuery(input: Input, ctx: ConnectorContext, now = Date.now()) {
  const timeZone = calendarZone(ctx, input);
  const durationMinutes = optNumber(input, "duration_minutes") ?? 60;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480)
    throw new ConnectorError("duration_minutes: between 5 and 480", "validation");
  const from = Math.max(parseWhen(optString(input, "from"), now, timeZone), now);
  const to = parseWhen(optString(input, "to"), from + 7 * DAY, timeZone, true);
  if (to <= from) throw new ConnectorError("`to` must be after `from`", "validation");
  if (to - from > 62 * DAY) throw new ConnectorError("Search at most two months at a time", "validation");
  return {
    attendees: emails(input, "attendees", true),
    durationMinutes,
    from,
    to,
    timeZone,
    workdayStart: hhmm(input, "working_hours_start", configString(ctx, "working_hours_start") ?? "09:00"),
    workdayEnd: hhmm(input, "working_hours_end", configString(ctx, "working_hours_end") ?? "18:00"),
    max: Math.min(Math.max(optNumber(input, "max_results") ?? 5, 1), 20),
  };
}

/** The answer of find_free_times, the same for every calendar. */
export function freeTimeResult(query: ReturnType<typeof freeTimeQuery>, busy: Interval[], unknown: string[] = []) {
  const slots = freeSlots({ ...query, busy });
  return {
    time_zone: query.timeZone,
    duration_minutes: query.durationMinutes,
    slots: slots.map((slot) => ({
      start: isoInZone(slot.start, query.timeZone),
      end: isoInZone(slot.end, query.timeZone),
      label: slotLabel(slot, query.timeZone),
    })),
    checked: query.attendees.filter((a) => !unknown.includes(a)),
    ...(unknown.length ? { not_checked: unknown, note: `The calendars of ${unknown.join(", ")} could not be read: ask them before booking.` } : {}),
  };
}

/** The meeting a book_meeting call asks for. */
export function meetingRequest(input: Input, ctx: ConnectorContext) {
  const timeZone = calendarZone(ctx, input);
  const start = Date.parse(reqString(input, "start"));
  if (Number.isNaN(start)) throw new ConnectorError("start: an ISO 8601 date-time, e.g. 2026-10-06T10:00:00+03:00", "validation");
  const durationMinutes = optNumber(input, "duration_minutes") ?? 60;
  if (durationMinutes < 5 || durationMinutes > 480) throw new ConnectorError("duration_minutes: between 5 and 480", "validation");
  if (start < Date.now() - 5 * MINUTE) throw new ConnectorError("The meeting would start in the past", "validation");
  return {
    subject: reqString(input, "subject"),
    start,
    end: start + durationMinutes * MINUTE,
    timeZone,
    attendees: emails(input, "attendees", true),
    optional: emails(input, "optional_attendees", false),
    body: optString(input, "body") ?? "",
    location: optString(input, "location"),
    online: input.online_meeting !== false,
  };
}

export type MeetingRequest = ReturnType<typeof meetingRequest>;

/** The standard answer of book_meeting. */
export function bookedResult(request: MeetingRequest, booked: { id: string; webLink?: string | null; joinUrl?: string | null }) {
  return {
    ok: true,
    event_id: booked.id,
    subject: request.subject,
    start: isoInZone(request.start, request.timeZone),
    end: isoInZone(request.end, request.timeZone),
    label: slotLabel({ start: request.start, end: request.end }, request.timeZone),
    attendees: [...request.attendees, ...request.optional],
    ...(booked.webLink ? { web_link: booked.webLink } : {}),
    ...(booked.joinUrl ? { join_url: booked.joinUrl } : {}),
  };
}

export const CALENDAR_CONFIG_EXTRAS = [
  {
    key: "time_zone",
    label: "Time zone",
    type: "string" as const,
    placeholder: DEFAULT_TIME_ZONE,
    help: "IANA time zone meetings are planned in (default Europe/Istanbul).",
  },
  { key: "working_hours_start", label: "Working day starts", type: "string" as const, placeholder: "09:00" },
  { key: "working_hours_end", label: "Working day ends", type: "string" as const, placeholder: "18:00" },
];
