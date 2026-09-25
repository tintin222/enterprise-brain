import { and, count, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents, approvals, builderSessions, departments, knowledgeDocuments, runs } from "@enterprise-brain/db";
import type { AppContext } from "../context.ts";
import { requireAdmin, viewerOf } from "../auth/viewer.ts";
import { HttpError, companyOf } from "../http.ts";

export const VERSION = "0.1.0";

export async function coreRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, config } = ctx;

  app.get("/api/health", async () => ({ ok: true, version: VERSION }));

  app.get("/api/info", async () => ({
    name: "Enterprise Brain",
    version: VERSION,
    llm: { available: platform.llm.available, provider: platform.llm.provider, model: platform.llm.model },
    embeddings: { model: platform.embedder.model },
    database: platform.handle.kind,
    defaultCompany: config.defaultCompany.slug,
    publicUrl: config.publicUrl,
    /** Legacy: open mode protected by EB_API_KEY (the console asks for the key). */
    authRequired: Boolean(config.apiKey) && (config.auth?.mode ?? "open") === "open",
    auth: { mode: config.auth?.mode ?? "open" },
    paperclip: { configured: Boolean(config.paperclip), url: config.paperclip?.url ?? null },
  }));

  app.get("/api/companies", async (request) => {
    const viewer = viewerOf(request);
    const all = await platform.companies();
    return viewer.companyId ? all.filter((c) => c.id === viewer.companyId) : all;
  });

  app.post("/api/companies", async (request) => {
    if (viewerOf(request).kind === "session") throw new HttpError(403, "Each installation holds one company");
    const body = z
      .object({ name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]+$/), mailDomain: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i).optional() })
      .parse(request.body);
    return platform.ensureCompany({ name: body.name, slug: body.slug, settings: body.mailDomain ? { mailDomain: body.mailDomain } : {} });
  });

  app.get("/api/companies/:company/dashboard", async (request) => {
    const company = await companyOf(platform, request);
    const db = platform.handle.db;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [agentCounts] = await db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${agents.status} = 'active')::int` })
      .from(agents)
      .where(eq(agents.companyId, company.id));
    const [runCounts] = await db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`,
      })
      .from(runs)
      .where(and(eq(runs.companyId, company.id), gte(runs.createdAt, since)));
    const [cost] = await db
      .select({ usd: sql<number>`coalesce(sum((${runs.usage}->>'costUsd')::numeric), 0)::float` })
      .from(runs)
      .where(and(eq(runs.companyId, company.id), gte(runs.createdAt, monthStart)));
    const [pending] = await db
      .select({ n: count() })
      .from(approvals)
      .where(and(eq(approvals.companyId, company.id), eq(approvals.status, "pending")));
    const [deptCount] = await db.select({ n: count() }).from(departments).where(eq(departments.companyId, company.id));
    const [docCount] = await db.select({ n: count() }).from(knowledgeDocuments).where(eq(knowledgeDocuments.companyId, company.id));
    const [sessions] = await db
      .select({ n: count() })
      .from(builderSessions)
      .where(and(eq(builderSessions.companyId, company.id), sql`${builderSessions.status} not in ('deployed', 'archived')`));
    const recentRuns = await platform.engine.list(company.id, { limit: 10 });
    const agentRows = new Map((await platform.agents.list(company.id)).map((a) => [a.row.id, a.row]));
    return {
      company,
      counts: {
        agents: agentCounts?.total ?? 0,
        activeAgents: agentCounts?.active ?? 0,
        runs24h: runCounts?.total ?? 0,
        succeeded24h: runCounts?.succeeded ?? 0,
        failed24h: runCounts?.failed ?? 0,
        pendingApprovals: pending?.n ?? 0,
        departments: deptCount?.n ?? 0,
        knowledgeDocuments: docCount?.n ?? 0,
        openBuilderSessions: sessions?.n ?? 0,
      },
      costMonthUsd: Math.round((cost?.usd ?? 0) * 100) / 100,
      recentRuns: recentRuns.map((r) => ({ ...r, agentName: agentRows.get(r.agentId)?.name ?? "Agent", agentSlug: agentRows.get(r.agentId)?.slug ?? null, context: undefined })),
      recentActivity: await platform.activity.list(company.id, 15),
    };
  });

  app.get("/api/companies/:company/activity", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const { limit } = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(request.query);
    return platform.activity.list(company.id, limit);
  });
}
