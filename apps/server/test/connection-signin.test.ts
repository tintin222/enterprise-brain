import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Signing a web-service connection in with OAuth 2.0: an admin goes to the provider (with PKCE) and
 * comes back; the refresh token is kept, encrypted, and the connection works from then on. The state
 * is single-use and belongs to the admin who started.
 */

const AUTHORIZE = "https://login.partner.example/authorize";
const TOKEN = "https://login.partner.example/token";
const API = "https://api.partner.example/v2";

describe("signing a connection in", () => {
  let t: TestApp;
  let companyId: string;
  let connectionId: string;
  const realFetch = globalThis.fetch;
  const tokenRequests: URLSearchParams[] = [];
  const apiAuth: (string | null)[] = [];
  const cookieOf = async (email: string) =>
    String((await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } })).headers["set-cookie"]).split(";")[0]!;

  beforeAll(async () => {
    // The provider and the partner's API.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === TOKEN) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          return form.get("code") === "good-code"
            ? Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
            : Response.json({ error: "invalid_grant", error_description: "The code was already used" }, { status: 400 });
        }
        return Response.json({ access_token: `access-for-${form.get("refresh_token")}`, expires_in: 3600 });
      }
      if (url.startsWith(API)) {
        apiAuth.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ ok: true });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] }, publicUrl: "https://brain.acme.test" } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    connectionId = (
      await t.platform.connectors.create(companyId, {
        type: "rest-api",
        name: "Partner API",
        values: {
          base_url: API,
          auth_type: "oauth2_authorization_code",
          authorize_url: AUTHORIZE,
          token_url: TOKEN,
          client_id: "brain-app",
          client_secret: "app-secret",
          scope: "orders offline_access",
        },
      })
    ).id;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await t?.close();
  });

  it("sends the admin to the provider with PKCE, and keeps the refresh token that comes back", async () => {
    const mehmet = await cookieOf("mehmet.oz@acme.com.tr");
    const start = await t.app.inject({ url: `/api/companies/acme/connectors/${connectionId}/oauth/start`, headers: { cookie: mehmet } });
    expect(start.statusCode, start.body).toBe(302);
    const location = new URL(String(start.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE);
    const params = Object.fromEntries(location.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "brain-app",
      redirect_uri: "https://brain.acme.test/api/connectors/oauth/callback",
      scope: "orders offline_access",
      code_challenge_method: "S256",
    });
    expect(params.code_challenge).toMatch(/^[\w-]{43}$/);

    const back = await t.app.inject({ url: `/api/connectors/oauth/callback?state=${params.state}&code=good-code`, headers: { cookie: mehmet } });
    expect(back.statusCode, back.body).toBe(302);
    expect(back.headers.location).toBe(`/settings/connections?signin=ok&connection=${connectionId}`);
    const exchange = tokenRequests.find((f) => f.get("grant_type") === "authorization_code")!;
    expect(Object.fromEntries(exchange)).toMatchObject({
      code: "good-code",
      redirect_uri: "https://brain.acme.test/api/connectors/oauth/callback",
      client_id: "brain-app",
    });
    // PKCE: the verifier matches the challenge the provider saw.
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(params.code_challenge);

    const connection = await t.platform.connectors.get(companyId, connectionId);
    expect(connection.secretFields).toEqual(expect.arrayContaining(["client_secret", "refresh_token"]));
    expect(connection.status).toBe("ok");
    expect(apiAuth.at(-1)).toBe("Bearer access-for-refresh-1");

    // The state was used up: coming back twice doesn't work.
    const again = await t.app.inject({ url: `/api/connectors/oauth/callback?state=${params.state}&code=good-code`, headers: { cookie: mehmet } });
    expect(again.headers.location).toBe("/settings/connections?signin=expired");
    const audit = (await t.platform.activity.list(companyId, 20)).find((a) => a.action === "connector.signed_in");
    expect(audit).toMatchObject({ summary: "Signed Partner API in with OAuth 2.0" });
  });

  it("belongs to the admin who started it, and says why a sign-in failed", async () => {
    const mehmet = await cookieOf("mehmet.oz@acme.com.tr");
    const start = await t.app.inject({ url: `/api/companies/acme/connectors/${connectionId}/oauth/start`, headers: { cookie: mehmet } });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const elif = await cookieOf("elif.arslan@acme.com.tr");
    expect((await t.app.inject({ url: `/api/connectors/oauth/callback?state=${state}&code=good-code`, headers: { cookie: elif } })).statusCode).toBe(403);

    const retry = await t.app.inject({ url: `/api/companies/acme/connectors/${connectionId}/oauth/start`, headers: { cookie: mehmet } });
    const next = new URL(String(retry.headers.location)).searchParams.get("state")!;
    const failed = await t.app.inject({ url: `/api/connectors/oauth/callback?state=${next}&code=used-code`, headers: { cookie: mehmet } });
    const location = new URL(String(failed.headers.location), "https://brain.acme.test");
    expect(location.searchParams.get("signin")).toBe("failed");
    expect(location.searchParams.get("reason")).toMatch(/already used/);

    expect((await t.app.inject({ url: `/api/companies/acme/connectors/${connectionId}/oauth/start`, headers: { cookie: elif } })).statusCode).toBe(403);
  });
});
