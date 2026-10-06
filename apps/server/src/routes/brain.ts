import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ColumnDefinitions, LearnChange, applyLearning, proposeLearning, suggestDefinitions } from "@enterprise-brain/brain";
import {
  BRAIN_KIND_KEYS,
  BRAIN_RELATION_KEYS,
  BrainEntityInput,
  BrainEntityPatch,
  BrainEventInput,
  BrainLinkInput,
  brainKind,
  type BrainImage,
} from "@enterprise-brain/core";
import { actorOf, requireAnyManager, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/**
 * The company brain: everyone reads it, asks it and adds know-how and notes; managers and admins
 * shape it (add, change and remove things and links) and read its sources.
 */
export async function brainRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const base = "/api/companies/:company/brain";

  const editor = (viewer: Viewer) => viewer.isAdmin || viewer.departments.some((d) => d.role === "manager");
  const requireEditor = (request: FastifyRequest): Viewer => {
    const viewer = viewerOf(request);
    if (!editor(viewer)) throw new HttpError(403, "Only a manager or an admin can change this; you can add know-how and notes");
    return viewer;
  };

  /** Pictures people add (a report's screenshots) are uploaded pictures: PNG, JPEG, GIF or WebP. */
  const checkPictures = async (companyId: string, kindKey: string, data: Record<string, unknown> | undefined) => {
    for (const field of brainKind(kindKey)?.fields ?? []) {
      const pictures = data?.[field.key];
      if (field.type !== "images" || !Array.isArray(pictures)) continue;
      for (const picture of pictures as { file?: unknown }[]) {
        if (typeof picture?.file !== "string") continue;
        const meta = await platform.files.meta(companyId, picture.file).catch(() => undefined);
        if (!meta || !/^image\/(png|jpeg|gif|webp)$/.test(meta.mimeType)) throw new HttpError(400, `${field.label}: upload a PNG, JPEG, GIF or WebP picture`);
      }
    }
  };

  app.get(`${base}/model`, async () => platform.brain.model());

  app.get(`${base}/overview`, async (request) => {
    const company = await companyOf(platform, request);
    return platform.brain.overview(company.id);
  });

  app.get(`${base}/entities`, async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({
        kind: z.enum(BRAIN_KIND_KEYS).optional(),
        kinds: z.string().optional(),
        q: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        with: z.literal("links").optional(),
      })
      .parse(request.query);
    const kinds = query.kinds?.split(",").filter((k) => (BRAIN_KIND_KEYS as readonly string[]).includes(k));
    return platform.brain.list(company.id, { kind: query.kind, kinds, q: query.q, limit: query.limit, keyLinks: query.with === "links" });
  });

  app.post(`${base}/entities`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = BrainEntityInput.extend({
      links: z
        .array(
          z.object({
            relation: z.enum(BRAIN_RELATION_KEYS),
            to: z.string().min(1),
            detail: z.string().trim().max(200).optional(),
            reverse: z.boolean().optional(),
          }),
        )
        .max(50)
        .optional(),
    }).parse(request.body);
    // Everyone may write down know-how and tie it to what it is about; the rest is for managers.
    if (body.kind !== "knowhow") requireEditor(request);
    await checkPictures(company.id, body.kind, body.data);
    const actor = actorOf(viewer);
    const created = await platform.brain.create(company.id, body, actor);
    for (const link of body.links ?? []) {
      await platform.brain.link(
        company.id,
        link.reverse
          ? { from: link.to, relation: link.relation, to: created.id, detail: link.detail }
          : { from: created.id, relation: link.relation, to: link.to, detail: link.detail },
        actor,
      );
    }
    if (body.kind === "knowhow" && viewer.email) {
      const [me] = await platform.brain.list(company.id, { kind: "person", q: viewer.email, limit: 1 });
      if (me) await platform.brain.link(company.id, { from: created.id, relation: "shared_by", to: me.id }, actor).catch(() => undefined);
    }
    return platform.brain.get(company.id, created.id);
  });

  app.get(`${base}/entities/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    return platform.brain.get(company.id, id);
  });

  app.patch(`${base}/entities/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    const { id } = request.params as { id: string };
    const patch = BrainEntityPatch.parse(request.body);
    if (patch.data) await checkPictures(company.id, (await platform.brain.get(company.id, id)).kind, patch.data);
    return platform.brain.update(company.id, id, patch, actorOf(viewer));
  });

  app.delete(`${base}/entities/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    const { id } = request.params as { id: string };
    await platform.brain.remove(company.id, id, actorOf(viewer));
    return { removed: true };
  });

  app.post(`${base}/links`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    return platform.brain.link(company.id, BrainLinkInput.parse(request.body), actorOf(viewer));
  });

  app.delete(`${base}/links/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    const { id } = request.params as { id: string };
    await platform.brain.unlink(company.id, id, actorOf(viewer));
    return { removed: true };
  });

  app.get(`${base}/events`, async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({
        about: z.string().optional(),
        origin: z.string().max(40).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    return platform.brain.events(company.id, {
      about: query.about,
      origin: query.origin,
      before: query.before ? new Date(query.before) : undefined,
      limit: query.limit ?? 50,
    });
  });

  app.post(`${base}/events`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    return platform.brain.addEvent(company.id, BrainEventInput.parse(request.body), actorOf(viewer), viewer.email);
  });

  app.get(`${base}/graph`, async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({
        focus: z.string().optional(),
        depth: z.coerce.number().int().min(1).max(3).optional(),
        limit: z.coerce.number().int().min(5).max(200).optional(),
      })
      .parse(request.query);
    return platform.brain.graph(company.id, query.focus || undefined, { depth: query.depth, limit: query.limit });
  });

  app.get(`${base}/search`, async (request) => {
    const company = await companyOf(platform, request);
    const { q, kinds } = z.object({ q: z.string().max(500), kinds: z.string().optional() }).parse(request.query);
    return platform.brain.search(company.id, q, { kinds: kinds?.split(",").filter(Boolean), limit: 30 });
  });

  /** "Tell the brain": what someone knows, in their words, becomes changes they pick from. */
  app.post(`${base}/learn`, async (request) => {
    const company = await companyOf(platform, request);
    viewerOf(request);
    const body = z.object({ text: z.string().trim().min(3).max(10_000), about: z.string().optional() }).parse(request.body);
    return proposeLearning(platform.brain, platform.llm, company.id, body.text, body.about);
  });

  app.post(`${base}/learn/apply`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z.object({ changes: z.array(LearnChange).min(1).max(50) }).parse(request.body);
    return applyLearning(platform.brain, company.id, body.changes, { name: viewer.name, email: viewer.email, mayEdit: editor(viewer) });
  });

  /** How a database's tables can be read: through which connections, or its demo. */
  app.get(`${base}/entities/:id/read-tables`, async (request) => {
    const company = await companyOf(platform, request);
    requireEditor(request);
    const { id } = request.params as { id: string };
    return platform.brainCatalog.readOptions(company.id, id);
  });

  /** Reads a database's tables and views into the brain (only the catalog, never a row of data). */
  app.post(`${base}/entities/:id/read-tables`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    const { id } = request.params as { id: string };
    const body = z.object({ connectionId: z.string().uuid().optional(), schema: z.string().trim().max(128).optional() }).parse(request.body ?? {});
    return platform.brainCatalog.readTables(company.id, id, { ...body, actor: actorOf(viewer) });
  });

  /** Where a report's, data set's or table's data comes from, and what is built on it. */
  app.get(`${base}/entities/:id/lineage`, async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    return platform.brain.lineage(company.id, id);
  });

  /** Business names and definitions for a table's columns, for the person to review; nothing is kept yet. */
  app.post(`${base}/entities/:id/suggest-definitions`, async (request) => {
    const company = await companyOf(platform, request);
    requireEditor(request);
    const { id } = request.params as { id: string };
    const body = z.object({ all: z.boolean().optional() }).parse(request.body ?? {});
    return suggestDefinitions(platform.brain, platform.llm, company.id, id, body);
  });

  /** What people say a table's columns mean, by column name; the columns' types and keys stay as the database has them. */
  app.post(`${base}/entities/:id/definitions`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireEditor(request);
    const { id } = request.params as { id: string };
    return platform.brain.defineColumns(company.id, id, ColumnDefinitions.parse(request.body), actorOf(viewer));
  });

  /**
   * A thing's picture (a report's screenshot), as an image: what the brain keeps, an uploaded file,
   * or a link. Served so it can never run as a page of the app.
   */
  app.get(`${base}/entities/:id/pictures/:field/:index`, async (request, reply) => {
    const company = await companyOf(platform, request);
    const { id, field, index } = z.object({ id: z.string(), field: z.string().max(60), index: z.coerce.number().int().min(0).max(100) }).parse(request.params);
    const thing = await platform.brain.get(company.id, id);
    const kind = brainKind(thing.kind);
    if (kind?.fields.find((f) => f.key === field)?.type !== "images") throw new HttpError(404, "No such picture");
    const picture = (thing.data[field] as BrainImage[] | undefined)?.[index];
    if (!picture) throw new HttpError(404, "No such picture");
    reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header("cache-control", "private, max-age=300");
    if (picture.file) {
      const file = await platform.files.get(company.id, picture.file).catch(() => {
        throw new HttpError(404, "No such picture");
      });
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mimeType)) throw new HttpError(415, "Not a picture");
      return reply.header("content-type", file.mimeType).send(file.data);
    }
    const data = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(picture.src ?? "");
    if (data) return reply.header("content-type", data[1]!).send(Buffer.from(data[2]!, "base64"));
    if (picture.src?.startsWith("https://")) return reply.redirect(picture.src);
    throw new HttpError(404, "No such picture");
  });

  app.get(`${base}/sources`, async (request) => {
    const company = await companyOf(platform, request);
    return platform.brainSources.list(company.id);
  });

  app.post(`${base}/sources/sync-all`, async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const results = await platform.brainSources.syncAll(company.id);
    return { results, sources: await platform.brainSources.list(company.id) };
  });

  app.post(`${base}/sources/:key/:action`, async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const { key, action } = z.object({ key: z.string().min(1).max(40), action: z.enum(["connect", "disconnect", "sync"]) }).parse(request.params);
    const result =
      action === "sync"
        ? await platform.brainSources.sync(company.id, key)
        : action === "connect"
          ? await platform.brainSources.connect(company.id, key)
          : await platform.brainSources.disconnect(company.id, key);
    return { result: result ?? null, sources: await platform.brainSources.list(company.id) };
  });
}
