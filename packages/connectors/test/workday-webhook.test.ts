import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, signWebhookPayload, verifyWebhookSignature, webhookInboundConnector, workdayConnector } from "../src/index.ts";
import { basicHeader, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const HOST = "https://wd2-impl-services1.workday.com";

describe("workday", () => {
  beforeEach(() => clearTokenCache());

  it("exchanges the refresh token (client auth via HTTP Basic) and searches workers", async () => {
    const fake = new FakeFetch()
      .on("POST", `${HOST}/ccx/oauth2/acme/token`, json({ access_token: "wd-token", token_type: "Bearer" }))
      .on("GET", `${HOST}/ccx/api/v1/acme/workers`, json({ total: 1, data: [{ id: "3aa5550b7fe348b98d7b5741afc65534", descriptor: "Zeynep Demir", primaryWorkEmail: "zeynep.demir@acme.example", businessTitle: "HR Director" }] }));
    const ctx = makeCtx({ fetch: fake.fetch, config: { host: HOST, tenant: "acme", client_id: "wd-client" }, secrets: { client_secret: "wd-secret", refresh_token: "wd-refresh" } });
    const result = await run(workdayConnector, "search_workers", { query: "Zeynep" }, ctx);
    expect(result).toMatchObject({ total: 1, has_more: false, items: [{ descriptor: "Zeynep Demir" }] });
    const token = fake.calls[0]!;
    expect(token.headers.get("authorization")).toBe(basicHeader("wd-client", "wd-secret"));
    expect(Object.fromEntries(token.form!)).toEqual({ grant_type: "refresh_token", refresh_token: "wd-refresh" });
    const search = fake.calls[1]!;
    expect(search.headers.get("authorization")).toBe("Bearer wd-token");
    expect(search.url.searchParams.get("search")).toBe("Zeynep");
    expect(search.url.searchParams.get("limit")).toBe("20");
  });
});

describe("webhook-inbound", () => {
  it("describes an inbound trigger without operations", async () => {
    expect(webhookInboundConnector.manifest.operations).toEqual([]);
    expect(webhookInboundConnector.manifest.events.map((e) => e.id)).toEqual(["submission"]);
    expect((await webhookInboundConnector.test(makeCtx())).ok).toBe(true);
    await expect(webhookInboundConnector.execute("anything", {}, makeCtx())).rejects.toMatchObject({ code: "unsupported" });
  });

  it("signs and verifies payloads with HMAC-SHA256 in constant time", () => {
    const body = JSON.stringify({ full_name: "Mert Yalçın", email: "mert.yalcin@mail.example", requisition_id: "REQ-301" });
    const signature = signWebhookPayload("whsec_123", body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("whsec_123", body, signature)).toBe(true);
    expect(verifyWebhookSignature("whsec_123", Buffer.from(body), signature.replace("sha256=", ""))).toBe(true);
    expect(verifyWebhookSignature("whsec_123", `${body} `, signature)).toBe(false);
    expect(verifyWebhookSignature("other", body, signature)).toBe(false);
    expect(verifyWebhookSignature("whsec_123", body, "sha256=abc")).toBe(false);
    expect(verifyWebhookSignature("whsec_123", body, undefined)).toBe(false);
  });
});
