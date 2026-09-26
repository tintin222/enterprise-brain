import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { oauthSettings, requestToken, secureUrl } from "@enterprise-brain/connectors";
import { actorOf, requireAdmin, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

interface PendingSignIn {
  companyId: string;
  connectionId: string;
  userId: string | null;
  verifier: string;
  expiresAt: number;
}

const TEN_MINUTES = 10 * 60_000;

/** Where providers send people back after signing a connection in (to register with the provider). */
export function oauthRedirectUrl(publicUrl: string): string {
  return `${publicUrl}/api/connectors/oauth/callback`;
}

/**
 * Signing a connection in with OAuth 2.0 (authorization code with PKCE): an admin is sent to the
 * provider, signs in, and comes back here; the refresh token is kept, encrypted, on the connection.
 * The state is single-use, expires in ten minutes and belongs to the admin who started.
 */
export async function connectionSignInRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, config } = ctx;
  const pending = new Map<string, PendingSignIn>();
  const redirectUri = oauthRedirectUrl(config.publicUrl);

  app.get("/api/companies/:company/connectors/:id/oauth/start", async (request, reply) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { id } = request.params as { id: string };
    const connection = await platform.connectors.contextFor(company.id, id);
    if (connection.config.auth_type !== "oauth2_authorization_code") throw new HttpError(409, "This connection doesn't sign in with OAuth 2.0");
    const settings = oauthSettings(connection);
    const authorize = new URL(secureUrl(String(connection.config.authorize_url ?? ""), "OAuth sign-in URL"));
    for (const [key, entry] of pending) if (entry.expiresAt < Date.now()) pending.delete(key);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    pending.set(state, { companyId: company.id, connectionId: id, userId: viewer.userId, verifier, expiresAt: Date.now() + TEN_MINUTES });
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", settings.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorize.searchParams.set("code_challenge_method", "S256");
    if (settings.scope) authorize.searchParams.set("scope", settings.scope);
    if (settings.extraParams?.audience) authorize.searchParams.set("audience", settings.extraParams.audience);
    return reply.redirect(authorize.toString());
  });

  app.get("/api/connectors/oauth/callback", async (request, reply) => {
    const query = z
      .object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() })
      .parse(request.query);
    const entry = pending.get(query.state);
    pending.delete(query.state);
    const back = (params: Record<string, string>) => reply.redirect(`/settings/connections?${new URLSearchParams(params)}`);
    if (!entry || entry.expiresAt < Date.now()) return back({ signin: "expired" });
    const viewer = viewerOf(request);
    if (!viewer.isAdmin || viewer.userId !== entry.userId) throw new HttpError(403, "The sign-in was started by someone else");
    if (query.error || !query.code) {
      return back({ signin: "failed", connection: entry.connectionId, reason: query.error_description ?? query.error ?? "The provider sent no code" });
    }
    const connection = await platform.connectors.contextFor(entry.companyId, entry.connectionId);
    const settings = oauthSettings(connection);
    let refreshToken: string | undefined;
    try {
      const token = await requestToken(connection.fetch, {
        tokenUrl: settings.tokenUrl,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        clientAuth: settings.clientAuth,
        params: { grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri, code_verifier: entry.verifier },
        service: "The sign-in provider",
      });
      refreshToken = token.refreshToken;
    } catch (error) {
      return back({ signin: "failed", connection: entry.connectionId, reason: error instanceof Error ? error.message : String(error) });
    }
    if (!refreshToken) {
      return back({
        signin: "failed",
        connection: entry.connectionId,
        reason: "The provider gave no refresh token: allow offline access (often the offline_access scope)",
      });
    }
    await platform.connectors.saveSecrets(entry.companyId, entry.connectionId, { refresh_token: refreshToken });
    await platform.connectors.test(entry.companyId, entry.connectionId);
    const instance = await platform.connectors.get(entry.companyId, entry.connectionId);
    await platform.activity.record(entry.companyId, {
      actor: actorOf(viewer),
      action: "connector.signed_in",
      entityType: "connector",
      entityId: entry.connectionId,
      summary: `Signed ${instance.name} in with OAuth 2.0`,
    });
    return back({ signin: "ok", connection: entry.connectionId });
  });
}
