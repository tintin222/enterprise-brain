import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";
import { HttpError } from "../http.ts";
import { KeySets } from "./jwks.ts";

/** Who Google Chat's calls come from, and where the keys it signs them with are published. */
export const CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
export const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
export const CHAT_KEYS = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_SERVICE_ACCOUNT}`;

/**
 * Checks that a call to the Chat app comes from Google Chat. With the endpoint URL as the audience,
 * Google signs an ID token for chat@system.gserviceaccount.com issued to the endpoint's URL; with the
 * project number, Chat signs a token itself, issued to the project number.
 */
export class GoogleChatAuth {
  private readonly keys = new KeySets();

  async verify(
    authorization: string | undefined,
    settings: { audience: "endpoint-url" | "project-number"; projectNumber: string | null },
    endpointUrl: string,
  ): Promise<JWTPayload> {
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Missing Google Chat token");
    const token = authorization.slice(7).trim();
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new HttpError(401, "Invalid Google Chat token");
    }
    const byProject = settings.audience === "project-number";
    const set = await this.keys.get(byProject ? CHAT_KEYS : GOOGLE_CERTS, kid);
    const options: JWTVerifyOptions = byProject
      ? { issuer: CHAT_SERVICE_ACCOUNT, audience: settings.projectNumber ?? "", algorithms: ["RS256"], clockTolerance: 300 }
      : { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: endpointUrl, algorithms: ["RS256"], clockTolerance: 300 };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet(set), options));
    } catch (error) {
      if (error instanceof errors.JOSEError) throw new HttpError(401, `Invalid Google Chat token: ${error.message}`);
      throw error;
    }
    if (!byProject && (payload.email !== CHAT_SERVICE_ACCOUNT || (payload.email_verified !== true && payload.email_verified !== "true"))) {
      throw new HttpError(401, "The call was not made by Google Chat");
    }
    return payload;
  }
}
