import { z } from "zod";
import { scheduleText } from "./employment.ts";

/**
 * When recurring work repeats, as people say it: every day, every weekday, one day of the week or
 * one day of the month, at a time of day in the company's time zone.
 */
export const RepeatSchedule = z.object({
  every: z.enum(["day", "weekday", "week", "month"]),
  /** Every week: the day, 0 = Sunday … 6 = Saturday (Monday when not said). */
  weekday: z.number().int().min(0).max(6).optional(),
  /** Every month: the day of the month, at most the 28th so that every month has it (the 1st when not said). */
  day: z.number().int().min(1).max(28).optional(),
  /** HH:MM, 24 hours. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("08:00"),
});
export type RepeatSchedule = z.infer<typeof RepeatSchedule>;

/** The schedule as a 5-field cron expression (minute hour day month weekday). */
export function repeatCron(schedule: RepeatSchedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const at = `${minute} ${hour}`;
  switch (schedule.every) {
    case "day":
      return `${at} * * *`;
    case "weekday":
      return `${at} * * 1-5`;
    case "week":
      return `${at} * * ${schedule.weekday ?? 1}`;
    case "month":
      return `${at} ${schedule.day ?? 1} * *`;
  }
}

/** "every Monday at 08:00", "on day 1 of every month at 07:30". */
export function describeRepeat(schedule: RepeatSchedule): string {
  return scheduleText(repeatCron(schedule));
}

/** What a request to the one box can become. */
export const NEED_KINDS = ["task", "recurring", "answer", "calculation", "table", "app", "ai-employee", "change", "unclear"] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/** Each reading in a few words, for choosing another one ("Not this: …"). */
export const NEED_LABELS: Record<NeedKind, string> = {
  task: "An AI employee does it now",
  recurring: "An AI employee does it regularly",
  answer: "An answer from the company's knowledge",
  calculation: "Work it out on our tables",
  table: "A table to keep track of it",
  app: "An app, with its table",
  "ai-employee": "A new AI employee for it",
  change: "A change to something we have",
  unclear: "Something else",
};
