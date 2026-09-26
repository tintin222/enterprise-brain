import { generateKeyPairSync, createVerify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Google Chat, against a stand-in for Google (the keys it signs Chat's calls with, the token service
 * for the app's service account, and the Chat API): only calls signed by Google for Chat, issued to
 * this endpoint and from the company's domain get in; people give work and act on cards in their
 * direct messages with the app; approvals arrive there as cards and are decided with their buttons.
 */

const ENDPOINT = "http://brain.test/api/channels/google-chat/acme/events";
const serviceAccount = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "acme-brain",
  client_email: "brain-chat@acme-brain.iam.gserviceaccount.com",
  private_key: serviceAccount.privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
});

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
  returnedName?: string;
}

const firstMessage = (request: ToolLoopRequest) => String((request.messages[0] as { content: unknown }).content);
const llm = new ScriptedLlm({
  "runtime.agent": {
    tools: (request, turn) =>
      /remind/i.test(firstMessage(request)) && turn === 1
        ? { calls: [{ name: "task_complete", input: { outcome: "Reminded them; payment on Friday." } }] }
        : { text: "Done." },
  },
});

let base = "";
let server: Server;
let googleKey: CryptoKey;
let chatKey: CryptoKey;
let strangerKey: CryptoKey;
const calls: Recorded[] = [];
let seq = 0;
const realFetch = globalThis.fetch;

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/** An ID token as Google signs it for Chat's calls to an app whose audience is its endpoint URL. */
async function idToken(options: { audience?: string; email?: string; key?: CryptoKey } = {}) {
  return new SignJWT({ email: options.email ?? "chat@system.gserviceaccount.com", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "google-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(options.audience ?? ENDPOINT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(options.key ?? googleKey);
}

const elifUser = { name: "users/111", displayName: "Elif Arslan", email: "elif.arslan@acme.com.tr", type: "HUMAN" };
const dm = { name: "spaces/elif-dm", type: "DM", spaceType: "DIRECT_MESSAGE", singleUserBotDm: true };

function chatEvent(type: string, extra: Record<string, unknown> = {}, user: Record<string, unknown> = elifUser) {
  return { type, eventTime: new Date().toISOString(), user, space: dm, ...extra };
}

/** A Chat card's words (header, paragraphs, labels, buttons). */
function words(message: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string" && ["title", "subtitle", "text", "topLabel", "bottomLabel", "label"].includes(key)) parts.push(value);
        else walk(value);
      }
    }
  };
  walk(message);
  return parts.join(" | ");
}

describe("Google Chat", () => {
  let t: TestApp;
  let companyId: string;
  let connectionId: string;

  const post = async (payload: Record<string, unknown>, auth?: string | null) =>
    t.app.inject({
      method: "POST",
      url: "/api/channels/google-chat/acme/events",
      headers: auth === null ? {} : { authorization: `Bearer ${auth ?? (await idToken())}` },
      payload,
    });

  beforeAll(async () => {
    const google = await generateKeyPair("RS256");
    googleKey = google.privateKey;
    const chat = await generateKeyPair("RS256");
    chatKey = chat.privateKey;
    strangerKey = (await generateKeyPair("RS256")).privateKey;
    const googleJwk = { ...(await exportJWK(google.publicKey)), kid: "google-key", use: "sig", alg: "RS256" };
    const chatJwk = { ...(await exportJWK(chat.publicKey)), kid: "chat-key", use: "sig", alg: "RS256" };
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      const reply = (status: number, data: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      };
      if (url.pathname === "/oauth2/v3/certs") return reply(200, { keys: [googleJwk] });
      if (url.pathname === "/service_accounts/v1/jwk/chat@system.gserviceaccount.com") return reply(200, { keys: [chatJwk] });
      if (url.pathname === "/token") {
        // The app's service account signs in with a JWT it signed (RFC 7523).
        const form = await body(request);
        const [header, payload, signature] = String(form.assertion ?? "").split(".");
        const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString() || "{}");
        const valid = createVerify("RSA-SHA256")
          .update(`${header}.${payload}`)
          .verify(serviceAccount.publicKey, Buffer.from(signature ?? "", "base64url"));
        const ok =
          form.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
          valid &&
          claims.iss === "brain-chat@acme-brain.iam.gserviceaccount.com" &&
          claims.scope === "https://www.googleapis.com/auth/chat.bot";
        return ok ? reply(200, { access_token: "chat-token", token_type: "Bearer", expires_in: 3600 }) : reply(400, { error: "invalid_grant" });
      }
      if (url.pathname.startsWith("/v1/spaces/")) {
        const recorded: Recorded = {
          method: request.method ?? "",
          path: url.pathname.slice(4) + url.search,
          body: await body(request),
          auth: request.headers.authorization,
        };
        if (request.method === "POST") recorded.returnedName = `${url.pathname.slice(4).replace(/\/messages$/, "")}/messages/m${++seq}`;
        calls.push(recorded);
        return reply(200, { name: recorded.returnedName ?? url.pathname.slice(4) });
      }
      reply(404, { error: `No route ${url.pathname}` });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Google's addresses lead to the stand-in.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://oauth2.googleapis.com/token") return realFetch(`${base}/token`, init);
      if (url.startsWith("https://www.googleapis.com/")) return realFetch(`${base}${new URL(url).pathname}`, init);
      if (url.startsWith("https://chat.googleapis.com/")) {
        const u = new URL(url);
        return realFetch(`${base}${u.pathname}${u.search}`, init);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(companyId, {
      definition: {
        slug: "reminder-clerk",
        name: "Reminder Clerk",
        summary: "Reminds customers of overdue invoices.",
        archetype: "process-automation",
        instructions: "Remind customers.",
        inputs: [{ key: "customer", type: "email", required: true }],
        workflow: [{ id: "remind", type: "mail.send", to: "{{ input.customer }}", subject: "Overdue invoice INV-9", body: "Please pay invoice INV-9." }],
      },
      status: "active",
      departmentId: finance.id,
    });
    t.platform.notifications.configure({ publicUrl: t.config.publicUrl });
    connectionId = (
      await t.platform.connectors.create(companyId, {
        type: "google-chat",
        values: { service_account_key: KEY_FILE, audience: "endpoint-url", allowed_domains: "acme.com.tr" },
      })
    ).id;
    expect(await t.platform.connectors.test(companyId, connectionId)).toMatchObject({ ok: true });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await t?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("lets in only calls Google signed for Chat, to this endpoint, from the company's domain", async () => {
    const hello = chatEvent("MESSAGE", { message: { text: "help" } });
    expect((await post(hello, null)).statusCode).toBe(401);
    expect((await post(hello, await idToken({ key: strangerKey }))).statusCode).toBe(401);
    expect((await post(hello, await idToken({ audience: "https://elsewhere.example/events" }))).statusCode).toBe(401);
    expect((await post(hello, await idToken({ email: "someone@gmail.com" }))).statusCode).toBe(401);
    const outsider = chatEvent("MESSAGE", { message: { text: "help" } }, { name: "users/999", displayName: "Eve", email: "eve@evil.example", type: "HUMAN" });
    expect((await post(outsider)).statusCode).toBe(403);
    expect(await t.platform.channelAccounts.list(companyId, "google-chat")).toHaveLength(0);
  });

  it("says hello when added, and links the person by their email", async () => {
    const added = await post(chatEvent("ADDED_TO_SPACE"));
    expect(added.statusCode, added.body).toBe(200);
    expect(words(added.json())).toContain("Hi Elif, your AI employees work here with you");
    expect(added.json().cardsV2[0].card.sections[0].widgets.at(-1).buttonList.buttons[0].onClick.openLink.url).toBe("http://brain.test");
    const [account] = await t.platform.channelAccounts.list(companyId, "google-chat");
    expect(account).toMatchObject({ externalId: "users/111", email: "elif.arslan@acme.com.tr", address: { space: "spaces/elif-dm" } });
    expect(account!.userId).toBeTruthy();
  });

  it("gives work in a direct message and tells the person when it's done", async () => {
    t.platform.notifications.start(0);
    try {
      const given = await post(
        chatEvent("MESSAGE", { message: { name: "spaces/elif-dm/messages/in1", text: "Reminder Clerk, remind Kaya Çelik about INV-9" } }),
      );
      expect(words(given.json())).toMatch(/Reminder Clerk is on it \| EB-[A-Z0-9]{5}/);
      const task = (await t.platform.tasks.list(companyId)).find((x) => x.source === "google-chat")!;
      expect(task).toMatchObject({ requestedBy: "Elif Arslan", title: "remind Kaya Çelik about INV-9" });
      await t.platform.engine.waitForSettled(companyId, (await t.platform.tasks.runsOf(task.id)).at(-1)!.id);
      await t.platform.notifications.idle();
      const news = calls.find((c) => c.method === "POST" && words(c.body).includes(`Done: ${task.title}`));
      expect(news).toMatchObject({ path: "spaces/elif-dm/messages", auth: "Bearer chat-token" });
      expect(news!.body.fallbackText).toBe(`${task.ref}: Done: ${task.title}`);
    } finally {
      await t.platform.notifications.stop();
    }
  });

  it("sends an approval as a card in the direct message, and decides it with its buttons", async () => {
    t.platform.notifications.start(0);
    try {
      const before = calls.length;
      await t.platform.engine.start(companyId, "reminder-clerk", { customer: "ap@kaya.example" });
      await t.platform.notifications.idle();
      const approval = (await t.platform.engine.listApprovals(companyId, { status: "pending" })).find(
        (a) => (a.action as { to?: string }).to === "ap@kaya.example",
      )!;
      const card = calls.slice(before).find((c) => c.method === "POST" && c.path === "spaces/elif-dm/messages");
      expect(card?.body.fallbackText).toBe("Approve? Send email to ap@kaya.example");
      const widgets = (card!.body.cardsV2 as { card: { sections: { widgets: Record<string, unknown>[] }[] } }[])[0]!.card.sections[0]!.widgets;
      const buttons = (
        widgets.at(-1)!.buttonList as {
          buttons: { text: string; onClick: Record<string, { function?: string; parameters?: { key: string; value: string }[]; url?: string }> }[];
        }
      ).buttons;
      expect(buttons.map((b) => b.text)).toEqual(["Approve", "Reject", "Correct it first", "Open in the app"]);
      expect(buttons[0]!.onClick.action).toEqual({
        function: "approve",
        parameters: [
          { key: "eb", value: "act" },
          { key: "type", value: "approval" },
          { key: "id", value: approval.id },
        ],
      });
      expect(widgets.some((w) => (w.textInput as { name?: string } | undefined)?.name === "note")).toBe(true);

      const clicked = await post(
        chatEvent("CARD_CLICKED", {
          message: { name: card!.returnedName },
          action: { actionMethodName: "approve", parameters: buttons[0]!.onClick.action!.parameters },
          common: {
            invokedFunction: "approve",
            parameters: { eb: "act", type: "approval", id: approval.id },
            formInputs: { note: { stringInputs: { value: ["They agreed"] } } },
          },
        }),
      );
      expect(clicked.statusCode, clicked.body).toBe(200);
      expect(clicked.json().actionResponse).toEqual({ type: "UPDATE_MESSAGE" });
      expect(words(clicked.json())).toContain("Approved by Elif Arslan");
      expect((await t.platform.engine.listApprovals(companyId)).find((a) => a.id === approval.id)).toMatchObject({
        status: "approved",
        decisionNote: "They agreed",
      });
      const audit = (await t.platform.activity.list(companyId, 50)).find((a) => a.action === "approval.approved" && a.entityId === approval.id);
      expect(audit?.summary).toBe("Approved in Google Chat: Send email to ap@kaya.example");
      // The delivered card is updated too (a PATCH of the same message).
      await t.platform.notifications.idle();
      const patch = calls.find((c) => c.method === "PATCH" && c.path.startsWith(`${card!.returnedName}?updateMask=`));
      expect(words(patch?.body)).toContain("Approved by Elif Arslan");
    } finally {
      await t.platform.notifications.stop();
    }
  });

  it("answers a card button it can't act on with a message, keeping the card", async () => {
    const elif = (await t.platform.people.list(companyId)).find((p) => p.email === "elif.arslan@acme.com.tr")!;
    const question = await t.platform.work.create(companyId, {
      kind: "question",
      title: "Which cost centre?",
      options: ["4200", "4300"],
      assigneeUserId: elif.id,
      departmentId: elif.departments[0]!.departmentId,
    });
    const empty = await post(
      chatEvent("CARD_CLICKED", { common: { invokedFunction: "answer", parameters: { eb: "act", type: "question", id: question.id } } }),
    );
    expect(empty.json()).toEqual({ actionResponse: { type: "NEW_MESSAGE" }, text: "Write an answer, or dismiss the question" });
    const answered = await post(
      chatEvent("CARD_CLICKED", {
        common: {
          invokedFunction: "answer",
          parameters: { eb: "act", type: "question", id: question.id },
          formInputs: { choice: { stringInputs: { value: ["4300"] } } },
        },
      }),
    );
    expect(words(answered.json())).toContain("Answered by Elif Arslan: 4300");
  });

  it("asks for a direct message when written to in a space, keeping where it writes to the person", async () => {
    const room = await post({
      ...chatEvent("MESSAGE", { message: { text: "@Acme AI hi" } }),
      space: { name: "spaces/finance-room", type: "ROOM", spaceType: "SPACE" },
    });
    expect(room.json().text).toContain("message me directly");
    const [account] = await t.platform.channelAccounts.list(companyId, "google-chat");
    expect(account!.address).toMatchObject({ space: "spaces/elif-dm" });
  });

  it("accepts calls Chat signed for the project number, when set up that way", async () => {
    await t.platform.connectors.update(companyId, connectionId, { values: { audience: "project-number", project_number: "123456789012" } });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "chat-key" })
      .setIssuer("chat@system.gserviceaccount.com")
      .setAudience("123456789012")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(chatKey);
    expect((await post(chatEvent("MESSAGE", { message: { text: "help" } }), token)).statusCode).toBe(200);
    expect((await post(chatEvent("MESSAGE", { message: { text: "help" } }))).statusCode).toBe(401);
    await t.platform.connectors.update(companyId, connectionId, { values: { audience: "endpoint-url" } });
  });
});
