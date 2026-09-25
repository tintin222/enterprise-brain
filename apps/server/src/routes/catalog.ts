import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchCatalog } from "@enterprise-brain/catalog";
import { actorOf, requireAdmin, requireAnyManager } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

export async function catalogRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const catalog = () => platform.catalog.catalog;

  app.get("/api/catalog", async () => {
    const c = catalog();
    return {
      departments: c.departments,
      processes: c.processes,
      agents: c.agents.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        title: a.title,
        summary: a.summary,
        department: a.department,
        process: a.process,
        archetype: a.archetype,
        capabilities: a.capabilities,
        triggers: a.triggers,
        connectors: a.connectors,
        tags: a.tags,
        steps: a.workflow.length,
      })),
      useCases: c.useCases,
    };
  });

  app.get("/api/catalog/search", async (request) => {
    const { q } = z.object({ q: z.string().min(1) }).parse(request.query);
    return searchCatalog(catalog(), q).slice(0, 10);
  });

  app.get("/api/catalog/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    const template = catalog().agents.find((a) => a.id === id || a.slug === id);
    if (!template) throw new HttpError(404, `Agent template "${id}" not found`);
    return template;
  });

  app.post("/api/companies/:company/catalog/departments/:department/install", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAdmin(request);
    const { department } = request.params as { department: string };
    const body = z.object({ processes: z.array(z.string()).optional(), activate: z.boolean().optional() }).parse(request.body ?? {});
    const result = await platform.catalog.installDepartment(company.id, department, { ...body, actor: actorOf(viewer) });
    await platform.employment.assignDefaultManagers(company.id, { by: viewer.userId, agentIds: result.agents.map((a) => a.row.id) });
    return { department: result.department, processes: result.processes, agents: result.agents.map((a) => a.row) };
  });

  app.post("/api/companies/:company/catalog/agents/:template/install", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { template } = request.params as { template: string };
    const body = z.object({ activate: z.boolean().optional() }).parse(request.body ?? {});
    const agent = await platform.catalog.installAgentTemplate(company.id, template, { ...body, actor: actorOf(viewer) });
    await platform.employment.assignDefaultManagers(company.id, { by: viewer.userId, agentIds: [agent.row.id] });
    return (await platform.agents.get(company.id, agent.row.id)).row;
  });

  app.post("/api/companies/:company/catalog/use-cases/:useCase/install", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { useCase } = request.params as { useCase: string };
    const result = await platform.catalog.installUseCase(company.id, useCase, { actor: actorOf(viewer) });
    if (result.agent) await platform.employment.assignDefaultManagers(company.id, { by: viewer.userId, agentIds: [result.agent.row.id] });
    return { useCase: result.useCase, agent: result.agent?.row ?? null };
  });

  /** Installed departments with their processes and agents (the company's operating model). */
  app.get("/api/companies/:company/departments", async (request) => {
    const company = await companyOf(platform, request);
    const [departments, processes, agentRecords] = await Promise.all([
      platform.catalog.departments(company.id),
      platform.catalog.processes(company.id),
      platform.agents.list(company.id),
    ]);
    return departments.map((d) => ({
      ...d,
      processes: processes.filter((p) => p.departmentId === d.id),
      agents: agentRecords
        .filter((a) => a.row.departmentId === d.id)
        .map((a) => ({ id: a.row.id, slug: a.row.slug, name: a.row.name, status: a.row.status, archetype: a.row.archetype, processId: a.row.processId, source: a.row.source })),
    }));
  });
}
