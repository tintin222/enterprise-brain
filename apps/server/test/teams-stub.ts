import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * A stand-in for the Bot Framework: its OpenID keys, its token service and the Bot Connector a bot
 * sends activities to. It signs the calls Teams would make to Enterprise Brain, and records what
 * Enterprise Brain sends back.
 */

export interface TeamsMember {
  email: string;
  name: string;
  aadObjectId: string;
}

export interface SentActivity {
  method: string;
  conversation: string;
  activityId?: string;
  body: Record<string, unknown>;
  auth: string | undefined;
  /** The id the stand-in gave a new message. */
  returnedId?: string;
}

export interface TeamsStub {
  base: string;
  appId: string;
  tenant: string;
  password: string;
  sent: SentActivity[];
  /** A token Teams would send with a call for this bot. */
  token(): Promise<string>;
  /** An activity from a member (by their Teams id, e.g. "29:elif") in their personal chat. */
  activity(from: string, overrides?: Record<string, unknown>): Record<string, unknown>;
  close(): Promise<void>;
}

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

export async function startTeamsStub(members: Record<string, TeamsMember>, options: { appId?: string; tenant?: string } = {}): Promise<TeamsStub> {
  const appId = options.appId ?? "4b1c7f0e-2d3a-4c5b-9e8f-0a1b2c3d4e5f";
  const tenant = options.tenant ?? "72f988bf-86f1-41af-91ab-2d7cd011db47";
  const password = "bot-secret";
  const keys = await generateKeyPair("RS256");
  const privateKey: CryptoKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "bf-key", use: "sig", endorsements: ["msteams"] };
  const sent: SentActivity[] = [];
  let seq = 0;
  let base = "";

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (url.pathname === "/openid") return reply(200, { jwks_uri: `${base}/keys` });
    if (url.pathname === "/keys") return reply(200, { keys: [jwk] });
    if (url.pathname === "/token") {
      const form = await body(request);
      return form.client_secret === password
        ? reply(200, { access_token: "bot-token", token_type: "Bearer", expires_in: 3600 })
        : reply(401, { error: "invalid_client" });
    }
    const member = /^\/v3\/conversations\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
    if (member && request.method === "GET") {
      const id = decodeURIComponent(member[2]!);
      const found = members[id];
      return found ? reply(200, { id, name: found.name, email: found.email, userPrincipalName: found.email, aadObjectId: found.aadObjectId }) : reply(404, {});
    }
    const activities = /^\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/.exec(url.pathname);
    if (activities) {
      const recorded: SentActivity = {
        method: request.method ?? "",
        conversation: decodeURIComponent(activities[1]!),
        activityId: activities[2] ? decodeURIComponent(activities[2]) : undefined,
        body: await body(request),
        auth: request.headers.authorization,
      };
      recorded.returnedId = recorded.activityId ?? `out-${++seq}`;
      sent.push(recorded);
      return reply(200, { id: recorded.returnedId });
    }
    reply(404, { error: `No route ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    appId,
    tenant,
    password,
    sent,
    token: () =>
      new SignJWT({ serviceUrl: base })
        .setProtectedHeader({ alg: "RS256", kid: "bf-key" })
        .setIssuer("https://api.botframework.com")
        .setAudience(appId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
    activity: (from, overrides = {}) => {
      const member = members[from]!;
      return {
        type: "message",
        id: `in-${Math.random().toString(16).slice(2)}`,
        serviceUrl: base,
        channelId: "msteams",
        from: { id: from, name: member.name, aadObjectId: member.aadObjectId },
        recipient: { id: `28:${appId}`, name: "Acme AI" },
        conversation: { id: `a:${from.slice(3)}-chat`, conversationType: "personal", tenantId: tenant },
        channelData: { tenant: { id: tenant } },
        ...overrides,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A card's text, flattened (titles, text blocks, facts, buttons). */
export function cardText(card: unknown): string {
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

export const cardOf = (sent: SentActivity | undefined) => (sent?.body.attachments as { content: Record<string, unknown> }[] | undefined)?.[0]?.content;
