import { randomUUID } from "node:crypto";
import { defineConnector, defineManifest } from "../define.ts";
import { getServiceAccountToken, httpRequest, parseServiceAccountKey, withTokenRetry, type HttpRequestOptions, type HttpResponse } from "../http.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { isRecord, optString, reqString, requireConfig, requireSecret, type Rec } from "../util.ts";
import {
  bookedResult,
  CALENDAR_CONFIG_EXTRAS,
  CALENDAR_OPERATIONS,
  calendarZone,
  freeTimeQuery,
  freeTimeResult,
  isoInZone,
  meetingRequest,
  parseWhen,
  type Interval,
} from "./calendar-common.ts";

const SERVICE = "Google Calendar";
const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const DAY = 24 * 3600_000;

/** Calendar API calls as the organizer (the service account acts for them by domain-wide delegation). */
function calendarRequest<T = unknown>(ctx: ConnectorContext, path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const key = parseServiceAccountKey(requireSecret(ctx, "service_account_key", "Service account key"));
  const subject = requireConfig(ctx, "organizer", "Calendar (organizer)");
  return withTokenRetry(
    (force) => getServiceAccountToken(ctx.fetch, { key, scope: CALENDAR_SCOPE, subject, service: SERVICE }, force),
    (token) =>
      httpRequest<T>(ctx.fetch, `${API}${path}`, {
        ...options,
        service: SERVICE,
        headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` },
      }),
  );
}

function when(value: unknown): number {
  const record = isRecord(value) ? value : {};
  const text = typeof record.dateTime === "string" ? record.dateTime : typeof record.date === "string" ? `${record.date}T00:00:00Z` : "";
  const instant = Date.parse(text);
  if (Number.isNaN(instant)) throw new ConnectorError(`Unreadable time in a Google Calendar answer: ${JSON.stringify(value)}`, "remote");
  return instant;
}

export const googleCalendarConnector = defineConnector({
  manifest: defineManifest({
    type: "google-calendar",
    name: "Google Calendar",
    vendor: "Google",
    category: "calendar",
    description:
      "Finds times when people are free (their Google Calendar free/busy) and books meetings with a Google Meet link from one calendar, such as recruiting@ for interviews, as a service account acting for that calendar's owner.",
    auth: "custom",
    docsUrl: "https://developers.google.com/calendar/api/v3/reference/freebusy/query",
    maturity: "preview",
    config: [
      {
        key: "service_account_key",
        label: "Service account key (JSON)",
        type: "textarea",
        required: true,
        secret: true,
        help: "A JSON key of a service account with domain-wide delegation for the Calendar scope.",
      },
      {
        key: "organizer",
        label: "Calendar (organizer)",
        type: "string",
        required: true,
        placeholder: "recruiting@acme.com",
        help: "The Google Workspace user whose calendar books the meetings; invitations come from them.",
      },
      ...CALENDAR_CONFIG_EXTRAS,
    ],
    operations: CALENDAR_OPERATIONS,
    itRequirements: [
      "A Google Cloud service account with a JSON key, and the Google Calendar API turned on",
      "Domain-wide delegation for that service account with the scope https://www.googleapis.com/auth/calendar (Admin console → Security → API controls)",
      "The Workspace user whose calendar books the meetings, e.g. recruiting@company.com",
    ],
  }),
  async test(ctx) {
    const organizer = requireConfig(ctx, "organizer", "Calendar (organizer)");
    const response = await calendarRequest<Rec>(ctx, `/calendars/primary`);
    return { ok: true, message: `Connected to the calendar of ${organizer}${response.data?.timeZone ? ` (${String(response.data.timeZone)})` : ""}` };
  },
  operations: {
    async find_free_times(input, ctx) {
      const query = freeTimeQuery(input, ctx);
      const response = await calendarRequest<Rec>(ctx, "/freeBusy", {
        method: "POST",
        json: { timeMin: new Date(query.from).toISOString(), timeMax: new Date(query.to).toISOString(), items: query.attendees.map((id) => ({ id })) },
      });
      const calendars = isRecord(response.data?.calendars) ? response.data.calendars : {};
      const busy: Interval[] = [];
      const unknown: string[] = [];
      for (const attendee of query.attendees) {
        const calendar = Object.entries(calendars).find(([id]) => id.toLowerCase() === attendee)?.[1];
        if (!isRecord(calendar) || (Array.isArray(calendar.errors) && calendar.errors.length)) {
          unknown.push(attendee);
          continue;
        }
        for (const period of Array.isArray(calendar.busy) ? calendar.busy : []) {
          if (isRecord(period)) busy.push({ start: Date.parse(String(period.start)), end: Date.parse(String(period.end)) });
        }
      }
      return freeTimeResult(query, busy, unknown);
    },

    async book_meeting(input, ctx) {
      const request = meetingRequest(input, ctx);
      const response = await calendarRequest<Rec>(ctx, "/calendars/primary/events", {
        method: "POST",
        query: { sendUpdates: "all", conferenceDataVersion: request.online ? "1" : "0" },
        json: {
          summary: request.subject,
          description: request.body,
          ...(request.location ? { location: request.location } : {}),
          start: { dateTime: new Date(request.start).toISOString(), timeZone: request.timeZone },
          end: { dateTime: new Date(request.end).toISOString(), timeZone: request.timeZone },
          attendees: [...request.attendees.map((email) => ({ email })), ...request.optional.map((email) => ({ email, optional: true }))],
          ...(request.online ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
        },
      });
      const created = response.data ?? {};
      return bookedResult(request, {
        id: String(created.id ?? ""),
        webLink: typeof created.htmlLink === "string" ? created.htmlLink : null,
        joinUrl: typeof created.hangoutLink === "string" ? created.hangoutLink : null,
      });
    },

    async cancel_meeting(input, ctx) {
      const id = reqString(input, "event_id");
      await calendarRequest(ctx, `/calendars/primary/events/${encodeURIComponent(id)}`, {
        method: "DELETE",
        query: { sendUpdates: "all" },
        responseType: "text",
      });
      return { ok: true, cancelled: id };
    },

    async list_events(input, ctx) {
      const timeZone = calendarZone(ctx, input);
      const from = parseWhen(optString(input, "from"), Date.now(), timeZone);
      const to = parseWhen(optString(input, "to"), from + 7 * DAY, timeZone, true);
      const response = await calendarRequest<Rec>(ctx, "/calendars/primary/events", {
        query: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" },
      });
      const items = (Array.isArray(response.data?.items) ? response.data.items : []).filter(isRecord).map((item) => ({
        event_id: item.id,
        subject: item.summary ?? null,
        start: isoInZone(when(item.start), timeZone),
        end: isoInZone(when(item.end), timeZone),
        attendees: (Array.isArray(item.attendees) ? item.attendees : []).map((a) => (isRecord(a) ? a.email : null)).filter(Boolean),
        location: item.location ?? null,
        join_url: item.hangoutLink ?? null,
        web_link: item.htmlLink ?? null,
      }));
      return { time_zone: timeZone, count: items.length, items };
    },
  },
});
