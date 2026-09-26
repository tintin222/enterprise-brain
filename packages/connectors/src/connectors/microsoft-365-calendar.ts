import { defineConnector, defineManifest } from "../define.ts";
import { odataV4Collection } from "../http.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { isRecord, optString, reqString, requireConfig, type Rec } from "../util.ts";
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
import { ENTRA_CONFIG, graphRequest } from "./microsoft.ts";

const SERVICE = "Microsoft 365 Calendar";
const UTC_PREFERENCE = { prefer: 'outlook.timezone="UTC"' };
/** Free/busy statuses that keep someone from a meeting. */
const BUSY = new Set(["busy", "tentative", "oof"]);
const DAY = 24 * 3600_000;

function organizerPath(ctx: ConnectorContext): string {
  return `/users/${encodeURIComponent(requireConfig(ctx, "organizer", "Calendar (organizer)"))}`;
}

/** Graph's { dateTime: "2026-10-06T07:00:00.0000000", timeZone: "UTC" } as an instant. */
function graphTime(value: unknown): number {
  const record = isRecord(value) ? value : {};
  const text = typeof record.dateTime === "string" ? record.dateTime.slice(0, 19) : "";
  const zone = typeof record.timeZone === "string" ? record.timeZone : "UTC";
  if (zone !== "UTC") throw new ConnectorError(`Unexpected time zone ${zone} in a Graph answer`, "remote");
  return Date.parse(`${text}Z`);
}

function utc(instant: number): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(instant).toISOString().slice(0, 19), timeZone: "UTC" };
}

function event(item: Rec, timeZone: string) {
  const attendees = Array.isArray(item.attendees) ? item.attendees : [];
  const online = isRecord(item.onlineMeeting) ? item.onlineMeeting : {};
  return {
    event_id: item.id,
    subject: item.subject,
    start: isoInZone(graphTime(item.start), timeZone),
    end: isoInZone(graphTime(item.end), timeZone),
    attendees: attendees.map((a) => (isRecord(a) && isRecord(a.emailAddress) ? a.emailAddress.address : null)).filter(Boolean),
    location: isRecord(item.location) ? (item.location.displayName ?? null) : null,
    join_url: typeof online.joinUrl === "string" ? online.joinUrl : null,
    web_link: item.webLink ?? null,
  };
}

export const microsoft365CalendarConnector = defineConnector({
  manifest: defineManifest({
    type: "microsoft-365-calendar",
    name: "Microsoft 365 Calendar (Outlook)",
    vendor: "Microsoft",
    category: "calendar",
    description:
      "Finds times when people are free (their Outlook free/busy) and books meetings with a Teams link from one calendar, such as recruiting@ for interviews, through Microsoft Graph with an app registration.",
    auth: "oauth2-client-credentials",
    docsUrl: "https://learn.microsoft.com/graph/api/calendar-getschedule",
    maturity: "preview",
    config: [
      ...ENTRA_CONFIG,
      {
        key: "organizer",
        label: "Calendar (organizer)",
        type: "string",
        required: true,
        placeholder: "recruiting@acme.com",
        help: "The mailbox whose calendar books the meetings (a shared mailbox works); invitations come from it.",
      },
      ...CALENDAR_CONFIG_EXTRAS,
    ],
    operations: CALENDAR_OPERATIONS,
    itRequirements: [
      "A Microsoft Entra ID app registration with a client secret; provide tenant ID, client ID and the secret value",
      "Microsoft Graph application permission Calendars.ReadWrite with admin consent",
      "Scope the app to the organizer mailbox with an application access policy (free/busy of the attendees is still visible)",
      "The organizer mailbox, e.g. recruiting@company.com for interviews",
    ],
  }),
  async test(ctx) {
    const response = await graphRequest(ctx, `${organizerPath(ctx)}/calendar`, { query: { $select: "name,owner" } }, SERVICE);
    const calendar = isRecord(response.data) ? response.data : {};
    return { ok: true, message: `Connected to the calendar "${String(calendar.name ?? "Calendar")}" of ${requireConfig(ctx, "organizer")}` };
  },
  operations: {
    async find_free_times(input, ctx) {
      const query = freeTimeQuery(input, ctx);
      const response = await graphRequest(
        ctx,
        `${organizerPath(ctx)}/calendar/getSchedule`,
        {
          method: "POST",
          headers: UTC_PREFERENCE,
          json: { schedules: query.attendees, startTime: utc(query.from), endTime: utc(query.to), availabilityViewInterval: 30 },
        },
        SERVICE,
      );
      const busy: Interval[] = [];
      const unknown: string[] = [];
      for (const schedule of odataV4Collection(response.data).items) {
        const id = String(schedule.scheduleId ?? "").toLowerCase();
        if (isRecord(schedule.error)) {
          unknown.push(id);
          continue;
        }
        for (const item of Array.isArray(schedule.scheduleItems) ? schedule.scheduleItems : []) {
          if (isRecord(item) && BUSY.has(String(item.status))) busy.push({ start: graphTime(item.start), end: graphTime(item.end) });
        }
      }
      return freeTimeResult(query, busy, unknown);
    },

    async book_meeting(input, ctx) {
      const request = meetingRequest(input, ctx);
      const response = await graphRequest(
        ctx,
        `${organizerPath(ctx)}/events`,
        {
          method: "POST",
          headers: UTC_PREFERENCE,
          json: {
            subject: request.subject,
            body: { contentType: "Text", content: request.body },
            start: utc(request.start),
            end: utc(request.end),
            attendees: [
              ...request.attendees.map((address) => ({ emailAddress: { address }, type: "required" })),
              ...request.optional.map((address) => ({ emailAddress: { address }, type: "optional" })),
            ],
            ...(request.location ? { location: { displayName: request.location } } : {}),
            ...(request.online ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
            allowNewTimeProposals: true,
          },
        },
        SERVICE,
      );
      const created = isRecord(response.data) ? response.data : {};
      const online = isRecord(created.onlineMeeting) ? created.onlineMeeting : {};
      return bookedResult(request, {
        id: String(created.id ?? ""),
        webLink: typeof created.webLink === "string" ? created.webLink : null,
        joinUrl: typeof online.joinUrl === "string" ? online.joinUrl : null,
      });
    },

    async cancel_meeting(input, ctx) {
      const id = reqString(input, "event_id");
      await graphRequest(
        ctx,
        `${organizerPath(ctx)}/events/${encodeURIComponent(id)}/cancel`,
        { method: "POST", json: { comment: optString(input, "comment") ?? "" } },
        SERVICE,
      );
      return { ok: true, cancelled: id };
    },

    async list_events(input, ctx) {
      const timeZone = calendarZone(ctx, input);
      const from = parseWhen(optString(input, "from"), Date.now(), timeZone);
      const to = parseWhen(optString(input, "to"), from + 7 * DAY, timeZone, true);
      const response = await graphRequest(
        ctx,
        `${organizerPath(ctx)}/calendarView`,
        {
          headers: UTC_PREFERENCE,
          query: {
            startDateTime: new Date(from).toISOString(),
            endDateTime: new Date(to).toISOString(),
            $top: "100",
            $orderby: "start/dateTime",
            $select: "id,subject,start,end,attendees,location,onlineMeeting,webLink",
          },
        },
        SERVICE,
      );
      const items = odataV4Collection(response.data).items.map((item) => event(item, timeZone));
      return { time_zone: timeZone, count: items.length, items };
    },
  },
});
