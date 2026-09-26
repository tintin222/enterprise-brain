import { z } from "zod";
import type { TriggerSpec } from "./agent.ts";

/**
 * How much an AI employee may do alone. Its manager moves it up or down on its track record.
 * Shadow and Supervised hand every change (an email sent, a record written) to a person;
 * Trusted acts alone within the limits its manager sets.
 */
export const Probation = z.enum(["shadow", "supervised", "trusted"]);
export type Probation = z.infer<typeof Probation>;

/** What a Trusted AI employee may do alone; anything above goes to a person. */
export const TrustLimits = z.object({
  /** The largest amount one action may carry alone: 10000 for "invoices under ₺10,000". */
  maxAmount: z.number().nonnegative().optional(),
  /** The currency of maxAmount (ISO code); an action in another currency goes to a person. */
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  /** At most this many changes a day alone; more go to a person. */
  maxActionsPerDay: z.number().int().positive().optional(),
  /** Emails alone only to these domains (the company's own, a partner's); others go to a person. */
  mailDomains: z.array(z.string()).optional(),
});
export type TrustLimits = z.infer<typeof TrustLimits>;

export const PROBATION_LEVELS: Record<Probation, { label: string; alone: string; person: string }> = {
  shadow: {
    label: "Shadow",
    alone: "Reads and prepares drafts",
    person: "Every action, and a check of every finished task",
  },
  supervised: {
    label: "Supervised",
    alone: "Reads, classifies and drafts",
    person: "Every change, such as sending an email or writing to a system",
  },
  trusted: {
    label: "Trusted",
    alone: "Acts within the limits its manager sets",
    person: "Anything above its limits",
  },
};

/** A duty: a standing job an AI employee does on its own, in plain words. */
export interface Duty {
  kind: TriggerSpec["type"];
  text: string;
}

/**
 * The AI employee's duties from its triggers: "Reads every email sent to careers@acme.com.tr".
 * Manual starts are requests from people, not duties.
 */
/** `names`: what to call the connections the triggers name (their refs), e.g. the connected system's name. */
export function describeDuties(triggers: TriggerSpec[], names: Record<string, string> = {}): Duty[] {
  return triggers.flatMap((trigger): Duty[] => {
    switch (trigger.type) {
      case "manual":
        return [];
      case "form":
        // Its page's form is how colleagues give it work (requests); only a described form is a standing duty.
        return trigger.description ? [{ kind: "form", text: `Handles its form: ${trigger.description}` }] : [];
      case "mailbox": {
        const filter = trigger.filter ?? {};
        const conditions = [
          filter.subjectContains?.length ? `with ${filter.subjectContains.map((s) => `“${s}”`).join(" or ")} in the subject` : "",
          filter.fromDomains?.length ? `from ${filter.fromDomains.join(" or ")}` : "",
          filter.hasAttachment ? "with an attachment" : "",
        ].filter(Boolean);
        return [{ kind: "mailbox", text: `Reads every email sent to ${trigger.mailbox}${conditions.length ? ` ${conditions.join(", ")}` : ""}` }];
      }
      case "schedule":
        return [{ kind: "schedule", text: `Works ${scheduleText(trigger.cron)}${trigger.timezone ? ` (${trigger.timezone})` : ""}` }];
      case "webhook":
        return [{ kind: "webhook", text: trigger.description ? `Acts when another system calls it: ${trigger.description}` : "Acts when another system calls it" }];
      case "chat":
        return [{ kind: "chat", text: "Answers people in chat" }];
      case "paperclip":
        return [{ kind: "paperclip", text: "Works on the tasks assigned to it in Paperclip" }];
      case "connector-event": {
        const system = Object.hasOwn(names, trigger.connector) ? names[trigger.connector]! : trigger.connector;
        if (trigger.event === "new_file") return [{ kind: "connector-event", text: `Picks up each new file in ${system}` }];
        if (trigger.event.startsWith("new:")) return [{ kind: "connector-event", text: `Acts on each new item from ${humanizeAction(trigger.event.slice(4))} in ${system}` }];
        return [{ kind: "connector-event", text: `Acts when ${humanizeEvent(trigger.event)} in ${system}` }];
      }
    }
  });
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "0 8 * * 1-5" → "every weekday at 08:00". Unusual expressions come back as the cron text. */
export function scheduleText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `on the schedule “${cron}”`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `every ${everyMinutes[1]} minutes`;
  if (minute === "0" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return "every hour";
  if (!/^\d+$/.test(minute) || !/^\d+(,\d+)*$/.test(hour) || month !== "*") return `on the schedule “${cron}”`;
  const at = `at ${hour
    .split(",")
    .map((h) => `${h.padStart(2, "0")}:${minute.padStart(2, "0")}`)
    .join(" and ")}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `every day ${at}`;
  if (dayOfMonth === "*" && (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI")) return `every weekday ${at}`;
  if (dayOfMonth === "*" && /^[0-7](,[0-7])*$/.test(dayOfWeek)) {
    const days = dayOfWeek.split(",").map((d) => DAYS[Number(d) % 7]);
    return `every ${days.join(" and ")} ${at}`;
  }
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `on day ${dayOfMonth} of every month ${at}`;
  return `on the schedule “${cron}”`;
}

function humanizeAction(action: string): string {
  return `“${action.replace(/[_.-]+/g, " ").trim()}”`;
}

function humanizeEvent(event: string): string {
  const words = event.replace(/[_.-]+/g, " ").trim();
  return words ? `“${words}” happens` : "an event happens";
}
