import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LearnChange, applyLearning } from "@enterprise-brain/brain";
import {
  CONVERSATION_KINDS,
  brainPath,
  plainText,
  reactionEmoji,
  type Actor,
  type ConversationKind,
  type Mention,
  type MentionKind,
} from "@enterprise-brain/core";
import {
  COMPANY_BRAIN_SLUG,
  OPEN_TASK_STATUSES,
  THREADABLE_KINDS,
  agentActor,
  canLeaveConversation,
  isCompanyBrain,
  type AgentRecord,
  type ConversationEvent,
  type ConversationRow,
  type ConversationWithParticipants,
  type MessageRow,
  type QueueEntry,
} from "@enterprise-brain/runtime";
import { actorOfViewer, canInvite, canManageConversation, canSeeConversation, ownDepartmentIds, readerOf, requireConversation } from "../auth/conversations.ts";
import { canHandleWork, canSeeDepartment, canShapeBrain, isForViewer, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { giveWork } from "../give-work.ts";
import { HttpError, companyOf, sse } from "../http.ts";
import { checkMentions, mentionHref, type MentionHit } from "../mentions.ts";
import { canSeeTable } from "./tables.ts";

const MENTION_KINDS: MentionKind[] = ["person", "ai_employee", "thing", "table", "app", "calculation", "file", "document", "task"];

/** What the composer offers besides Send: teaching the brain, and giving work (to whom, when the words name nobody). */
export interface Offers {
  teach: boolean;
  work: { to: { id: string; slug: string; name: string } | null } | null;
}

/** What the company brain understood from a person's words, kept in its card's message. */
interface LearningData {
  by: Actor;
  forSeq: number;
  about: string | null;
  understood: string;
  offline: boolean;
  changes: LearnChange[];
  status: "open" | "kept" | "dismissed";
  kept?: number[];
  result?: { done: string[]; skipped: string[]; ids: string[] };
  settledBy?: string;
  settledAt?: string;
}

/** An AI employee that can be given work: at work or on trial (the company brain answers, it takes no tasks). */
export function takesWork(agent: AgentRecord): boolean {
  return !isCompanyBrain(agent.row) && (agent.row.status === "active" || agent.row.status === "testing");
}

/** A learning card as the viewer sees it: only the person who taught it keeps it, with their own rights. */
function learningView(viewer: Viewer, row: MessageRow) {
  const learning = row.data.learning as LearningData | undefined;
  if (!learning || !row.card) return null;
  const me = actorOfViewer(viewer);
  const teacher = learning.by.kind === me.kind && learning.by.id === me.id;
  return {
    type: "learning" as const,
    id: row.card.id,
    by: learning.by,
    understood: learning.understood,
    offline: learning.offline,
    changes: learning.changes,
    status: learning.status,
    kept: learning.kept ?? [],
    result: learning.result ?? null,
    settledBy: learning.settledBy ?? null,
    settledAt: learning.settledAt ?? null,
    canKeep: teacher && learning.status === "open",
    mayEdit: canShapeBrain(viewer),
  };
}

/**
 * Conversations: people and AI employees in one thread, with "@" mentions of people
 * and assets. What is posted here is heard by the turn planner, which decides which AI employee answers.
 */
export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** A conversation the viewer may open (404 otherwise). */
  const open = async (request: FastifyRequest, companyId: string, id: string) => {
    const found = await platform.conversations.get(companyId, id);
    requireConversation(viewerOf(request), found);
    return found;
  };

  /** The company as views need it: its id for the data, its slug for links. */
  type Company = { id: string; slug: string };

  /** The names and pages behind an AI employee, for chips. */
  const agentsById = async (companyId: string) => new Map((await platform.agents.list(companyId, { includeSystem: true })).map((a) => [a.row.id, a]));

  /**
   * A message as the page shows it: chips with links, files with names, cards as live work entries, who
   * reacted, and the thread under it (`conversation` is the one the messages are in; threads are summed up
   * for channels, direct messages and talks).
   */
  const messageViews = async (viewer: Viewer, companySlug: string, companyId: string, rows: MessageRow[], conversation?: ConversationRow) => {
    const agents = await agentsById(companyId);
    const me = actorOfViewer(viewer);
    const ids = rows.map((r) => r.id);
    const reactions = await platform.conversations.reactionsOf(ids, me.kind === "system" ? null : me);
    const threads =
      conversation && THREADABLE_KINDS.includes(conversation.kind as ConversationKind)
        ? await platform.conversations.threadsOf(companyId, conversation.id, ids)
        : new Map();
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
        card: row.card ? (row.card.type === "learning" ? learningView(viewer, row) : await cardOf(row.card)) : null,
        plain: plainText(row.text),
        reactions: reactions.get(row.id) ?? [],
        thread: threads.get(row.id) ?? null,
      });
    }
    return views;
  };

  /** The page a conversation is about: its task, its AI employee, its thing in the brain; a thread's channel or direct message. */
  const aboutOf = async (companyId: string, conversation: ConversationRow): Promise<{ href: string; label: string } | null> => {
    if (!conversation.aboutId) return null;
    try {
      switch (conversation.kind) {
        case "thread": {
          const parent = conversation.parentId ? await platform.conversations.find(companyId, conversation.parentId) : undefined;
          if (!parent) return null;
          const { kind, name, title } = parent.conversation;
          return { href: `/chat/${parent.conversation.id}`, label: kind === "channel" ? `#${name}` : title || "the conversation" };
        }
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
          return { href: brainPath(thing.id), label: thing.name };
        }
        case "studio":
          return { href: `/studio/conversations/${conversation.aboutId}`, label: "Studio" };
        default:
          return null;
      }
    } catch {
      return null;
    }
  };

  /**
   * What the composer offers here besides Send: teaching the brain (its talk, a thing's conversation), giving
   * work (to the AI employee of the talk; in a thread, to the AI employee whose message it is under).
   */
  const offersOf = async (viewer: Viewer, companyId: string, conversation: ConversationRow, parent?: ConversationRow): Promise<Offers> => {
    const none: Offers = { teach: false, work: null };
    if (conversation.status !== "open" || conversation.kind === "task" || conversation.kind === "studio") return none;
    if (actorOfViewer(viewer).kind !== "person") return none;
    if (conversation.kind === "thing") return { teach: true, work: { to: null } };
    if (conversation.kind === "thread") {
      // Work goes to the AI employee the thread is with: the one that wrote last in it, else the one whose message it is under.
      const recent = (await platform.conversations.messages(companyId, conversation.id, { limit: 30 })).reverse();
      const latest = recent.find((m) => m.kind === "text" && m.author.kind === "ai_employee");
      const root = latest ? undefined : conversation.aboutId ? await platform.conversations.message(companyId, conversation.aboutId) : undefined;
      const aiId = latest?.author.id ?? (root?.author.kind === "ai_employee" ? root.author.id : undefined);
      const author = aiId ? await platform.agents.find(companyId, aiId) : undefined;
      if (author && takesWork(author) && canSeeDepartment(viewer, author.row.departmentId)) {
        return { teach: false, work: { to: { id: author.row.id, slug: author.row.slug, name: author.definition.name } } };
      }
      return parent ? offersOf(viewer, companyId, parent) : { teach: false, work: { to: null } };
    }
    if (conversation.kind === "ai_employee" && conversation.aboutId) {
      const agent = await platform.agents.find(companyId, conversation.aboutId);
      if (agent && isCompanyBrain(agent.row)) return { teach: true, work: { to: null } };
      if (agent && takesWork(agent) && canSeeDepartment(viewer, agent.row.departmentId)) {
        return { teach: false, work: { to: { id: agent.row.id, slug: agent.row.slug, name: agent.definition.name } } };
      }
    }
    return { teach: false, work: { to: null } };
  };

  const conversationView = async (viewer: Viewer, company: Company, found: ConversationWithParticipants) => {
    const { conversation, participants, parent } = found;
    const me = actorOfViewer(viewer);
    const mine = participants.find((p) => p.actorKind === me.kind && p.actorId === me.id) ?? null;
    const root = conversation.kind === "thread" && conversation.aboutId ? await platform.conversations.message(company.id, conversation.aboutId) : undefined;
    return {
      conversation,
      participants,
      me: mine,
      canInvite: canInvite(viewer, conversation, participants),
      canManage: canManageConversation(viewer, conversation, participants),
      canLeave: Boolean(mine) && canLeaveConversation(conversation, ownDepartmentIds(viewer)),
      parent: parent ? { id: parent.conversation.id, kind: parent.conversation.kind, name: parent.conversation.name, title: parent.conversation.title } : null,
      root: root ? (await messageViews(viewer, company.slug, company.id, [root], parent?.conversation))[0] : null,
      about: await aboutOf(company.id, conversation),
      offers: await offersOf(viewer, company.id, conversation, parent?.conversation),
    };
  };

  /** A person of the company who may be written to. */
  const activePerson = async (companyId: string, id: string): Promise<Actor> => {
    const person = await platform.people.get(companyId, id).catch(() => undefined);
    if (!person || person.status !== "active") throw new HttpError(404, "There is no such person here");
    return { kind: "person", id: person.id, name: person.name };
  };

  /**
   * The viewer's conversations (`scope=mine`, the sidebar), their departments' and the company's open ones
   * (`department`: a channel to browse), or everything (`all`, admins). Lists the kinds asked for. First,
   * the built-in channels are brought in step and the viewer joined to theirs.
   */
  app.get("/api/companies/:company/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const query = z
      .object({
        scope: z.enum(["mine", "department", "all"]).optional(),
        kinds: z.string().optional(),
        unread: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    const viewer = viewerOf(request);
    const me = actorOfViewer(viewer);
    if (me.kind === "person") {
      await platform.syncChannels(company.id);
      await platform.conversations.ensureMemberships(company.id, me, ownDepartmentIds(viewer));
    }
    const kinds = query.kinds
      ?.split(",")
      .map((k) => k.trim())
      .filter((k): k is ConversationKind => (CONVERSATION_KINDS as readonly string[]).includes(k));
    return platform.conversations.list(company.id, readerOf(viewer), {
      scope: query.scope,
      kinds,
      unreadOnly: query.unread === "1",
      limit: query.limit,
    });
  });

  /** A new channel (public to the company or a department, or private), or the direct message with some people (or the talk with one AI employee). */
  app.post("/api/companies/:company/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("channel"),
          name: z.string().min(1).max(80),
          title: z.string().max(200).optional(),
          visibility: z.enum(["participants", "department", "company"]).default("company"),
          departmentId: z.string().uuid().nullable().optional(),
          participants: z
            .array(z.object({ kind: z.enum(["person", "ai_employee"]), id: z.string() }))
            .max(50)
            .optional(),
          text: z.string().max(20_000).optional(),
          fileIds: z.array(z.string()).max(20).optional(),
        }),
        z.object({
          kind: z.literal("dm"),
          participants: z
            .array(z.object({ kind: z.enum(["person", "ai_employee"]), id: z.string() }))
            .min(1)
            .max(8),
          text: z.string().max(20_000).optional(),
          fileIds: z.array(z.string()).max(20).optional(),
        }),
      ])
      .parse(request.body ?? {});
    const me = actorOfViewer(viewer);
    if (me.kind !== "person") throw new HttpError(400, "Sign in to start a conversation");
    let found: ConversationWithParticipants;
    if (body.kind === "channel") {
      if (body.visibility === "department" && (!body.departmentId || !canSeeDepartment(viewer, body.departmentId)))
        throw new HttpError(400, "Choose one of your departments for a department channel");
      const participants: Actor[] = [];
      for (const p of body.participants ?? []) {
        if (p.kind === "person") participants.push(await activePerson(company.id, p.id));
        else {
          const agent = await platform.agents.find(company.id, p.id);
          if (agent && canSeeDepartment(viewer, agent.row.departmentId)) participants.push(agentActor(agent));
        }
      }
      found = await platform.conversations.createChannel(company.id, {
        name: body.name,
        title: body.title,
        visibility: body.visibility,
        departmentId: body.visibility === "department" ? body.departmentId : null,
        createdBy: me,
        participants,
      });
    } else {
      const ais = body.participants.filter((p) => p.kind === "ai_employee");
      if (ais.length) {
        if (ais.length > 1 || body.participants.length > 1) throw new HttpError(400, "A direct message is with people, or a talk with one AI employee");
        const agent = await platform.agents.get(company.id, ais[0]!.id);
        if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `AI employee "${ais[0]!.id}" not found`);
        found = await platform.conversations.talkWith(company.id, agent, me);
      } else {
        const people: Actor[] = [];
        for (const p of body.participants) people.push(await activePerson(company.id, p.id));
        found = await platform.conversations.ensureDm(company.id, people, me);
      }
    }
    if (body.text?.trim()) {
      const mentions = await checkMentions(platform, viewer, company.id, body.text);
      await platform.conversations.post(company.id, found.conversation.id, { author: me, text: body.text, mentions, fileIds: body.fileIds });
      found = await platform.conversations.get(company.id, found.conversation.id);
    }
    return conversationView(viewer, company, found);
  });

  /**
   * The conversation about a task, a thing, my talk with an AI employee, my direct message with a person,
   * or the thread under a message (made on first use).
   */
  app.get("/api/companies/:company/conversations/for/:kind/:about", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { kind, about } = z.object({ kind: z.enum(["task", "thing", "ai_employee", "dm", "thread"]), about: z.string().min(1) }).parse(request.params);
    let found: ConversationWithParticipants;
    if (kind === "thread") {
      const root = z.string().uuid().safeParse(about).success ? await platform.conversations.message(company.id, about) : undefined;
      if (!root) throw new HttpError(404, "There is no such message");
      const parent = await open(request, company.id, root.conversationId);
      found = await platform.conversations.ensureThread(company.id, parent, root);
    } else if (kind === "dm") {
      const me = actorOfViewer(viewer);
      if (me.kind === "system") throw new HttpError(400, "Sign in to write to someone");
      found = await platform.conversations.ensureDm(company.id, [await activePerson(company.id, about)], me);
    } else if (kind === "task") {
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
    return conversationView(viewer, company, found);
  });

  app.get("/api/companies/:company/conversations/:id", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const found = await open(request, company.id, id);
    return conversationView(viewerOf(request), company, found);
  });

  /** Join a channel open to you (the company's, or your department's); you read from now on. */
  app.post("/api/companies/:company/conversations/:id/join", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const viewer = viewerOf(request);
    const me = actorOfViewer(viewer);
    if (me.kind !== "person") throw new HttpError(400, "Sign in to join a channel");
    await open(request, company.id, id);
    const participants = await platform.conversations.join(company.id, id, me, readerOf(viewer));
    return { participants };
  });

  /** Close a channel: it stays readable, nothing more is written. Its owner, the managers of its department, admins. */
  app.post("/api/companies/:company/conversations/:id/archive", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (!canManageConversation(viewer, found.conversation, found.participants)) throw new HttpError(403, "Only the channel's owner or a manager archives it");
    await platform.conversations.archive(company.id, id, actorOfViewer(viewer));
    return conversationView(viewer, company, await platform.conversations.get(company.id, id));
  });

  /** Rename a channel or change its description. Its owner, the managers of its department, admins. */
  app.patch("/api/companies/:company/conversations/:id", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(80).optional(), title: z.string().max(200).optional() }).parse(request.body ?? {});
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (!canManageConversation(viewer, found.conversation, found.participants)) throw new HttpError(403, "Only the channel's owner or a manager renames it");
    await platform.conversations.rename(company.id, id, body, actorOfViewer(viewer));
    return conversationView(viewer, company, await platform.conversations.get(company.id, id));
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
    const found = await open(request, company.id, id);
    const rows = await platform.conversations.messages(company.id, id, { beforeSeq: query.before, afterSeq: query.after, limit: query.limit });
    return messageViews(viewerOf(request), company.slug, company.id, rows, found.conversation);
  });

  app.post("/api/companies/:company/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        text: z.string().max(20_000),
        fileIds: z.array(z.string()).max(20).optional(),
        replyToId: z.string().uuid().nullable().optional(),
        /** teach: the company brain reads it and says what it would keep · work: it becomes a task */
        intent: z.enum(["teach", "work"]).optional(),
      })
      .parse(request.body);
    if (!body.text.trim() && !body.fileIds?.length) throw new HttpError(400, "Write something, or attach a file");
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (found.conversation.status !== "open") throw new HttpError(409, "This conversation is archived");
    const author = actorOfViewer(viewer);
    let data: Record<string, unknown> = {};
    if (body.intent) {
      const offers = await offersOf(viewer, company.id, found.conversation);
      if (author.kind !== "person") throw new HttpError(400, "Only a person teaches the brain or gives work here");
      if (body.intent === "teach") {
        if (!offers.teach) throw new HttpError(400, "Teach the brain in your talk with it, or in the conversation about a thing");
        if (body.fileIds?.length) throw new HttpError(400, "Teach the brain in words: files are not read here");
        if (plainText(body.text).trim().split(/\s+/).length < 3) throw new HttpError(400, "Say a little more: a few words at least");
        data = { intent: "teach" };
      } else {
        if (!offers.work) throw new HttpError(400, "Work is given in a talk with an AI employee, or by naming one with @");
        const given = await giveWork(platform, viewer, company.id, {
          text: body.text,
          fileIds: body.fileIds,
          defaultAgent: offers.work.to?.id ?? null,
          trigger: "chat",
          triggerRef: id,
        });
        data = { intent: "work", task: { id: given.task.id, ref: given.task.ref, title: given.task.title }, to: given.to };
      }
    }
    const mentions = await checkMentions(platform, viewer, company.id, body.text);
    const message = await platform.conversations.post(company.id, id, {
      author,
      text: body.text,
      mentions,
      fileIds: body.fileIds,
      replyToId: body.replyToId ?? null,
      data,
    });
    return (await messageViews(viewer, company.slug, company.id, [message], found.conversation))[0];
  });

  /** React to a message with one of the emoji offered (PUT), or take the reaction back (DELETE). */
  for (const method of ["put", "delete"] as const) {
    app[method]("/api/companies/:company/conversations/:id/messages/:messageId/reactions/:emoji", async (request) => {
      const company = await companyOf(platform, request);
      const { id, messageId, emoji: raw } = z.object({ id: z.string(), messageId: z.string().uuid(), emoji: z.string().min(1).max(16) }).parse(request.params);
      const viewer = viewerOf(request);
      const me = actorOfViewer(viewer);
      if (me.kind !== "person") throw new HttpError(400, "Sign in to react");
      const emoji = reactionEmoji(raw);
      if (!emoji) throw new HttpError(400, "Pick one of the emoji offered");
      const found = await open(request, company.id, id);
      if (found.conversation.status !== "open") throw new HttpError(409, "This conversation is archived");
      const row = await platform.conversations.message(company.id, messageId);
      if (!row || row.conversationId !== id) throw new HttpError(404, "There is no such message here");
      await platform.conversations.react(company.id, row, me, emoji, method === "put");
      return (await messageViews(viewer, company.slug, company.id, [row], found.conversation))[0];
    });
  }

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
    if (found.conversation.kind === "dm" && body.kind === "person")
      throw new HttpError(400, "A direct message's people are fixed: start a new one with everyone in it");
    if (found.conversation.status !== "open") throw new HttpError(409, "This conversation is archived");
    if (
      !canInvite(viewer, found.conversation, found.participants) &&
      !found.participants.some((p) => p.actorKind === actorOfViewer(viewer).kind && p.actorId === actorOfViewer(viewer).id)
    ) {
      throw new HttpError(403, "Only the people in this conversation bring others in");
    }
    let actor: Actor;
    if (body.kind === "person") {
      actor = await activePerson(company.id, body.id);
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
    if (kind === "person") {
      const { conversation } = found;
      if (conversation.kind === "dm" || conversation.kind === "thread" || conversation.kind === "ai_employee")
        throw new HttpError(400, leaving ? "A direct message is not left; it just stays quiet" : "A direct message's people are fixed");
      if (leaving && !canLeaveConversation(conversation, ownDepartmentIds(viewer)))
        throw new HttpError(400, conversation.aboutId === "general" ? "Everyone is in #general" : "You are in your department's channel");
    }
    const participants = await platform.conversations.removeParticipant(company.id, id, { kind, id: actor });
    if (kind === "person" && found.participants.some((p) => p.actorKind === kind && p.actorId === actor)) {
      const name = found.participants.find((p) => p.actorKind === kind && p.actorId === actor)!.actorName;
      await platform.conversations.postSystem(company.id, id, leaving ? `${name} left` : `${viewer.name} removed ${name}`, { left: `${kind}:${actor}` });
    }
    return { participants };
  });

  /** Keep what the company brain understood (the ticked changes), or put it aside: only the person who taught it. */
  app.post("/api/companies/:company/conversations/:id/messages/:messageId/learn", async (request) => {
    const company = await companyOf(platform, request);
    const { id, messageId } = z.object({ id: z.string(), messageId: z.string().uuid() }).parse(request.params);
    const body = z.object({ keep: z.array(z.number().int().min(0)).max(50).optional(), dismiss: z.boolean().optional() }).parse(request.body ?? {});
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    if (found.conversation.status !== "open") throw new HttpError(409, "This conversation is archived");
    const row = await platform.conversations.message(company.id, messageId);
    if (!row || row.conversationId !== id || row.card?.type !== "learning") throw new HttpError(404, "There is no such card here");
    const me = actorOfViewer(viewer);
    const updated = await platform.conversations.changeMessage(company.id, messageId, async (current) => {
      const learning = current.data.learning as LearningData;
      if (learning.status !== "open") throw new HttpError(409, learning.status === "kept" ? "It was already kept" : "It was put aside");
      if (learning.by.kind !== me.kind || learning.by.id !== me.id) throw new HttpError(403, "Only the person who taught the brain keeps what it understood");
      const settled = { settledBy: viewer.name, settledAt: new Date().toISOString() };
      if (body.dismiss) return { ...current.data, learning: { ...learning, status: "dismissed", ...settled } };
      const kept = [...new Set(body.keep ?? [])].filter((i) => i < learning.changes.length).sort((a, b) => a - b);
      if (!kept.length) throw new HttpError(400, "Tick what to keep");
      const changes = kept.map((i) => LearnChange.parse(learning.changes[i]));
      const result = await applyLearning(platform.brain, company.id, changes, { name: viewer.name, email: viewer.email, mayEdit: canShapeBrain(viewer) });
      return { ...current.data, learning: { ...learning, status: "kept", kept, result, ...settled } };
    });
    return (await messageViews(viewer, company.slug, company.id, [updated], found.conversation))[0];
  });

  /** Live: new messages, who is working, cards that were handled, participants. */
  app.get("/api/companies/:company/conversations/:id/stream", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { after } = z.object({ after: z.coerce.number().int().optional() }).parse(request.query);
    const viewer = viewerOf(request);
    const found = await open(request, company.id, id);
    const stream = sse(reply);
    const send = async (event: ConversationEvent) => {
      try {
        if (event.type === "message" || event.type === "card" || event.type === "updated") {
          // A root message of this conversation whose thread moved comes back as "updated": summed up for this conversation.
          const [view] = await messageViews(viewer, company.slug, company.id, [event.message], found.conversation);
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
      .object({
        q: z.string().max(200).default(""),
        conversation: z.string().uuid().optional(),
        kinds: z.string().optional(),
        /** company: every active person (to write to, to bring into a channel), not only those of the viewer's departments. */
        scope: z.enum(["company"]).optional(),
      })
      .parse(request.query);
    const viewer = viewerOf(request);
    const wanted = new Set((query.kinds?.split(",").filter((k) => (MENTION_KINDS as string[]).includes(k)) as MentionKind[] | undefined) ?? MENTION_KINDS);
    const q = query.q.trim().toLowerCase();
    const matches = (name: string, detail = "") => !q || name.toLowerCase().includes(q) || detail.toLowerCase().includes(q);
    const found = query.conversation ? await platform.conversations.find(company.id, query.conversation) : undefined;
    if (found && !canSeeConversation(viewer, found)) throw new HttpError(404, "Conversation not found");
    const participants = found?.participants ?? [];
    const inConversation = new Set(participants.map((p) => `${p.actorKind}:${p.actorId}`));
    const hits: MentionHit[] = [];

    if (wanted.has("person")) {
      const mine = new Set(viewer.departments.map((d) => d.departmentId));
      for (const person of await platform.people.list(company.id)) {
        if (person.status !== "active") continue;
        if (
          query.scope !== "company" &&
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
          takesWork: takesWork(agent),
        });
      }
    }
    if (wanted.has("thing") && q) {
      for (const thing of await platform.brain.search(company.id, q, { limit: 10 })) {
        // The brain's copy of a person or an AI employee listed above: only the one that reaches them.
        if ((thing.kind === "person" || thing.kind === "ai_employee") && hits.some((h) => h.kind === thing.kind && h.name === thing.name)) continue;
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
          href: brainPath(thing.id),
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
        hits.push({
          kind: "document",
          id: document.id,
          name: document.title,
          detail: collection.name,
          group: "Files",
          href: mentionHref(company.slug, { kind: "document", id: document.id, name: document.title }),
        });
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
