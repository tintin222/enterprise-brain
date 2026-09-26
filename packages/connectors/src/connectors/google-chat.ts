import { defineConnector, defineManifest } from "../define.ts";
import {
  getServiceAccountToken,
  httpRequest,
  parseServiceAccountKey,
  withTokenRetry,
  type HttpRequestOptions,
  type OAuthToken,
  type ServiceAccountKey,
} from "../http.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { configString, requireSecret, type Rec } from "../util.ts";

/**
 * Google Chat through the company's Chat app: people message it, and approvals, questions and a
 * morning summary arrive from it as cards with buttons. Google calls the app's HTTP endpoint (the server
 * verifies those calls); the app writes first through the Chat API, as its service account.
 */

export const CHAT_API = "https://chat.googleapis.com/v1";
export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface GoogleChatSettings {
  key: ServiceAccountKey;
  /** What Google's calls are issued to: the endpoint's URL (ID tokens from Google), or the project number. */
  audience: "endpoint-url" | "project-number";
  projectNumber: string | null;
  /** People of these domains only (empty: everyone the app is available to in Chat). */
  allowedDomains: string[];
}

export function googleChatSettings(ctx: ConnectorContext): GoogleChatSettings {
  const key = parseServiceAccountKey(requireSecret(ctx, "service_account_key", "Service account key"));
  const audience = configString(ctx, "audience") === "project-number" ? "project-number" : "endpoint-url";
  const projectNumber = configString(ctx, "project_number") ?? null;
  if (audience === "project-number" && !/^\d+$/.test(projectNumber ?? "")) {
    throw new ConnectorError("Give the Google Cloud project number (digits), or choose the HTTP endpoint URL as the audience", "config");
  }
  const allowedDomains = (configString(ctx, "allowed_domains") ?? "")
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return { key, audience, projectNumber, allowedDomains };
}

export function chatToken(ctx: ConnectorContext, forceRefresh = false): Promise<OAuthToken> {
  return getServiceAccountToken(ctx.fetch, { key: googleChatSettings(ctx).key, scope: CHAT_BOT_SCOPE, service: "Google Chat" }, forceRefresh);
}

async function chatRequest<T>(ctx: ConnectorContext, path: string, options: HttpRequestOptions = {}): Promise<T> {
  const response = await withTokenRetry(
    (force) => chatToken(ctx, force),
    (token) =>
      httpRequest<T>(ctx.fetch, `${CHAT_API}/${path}`, {
        ...options,
        service: "Google Chat",
        headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` },
      }),
  );
  return response.data;
}

const SPACE = /^spaces\/[\w-]+$/;
const MESSAGE = /^spaces\/[\w-]+\/messages\/[\w.-]+$/;

/** Write in a space (a person's direct messages with the app). Returns the message's name, to update it later. */
export async function createChatMessage(ctx: ConnectorContext, space: string, message: Rec): Promise<{ name: string }> {
  if (!SPACE.test(space)) throw new ConnectorError(`Not a Google Chat space: ${space}`, "validation");
  const data = await chatRequest<Rec>(ctx, `${space}/messages`, { method: "POST", json: message });
  return { name: typeof data?.name === "string" ? data.name : "" };
}

/** Replace a message the app wrote (a card that was handled). */
export async function updateChatMessage(ctx: ConnectorContext, name: string, message: Rec): Promise<void> {
  if (!MESSAGE.test(name)) throw new ConnectorError(`Not a Google Chat message: ${name}`, "validation");
  await chatRequest(ctx, name, { method: "PATCH", query: { updateMask: "text,cardsV2" }, json: message });
}

export const googleChatConnector = defineConnector({
  manifest: defineManifest({
    type: "google-chat",
    name: "Google Chat",
    vendor: "Google",
    category: "messaging",
    description:
      "AI employees in Google Chat: people message them there, and approvals, questions and a morning summary arrive as cards with buttons. Uses your Chat app; Settings → Teams and Chat shows its HTTP endpoint.",
    auth: "custom",
    config: [
      {
        key: "service_account_key",
        label: "Service account key (JSON)",
        type: "textarea",
        required: true,
        secret: true,
        help: "A JSON key of the service account the Chat app writes as (Google Cloud → IAM → Service accounts → Keys).",
      },
      {
        key: "audience",
        label: "Authentication audience",
        type: "select",
        default: "endpoint-url",
        options: [
          { value: "endpoint-url", label: "HTTP endpoint URL (recommended)" },
          { value: "project-number", label: "Project number" },
        ],
        help: "As chosen in the Chat app's configuration (Connection settings).",
      },
      { key: "project_number", label: "Project number", type: "string", placeholder: "123456789012", help: "Only when the audience is the project number." },
      {
        key: "allowed_domains",
        label: "Your domains",
        type: "string",
        placeholder: "acme.com.tr",
        help: "Messages from people of other domains are refused. Separate several with commas.",
      },
    ],
    operations: [],
    docsUrl: "https://developers.google.com/workspace/chat/quickstart/gcf-app",
    maturity: "preview",
    itRequirements: [
      "A Google Cloud project with the Google Chat API turned on",
      "The Chat app configured with the HTTP endpoint Settings → Teams and Chat shows, and made available to your people",
      "A service account of that project and a JSON key for it",
    ],
  }),
  async test(ctx) {
    googleChatSettings(ctx);
    await chatToken(ctx, true);
    return { ok: true, message: "The Chat app's service account signed in to Google" };
  },
  operations: {},
});
