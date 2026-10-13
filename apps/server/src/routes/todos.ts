import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TODO_STATUSES, type TodoRow } from "@enterprise-brain/runtime";
import { actorOfViewer } from "../auth/conversations.ts";
import { requirePerson } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

export interface TodoProjectRef {
  id: string;
  slug: string;
  name: string;
}

/** A to-do as the pages show it. */
export interface TodoView {
  id: string;
  title: string;
  details: string;
  dueAt: Date | null;
  status: string;
  source: string;
  sourceRef: string | null;
  link: string | null;
  data: Record<string, unknown>;
  project: TodoProjectRef | null;
  createdAt: Date;
  doneAt: Date | null;
}

export function todoView(row: TodoRow, project: TodoProjectRef | null): TodoView {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    dueAt: row.dueAt,
    status: row.status,
    source: row.source,
    sourceRef: row.sourceRef,
    link: row.link,
    data: row.data,
    project,
    createdAt: row.createdAt,
    doneAt: row.doneAt,
  };
}

/** A due date as the pages send it: a day ("2026-10-20") or a moment; nothing clears it. */
export function parseDue(value: string | null | undefined): Date | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const text = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T17:00:00`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "That is not a date");
  return date;
}

const TodoBody = z.object({
  title: z.string().trim().min(1).max(300),
  details: z.string().max(4000).optional(),
  dueAt: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  details: z.string().max(4000).optional(),
  dueAt: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
  status: z.enum(TODO_STATUSES).optional(),
});

/**
 * A person's own to-dos: what they must do themselves, from their mail, from projects, from the Studio
 * or written by hand. Always the signed-in person's; nobody sees another's.
 */
export async function todoRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const base = "/api/companies/:company/todos";

  /** Names the projects to-dos belong to, once per request. */
  const projectsNamed = async (companyId: string, rows: TodoRow[]): Promise<Map<string, TodoProjectRef>> => {
    const ids = [...new Set(rows.map((r) => r.projectId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return new Map();
    const projects = await platform.projects.list(companyId);
    return new Map(projects.filter((p) => ids.includes(p.id)).map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
  };

  app.get(base, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const query = z.object({ status: z.enum([...TODO_STATUSES, "all"]).default("open"), project: z.string().uuid().optional() }).parse(request.query);
    const rows = await platform.todos.listFor(company.id, viewer.userId, { status: query.status, projectId: query.project });
    const named = await projectsNamed(company.id, rows);
    return rows.map((row) => todoView(row, row.projectId ? (named.get(row.projectId) ?? null) : null));
  });

  app.post(base, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const body = TodoBody.parse(request.body);
    const project = body.projectId ? await platform.projects.get(company.id, body.projectId) : undefined;
    const { todo } = await platform.todos.add(
      company.id,
      { userId: viewer.userId, projectId: project?.id ?? null, title: body.title, details: body.details, dueAt: parseDue(body.dueAt), source: "manual" },
      actorOfViewer(viewer),
    );
    return todoView(todo, project ? { id: project.id, slug: project.slug, name: project.name } : null);
  });

  app.patch(`${base}/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const { id } = request.params as { id: string };
    const body = PatchBody.parse(request.body);
    if (body.projectId) await platform.projects.get(company.id, body.projectId);
    const todo = await platform.todos.update(company.id, id, viewer.userId, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.details !== undefined ? { details: body.details } : {}),
      ...(body.dueAt !== undefined ? { dueAt: parseDue(body.dueAt) } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    const named = await projectsNamed(company.id, [todo]);
    return todoView(todo, todo.projectId ? (named.get(todo.projectId) ?? null) : null);
  });

  app.delete(`${base}/:id`, async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requirePerson(request);
    const { id } = request.params as { id: string };
    await platform.todos.remove(company.id, id, viewer.userId);
    return { removed: true };
  });
}
