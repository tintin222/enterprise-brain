import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { companies, departments } from "@enterprise-brain/db";
import type { CompanyRow, Person, Platform, UserRow } from "@enterprise-brain/runtime";
import type { ServerConfig } from "../config.ts";
import { HttpError } from "../http.ts";
import { OidcClient, OidcError, googleProvider, microsoftProvider, type OidcProvider } from "./oidc.ts";
import { clearCookie, readCookie, setCookie, viewerFromPerson, type Viewer } from "./viewer.ts";

export const SESSION_COOKIE = "eb_session";
const SIGN_IN_COOKIE = "eb_sign_in";
const SIGN_IN_WINDOW_MS = 10 * 60_000;

/** Sign-in settings an admin keeps in Settings (company.settings.signIn); secrets are encrypted. */
export interface SignInSettings {
  microsoft?: { clientId: string; tenant?: string; secret: string };
  google?: { clientId: string; hostedDomain?: string; secret: string };
  /** People with an email in these domains get an account on their first Microsoft or Google sign-in. */
  autoJoinDomains?: string[];
  /** Demo installations: the seeded people can sign in with one click. */
  demo?: boolean;
  demoEmails?: string[];
}

export interface SignInSettingsInput {
  microsoft?: { clientId: string; tenant?: string; secret?: string } | null;
  google?: { clientId: string; hostedDomain?: string; secret?: string } | null;
  autoJoinDomains?: string[];
  demo?: boolean;
}

interface PendingSignIn {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expires: number;
}

/** Only paths inside this app: "/work?x=1" yes; "//evil.example", "https://…" no. */
export function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

/**
 * Sign-in for the installation's company: password accounts, Microsoft Entra ID and Google
 * (OpenID Connect), one-click demo people, and the session cookie that follows.
 */
export class AuthService {
  readonly oidc: OidcClient;
  private readonly openDepartments = new Map<string, { ids: string[]; at: number }>();

  constructor(
    private readonly platform: Platform,
    private readonly config: ServerConfig,
    private readonly options: { fetch?: typeof fetch; extraProviders?: OidcProvider[] } = {},
  ) {
    this.oidc = new OidcClient(options.fetch);
  }

  get mode(): "accounts" | "open" {
    return this.config.auth?.mode ?? "open";
  }

  private get secure(): boolean {
    return this.config.publicUrl.startsWith("https://");
  }

  private get sessionMs(): number {
    return (this.config.auth?.sessionHours ?? 12) * 3600_000;
  }

  /** The company people sign in to: one per installation. */
  async company(): Promise<CompanyRow> {
    const company = await this.platform.company(this.config.defaultCompany.slug);
    if (!company) throw new HttpError(503, "The company is not set up yet");
    return company;
  }

  settings(company: CompanyRow): SignInSettings {
    return (company.settings.signIn ?? {}) as SignInSettings;
  }

  /** Providers from Settings, falling back to the environment (EB_AUTH_MICROSOFT_*, EB_AUTH_GOOGLE_*). */
  providers(company: CompanyRow): OidcProvider[] {
    const saved = this.settings(company);
    const decrypt = (secret: string) => this.platform.secretBox.decrypt<string>(secret);
    const fromEnv = (id: "microsoft" | "google") => this.config.auth?.providers.find((p) => p.id === id);
    const list: OidcProvider[] = [];
    const msEnv = fromEnv("microsoft");
    const ms = saved.microsoft?.tenant
      ? microsoftProvider({ clientId: saved.microsoft.clientId, clientSecret: decrypt(saved.microsoft.secret), tenant: saved.microsoft.tenant })
      : !saved.microsoft && msEnv?.tenant
        ? microsoftProvider({ ...msEnv, tenant: msEnv.tenant })
        : undefined;
    if (ms) list.push(ms);
    const google = saved.google
      ? googleProvider({ clientId: saved.google.clientId, clientSecret: decrypt(saved.google.secret), hostedDomain: saved.google.hostedDomain })
      : fromEnv("google") && googleProvider(fromEnv("google")!);
    if (google) list.push(google);
    return [...list, ...(this.options.extraProviders ?? [])];
  }

  /** What Settings shows: never the secrets. */
  publicSettings(company: CompanyRow) {
    const saved = this.settings(company);
    const env = (id: "microsoft" | "google") => this.config.auth?.providers.find((p) => p.id === id);
    return {
      redirectUris: {
        microsoft: `${this.config.publicUrl}/api/auth/oidc/microsoft/callback`,
        google: `${this.config.publicUrl}/api/auth/oidc/google/callback`,
      },
      microsoft: saved.microsoft
        ? { configured: true, source: "settings" as const, clientId: saved.microsoft.clientId, tenant: saved.microsoft.tenant ?? "" }
        : env("microsoft")
          ? { configured: true, source: "environment" as const, clientId: env("microsoft")!.clientId, tenant: env("microsoft")!.tenant ?? "" }
          : { configured: false, source: null, clientId: "", tenant: "" },
      google: saved.google
        ? { configured: true, source: "settings" as const, clientId: saved.google.clientId, hostedDomain: saved.google.hostedDomain ?? "" }
        : env("google")
          ? { configured: true, source: "environment" as const, clientId: env("google")!.clientId, hostedDomain: env("google")!.hostedDomain ?? "" }
          : { configured: false, source: null, clientId: "", hostedDomain: "" },
      autoJoinDomains: saved.autoJoinDomains ?? [],
      demo: Boolean(saved.demo),
    };
  }

  async saveSettings(company: CompanyRow, input: SignInSettingsInput): Promise<ReturnType<AuthService["publicSettings"]>> {
    const current = this.settings(company);
    const next: SignInSettings = { ...current };
    const encrypt = (value: string) => this.platform.secretBox.encrypt(value);
    if (input.microsoft === null) delete next.microsoft;
    else if (input.microsoft) {
      const secret = input.microsoft.secret ? encrypt(input.microsoft.secret) : current.microsoft?.secret;
      if (!secret) throw new HttpError(400, "Enter the client secret of the Microsoft app registration");
      const tenant = input.microsoft.tenant?.trim() ?? "";
      if (!tenant || ["common", "organizations", "consumers"].includes(tenant.toLowerCase())) {
        throw new HttpError(400, "Enter your organisation's tenant: its directory (tenant) ID or primary domain, e.g. acme.com.tr");
      }
      next.microsoft = { clientId: input.microsoft.clientId.trim(), tenant, secret };
    }
    if (input.google === null) delete next.google;
    else if (input.google) {
      const secret = input.google.secret ? encrypt(input.google.secret) : current.google?.secret;
      if (!secret) throw new HttpError(400, "Enter the client secret of the Google OAuth client");
      next.google = { clientId: input.google.clientId.trim(), hostedDomain: input.google.hostedDomain?.trim() || undefined, secret };
    }
    if (input.autoJoinDomains) next.autoJoinDomains = [...new Set(input.autoJoinDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    if (input.demo !== undefined) next.demo = input.demo;
    const settings = { ...company.settings, signIn: next };
    await this.platform.handle.db.update(companies).set({ settings }).where(eq(companies.id, company.id));
    return this.publicSettings({ ...company, settings });
  }

  /** Mark people as one-click demo accounts (seeded demo installations). */
  async enableDemo(company: CompanyRow, emails: string[]): Promise<void> {
    const current = this.settings(company);
    const settings = { ...company.settings, signIn: { ...current, demo: true, demoEmails: [...new Set([...(current.demoEmails ?? []), ...emails])] } };
    await this.platform.handle.db.update(companies).set({ settings }).where(eq(companies.id, company.id));
  }

  async demoPeople(company: CompanyRow): Promise<Person[]> {
    const saved = this.settings(company);
    if (!saved.demo || !saved.demoEmails?.length) return [];
    const people = await this.platform.people.list(company.id);
    return people.filter((p) => p.status === "active" && saved.demoEmails!.includes(p.email));
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async viewerFromRequest(request: FastifyRequest): Promise<Viewer | undefined> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return undefined;
    const person = await this.platform.people.resolveSession(token);
    return person ? viewerFromPerson(person, await this.openDepartmentIds(person.companyId)) : undefined;
  }

  /** Departments open to everyone (their template says so), cached for a minute. */
  async openDepartmentIds(companyId: string): Promise<string[]> {
    const cached = this.openDepartments.get(companyId);
    if (cached && Date.now() - cached.at < 60_000) return cached.ids;
    const rows = await this.platform.handle.db
      .select({ id: departments.id, key: departments.key, templateId: departments.templateId, data: departments.data })
      .from(departments)
      .where(eq(departments.companyId, companyId));
    const templates = this.platform.catalog.catalog.departments;
    const ids = rows
      .filter((d) => d.data.openToEveryone === true || templates.find((t) => t.id === (d.templateId ?? d.key))?.openToEveryone)
      .map((d) => d.id);
    this.openDepartments.set(companyId, { ids, at: Date.now() });
    return ids;
  }

  async startSession(reply: FastifyReply, user: UserRow, provider: string, externalId?: string): Promise<Person> {
    const { token } = await this.platform.people.createSession(user.companyId, user.id, this.sessionMs);
    setCookie(reply, SESSION_COOKIE, token, { maxAgeSeconds: this.sessionMs / 1000, secure: this.secure });
    await this.platform.people.recordSignIn(user.id, provider, externalId);
    await this.platform.activity.record(user.companyId, {
      actor: `${user.name} <${user.email}>`,
      action: "person.signed_in",
      entityType: "user",
      entityId: user.id,
      summary: `${user.name} signed in (${provider})`,
    });
    return this.platform.people.get(user.companyId, user.id);
  }

  async signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await this.platform.people.deleteSession(token);
    clearCookie(reply, SESSION_COOKIE, this.secure);
  }

  // -------------------------------------------------------------------------
  // Microsoft and Google
  // -------------------------------------------------------------------------

  private redirectUri(providerId: string): string {
    return `${this.config.publicUrl}/api/auth/oidc/${encodeURIComponent(providerId)}/callback`;
  }

  async beginOidc(reply: FastifyReply, providerId: string, returnTo: unknown): Promise<string> {
    const company = await this.company();
    const provider = this.providers(company).find((p) => p.id === providerId);
    if (!provider) throw new HttpError(404, `Sign-in with ${providerId} is not set up`);
    const started = await this.oidc.begin(provider, this.redirectUri(provider.id));
    const pending: PendingSignIn = {
      provider: provider.id,
      state: started.state,
      nonce: started.nonce,
      verifier: started.verifier,
      returnTo: safeReturnTo(returnTo),
      expires: Date.now() + SIGN_IN_WINDOW_MS,
    };
    setCookie(reply, SIGN_IN_COOKIE, this.platform.secretBox.encrypt(pending), { maxAgeSeconds: SIGN_IN_WINDOW_MS / 1000, secure: this.secure });
    return started.url;
  }

  /** Finish a Microsoft or Google sign-in; returns where to send the browser. */
  async completeOidc(request: FastifyRequest, reply: FastifyReply, providerId: string, query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    const raw = readCookie(request, SIGN_IN_COOKIE);
    clearCookie(reply, SIGN_IN_COOKIE, this.secure);
    if (query.error) throw new OidcError(query.error_description || query.error);
    let pending: PendingSignIn | undefined;
    try {
      pending = raw ? this.platform.secretBox.decrypt<PendingSignIn>(raw) : undefined;
    } catch {
      pending = undefined;
    }
    if (!pending || pending.provider !== providerId || pending.state !== query.state || pending.expires < Date.now() || !query.code) {
      throw new OidcError("This sign-in expired or was started elsewhere. Please try again.");
    }
    const company = await this.company();
    const provider = this.providers(company).find((p) => p.id === providerId);
    if (!provider) throw new OidcError(`Sign-in with ${providerId} is not set up`);
    const identity = await this.oidc.complete(provider, { code: query.code, redirectUri: this.redirectUri(provider.id), verifier: pending.verifier, nonce: pending.nonce });

    let user = await this.platform.people.findByEmail(company.id, identity.email);
    if (!user) {
      const domain = identity.email.split("@")[1] ?? "";
      if (!(this.settings(company).autoJoinDomains ?? []).includes(domain)) {
        throw new OidcError(`${identity.email} has no account here. Ask your administrator to add you.`);
      }
      const person = await this.platform.people.create(company.id, { email: identity.email, name: identity.name, authProvider: provider.id });
      user = await this.platform.people.findByEmail(company.id, person.email);
    }
    if (!user || user.status !== "active") throw new OidcError("This account is disabled. Ask your administrator.");
    await this.startSession(reply, user, provider.id, identity.subject);
    return pending.returnTo;
  }
}
