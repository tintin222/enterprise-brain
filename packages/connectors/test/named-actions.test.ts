import { describe, expect, it } from "vitest";
import { NamedAction } from "@enterprise-brain/core";
import {
  actionsFromExamples,
  actionsFromOpenApi,
  bindNamedParams,
  createSqlDatabaseConnector,
  fillPath,
  fillTemplate,
  restApiConnector,
  withNamedActions,
  type SqlClient,
  type SqlQueryResult,
} from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx } from "./helpers.ts";

/**
 * Named actions: IT's own actions on a web service or database. AI employees see only these, each
 * checked against its parameters; watched actions report new rows or items.
 */

const BASE = "https://crm.acme.example/api";
const action = (input: Record<string, unknown>) => NamedAction.parse(input);

const getCustomer = action({
  id: "get_customer",
  name: "Get customer",
  description: "A customer's master data and open balance",
  kind: "read",
  method: "GET",
  path: "/customers/{customer_id}",
  query: { include: "{include}" },
  params: [
    { key: "customer_id", required: true, description: "e.g. C-1001" },
    { key: "include", description: "balance or contacts" },
  ],
});
const createNote = action({
  id: "create_note",
  name: "Add a note to a customer",
  kind: "write",
  requiresApproval: true,
  method: "POST",
  path: "/customers/{customer_id}/notes",
  body: { text: "{text}", priority: "{priority}", source: "enterprise-brain" },
  params: [
    { key: "customer_id", required: true },
    { key: "text", required: true },
    { key: "priority", type: "integer" },
  ],
});
const newOrders = action({
  id: "new_orders",
  name: "New orders",
  kind: "read",
  method: "GET",
  path: "/orders",
  query: { created_after: "{since}" },
  params: [{ key: "since", type: "string" }],
  watch: { cursorField: "created_at", idField: "number" },
});

describe("templates and parameters", () => {
  it("fills paths and templates, typed when a whole value is a parameter", () => {
    expect(fillPath("/customers/{id}/orders", { id: "C 1/2" })).toBe("/customers/C%201%2F2/orders");
    expect(fillTemplate({ a: "{n}", b: "Order {n}", c: ["{x}"], d: "{missing}" }, { n: 5, x: true })).toEqual({ a: 5, b: "Order 5", c: [true] });
  });

  it("lets AI employees use only IT's actions, with checked values", async () => {
    const fake = new FakeFetch()
      .on("GET", `${BASE}/customers/C-1001`, json({ id: "C-1001", name: "Kaya Çelik", balance: 1200 }))
      .on("POST", `${BASE}/customers/C-1001/notes`, (req) => json({ saved: req.json }, 201));
    const connector = withNamedActions(restApiConnector, [getCustomer, createNote]);
    expect(connector.manifest.operations.map((o) => [o.id, o.kind, o.requiresApproval ?? false])).toEqual([
      ["get_customer", "read", false],
      ["create_note", "write", true],
    ]);
    expect(connector.manifest.operations[0]!.input).toMatchObject({ required: ["customer_id"], properties: { customer_id: { type: "string", description: "e.g. C-1001" } } });

    const ctx = makeCtx({ fetch: fake.fetch, config: { base_url: BASE } });
    const customer = await connector.execute("get_customer", { customer_id: "C-1001", include: "balance" }, ctx);
    expect(customer).toMatchObject({ status: 200, data: { name: "Kaya Çelik" } });
    expect(fake.calls[0]!.url.search).toBe("?include=balance");
    await connector.execute("get_customer", { customer_id: "C-1001" }, ctx);
    expect(fake.calls[1]!.url.search).toBe("");

    await connector.execute("create_note", { customer_id: "C-1001", text: "Called about the invoice", priority: "2" }, ctx);
    expect(fake.calls[2]!.json).toEqual({ text: "Called about the invoice", priority: 2, source: "enterprise-brain" });

    expect((await expectConnectorError(connector.execute("get_customer", {}, ctx))).message).toBe("Get customer: customer_id is required");
    expect((await expectConnectorError(connector.execute("create_note", { customer_id: "C", text: "x", priority: "high" }, ctx))).message).toMatch(/priority must be a whole number/);
    expect((await expectConnectorError(connector.execute("http_post", { path: "/anything" }, ctx))).code).toBe("unsupported");
    expect((await expectConnectorError(connector.execute("get_customer", { customer_id: "C", sql: "x" }, ctx))).message).toMatch(/doesn't take sql/);
  });

  it("watches an action for new items: the first check only records where to start", async () => {
    const orders = [
      { number: "SO-1", created_at: "2026-09-25T08:00:00Z" },
      { number: "SO-2", created_at: "2026-09-25T09:00:00Z" },
    ];
    const fake = new FakeFetch().on("GET", `${BASE}/orders`, (req) => json({ items: orders.filter((o) => o.created_at > (req.url.searchParams.get("created_after") ?? "")) }));
    const connector = withNamedActions(restApiConnector, [newOrders]);
    expect(connector.manifest.events.map((e) => e.id)).toEqual(["new:new_orders"]);
    const ctx = makeCtx({ fetch: fake.fetch, config: { base_url: BASE } });
    const first = await connector.poll!("new:new_orders", ctx, undefined);
    expect(first.events).toEqual([]);
    const second = await connector.poll!("new:new_orders", ctx, "2026-09-25T08:30:00Z");
    expect(second.events.map((e) => [e.id, e.data.number])).toEqual([["new_orders:SO-2", "SO-2"]]);
    expect(second.cursor).toBe("2026-09-25T09:00:00Z");
    expect(fake.calls.at(-1)!.url.searchParams.get("created_after")).toBe("2026-09-25T08:30:00Z");
  });
});

class RecordingClient implements SqlClient {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  constructor(private readonly respond: (text: string) => SqlQueryResult = () => ({ rows: [] })) {}
  async connect() {}
  async query(text: string, values?: unknown[]) {
    this.statements.push({ text, values });
    return this.respond(text);
  }
  async end() {}
}

describe("database actions", () => {
  it("binds :params in each database's style, leaving quotes and casts alone", () => {
    const sql = "SELECT * FROM orders WHERE customer = :customer AND note <> ':customer' AND created::date >= :since AND owner = :customer";
    expect(bindNamedParams(sql, "postgres", { customer: "C-1", since: "2026-01-01" })).toEqual({
      text: "SELECT * FROM orders WHERE customer = $1 AND note <> ':customer' AND created::date >= $2 AND owner = $1",
      params: ["C-1", "2026-01-01"],
    });
    expect(bindNamedParams(sql, "mysql", { customer: "C-1", since: "2026-01-01" }).params).toEqual(["C-1", "2026-01-01", "C-1"]);
    expect(bindNamedParams("SELECT * FROM t WHERE a = :a;", "sqlserver", {})).toEqual({ text: "SELECT * FROM t WHERE a = @p1", params: [null] });
  });

  it("runs saved queries rolled back, and changes in a committed transaction", async () => {
    const client = new RecordingClient((text) => (text.startsWith("SELECT") ? { rows: [{ order_no: "SO-1" }, { order_no: "SO-2" }] } : { rows: [], rowCount: 1 }));
    const base = createSqlDatabaseConnector({ createClient: () => client });
    const connector = withNamedActions(base, [
      action({ id: "open_orders", name: "Open orders of a customer", kind: "read", sql: "SELECT order_no FROM orders WHERE customer_id = :customer_id AND status = 'open'", params: [{ key: "customer_id", required: true }] }),
      action({ id: "block_order", name: "Block an order", kind: "write", sql: "UPDATE orders SET status = 'blocked', note = :reason WHERE order_no = :order_no", params: [{ key: "order_no", required: true }, { key: "reason" }] }),
    ]);
    const ctx = makeCtx({ config: { max_rows: 1 }, secrets: { connection_string: "postgresql://eb@db/erp" } });
    expect(await connector.execute("open_orders", { customer_id: "C-1" }, ctx)).toMatchObject({ rows: [{ order_no: "SO-1" }], truncated: true, max_rows: 1 });
    expect(client.statements.map((s) => s.text)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = 15000",
      "SELECT order_no FROM orders WHERE customer_id = $1 AND status = 'open'",
      "ROLLBACK",
    ]);
    client.statements.length = 0;
    expect(await connector.execute("block_order", { order_no: "SO-1", reason: "Price check" }, ctx)).toEqual({ ok: true, affected_rows: 1 });
    expect(client.statements.map((s) => s.text)).toEqual(["BEGIN", "SET LOCAL statement_timeout = 15000", "UPDATE orders SET status = 'blocked', note = $1 WHERE order_no = $2", "COMMIT"]);
    expect(client.statements[2]!.values).toEqual(["Price check", "SO-1"]);
  });

  it("speaks SQL Server: TOP instead of LIMIT, @p placeholders, rolled-back reads", async () => {
    const client = new RecordingClient(() => ({ rows: [{ n: 1 }] }));
    let dialect: string | undefined;
    const connector = createSqlDatabaseConnector({
      createClient: (config) => {
        dialect = config.dialect;
        return client;
      },
    });
    const ctx = makeCtx({ config: { dialect: "sqlserver", max_rows: 50 }, secrets: { connection_string: "Server=db,1433;Database=erp;User Id=eb;Password=pw" } });
    await connector.execute("run_query", { sql: "SELECT n FROM t WHERE a = @p1", params: [5] }, ctx);
    expect(dialect).toBe("sqlserver");
    expect(client.statements.map((s) => s.text)).toEqual(["BEGIN TRANSACTION", "SELECT TOP (50) * FROM (SELECT n FROM t WHERE a = @p1) AS q", "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"]);
  });
});

describe("proposing actions", () => {
  it("reads an OpenAPI description: one action per operation, parameters from the path, query and body", () => {
    const proposed = actionsFromOpenApi({
      openapi: "3.0.3",
      servers: [{ url: "https://crm.acme.example/api" }],
      paths: {
        "/customers/{customerId}": {
          parameters: [{ name: "customerId", in: "path", required: true, schema: { type: "string" } }],
          get: { operationId: "getCustomer", summary: "Get a customer", parameters: [{ name: "include", in: "query", schema: { type: "string" } }] },
        },
        "/orders": {
          post: {
            operationId: "createOrder",
            summary: "Create an order",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
          },
        },
      },
      components: { schemas: { Order: { type: "object", required: ["customer"], properties: { customer: { type: "string" }, amount: { type: "number", description: "Net amount" } } } } },
    });
    expect(proposed.baseUrl).toBe("https://crm.acme.example/api");
    expect(proposed.actions).toEqual([
      expect.objectContaining({
        id: "get_customer",
        name: "Get a customer",
        kind: "read",
        method: "GET",
        path: "/customers/{customerId}",
        query: { include: "{include}" },
        params: [
          { key: "customerId", type: "string", required: true },
          { key: "include", type: "string", required: false },
        ],
      }),
      expect.objectContaining({
        id: "create_order",
        kind: "write",
        method: "POST",
        body: { customer: "{customer}", amount: "{amount}" },
        params: [
          { key: "customer", type: "string", required: true },
          { key: "amount", type: "number", description: "Net amount", required: false },
        ],
      }),
    ]);
  });

  it("learns actions from example calls", () => {
    const proposed = actionsFromExamples(
      [
        "GET https://wms.acme.example/v1/shipments/48213?carrier=ups",
        'POST https://wms.acme.example/v1/pickings {"order": "SO-7000121", "priority": 2}',
        "nonsense",
      ].join("\n"),
    );
    expect(proposed.baseUrl).toBe("https://wms.acme.example");
    expect(proposed.actions.map((a) => [a.id, a.kind, a.method, a.path, a.params.map((p) => p.key)])).toEqual([
      ["get_shipment", "read", "GET", "/v1/shipments/{shipment_id}", ["shipment_id", "carrier"]],
      ["create_picking", "write", "POST", "/v1/pickings", ["order", "priority"]],
    ]);
    expect(proposed.warnings).toEqual(["Not an example call: nonsense"]);
  });
});
