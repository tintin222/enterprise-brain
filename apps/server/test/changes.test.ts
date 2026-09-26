import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Changes in plain words over HTTP: a table, an app, a calculation and an AI employee are changed by
 * saying what should change; each change is shown in plain words and checked before it goes live.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("changes in plain words", () => {
  let t: TestApp;
  let zeynep = "";
  let deniz = "";
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
    departmentId = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!.id;
    await call(zeynep, "POST", "/tables", {
      name: "Complaints",
      departmentId,
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "customer", label: "Customer", type: "text" },
        { key: "status", label: "Status", type: "choice", choices: ["Open", "Done"], default: "Open" },
      ],
    });
    for (const [problem, customer, status] of [
      ["Scratched housing", "Kaya Çelik", "Open"],
      ["Wrong invoice", "Kaya Çelik", "Done"],
      ["Late parcel", "Akın Metal", "Done"],
    ]) {
      await call(deniz, "POST", "/tables/complaints/records", { values: { problem, customer, status } });
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it("changes a table: says what changes, checks the records, and renames a value in every record", async () => {
    expect((await call(deniz, "POST", "/tables/complaints/changes", { request: "add Root cause" })).statusCode).toBe(403);
    const proposed = await call(zeynep, "POST", "/tables/complaints/changes", { request: "rename Done to Closed and add Root cause" });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const change = proposed.json() as { design: { fields: unknown[] }; renames: Record<string, Record<string, string>>; summary: string[]; problems: string[] };
    expect(change.summary).toEqual(["Status: “Done” becomes “Closed” in every record", "Adds Root cause (longer text)"]);
    expect(change.problems).toEqual([]);
    const applied = await call(zeynep, "PATCH", "/tables/complaints", { fields: change.design.fields, renames: change.renames });
    expect(applied.statusCode, applied.body).toBe(200);
    const closed = (await call(deniz, "GET", "/tables/complaints/records?filter.status=Closed")).json() as { total: number };
    expect(closed.total).toBe(2);

    const wouldBreak = (await call(zeynep, "POST", "/tables/complaints/changes", { request: "make Problem a number" })).json() as { problems: string[] };
    expect(wouldBreak.problems).toEqual(["#1: Problem: give a number", "#2: Problem: give a number", "#3: Problem: give a number"]);
  });

  it("changes an app: the new pages in plain words, checked against the tables", async () => {
    const made = await call(zeynep, "POST", "/apps", {
      name: "Complaint desk",
      departmentId,
      pages: [{ key: "add", title: "Add", blocks: [{ type: "form", table: "complaints" }] }],
    });
    expect(made.statusCode, made.body).toBe(200);
    const proposed = (await call(zeynep, "POST", "/apps/complaint_desk/changes", { request: "add a chart of complaints by status and a board" })).json() as {
      pages: { key: string }[];
      summary: string[];
      problems: string[];
    };
    expect(proposed.summary).toEqual([
      "Adds the page “Overview”: A bar chart of how many Complaints by Status",
      "Adds the page “Board”: A board of Complaints in columns by Status: moving a card changes it",
    ]);
    expect(proposed.problems).toEqual([]);
    const applied = await call(zeynep, "PATCH", "/apps/complaint_desk", { pages: proposed.pages });
    expect(applied.json()).toMatchObject({ version: 2 });
  });

  it("changes a calculation: the rule as it becomes, worked out again next to the current result", async () => {
    const written = (await call(zeynep, "POST", "/calculations/write", { rule: "Count complaints by status" })).json() as { draft: Record<string, unknown> };
    await call(zeynep, "POST", "/calculations", { ...written.draft, rule: "Count complaints by status", departmentId });
    const proposed = (await call(zeynep, "POST", "/calculations/status_ranking/changes", { request: "Count complaints by customer" })).json() as {
      rule: string;
      draft: Record<string, unknown>;
      trial: { ok: boolean; result: unknown };
      before: { result: unknown };
    };
    expect(proposed.rule).toBe("Count complaints by customer");
    expect(proposed.before.result).toEqual([
      { rank: 1, status: "Closed", complaints: 2 },
      { rank: 2, status: "Open", complaints: 1 },
    ]);
    expect(proposed.trial.result).toEqual([
      { rank: 1, customer: "Kaya Çelik", complaints: 2 },
      { rank: 2, customer: "Akın Metal", complaints: 1 },
    ]);
    const applied = await call(zeynep, "PATCH", "/calculations/status_ranking", { ...proposed.draft, rule: proposed.rule });
    expect(applied.json()).toMatchObject({ rule: "Count complaints by customer", version: 2 });
  });

  it("changes an AI employee as coaching does: rules, a new version, tested on recent tasks first", async () => {
    const changed = await call(zeynep, "POST", "/agents/customer-service-mail-triage/changes", {
      request: "Reply in Turkish when the customer writes in Turkish",
      wait: true,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      status: "ready",
      rules: ["Reply in Turkish when the customer writes in Turkish"],
      notes: [{ kind: "change", by: "Zeynep Kaya" }],
    });
    expect((await call(deniz, "POST", "/agents/customer-service-mail-triage/changes", { request: "Be faster" })).statusCode).toBe(403);
  });
});
