import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { microsoftProvider } from "../src/auth/oidc.ts";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * People and sign-in (EB_AUTH=accounts): first start, passwords, demo people, what each role may see
 * and change, Microsoft/Google-style sign-in against a stand-in OpenID provider, and the API key.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

/** The session cookie from a response, ready to send back. */
function cookieFrom(response: { headers: Record<string, unknown> }, name = "eb_session"): string {
  const header = response.headers["set-cookie"];
  const list = Array.isArray(header) ? header : [header];
  const found = list.map(String).find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie in ${JSON.stringify(header)}`);
  return found.split(";")[0]!;
}

// ---------------------------------------------------------------------------
// A stand-in OpenID Connect provider (the part of Microsoft Entra ID / Google a sign-in touches)
// ---------------------------------------------------------------------------

interface FakeProvider {
  url: string;
  server: Server;
  /** Who signs in next, and with what nonce (taken from the authorization request). */
  next: { email: string; name?: string; audience?: string; nonce?: string; emailVerified?: boolean };
  challenges: Map<string, string>;
}

async function startFakeProvider(clientId: string): Promise<FakeProvider> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const fake: FakeProvider = { url: "", server: createServer(), next: { email: "" }, challenges: new Map() };
  const readBody = async (request: IncomingMessage) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    return new URLSearchParams(raw);
  };
  fake.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", fake.url);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer: fake.url, authorization_endpoint: `${fake.url}/authorize`, token_endpoint: `${fake.url}/token`, jwks_uri: `${fake.url}/jwks` });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && request.method === "POST") {
      const form = await readBody(request);
      // PKCE: the verifier must hash to the challenge sent with the authorization request.
      const challenge = fake.challenges.get(form.get("code") ?? "");
      const hashed = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!challenge || challenge !== hashed || form.get("client_secret") !== "s3cret") return json(400, { error: "invalid_grant" });
      const claims = { email: fake.next.email, name: fake.next.name ?? "Signed In", nonce: fake.next.nonce };
      const idToken = await new SignJWT(fake.next.emailVerified === undefined ? claims : { ...claims, email_verified: fake.next.emailVerified })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(fake.url)
        .setAudience(fake.next.audience ?? clientId)
        .setSubject(`sub-${fake.next.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { id_token: idToken, access_token: "x", token_type: "Bearer" });
    }
    return json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

describe("first start", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ seed: false, config: ACCOUNTS });
  });
  afterAll(() => t?.close());

  it("asks for the first admin, and nothing else opens without signing in", async () => {
    const state = (await t.app.inject("/api/auth/state")).json();
    expect(state).toMatchObject({ mode: "accounts", setupRequired: true, viewer: null });
    expect((await t.app.inject("/api/companies/acme/agents")).statusCode).toBe(401);

    const setup = await t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { name: "Mehmet Öz", email: "Mehmet@Acme.com.tr", password: "correct horse" } });
    expect(setup.statusCode, setup.body).toBe(200);
    const cookie = cookieFrom(setup);
    expect(String(setup.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/);
    const me = (await t.app.inject({ url: "/api/auth/state", headers: { cookie } })).json();
    expect(me.viewer).toMatchObject({ name: "Mehmet Öz", email: "mehmet@acme.com.tr", isAdmin: true });
    expect((await t.app.inject({ url: "/api/companies/acme/agents", headers: { cookie } })).statusCode).toBe(200);

    const again = await t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { name: "Someone", email: "x@acme.com.tr", password: "another one" } });
    expect(again.statusCode).toBe(409);
  });

  it("signs in with a password, refuses a wrong one, and signs out", async () => {
    const wrong = await t.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "mehmet@acme.com.tr", password: "nope nope" } });
    expect(wrong.statusCode).toBe(401);
    const right = await t.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "MEHMET@acme.com.tr", password: "correct horse" } });
    expect(right.statusCode, right.body).toBe(200);
    const cookie = cookieFrom(right);
    expect((await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie } })).statusCode).toBe(200);
    await t.app.inject({ method: "POST", url: "/api/auth/signout", headers: { cookie } });
    expect((await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("demo people and departments", () => {
  let t: TestApp;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
  });
  afterAll(() => t?.close());

  it("offers one-click sign-in as the demo people", async () => {
    const state = (await t.app.inject("/api/auth/state")).json();
    expect(state.setupRequired).toBe(false);
    expect(state.demo.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["Ayşe Yılmaz", "Elif Arslan", "Mehmet Öz"]));
    const refused = await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "someone@else.com" } });
    expect(refused.statusCode).toBe(403);
  });

  it("shows a worker their own department's AI employees and the company-wide ones", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const agents = (await t.app.inject({ url: "/api/companies/acme/agents", headers: { cookie: elif } })).json() as { slug: string; departmentId: string | null }[];
    const departments = await t.platform.catalog.departments((await t.platform.company("acme"))!.id);
    const keyOf = (id: string | null) => departments.find((d) => d.id === id)?.key;
    const keys = new Set(agents.map((a) => keyOf(a.departmentId)));
    expect(keys.has("finance")).toBe(true);
    expect(keys.has("shared-services")).toBe(true);
    expect(keys.has("hr")).toBe(false);

    const hrAgent = (await t.platform.agents.list((await t.platform.company("acme"))!.id)).find((a) => keyOf(a.row.departmentId) === "hr")!;
    expect((await t.app.inject({ url: `/api/companies/acme/agents/${hrAgent.row.slug}`, headers: { cookie: elif } })).statusCode).toBe(404);
  });

  it("lets a manager run their department's AI employees, but not a worker", async () => {
    const companyId = (await t.platform.company("acme"))!.id;
    const departments = await t.platform.catalog.departments(companyId);
    const finance = departments.find((d) => d.key === "finance")!;
    const agent = (await t.platform.agents.list(companyId)).find((a) => a.row.departmentId === finance.id)!;
    const pause = (cookie: string) =>
      t.app.inject({ method: "POST", url: `/api/companies/acme/agents/${agent.row.slug}/status`, headers: { cookie }, payload: { status: "paused" } });
    expect((await pause(await as("elif.arslan@acme.com.tr"))).statusCode).toBe(403);
    expect((await pause(await as("burak.sahin@acme.com.tr"))).statusCode).toBe(200);
    expect((await pause(await as("ayse.yilmaz@acme.com.tr"))).statusCode).toBe(404);
  });

  it("keeps people management and connections for admins", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const colleagues = (await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie: elif } })).json() as { name: string }[];
    expect(colleagues.map((p) => p.name)).toEqual(expect.arrayContaining(["Burak Şahin", "Elif Arslan", "Mehmet Öz"]));
    expect(colleagues.map((p) => p.name)).not.toContain("Ayşe Yılmaz");
    const everyone = (await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie: mehmet } })).json() as unknown[];
    expect(everyone.length).toBe(8);

    const add = (cookie: string) =>
      t.app.inject({ method: "POST", url: "/api/companies/acme/people", headers: { cookie }, payload: { name: "New Person", email: "new.person@acme.com.tr" } });
    expect((await add(elif)).statusCode).toBe(403);
    expect((await add(mehmet)).statusCode).toBe(200);
    expect((await t.app.inject({ method: "POST", url: "/api/companies/acme/connectors", headers: { cookie: elif }, payload: { type: "rest-api" } })).statusCode).toBe(403);
  });

  it("never leaves the company without an active admin", async () => {
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const me = (await t.app.inject({ url: "/api/me", headers: { cookie: mehmet } })).json();
    const demote = await t.app.inject({ method: "PUT", url: `/api/companies/acme/people/${me.id}`, headers: { cookie: mehmet }, payload: { role: "member" } });
    expect(demote.statusCode).toBe(409);
  });

  it("accepts changes only from the app's own pages", async () => {
    const companyId = (await t.platform.company("acme"))!.id;
    const departments = await t.platform.catalog.departments(companyId);
    const itDepartment = departments.find((d) => d.key === "it")!;
    const agent = (await t.platform.agents.list(companyId)).find((a) => a.row.departmentId === itDepartment.id)!;
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const pause = (headers: Record<string, string>) =>
      t.app.inject({ method: "POST", url: `/api/companies/acme/agents/${agent.row.slug}/status`, headers: { cookie: mehmet, ...headers }, payload: { status: "paused" } });
    // A sibling site (another port or subdomain) gets the cookie too, but may not act for the person.
    expect((await pause({ "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await pause({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await pause({ origin: "http://intranet.brain.test" })).statusCode).toBe(403);
    expect((await pause({ "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await pause({ origin: "http://brain.test" })).statusCode).toBe(200);
    // Reading is fine, and sign-in can't be forged either.
    expect((await t.app.inject({ url: "/api/companies/acme/agents", headers: { cookie: mehmet, "sec-fetch-site": "cross-site" } })).statusCode).toBe(200);
    const forged = await t.app.inject({ method: "POST", url: "/api/auth/demo", headers: { "sec-fetch-site": "cross-site" }, payload: { email: "elif.arslan@acme.com.tr" } });
    expect(forged.statusCode).toBe(403);
  });

  it("limits Microsoft sign-in to the organisation's own tenant", async () => {
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const save = (tenant?: string) =>
      t.app.inject({ method: "PUT", url: "/api/companies/acme/sign-in", headers: { cookie: mehmet }, payload: { microsoft: { clientId: "app-1", secret: "s", tenant } } });
    expect((await save()).statusCode).toBe(400);
    expect((await save("organizations")).statusCode).toBe(400);
    expect((await save("common")).statusCode).toBe(400);
    const saved = await save("acme.com.tr");
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().microsoft).toMatchObject({ configured: true, source: "settings", clientId: "app-1", tenant: "acme.com.tr" });
    expect(JSON.stringify(saved.json())).not.toContain('"s"');
    const state = (await t.app.inject("/api/auth/state")).json();
    expect(state.providers).toEqual([{ id: "microsoft", label: "Microsoft" }]);
    expect(() => microsoftProvider({ clientId: "a", clientSecret: "b", tenant: "" })).toThrow(/tenant/);
    expect(microsoftProvider({ clientId: "a", clientSecret: "b", tenant: "acme.com.tr" }).issuer).toBe("https://login.microsoftonline.com/acme.com.tr/v2.0");
  });

  it("signs a disabled person out at once", async () => {
    const mehmet = await as("mehmet.oz@acme.com.tr");
    const deniz = await as("deniz.aydin@acme.com.tr");
    const people = (await t.app.inject({ url: "/api/companies/acme/people", headers: { cookie: mehmet } })).json() as { id: string; name: string }[];
    const id = people.find((p) => p.name === "Deniz Aydın")!.id;
    await t.app.inject({ method: "PUT", url: `/api/companies/acme/people/${id}`, headers: { cookie: mehmet }, payload: { status: "disabled" } });
    expect((await t.app.inject({ url: "/api/companies/acme/agents", headers: { cookie: deniz } })).statusCode).toBe(401);
  });
});

describe("sign-in with Microsoft or Google (OpenID Connect)", () => {
  let t: TestApp;
  let fake: FakeProvider;

  beforeAll(async () => {
    fake = await startFakeProvider("client-1");
    t = await createTestApp({
      seed: false,
      config: ACCOUNTS,
      oidcProviders: [
        { id: "test", label: "Test", issuer: fake.url, clientId: "client-1", clientSecret: "s3cret" },
        { id: "strict", label: "Strict", issuer: fake.url, clientId: "client-1", clientSecret: "s3cret", requireVerifiedEmail: true },
      ],
    });
    const company = (await t.platform.company("acme"))!;
    await t.platform.people.create(company.id, { email: "ayse.yilmaz@acme.com.tr", name: "Ayşe Yılmaz", role: "admin" });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((resolve) => fake?.server.close(() => resolve()));
  });

  /** Start at the app, "sign in" at the provider, come back to the callback. */
  async function signIn(email: string, overrides: Partial<FakeProvider["next"]> = {}, tamperState = false, provider = "test") {
    const start = await t.app.inject({ url: `/api/auth/oidc/${provider}/start?returnTo=/work` });
    expect(start.statusCode).toBe(302);
    const location = new URL(String(start.headers.location));
    expect(location.origin).toBe(fake.url);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    fake.challenges.set("code-1", location.searchParams.get("code_challenge")!);
    fake.next = { email, nonce: location.searchParams.get("nonce")!, ...overrides };
    const state = tamperState ? "forged" : location.searchParams.get("state")!;
    return t.app.inject({ url: `/api/auth/oidc/${provider}/callback?code=code-1&state=${encodeURIComponent(state)}`, headers: { cookie: cookieFrom(start, "eb_sign_in") } });
  }

  it("signs in a person who has an account", async () => {
    const callback = await signIn("Ayse.Yilmaz@acme.com.tr");
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/work");
    const state = (await t.app.inject({ url: "/api/auth/state", headers: { cookie: cookieFrom(callback) } })).json();
    expect(state.viewer).toMatchObject({ name: "Ayşe Yılmaz", isAdmin: true });
  });

  it("refuses people without an account, unless their domain may join", async () => {
    const refused = await signIn("stranger@acme.com.tr");
    expect(String(refused.headers.location)).toMatch(/^\/signin\?error=.*has%20no%20account/);

    const company = (await t.platform.company("acme"))!;
    await t.app.inject({ method: "PUT", url: "/api/companies/acme/sign-in", headers: { cookie: cookieFrom(await signIn("ayse.yilmaz@acme.com.tr")) }, payload: { autoJoinDomains: ["acme.com.tr"] } });
    const joined = await signIn("new.hire@acme.com.tr", { name: "New Hire" });
    expect(joined.headers.location).toBe("/work");
    const person = await t.platform.people.findByEmail(company.id, "new.hire@acme.com.tr");
    expect(person).toMatchObject({ name: "New Hire", role: "member" });
  });

  it("rejects a forged state, a token for another app and a replayed nonce", async () => {
    expect(String((await signIn("ayse.yilmaz@acme.com.tr", {}, true)).headers.location)).toMatch(/^\/signin\?error=/);
    expect(String((await signIn("ayse.yilmaz@acme.com.tr", { audience: "another-app" })).headers.location)).toMatch(/could%20not%20be%20verified/);
    expect(String((await signIn("ayse.yilmaz@acme.com.tr", { nonce: "old-nonce" })).headers.location)).toMatch(/does%20not%20belong/);
  });

  it("requires a verified email where the provider vouches for it (Google)", async () => {
    expect(String((await signIn("ayse.yilmaz@acme.com.tr", {}, false, "strict")).headers.location)).toMatch(/not%20verified/);
    expect(String((await signIn("ayse.yilmaz@acme.com.tr", { emailVerified: false }, false, "strict")).headers.location)).toMatch(/not%20verified/);
    expect((await signIn("ayse.yilmaz@acme.com.tr", { emailVerified: true }, false, "strict")).headers.location).toBe("/work");
  });
});

describe("machines: the API key and MCP", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ seed: false, config: { ...ACCOUNTS, apiKey: "machine-key" } });
  });
  afterAll(() => t?.close());

  it("accepts the console API key instead of a session, and requires it for MCP", async () => {
    expect((await t.app.inject({ url: "/api/companies/acme/agents", headers: { authorization: "Bearer machine-key" } })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/companies/acme/agents", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);
  });
});
