import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.ts";

/** IT turns a web service into named actions over the API: import, review, save, try. */

const OPENAPI_YAML = `
openapi: 3.0.3
info: { title: Warehouse, version: "1" }
servers:
  - url: https://wms.acme.example/v1
paths:
  /stock/{material}:
    get:
      operationId: getStock
      summary: Stock of a material
      parameters:
        - { name: material, in: path, required: true, schema: { type: string } }
  /reservations:
    post:
      operationId: reserveStock
      summary: Reserve stock
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [material, quantity]
              properties:
                material: { type: string }
                quantity: { type: integer }
`;

describe("named actions over the API", () => {
  let t: TestApp;
  let server: Server;
  let connectionId: string;
  const reservations: unknown[] = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.startsWith("/v1/stock/")) return response.end(JSON.stringify({ material: request.url.split("/").pop(), available: 40 }));
      reservations.push(JSON.parse(body || "{}"));
      response.end(JSON.stringify({ reserved: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t = await createTestApp({ seed: false });
    const created = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/connectors",
      payload: { type: "rest-api", name: "Warehouse", values: { base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` } },
    });
    connectionId = created.json().id;
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("proposes actions from an OpenAPI description (YAML) and from example calls", async () => {
    const fromYaml = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/import`, payload: { openapi: OPENAPI_YAML } });
    expect(fromYaml.statusCode, fromYaml.body).toBe(200);
    expect(fromYaml.json()).toMatchObject({
      baseUrl: "https://wms.acme.example/v1",
      actions: [
        { id: "get_stock", name: "Stock of a material", kind: "read", path: "/stock/{material}" },
        { id: "reserve_stock", name: "Reserve stock", kind: "write", body: { material: "{material}", quantity: "{quantity}" } },
      ],
    });
    const fromExamples = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/import`, payload: { examples: "GET https://wms.acme.example/v1/stock/FG-20001" } });
    expect(fromExamples.json().actions[0]).toMatchObject({ id: "get_stock", path: "/v1/stock/{stock_id}" });
    const broken = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/import`, payload: { openapi: "{ not json" } });
    expect(broken.statusCode).toBe(400);
  });

  it("saves reviewed actions, refuses broken ones, and tries them", async () => {
    const proposed = (await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/import`, payload: { openapi: OPENAPI_YAML } })).json();
    const bad = await t.app.inject({ method: "PUT", url: `/api/companies/acme/connectors/${connectionId}/actions`, payload: { actions: [{ id: "Bad Id", name: "x", kind: "read" }] } });
    expect(bad.statusCode).toBe(400);
    const saved = await t.app.inject({ method: "PUT", url: `/api/companies/acme/connectors/${connectionId}/actions`, payload: { actions: proposed.actions } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await t.app.inject(`/api/companies/acme/connectors/${connectionId}/actions`)).json()).toMatchObject({ supports: true, actions: [{ id: "get_stock" }, { id: "reserve_stock" }] });

    const read = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/get_stock/test`, payload: { input: { material: "FG-20001" } } });
    expect(read.json()).toMatchObject({ ok: true, result: { data: { material: "FG-20001", available: 40 } } });
    const unconfirmed = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/reserve_stock/test`, payload: { input: { material: "FG-20001", quantity: 2 } } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toMatch(/changes data in Warehouse: confirm/);
    const confirmed = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${connectionId}/actions/reserve_stock/test`, payload: { input: { material: "FG-20001", quantity: 2 }, confirm: true } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(reservations).toEqual([{ material: "FG-20001", quantity: 2 }]);
  });
});
