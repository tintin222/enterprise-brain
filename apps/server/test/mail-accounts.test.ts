import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailAccounts } from "@enterprise-brain/db";
import { ScriptedLlm, UnavailableLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { MailTaskReader, offlineMailTask, type PersonalMail } from "@enterprise-brain/runtime";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * A person's own Gmail, read for their to-dos: connected with Google (the sign-in client, offline access,
 * the Gmail scope checked), read from the first check on, each new email from a person a to-do (automatic
 * mail nothing), never twice, quiet senders left alone, the watcher checking on its pass, a lost
 * permission said so, disconnected on request; and nothing of it in the shared mail or the connections.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const base = "/api/companies/acme";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function cookieFrom(response: { headers: Record<string, unknown> }, name = "eb_session"): string {
  const header = response.headers["set-cookie"];
  const list = Array.isArray(header) ? header : [header];
  const found = list.map(String).find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie in ${JSON.stringify(header)}`);
  return found.split(";")[0]!;
}

interface FakeMail {
  internalDate: number;
  from: string;
  subject: string;
  labels: string[];
  body: string;
}

/** Google, as far as connecting and reading a mailbox touches it: sign-in discovery, tokens, revocation, and the Gmail API. */
interface FakeGoogle {
  url: string;
  server: Server;
  next: { email: string; nonce?: string; scope: string; refreshToken: string | null };
  challenges: Map<string, string>;
  messages: Map<string, FakeMail>;
  /** The refresh grant answers invalid_grant; the Gmail API answers 401 (so the token is refreshed). */
  revokedAtGoogle: boolean;
  refreshes: number;
  revoked: string[];
}

async function startFakeGoogle(clientId: string): Promise<FakeGoogle> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const fake: FakeGoogle = {
    url: "",
    server: createServer(),
    next: { email: "", scope: `openid email ${GMAIL_SCOPE}`, refreshToken: "rt-1" },
    challenges: new Map(),
    messages: new Map(),
    revokedAtGoogle: false,
    refreshes: 0,
    revoked: [],
  };
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
      return json(200, {
        issuer: fake.url,
        authorization_endpoint: `${fake.url}/authorize`,
        token_endpoint: `${fake.url}/token`,
        jwks_uri: `${fake.url}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && request.method === "POST") {
      const form = await readBody(request);
      if (form.get("grant_type") === "refresh_token") {
        if (fake.revokedAtGoogle) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        fake.refreshes += 1;
        return json(200, { access_token: `at-${fake.refreshes}`, token_type: "Bearer", expires_in: 3600 });
      }
      const challenge = fake.challenges.get(form.get("code") ?? "");
      const hashed = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (!challenge || challenge !== hashed || form.get("client_secret") !== "s3cret") return json(400, { error: "invalid_grant" });
      const idToken = await new SignJWT({ email: fake.next.email, email_verified: true, name: "Kerem (personal)", nonce: fake.next.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(fake.url)
        .setAudience(clientId)
        .setSubject(`sub-${fake.next.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, {
        id_token: idToken,
        access_token: "at-0",
        token_type: "Bearer",
        scope: fake.next.scope,
        ...(fake.next.refreshToken ? { refresh_token: fake.next.refreshToken } : {}),
      });
    }
    if (url.pathname === "/revoke") {
      fake.revoked.push(url.searchParams.get("token") ?? "");
      return json(200, {});
    }
    // The Gmail API, for one mailbox.
    if (url.pathname.startsWith("/gmail/")) {
      if (fake.revokedAtGoogle || !/^Bearer at-/.test(request.headers.authorization ?? ""))
        return json(401, { error: { code: 401, message: "Invalid Credentials" } });
      const rest = url.pathname.slice("/gmail/".length);
      if (rest === "messages") {
        const sorted = [...fake.messages].sort((a, b) => b[1].internalDate - a[1].internalDate);
        return json(200, { messages: sorted.map(([id]) => ({ id, threadId: `t-${id}` })) });
      }
      const id = decodeURIComponent(rest.replace(/^messages\//, ""));
      const mail = fake.messages.get(id);
      if (!mail) return json(404, { error: { code: 404, message: "Not Found" } });
      return json(200, {
        id,
        threadId: `t-${id}`,
        labelIds: mail.labels,
        internalDate: String(mail.internalDate),
        snippet: mail.body.slice(0, 80),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: mail.from },
            { name: "To", value: "kerem.personal@gmail.com" },
            { name: "Subject", value: mail.subject },
            { name: "Date", value: new Date(mail.internalDate).toUTCString() },
            { name: "Message-ID", value: `<${id}@example>` },
          ],
          body: { size: mail.body.length, data: Buffer.from(mail.body).toString("base64url") },
        },
      });
    }
    return json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

interface MyMail {
  configured: boolean;
  redirectUri: string;
  account: {
    address: string;
    status: string;
    tasksEnabled: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    checked: number;
    made: number;
    quietSenders: string[];
  } | null;
}

interface Todo {
  id: string;
  title: string;
  status: string;
  source: string;
  link: string | null;
  data: Record<string, unknown>;
}

describe("a person's Gmail, read for their to-dos", () => {
  let t: TestApp;
  let companyId = "";
  let fake: FakeGoogle;
  const as: Record<string, string> = {};
  const realFetch = globalThis.fetch;
  let startedAt = 0;
  const me = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, extraCookie?: string) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: [as[who]!, extraCookie].filter(Boolean).join("; ") },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const call = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => me(who, method, `${base}${url}`, payload);

  /** The person goes to Google and comes back: the start's redirect, then the callback with the code. */
  async function connect(who: string, returnTo: string): Promise<{ statusCode: number; location: string }> {
    const start = await me(who, "GET", `/api/me/mail/gmail/start?returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.statusCode, start.body).toBe(302);
    const url = new URL(String(start.headers.location));
    const code = `code-${Math.random().toString(16).slice(2)}`;
    fake.challenges.set(code, url.searchParams.get("code_challenge")!);
    fake.next.nonce = url.searchParams.get("nonce")!;
    const callback = await me(
      who,
      "GET",
      `/api/me/mail/gmail/callback?code=${code}&state=${url.searchParams.get("state")}`,
      undefined,
      cookieFrom(start, "eb_mail_connect"),
    );
    return { statusCode: callback.statusCode, location: String(callback.headers.location) };
  }

  beforeAll(async () => {
    fake = await startFakeGoogle("gclient");
    t = await createTestApp({
      seed: false,
      config: ACCOUNTS,
      oidcProviders: [{ id: "google", label: "Google", issuer: fake.url, clientId: "gclient", clientSecret: "s3cret", requireVerifiedEmail: true }],
    });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    for (const local of ["kerem.yildiz", "selin.acar"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
    // Google and Gmail stood in for: the connector's addresses go to the fake.
    t.platform.mailAccounts.useFetch(((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
        .replace("https://gmail.googleapis.com/gmail/v1/users/me", `${fake.url}/gmail`)
        .replace("https://oauth2.googleapis.com/token", `${fake.url}/token`)
        .replace("https://oauth2.googleapis.com/revoke", `${fake.url}/revoke`);
      return realFetch(url, init);
    }) as typeof fetch);
    startedAt = Date.now();
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("connects with Google: offline access to read mail, the scope and the refresh token checked, the address remembered, the secret kept sealed", async () => {
    const before = (await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail;
    expect(before).toEqual({ configured: true, redirectUri: "http://brain.test/api/me/mail/gmail/callback", account: null });

    const start = await me("kerem.yildiz", "GET", "/api/me/mail/gmail/start?returnTo=/work?view=todos");
    expect(start.statusCode, start.body).toBe(302);
    const url = new URL(String(start.headers.location));
    expect(url.origin + url.pathname).toBe(`${fake.url}/authorize`);
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_SCOPE}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("kerem.yildiz@acme.com.tr");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://brain.test/api/me/mail/gmail/callback");

    // Without the Gmail permission, or without offline access, nothing is connected.
    fake.next = { email: "kerem.personal@gmail.com", scope: "openid email", refreshToken: "rt-1" };
    const noScope = await connect("kerem.yildiz", "/work");
    expect(noScope.statusCode).toBe(302);
    expect(noScope.location).toMatch(/^\/\?gmail=error&message=.*did%20not%20grant/);
    fake.next = { email: "kerem.personal@gmail.com", scope: `openid email ${GMAIL_SCOPE}`, refreshToken: null };
    expect((await connect("kerem.yildiz", "/work")).location).toMatch(/no%20offline%20access/);
    expect(((await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail).account).toBeNull();

    // The real thing.
    fake.next = { email: "Kerem.Personal@gmail.com", scope: `openid email ${GMAIL_SCOPE}`, refreshToken: "rt-1" };
    const done = await connect("kerem.yildiz", "/work?view=todos");
    expect(done.statusCode).toBe(302);
    expect(done.location).toBe("/work?view=todos&gmail=connected");
    const mine = (await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail;
    expect(mine.account).toMatchObject({ address: "kerem.personal@gmail.com", status: "ok", tasksEnabled: true, lastCheckedAt: null, checked: 0, made: 0 });
    expect(JSON.stringify(mine)).not.toContain("rt-1");
    const [row] = await t.platform.handle.db.select().from(mailAccounts).where(eq(mailAccounts.companyId, companyId));
    expect(t.platform.secretBox.decrypt(row!.secretsCiphertext)).toEqual({ refresh_token: "rt-1" });
    // Someone else sees nothing of it.
    expect(((await me("selin.acar", "GET", "/api/me/mail")).json() as MyMail).account).toBeNull();
    // A stranger to this browser cannot finish a consent started by another: the sealed state names the person.
    expect((await t.app.inject({ method: "GET", url: "/api/me/mail/gmail/callback?code=x&state=y" })).statusCode).toBe(401);
  });

  it("reads from the first check on: a person's email becomes a to-do with a link back, automatic mail nothing, never twice", async () => {
    const first = (await me("kerem.yildiz", "POST", "/api/me/mail/check")).json() as { first: boolean; checked: number; made: number };
    expect(first).toEqual({ first: true, checked: 0, made: 0 });
    const at = Math.max(Date.now(), startedAt) + 2000;
    fake.messages.set("m1", {
      internalDate: at,
      from: "Ayşe Yılmaz <ayse@petrokim.example>",
      subject: "Offer for the portal",
      labels: ["INBOX", "UNREAD"],
      body: "Can you send the revised offer by Friday?\n\nAyşe",
    });
    fake.messages.set("m2", {
      internalDate: at + 100,
      from: "noreply@bank.example",
      subject: "Your statement is ready",
      labels: ["INBOX"],
      body: "Automatic message.",
    });
    fake.messages.set("m3", {
      internalDate: at + 200,
      from: "news@shop.example",
      subject: "Autumn sale",
      labels: ["INBOX", "CATEGORY_PROMOTIONS"],
      body: "Deals!",
    });
    const second = (await me("kerem.yildiz", "POST", "/api/me/mail/check")).json() as { first: boolean; checked: number; made: number };
    expect(second).toEqual({ first: false, checked: 3, made: 1 });
    const todos = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    expect(todos).toEqual([
      expect.objectContaining({
        title: "Reply to Ayşe Yılmaz: Offer for the portal",
        status: "open",
        source: "mail",
        link: "https://mail.google.com/mail/u/0/#all/m1",
        data: expect.objectContaining({ from: "Ayşe Yılmaz <ayse@petrokim.example>", subject: "Offer for the portal", threadId: "t-m1" }),
      }),
    ]);
    const third = (await me("kerem.yildiz", "POST", "/api/me/mail/check")).json() as { checked: number; made: number };
    expect(third.made).toBe(0);
    expect(((await call("kerem.yildiz", "GET", "/todos")).json() as Todo[]).length).toBe(1);
    const mine = (await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail;
    expect(mine.account).toMatchObject({ status: "ok", checked: 3, made: 1 });
    expect(mine.account!.lastCheckedAt).toBeTruthy();
    expect(((await call("selin.acar", "GET", "/todos")).json() as Todo[]).length).toBe(0);
  });

  it("says Not a task once, and hears no more from that sender; the watcher checks accounts on its pass", async () => {
    const [todo] = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    const dismissed = await call("kerem.yildiz", "PATCH", `/todos/${todo!.id}`, { status: "dismissed", quietSender: true });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(((await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail).account!.quietSenders).toEqual(["ayse@petrokim.example"]);
    fake.messages.set("m4", {
      internalDate: Date.now() + 4000,
      from: "ayse@petrokim.example",
      subject: "One more thing",
      labels: ["INBOX"],
      body: "And the price list?",
    });
    fake.messages.set("m5", {
      internalDate: Date.now() + 4100,
      from: "Burak Şahin <burak@acme.com.tr>",
      subject: "Budget",
      labels: ["INBOX"],
      body: "Can you confirm the Q4 numbers?",
    });

    // Just checked: the watcher leaves it for now.
    let pass = await t.platform.watchers.pollCompany(companyId);
    expect(pass.errors).toEqual([]);
    expect(((await call("kerem.yildiz", "GET", "/todos")).json() as Todo[]).length).toBe(0);
    // Ten minutes later: the pass reads the new mail, Ayşe's stays quiet, Burak's becomes a to-do.
    await t.platform.handle.db
      .update(mailAccounts)
      .set({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(mailAccounts.companyId, companyId));
    pass = await t.platform.watchers.pollCompany(companyId);
    expect(pass.errors).toEqual([]);
    const open = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    expect(open.map((x) => x.title)).toEqual(["Reply to Burak Şahin: Budget"]);
    // Switched off: the pass leaves the mailbox alone.
    expect((await me("kerem.yildiz", "PATCH", "/api/me/mail", { tasksEnabled: false })).statusCode).toBe(200);
    await t.platform.handle.db
      .update(mailAccounts)
      .set({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(mailAccounts.companyId, companyId));
    fake.messages.set("m6", {
      internalDate: Date.now() + 5000,
      from: "Zeynep Kaya <zeynep@acme.com.tr>",
      subject: "Customer call",
      labels: ["INBOX"],
      body: "Join at 3?",
    });
    await t.platform.watchers.pollCompany(companyId);
    expect(((await call("kerem.yildiz", "GET", "/todos")).json() as Todo[]).length).toBe(1);
    expect((await me("kerem.yildiz", "PATCH", "/api/me/mail", { tasksEnabled: true })).statusCode).toBe(200);
  });

  it("says when Google no longer accepts the permission, and disconnects on request; the shared mail and connections know nothing of it", async () => {
    fake.revokedAtGoogle = true;
    const failed = await me("kerem.yildiz", "POST", "/api/me/mail/check");
    expect(failed.statusCode, failed.body).toBe(409);
    expect((failed.json() as { error: string }).error).toMatch(/Connect Gmail again/);
    const mine = (await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail;
    expect(mine.account).toMatchObject({ status: "error" });
    expect(mine.account!.lastError).toMatch(/Connect Gmail again/);
    fake.revokedAtGoogle = false;
    expect((await me("kerem.yildiz", "POST", "/api/me/mail/check")).statusCode).toBe(200);
    expect(((await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail).account!.status).toBe("ok");

    const gone = await me("kerem.yildiz", "DELETE", "/api/me/mail/gmail");
    expect(gone.statusCode, gone.body).toBe(200);
    expect(fake.revoked).toEqual(["rt-1"]);
    expect(((await me("kerem.yildiz", "GET", "/api/me/mail")).json() as MyMail).account).toBeNull();
    expect((await me("kerem.yildiz", "DELETE", "/api/me/mail/gmail")).statusCode).toBe(404);
    expect((await me("kerem.yildiz", "POST", "/api/me/mail/check")).statusCode).toBe(404);
    // The to-dos it made stay: Ayşe's (dismissed), Burak's, and Zeynep's, which the check after the permission came back read.
    expect(((await call("kerem.yildiz", "GET", "/todos?status=all")).json() as Todo[]).length).toBe(3);
    // Nothing of a person's mail is a company mailbox or a connection.
    const mailboxes = (await call("selin.acar", "GET", "/mail/mailboxes")).json() as { mailbox: string }[];
    expect(mailboxes.some((m) => m.mailbox.includes("gmail.com"))).toBe(false);
    const connections = (await call("selin.acar", "GET", "/connectors")).json() as { type: string }[];
    expect(connections.some((c) => c.type === "gmail")).toBe(false);
    expect(await t.platform.mail.findByExternalId(companyId, "m1")).toBeUndefined();
  });
});

describe("reading mail for tasks", () => {
  const mail = (id: string, from: string, subject: string, body: string, labels: string[] = ["INBOX"]): PersonalMail => ({
    id,
    threadId: `t-${id}`,
    from,
    subject,
    receivedAt: "2026-10-13T08:00:00.000Z",
    labels,
    body,
    preview: body.slice(0, 80),
  });
  const ctx = {
    person: { name: "Kerem Yıldız", email: "kerem.yildiz@acme.com.tr" },
    projects: [{ id: "p-1", name: "Petrokim complaints", summary: "Agents for the complaint process" }],
    quietSenders: ["spam@example.com"],
  };

  it("without Claude, every email from a person is something to answer; automatic and quiet senders make nothing", async () => {
    expect(offlineMailTask(mail("a", "Ayşe Yılmaz <ayse@petrokim.example>", "Offer", "Send it by Friday"), ctx)).toMatchObject({
      needsAction: true,
      title: "Reply to Ayşe Yılmaz: Offer",
      details: "Send it by Friday",
    });
    expect(offlineMailTask(mail("b", "no-reply@github.com", "Build failed", "…"), ctx).needsAction).toBe(false);
    expect(offlineMailTask(mail("c", "shop@example.com", "Sale", "…", ["INBOX", "CATEGORY_PROMOTIONS"]), ctx).needsAction).toBe(false);
    expect(offlineMailTask(mail("d", "spam@example.com", "Hi", "…"), ctx)).toMatchObject({
      needsAction: false,
      reason: "The person asked for no tasks from this sender",
    });
    expect(offlineMailTask(mail("e", "someone@example.com", "", "…"), ctx).title).toBe("Reply to someone@example.com: (no subject)");
    const reader = new MailTaskReader(new UnavailableLlm());
    const decided = await reader.read([mail("a", "ayse@petrokim.example", "Offer", "x"), mail("b", "noreply@x.example", "y", "z")], ctx);
    expect(decided.map((d) => d.needsAction)).toEqual([true, false]);
  });

  it("with Claude, only the mail that could be something to do is read, and its answer names the project and the day", async () => {
    let asked = "";
    const llm = new ScriptedLlm({
      "mail.tasks": {
        structured: (request: StructuredRequest) => {
          asked = String((request.messages[0] as { content: string }).content);
          return {
            items: [
              {
                id: "a",
                needs_action: true,
                title: "Send Ayşe the revised offer",
                details: "She needs it for Petrokim's board.",
                due: "2026-10-17",
                project: "petrokim COMPLAINTS",
                reason: "asks for a document",
              },
              { id: "f", needs_action: false, title: "", details: "", due: null, project: null, reason: "an FYI" },
            ],
          };
        },
      },
    });
    const reader = new MailTaskReader(llm, () => new Date("2026-10-13T09:00:00Z"));
    const decided = await reader.read(
      [
        mail("a", "Ayşe Yılmaz <ayse@petrokim.example>", "Offer", "Could you send the revised offer by Friday? It is for the board."),
        mail("b", "noreply@bank.example", "Statement", "…"),
        mail("f", "Can Demir <can@acme.com.tr>", "FYI", "Just so you know."),
        mail("g", "Burak Şahin <burak@acme.com.tr>", "Budget", "Numbers?"),
      ],
      ctx,
    );
    expect(asked).toContain("Today is 2026-10-13");
    expect(asked).toContain("- Petrokim complaints: Agents for the complaint process");
    expect(asked).toContain('<email id="a">');
    expect(asked).not.toContain('<email id="b">');
    expect(decided[0]).toMatchObject({
      id: "a",
      needsAction: true,
      title: "Send Ayşe the revised offer",
      due: "2026-10-17",
      projectId: "p-1",
      reason: "asks for a document",
    });
    expect(decided[1]).toMatchObject({ id: "b", needsAction: false });
    expect(decided[2]).toMatchObject({ id: "f", needsAction: false });
    // Not answered by the model: the offline rule stands in.
    expect(decided[3]).toMatchObject({ id: "g", needsAction: true, title: "Reply to Burak Şahin: Budget" });
  });
});
