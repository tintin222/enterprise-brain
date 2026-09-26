import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renamesBack } from "../src/routes/building.ts";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The rules for building over HTTP: IT decides who may build; personal data waits for the data
 * protection officer; sharing beyond a department waits for IT; everything has versions and a way
 * back; IT sees everything built, with its owner.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Table {
  id: string;
  key: string;
  version: number;
  personal: { approved: string[]; waiting: string[] };
  reviews: { id: string; kind: string; what: string }[];
  can: { design: boolean };
}

describe("the rules for building", () => {
  let t: TestApp;
  let mehmet = "";
  let zeynep = "";
  let deniz = "";
  let ayse = "";
  let ayseId = "";
  let zeynepId = "";
  let departmentId = "";
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const fields = [
    { key: "problem", label: "Problem", type: "text", required: true },
    { key: "status", label: "Status", type: "choice", choices: ["Open", "Done"], default: "Open" },
  ];

  beforeAll(async () => {
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const as = async (address: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: address } }));
    mehmet = await as("mehmet.oz@acme.com.tr");
    zeynep = await as("zeynep.kaya@acme.com.tr");
    deniz = await as("deniz.aydin@acme.com.tr");
    ayse = await as("ayse.yilmaz@acme.com.tr");
    const people = await t.platform.people.list(company.id);
    ayseId = people.find((p) => p.name === "Ayşe Yılmaz")!.id;
    zeynepId = people.find((p) => p.name === "Zeynep Kaya")!.id;
    departmentId = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lets IT decide who builds: managers by default, everyone, or only IT and the people it names", async () => {
    expect((await call(deniz, "GET", "/building")).json()).toMatchObject({ who: "managers", buildsFor: [], decides: { personalData: false, sharing: false } });
    expect((await call(deniz, "POST", "/tables", { name: "Parcels", departmentId, fields })).json()).toMatchObject({
      error: "Only a manager of this department makes its tables",
    });
    expect((await call(zeynep, "PUT", "/building", { who: "everyone" })).statusCode).toBe(403);

    expect((await call(mehmet, "PUT", "/building", { who: "everyone" })).statusCode).toBe(200);
    const made = await call(deniz, "POST", "/tables", { name: "Parcels", departmentId, fields });
    expect(made.statusCode, made.body).toBe(200);
    expect((made.json() as Table).can.design).toBe(true);
    // Whoever made it changes it; a colleague's table stays theirs (and their managers').
    expect((await call(deniz, "PATCH", "/tables/parcels", { description: "Parcels that went missing" })).statusCode).toBe(200);
    await call(zeynep, "POST", "/tables", { name: "Complaints", departmentId, fields });
    expect((await call(deniz, "PATCH", "/tables/complaints", { description: "Mine now" })).statusCode).toBe(403);

    expect((await call(mehmet, "PUT", "/building", { who: "it" })).statusCode).toBe(200);
    expect((await call(zeynep, "POST", "/tables", { name: "Returns", departmentId, fields })).json()).toMatchObject({ error: "IT makes tables here; ask IT" });
    expect((await call(mehmet, "PUT", "/building", { builders: [zeynepId] })).statusCode).toBe(200);
    expect((await call(zeynep, "POST", "/tables", { name: "Returns", departmentId, fields })).statusCode).toBe(200);
    expect((await call(zeynep, "GET", "/building")).json()).toMatchObject({ who: "it", builders: [{ name: "Zeynep Kaya" }], buildsFor: [departmentId] });
    await call(mehmet, "PUT", "/building", { who: "managers", builders: [] });
  });

  it("holds personal data until the data protection officer approves it", async () => {
    expect((await call(mehmet, "PUT", "/building", { dpo: ayseId })).statusCode).toBe(200);
    const made = await call(zeynep, "POST", "/tables", {
      name: "Visitors",
      departmentId,
      fields: [
        { key: "visitor", label: "Visitor", type: "text", required: true },
        { key: "email", label: "Email", type: "email", personal: true },
      ],
    });
    const table = made.json() as Table;
    expect(table.personal).toEqual({ approved: [], waiting: ["email"] });
    expect(table.reviews).toMatchObject([{ kind: "personal-data", what: "Visitors keeps personal data: Email" }]);

    const refused = await call(deniz, "POST", "/tables/visitors/records", { values: { visitor: "Ali Veli", email: "ali@example.com" } });
    expect(refused.json()).toMatchObject({ problems: ["Email: personal data, which waits for the data protection officer"] });
    expect((await call(deniz, "POST", "/tables/visitors/records", { values: { visitor: "Ali Veli" } })).statusCode).toBe(200);

    // IT doesn't decide on personal data once an officer is named; the officer does.
    expect((await call(mehmet, "POST", `/reviews/${table.reviews[0]!.id}/approve`)).statusCode).toBe(403);
    const waiting = (await call(ayse, "GET", "/reviews")).json() as { id: string; canDecide: boolean }[];
    expect(waiting).toMatchObject([{ id: table.reviews[0]!.id, canDecide: true }]);
    expect((await call(ayse, "POST", `/reviews/${table.reviews[0]!.id}/approve`, { note: "Visitor log, kept 1 year" })).json()).toMatchObject({
      status: "approved",
      decidedBy: "Ayşe Yılmaz",
      note: "Visitor log, kept 1 year",
    });
    expect((await call(deniz, "PATCH", "/tables/visitors/records/1", { values: { email: "ali@example.com" } })).statusCode).toBe(200);

    // A new personal field waits again; taking the mark off withdraws the request.
    const changed = (
      await call(zeynep, "PATCH", "/tables/visitors", {
        fields: [
          { key: "visitor", label: "Visitor", type: "text", required: true },
          { key: "email", label: "Email", type: "email", personal: true },
          { key: "phone", label: "Phone", type: "text", personal: true },
        ],
      })
    ).json() as Table;
    expect(changed.personal).toEqual({ approved: ["email"], waiting: ["phone"] });
    const unmarked = (
      await call(zeynep, "PATCH", "/tables/visitors", {
        fields: [
          { key: "visitor", label: "Visitor", type: "text", required: true },
          { key: "email", label: "Email", type: "email", personal: true },
          { key: "phone", label: "Phone", type: "text" },
        ],
      })
    ).json() as Table;
    expect(unmarked.reviews).toEqual([]);
    expect((await t.platform.reviews.list((await t.platform.company("acme"))!.id, { status: "withdrawn" })).map((r) => r.what)).toEqual([
      "Visitors keeps personal data: Phone",
    ]);
  });

  it("keeps every version, with what changed, and goes back to one (renamed values too)", async () => {
    await call(deniz, "POST", "/tables/complaints/records", { values: { problem: "Late parcel", status: "Done" } });
    const renamed = await call(zeynep, "PATCH", "/tables/complaints", {
      fields: [fields[0], { ...fields[1], choices: ["Open", "Closed"] }],
      renames: { status: { Done: "Closed" } },
    });
    expect((renamed.json() as Table).version).toBe(2);
    const versions = (await call(zeynep, "GET", "/tables/complaints/versions")).json() as {
      version: number;
      summary: string[];
      current: boolean;
      by: string;
    }[];
    expect(versions).toMatchObject([
      { version: 2, current: true, by: "Zeynep Kaya", summary: ["Status: “Done” becomes “Closed” in every record"] },
      { version: 1, current: false, summary: ["Made"] },
    ]);
    expect((await call(deniz, "POST", "/tables/complaints/versions/1/restore")).statusCode).toBe(403);
    const back = await call(zeynep, "POST", "/tables/complaints/versions/1/restore");
    expect(back.statusCode, back.body).toBe(200);
    expect((back.json() as Table).version).toBe(3);
    const records = (await call(deniz, "GET", "/tables/complaints/records")).json() as { records: { values: { status: string } }[] };
    expect(records.records.map((r) => r.values.status)).toEqual(["Done"]);
    const latest = ((await call(zeynep, "GET", "/tables/complaints/versions")).json() as { note: string; summary: string[] }[])[0];
    expect(latest).toMatchObject({ note: "Back to version 1", summary: ["Status: “Closed” becomes “Done” in every record"] });
  });

  it("gives IT everything built, with its owner, and what waits", async () => {
    expect((await call(zeynep, "GET", "/built")).statusCode).toBe(403);
    const built = (await call(mehmet, "GET", "/built")).json() as {
      items: { type: string; name: string; owner: string; personal: { label: string; approved: boolean }[]; shared: boolean }[];
      reviews: unknown[];
    };
    expect(built.items.filter((i) => i.type === "table").map((i) => [i.name, i.owner])).toEqual(
      expect.arrayContaining([
        ["Parcels", "Deniz Aydın"],
        ["Complaints", "Zeynep Kaya"],
        ["Visitors", "Zeynep Kaya"],
      ]),
    );
    expect(built.items.find((i) => i.name === "Visitors")!.personal).toEqual([{ label: "Email", approved: true }]);
    expect(built.items.some((i) => i.type === "ai-employee" && i.name === "Mail Triage")).toBe(true);
  });
});

describe("going back past renamed values", () => {
  it("renames back newest first, following a value renamed twice", () => {
    expect(
      renamesBack([
        { snapshot: { renames: { status: { Closed: "Resolved" } } } },
        { snapshot: {} },
        { snapshot: { renames: { status: { Done: "Closed" }, owner: { A: "B" } } } },
      ]),
    ).toEqual({ status: { Resolved: "Done" }, owner: { B: "A" } });
  });
});
