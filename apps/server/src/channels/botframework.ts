import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWK, type JWTPayload } from "jose";
import { HttpError } from "../http.ts";

/** Where the Bot Framework publishes the keys it signs its calls to bots with. */
export const BOT_FRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

const DAY = 24 * 3600_000;
const REFRESH_AT_MOST_EVERY = 5 * 60_000;

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
  private keys: { set: JSONWebKeySet; fetchedAt: number } | undefined;
  private loading: Promise<{ set: JSONWebKeySet; fetchedAt: number }> | undefined;

  constructor(private readonly openIdUrl = BOT_FRAMEWORK_OPENID) {}

  private async load(): Promise<{ set: JSONWebKeySet; fetchedAt: number }> {
    const config = (await (await fetch(this.openIdUrl, { signal: AbortSignal.timeout(10_000) })).json()) as { jwks_uri?: string };
    if (!config.jwks_uri) throw new Error("The Bot Framework's sign-in configuration has no keys address");
    const set = (await (await fetch(config.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as JSONWebKeySet;
    if (!Array.isArray(set.keys)) throw new Error("The Bot Framework's keys could not be read");
    return { set, fetchedAt: Date.now() };
  }

  /** The keys, cached for a day; fetched again for an unknown key (at most every few minutes). */
  private async keySet(unknownKid = false): Promise<JSONWebKeySet> {
    const stale = !this.keys || Date.now() - this.keys.fetchedAt > DAY || (unknownKid && Date.now() - this.keys.fetchedAt > REFRESH_AT_MOST_EVERY);
    if (stale) {
      this.loading ??= this.load().finally(() => (this.loading = undefined));
      this.keys = await this.loading;
    }
    return this.keys!.set;
  }

  async verify(authorization: string | undefined, activity: { serviceUrl?: string; channelId?: string }, appId: string): Promise<JWTPayload> {
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Missing Bot Framework token");
    const token = authorization.slice(7).trim();
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new HttpError(401, "Invalid Bot Framework token");
    }
    let set = await this.keySet();
    if (!set.keys.some((k) => k.kid === kid)) set = await this.keySet(true);
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
