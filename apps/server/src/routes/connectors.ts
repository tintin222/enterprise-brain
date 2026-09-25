import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { actionsFromExamples, actionsFromOpenApi } from "@enterprise-brain/connectors";
import { actorOf, requireAdmin } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  app.get("/api/connectors/catalog", async () => platform.connectors.catalog());

  app.get("/api/companies/:company/connectors", async (request) => {
    const company = await companyOf(platform, request);
    return platform.connectors.list(company.id);
  });

  app.post("/api/companies/:company/connectors", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const body = z.object({ type: z.string(), name: z.string().optional(), values: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const instance = await platform.connectors.create(company.id, body);
    await platform.activity.record(company.id, { actor: "user", action: "connector.created", entityType: "connector", entityId: instance.id, summary: `Connected ${instance.name}` });
    return instance;
  });

  app.put("/api/companies/:company/connectors/:id", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().optional(), values: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    return platform.connectors.update(company.id, id, body);
  });

  app.delete("/api/companies/:company/connectors/:id", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { id } = request.params as { id: string };
    await platform.connectors.remove(company.id, id);
    await platform.activity.record(company.id, { actor: "user", action: "connector.removed", entityType: "connector", entityId: id, summary: "Removed a connector" });
    return { ok: true };
  });

  app.post("/api/companies/:company/connectors/:id/test", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { id } = request.params as { id: string };
    return platform.connectors.test(company.id, id);
  });

  /** Execute an operation against a connector type (explore sandbox data, verify a live integration). */
  app.post("/api/companies/:company/connectors/types/:type/operations/:operation", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { type, operation } = request.params as { type: string; operation: string };
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}) }).parse(request.body ?? {});
    const result = await platform.connectors.executeByType(company.id, type, operation, body.input);
    const op = platform.connectors.registry.get(type)?.manifest.operations.find((o) => o.id === operation);
    if (op?.kind === "write") {
      await platform.activity.record(company.id, { actor: "user", action: "connector.write", entityType: "connector", entityId: type, summary: `${type}: ${operation}`, data: { input: body.input } });
    }
    return { result };
  });

  /** What each watcher saw last: connected mailboxes and the systems AI employees watch. */
  app.get("/api/companies/:company/watchers", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const instances = new Map((await platform.connectors.list(company.id)).map((i) => [i.id, i]));
    return (await platform.watchers.status(company.id)).map((w) => ({
      connection: instances.get(w.connectorInstanceId)?.name ?? w.connectorInstanceId,
      connectionId: w.connectorInstanceId,
      watching: w.key.split("#")[0],
      lastPolledAt: w.lastPolledAt,
      lastCount: w.lastCount,
      lastError: w.lastError,
    }));
  });

  /** Check connected mailboxes and systems now (they are also checked every minute). */
  app.post("/api/companies/:company/watchers/poll", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    return platform.watchers.pollCompany(company.id);
  });

  // -------------------------------------------------------------------------
  // Named actions: what AI employees may do in a web service or database
  // -------------------------------------------------------------------------

  app.get("/api/companies/:company/connectors/:id/actions", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const instance = await platform.connectors.get(company.id, id);
    const supports = Boolean(platform.connectors.registry.get(instance.type)?.runAction);
    return { supports, actions: platform.connectors.actionsOf(instance.config) };
  });

  app.put("/api/companies/:company/connectors/:id/actions", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = z.object({ actions: z.array(z.unknown()) }).parse(request.body);
    const saved = await platform.connectors.setActions(company.id, id, body.actions);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "connector.actions",
      entityType: "connector",
      entityId: id,
      summary: `Saved ${body.actions.length} action${body.actions.length === 1 ? "" : "s"} of ${saved.name}`,
    });
    return { actions: platform.connectors.actionsOf(saved.config) };
  });

  /** Propose actions from an OpenAPI/Swagger description (a document, JSON/YAML text or a link) or from example calls. */
  app.post("/api/companies/:company/connectors/:id/actions/import", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { id } = request.params as { id: string };
    await platform.connectors.get(company.id, id);
    const body = z.object({ openapi: z.unknown().optional(), url: z.string().url().optional(), examples: z.string().optional() }).parse(request.body);
    if (body.examples) return actionsFromExamples(body.examples);
    let doc = body.openapi;
    if (body.url) {
      const response = await fetch(body.url, { headers: { accept: "application/json, application/yaml, text/yaml, */*" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new HttpError(400, `The description could not be loaded (HTTP ${response.status})`);
      doc = await response.text();
    }
    if (typeof doc === "string") {
      try {
        doc = doc.trim().startsWith("{") ? JSON.parse(doc) : parseYaml(doc);
      } catch (error) {
        throw new HttpError(400, `This is not valid JSON or YAML: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (doc === undefined) throw new HttpError(400, "Give an OpenAPI description (document or link), or example calls");
    return actionsFromOpenApi(doc);
  });

  /** Try an action with sample values. A write action changes the system, so it needs confirm: true. */
  app.post("/api/companies/:company/connectors/:id/actions/:action/test", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { id, action } = request.params as { id: string; action: string };
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}), confirm: z.boolean().optional() }).parse(request.body ?? {});
    const instance = await platform.connectors.get(company.id, id);
    const named = platform.connectors.actionsOf(instance.config).find((a) => a.id === action);
    if (!named) throw new HttpError(404, `${instance.name} has no action "${action}"`);
    if (named.kind === "write" && !body.confirm) throw new HttpError(400, `${named.name} changes data in ${instance.name}: confirm to run it`);
    const started = Date.now();
    const result = await platform.connectors.executeInstance(company.id, id, action, body.input);
    await platform.activity.record(company.id, { actor: actorOf(viewer), action: "connector.action_tested", entityType: "connector", entityId: id, summary: `Tried ${named.name} on ${instance.name}` });
    return { ok: true, durationMs: Date.now() - started, result };
  });
}
