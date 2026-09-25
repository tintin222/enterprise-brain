import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PeopleError, type Person } from "@enterprise-brain/runtime";
import { safeReturnTo } from "../auth/service.ts";
import { OPEN_VIEWER, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

/** Failed password attempts per email + address: 8 in 15 minutes, then a pause. */
const ATTEMPTS = new Map<string, { count: number; since: number }>();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

function throttleKey(request: FastifyRequest, email: string): string {
  return `${request.ip}|${email.trim().toLowerCase()}`;
}

function checkThrottle(key: string) {
  const entry = ATTEMPTS.get(key);
  if (entry && Date.now() - entry.since < ATTEMPT_WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  }
}

function recordFailure(key: string) {
  const entry = ATTEMPTS.get(key);
  if (!entry || Date.now() - entry.since >= ATTEMPT_WINDOW_MS) ATTEMPTS.set(key, { count: 1, since: Date.now() });
  else entry.count += 1;
}

export function viewerJson(viewer: Viewer) {
  return {
    kind: viewer.kind,
    id: viewer.userId,
    name: viewer.name,
    email: viewer.email,
    isAdmin: viewer.isAdmin,
    departments: viewer.departments.map((d) => ({ id: d.departmentId, key: d.key, name: d.name, role: d.role })),
  };
}

/** Demo people on the sign-in page: the admin first, then managers, then workers. */
function byRank(a: Person, b: Person): number {
  const rank = (p: Person) => (p.role === "admin" ? 0 : p.departments.some((d) => d.role === "manager") ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** Sign-in for the installation (not company-scoped: one company per installation). */
export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const auth = ctx.auth!;

  /** Everything the sign-in page and the app shell need to know about who is here. */
  app.get("/api/auth/state", async (request) => {
    const company = await auth.company().catch(() => undefined);
    const viewer = (await auth.viewerFromRequest(request)) ?? (auth.mode === "open" ? OPEN_VIEWER : undefined);
    const setupRequired = auth.mode === "accounts" && Boolean(company) && (await platform.people.count(company!.id)) === 0;
    return {
      mode: auth.mode,
      company: company ? { slug: company.slug, name: company.name } : null,
      setupRequired,
      viewer: viewer ? viewerJson(viewer) : null,
      providers: company ? auth.providers(company).map((p) => ({ id: p.id, label: p.label })) : [],
      demo: company
        ? (await auth.demoPeople(company)).sort(byRank).map((p) => ({
            email: p.email,
            name: p.name,
            title: p.title,
            isAdmin: p.role === "admin",
            departments: p.departments.map((d) => ({ name: d.name, role: d.role })),
          }))
        : [],
    };
  });

  /** First start: the first person becomes the admin. Only while nobody has an account. */
  app.post("/api/auth/setup", async (request, reply) => {
    if (auth.mode !== "accounts") throw new HttpError(400, "Sign-in is off (EB_AUTH=open)");
    const company = await auth.company();
    if ((await platform.people.count(company.id)) > 0) throw new HttpError(409, "This installation is already set up. Sign in instead.");
    const body = z.object({ name: z.string().min(1), email: z.string(), password: z.string() }).parse(request.body);
    const person = await platform.people.create(company.id, { ...body, role: "admin", authProvider: "password" });
    const user = await platform.people.findByEmail(company.id, person.email);
    const signedIn = await auth.startSession(reply, user!, "password");
    return { ok: true, person: signedIn };
  });

  app.post("/api/auth/signin", async (request, reply) => {
    const company = await auth.company();
    const body = z.object({ email: z.string(), password: z.string() }).parse(request.body);
    const key = throttleKey(request, body.email);
    checkThrottle(key);
    const user = await platform.people.checkPassword(company.id, body.email, body.password);
    if (!user) {
      recordFailure(key);
      throw new HttpError(401, "Wrong email or password");
    }
    ATTEMPTS.delete(key);
    const person = await auth.startSession(reply, user, "password");
    return { ok: true, person };
  });

  /** One-click sign-in as a seeded demo person (demo installations only). */
  app.post("/api/auth/demo", async (request, reply) => {
    const company = await auth.company();
    const { email } = z.object({ email: z.string() }).parse(request.body);
    const demo = await auth.demoPeople(company);
    const person = demo.find((p) => p.email === email.trim().toLowerCase());
    if (!person) throw new HttpError(403, "Demo sign-in is not available for this account");
    const user = await platform.people.findByEmail(company.id, person.email);
    return { ok: true, person: await auth.startSession(reply, user!, "demo") };
  });

  app.post("/api/auth/signout", async (request, reply) => {
    await auth.signOut(request, reply);
    return { ok: true };
  });

  app.get("/api/auth/oidc/:provider/start", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const { returnTo } = request.query as { returnTo?: string };
    try {
      return reply.redirect(await auth.beginOidc(reply, provider, returnTo));
    } catch (error) {
      return reply.redirect(`/signin?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });

  app.get("/api/auth/oidc/:provider/callback", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    try {
      const returnTo = await auth.completeOidc(request, reply, provider, request.query as Record<string, string>);
      return reply.redirect(safeReturnTo(returnTo));
    } catch (error) {
      const message = error instanceof PeopleError || error instanceof Error ? error.message : String(error);
      return reply.redirect(`/signin?error=${encodeURIComponent(message)}`);
    }
  });
}
