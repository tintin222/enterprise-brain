import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { companyOf } from "../http.ts";

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
}
