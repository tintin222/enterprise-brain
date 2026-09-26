import { z } from "zod";

/**
 * How things reach a person outside the app. What an AI employee is waiting on (an approval, a
 * question) is urgent; checks, notices and the day's news are not.
 */
export const DeliveryMode = z.enum(["urgent", "all", "summary", "off"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

/** Where things reach a person: Teams, Google Chat or email. */
export const NotificationChannel = z.enum(["email", "teams", "google-chat"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "auto": Teams if they use it, else Google Chat, else email. */
export const ChannelChoice = z.enum(["auto", "email", "teams", "google-chat"]);
/** When the morning summary arrives, "HH:MM" in their time zone. */
export const SummaryTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 08:30");
/** An IANA time zone, e.g. "Europe/Istanbul". */
export const TimeZone = z.string().refine(validTimeZone, "Unknown time zone");

export const NotificationPreferences = z.object({
  deliver: DeliveryMode.default("urgent"),
  channel: ChannelChoice.default("auto"),
  summaryAt: SummaryTime.default("08:30"),
  timeZone: TimeZone.default("Europe/Istanbul"),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

/** A change to some preferences (no defaults: what isn't given stays as it is). */
export const NotificationPreferencesPatch = z.object({
  deliver: DeliveryMode.optional(),
  channel: ChannelChoice.optional(),
  summaryAt: SummaryTime.optional(),
  timeZone: TimeZone.optional(),
});
export type NotificationPreferencesPatch = z.infer<typeof NotificationPreferencesPatch>;

export const DELIVERY_MODES: Record<DeliveryMode, { label: string; description: string }> = {
  urgent: {
    label: "Urgent at once, the rest in a morning summary",
    description: "Approvals and questions an AI employee is waiting on arrive at once; checks, notices and the day's news come in one summary each morning.",
  },
  all: { label: "Everything at once", description: "Every item arrives as it happens, and the morning summary too." },
  summary: { label: "Only a morning summary", description: "One message each morning with everything that needs you." },
  off: { label: "Only in the app", description: "Nothing arrives outside the app; see Home and Work." },
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: "Email",
  teams: "Microsoft Teams",
  "google-chat": "Google Chat",
};
