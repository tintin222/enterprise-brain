import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, successFactorsConnector } from "../src/index.ts";
import { basicHeader, expectConnectorError, FakeFetch, json, makeCtx, run, text } from "./helpers.ts";

const API = "https://api55.sapsf.eu";
const ODATA = `${API}/odata/v2`;

function basicCtx(fake: FakeFetch) {
  return makeCtx({ fetch: fake.fetch, config: { api_url: API, company_id: "ACMEENDUST", username: "eb_api" }, secrets: { password: "sf-pass" } });
}

describe("sap-successfactors", () => {
  beforeEach(() => clearTokenCache());

  it("searches users with basic auth (user@company) and $format=json", async () => {
    const fake = new FakeFetch().on("GET", `${ODATA}/User`, json({
      d: {
        results: [
          { __metadata: { uri: "u" }, userId: "100231", displayName: "Zeynep Demir", email: "zeynep.demir@acme.example", hireDate: `/Date(${Date.UTC(2019, 2, 1)})/`, manager: { __metadata: {}, userId: "100001", displayName: "Mehmet Aydın" } },
        ],
      },
    }));
    const result = await run(successFactorsConnector, "search_users", { query: "Zeynep", department: "Human Resources", status: "active", top: 10 }, basicCtx(fake));
    expect(result.items).toEqual([
      { userId: "100231", displayName: "Zeynep Demir", email: "zeynep.demir@acme.example", hireDate: "2019-03-01", manager: { userId: "100001", displayName: "Mehmet Aydın" } },
    ]);
    const call = fake.calls[0]!;
    expect(call.headers.get("authorization")).toBe(basicHeader("eb_api@ACMEENDUST", "sf-pass"));
    expect(call.url.searchParams.get("$format")).toBe("json");
    expect(call.url.searchParams.get("$expand")).toBe("manager");
    expect(call.url.searchParams.get("$filter")).toBe(
      "(substringof('Zeynep',displayName) or substringof('Zeynep',email) or userId eq 'Zeynep') and department eq 'Human Resources' and status eq 't'",
    );
  });

  it("reads employment and current job information", async () => {
    const fake = new FakeFetch()
      .on("GET", `${ODATA}/EmpEmployment`, json({ d: { results: [{ personIdExternal: "100231", userId: "100231", startDate: `/Date(${Date.UTC(2019, 2, 1)})/` }] } }))
      .on("GET", `${ODATA}/EmpJob`, json({ d: { results: [{ userId: "100231", jobTitle: "HR Director", department: "HR", managerId: "100001", costCenter: "CC-3000" }] } }));
    const result = await run(successFactorsConnector, "get_employment", { user_id: "100231" }, basicCtx(fake));
    expect(result).toMatchObject({ user_id: "100231", employment: { startDate: "2019-03-01" }, job: { jobTitle: "HR Director", costCenter: "CC-3000" } });
    const job = fake.callsTo("GET", `${ODATA}/EmpJob`)[0]!;
    expect(job.url.searchParams.get("$filter")).toBe("userId eq '100231'");
    expect(job.url.searchParams.get("$orderby")).toBe("startDate desc");
  });

  it("uses the OAuth 2.0 SAML bearer flow when configured", async () => {
    const fake = new FakeFetch()
      .on("POST", `${API}/oauth/idp`, text("PHNhbWwyOkFzc2VydGlvbj4uLi48L3NhbWwyOkFzc2VydGlvbj4="))
      .on("POST", `${API}/oauth/token`, json({ access_token: "sf-oauth-token", token_type: "Bearer", expires_in: 86399 }))
      .on("GET", `${ODATA}/User('100231')`, json({ d: { userId: "100231", displayName: "Zeynep Demir" } }));
    const ctx = makeCtx({
      fetch: fake.fetch,
      config: { api_url: API, company_id: "ACMEENDUST", auth_type: "oauth2", client_id: "NGE5YzFmMjU", oauth_user_id: "eb_api" },
      secrets: { private_key: "TUlJRXZ3SUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2t3Z2dTbEFnRUFBb0lCQVFD" },
    });
    const user = await run(successFactorsConnector, "get_user", { user_id: "100231" }, ctx);
    expect(user).toEqual({ userId: "100231", displayName: "Zeynep Demir" });
    const idp = fake.calls[0]!;
    expect(Object.fromEntries(idp.form!)).toEqual({
      client_id: "NGE5YzFmMjU",
      user_id: "eb_api",
      token_url: `${API}/oauth/token`,
      private_key: "TUlJRXZ3SUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2t3Z2dTbEFnRUFBb0lCQVFD",
    });
    const token = fake.calls[1]!;
    expect(Object.fromEntries(token.form!)).toEqual({
      company_id: "ACMEENDUST",
      grant_type: "urn:ietf:params:oauth:grant-type:saml2-bearer",
      assertion: "PHNhbWwyOkFzc2VydGlvbj4uLi48L3NhbWwyOkFzc2VydGlvbj4=",
      client_id: "NGE5YzFmMjU",
    });
    expect(fake.calls[2]!.headers.get("authorization")).toBe("Bearer sf-oauth-token");
    await run(successFactorsConnector, "get_user", { user_id: "100231" }, ctx);
    expect(fake.callsTo("POST", `${API}/oauth/token`)).toHaveLength(1);
  });

  it("reports missing employment as not_found", async () => {
    const fake = new FakeFetch().on("GET", `${ODATA}/EmpEmployment`, json({ d: { results: [] } })).on("GET", `${ODATA}/EmpJob`, json({ d: { results: [] } }));
    expect((await expectConnectorError(successFactorsConnector.execute("get_employment", { user_id: "x" }, basicCtx(fake)))).code).toBe("not_found");
  });
});
