import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, dynamics365Connector } from "../src/index.ts";
import { empty, expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const ORG = "https://acme.crm4.dynamics.com";
const API = `${ORG}/api/data/v9.2`;
const TOKEN_URL = "https://login.microsoftonline.com/7f3a2c1e-0000-4000-8000-000000000001/oauth2/v2.0/token";
const GUID = "5f2c1b4e-3a0d-ef11-9f89-000d3a4b1c2d";

function ctxFor(fake: FakeFetch) {
  return makeCtx({
    fetch: fake.fetch,
    config: { org_url: ORG, tenant_id: "7f3a2c1e-0000-4000-8000-000000000001", client_id: "eb-app" },
    secrets: { client_secret: "entra-secret" },
  });
}

function withToken(fake: FakeFetch): FakeFetch {
  return fake.on("POST", TOKEN_URL, json({ token_type: "Bearer", expires_in: 3599, access_token: "dv-token" }));
}

describe("microsoft-dynamics-365", () => {
  beforeEach(() => clearTokenCache());

  it("gets an app-only token for the environment and queries with paging", async () => {
    const fake = withToken(new FakeFetch())
      .once("GET", `${API}/accounts`, json({
        "@odata.context": "x",
        value: [
          { "@odata.etag": "W/\"1\"", accountid: "a1", name: "Hansa Pumpen", "statecode@OData.Community.Display.V1.FormattedValue": "Active" },
          { accountid: "a2", name: "Hansa Service" },
        ],
        "@odata.nextLink": `${API}/accounts?$skiptoken=abc`,
      }))
      .on("GET", `${API}/accounts`, json({ value: [{ accountid: "a3" }, { accountid: "a4" }] }));
    const result = await run(
      dynamics365Connector,
      "query_records",
      { entity_set: "accounts", filter: "contains(name,'Hansa')", select: "name,accountnumber", orderby: "name asc", top: 3 },
      ctxFor(fake),
    );
    expect(result.items).toEqual([
      { accountid: "a1", name: "Hansa Pumpen", "statecode@OData.Community.Display.V1.FormattedValue": "Active" },
      { accountid: "a2", name: "Hansa Service" },
      { accountid: "a3" },
    ]);
    expect(result).toMatchObject({ total: 3, has_more: true });

    const token = fake.calls[0]!;
    expect(token.form!.get("scope")).toBe(`${ORG}/.default`);
    expect(token.form!.get("grant_type")).toBe("client_credentials");
    expect(token.form!.get("client_id")).toBe("eb-app");
    const query = fake.calls[1]!;
    expect(query.headers.get("authorization")).toBe("Bearer dv-token");
    expect(query.headers.get("odata-version")).toBe("4.0");
    expect(query.headers.get("prefer")).toBe('odata.maxpagesize=3,odata.include-annotations="OData.Community.Display.V1.FormattedValue"');
    expect(query.url.searchParams.get("$filter")).toBe("contains(name,'Hansa')");
    expect(query.url.searchParams.get("$select")).toBe("name,accountnumber");
    expect(fake.calls[2]!.url.searchParams.get("$skiptoken")).toBe("abc");
    expect(fake.callsTo("POST", TOKEN_URL)).toHaveLength(1);
  });

  it("creates a record and returns its id from OData-EntityId", async () => {
    const fake = withToken(new FakeFetch()).on("POST", `${API}/leads`, json({ leadid: GUID, subject: "Pump inquiry" }, 201, { "OData-EntityId": `${API}/leads(${GUID})` }));
    const result = await run(
      dynamics365Connector,
      "create_record",
      { entity_set: "leads", fields: { subject: "Pump inquiry", firstname: "Yasemin", "parentaccountid@odata.bind": "/accounts(a1)" } },
      ctxFor(fake),
    );
    expect(result).toMatchObject({ ok: true, id: GUID, entity_set: "leads", record: { leadid: GUID } });
    const post = fake.calls[1]!;
    expect(post.json).toEqual({ subject: "Pump inquiry", firstname: "Yasemin", "parentaccountid@odata.bind": "/accounts(a1)" });
    expect(post.headers.get("prefer")).toContain("return=representation");
  });

  it("updates a record with If-Match: * (no upsert)", async () => {
    const fake = withToken(new FakeFetch()).on("PATCH", `${API}/opportunities(${GUID})`, empty(204));
    const result = await run(dynamics365Connector, "update_record", { entity_set: "opportunities", id: `{${GUID}}`, fields: { estimatedvalue: 1_380_000 } }, ctxFor(fake));
    expect(result).toEqual({ ok: true, id: GUID, entity_set: "opportunities", record: null });
    expect(fake.calls[1]!.headers.get("if-match")).toBe("*");
    expect(fake.calls[1]!.json).toEqual({ estimatedvalue: 1_380_000 });
  });

  it("validates entity sets and ids and maps errors", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${API}/accounts(${GUID})`, json({ error: { code: "0x80040217", message: "account With Id = ... Does Not Exist" } }, 404));
    const ctx = ctxFor(fake);
    expect((await expectConnectorError(dynamics365Connector.execute("get_record", { entity_set: "accounts;drop", id: GUID }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(dynamics365Connector.execute("get_record", { entity_set: "accounts", id: "123" }, ctx))).code).toBe("validation");
    const missing = await expectConnectorError(dynamics365Connector.execute("get_record", { entity_set: "accounts", id: GUID }, ctx));
    expect(missing).toMatchObject({ code: "not_found", status: 404 });
  });

  it("tests the connection with WhoAmI", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${API}/WhoAmI`, json({ UserId: "u-1", BusinessUnitId: "b-1", OrganizationId: "o-1" }));
    expect(await dynamics365Connector.test(ctxFor(fake))).toMatchObject({ ok: true, details: { userId: "u-1" } });
  });
});
