import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Mail, the shared mailboxes AI employees follow: managers and IT see them all; the people of a
 * department read the ones their department's AI employees follow, and nothing else.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("who reads which shared mailbox", () => {
  let t: TestApp;
  const as: Record<string, string> = {};
  const get = (who: string, url: string) => t.app.inject({ method: "GET", url: `${base}${url}`, headers: { cookie: as[who]! } });
  const boxesOf = async (who: string) => ((await get(who, "/mail/mailboxes")).json() as { mailbox: string }[]).map((b) => b.mailbox);

  beforeAll(async () => {
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    for (const local of ["can.demir", "elif.arslan", "burak.sahin", "mehmet.oz"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it("shows the people of a department their AI employees' mailboxes", async () => {
    const hr = await boxesOf("can.demir");
    expect(hr).toContain("careers@acme.com.tr");
    expect(hr).not.toContain("invoices@acme.com.tr");
    const finance = await boxesOf("elif.arslan");
    expect(finance).toContain("invoices@acme.com.tr");
    expect(finance).not.toContain("careers@acme.com.tr");

    const messages = (await get("can.demir", "/mail/messages?direction=inbound")).json() as { id: string; mailbox: string }[];
    expect(messages.length).toBeGreaterThan(0);
    expect(new Set(messages.map((m) => m.mailbox))).toEqual(new Set(hr));
    const one = await get("can.demir", `/mail/messages/${messages[0]!.id}`);
    expect(one.statusCode, one.body).toBe(200);
  });

  it("keeps other departments' mail from them, and leaves test emails and processing to managers", async () => {
    expect((await get("can.demir", "/mail/messages?mailbox=invoices@acme.com.tr")).statusCode).toBe(403);
    const invoices = (await get("elif.arslan", "/mail/messages?mailbox=invoices@acme.com.tr")).json() as { id: string }[];
    expect(invoices.length).toBeGreaterThan(0);
    expect((await get("can.demir", `/mail/messages/${invoices[0]!.id}`)).statusCode).toBe(403);

    const send = await t.app.inject({
      method: "POST",
      url: `${base}/mail/messages`,
      headers: { cookie: as["can.demir"]! },
      payload: { mailbox: "careers@acme.com.tr", from: "someone@example.com", subject: "Hello", body: "Hi", route: false },
    });
    expect(send.statusCode).toBe(403);
  });

  it("shows managers and IT every mailbox", async () => {
    const all = await boxesOf("mehmet.oz");
    expect(all).toEqual(expect.arrayContaining(["careers@acme.com.tr", "invoices@acme.com.tr"]));
    expect(new Set(await boxesOf("burak.sahin"))).toEqual(new Set(all));
  });
});
