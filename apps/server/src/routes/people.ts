import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { companyOf } from "../http.ts";
import { viewerJson } from "./auth.ts";

const Membership = z.object({ departmentId: z.string().uuid(), role: z.enum(["manager", "worker"]) });

/** People and roles (Settings → People), and the sign-in settings. Admins change them; everyone sees their colleagues. */
export async function peopleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const auth = ctx.auth!;

  app.get("/api/me", async (request) => viewerJson(viewerOf(request)));

  app.get("/api/companies/:company/people", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const people = await platform.people.list(company.id);
    if (viewer.isAdmin) return people;
    // Members see the people of their own departments, and who the admins are.
    const mine = new Set(viewer.departments.map((d) => d.departmentId));
    return people
      .filter((p) => p.id === viewer.userId || p.role === "admin" || p.departments.some((d) => mine.has(d.departmentId)))
      .map((p) => ({ ...p, hasPassword: undefined, authProvider: undefined, lastSignInAt: undefined }));
  });

  app.post("/api/companies/:company/people", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const body = z
      .object({
        name: z.string().min(1),
        email: z.string(),
        title: z.string().optional(),
        role: z.enum(["admin", "member"]).default("member"),
        password: z.string().optional(),
        departments: z.array(Membership).default([]),
      })
      .parse(request.body);
    const person = await platform.people.create(company.id, { ...body, password: body.password || undefined });
    await platform.employment.assignDefaultManagers(company.id);
    await platform.activity.record(company.id, {
      actor: viewer.name,
      action: "person.added",
      entityType: "user",
      entityId: person.id,
      summary: `Added ${person.name} (${person.email})`,
    });
    return person;
  });

  app.put("/api/companies/:company/people/:id", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        title: z.string().nullable().optional(),
        role: z.enum(["admin", "member"]).optional(),
        status: z.enum(["active", "disabled"]).optional(),
        password: z.string().nullable().optional(),
        departments: z.array(Membership).optional(),
      })
      .parse(request.body);
    const person = await platform.people.update(company.id, id, body);
    if (body.departments) await platform.employment.assignDefaultManagers(company.id);
    await platform.activity.record(company.id, {
      actor: viewer.name,
      action: "person.updated",
      entityType: "user",
      entityId: person.id,
      summary: `Updated ${person.name}`,
    });
    return person;
  });

  app.delete("/api/companies/:company/people/:id", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { id } = request.params as { id: string };
    const person = await platform.people.get(company.id, id);
    await platform.people.remove(company.id, id);
    await platform.activity.record(company.id, { actor: viewer.name, action: "person.removed", entityType: "user", entityId: id, summary: `Removed ${person.name}` });
    return { ok: true };
  });

  app.get("/api/companies/:company/sign-in", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    return auth.publicSettings(company);
  });

  app.put("/api/companies/:company/sign-in", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const Provider = z.object({ clientId: z.string().min(1), secret: z.string().optional() });
    const body = z
      .object({
        microsoft: Provider.extend({ tenant: z.string().optional() }).nullable().optional(),
        google: Provider.extend({ hostedDomain: z.string().optional() }).nullable().optional(),
        autoJoinDomains: z.array(z.string()).optional(),
        demo: z.boolean().optional(),
      })
      .parse(request.body);
    const saved = await auth.saveSettings(company, body);
    await platform.activity.record(company.id, { actor: viewer.name, action: "settings.sign_in", entityType: "company", entityId: company.id, summary: "Changed the sign-in settings" });
    return saved;
  });
}
