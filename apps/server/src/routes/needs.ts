import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { understandNeed, type NeedMaterials, type UnderstoodNeed } from "@enterprise-brain/builder";
import { describeDuties, describeRepeat, NEED_KINDS, RepeatSchedule } from "@enterprise-brain/core";
import type { RecurringWorkView } from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";
import { canUseApp } from "./apps.ts";
import { canSeeTable } from "./tables.ts";

const TARGET_WORDS = { table: "the table", app: "the app", calculation: "the calculation", agent: "" } as const;

/** What will happen, in one sentence. */
function summaryOf(need: UnderstoodNeed, agentName: string | undefined): string {
  const who = agentName ?? "An AI employee";
  switch (need.kind) {
    case "task":
      return `${who} does it now, as a task you can follow`;
    case "recurring":
      return `${who} does it ${need.schedule ? describeRepeat(need.schedule) : "regularly"}, each time as a task for you`;
    case "answer":
      return "Answered from the company's knowledge";
    case "calculation":
      return need.schedule ? `Worked out on your tables now, and again ${describeRepeat(need.schedule)}` : "Worked out on your tables now";
    case "table":
      return "A new table: you see its fields before it is made";
    case "app":
      return "A new app with its table: you see its pages before it is made";
    case "ai-employee":
      return "A new AI employee: the Studio asks you what it needs to know, and it is tried before it works";
    case "change":
      return `A change to ${[TARGET_WORDS[need.target!.type], need.target!.name].filter(Boolean).join(" ")}: you see it before it is made`;
    case "unclear":
      return need.question ?? "What should happen?";
  }
}

/**
 * The one box ("What do you need?") and the recurring work it makes. The box only says what it
 * understood; the person says go, and the usual endpoints do it with their own checks.
 */
export async function needRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** What the viewer sees: who can do work, and what there is to change. */
  const materialsOf = async (viewer: Viewer, companyId: string) => {
    const [agents, tables, apps, calculations] = await Promise.all([
      platform.agents.list(companyId),
      platform.tables.list(companyId),
      platform.apps.list(companyId),
      platform.calculations.list(companyId),
    ]);
    return {
      agents: agents.filter((a) => a.row.status !== "archived" && canSeeDepartment(viewer, a.row.departmentId)),
      tables: tables.filter((t) => canSeeTable(viewer, t)),
      apps: apps.filter((a) => canUseApp(viewer, a)),
      calculations: calculations.filter((c) => canSeeDepartment(viewer, c.departmentId)),
    };
  };

  app.post("/api/companies/:company/needs", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z.object({ text: z.string().trim().min(3).max(4000), as: z.enum(NEED_KINDS).optional() }).parse(request.body);
    const found = await materialsOf(viewer, company.id);
    const workers = found.agents.filter((a) => a.row.status === "active" || a.row.status === "testing");
    const materials: NeedMaterials = {
      agents: workers.map((a) => ({
        slug: a.row.slug,
        name: a.definition.name,
        summary: a.definition.summary,
        duties: describeDuties(a.definition.triggers).map((d) => d.text),
      })),
      tables: found.tables.map((t) => ({ key: t.key, name: t.name, fields: t.fields.map((f) => ({ key: f.key, label: f.label })) })),
      apps: found.apps.map((a) => ({ key: a.key, name: a.name })),
      calculations: found.calculations.map((c) => ({ key: c.key, name: c.name, rule: c.rule })),
    };
    const need = await understandNeed(platform.llm, { text: body.text, ...(body.as ? { as: body.as } : {}), materials });
    const agent = need.agent ? workers.find((a) => a.row.slug === need.agent) : undefined;
    const departmentOf = (target: NonNullable<UnderstoodNeed["target"]>): string | null | undefined =>
      target.type === "table"
        ? found.tables.find((t) => t.key === target.key)?.departmentId
        : target.type === "app"
          ? found.apps.find((a) => a.key === target.key)?.departmentId
          : target.type === "calculation"
            ? found.calculations.find((c) => c.key === target.key)?.departmentId
            : found.agents.find((a) => a.row.slug === target.key)?.row.departmentId;
    return {
      ...need,
      summary: summaryOf(need, agent?.definition.name),
      when: need.schedule ? describeRepeat(need.schedule) : null,
      agentName: agent?.definition.name ?? null,
      /** Who can do the work: to choose another. */
      workers: workers.map((a) => ({ slug: a.row.slug, name: a.definition.name, status: a.row.status })),
      can: {
        /** Tables, apps, calculations and AI employees are made by managers (and admins). */
        build: viewer.isAdmin || viewer.departments.some((d) => d.role === "manager"),
        change: need.target ? canManageDepartment(viewer, departmentOf(need.target) ?? null) : false,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Recurring work
  // -------------------------------------------------------------------------

  const withAgent = async (companyId: string, list: RecurringWorkView[]) => {
    const agents = new Map((await platform.agents.list(companyId)).map((a) => [a.row.id, a]));
    return list.map((r) => {
      const agent = agents.get(r.agentId);
      return { ...r, agent: agent ? { slug: agent.row.slug, name: agent.definition.name, status: agent.row.status } : null };
    });
  };
  const recurringFor = async (request: FastifyRequest, companyId: string, id: string) => {
    const viewer = viewerOf(request);
    const found = await platform.recurring.get(companyId, id);
    const agent = await platform.agents.get(companyId, found.agentId);
    const own = viewer.userId !== null && found.userId === viewer.userId;
    if (!own && !canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, "There is no such recurring work");
    return { found, agent, own };
  };

  /** The viewer's own recurring work; with `agent`, everything that AI employee does regularly for people. */
  app.get("/api/companies/:company/recurring", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { agent: ref, stopped } = z.object({ agent: z.string().optional(), stopped: z.enum(["true", "false"]).optional() }).parse(request.query ?? {});
    if (ref) {
      const agent = await platform.agents.get(company.id, ref);
      if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${ref}" not found`);
      return withAgent(company.id, await platform.recurring.list(company.id, { agentId: agent.row.id, stopped: stopped === "true" }));
    }
    return withAgent(
      company.id,
      await platform.recurring.list(company.id, { ...(viewer.userId ? { userId: viewer.userId } : {}), stopped: stopped === "true" }),
    );
  });

  /** Ask an AI employee of your department to do something regularly. */
  app.post("/api/companies/:company/recurring", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z.object({ agent: z.string(), text: z.string().trim().min(3).max(2000), schedule: RepeatSchedule }).parse(request.body);
    const agent = await platform.agents.get(company.id, body.agent);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${body.agent}" not found`);
    const made = await platform.recurring.create(company.id, {
      agentId: agent.row.id,
      text: body.text,
      schedule: body.schedule,
      userId: viewer.userId,
      by: viewer.name,
    });
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "recurring.created",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `${viewer.name} asked ${agent.definition.name} to do this ${made.when}: ${made.text}`,
    });
    return (await withAgent(company.id, [made]))[0];
  });

  /** Stop it: the person who asked, the AI employee's managers, admins. */
  app.post("/api/companies/:company/recurring/:id/stop", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { id } = request.params as { id: string };
    const { found, agent, own } = await recurringFor(request, company.id, id);
    if (!own && !canManageDepartment(viewer, agent.row.departmentId))
      throw new HttpError(403, `Only ${found.by} or a manager of ${agent.definition.name} stops it`);
    const stopped = await platform.recurring.stop(company.id, id, viewer.name);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "recurring.stopped",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `${viewer.name} stopped ${agent.definition.name}'s recurring work: ${found.text}`,
    });
    return (await withAgent(company.id, [stopped]))[0];
  });
}
