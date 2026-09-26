import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWorkbook } from "@enterprise-brain/documents";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * Tables over HTTP with people signed in: a department manager describes a table, the Studio
 * proposes its fields, the department's people add and change records, other departments don't see
 * it until it is shared, a sheet comes in and goes out, and the Tables connection is the platform's.
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
  name: string;
  fields: { key: string; label: string; type: string }[];
  can: { edit: boolean; design: boolean };
}

describe("tables over HTTP", () => {
  let t: TestApp;
  let mehmet = "";
  let zeynep = "";
  let deniz = "";
  let burak = "";
  let departmentId = "";
  let table: Table;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
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
  });
  afterAll(async () => {
    await t?.close();
  });

  it("proposes a table from a description, and a department manager makes it", async () => {
    const proposed = await call(zeynep, "POST", "/tables/propose", {
      description: "Customer complaints: customer, order number, problem, status (open, in progress, closed), owner, refund in TRY",
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const { design } = proposed.json() as { design: { name: string; fields: unknown[]; titleField: string } };
    expect(design.name).toBe("Customer complaints");
    expect((await call(deniz, "POST", "/tables", { ...design, departmentId })).statusCode).toBe(403);
    expect((await call(zeynep, "POST", "/tables", design)).statusCode).toBe(403);
    const made = await call(zeynep, "POST", "/tables", { ...design, departmentId });
    expect(made.statusCode, made.body).toBe(200);
    table = made.json() as Table;
    expect(table).toMatchObject({ key: "customer_complaints", can: { edit: true, design: true } });
    expect(table.fields.map((f) => f.type)).toEqual(["text", "text", "text", "choice", "person", "money"]);
  });

  it("lets the department's people add and change records; others don't see the table", async () => {
    const added = await call(deniz, "POST", `/tables/${table.key}/records`, {
      values: { customer: "Kaya Çelik", problem: "Scratched housing", owner: "Deniz Aydın", refund: "1.200" },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ number: 1, values: { status: "Open", owner: "deniz.aydin@acme.com.tr", refund: 1200 }, createdBy: "Deniz Aydın" });
    const wrong = await call(deniz, "POST", `/tables/${table.key}/records`, { values: { customer: "X", status: "Lost" } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ problems: ["Problem is required", 'Status: one of "Open", "In progress", "Closed"'] });
    const changed = await call(deniz, "PATCH", `/tables/${table.key}/records/1`, { values: { status: "In progress" } });
    expect(changed.statusCode, changed.body).toBe(200);
    const detail = (await call(zeynep, "GET", `/tables/${table.key}/records/1`)).json() as {
      record: { values: { status: string } };
      history: { action: string; by: string }[];
    };
    expect(detail.record.values.status).toBe("In progress");
    expect(detail.history.map((h) => `${h.action} by ${h.by}`)).toEqual(["updated by Deniz Aydın", "created by Deniz Aydın"]);

    expect((await call(burak, "GET", "/tables")).json()).toEqual([]);
    expect((await call(burak, "GET", `/tables/${table.key}`)).statusCode).toBe(404);
    expect((await call(burak, "POST", `/tables/${table.key}/records`, { values: { problem: "x" } })).statusCode).toBe(404);
    expect((await call(deniz, "PATCH", `/tables/${table.key}`, { name: "Complaints" })).statusCode).toBe(403);
  });

  it("follows its settings: only managers change records, and sharing it (once IT agrees) shows it to everyone", async () => {
    const settings = await call(zeynep, "PATCH", `/tables/${table.key}`, { settings: { editors: "managers", visibility: "company" } });
    expect(settings.statusCode, settings.body).toBe(200);
    // Shared beyond its department only once IT says so.
    const asked = settings.json() as { settings: { visibility: string }; reviews: { id: string; kind: string; what: string }[] };
    expect(asked.settings.visibility).toBe("department");
    expect(asked.reviews).toMatchObject([{ kind: "sharing", what: "Share Customer complaints with the whole company" }]);
    expect((await call(burak, "GET", "/tables")).json()).toEqual([]);
    expect((await call(zeynep, "POST", `/reviews/${asked.reviews[0]!.id}/approve`)).statusCode).toBe(403);
    expect((await call(mehmet, "POST", `/reviews/${asked.reviews[0]!.id}/approve`)).json()).toMatchObject({ status: "approved", decidedBy: "Mehmet Öz" });
    expect((await call(deniz, "POST", `/tables/${table.key}/records`, { values: { problem: "Late parcel" } })).statusCode).toBe(403);
    const seen = (await call(burak, "GET", "/tables")).json() as Table[];
    expect(seen.map((x) => [x.key, x.can.edit])).toEqual([["customer_complaints", false]]);
    const response = await call(burak, "GET", `/tables/${table.key}/records?filter.status=in%20progress&search=housing`);
    expect(response.statusCode, response.body).toBe(200);
    const found = response.json() as { total: number };
    expect(found.total).toBe(1);
    expect((await call(zeynep, "PATCH", `/tables/${table.key}`, { settings: { editors: "members" } })).statusCode).toBe(200);
  });

  it("imports a sheet after showing what it would add, and exports the records to Excel", async () => {
    const csv = "Customer,Problem,Status,Owner,Colour\nAkın Metal,Wrong invoice,Open,Zeynep Kaya,red\n,,,,\nBoş,,Maybe,,\n";
    const upload = multipart({}, [{ field: "file", name: "complaints.csv", data: Buffer.from(csv), type: "text/csv" }]);
    const preview = await t.app.inject({
      method: "POST",
      url: `${base}/tables/${table.key}/import`,
      headers: { cookie: deniz, ...upload.headers },
      payload: upload.payload,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const checked = preview.json() as { fileId: string; ready: number; added: number; ignored: string[]; problems: { row: number }[] };
    expect(checked).toMatchObject({ ready: 1, added: 0, ignored: ["Colour"] });
    expect(checked.problems.map((p) => p.row)).toEqual([4]);
    const done = await call(deniz, "POST", `/tables/${table.key}/import`, { fileId: checked.fileId });
    expect(done.json()).toMatchObject({ added: 1 });

    const exported = await call(deniz, "GET", `/tables/${table.key}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("spreadsheetml");
    const [sheet] = await readWorkbook(exported.rawPayload);
    expect(sheet!.rows.map((r) => [r["#"], r.Problem, r.Owner])).toEqual([
      [1, "Scratched housing", "Deniz Aydın"],
      [2, "Wrong invoice", "Zeynep Kaya"],
    ]);
  });

  it("keeps the Tables connection itself: IT doesn't change or remove it", async () => {
    const connection = ((await call(mehmet, "GET", "/connectors")).json() as { id: string; type: string }[]).find((c) => c.type === "tables")!;
    expect(connection).toBeDefined();
    expect((await call(mehmet, "PUT", `/connectors/${connection.id}/actions`, { actions: [] })).statusCode).toBe(400);
    expect((await call(mehmet, "DELETE", `/connectors/${connection.id}`)).statusCode).toBe(400);
    expect((await call(mehmet, "POST", "/connectors", { type: "tables" })).statusCode).toBe(400);
    const actions = (await call(mehmet, "GET", `/connectors/${connection.id}/actions`)).json() as { actions: { id: string }[] };
    expect(actions.actions.map((a) => a.id)).toContain("add_customer_complaints");
  });

  it("archives a table: its records stay, AI employees no longer reach it", async () => {
    expect((await call(deniz, "POST", `/tables/${table.key}/archive`)).statusCode).toBe(403);
    expect((await call(zeynep, "POST", `/tables/${table.key}/archive`)).statusCode).toBe(200);
    expect((await call(zeynep, "GET", "/tables")).json()).toEqual([]);
    expect(((await call(zeynep, "GET", "/tables?archived=true")).json() as Table[]).map((x) => x.key)).toEqual(["customer_complaints"]);
    expect((await call(deniz, "POST", `/tables/${table.key}/records`, { values: { problem: "x" } })).statusCode).toBe(409);
    expect((await call(zeynep, "POST", `/tables/${table.key}/restore`)).statusCode).toBe(200);
  });
});
