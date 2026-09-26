import { z } from "zod";

/**
 * Working hours: the days and hours people work, in the company's time zone. Reports measure how long
 * people take to handle work in these hours only, so a question asked on Friday evening and answered
 * on Monday morning took an hour, not three days.
 */
export const WorkingHoursSettings = z.object({
  /** Days of the week people work: 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5]),
  start: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("09:00"),
  end: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/)
    .default("18:00"),
});
export type WorkingHoursSettings = z.infer<typeof WorkingHoursSettings>;
