import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, salesforceConnector, soqlString } from "../src/index.ts";
import { empty, expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const LOGIN = "https://acme.my.salesforce.com";
const INSTANCE = "https://acme--prod.my.salesforce.com";
const TOKEN_URL = `${LOGIN}/services/oauth2/token`;
const DATA = `${INSTANCE}/services/data/v62.0`;

function ctxFor(fake: FakeFetch, extra: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
  return makeCtx({
    fetch: fake.fetch,
    config: { login_url: LOGIN, client_id: "3MVG9-consumer-key", ...extra },
    secrets: { client_secret: "consumer-secret", ...secrets },
  });
}

function withToken(fake: FakeFetch): FakeFetch {
  let n = 0;
  return fake.on("POST", TOKEN_URL, () =>
    json({ access_token: `00Dxx!token-${++n}`, instance_url: INSTANCE, id: `${LOGIN}/id/00D/005`, token_type: "Bearer", issued_at: "1727170000000", signature: "sig" }),
  );
}

describe("salesforce", () => {
  beforeEach(() => clearTokenCache());

  it("uses the client credentials flow and the returned instance_url; pages SOQL results", async () => {
    const fake = withToken(new FakeFetch())
      .on("GET", `${DATA}/query`, json({
        totalSize: 3,
        done: false,
        nextRecordsUrl: "/services/data/v62.0/query/01gD0000002HU6KIAW-2000",
        records: [
          { attributes: { type: "Opportunity", url: "/x" }, Id: "006A", Name: "Hansa frame agreement", Account: { attributes: { type: "Account" }, Name: "Hansa" } },
          { attributes: { type: "Opportunity" }, Id: "006B", Name: "Gulf Water boosters", Account: null },
        ],
      }))
      .on("GET", `${DATA}/query/01gD0000002HU6KIAW-2000`, json({ totalSize: 3, done: true, records: [{ attributes: { type: "Opportunity" }, Id: "006C", Name: "Nordwind skids" }] }));
    const soql = "SELECT Id, Name, Account.Name FROM Opportunity WHERE IsClosed = false";
    const result = await run(salesforceConnector, "soql_query", { soql }, ctxFor(fake));
    expect(result).toEqual({
      items: [
        { Id: "006A", Name: "Hansa frame agreement", Account: { Name: "Hansa" } },
        { Id: "006B", Name: "Gulf Water boosters", Account: null },
        { Id: "006C", Name: "Nordwind skids" },
      ],
      total: 3,
      done: true,
    });
    const token = fake.calls[0]!;
    expect(Object.fromEntries(token.form!)).toEqual({ grant_type: "client_credentials", client_id: "3MVG9-consumer-key", client_secret: "consumer-secret" });
    const query = fake.calls[1]!;
    expect(query.url.origin).toBe(INSTANCE);
    expect(query.url.searchParams.get("q")).toBe(soql);
    expect(query.headers.get("authorization")).toBe("Bearer 00Dxx!token-1");
    expect(fake.calls[2]!.headers.get("authorization")).toBe("Bearer 00Dxx!token-1");
  });

  it("creates and updates records", async () => {
    const fake = withToken(new FakeFetch())
      .on("POST", `${DATA}/sobjects/Lead`, json({ id: "00Q5g00000ABCDEFGH", success: true, errors: [] }, 201))
      .on("PATCH", `${DATA}/sobjects/Opportunity/0065g00000XYZabcDE`, empty(204));
    const ctx = ctxFor(fake);
    const created = await run(salesforceConnector, "create_record", { sobject: "Lead", fields: { LastName: "Koç", Company: "Doğu Marmara Arıtma", Email: "y@example.com" } }, ctx);
    expect(created).toEqual({ ok: true, id: "00Q5g00000ABCDEFGH", sobject: "Lead", errors: [] });
    expect(fake.callsTo("POST", `${DATA}/sobjects/Lead`)[0]!.json).toEqual({ LastName: "Koç", Company: "Doğu Marmara Arıtma", Email: "y@example.com" });
    const updated = await run(salesforceConnector, "update_record", { sobject: "Opportunity", id: "0065g00000XYZabcDE", fields: { StageName: "Negotiation/Review" } }, ctx);
    expect(updated).toEqual({ ok: true, id: "0065g00000XYZabcDE", sobject: "Opportunity", updated_fields: ["StageName"] });
    expect(fake.callsTo("POST", TOKEN_URL)).toHaveLength(1);
  });

  it("finds contacts by e-mail with safely escaped SOQL", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${DATA}/query`, json({
      totalSize: 1,
      done: true,
      records: [{ attributes: { type: "Contact" }, Id: "003A", Email: "o'brien@example.com", Account: { attributes: {}, Name: "Acme" } }],
    }));
    const result = await run(salesforceConnector, "search_contacts_by_email", { email: "O'Brien@Example.com" }, ctxFor(fake));
    expect(result).toEqual({ items: [{ Id: "003A", Email: "o'brien@example.com", Account: { Name: "Acme" } }], total: 1 });
    expect(fake.calls[1]!.url.searchParams.get("q")).toContain("WHERE Email = 'o\\'brien@example.com'");
    expect(soqlString("a\\b'c\nd")).toBe("'a\\\\b\\'c\\nd'");
  });

  it("refreshes a revoked cached token once after a 401", async () => {
    const fake = withToken(new FakeFetch())
      .on("GET", `${DATA}/sobjects/Account/001A0000001aBcDEFG`, (req) =>
        req.headers.get("authorization") === "Bearer 00Dxx!token-1"
          ? json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], 401)
          : json({ attributes: { type: "Account" }, Id: "001A0000001aBcDEFG", Name: "Hansa" }),
      )
      .on("GET", `${DATA}/`, json({ sobjects: "/services/data/v62.0/sobjects", query: "/services/data/v62.0/query" }));
    const ctx = ctxFor(fake);
    expect((await salesforceConnector.test(ctx)).ok).toBe(true);
    const record = await run(salesforceConnector, "get_record", { sobject: "Account", id: "001A0000001aBcDEFG", fields: "Id,Name" }, ctx);
    expect(record).toEqual({ Id: "001A0000001aBcDEFG", Name: "Hansa" });
    expect(fake.callsTo("POST", TOKEN_URL)).toHaveLength(2);
    expect(fake.callsTo("GET", `${DATA}/sobjects/Account/001A0000001aBcDEFG`)[0]!.url.searchParams.get("fields")).toBe("Id,Name");
  });

  it("supports the refresh token flow and validates inputs", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${DATA}/query`, json({ totalSize: 0, done: true, records: [] }));
    const ctx = ctxFor(fake, { auth_type: "refresh_token" }, { refresh_token: "5Aep861-refresh" });
    await run(salesforceConnector, "soql_query", { soql: "SELECT Id FROM Account LIMIT 1" }, ctx);
    expect(fake.calls[0]!.form!.get("grant_type")).toBe("refresh_token");
    expect(fake.calls[0]!.form!.get("refresh_token")).toBe("5Aep861-refresh");
    expect((await expectConnectorError(salesforceConnector.execute("soql_query", { soql: "DELETE FROM Account" }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(salesforceConnector.execute("get_record", { sobject: "Account/../x", id: "001A0000001aBcDEFG" }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(salesforceConnector.execute("get_record", { sobject: "Account", id: "bad id" }, ctx))).code).toBe("validation");
  });

  it("reports token endpoint failures as auth errors", async () => {
    const fake = new FakeFetch().on("POST", TOKEN_URL, json({ error: "invalid_client", error_description: "invalid client credentials" }, 400));
    const result = await salesforceConnector.test(ctxFor(fake));
    expect(result).toMatchObject({ ok: false, details: { code: "auth" } });
    expect(result.message).toContain("invalid client credentials");
  });
});
