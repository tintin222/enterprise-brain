import { describe, expect, it } from "vitest";
import { resolveRestUrl, restApiConnector } from "../src/index.ts";
import { basicHeader, empty, expectConnectorError, FakeFetch, json, makeCtx, run, text } from "./helpers.ts";

const BASE = "https://erp-gateway.acme.example/api/v1";

function ctxFor(fake: FakeFetch, config: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
  return makeCtx({
    fetch: fake.fetch,
    config: { base_url: BASE, auth_type: "api_key", api_key_header: "X-Api-Key", default_headers: '{"X-Tenant": "acme", "Accept-Language": "tr-TR"}', ...config },
    secrets: { api_key: "k-123", ...secrets },
  });
}

describe("rest-api", () => {
  it("GETs a path below the base URL with query parameters, API key and default headers", async () => {
    const fake = new FakeFetch().on("GET", `${BASE}/orders`, json({ items: [{ id: 4711 }] }));
    const result = await run(restApiConnector, "http_get", { path: "/orders", query: { status: "open", limit: 5, tags: ["a", "b"] } }, ctxFor(fake));
    expect(result).toMatchObject({ ok: true, status: 200, content_type: "application/json", data: { items: [{ id: 4711 }] } });
    const call = fake.calls[0]!;
    expect(call.url.search).toBe("?status=open&limit=5&tags=a&tags=b");
    expect(call.headers.get("x-api-key")).toBe("k-123");
    expect(call.headers.get("x-tenant")).toBe("acme");
    expect(call.headers.get("accept-language")).toBe("tr-TR");
  });

  it("POSTs, PUTs, PATCHes and DELETEs", async () => {
    const fake = new FakeFetch()
      .on("POST", `${BASE}/orders`, (req) => json({ created: req.json }, 201, { location: `${BASE}/orders/4712` }))
      .on("PUT", `${BASE}/orders/4712`, json({ ok: true }))
      .on("PATCH", `${BASE}/orders/4712`, json({ ok: true }))
      .on("DELETE", `${BASE}/orders/4712`, empty(204))
      .on("POST", `${BASE}/notes`, (req) => text(`received ${req.body} as ${req.headers.get("content-type")}`));
    const ctx = ctxFor(fake, { auth_type: "bearer" }, { bearer_token: "tok-xyz" });
    const created = await run(restApiConnector, "http_post", { path: "orders", body: { customer: "CUST-2002", lines: [{ material: "FG-20001", qty: 2 }] } }, ctx);
    expect(created).toMatchObject({ status: 201, location: `${BASE}/orders/4712`, data: { created: { customer: "CUST-2002" } } });
    expect(fake.calls[0]!.headers.get("authorization")).toBe("Bearer tok-xyz");
    expect(fake.calls[0]!.headers.get("content-type")).toBe("application/json");
    await run(restApiConnector, "http_put", { path: "orders/4712", body: { status: "confirmed" } }, ctx);
    await run(restApiConnector, "http_patch", { path: "orders/4712", body: { status: "shipped" } }, ctx);
    expect(await run(restApiConnector, "http_delete", { path: "orders/4712" }, ctx)).toMatchObject({ ok: true, status: 204, data: null });
    expect((await run(restApiConnector, "http_post", { path: "notes", body: "plain note" }, ctx)).data).toBe("received plain note as text/plain; charset=utf-8");
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "PUT", "PATCH", "DELETE", "POST"]);
  });

  it("supports basic authentication", async () => {
    const fake = new FakeFetch().on("GET", `${BASE}/me`, json({ user: "svc" }));
    await run(restApiConnector, "http_get", { path: "me" }, ctxFor(fake, { auth_type: "basic", username: "svc_eb", default_headers: "" }, { password: "pw" }));
    expect(fake.calls[0]!.headers.get("authorization")).toBe(basicHeader("svc_eb", "pw"));
  });

  it("refuses paths outside of the base URL", async () => {
    const ctx = ctxFor(new FakeFetch());
    for (const path of ["../admin", "/../../etc/passwd", "%2e%2e/admin", "https://evil.example/x", "//evil.example/x", "javascript:alert(1)"]) {
      expect((await expectConnectorError(restApiConnector.execute("http_get", { path }, ctx))).code, path).toBe("validation");
    }
    expect(resolveRestUrl(BASE, "orders/4711?expand=lines")).toBe(`${BASE}/orders/4711?expand=lines`);
    expect(resolveRestUrl(`${BASE}/`, "/orders")).toBe(`${BASE}/orders`);
  });

  it("maps HTTP errors and reports invalid configuration", async () => {
    const fake = new FakeFetch().on("GET", `${BASE}/orders/1`, json({ detail: "Order not found" }, 404));
    expect(await expectConnectorError(restApiConnector.execute("http_get", { path: "orders/1" }, ctxFor(fake, { system_name: "Order service" })))).toMatchObject({
      code: "not_found",
      message: "Order service returned HTTP 404: Order not found",
    });
    expect(await restApiConnector.test(ctxFor(fake, { default_headers: "{not json" }))).toMatchObject({ ok: false, details: { code: "config" } });
  });

  it("test() accepts any non-auth answer and reports auth failures", async () => {
    const reachable = new FakeFetch().on("GET", BASE, text("Not Found", 404));
    expect(await restApiConnector.test(ctxFor(reachable))).toMatchObject({ ok: true, details: { status: 404 } });
    const health = new FakeFetch().on("GET", `${BASE}/health`, json({ status: "UP" }));
    expect(await restApiConnector.test(ctxFor(health, { health_path: "/health" }))).toMatchObject({ ok: true, details: { status: 200 } });
    const denied = new FakeFetch().on("GET", BASE, text("Unauthorized", 401));
    expect(await restApiConnector.test(ctxFor(denied))).toMatchObject({ ok: false, details: { code: "auth" } });
  });
});
