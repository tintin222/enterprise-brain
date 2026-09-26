import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Calculations over HTTP: a manager says the rule, the Studio works it out on the real rows and shows
 * the result, the manager keeps it on a schedule; the department's people run it; IT sees the code.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("calculations over HTTP", () => {
  let t: TestApp;
  let mehmet = "";
  let zeynep = "";
  let deniz = "";
  let burak = "";
  let departmentId = "";
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  beforeAll(async () => {
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const as = async (address: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: address } }));
    mehmet = await as("mehmet.oz@acme.com.tr");
    zeynep = await as("zeynep.kaya@acme.com.tr");
    deniz = await as("deniz.aydin@acme.com.tr");
    burak = await as("burak.sahin@acme.com.tr");
    departmentId = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!.id;
    const table = {
      name: "Customer complaints",
      departmentId,
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "customer", label: "Customer", type: "text" },
        { key: "refund", label: "Refund", type: "money", currency: "TRY" },
      ],
    };
    expect((await call(zeynep, "POST", "/tables", table)).statusCode).toBe(200);
    for (const [problem, customer, refund] of [
      ["Scratched housing", "Kaya Çelik", 1250.5],
      ["Wrong invoice", "Kaya Çelik", 320],
      ["Late parcel", "Akın Metal", 90],
    ] as const) {
      await call(deniz, "POST", "/tables/customer_complaints/records", { values: { problem, customer, refund } });
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it("works a rule out on the real rows, and keeps it on a schedule", async () => {
    const written = await call(zeynep, "POST", "/calculations/write", { rule: "Total refund by customer" });
    expect(written.statusCode, written.body).toBe(200);
    const proposal = written.json() as { draft: Record<string, unknown>; trial: { ok: boolean; result: unknown } };
    expect(proposal.trial).toMatchObject({
      ok: true,
      error: null,
      rows: 3,
      result: [
        { rank: 1, customer: "Kaya Çelik", refund: 1570.5 },
        { rank: 2, customer: "Akın Metal", refund: 90 },
      ],
    });
    expect((await call(deniz, "POST", "/calculations", { ...proposal.draft, rule: "Total refund by customer", departmentId })).statusCode).toBe(403);
    const kept = await call(zeynep, "POST", "/calculations", { ...proposal.draft, rule: "Total refund by customer", schedule: "monthly", departmentId });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({ key: "customer_ranking", schedule: "monthly", last: { status: "succeeded", by: "Zeynep Kaya" } });
  });

  it("lets its department's people run it, keeps each run, and shows the code only to IT", async () => {
    await call(deniz, "POST", "/tables/customer_complaints/records", { values: { problem: "Dent", customer: "Akın Metal", refund: 10 } });
    const ran = await call(deniz, "POST", "/calculations/customer_ranking/run");
    expect(ran.json()).toMatchObject({
      status: "succeeded",
      by: "Deniz Aydın",
      rows: 4,
      result: [{ customer: "Kaya Çelik" }, { customer: "Akın Metal", refund: 100 }],
    });
    const detail = (await call(deniz, "GET", "/calculations/customer_ranking")).json() as {
      runs: unknown[];
      code?: string;
      calculation: { can: { design: boolean } };
    };
    expect(detail.runs).toHaveLength(2);
    expect(detail.code).toBeUndefined();
    expect(detail.calculation.can.design).toBe(false);
    expect(((await call(mehmet, "GET", "/calculations/customer_ranking")).json() as { code?: string }).code).toContain("tables[");
    expect((await call(burak, "GET", "/calculations/customer_ranking")).statusCode).toBe(404);
    expect((await call(burak, "GET", "/calculations")).json()).toEqual([]);
    expect((await call(deniz, "PATCH", "/calculations/customer_ranking", { schedule: null })).statusCode).toBe(403);
    expect((await call(zeynep, "PATCH", "/calculations/customer_ranking", { schedule: null })).json()).toMatchObject({ schedule: null });
  });

  it("says when a rule can't be worked out without the model", async () => {
    const refused = await call(zeynep, "POST", "/calculations/write", { rule: "Predict which customers will leave next year" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: expect.stringMatching(/needs the model/) });
  });
});
