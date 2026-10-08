import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CONVERSATION_KINDS, plainText, type Actor, type Mention, type MentionKind } from "@enterprise-brain/core";
import {
  COMPANY_BRAIN_SLUG,
  OPEN_TASK_STATUSES,
  agentActor,
  type ConversationEvent,
  type ConversationRow,
  type MessageRow,
  type ParticipantRow,
  type QueueEntry,
} from "@enterprise-brain/runtime";
import { actorOfViewer, canInvite, readerOf, requireConversation } from "../auth/conversations.ts";
import { canHandleWork, canSeeDepartment, isForViewer, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, sse } from "../http.ts";
import { checkMentions, mentionHref, type MentionHit } from "../mentions.ts";
import { canSeeTable } from "./tables.ts";

const MENTION_KINDS: MentionKind[] = ["person", "ai_employee", "thing", "table", "app", "calculation", "file", "document", "task"];

/**
 * Conversations: people and AI employees in one thread, with "@" mentions of people
 * and assets. What is posted here is heard by the turn planner, which decides which AI employee answers.
 */
export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** A conversation the viewer may open (404 otherwise). */
  const open = async (request: FastifyRequest, companyId: string, id: string) => {
    const found = await platform.conversations.get(companyId, id);
    requireConversation(viewerOf(request), found.conversation, found.participants);
    return found;
  };

  /** The names and pages behind an AI employee, for chips. */
  const agentsById = async (companyId: string) => new Map((await platform.agents.list(companyId, { includeSystem: true })).map((a) => [a.row.id, a]));

  /** A message as the page shows it: chips with links, files with names, cards as live work entries. */
  const messageViews = async (viewer: Viewer, companySlug: string, companyId: string, rows: MessageRow[]) => {
    const agents = await agentsById(companyId);
    const people = new Map((await platform.people.list(companyId)).map((p) => [p.id, p]));
    const files = new Map<string, { id: string; name: string; mimeType: string; size: number } | null>();
    const fileOf = async (id: string) => {
      if (!files.has(id)) {
        const meta = await platform.files.meta(companyId, id).catch(() => undefined);
        files.set(id, meta ? { id: meta.id, name: meta.name, mimeType: meta.mimeType, size: meta.size } : null);
      }
      return files.get(id);
    };
    const tasks = new Map<string, { id: string; ref: string; title: string; status: string } | null>();
    const taskOf = async (id: string | null) => {
      if (!id) return null;
      if (!tasks.has(id)) {
        const task = await platform.tasks.byId(id);
        tasks.set(id, task ? { id: task.id, ref: task.ref, title: task.title, status: task.status } : null);
      }
      return tasks.get(id) ?? null;
    };
    const cardOf = async (card: { type: string; id: string }) => {
      const entry = await platform.queue.entry(companyId, card.type as QueueEntry["type"], card.id);
      if (!entry) return null;
      const assignee = entry.assigneeUserId ? people.get(entry.assigneeUserId) : undefined;
      return {
        type: entry.type,
        id: entry.id,
        title: entry.title,
        details: entry.details,
        reason: entry.reason,
        suggestion: entry.suggestion,
        options: entry.options,
        action: entry.action,
        task: entry.task ? { ...entry.task } : await taskOf(null),
        agent: entry.agent ? { id: entry.agent.id, slug: entry.agent.slug, name: entry.agent.name } : null,
        departmentId: entry.departmentId,
        assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        forMe:
          isForViewer(viewer, entry.departmentId, entry.assigneeUserId) ||
          (entry.agent?.managerUserId !== null && entry.agent?.managerUserId === viewer.userId),
        canHandle: canHandleWork(viewer, entry.departmentId, entry.assigneeUserId),
        status: entry.status,
        resolvedBy: entry.resolvedBy,
        createdAt: entry.createdAt,
      };
    };
    const views = [];
    for (const row of rows) {
      const mentions = row.mentions.map((m) => ({
        ...m,
        href: m.allowed ? mentionHref(companySlug, m as Mention, { slug: m.kind === "ai_employee" ? agents.get(m.id)?.row.slug : undefined }) : null,
      }));
      const attachments = (await Promise.all(row.fileIds.map(fileOf))).filter(Boolean);
      views.push({
        ...row,
        mentions,
        files: attachments,
        card: row.card ? await cardOf(row.card) : null,
        plain: plainText(row.text),
      });
    }
    return views;
  };

  /** The page a conversation is about: its task, its AI employee, or its thing in the brain. */
  const aboutOf = async (companyId: string, conversation: ConversationRow): Promise<{ href: string; label: string } | null> => {
    if (!conversation.aboutId) return null;
    try {
      switch (conversation.kind) {
        case "task": {
          const task = await platform.tasks.byId(conversation.aboutId);
          return task ? { href: `/work/${encodeURIComponent(task.ref)}`, label: task.ref } : null;
        }
        case "ai_employee": {
          const agent = await platform.agents.find(companyId, conversation.aboutId);
          if (!agent || (agent.row.slug === COMPANY_BRAIN_SLUG && agent.row.source === "system")) return null;
          return { href: `/ai/${agent.row.slug}`, label: agent.definition.name };
        }
        case "thing": {
          const thing = await platform.brain.get(companyId, conversation.aboutId);
          return { href: `/brain/e/${thing.id}`, label: thing.name };
        }
        case "studio":
          return { href: `/studio/${conversation.aboutId}`, label: "Studio" };
        default:
          return null;
      }
    } catch {
      return null;
    }
  };

  const conversationView = async (viewer: Viewer, companyId: string, conversation: ConversationRow, participants: ParticipantRow[]) => {
    const me = actorOfViewer(viewer);
    return {
      conversation,
      participants,
      me: participants.find((p) => p.actorKind === me.kind && p.actorId === me.id) ?? null,
      canInvite: canInvite(viewer, conversation, participants),
      about: await aboutOf(companyId, conversation),
    };
  };

  app.get("/api/companies/:company/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({
        scope: z.enum(["mine", "department", "all"]).optional(),
        kind: z.enum(CONVERSATION_KINDS).optional(),
        unread: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    const viewer = viewerOf(request);
    return platform.conversations.list(company.id, readerOf(viewer), {
      scope: query.scope,
      kind: query.kind,
      unreadOnly: query.unread === "1",
      limit: query.limit,
    });
  });

  /** A topic: the first message makes it; its title is the first line. */
  app.post("/api/companies/:company/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z
      .object({
        title: z.string().max(200).optional(),
        text: z.string().max(20_000).optional(),
        fileIds: z.array(z.string()).max(20).optional(),
        participants: z
          .array(z.object({ kind: z.enum(["person", "ai_employee"]), id: z.string() }))
          .max(50)
          .optional(),
        visibility: z.enum(["participants", "department", "company"]).optional(),
        departmentId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body ?? {});
    if (body.visibility === "department") {
      if (!body.departmentId || !canSeeDepartment(viewer, body.departmentId))
        throw new HttpError(400, "Choose one of your departments for a department conversation");
    }
    const me = actorOfViewer(viewer);
    const participants: Actor[] = [];
    for (const p of body.participants ?? []) {
      if (p.kind === "person") {
        const person = await platform.people.get(company.id, p.id).catch(() => undefined);
        if (person && person.status === "active") participants.push({ kind: "person", id: person.id, name: person.name });
      } else {
        const agent = await platform.agents.find(company.id, p.id);
        if (agent && canSeeDepartment(viewer, agent.row.departmentId)) participants.push(agentActor(agent));
      }
    }
    const created = await platform.conversations.create(company.id, {
      kind: "topic",
      title: body.title,
      visibility: body.visibility ?? "participants",
      departmentId: body.visibility === "department" ? body.departmentId : null,
      createdBy: me,
      participants,
    });
    if (body.text?.trim()) {
      const mentions = await checkMentions(platform, viewer, company.id, body.text);
      await platform.conversations.post(company.id, created.conversation.id, { author: me, text: body.text, mentions, fileIds: body.fileIds });
    }
    const found = await platform.conversations.get(company.id, created.conversation.id);
    return conversationView(viewer, company.id, found.conversation, found.participants);
  });

  /** The conversation about a task, a thing, or my talk with an AI employee (made on first use). */
  app.get("/api/companies/:company/conversations/for/:kind/:about", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { kind, about } = z.object({ kind: z.enum(["task", "thing", "ai_employee"]), about: z.string().min(1) }).parse(request.params);
    let found;
    if (kind === "task") {
      const task = await platform.tasks.get(company.id, about);
      const agent = await platform.agents.find(company.id, task.agentId);
      if (!canSeeDepartment(viewer, agent?.row.departmentId)) throw new HttpError(404, `Task ${about} not found`);
      found = await platform.conversations.forTask(company.id, task);
    } else if (kind === "thing") {
      const thing = await platform.brain.get(company.id, about);
      found = await platform.conversations.forThing(company.id, { id: thing.id, name: thing.name });
    } else {
      const agent = await platform.agents.get(company.id, about);
      if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `AI employee "${about}" not found`);
      const me = actorOfViewer(viewer);
      if (me.kind === "system") throw new HttpError(400, "Sign in to talk with an AI employee");
      found = await platform.conversations.talkWith(company.id, agent, me);
    }
    return conversationView(viewer, company.id, found.conversation, found.participants);
  });

  app.get("/api/companies/:company/conversations/:id", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const found = await open(request, company.id, id);
    return conversationView(viewerOf(request), company.id, found.conversation, found.participants);
  });

  app.get("/api/companies/:company/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const query = z
      .object({
        before: z.coerce.number().int().optional(),
        after: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);
    await open(request, company.id, id);
    const rows = await platform.conversations.messages(company.id, id, { beforeSeq: query.before, afterSeq: query.after, limit: query.limit });
    return messageViews(viewerOf(request), company.slug, company.id, rows);
  });

  app.post("/api/companies/:company/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const body = z
      .object({ text: z.string().max(20_000), fileIds: z.array(z.string()).max(20).optional(), replyToId: z.string().uuid().nullable().optional() })
      .parse(request.body);
    if (!body.text.trim() && !body.fileIds?.length) throw new HttpError(400, "Write something, or attach a file");
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (found.conversation.status !== "open") throw new HttpError(409, "This conversation is archived");
    const mentions = await checkMentions(platform, viewer, company.id, body.text);
    const message = await platform.conversations.post(company.id, id, {
      author: actorOfViewer(viewer),
      text: body.text,
      mentions,
      fileIds: body.fileIds,
      replyToId: body.replyToId ?? null,
    });
    return (await messageViews(viewer, company.slug, company.id, [message]))[0];
  });

  app.post("/api/companies/:company/conversations/:id/read", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { seq } = z.object({ seq: z.number().int().min(0) }).parse(request.body);
    const viewer = viewerOf(request);
    await open(request, company.id, id);
    const me = actorOfViewer(viewer);
    if (me.kind !== "system") await platform.conversations.markRead(id, me, seq);
    return { ok: true };
  });

  /** Bring a person or an AI employee in. */
  app.post("/api/companies/:company/conversations/:id/participants", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const body = z.object({ kind: z.enum(["person", "ai_employee"]), id: z.string().min(1) }).parse(request.body);
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (
      !canInvite(viewer, found.conversation, found.participants) &&
      !found.participants.some((p) => p.actorKind === actorOfViewer(viewer).kind && p.actorId === actorOfViewer(viewer).id)
    ) {
      throw new HttpError(403, "Only the people in this conversation bring others in");
    }
    let actor: Actor;
    if (body.kind === "person") {
      const person = await platform.people.get(company.id, body.id);
      actor = { kind: "person", id: person.id, name: person.name };
    } else {
      const agent = await platform.agents.get(company.id, body.id);
      if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `AI employee "${body.id}" not found`);
      actor = agentActor(agent);
    }
    const participants = await platform.conversations.addParticipant(company.id, id, actor, { invitedBy: actorOfViewer(viewer) });
    await platform.conversations.postSystem(company.id, id, `${viewerOf(request).name} brought ${actor.name} in.`, { participant: actor });
    return { participants };
  });

  app.delete("/api/companies/:company/conversations/:id/participants/:kind/:actor", async (request) => {
    const company = await companyOf(platform, request);
    const { id, kind, actor } = z.object({ id: z.string(), kind: z.enum(["person", "ai_employee"]), actor: z.string() }).parse(request.params);
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    const me = actorOfViewer(viewer);
    const leaving = me.kind === kind && me.id === actor;
    if (!leaving && !canInvite(viewer, found.conversation, found.participants))
      throw new HttpError(403, "Only the conversation's owner or a manager removes participants");
    const participants = await platform.conversations.removeParticipant(company.id, id, { kind, id: actor });
    return { participants };
  });

  /** Live: new messages, who is working, cards that were handled, participants. */
  app.get("/api/companies/:company/conversations/:id/stream", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { after } = z.object({ after: z.coerce.number().int().optional() }).parse(request.query);
    const viewer = viewerOf(request);
    await open(request, company.id, id);
    const stream = sse(reply);
    const send = async (event: ConversationEvent) => {
      try {
        if (event.type === "message" || event.type === "card") {
          const [view] = await messageViews(viewer, company.slug, company.id, [event.message]);
          stream.send(event.type, { message: view });
        } else stream.send(event.type, event);
      } catch (error) {
        request.log.warn(error);
      }
    };
    if (after !== undefined) {
      for (const row of await platform.conversations.messages(company.id, id, { afterSeq: after, limit: 100 })) await send({ type: "message", message: row });
    }
    const unsubscribe = platform.conversations.subscribe(id, (event) => void send(event), actorOfViewer(viewer));
    stream.onClose(unsubscribe);
  });

  /** The "@" picker: people, AI employees, things of the brain, tables, apps, calculations, documents, files and tasks the viewer may see. */
  app.get("/api/companies/:company/mention", async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({ q: z.string().max(200).default(""), conversation: z.string().uuid().optional(), kinds: z.string().optional() })
      .parse(request.query);
    const viewer = viewerOf(request);
    const wanted = new Set((query.kinds?.split(",").filter((k) => (MENTION_KINDS as string[]).includes(k)) as MentionKind[] | undefined) ?? MENTION_KINDS);
    const q = query.q.trim().toLowerCase();
    const matches = (name: string, detail = "") => !q || name.toLowerCase().includes(q) || detail.toLowerCase().includes(q);
    const participants = query.conversation ? ((await platform.conversations.find(company.id, query.conversation))?.participants ?? []) : [];
    const inConversation = new Set(participants.map((p) => `${p.actorKind}:${p.actorId}`));
    const hits: MentionHit[] = [];

    if (wanted.has("person")) {
      const mine = new Set(viewer.departments.map((d) => d.departmentId));
      for (const person of await platform.people.list(company.id)) {
        if (person.status !== "active") continue;
        if (
          !viewer.isAdmin &&
          person.id !== viewer.userId &&
          person.role !== "admin" &&
          !person.departments.some((d) => mine.has(d.departmentId)) &&
          !inConversation.has(`person:${person.id}`)
        )
          continue;
        if (!matches(person.name, person.title ?? "")) continue;
        hits.push({
          kind: "person",
          id: person.id,
          name: person.name,
          detail: person.title ?? (person.role === "admin" ? "Admin" : ""),
          group: "People",
          href: "/company",
        });
      }
    }
    if (wanted.has("ai_employee")) {
      const agents = (await platform.agents.list(company.id, { includeSystem: true })).filter(
        (a) => a.row.status !== "archived" && canSeeDepartment(viewer, a.row.departmentId),
      );
      for (const agent of agents) {
        const brain = agent.row.slug === COMPANY_BRAIN_SLUG && agent.row.source === "system";
        if (!matches(agent.definition.name, brain ? "brain company" : (agent.definition.title ?? ""))) continue;
        hits.push({
          kind: "ai_employee",
          id: agent.row.id,
          name: agent.definition.name,
          detail: brain ? "Knows the company" : (agent.definition.title ?? "AI employee"),
          group: "AI employees",
          href: brain ? null : `/ai/${agent.row.slug}`,
        });
      }
    }
    if (wanted.has("thing") && q) {
      for (const thing of await platform.brain.search(company.id, q, { limit: 10 })) {
        hits.push({
          kind: "thing",
          id: thing.id,
          name: thing.name,
          detail:
            thing.brief
              .map(([, v]) => v)
              .slice(0, 2)
              .join(" · ") || thing.kind.replace("_", " "),
          group: "Things",
          href: `/brain/e/${thing.id}`,
        });
      }
    }
    if (wanted.has("table")) {
      for (const table of (await platform.tables.list(company.id)).filter((t) => canSeeTable(viewer, t))) {
        if (matches(table.name, table.description))
          hits.push({ kind: "table", id: table.key, name: table.name, detail: "Table", group: "Data", href: `/tables/${table.key}` });
      }
    }
    if (wanted.has("app")) {
      for (const item of (await platform.apps.list(company.id)).filter(
        (a) => a.settings.visibility === "company" || canSeeDepartment(viewer, a.departmentId),
      )) {
        if (matches(item.name, item.description))
          hits.push({ kind: "app", id: item.key, name: item.name, detail: "App", group: "Data", href: `/apps/${item.key}` });
      }
    }
    if (wanted.has("calculation")) {
      for (const item of (await platform.calculations.list(company.id)).filter((c) => canSeeDepartment(viewer, c.departmentId))) {
        if (matches(item.name, item.rule))
          hits.push({ kind: "calculation", id: item.key, name: item.name, detail: "Calculation", group: "Data", href: `/calculations/${item.key}` });
      }
    }
    if (wanted.has("document") && q) {
      const collections = new Map(
        (await platform.knowledge.listCollections(company.id)).filter((c) => canSeeDepartment(viewer, c.departmentId)).map((c) => [c.id, c]),
      );
      for (const document of await platform.knowledge.listDocuments(company.id)) {
        const collection = collections.get(document.collectionId);
        if (!collection || !matches(document.title, collection.name)) continue;
        hits.push({ kind: "document", id: document.id, name: document.title, detail: collection.name, group: "Files", href: "/settings/knowledge" });
        if (hits.filter((h) => h.kind === "document").length >= 8) break;
      }
    }
    if (wanted.has("file") && query.conversation) {
      const seen = new Set<string>();
      for (const message of await platform.conversations.messages(company.id, query.conversation, { limit: 200 })) {
        for (const fileId of message.fileIds) {
          if (seen.has(fileId)) continue;
          seen.add(fileId);
          const file = await platform.files.meta(company.id, fileId).catch(() => undefined);
          if (file && matches(file.name))
            hits.push({
              kind: "file",
              id: file.id,
              name: file.name,
              detail: "File in this conversation",
              group: "Files",
              href: `/api/companies/${company.slug}/files/${file.id}?inline=1`,
            });
        }
      }
    }
    if (wanted.has("task")) {
      const agents = new Map((await platform.agents.list(company.id)).map((a) => [a.row.id, a]));
      const tasks = await platform.tasks.list(company.id, { statuses: q ? undefined : OPEN_TASK_STATUSES, limit: 100 });
      for (const task of tasks) {
        const agent = agents.get(task.agentId);
        if (!agent || !canSeeDepartment(viewer, agent.row.departmentId)) continue;
        if (!matches(task.title, task.ref)) continue;
        hits.push({
          kind: "task",
          id: task.ref,
          name: task.title,
          detail: `${task.ref} · ${agent.definition.name} · ${task.status.replace("_", " ")}`,
          group: "Tasks",
          href: `/work/${task.ref}`,
        });
      }
    }
    const rank = (hit: MentionHit) => {
      const name = hit.name.toLowerCase();
      const member = inConversation.has(`${hit.kind}:${hit.id}`) ? 0 : 1;
      const position = !q ? 0 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
      return member * 10 + position;
    };
    return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 25);
  });
}
