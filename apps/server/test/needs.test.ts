import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The one box over HTTP: "What do you need?" is read as work for an AI employee (now or regularly),
 * an answer, a calculation, something to make or a change; recurring work is kept and given as a
 * task on its schedule.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("the one box", () => {
  let t: TestApp;
  let companyId = "";
  let zeynep = "";
  let deniz = "";
  let burak = "";
  const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  beforeAll(async () => {
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const as = async (address: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: address } }));
    zeynep = await as("zeynep.kaya@acme.com.tr");
    deniz = await as("deniz.aydin@acme.com.tr");
    burak = await as("burak.sahin@acme.com.tr");
    const departmentId = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!.id;
    await call(zeynep, "POST", "/tables", {
      name: "Complaints",
      departmentId,
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "customer", label: "Customer", type: "text" },
        { key: "status", label: "Status", type: "choice", choices: ["Open", "Done"], default: "Open" },
      ],
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("gives work to the AI employee it names, and says who may make things", async () => {
    const need = await call(deniz, "POST", "/needs", { text: "Mail Triage: reply to Kaya Çelik about the late parcel" });
    expect(need.statusCode, need.body).toBe(200);
    expect(need.json()).toMatchObject({
      kind: "task",
      agent: "customer-service-mail-triage",
      agentName: "Mail Triage",
      work: "Reply to Kaya Çelik about the late parcel",
      summary: "Mail Triage does it now, as a task you can follow",
      can: { build: false },
    });
    expect((need.json() as { workers: { slug: string }[] }).workers.map((w) => w.slug)).toContain("customer-service-returns-agent");
    // Another department's AI employees aren't Deniz's to give work to.
    expect((need.json() as { workers: { slug: string }[] }).workers.map((w) => w.slug)).not.toContain("finance-invoice-processor");

    const table = (await call(zeynep, "POST", "/needs", { text: "Add Root cause to the Complaints table" })).json();
    expect(table).toMatchObject({ kind: "change", target: { type: "table", key: "complaints" }, change: "Add Root cause", can: { build: true, change: true } });
    expect((await call(zeynep, "POST", "/needs", { text: "I need a register of supplier complaints", as: "table" })).json()).toMatchObject({
      kind: "table",
      summary: "A new table: you see its fields before it is made",
    });
  });

  it("makes work recurring, and gives it as a task on its day, once", async () => {
    const need = (await call(deniz, "POST", "/needs", { text: "Every Monday at 9, send me the open complaints" })).json() as {
      kind: string;
      agent: string;
      work: string;
      schedule: unknown;
      when: string;
    };
    expect(need).toMatchObject({
      kind: "recurring",
      work: "Send me the open complaints",
      when: "every Monday at 09:00",
      schedule: { every: "week", weekday: 1, time: "09:00" },
    });
    const made = await call(deniz, "POST", "/recurring", { agent: need.agent, text: need.work, schedule: need.schedule });
    expect(made.statusCode, made.body).toBe(200);
    const recurring = made.json() as { id: string; agent: { slug: string } };
    expect(recurring).toMatchObject({ when: "every Monday at 09:00", by: "Deniz Aydın", text: "Send me the open complaints", agent: { slug: need.agent } });
    expect(((await call(deniz, "GET", "/recurring")).json() as unknown[]).length).toBe(1);
    expect(((await call(zeynep, "GET", `/agents/${need.agent}`)).json() as { recurring: unknown[] }).recurring).toHaveLength(1);

    // Its time: Monday 28 September 2026, 09:00 in Istanbul.
    await t.platform.recurring.runDue(new Date("2026-09-28T05:59:00Z"));
    const started = await t.platform.recurring.runDue(new Date("2026-09-28T06:00:00Z"));
    expect(started).toHaveLength(1);
    const task = await t.platform.tasks.get(companyId, started[0]!.taskId!);
    expect(task).toMatchObject({ source: "recurring", requestedBy: "Deniz Aydın", title: expect.stringContaining("Send me the open complaints") });
    expect(await t.platform.recurring.runDue(new Date("2026-09-28T06:01:00Z"))).toHaveLength(0);

    // Stopped by whoever asked or its manager; other departments don't see it.
    expect((await call(burak, "POST", `/recurring/${recurring.id}/stop`)).statusCode).toBe(404);
    const stopped = await call(zeynep, "POST", `/recurring/${recurring.id}/stop`);
    expect(stopped.json()).toMatchObject({ stoppedBy: "Zeynep Kaya" });
    expect(await t.platform.recurring.runDue(new Date("2026-10-05T06:00:00Z"))).toHaveLength(0);
  });
});
