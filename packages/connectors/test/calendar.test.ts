import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTokenCache,
  freeSlots,
  googleCalendarConnector,
  isoInZone,
  microsoft365CalendarConnector,
  sandboxCalendarConnector,
  slotLabel,
  zonedInstant,
  zoneOffsetMinutes,
} from "../src/index.ts";
import { FakeFetch, json, makeCtx, run } from "./helpers.ts";

/**
 * Calendars: free times worked out the same way for every system (working hours in the time zone,
 * weekdays, soonest first, spread over days), from Outlook's and Google's free/busy, and meetings
 * booked with an online meeting link. 1 March 2027 is a Monday.
 */

const IST = "Europe/Istanbul";
const at = (iso: string) => Date.parse(iso);

describe("time zones", () => {
  it("turns wall-clock times into instants and back, across daylight saving", () => {
    expect(new Date(zonedInstant("2027-03-01", "09:00", IST)).toISOString()).toBe("2027-03-01T06:00:00.000Z");
    // New York moves to summer time on 14 March 2027.
    expect(new Date(zonedInstant("2027-03-12", "09:00", "America/New_York")).toISOString()).toBe("2027-03-12T14:00:00.000Z");
    expect(new Date(zonedInstant("2027-03-15", "09:00", "America/New_York")).toISOString()).toBe("2027-03-15T13:00:00.000Z");
    expect(zoneOffsetMinutes(at("2027-03-15T13:00:00Z"), "America/New_York")).toBe(-240);
    expect(isoInZone(at("2027-03-15T13:00:00Z"), "America/New_York")).toBe("2027-03-15T09:00:00-04:00");
    expect(isoInZone(at("2027-03-01T06:00:00Z"), IST)).toBe("2027-03-01T09:00:00+03:00");
    expect(slotLabel({ start: at("2027-03-01T06:00:00Z"), end: at("2027-03-01T07:00:00Z") }, IST)).toBe("Mon 1 Mar, 09:00–10:00");
  });
});

describe("free times", () => {
  const options = { durationMinutes: 60, timeZone: IST, workdayStart: "09:00", workdayEnd: "18:00" };
  const labels = (slots: { start: number; end: number }[]) => slots.map((s) => slotLabel(s, IST));

  it("finds the soonest times nobody is busy, two a day at most", () => {
    const busy = [
      { start: at("2027-03-01T06:00:00Z"), end: at("2027-03-01T07:30:00Z") }, // Ayşe 09:00–10:30
      { start: at("2027-03-01T07:30:00Z"), end: at("2027-03-01T09:00:00Z") }, // Can 10:30–12:00
    ];
    const slots = freeSlots({ ...options, busy, from: at("2027-02-28T21:00:00Z"), to: at("2027-03-03T20:59:00Z") });
    expect(labels(slots)).toEqual([
      "Mon 1 Mar, 12:00–13:00",
      "Mon 1 Mar, 14:00–15:00",
      "Tue 2 Mar, 09:00–10:00",
      "Tue 2 Mar, 11:00–12:00",
      "Wed 3 Mar, 09:00–10:00",
    ]);
  });

  it("skips weekends, starts on the half hour, and stays in working hours", () => {
    const slots = freeSlots({ ...options, busy: [], from: at("2027-03-05T13:10:00Z"), to: at("2027-03-08T20:59:00Z"), perDay: 1 });
    // Friday from 16:10 → 16:30; then Monday.
    expect(labels(slots)).toEqual(["Fri 5 Mar, 16:30–17:30", "Mon 8 Mar, 09:00–10:00"]);
    expect(freeSlots({ ...options, durationMinutes: 600, busy: [], from: at("2027-03-01T00:00:00Z"), to: at("2027-03-02T00:00:00Z") })).toEqual([]);
  });
});

describe("microsoft-365-calendar", () => {
  beforeEach(() => clearTokenCache());
  const TOKEN_URL = "https://login.microsoftonline.com/acme.onmicrosoft.com/oauth2/v2.0/token";
  const ORGANIZER = "https://graph.microsoft.com/v1.0/users/recruiting%40acme.example";
  const ctxFor = (fake: FakeFetch) =>
    makeCtx({
      fetch: fake.fetch,
      config: { tenant_id: "acme.onmicrosoft.com", client_id: "eb-calendar", organizer: "recruiting@acme.example" },
      secrets: { client_secret: "graph-secret" },
    });
  const token = (fake: FakeFetch) => fake.on("POST", TOKEN_URL, json({ token_type: "Bearer", expires_in: 3599, access_token: "graph-token" }));

  it("finds free times from the attendees' Outlook free/busy, and says whose it couldn't read", async () => {
    const fake = token(new FakeFetch()).on(
      "POST",
      `${ORGANIZER}/calendar/getSchedule`,
      json({
        value: [
          {
            scheduleId: "ayse@acme.example",
            scheduleItems: [
              {
                status: "busy",
                start: { dateTime: "2027-03-01T06:00:00.0000000", timeZone: "UTC" },
                end: { dateTime: "2027-03-01T08:00:00.0000000", timeZone: "UTC" },
              },
              {
                status: "free",
                start: { dateTime: "2027-03-01T08:00:00.0000000", timeZone: "UTC" },
                end: { dateTime: "2027-03-01T15:00:00.0000000", timeZone: "UTC" },
              },
            ],
          },
          { scheduleId: "can@acme.example", error: { message: "The mailbox was not found", responseCode: "ErrorMailboxNotFound" } },
        ],
      }),
    );
    const result = await run(
      microsoft365CalendarConnector,
      "find_free_times",
      { attendees: ["Ayse@acme.example", "can@acme.example"], duration_minutes: 60, from: "2027-03-01", to: "2027-03-01" },
      ctxFor(fake),
    );
    expect(result).toMatchObject({
      time_zone: IST,
      slots: [
        { start: "2027-03-01T11:00:00+03:00", end: "2027-03-01T12:00:00+03:00", label: "Mon 1 Mar, 11:00–12:00" },
        { start: "2027-03-01T13:00:00+03:00", label: "Mon 1 Mar, 13:00–14:00" },
      ],
      checked: ["ayse@acme.example"],
      not_checked: ["can@acme.example"],
    });
    const request = fake.calls[1]!;
    expect(request.headers.get("prefer")).toBe('outlook.timezone="UTC"');
    expect(request.headers.get("authorization")).toBe("Bearer graph-token");
    expect(request.json).toEqual({
      schedules: ["ayse@acme.example", "can@acme.example"],
      startTime: { dateTime: "2027-02-28T21:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2027-03-01T20:59:00", timeZone: "UTC" },
      availabilityViewInterval: 30,
    });
  });

  it("books a meeting with a Teams link", async () => {
    const fake = token(new FakeFetch()).on(
      "POST",
      `${ORGANIZER}/events`,
      json({
        id: "AAMkEv1",
        webLink: "https://outlook.office365.com/owa/?itemid=AAMkEv1",
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      }),
    );
    const result = await run(
      microsoft365CalendarConnector,
      "book_meeting",
      {
        subject: "Interview: Deniz Kaya",
        start: "2027-03-01T11:00:00+03:00",
        duration_minutes: 45,
        attendees: ["ayse@acme.example", "deniz@example.com"],
        body: "Welcome!",
      },
      ctxFor(fake),
    );
    expect(result).toMatchObject({
      event_id: "AAMkEv1",
      start: "2027-03-01T11:00:00+03:00",
      end: "2027-03-01T11:45:00+03:00",
      label: "Mon 1 Mar, 11:00–11:45",
      join_url: "https://teams.microsoft.com/l/meetup-join/abc",
    });
    expect(fake.calls[1]!.json).toMatchObject({
      subject: "Interview: Deniz Kaya",
      start: { dateTime: "2027-03-01T08:00:00", timeZone: "UTC" },
      end: { dateTime: "2027-03-01T08:45:00", timeZone: "UTC" },
      attendees: [
        { emailAddress: { address: "ayse@acme.example" }, type: "required" },
        { emailAddress: { address: "deniz@example.com" }, type: "required" },
      ],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    });
  });
});

describe("google-calendar", () => {
  beforeEach(() => clearTokenCache());
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const ctxFor = (fake: FakeFetch) =>
    makeCtx({
      fetch: fake.fetch,
      config: { organizer: "recruiting@acme.example", time_zone: IST },
      secrets: {
        service_account_key: JSON.stringify({
          client_email: "brain@acme.iam.gserviceaccount.com",
          private_key: key.privateKey,
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      },
    });
  /** The token service checks the service account's signed request, acting for the organizer. */
  const token = (fake: FakeFetch) =>
    fake.on("POST", "https://oauth2.googleapis.com/token", (request) => {
      const [header, payload, signature] = request.form!.get("assertion")!.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      const valid = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(key.publicKey, Buffer.from(signature!, "base64url"));
      expect(valid).toBe(true);
      expect(claims).toMatchObject({
        iss: "brain@acme.iam.gserviceaccount.com",
        sub: "recruiting@acme.example",
        scope: "https://www.googleapis.com/auth/calendar",
        aud: "https://oauth2.googleapis.com/token",
      });
      return json({ access_token: "calendar-token", token_type: "Bearer", expires_in: 3600 });
    });

  it("finds free times from Google free/busy", async () => {
    const fake = token(new FakeFetch()).on(
      "POST",
      "https://www.googleapis.com/calendar/v3/freeBusy",
      json({
        calendars: {
          "ayse@acme.example": { busy: [{ start: "2027-03-01T06:00:00Z", end: "2027-03-01T08:00:00Z" }] },
          "can@acme.example": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
        },
      }),
    );
    const result = await run(
      googleCalendarConnector,
      "find_free_times",
      { attendees: ["ayse@acme.example", "can@acme.example"], duration_minutes: 60, from: "2027-03-01", to: "2027-03-01" },
      ctxFor(fake),
    );
    expect(result).toMatchObject({ slots: [{ label: "Mon 1 Mar, 11:00–12:00" }, { label: "Mon 1 Mar, 13:00–14:00" }], not_checked: ["can@acme.example"] });
    expect(fake.calls[1]!.json).toEqual({
      timeMin: "2027-02-28T21:00:00.000Z",
      timeMax: "2027-03-01T20:59:00.000Z",
      items: [{ id: "ayse@acme.example" }, { id: "can@acme.example" }],
    });
  });

  it("books a meeting with a Google Meet link and invites everyone", async () => {
    const fake = token(new FakeFetch()).on(
      "POST",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      json({ id: "ev1", htmlLink: "https://calendar.google.com/event?eid=ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" }),
    );
    const result = await run(
      googleCalendarConnector,
      "book_meeting",
      { subject: "Interview", start: "2027-03-01T11:00:00+03:00", attendees: ["ayse@acme.example"], optional_attendees: ["can@acme.example"] },
      ctxFor(fake),
    );
    expect(result).toMatchObject({ event_id: "ev1", join_url: "https://meet.google.com/abc-defg-hij", end: "2027-03-01T12:00:00+03:00" });
    const request = fake.calls[1]!;
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ sendUpdates: "all", conferenceDataVersion: "1" });
    expect(request.json).toMatchObject({
      summary: "Interview",
      start: { dateTime: "2027-03-01T08:00:00.000Z", timeZone: IST },
      attendees: [{ email: "ayse@acme.example" }, { email: "can@acme.example", optional: true }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
  });
});

describe("sandbox-calendar", () => {
  it("gives everyone usual meetings, and counts meetings booked in it as busy", async () => {
    const ctx = makeCtx();
    const find = () =>
      run(
        sandboxCalendarConnector,
        "find_free_times",
        { attendees: ["ayse.yilmaz@acme.com.tr", "can.demir@acme.com.tr"], duration_minutes: 60, from: "2027-03-01", to: "2027-03-02" },
        ctx,
      );
    const first = await find();
    expect(first.slots.length).toBeGreaterThan(0);
    // Lunch is nobody's meeting time.
    expect(first.slots.every((s: { label: string }) => !/12:30|13:00–14:00/.test(s.label.split(", ")[1]!.slice(0, 5)))).toBe(true);
    const booked = await run(
      sandboxCalendarConnector,
      "book_meeting",
      { subject: "Interview: Deniz Kaya", start: first.slots[0].start, attendees: ["ayse.yilmaz@acme.com.tr", "can.demir@acme.com.tr"] },
      ctx,
    );
    expect(booked).toMatchObject({ event_id: "EV-0001", join_url: "https://meet.sandbox.example/EV-0001", start: first.slots[0].start });
    const again = await find();
    expect(again.slots.map((s: { start: string }) => s.start)).not.toContain(first.slots[0].start);
    const listed = await run(sandboxCalendarConnector, "list_events", { from: "2027-03-01", to: "2027-03-02" }, ctx);
    expect(listed.items).toEqual([expect.objectContaining({ event_id: "EV-0001", subject: "Interview: Deniz Kaya" })]);
    await run(sandboxCalendarConnector, "cancel_meeting", { event_id: "EV-0001" }, ctx);
    expect((await find()).slots.map((s: { start: string }) => s.start)).toContain(first.slots[0].start);
  });
});
