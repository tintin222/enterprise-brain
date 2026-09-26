import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Apps over HTTP: a manager describes the screens in one sentence, the Studio proposes the app and the
 * table it needs, the app is made with its table, its department's people use it, and an app that
 * wouldn't work is refused without leaving its table behind.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("apps over HTTP", () => {
  let t: TestApp;
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
    zeynep = await as("zeynep.kaya@acme.com.tr");
    deniz = await as("deniz.aydin@acme.com.tr");
    burak = await as("burak.sahin@acme.com.tr");
    departmentId = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("proposes an app and its table from one sentence, and makes both", async () => {
    const proposed = await call(zeynep, "POST", "/apps/propose", {
      description: "Customer complaints: customer, order number, problem, owner, log a complaint, see the open ones by customer, close them",
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposal = proposed.json() as {
      design: { name: string; pages: unknown[] };
      tables: { key: string }[];
      outline: { title: string; blocks: string[] }[];
    };
    expect(proposal.tables.map((x) => x.key)).toEqual(["customer_complaints"]);
    expect(proposal.outline).toEqual([
      { key: "log_a_complaint", title: "Log a complaint", blocks: ["A form that adds to Customer complaints"] },
      {
        key: "open_ones_by_customer",
        title: "Open ones by customer",
        blocks: [
          "A list of Customer complaints whose Status is Open, in groups by Customer, showing Customer, Order number, Problem, Owner, Status, with a search box, to Close",
        ],
      },
    ]);
    expect((await call(deniz, "POST", "/apps", { ...proposal.design, tables: proposal.tables, departmentId })).statusCode).toBe(403);
    const made = await call(zeynep, "POST", "/apps", { ...proposal.design, tables: proposal.tables, departmentId });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json()).toMatchObject({ key: "customer_complaints", madeTables: ["customer_complaints"] });
  });

  it("gives its department's people the app with its tables and their rights", async () => {
    const opened = await call(deniz, "GET", "/apps/customer_complaints");
    expect(opened.statusCode, opened.body).toBe(200);
    const body = opened.json() as { app: { can: { design: boolean } }; tables: { key: string; can: { edit: boolean } }[] };
    expect(body.app.can.design).toBe(false);
    expect(body.tables.map((x) => [x.key, x.can.edit])).toEqual([["customer_complaints", true]]);
    for (const [problem, customer, status] of [
      ["Scratched housing", "Kaya Çelik", "Open"],
      ["Wrong invoice", "Kaya Çelik", "Open"],
      ["Late parcel", "Akın Metal", "Closed"],
    ]) {
      expect((await call(deniz, "POST", "/tables/customer_complaints/records", { values: { problem, customer, status } })).statusCode).toBe(200);
    }
    const summary = await call(deniz, "GET", "/tables/customer_complaints/summary?groupBy=customer&filter.status=open");
    expect(summary.json()).toEqual({ total: 2, groups: [{ key: "Kaya Çelik", label: "Kaya Çelik", value: 2 }] });
    expect((await call(burak, "GET", "/apps")).json()).toEqual([]);
    expect((await call(burak, "GET", "/apps/customer_complaints")).statusCode).toBe(404);
    expect((await call(deniz, "PATCH", "/apps/customer_complaints", { name: "Complaints" })).statusCode).toBe(403);
    const renamed = await call(zeynep, "PATCH", "/apps/customer_complaints", { name: "Complaint desk", settings: { visibility: "company" } });
    expect(renamed.json()).toMatchObject({ name: "Complaint desk", version: 1 });
    expect(((await call(burak, "GET", "/apps")).json() as { name: string }[]).map((a) => a.name)).toEqual(["Complaint desk"]);
  });

  it("refuses an app that wouldn't work and takes back the table made for it", async () => {
    const refused = await call(zeynep, "POST", "/apps", {
      name: "Returns",
      departmentId,
      tables: [{ key: "returns", name: "Returns", fields: [{ key: "item", label: "Item", type: "text" }] }],
      pages: [{ key: "board", title: "Board", blocks: [{ type: "board", table: "returns", groupBy: "item" }] }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ problems: ["Board, block 1: a board's columns are one of a list; Item is not"] });
    expect(((await call(zeynep, "GET", "/tables")).json() as { key: string }[]).map((x) => x.key)).toEqual(["customer_complaints"]);
  });
});
