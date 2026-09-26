import { z } from "zod";

/**
 * Calculations: rules people say in plain words ("rank suppliers by complaints per 100 deliveries").
 * The Studio writes the code once and tries it on the real rows; it runs in a sandbox with only the
 * rows of the tables it names. People see the rule, how it works in plain words and the result, never
 * the code.
 */

const Key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Use lower-case letters, digits and _")
  .max(48);

/** When it runs by itself: every day, every Monday or on the first of every month, at 07:00 in the company's time zone. */
export const CALCULATION_SCHEDULES = ["daily", "weekly", "monthly"] as const;
export type CalculationSchedule = (typeof CALCULATION_SCHEDULES)[number];

/** A column of a result's rows, as people read it. */
export const ResultColumn = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "money", "percent", "date", "rank"]).default("text"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export type ResultColumn = z.infer<typeof ResultColumn>;

/** What a calculation gives: rows (a ranking, a list), one number, or a text. */
export const CalculationOutput = z.object({
  kind: z.enum(["rows", "number", "text"]),
  columns: z.array(ResultColumn).max(20).default([]),
  /** For a number: what it counts ("complaints", "%"). */
  unit: z.string().max(40).optional(),
});
export type CalculationOutput = z.infer<typeof CalculationOutput>;

export const CalculationDesign = z.object({
  key: Key,
  name: z.string().min(1).max(80),
  /** The rule as the person said it. */
  rule: z.string().min(3).max(2000),
  /** How it works, in plain words, for the person to check. */
  explanation: z.string().max(2000).default(""),
  /** The tables it reads (their keys). */
  tables: z.array(Key).max(10),
  /** The body of function calculate(tables, params), written by the Studio. */
  code: z.string().min(1).max(20_000),
  output: CalculationOutput,
  schedule: z.enum(CALCULATION_SCHEDULES).optional(),
});
export type CalculationDesign = z.infer<typeof CalculationDesign>;
export type CalculationDesignInput = z.input<typeof CalculationDesign>;

/** The code's contract, for the Studio's prompt and the docs. */
export const CALCULATION_CONTRACT = `The code is the body of function calculate(tables, params) and runs in a sandbox with nothing but its arguments (no network, files, timers or modules; plain modern JavaScript).
- tables: the rows of each table it reads, by table key: plain objects with the fields by key (numbers and money as numbers, dates as "YYYY-MM-DD", yes/no as true/false, a person as their name, a linked record as its name), plus "number" (the record's number) and "created_at" (ISO time).
- params: { today: "YYYY-MM-DD", thisMonth, lastMonth, thisWeek, thisYear }, each period { from, to, label } with from and to as "YYYY-MM-DD" (inclusive), in the company's time zone.
- Return rows (an array of objects whose keys are the result's columns), one number, or a text. Round what people read (two decimals at most).`;

/** The periods a calculation is given, as local dates: this month, last month, this week (from Monday), this year. */
export function calculationParams(today: string): Record<string, unknown> {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
  const monthName = (year: number, month: number) => utc(year, month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const lastMonth = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
  const weekday = (utc(y, m, d).getUTCDay() + 6) % 7;
  const monday = utc(y, m, d - weekday);
  return {
    today,
    thisMonth: { from: iso(utc(y, m, 1)), to: iso(utc(y, m + 1, 0)), label: monthName(y, m) },
    lastMonth: {
      from: iso(utc(lastMonth.year, lastMonth.month, 1)),
      to: iso(utc(lastMonth.year, lastMonth.month + 1, 0)),
      label: monthName(lastMonth.year, lastMonth.month),
    },
    thisWeek: { from: iso(monday), to: iso(utc(y, m, d - weekday + 6)), label: `Week of ${iso(monday)}` },
    thisYear: { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) },
  };
}
