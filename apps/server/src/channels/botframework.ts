import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWK, type JWTPayload } from "jose";
import { HttpError } from "../http.ts";
import { fetchJson, KeySets } from "./jwks.ts";

/** Where the Bot Framework publishes the keys it signs its calls to bots with. */
export const BOT_FRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

type EndorsedKey = JWK & { endorsements?: string[] };

function sameServiceUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

/**
 * Checks that a call to the bot comes from the Bot Framework: signed with its published keys (endorsed
 * for the channel), issued to this bot, current, and for the serviceUrl the activity names (the bot
 * sends its own token there when it answers).
 */
export class BotFrameworkAuth {
  /** The keys, found through the Bot Framework's sign-in configuration. */
  private readonly keys = new KeySets(async (openIdUrl) => {
    const config = (await fetchJson(openIdUrl)) as { jwks_uri?: unknown };
    if (typeof config?.jwks_uri !== "string") throw new Error("The Bot Framework's sign-in configuration has no keys address");
    return fetchJson(config.jwks_uri);
  });

  constructor(private readonly openIdUrl = BOT_FRAMEWORK_OPENID) {}

  async verify(authorization: string | undefined, activity: { serviceUrl?: string; channelId?: string }, appId: string): Promise<JWTPayload> {
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Missing Bot Framework token");
    const token = authorization.slice(7).trim();
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new HttpError(401, "Invalid Bot Framework token");
    }
    const set = await this.keys.get(this.openIdUrl, kid);
    const key = set.keys.find((k) => k.kid === kid) as EndorsedKey | undefined;
    if (!key) throw new HttpError(401, "The token was not signed with a Bot Framework key");
    if (Array.isArray(key.endorsements) && activity.channelId && !key.endorsements.includes(activity.channelId)) {
      throw new HttpError(401, `The signing key is not endorsed for ${activity.channelId}`);
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet(set), {
        issuer: BOT_FRAMEWORK_ISSUER,
        audience: appId,
        algorithms: ["RS256"],
        clockTolerance: 300,
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError) throw new HttpError(401, `Invalid Bot Framework token: ${error.message}`);
      throw error;
    }
    const claimed = payload.serviceUrl;
    if (activity.serviceUrl && (typeof claimed !== "string" || !sameServiceUrl(claimed, activity.serviceUrl))) {
      throw new HttpError(401, "The token was issued for another serviceUrl");
    }
    return payload;
  }
}
