import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Microsoft Teams, against a stand-in for the Bot Framework (its keys, its token service and its Bot
 * Connector): only signed calls for this bot and tenant get in; people are linked by the email Teams
 * gives; they give work in plain words and hear back when it's done; approvals and questions arrive as
 * cards whose buttons act, and cards are updated wherever the item was handled.
 */

const APP_ID = "4b1c7f0e-2d3a-4c5b-9e8f-0a1b2c3d4e5f";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const ELIF_AAD = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ZED_AAD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

interface Recorded {
  method: string;
  conversation: string;
  activityId?: string;
  body: Record<string, unknown>;
  auth: string | undefined;
  /** The id the stand-in gave a new message. */
  returnedId?: string;
}

const members: Record<string, { email: string; name: string; aadObjectId: string }> = {
  "29:elif": { email: "Elif.Arslan@acme.com.tr", name: "Elif Arslan", aadObjectId: ELIF_AAD },
  "29:zed": { email: "zed@acme.com.tr", name: "Zed Unknown", aadObjectId: ZED_AAD },
};

const firstMessage = (request: ToolLoopRequest) => String((request.messages[0] as { content: unknown }).content);
const llm = new ScriptedLlm({
  "runtime.agent": {
    tools: (request, turn) =>
      /remind/i.test(firstMessage(request)) && turn === 1
        ? { calls: [{ name: "task_complete", input: { outcome: "Reminded Kaya Çelik about INV-9; they pay on Friday." } }] }
        : { text: "Done." },
  },
});

let base = "";
let server: Server;
let privateKey: CryptoKey;
let strangerKey: CryptoKey;
const sent: Recorded[] = [];
let activitySeq = 0;
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

async function token(options: { key?: CryptoKey; audience?: string; serviceUrl?: string } = {}) {
  return new SignJWT({ serviceUrl: options.serviceUrl ?? base })
    .setProtectedHeader({ alg: "RS256", kid: "bf-key" })
    .setIssuer("https://api.botframework.com")
    .setAudience(options.audience ?? APP_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(options.key ?? privateKey);
}

function activity(overrides: Record<string, unknown> = {}, who: "elif" | "zed" = "elif") {
  return {
    type: "message",
    id: `in-${Math.random().toString(16).slice(2)}`,
    serviceUrl: base,
    channelId: "msteams",
    from: { id: `29:${who}`, name: members[`29:${who}`]!.name, aadObjectId: members[`29:${who}`]!.aadObjectId },
    recipient: { id: `28:${APP_ID}`, name: "Acme AI" },
    conversation: { id: `a:${who}-chat`, conversationType: "personal", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    ...overrides,
  };
}

/** A card's text, flattened (titles, text blocks, facts, buttons). */
function cardText(card: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const n = node as Record<string, unknown>;
      for (const key of ["text", "title", "value"]) if (typeof n[key] === "string") parts.push(n[key] as string);
      Object.values(n).forEach(walk);
    }
  };
  walk(card);
  return parts.join(" | ");
}

const cardOf = (recorded: Recorded | undefined) => (recorded?.body.attachments as { content: Record<string, unknown> }[] | undefined)?.[0]?.content;

describe("Microsoft Teams", () => {
  let t: TestApp;
  let companyId: string;

  const post = async (payload: Record<string, unknown>, auth?: string | null) =>
    t.app.inject({
      method: "POST",
      url: "/api/channels/teams/acme/messages",
      headers: auth === null ? {} : { authorization: `Bearer ${auth ?? (await token())}` },
      payload,
    });
  const since = (count: number) => sent.slice(count);

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    strangerKey = (await generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "bf-key", use: "sig", endorsements: ["msteams"] };
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      const reply = (status: number, data: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      };
      if (url.pathname === "/openid") return reply(200, { jwks_uri: `${base}/keys` });
      if (url.pathname === "/keys") return reply(200, { keys: [jwk] });
      if (url.pathname === "/token") {
        const form = await body(request);
        return form.client_secret === "bot-secret"
          ? reply(200, { access_token: "bot-token", token_type: "Bearer", expires_in: 3600 })
          : reply(401, { error: "invalid_client" });
      }
      const member = /^\/v3\/conversations\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
      if (member && request.method === "GET") {
        const found = members[decodeURIComponent(member[2]!)];
        return found
          ? reply(200, {
              id: decodeURIComponent(member[2]!),
              name: found.name,
              email: found.email,
              userPrincipalName: found.email,
              aadObjectId: found.aadObjectId,
            })
          : reply(404, {});
      }
      const activities = /^\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/.exec(url.pathname);
      if (activities) {
        const recorded: Recorded = {
          method: request.method ?? "",
          conversation: decodeURIComponent(activities[1]!),
          activityId: activities[2] ? decodeURIComponent(activities[2]) : undefined,
          body: await body(request),
          auth: request.headers.authorization,
        };
        recorded.returnedId = recorded.activityId ?? `out-${++activitySeq}`;
        sent.push(recorded);
        return reply(200, { id: recorded.returnedId });
      }
      reply(404, { error: `No route ${url.pathname}` });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Microsoft's sign-in service is the stand-in's token endpoint.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith("https://login.microsoftonline.com/") ? realFetch(`${base}/token`, init) : realFetch(input, init);
    }) as typeof fetch;

    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] }, teams: { openIdUrl: `${base}/openid` } } });
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
    await t.platform.connectors.create(companyId, {
      type: "microsoft-teams",
      values: { app_id: APP_ID, app_password: "bot-secret", tenant_id: TENANT, app_type: "single-tenant" },
    });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await t?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("lets in only signed calls for this bot, from this tenant", async () => {
    const hello = activity({ text: "help" });
    expect((await post(hello, null)).statusCode).toBe(401);
    expect((await post(hello, await token({ key: strangerKey }))).statusCode).toBe(401);
    expect((await post(hello, await token({ audience: "another-bot" }))).statusCode).toBe(401);
    expect((await post(hello, await token({ serviceUrl: "https://smba.trafficmanager.net/emea/" }))).statusCode).toBe(401);
    const otherTenant = activity({
      text: "help",
      channelData: { tenant: { id: "11111111-2222-3333-4444-555555555555" } },
      conversation: { id: "a:x", conversationType: "personal" },
    });
    expect((await post(otherTenant)).statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("says hello when installed, to the person it links by their Teams email", async () => {
    const response = await post(activity({ type: "conversationUpdate", membersAdded: [{ id: `28:${APP_ID}` }] }));
    expect(response.statusCode, response.body).toBe(200);
    const [welcome] = sent;
    expect(welcome).toMatchObject({ method: "POST", conversation: "a:elif-chat", auth: "Bearer bot-token" });
    expect(cardText(cardOf(welcome))).toContain("Hi Elif, your AI employees work here with you");
    expect(cardText(cardOf(welcome))).toContain("Reminder Clerk");
    const [account] = await t.platform.channelAccounts.list(companyId, "teams");
    const elif = (await t.platform.people.list(companyId)).find((p) => p.email === "elif.arslan@acme.com.tr")!;
    expect(account).toMatchObject({
      externalId: ELIF_AAD,
      userId: elif.id,
      email: "elif.arslan@acme.com.tr",
      address: { conversationId: "a:elif-chat", serviceUrl: base },
    });
  });

  it("tells someone it doesn't know whom to ask", async () => {
    const before = sent.length;
    expect((await post(activity({ text: "Reminder Clerk, remind Kaya Çelik about INV-9" }, "zed"))).statusCode).toBe(200);
    const [reply] = since(before);
    expect(cardText(cardOf(reply))).toContain("I don't know you yet");
    expect(cardText(cardOf(reply))).toContain("zed@acme.com.tr");
    expect(await t.platform.tasks.list(companyId)).toHaveLength(0);
  });

  it("gives work in plain words and tells the person when it's done, in the same chat", async () => {
    t.platform.notifications.start(0);
    try {
      const before = sent.length;
      expect((await post(activity({ text: "Reminder Clerk, remind Kaya Çelik about INV-9 and ask when they pay" }))).statusCode).toBe(200);
      const [given] = since(before);
      expect(cardText(cardOf(given))).toMatch(/^EB-[A-Z0-9]{5} \| Reminder Clerk is on it \| remind Kaya Çelik/);
      const [task] = await t.platform.tasks.list(companyId);
      expect(task).toMatchObject({ source: "teams", requestedBy: "Elif Arslan", title: "remind Kaya Çelik about INV-9 and ask when they pay" });

      await t.platform.engine.waitForSettled(companyId, (await t.platform.tasks.runsOf(task!.id)).at(-1)!.id);
      await t.platform.notifications.idle();
      const news = since(before).find((r) => cardText(cardOf(r)).startsWith(`Reminder Clerk · ${task!.ref}`));
      expect(cardText(cardOf(news))).toContain("Done: remind Kaya Çelik about INV-9 and ask when they pay");
      expect(cardText(cardOf(news))).toContain("they pay on Friday");

      // The conversation now goes to Reminder Clerk: no need to name it again.
      await post(activity({ text: "Also remind Aras Lojistik about INV-12" }));
      const also = (await t.platform.tasks.list(companyId)).find((x) => x.title === "Also remind Aras Lojistik about INV-12");
      expect(also).toMatchObject({ source: "teams" });
      await t.platform.engine.waitForSettled(companyId, (await t.platform.tasks.runsOf(also!.id)).at(-1)!.id);
      await t.platform.notifications.idle();
    } finally {
      await t.platform.notifications.stop();
    }
  });

  it("sends an approval as a card whose buttons act, and updates the card when it's handled", async () => {
    t.platform.notifications.start(0);
    try {
      const before = sent.length;
      await t.platform.engine.start(companyId, "reminder-clerk", { customer: "ap@kaya.example" });
      await t.platform.notifications.idle();
      const approval = (await t.platform.engine.listApprovals(companyId, { status: "pending" })).find(
        (a) => (a.action as { to?: string }).to === "ap@kaya.example",
      )!;
      const card = since(before).find((r) => r.conversation === "a:elif-chat" && cardText(cardOf(r)).includes("ap@kaya.example"));
      expect(card?.body.summary).toBe("Approve? Send email to ap@kaya.example");
      const content = cardOf(card)!;
      expect(content).toMatchObject({ type: "AdaptiveCard", version: "1.5" });
      const actions = content.actions as { type: string; title: string; verb?: string; data?: Record<string, string>; url?: string }[];
      expect(actions.map((a) => a.title)).toEqual(["Approve", "Reject", "Correct it first", "Open in the app"]);
      expect(actions[0]).toMatchObject({ type: "Action.Execute", verb: "approve", data: { eb: "act", type: "approval", id: approval.id } });
      expect(actions[2]!.url).toMatch(/^http:\/\/brain\.test\/act\/[\w-]{95}\?choice=edit$/);
      // Burak isn't in Teams: his arrives by email.
      expect(
        (await t.platform.mail.list(companyId, { direction: "outbound" })).some(
          (m) => m.toAddresses.includes("burak.sahin@acme.com.tr") && m.subject.includes("ap@kaya.example"),
        ),
      ).toBe(true);

      const press = await post(
        activity({
          type: "invoke",
          name: "adaptiveCard/action",
          value: { action: { type: "Action.Execute", verb: "approve", data: { ...actions[0]!.data, note: "They agreed" } } },
        }),
      );
      expect(press.statusCode, press.body).toBe(200);
      expect(press.json()).toMatchObject({ statusCode: 200, type: "application/vnd.microsoft.card.adaptive" });
      expect(cardText(press.json().value)).toContain("Approved by Elif Arslan");
      expect(press.json().value.actions.map((a: { title: string }) => a.title)).toEqual(["Open in the app"]);
      const decided = (await t.platform.engine.listApprovals(companyId)).find((a) => a.id === approval.id)!;
      expect(decided).toMatchObject({ status: "approved", decidedBy: "Elif Arslan", decisionNote: "They agreed" });
      const audit = (await t.platform.activity.list(companyId, 50)).find((a) => a.action === "approval.approved" && a.entityId === approval.id);
      expect(audit?.summary).toBe("Approved in Microsoft Teams: Send email to ap@kaya.example");

      // The card delivered earlier now says who decided.
      await t.platform.notifications.idle();
      const update = sent.find((r) => r.method === "PUT" && r.activityId === card!.returnedId);
      expect(cardText(cardOf(update))).toContain("Approved by Elif Arslan");
      // Pressing again says what happened instead of acting twice.
      const again = await post(activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { verb: "reject", data: actions[0]!.data } } }));
      expect(cardText(again.json().value)).toContain("Approved by Elif Arslan");
    } finally {
      await t.platform.notifications.stop();
    }
  });

  it("lists what needs the person, and answers a question from its card", async () => {
    const elif = (await t.platform.people.list(companyId)).find((p) => p.email === "elif.arslan@acme.com.tr")!;
    const question = await t.platform.work.create(companyId, {
      kind: "question",
      title: "Which cost centre should INV-9 go to?",
      options: ["4200", "4300"],
      assigneeUserId: elif.id,
      departmentId: elif.departments[0]!.departmentId,
    });
    const before = sent.length;
    await post(activity({ text: "what needs me?" }));
    const cards = since(before).map((r) => cardOf(r));
    const asked = cards.find((c) => cardText(c).includes("Which cost centre should INV-9 go to?"));
    expect(asked).toBeTruthy();
    expect(cardText(asked)).toContain("4200");

    const empty = await post(
      activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { verb: "answer", data: { eb: "act", type: "question", id: question.id } } } }),
    );
    expect(empty.json()).toMatchObject({ statusCode: 400, value: { message: "Write an answer, or dismiss the question" } });
    const answered = await post(
      activity({
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: { verb: "answer", data: { eb: "act", type: "question", id: question.id, choice: "4200" } } },
      }),
    );
    expect(cardText(answered.json().value)).toContain("Answered by Elif Arslan: 4200");
    expect((await t.platform.work.get(companyId, question.id)).status).toBe("done");
  });

  it("asks whom to give work to when it isn't clear, and gives it on a click", async () => {
    // A new conversation (no AI employee yet) of a person who works with several.
    const accounts = await t.platform.channelAccounts.list(companyId, "teams");
    await t.platform.channelAccounts.talkTo(accounts.find((a) => a.externalId === ELIF_AAD)!.id, null);
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(companyId, {
      definition: {
        slug: "collections-clerk",
        name: "Collections Clerk",
        summary: "Chases payments.",
        archetype: "process-automation",
        instructions: "Chase.",
      },
      status: "active",
      departmentId: finance.id,
    });
    const before = sent.length;
    await post(activity({ text: "Please remind Mavi Tekstil about INV-31" }));
    const pick = cardOf(since(before)[0]);
    expect(cardText(pick)).toContain("Who should do this?");
    // All of their AI employees to choose from, the likeliest chosen at first.
    const choice = (pick!.body as { type: string; id?: string; value?: string; choices?: { value: string }[] }[]).find((b) => b.id === "agent")!;
    expect(choice).toMatchObject({ type: "Input.ChoiceSet", value: "reminder-clerk" });
    expect(choice.choices!.length).toBeGreaterThan(6);
    const button = (pick!.actions as { verb: string; data: Record<string, string> }[])[0]!;
    const given = await post(
      activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { verb: button.verb, data: { ...button.data, agent: choice.value! } } } }),
    );
    expect(cardText(given.json().value)).toContain("Reminder Clerk is on it");
    expect((await t.platform.tasks.list(companyId)).map((x) => x.title)).toContain("Please remind Mavi Tekstil about INV-31");
  });

  it("asks for a personal chat when written to in a group", async () => {
    const before = sent.length;
    await post(activity({ text: "hi", conversation: { id: "19:group@thread.v2", conversationType: "groupChat", tenantId: TENANT } }));
    expect(since(before)[0]?.body.text).toContain("personal chat");
  });

  it("sends the morning summary to Teams", async () => {
    const day = new Date();
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5, 35));
    const before = sent.length;
    await t.platform.notifications.summaries(companyId, at);
    const summary = since(before).find((r) => r.conversation === "a:elif-chat");
    expect(summary?.body.summary).toMatch(/^Good morning, Elif: /);
    expect(cardText(cardOf(summary))).toContain("Your AI employees since yesterday");
  });

  it("shows admins how Teams is set up, and gives them the Teams app", async () => {
    const mehmet = await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "mehmet.oz@acme.com.tr" } });
    const cookie = String(mehmet.headers["set-cookie"]).split(";")[0]!;
    const overview = await t.app.inject({ url: "/api/companies/acme/channels", headers: { cookie } });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().teams).toMatchObject({ connected: true, appId: APP_ID, messagingEndpoint: "http://brain.test/api/channels/teams/acme/messages" });
    expect(overview.json().teams.accounts.map((a: { person: string | null }) => a.person)).toEqual(expect.arrayContaining(["Elif Arslan", null]));

    const zip = await t.app.inject({ url: "/api/companies/acme/channels/teams/app", headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    const data = zip.rawPayload;
    expect(data.readUInt32LE(0)).toBe(0x04034b50);
    const nameLength = data.readUInt16LE(26);
    expect(data.subarray(30, 30 + nameLength).toString()).toBe("manifest.json");
    const manifest = JSON.parse(data.subarray(30 + nameLength, 30 + nameLength + data.readUInt32LE(18)).toString());
    expect(manifest).toMatchObject({ id: APP_ID, bots: [{ botId: APP_ID, scopes: ["personal"] }], name: { short: "Acme Endüstri A.Ş. AI" } });
    expect(data.includes(Buffer.from("color.png"))).toBe(true);

    const elif = await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "elif.arslan@acme.com.tr" } });
    const worker = String(elif.headers["set-cookie"]).split(";")[0]!;
    expect((await t.app.inject({ url: "/api/companies/acme/channels", headers: { cookie: worker } })).statusCode).toBe(403);
  });
});
