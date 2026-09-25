import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { StakeholderRole } from "@enterprise-brain/core";
import { requireAnyManager, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";

const StartBody = z.object({
  description: z.string().min(3),
  formDescription: z.string().optional(),
  requesterName: z.string().optional(),
  requesterEmail: z.string().optional(),
  requesterRole: z.string().optional(),
  department: z.string().optional(),
  language: z.string().optional(),
  roundSize: z.number().int().min(1).max(10).optional(),
});

const ReplyBody = z.object({
  text: z.string().optional(),
  answers: z
    .array(
      z.object({
        nodeId: z.string(),
        action: z.enum(["answer", "accept", "delegate", "skip"]).optional(),
        value: z.unknown().optional(),
        delegateTo: StakeholderRole.optional(),
      }),
    )
    .optional(),
  fileIds: z.array(z.string()).optional(),
});

/** A Studio interview is its hiring manager's: they, the managers of its department and admins see it. */
function mayOpen(viewer: Viewer, session: { requesterEmail: string | null; department: string | null }): boolean {
  if (viewer.isAdmin) return true;
  if (viewer.email && session.requesterEmail?.toLowerCase() === viewer.email.toLowerCase()) return true;
  return viewer.departments.some((d) => d.role === "manager" && d.key === session.department);
}

export async function builderRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, builder } = ctx;

  /** The session :id if the viewer may work on it (a manager), 404 otherwise. */
  const sessionFor = async (request: FastifyRequest, companyId: string) => {
    const viewer = requireAnyManager(request);
    const { id } = request.params as { id: string };
    const session = await builder.find(companyId, id);
    if (!mayOpen(viewer, session)) throw new HttpError(404, `Builder session ${id} not found`);
    return id;
  };

  app.get("/api/companies/:company/builder/sessions", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const sessions = (await builder.list(company.id)).filter((s) => mayOpen(viewer, s));
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      archetype: s.archetype,
      templateId: s.templateId,
      department: s.department,
      requesterName: s.requesterName,
      requesterRole: s.requesterRole,
      agentId: s.agentId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  });

  app.post("/api/companies/:company/builder/sessions", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const body = StartBody.parse(request.body);
    // A signed-in manager hires for themselves, into the department they manage.
    const managed = viewer.departments.filter((d) => d.role === "manager");
    const person = viewer.kind === "session" && viewer.userId ? await platform.people.get(company.id, viewer.userId).catch(() => undefined) : undefined;
    return builder.start(company.id, {
      ...body,
      ...(person ? { requesterName: person.name, requesterEmail: person.email, requesterRole: person.title ?? body.requesterRole } : {}),
      department: body.department ?? (managed.length === 1 ? managed[0]!.key : undefined),
    });
  });

  app.get("/api/companies/:company/builder/sessions/:id", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    return builder.get(company.id, id);
  });

  app.post("/api/companies/:company/builder/sessions/:id/reply", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    if (request.isMultipart()) {
      const { fields, files } = await readMultipart(platform, company.id, request, "builder");
      return builder.reply(company.id, id, { text: fields.text, fileIds: files.map((f) => f.id) });
    }
    return builder.reply(company.id, id, ReplyBody.parse(request.body));
  });

  app.post("/api/companies/:company/builder/sessions/:id/samples", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    if (!request.isMultipart()) throw new HttpError(400, "Upload samples as multipart/form-data");
    const { files } = await readMultipart(platform, company.id, request, "builder");
    return builder.reply(company.id, id, { fileIds: files.map((f) => f.id) });
  });

  app.post("/api/companies/:company/builder/sessions/:id/reference", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    if (!request.isMultipart()) throw new HttpError(400, "Upload documents as multipart/form-data");
    const { files } = await readMultipart(platform, company.id, request, "knowledge");
    return builder.addReference(company.id, id, files.map((f) => f.id));
  });

  app.post("/api/companies/:company/builder/sessions/:id/proceed", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    return builder.proceedWithAssumptions(company.id, id);
  });

  app.post("/api/companies/:company/builder/sessions/:id/confirm", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    const view = await builder.confirm(company.id, id);
    if (view.agent) await platform.employment.assignDefaultManagers(company.id, { by: viewerOf(request).userId, agentIds: [view.agent.id] });
    return view;
  });

  app.post("/api/companies/:company/builder/sessions/:id/activate", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    const view = await builder.activate(company.id, id);
    if (view.agent) await platform.employment.assignDefaultManagers(company.id, { by: viewerOf(request).userId, agentIds: [view.agent.id] });
    return view;
  });

  app.post("/api/companies/:company/builder/sessions/:id/reopen", async (request) => {
    const company = await companyOf(platform, request);
    const id = await sessionFor(request, company.id);
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.body);
    return builder.reopenNode(company.id, id, nodeId);
  });

  /** A stakeholder request :id of a session the viewer may work on, 404 otherwise. */
  const requestFor = async (request: FastifyRequest, companyId: string) => {
    const viewer = requireAnyManager(request);
    const { id } = request.params as { id: string };
    if (!mayOpen(viewer, await builder.sessionOfRequest(companyId, id))) throw new HttpError(404, `Request ${id} not found`);
    return id;
  };

  app.put("/api/companies/:company/builder/requests/:id", async (request) => {
    const company = await companyOf(platform, request);
    const id = await requestFor(request, company.id);
    const body = z
      .object({ recipientName: z.string().optional(), recipientEmail: z.string().optional(), subject: z.string().optional(), body: z.string().optional() })
      .parse(request.body);
    return builder.updateRequest(company.id, id, body);
  });

  app.post("/api/companies/:company/builder/requests/:id/send", async (request) => {
    const company = await companyOf(platform, request);
    const id = await requestFor(request, company.id);
    const { via } = z.object({ via: z.enum(["mail", "manual"]).default("manual") }).parse(request.body ?? {});
    return builder.sendRequest(company.id, id, { via });
  });

  // Public stakeholder answer page API (the link in the request email; the token is the credential).
  app.get("/api/public/requests/:token", async (request) => {
    const { token } = request.params as { token: string };
    return builder.requestByToken(token);
  });

  app.post("/api/public/requests/:token/answers", async (request) => {
    const { token } = request.params as { token: string };
    const body = z
      .object({
        answers: z.array(z.object({ nodeId: z.string(), answer: z.string() })).min(1),
        answeredBy: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(request.body);
    await builder.answerRequest(token, body);
    return { ok: true };
  });
}
