import { WorkingHoursSettings } from "@enterprise-brain/core";

/** Working hours in the company's time zone. */
export interface WorkingHours extends WorkingHoursSettings {
  timeZone: string;
}

export const DEFAULT_TIME_ZONE = "Europe/Istanbul";

/** The company's working hours from its settings (Mon–Fri 09:00–18:00 in its time zone by default). */
export function workingHoursOf(settings: Record<string, unknown>): WorkingHours {
  const parsed = WorkingHoursSettings.safeParse(settings.workingHours ?? {});
  const hours = parsed.success ? parsed.data : WorkingHoursSettings.parse({});
  const zone = typeof settings.timeZone === "string" && validZone(settings.timeZone) ? settings.timeZone : DEFAULT_TIME_ZONE;
  return { ...hours, timeZone: zone };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** Wall-clock parts of an instant in a time zone. */
function wallClock(timeZone: string, instant: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far the time zone's clocks are ahead of UTC at an instant (ms). */
function offsetAt(timeZone: string, instant: number): number {
  const w = wallClock(timeZone, instant);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a local date and minute of the day happen in a time zone. */
export function zonedInstant(timeZone: string, year: number, month: number, day: number, minutes: number): number {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const first = wall - offsetAt(timeZone, wall);
  return wall - offsetAt(timeZone, first);
}

/** The local calendar date of an instant, as a UTC midnight (for stepping day by day). */
function localDay(timeZone: string, instant: number): number {
  const w = wallClock(timeZone, instant);
  return Date.UTC(w.year, w.month - 1, w.day);
}

/** Working hours between two moments (a fraction of hours). */
export function workingHoursBetween(from: Date, to: Date, hours: WorkingHours): number {
  const start = from.getTime();
  const end = to.getTime();
  if (!(end > start)) return 0;
  const open = minutesOf(hours.start);
  const close = minutesOf(hours.end);
  if (close <= open) return 0;
  let total = 0;
  // Day by day in local dates, at most two years' worth (older items count up to there).
  for (let day = localDay(hours.timeZone, start), i = 0; i < 740; day += DAY, i++) {
    const date = new Date(day);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const dayStart = zonedInstant(hours.timeZone, y, m, d, 0);
    if (dayStart >= end) break;
    if (!hours.days.includes(date.getUTCDay())) continue;
    const a = Math.max(zonedInstant(hours.timeZone, y, m, d, open), start);
    const b = Math.min(zonedInstant(hours.timeZone, y, m, d, close), end);
    if (b > a) total += b - a;
  }
  return total / 3_600_000;
}

/** Monday 00:00 of the week an instant falls in, in a time zone. */
export function weekStart(instant: Date, timeZone: string): Date {
  const day = localDay(timeZone, instant.getTime());
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const date = new Date(monday);
  return new Date(zonedInstant(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0));
}

/** The first day of the month an instant falls in, 00:00, in a time zone; `offset` months later or earlier. */
export function monthStartIn(instant: Date, timeZone: string, offset = 0): Date {
  const w = wallClock(timeZone, instant.getTime());
  const first = new Date(Date.UTC(w.year, w.month - 1 + offset, 1));
  return new Date(zonedInstant(timeZone, first.getUTCFullYear(), first.getUTCMonth() + 1, 1, 0));
}

/** A local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Date(localDay(timeZone, instant.getTime())).toISOString().slice(0, 10);
}

/** The middle value (the mean of the two middle ones for an even count); null when there are none. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
