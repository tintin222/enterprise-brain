import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAnyManager, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { companyOf } from "../http.ts";
import { StudioService } from "../studio/service.ts";

/**
 * The Studio agent: conversations in which Claude builds a solution with a manager. A message starts
 * a turn in the background; the page follows its events (`?after=` the last one it has).
 */
export async function studioRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const studio = (ctx.studio ??= new StudioService(platform));
  const base = "/api/companies/:company/studio/threads";

  app.post(base, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const body = z
      .object({ text: z.string().min(1).max(20_000), departmentId: z.string().nullish(), fileIds: z.array(z.string()).max(20).optional() })
      .parse(request.body);
    const thread = await studio.start(company.id, viewer, { text: body.text, departmentId: body.departmentId ?? null, fileIds: body.fileIds });
    return studio.view(company.id, thread.id, viewer);
  });

  app.get(base, async (request) => {
    const company = await companyOf(platform, request);
    return studio.list(company.id, viewerOf(request));
  });

  app.get(`${base}/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return studio.view(company.id, id, viewerOf(request), after);
  });

  app.post(`${base}/:id/messages`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { id } = request.params as { id: string };
    const body = z
      .object({ text: z.string().min(1).max(20_000), fileIds: z.array(z.string()).max(20).optional(), after: z.number().int().min(0).optional() })
      .parse(request.body);
    await studio.send(company.id, id, viewer, { text: body.text, fileIds: body.fileIds });
    return studio.view(company.id, id, viewer, body.after ?? 0);
  });

  app.post(`${base}/:id/stop`, async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    await studio.stop(company.id, id, viewerOf(request));
    return { stopping: true };
  });

  app.post(`${base}/:id/put-to-work`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { id } = request.params as { id: string };
    return studio.putToWork(company.id, id, viewer);
  });

  app.delete(`${base}/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    await studio.discard(company.id, id, viewerOf(request));
    return { deleted: true };
  });
}
