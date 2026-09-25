import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** An OpenID Connect sign-in: Microsoft Entra ID, Google, or (in tests) any compliant issuer. */
export interface OidcProvider {
  id: string;
  label: string;
  /** Discovery base: <issuer>/.well-known/openid-configuration */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Google: only accounts of this Workspace domain. */
  hostedDomain?: string;
  /** Refuse ID tokens without email_verified: true (Google sends it; Microsoft does not). */
  requireVerifiedEmail?: boolean;
}

/** Microsoft's shared endpoints accept accounts of any organisation: never used for sign-in here. */
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/**
 * Microsoft Entra ID, limited to the customer's own tenant. Other tenants' tokens fail the issuer check;
 * this matters because their administrators can put any address in the email claim.
 */
export function microsoftProvider(input: { clientId: string; clientSecret: string; tenant: string }): OidcProvider {
  const tenant = input.tenant.trim();
  if (!tenant || MULTI_TENANT.has(tenant.toLowerCase())) {
    throw new OidcError("Microsoft sign-in needs your organisation's tenant: its directory (tenant) ID or primary domain");
  }
  return {
    id: "microsoft",
    label: "Microsoft",
    issuer: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0`,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
}

export function googleProvider(input: { clientId: string; clientSecret: string; hostedDomain?: string }): OidcProvider {
  return {
    id: "google",
    label: "Google",
    issuer: "https://accounts.google.com",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    hostedDomain: input.hostedDomain || undefined,
    requireVerifiedEmail: true,
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcIdentity {
  provider: string;
  subject: string;
  email: string;
  name: string;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

function random(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Authorization-code sign-in with PKCE. The ID token's signature (the issuer's published keys), audience,
 * issuer and nonce are all checked before the email in it is trusted.
 */
export class OidcClient {
  private readonly discoveries = new Map<string, { doc: Discovery; at: number }>();
  private readonly keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async discover(issuer: string): Promise<Discovery> {
    const cached = this.discoveries.get(issuer);
    if (cached && Date.now() - cached.at < 3600_000) return cached.doc;
    const response = await this.fetchImpl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new OidcError(`The sign-in provider did not answer (${response.status})`);
    const doc = (await response.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new OidcError("The sign-in provider's configuration is incomplete");
    this.discoveries.set(issuer, { doc, at: Date.now() });
    return doc;
  }

  /** Where to send the browser, and what the callback must check afterwards. */
  async begin(provider: OidcProvider, redirectUri: string): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const doc = await this.discover(provider.issuer);
    const state = random();
    const nonce = random();
    const verifier = random(48);
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(provider.hostedDomain ? { hd: provider.hostedDomain } : {}),
    }).toString();
    return { url: url.toString(), state, nonce, verifier };
  }

  async complete(provider: OidcProvider, input: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<OidcIdentity> {
    const doc = await this.discover(provider.issuer);
    const response = await this.fetchImpl(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: input.verifier,
      }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!response.ok || !body.id_token) throw new OidcError(`Sign-in was not completed: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);

    let keys = this.keySets.get(doc.jwks_uri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(doc.jwks_uri));
      this.keySets.set(doc.jwks_uri, keys);
    }
    let claims: JWTPayload & Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(body.id_token, keys, { audience: provider.clientId, clockTolerance: 60 }));
    } catch (error) {
      throw new OidcError(`The sign-in token could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (claims.iss !== doc.issuer) throw new OidcError("The sign-in token comes from an unexpected issuer");
    if (claims.nonce !== input.nonce) throw new OidcError("The sign-in token does not belong to this sign-in");
    if (provider.hostedDomain && claims.hd !== provider.hostedDomain) throw new OidcError(`Only ${provider.hostedDomain} accounts can sign in`);
    if (claims.email_verified === false || (provider.requireVerifiedEmail && claims.email_verified !== true)) {
      throw new OidcError("The email address of this account is not verified");
    }
    const email = [claims.email, claims.preferred_username, claims.upn].find((v): v is string => typeof v === "string" && v.includes("@"));
    if (!email || !claims.sub) throw new OidcError("The sign-in provider did not share an email address");
    return {
      provider: provider.id,
      subject: claims.sub,
      email: email.toLowerCase(),
      name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email,
    };
  }
}
