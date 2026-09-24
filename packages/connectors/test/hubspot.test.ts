import { describe, expect, it } from "vitest";
import { hubspotConnector } from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const API = "https://api.hubapi.com";

function ctxFor(fake: FakeFetch) {
  return makeCtx({ fetch: fake.fetch, secrets: { access_token: "pat-eu1-11111111-2222" } });
}

const contact = (id: number) => ({ id: String(id), properties: { email: `c${id}@example.com` }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", archived: false });

describe("hubspot", () => {
  it("searches objects with filters and follows paging.next.after", async () => {
    const fake = new FakeFetch()
      .once("POST", `${API}/crm/v3/objects/contacts/search`, json({
        total: 230,
        results: Array.from({ length: 100 }, (_, i) => contact(i + 1)),
        paging: { next: { after: "100" } },
      }))
      .on("POST", `${API}/crm/v3/objects/contacts/search`, json({
        total: 230,
        results: Array.from({ length: 50 }, (_, i) => contact(i + 101)),
        paging: { next: { after: "150" } },
      }));
    const result = await run(
      hubspotConnector,
      "search_objects",
      { object_type: "Contacts", query: "hansa", filters: [{ propertyName: "lifecyclestage", operator: "eq", value: "customer" }], properties: "email,firstname", limit: 150 },
      ctxFor(fake),
    );
    expect(result.items).toHaveLength(150);
    expect(result).toMatchObject({ total: 230, has_more: true, next_after: "150" });
    expect(result.items[0]).toEqual({ id: "1", properties: { email: "c1@example.com" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", archived: false });
    const [first, second] = fake.calls;
    expect(first!.headers.get("authorization")).toBe("Bearer pat-eu1-11111111-2222");
    expect(first!.json).toEqual({
      query: "hansa",
      filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] }],
      properties: ["email", "firstname"],
      limit: 100,
    });
    expect(second!.json).toMatchObject({ after: "100", limit: 50 });
  });

  it("gets, creates and updates objects", async () => {
    const fake = new FakeFetch()
      .on("GET", `${API}/crm/v3/objects/contacts/y%40example.com`, json(contact(7)))
      .on("POST", `${API}/crm/v3/objects/contacts`, (req) => json({ id: "501", properties: (req.json as any).properties, createdAt: "t", updatedAt: "t", archived: false }, 201))
      .on("PATCH", `${API}/crm/v3/objects/deals/9001`, (req) => json({ id: "9001", properties: (req.json as any).properties, createdAt: "t", updatedAt: "u", archived: false }));
    const ctx = ctxFor(fake);
    const got = await run(hubspotConnector, "get_object", { object_type: "contacts", object_id: "y@example.com", id_property: "email", associations: "companies" }, ctx);
    expect(got.id).toBe("7");
    const getCall = fake.calls[0]!;
    expect(getCall.url.searchParams.get("idProperty")).toBe("email");
    expect(getCall.url.searchParams.get("associations")).toBe("companies");
    expect(getCall.url.searchParams.get("properties")).toContain("lifecyclestage");
    const created = await run(hubspotConnector, "create_object", { object_type: "contacts", properties: { email: "y@example.com", firstname: "Yasemin" } }, ctx);
    expect(created).toMatchObject({ ok: true, object_type: "contacts", id: "501", properties: { firstname: "Yasemin" } });
    const updated = await run(hubspotConnector, "update_object", { object_type: "deals", object_id: "9001", properties: { dealstage: "closedwon" } }, ctx);
    expect(updated).toMatchObject({ ok: true, id: "9001", properties: { dealstage: "closedwon" } });
    expect(fake.callsTo("PATCH", `${API}/crm/v3/objects/deals/9001`)[0]!.json).toEqual({ properties: { dealstage: "closedwon" } });
  });

  it("maps rate limits and validation errors", async () => {
    const fake = new FakeFetch()
      .on("POST", `${API}/crm/v3/objects/contacts/search`, json({ status: "error", message: "You have reached your secondly limit.", category: "RATE_LIMITS" }, 429))
      .on("POST", `${API}/crm/v3/objects/contacts`, json({ status: "error", message: "Property values were not valid", category: "VALIDATION_ERROR" }, 400));
    const ctx = ctxFor(fake);
    expect(await expectConnectorError(hubspotConnector.execute("search_objects", { object_type: "contacts" }, ctx))).toMatchObject({ code: "remote", status: 429 });
    expect(await expectConnectorError(hubspotConnector.execute("create_object", { object_type: "contacts", properties: { email: "x" } }, ctx))).toMatchObject({
      code: "validation",
      message: "HubSpot returned HTTP 400: Property values were not valid",
    });
    expect((await expectConnectorError(hubspotConnector.execute("search_objects", { object_type: "contacts/../x" }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(hubspotConnector.execute("search_objects", { object_type: "contacts", filters: [{ propertyName: "a", operator: "LIKE" }] }, ctx))).code).toBe(
      "validation",
    );
  });

  it("tests the token by reading one contact", async () => {
    const fake = new FakeFetch().on("GET", `${API}/crm/v3/objects/contacts`, json({ results: [] }));
    expect((await hubspotConnector.test(ctxFor(fake))).ok).toBe(true);
    const unauthorized = new FakeFetch().on("GET", `${API}/crm/v3/objects/contacts`, json({ status: "error", message: "Authentication credentials not found." }, 401));
    expect(await hubspotConnector.test(ctxFor(unauthorized))).toMatchObject({ ok: false, details: { code: "auth" } });
  });
});
