import { defineConnector, defineManifest } from "../define.ts";
import { getClientCredentialsToken, httpRequest, withTokenRetry, type HttpRequestOptions, type OAuthToken } from "../http.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { configString, requireConfig, requireSecret, type Rec } from "../util.ts";
import { entraTokenUrl } from "./microsoft.ts";

/**
 * Microsoft Teams through the Bot Framework: the company's bot is how people reach their AI
 * employees in Teams. People message it; approvals, questions and a morning summary arrive from it as
 * cards with buttons. Teams calls the bot's messaging endpoint (the server verifies those calls); the
 * bot answers and writes first through the Bot Connector service at the conversation's serviceUrl.
 */

export const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a person's conversation with the bot is: enough to write to it later. */
export interface TeamsAddress {
  serviceUrl: string;
  conversationId: string;
  tenantId?: string;
  /** The bot's id in the conversation ("28:<app id>"). */
  botId?: string;
  /** The person's id in the conversation ("29:…"). */
  userId?: string;
}

/** A Teams member as the Bot Connector describes them. */
export interface TeamsMember {
  id: string;
  name: string | null;
  email: string | null;
  userPrincipalName: string | null;
  aadObjectId: string | null;
}

export interface TeamsBotSettings {
  appId: string;
  tenantId: string;
  appType: "single-tenant" | "multi-tenant";
}

export function teamsBotSettings(ctx: ConnectorContext): TeamsBotSettings {
  const tenantId = requireConfig(ctx, "tenant_id", "Directory (tenant) ID");
  if (!GUID.test(tenantId)) throw new ConnectorError("The Directory (tenant) ID must be the tenant's GUID (Entra ID → Overview)", "config");
  return {
    appId: requireConfig(ctx, "app_id", "Microsoft App ID"),
    tenantId: tenantId.toLowerCase(),
    appType: configString(ctx, "app_type") === "multi-tenant" ? "multi-tenant" : "single-tenant",
  };
}

/** The bot's own token for the Bot Connector service. */
export function botToken(ctx: ConnectorContext, forceRefresh = false): Promise<OAuthToken> {
  const settings = teamsBotSettings(ctx);
  return getClientCredentialsToken(
    ctx.fetch,
    {
      // Single-tenant bots sign in in their own tenant; multi-tenant bots in the Bot Framework's.
      tokenUrl: entraTokenUrl(settings.appType === "multi-tenant" ? "botframework.com" : settings.tenantId),
      clientId: settings.appId,
      clientSecret: requireSecret(ctx, "app_password", "Client secret"),
      scope: BOT_FRAMEWORK_SCOPE,
      service: "Microsoft Entra ID (Teams bot)",
    },
    forceRefresh,
  );
}

/** A serviceUrl the bot may send its token to: https (plain http only on this machine, for local trials). */
export function checkServiceUrl(serviceUrl: string): string {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    throw new ConnectorError(`Not a Bot Connector address: ${serviceUrl}`, "validation");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new ConnectorError(`The Bot Connector address must use https: ${serviceUrl}`, "validation");
  return url.toString().replace(/\/+$/, "");
}

async function connectorRequest<T>(ctx: ConnectorContext, serviceUrl: string, path: string, options: HttpRequestOptions = {}): Promise<T> {
  const url = `${checkServiceUrl(serviceUrl)}${path}`;
  const response = await withTokenRetry(
    (force) => botToken(ctx, force),
    (token) =>
      httpRequest<T>(ctx.fetch, url, { ...options, service: "Microsoft Teams", headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` } }),
  );
  return response.data;
}

const conversationPath = (conversationId: string) => `/v3/conversations/${encodeURIComponent(conversationId)}`;

/** Write to a conversation: a message, a card. Returns the new activity's id (to update it later). */
export async function sendActivity(ctx: ConnectorContext, address: TeamsAddress, activity: Rec): Promise<{ id: string }> {
  const data = await connectorRequest<Rec>(ctx, address.serviceUrl, `${conversationPath(address.conversationId)}/activities`, {
    method: "POST",
    json: { type: "message", ...activity },
  });
  return { id: typeof data?.id === "string" ? data.id : "" };
}

/** Replace an earlier message (a card that was handled). */
export async function updateActivity(ctx: ConnectorContext, address: TeamsAddress, activityId: string, activity: Rec): Promise<void> {
  await connectorRequest(ctx, address.serviceUrl, `${conversationPath(address.conversationId)}/activities/${encodeURIComponent(activityId)}`, {
    method: "PUT",
    json: { type: "message", id: activityId, ...activity },
  });
}

/** Who a member of the conversation is: their email links them to a person. */
export async function getMember(ctx: ConnectorContext, address: TeamsAddress, memberId: string): Promise<TeamsMember> {
  const data = await connectorRequest<Rec>(ctx, address.serviceUrl, `${conversationPath(address.conversationId)}/members/${encodeURIComponent(memberId)}`);
  const text = (key: string) => (typeof data?.[key] === "string" && data[key] ? (data[key] as string) : null);
  return {
    id: text("id") ?? memberId,
    name: text("name"),
    email: text("email"),
    userPrincipalName: text("userPrincipalName"),
    aadObjectId: text("aadObjectId"),
  };
}

export const microsoftTeamsConnector = defineConnector({
  manifest: defineManifest({
    type: "microsoft-teams",
    name: "Microsoft Teams",
    vendor: "Microsoft",
    category: "messaging",
    description:
      "AI employees in Teams: people message them there, and approvals, questions and a morning summary arrive as cards with buttons. Uses your Azure Bot; Settings → Teams and Chat shows its messaging endpoint and the Teams app to upload.",
    auth: "oauth2-client-credentials",
    config: [
      {
        key: "app_id",
        label: "Microsoft App ID",
        type: "string",
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
        help: "The Azure Bot's Microsoft App ID (its app registration's client id).",
      },
      {
        key: "app_password",
        label: "Client secret",
        type: "password",
        required: true,
        secret: true,
        help: "A client secret of that app registration (the value, not its id).",
      },
      {
        key: "tenant_id",
        label: "Directory (tenant) ID",
        type: "string",
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
        help: "Your Microsoft Entra tenant's GUID. Messages from other tenants are refused.",
      },
      {
        key: "app_type",
        label: "Bot type",
        type: "select",
        default: "single-tenant",
        options: [
          { value: "single-tenant", label: "Single tenant (recommended)" },
          { value: "multi-tenant", label: "Multi-tenant" },
        ],
        help: "As chosen when the Azure Bot was created.",
      },
    ],
    operations: [],
    docsUrl: "https://learn.microsoft.com/azure/bot-service/bot-service-quickstart-registration",
    maturity: "preview",
    itRequirements: [
      "An Azure Bot (single tenant) with the Microsoft Teams channel turned on",
      "Its messaging endpoint set to the address Settings → Teams and Chat shows",
      "The bot's Microsoft App ID, a client secret and the tenant ID",
      "The Teams app from Settings → Teams and Chat uploaded in the Teams admin center, and installed for the people who work with AI employees",
    ],
  }),
  async test(ctx) {
    teamsBotSettings(ctx);
    await botToken(ctx, true);
    return { ok: true, message: "The bot signed in to the Bot Framework" };
  },
  operations: {},
});
