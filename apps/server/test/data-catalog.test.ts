import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CONNECTORS, ConnectorRegistry, createSqlDatabaseConnector, type SqlClient } from "@enterprise-brain/connectors";
import { createDatabase, type DatabaseHandle } from "@enterprise-brain/db";
import { buildTools } from "@enterprise-brain/runtime";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * The company's data in its brain: tables of its databases with what each table and column means in
 * business words, data sets, and the BI reports built on them (their purpose, measures, dimensions
 * and screenshots), where the data comes from, and reading a database's tables through its
 * connection: a demo database, and a real one (PGlite standing in for the MES reporting replica).
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Column {
  name: string;
  type: string;
  key: string;
  comment: string;
  business_name: string;
  definition: string;
  personal: boolean;
}

interface Thing {
  id: string;
  kind: string;
  key: string;
  name: string;
  data: Record<string, unknown>;
  origins: Record<string, string>;
  links: { label: string; relation: string; direction: string; detail: string; other: { id: string; name: string; kind: string } }[];
  events: { title: string; kind: string; origin: string; body: string }[];
}

/** The MES reporting replica: a few of the MES tables, as a real database has them. */
const REPLICA = [
  "CREATE SCHEMA dbo",
  "CREATE TABLE dbo.lines (line_id integer PRIMARY KEY, name varchar(40) NOT NULL)",
  `CREATE TABLE dbo.work_orders (
     wo_id integer PRIMARY KEY,
     sap_order varchar(12) NOT NULL,
     line_id integer REFERENCES dbo.lines (line_id),
     status varchar(20)
   )`,
  "CREATE TABLE dbo.scrap_reasons (code char(3) PRIMARY KEY, reason varchar(80))",
  "COMMENT ON TABLE dbo.work_orders IS 'Released production orders'",
  "COMMENT ON COLUMN dbo.scrap_reasons.code IS 'S01 porosity, S02 machining, S03 leak test'",
  "INSERT INTO dbo.lines VALUES (1, 'Line 1'), (2, 'Line 2')",
  "INSERT INTO dbo.work_orders SELECT n, '10000' || n, 1 + n % 2, 'released' FROM generate_series(1, 120) n",
  "ANALYZE",
];

describe("the data catalog in the company brain", () => {
  let t: TestApp;
  let replica: DatabaseHandle;
  let as: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const find = async (kind: string, name: string): Promise<Thing> => {
    const hits = (await call("deniz.aydin", "GET", `/brain/search?q=${encodeURIComponent(name)}&kinds=${kind}`)).json() as { id: string; name: string }[];
    const hit = hits.find((h) => h.name === name);
    if (!hit) throw new Error(`${kind} ${name} not found`);
    return (await call("deniz.aydin", "GET", `/brain/entities/${hit.id}`)).json() as Thing;
  };
  const linked = (thing: Thing, label: string) =>
    thing.links.filter((l) => l.label === label).map((l) => (l.detail ? `${l.other.name} (${l.detail})` : l.other.name));
  const columns = (thing: Thing) => thing.data.columns as Column[];

  beforeAll(async () => {
    replica = await createDatabase({ skipMigrations: true });
    for (const statement of REPLICA) await replica.query(statement);
    const replicaClient = (connectionString: string): SqlClient => ({
      async connect() {
        if (connectionString.includes("unreachable")) throw Object.assign(new Error("connect ECONNREFUSED 10.20.0.15:5432"), { code: "ECONNREFUSED" });
      },
      async query(text, values) {
        return { rows: await replica.query(text, values ?? []) };
      },
      async end() {},
    });
    const registry = new ConnectorRegistry();
    for (const connector of BUILTIN_CONNECTORS) {
      registry.register(
        connector.manifest.type === "sql-database"
          ? createSqlDatabaseConnector({ createClient: (config) => replicaClient(config.connectionString) })
          : connector,
      );
    }
    t = await createTestApp({ registry, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    for (const local of ["mehmet.oz", "deniz.aydin"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
    const filled = await call("mehmet.oz", "POST", "/brain/sources/sync-all");
    expect(filled.statusCode, filled.body).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await replica?.close();
  });

  it("brings the company's tables, data sets and BI reports from the catalog and Power BI, each finding what it links to", async () => {
    const sources = (await call("mehmet.oz", "GET", "/brain/sources")).json() as {
      key: string;
      name: string;
      status: string;
      lastResult: { skipped: string[] };
    }[];
    expect(sources.filter((s) => ["catalog", "bi"].includes(s.key)).map((s) => [s.name, s.status, s.lastResult.skipped])).toEqual([
      ["Data catalog (demo)", "connected", []],
      ["Power BI (demo)", "connected", []],
    ]);
    const overview = (await call("deniz.aydin", "GET", "/brain/overview")).json() as { counts: Record<string, number> };
    expect(overview.counts).toMatchObject({ data_table: 31, dataset: 9, report: 13, database: 5 });
    // The inventory's old table notes gave way to the tables themselves.
    const mes = await find("database", "MES_PROD (SQL Server)");
    expect(mes.data.tables).toBeUndefined();
    expect(linked(mes, "Tables").sort()).toEqual(["downtime_reasons", "lines", "machine_downtime", "operations", "test_results", "work_orders"]);
  });

  it("knows what each table and column means in business words, who owns it and which work uses it", async () => {
    const orders = await find("data_table", "VBAK");
    expect(orders.data).toMatchObject({ business_name: "Sales orders", status: "Documented", schema: "SAPHANADB", rows: 182_400 });
    expect(columns(orders).find((c) => c.name === "VBELN")).toMatchObject({ type: "NVARCHAR(10)", key: "PK", business_name: "Sales order number" });
    expect(columns(orders).find((c) => c.name === "KUNNR")).toMatchObject({ key: "FK → KNA1.KUNNR", business_name: "Customer" });
    expect(linked(orders, "Table in")).toEqual(["S4P (SAP HANA)"]);
    expect(linked(orders, "Owner")).toEqual(["Thomas Weber"]);
    expect(linked(orders, "Used in").sort()).toEqual(["Collections (Reads)", "Order to delivery (Reads)", "Quotations (Writes)"]);
    expect(linked(orders, "Feeds")).toEqual(["fact_sales (Nightly copy at 02:00 (Azure Data Factory))"]);
    // Personal data is marked, for the table and column by column.
    expect((await find("data_table", "KNA1")).data.personal_data).toBe("Some");
    expect(columns(await find("data_table", "users")).find((c) => c.name === "email")?.personal).toBe(true);
    // What Claude reads about it: every column with its meaning.
    const scope = { companyId: t.companyId, agentId: "test", definition: { ...(await t.platform.agents.list(t.companyId))[0]!.definition }, citations: [] };
    const { tools } = await buildTools(t.platform.engine.toolDeps, scope, ["company.lookup"]);
    const open = await tools.find((tool) => tool.definition.name === "company_open")!.execute({ id_or_name: orders.id });
    expect(open.content).toContain(
      "- VBELN NVARCHAR(10) [PK] — Sales order number: The order's number in SAP, as printed on order confirmations. (e.g. 0000412345)",
    );
    expect(open.content).toContain("How to use it: Standard orders have AUART 'TA'");
    const search = await tools.find((tool) => tool.definition.name === "company_search")!.execute({ query: "net revenue" });
    expect(search.content).toContain("Sales semantic model");
  });

  it("keeps BI reports: what each is for, its measures, dimensions and screenshots, and the data behind it", async () => {
    const dashboard = await find("report", "Management dashboard");
    expect(dashboard.data).toMatchObject({ tool: "Power BI", status: "Live", workspace: "Management", views: 412 });
    expect(dashboard.data.purpose).toMatch(/^Shows the executive team every Monday/);
    expect((dashboard.data.measures as { name: string }[]).map((m) => m.name)).toContain("Net revenue YTD");
    expect((dashboard.data.dimensions as { name: string; levels: string }[])[0]).toMatchObject({ name: "Date", levels: "Year › Quarter › Month" });
    const shots = dashboard.data.screenshots as { src: string; caption: string }[];
    expect(shots.map((s) => s.caption)).toEqual(["Overview page", "Operations page"]);
    expect(shots[0]!.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(linked(dashboard, "Built on").sort()).toEqual([
      "Finance semantic model (Live connection)",
      "Operations semantic model (Live connection)",
      "Sales semantic model (Live connection)",
    ]);
    expect(linked(dashboard, "Reports on")).toEqual(expect.arrayContaining(["On-time delivery of 95%", "Management"]));
    expect(linked(dashboard, "Part of")).toEqual(["Power BI"]);
    // The picture is served as a picture that can never run as a page of the app.
    const picture = await call("deniz.aydin", "GET", `/brain/entities/${dashboard.id}/pictures/screenshots/0`);
    expect(picture.statusCode).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/svg+xml");
    expect(picture.headers["content-security-policy"]).toContain("sandbox");
    expect(picture.body).toMatch(/^<svg[^>]*>.*Management dashboard/);
    expect((await call("deniz.aydin", "GET", `/brain/entities/${dashboard.id}/pictures/screenshots/5`)).statusCode).toBe(404);
    expect((await call("deniz.aydin", "GET", `/brain/entities/${dashboard.id}/pictures/purpose/0`)).statusCode).toBe(404);
    // Claude reads the words, not the pictures.
    const scope = { companyId: t.companyId, agentId: "test", definition: { ...(await t.platform.agents.list(t.companyId))[0]!.definition }, citations: [] };
    const { tools } = await buildTools(t.platform.engine.toolDeps, scope, ["company.lookup"]);
    const open = await tools.find((tool) => tool.definition.name === "company_open")!.execute({ id_or_name: dashboard.id });
    expect(open.content).toContain("Screenshots: 2 on its page");
    expect(open.content).toContain("- Net revenue YTD: Net revenue from 1 January to today. = TOTALYTD([Net revenue], dim_date[date])");
    expect(open.content).not.toContain("base64");
  });

  it("follows where a report's numbers come from, back to the database tables and the work that writes them", async () => {
    const dashboard = await find("report", "Management dashboard");
    const lineage = (await call("deniz.aydin", "GET", `/brain/entities/${dashboard.id}/lineage`)).json() as {
      root: string;
      nodes: { id: string; name: string; layer: number; place: string | null }[];
      edges: { from: string; to: string; relation: string; detail: string }[];
    };
    const node = (name: string) => lineage.nodes.find((n) => n.name === name);
    expect(node("Management dashboard")).toMatchObject({ layer: 0, place: "Power BI" });
    expect(node("Sales semantic model")).toMatchObject({ layer: -1, place: "Semantic model" });
    expect(node("fact_sales")).toMatchObject({ layer: -2, place: "ACME_DWH (Azure SQL)" });
    expect(node("VBAK")).toMatchObject({ layer: -3, place: "S4P (SAP HANA)" });
    expect(node("Quotations")).toMatchObject({ layer: -4, place: "Process" });
    const name = (id: string) => lineage.nodes.find((n) => n.id === id)!.name;
    expect(lineage.edges.map((e) => `${name(e.from)} → ${name(e.to)}`)).toEqual(
      expect.arrayContaining(["VBAK → fact_sales", "Quotations → VBAK", "fact_sales → Sales semantic model"]),
    );
    // From a table: the work that fills it, and everything built on it.
    const qmel = await find("data_table", "QMEL");
    const down = (await call("deniz.aydin", "GET", `/brain/entities/${qmel.id}/lineage`)).json() as { nodes: { name: string; layer: number }[] };
    expect(down.nodes.map((n) => `${n.layer} ${n.name}`).sort()).toEqual([
      "-1 Customer complaints and 8D",
      "0 QMEL",
      "1 fact_quality",
      "2 Operations semantic model",
      "3 Management dashboard",
      "3 Production performance (OEE)",
      "3 Quality: complaints & PPM",
    ]);
  });

  it("reads a demo database's tables: finds the ones only the database has, and keeps what people wrote", async () => {
    const mes = await find("database", "MES_PROD (SQL Server)");
    expect((await call("deniz.aydin", "POST", `/brain/entities/${mes.id}/read-tables`, {})).statusCode).toBe(403);
    expect((await call("mehmet.oz", "GET", `/brain/entities/${mes.id}/read-tables`)).json()).toEqual({ connections: [], connectionId: null, demo: true });
    const read = await call("mehmet.oz", "POST", `/brain/entities/${mes.id}/read-tables`, {});
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ tables: 8, added: 2, changed: 0, gone: [], from: "the demo database", truncated: false, notes: [] });
    const shifts = await find("data_table", "shift_log");
    expect(shifts.key).toBe("mes-db.dbo.shift_log");
    expect(columns(shifts).map((c) => [c.name, c.key, c.business_name])).toEqual([
      ["shift_id", "PK", ""],
      ["line_id", "FK → lines.line_id", ""],
      ["shift", "", ""],
      ["supervisor", "", ""],
      ["notes", "", ""],
    ]);
    expect(linked(shifts, "Refers to")).toEqual(["lines (line_id)"]);
    expect(shifts.origins.name).toBe(`schema:${mes.id}`);
    // A documented table keeps its words.
    const workOrders = await find("data_table", "work_orders");
    expect(columns(workOrders).find((c) => c.name === "sap_order")?.business_name).toBe("SAP production order");
    // Nothing new the second time; each reading is on the database's timeline.
    expect((await call("mehmet.oz", "POST", `/brain/entities/${mes.id}/read-tables`, {})).json()).toMatchObject({ added: 0, changed: 0, gone: [] });
    expect((await find("database", "MES_PROD (SQL Server)")).events.map((e) => e.title)).toEqual(
      expect.arrayContaining(["Read 8 tables and views from MES_PROD (SQL Server): 2 new", "Read 8 tables and views from MES_PROD (SQL Server): no changes"]),
    );
  });

  it("suggests definitions from the column names without an AI model, and keeps what people write over the sources", async () => {
    const shifts = await find("data_table", "shift_log");
    expect((await call("deniz.aydin", "POST", `/brain/entities/${shifts.id}/suggest-definitions`, {})).statusCode).toBe(403);
    const suggested = (await call("mehmet.oz", "POST", `/brain/entities/${shifts.id}/suggest-definitions`, {})).json() as {
      by: string;
      columns: { name: string; business_name: string; personal: boolean }[];
    };
    expect(suggested.by).toBe("names");
    expect(suggested.columns.map((c) => [c.name, c.business_name, c.personal])).toEqual([
      ["shift_id", "Shift id", false],
      ["line_id", "Line id", false],
      ["shift", "", false],
      ["supervisor", "", true],
      ["notes", "", false],
    ]);
    // SAP's field names mean the same everywhere.
    const stock = (await call("mehmet.oz", "POST", `/brain/entities/${(await find("data_table", "QMEL")).id}/suggest-definitions`, {})).json() as {
      columns: { name: string; business_name: string; definition: string }[];
    };
    expect(stock.columns.find((c) => c.name === "KUNUM")).toMatchObject({
      business_name: "Customer number",
      definition: "The customer the notification is about.",
    });
    // Nothing is kept until someone keeps it.
    expect(columns(await find("data_table", "shift_log")).every((c) => !c.business_name)).toBe(true);

    expect(
      (await call("mehmet.oz", "POST", `/brain/entities/${shifts.id}/definitions`, { columns: [{ name: "shift_no", business_name: "x" }] })).statusCode,
    ).toBe(400);
    const saved = await call("mehmet.oz", "POST", `/brain/entities/${shifts.id}/definitions`, {
      business_name: "Shift log",
      definition: "One row per line and shift: who led it and what happened.",
      status: "Documented",
      columns: [
        { name: "shift", business_name: "Shift", definition: "A, B or C: morning, evening or night." },
        { name: "supervisor", business_name: "Shift supervisor", personal: true },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const kept = saved.json() as Thing;
    expect(kept.data).toMatchObject({ business_name: "Shift log", status: "Documented" });
    expect(columns(kept).find((c) => c.name === "supervisor")).toMatchObject({ business_name: "Shift supervisor", personal: true, type: "varchar(60)" });
    expect(kept.origins["data.columns"]).toBe("manual");

    // A documented table: what a person writes stays over the catalog's next reading and the database's.
    const orders = await find("data_table", "VBAK");
    await call("mehmet.oz", "POST", `/brain/entities/${orders.id}/definitions`, {
      columns: [{ name: "ERDAT", definition: "The day sales entered the order in SAP." }],
    });
    expect((await call("mehmet.oz", "POST", "/brain/sources/catalog/sync")).statusCode).toBe(200);
    const s4p = await find("database", "S4P (SAP HANA)");
    expect((await call("mehmet.oz", "POST", `/brain/entities/${s4p.id}/read-tables`, {})).json()).toMatchObject({ added: 2 });
    const after = await find("data_table", "VBAK");
    expect(columns(after).find((c) => c.name === "ERDAT")?.definition).toBe("The day sales entered the order in SAP.");
    expect(columns(after).find((c) => c.name === "VBELN")?.business_name).toBe("Sales order number");
  });

  it("reads a real database through its SQL connection, and remembers the connection", async () => {
    const connection = await t.platform.connectors.create(t.companyId, {
      type: "sql-database",
      name: "MES reporting replica",
      values: { dialect: "postgres", connection_string: "postgresql://eb_reader:secret@mes-replica.acme.local:5432/mes" },
    });
    const mes = await find("database", "MES_PROD (SQL Server)");
    expect((await call("mehmet.oz", "GET", `/brain/entities/${mes.id}/read-tables`)).json()).toEqual({
      connections: [{ id: connection.id, name: "MES reporting replica", detail: "PostgreSQL" }],
      connectionId: null,
      demo: true,
    });
    const read = await call("mehmet.oz", "POST", `/brain/entities/${mes.id}/read-tables`, { connectionId: connection.id });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      tables: 3,
      added: 1,
      changed: 2,
      from: "MES reporting replica",
      gone: ["downtime_reasons", "machine_downtime", "operations", "shift_log", "test_results", "v_oee_daily"],
    });
    const workOrders = await find("data_table", "work_orders");
    expect(columns(workOrders).map((c) => [c.name, c.type, c.key, c.business_name])).toEqual([
      ["wo_id", "integer", "PK", "Work order id"],
      ["sap_order", "varchar(12)", "", "SAP production order"],
      ["line_id", "integer", "FK → lines.line_id", "Assembly line"],
      ["status", "varchar(20)", "", "Status"],
    ]);
    expect(workOrders.data.rows).toBe(120);
    const scrap = await find("data_table", "scrap_reasons");
    expect(columns(scrap)[0]).toMatchObject({ name: "code", type: "char(3)", key: "PK", comment: "S01 porosity, S02 machining, S03 leak test" });
    // The catalog's next reading adds business words, but the columns stay as the database has them.
    expect((await call("mehmet.oz", "POST", "/brain/sources/catalog/sync")).statusCode).toBe(200);
    expect(columns(await find("data_table", "work_orders")).map((c) => c.type)).toEqual(["integer", "varchar(12)", "integer", "varchar(20)"]);
    // Next time, the connection it was read through is used.
    expect(((await call("mehmet.oz", "GET", `/brain/entities/${mes.id}/read-tables`)).json() as { connectionId: string }).connectionId).toBe(connection.id);
    expect((await call("mehmet.oz", "POST", `/brain/entities/${mes.id}/read-tables`, {})).json()).toMatchObject({
      from: "MES reporting replica",
      added: 0,
      changed: 0,
    });
  });

  it("says what went wrong when a database can't be read", async () => {
    const portal = await find("database", "PORTAL (Azure SQL)");
    const down = await t.platform.connectors.create(t.companyId, {
      type: "sql-database",
      name: "Portal replica",
      values: { dialect: "postgres", connection_string: "postgresql://eb_reader:secret@unreachable.acme.local:5432/portal" },
    });
    const failed = await call("mehmet.oz", "POST", `/brain/entities/${portal.id}/read-tables`, { connectionId: down.id });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatch(/^Portal replica could not be read: /);
    const rest = await t.platform.connectors.create(t.companyId, {
      type: "rest-api",
      name: "Warehouse API",
      values: { base_url: "https://wms.acme.example/v1" },
    });
    const wrong = await call("mehmet.oz", "POST", `/brain/entities/${portal.id}/read-tables`, { connectionId: rest.id });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("That is not one of the company's SQL database connections");
    const notDatabase = await find("report", "Monthly P&L");
    expect((await call("mehmet.oz", "POST", `/brain/entities/${notDatabase.id}/read-tables`, {})).statusCode).toBe(400);
  });

  it("points out data no one explained, data only someone on leave knows, and reports showing old numbers", async () => {
    const overview = (await call("deniz.aydin", "GET", "/brain/overview")).json() as {
      gaps: { type: string; title: string; detail: string }[];
      attention: { type: string; title: string }[];
    };
    expect(overview.gaps.filter((g) => g.type === "no-definitions").map((g) => g.title)).toEqual([
      "No one wrote down what Cash flow forecast.xlsx means",
      "No one wrote down what Quality notifications (QMEL) means",
    ]);
    expect(overview.gaps.map((g) => g.title)).toEqual(
      expect.arrayContaining([
        "Only Hande Özkan knows Finance semantic model, and they are on leave",
        "Only Hande Özkan knows Monthly general ledger (fact_gl), and they are on leave",
      ]),
    );
    expect(overview.attention.filter((a) => a.type === "data")).toEqual([]);
    // The next reading: the nightly copy from the MES failed again.
    expect((await call("mehmet.oz", "POST", "/brain/sources/bi/sync")).statusCode).toBe(200);
    const later = (await call("deniz.aydin", "GET", "/brain/overview")).json() as { attention: { type: string; title: string }[] };
    expect(later.attention.filter((a) => a.type === "data").map((a) => a.title)).toEqual([
      "Production performance (OEE) shows old numbers",
      "Quality: complaints & PPM shows old numbers",
    ]);
  });

  it("keeps screenshots people add as pictures", async () => {
    const report = await find("report", "Supplier performance");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const upload = (name: string, data: Buffer, type: string) => {
      const form = multipart({}, [{ field: "file", name, data, type }]);
      return t.app.inject({ method: "POST", url: `${base}/files`, headers: { cookie: as["mehmet.oz"]!, ...form.headers }, payload: form.payload });
    };
    const [picture] = (await upload("supplier-otd.png", png, "image/png")).json() as { id: string }[];
    const kept = await call("mehmet.oz", "PATCH", `/brain/entities/${report.id}`, {
      data: { screenshots: [{ file: picture!.id, caption: "On-time delivery" }] },
    });
    expect(kept.statusCode, kept.body).toBe(200);
    const served = await call("deniz.aydin", "GET", `/brain/entities/${report.id}/pictures/screenshots/0`);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.rawPayload.equals(png)).toBe(true);
    const [note] = (await upload("notes.html", Buffer.from("<script>alert(1)</script>"), "text/html")).json() as { id: string }[];
    const refused = await call("mehmet.oz", "PATCH", `/brain/entities/${report.id}`, { data: { screenshots: [{ file: note!.id, caption: "x" }] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("Screenshots: upload a PNG, JPEG, GIF or WebP picture");
  });
});
