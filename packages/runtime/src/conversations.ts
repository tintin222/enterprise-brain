import { and, asc, desc, eq, gt, inArray, isNotNull, like, lt, ne, or, sql } from "drizzle-orm";
import type { BrainService } from "@enterprise-brain/brain";
import {
  actorKey,
  channelName,
  isChannelName,
  parseMentions,
  plainText,
  sameActor,
  SYSTEM_ACTOR,
  truncate,
  type Actor,
  type ConversationKind,
  type ConversationVisibility,
  type Mention,
} from "@enterprise-brain/core";
import {
  approvals,
  chatConversations,
  chatMessages,
  conversationMessages,
  conversationParticipants,
  conversationReactions,
  conversations,
  runs,
  type DatabaseHandle,
} from "@enterprise-brain/db";
import type { ActivityService } from "./activity.ts";
import type { AgentRecord, AgentService } from "./agents.ts";
import { COMPANY_BRAIN_SLUG } from "./company-brain.ts";
import type { PlatformEvents } from "./events.ts";
import type { MentionCards } from "./mentions.ts";
import type { PeopleService } from "./people.ts";
import type { QueueEntry, QueueService } from "./queue.ts";
import type { TaskRow, TaskService } from "./tasks.ts";
import type { WorkService } from "./work.ts";

export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type MessageRow = typeof conversationMessages.$inferSelect;
export type ReactionRow = typeof conversationReactions.$inferSelect;

/** The kinds a thread can be opened under. */
export const THREADABLE_KINDS: ConversationKind[] = ["channel", "dm", "ai_employee"];
/** The kinds that are named at creation (a channel by its name, a direct message by its people, a thread by its root). */
const NAMED_KINDS: ConversationKind[] = ["channel", "dm", "thread"];
/** The built-in channel everyone is in. */
export const GENERAL_CHANNEL = "general";
/** How long a viewer's built-in memberships are taken as done before they are checked again. */
const MEMBERSHIP_TTL = 5 * 60_000;

/** What a conversation's open page hears about, live. */
export type ConversationEvent =
  | { type: "message"; message: MessageRow }
  | { type: "working"; actor: Actor; on: boolean }
  | { type: "card"; message: MessageRow; entry: QueueEntry }
  /** A message changed in place (a card kept or put aside). */
  | { type: "updated"; message: MessageRow }
  | { type: "participants"; participants: ParticipantRow[] };

export interface ConversationWithParticipants {
  conversation: ConversationRow;
  participants: ParticipantRow[];
  /** A thread's channel or direct message (threads only; one level). */
  parent?: ConversationWithParticipants;
}

/** A thread's channel or direct message, as lists name it. */
export type ConversationParent = Pick<ConversationRow, "id" | "kind" | "name" | "title">;

/** A conversation in a list: with its first people, what the viewer hasn't read, and the newest message. */
export interface ConversationSummary {
  conversation: ConversationRow;
  /** The first few (a channel can be large); `members` counts them all. */
  participants: ParticipantRow[];
  members: number;
  unread: number;
  mentionsMe: number;
  me: ParticipantRow | null;
  parent: ConversationParent | null;
  lastMessage: (Pick<MessageRow, "id" | "seq" | "kind" | "author" | "createdAt"> & { text: string }) | null;
}

/** Who reacted to a message with one emoji. */
export interface ReactionView {
  emoji: string;
  count: number;
  me: boolean;
  names: string[];
}

/** The replies under a message. */
export interface ThreadSummary {
  id: string;
  replies: number;
  lastReplyAt: Date | null;
  repliers: Actor[];
}

/** A built-in channel: #general, or a department's. */
export interface ChannelSpec {
  /** "general", or the department id. */
  aboutId: string;
  name: string;
  title?: string;
  visibility: ConversationVisibility;
  departmentId?: string | null;
  /** The AI employees in it from the start. */
  ais: Actor[];
}

export interface PostInput {
  author: Actor;
  text: string;
  mentions?: Mention[];
  fileIds?: string[];
  replyToId?: string | null;
  kind?: "text" | "system";
  runId?: string | null;
  data?: Record<string, unknown>;
}

export interface CreateInput {
  kind: ConversationKind;
  aboutId?: string | null;
  title?: string;
  /** A channel's name. */
  name?: string | null;
  /** A thread's channel or direct message. */
  parentId?: string | null;
  /** A direct message's people. */
  dmKey?: string | null;
  departmentId?: string | null;
  visibility?: ConversationVisibility;
  createdBy: Actor;
  participants?: Actor[];
}

/** Who reads a list: their own participation, their departments, and whether they see everything. */
export interface Reader {
  actor: Actor | null;
  departmentIds: string[];
  isAdmin: boolean;
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ConversationError";
  }
}

export interface ConversationDeps {
  handle: DatabaseHandle;
  people: PeopleService;
  agents: AgentService;
  tasks: TaskService;
  work: WorkService;
  queue: QueueService;
  events: PlatformEvents;
  activity: ActivityService;
  cards: MentionCards;
  brain?: BrainService;
}

type MessageListener = (conversation: ConversationRow, message: MessageRow, participants: ParticipantRow[]) => void | Promise<void>;
type CardListener = (conversation: ConversationRow, message: MessageRow, entry: QueueEntry, by: string) => void | Promise<void>;

/**
 * May this reader open the conversation? Admins everything; participants theirs; a thread as its channel or
 * direct message; the rest by visibility.
 */
export function canReadConversation(
  conversation: ConversationRow,
  participants: ParticipantRow[],
  reader: Reader,
  parent?: ConversationWithParticipants,
): boolean {
  if (reader.isAdmin) return true;
  if (reader.actor && participants.some((p) => p.actorKind === reader.actor!.kind && p.actorId === reader.actor!.id)) return true;
  if (conversation.kind === "thread") return parent ? canReadConversation(parent.conversation, parent.participants, reader) : false;
  if (conversation.visibility === "company") return Boolean(reader.actor);
  if (conversation.visibility === "department") return Boolean(conversation.departmentId && reader.departmentIds.includes(conversation.departmentId));
  return false;
}

/** Who may leave: a channel's members, except #general and, for the people of a department, its channel. */
export function canLeaveConversation(conversation: ConversationRow, memberOfDepartments: string[]): boolean {
  if (conversation.kind !== "channel" || conversation.aboutId === GENERAL_CHANNEL) return false;
  return !(conversation.aboutId && memberOfDepartments.includes(conversation.aboutId));
}

/** The key of a direct message: its people, sorted, so the same people always find the same one. */
export function dmKeyOf(people: Pick<Actor, "kind" | "id">[]): string {
  return [...new Set(people.filter((a) => a.kind === "person").map((a) => actorKey(a)))].sort().join("|");
}

export function participantActor(p: Pick<ParticipantRow, "actorKind" | "actorId" | "actorName">): Actor {
  return { kind: p.actorKind as Actor["kind"], id: p.actorId, name: p.actorName };
}

/** What an AI employee reads after a person's name when the message wanted no answer from it. */
function intentNote(message: Pick<MessageRow, "data">): string {
  if (message.data.intent === "teach") return " (taught the company brain; nothing to answer)";
  if (message.data.intent === "work") {
    const to = message.data.to as { name?: string } | undefined;
    const task = message.data.task as { ref?: string } | undefined;
    return ` (gave this${to?.name ? ` to ${to.name}` : ""} as work${task?.ref ? `, task ${task.ref}` : ""}; nothing to answer)`;
  }
  return "";
}

export function agentActor(agent: AgentRecord): Actor {
  return { kind: "ai_employee", id: agent.row.id, name: agent.definition.name };
}

/**
 * One conversation for people and AI employees: about a task, an AI employee, a thing of the brain,
 * a Studio thread, or a free topic. It stores and serves the messages; who answers is
 * decided by the turn planner, which listens to what is posted here.
 */
export class ConversationService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Map<(event: ConversationEvent) => void, Actor | null>>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly cardListeners = new Set<CardListener>();
  /** Who was joined to their built-in channels, and when. */
  private readonly joined = new Map<string, number>();

  constructor(private readonly deps: ConversationDeps) {
    deps.events.on("queue.added", async (event) => {
      const entry = await deps.queue.entry(event.companyId, event.type, event.id);
      if (!entry) return;
      const conversationId = await this.conversationOf(event.companyId, entry);
      if (conversationId) await this.postCard(event.companyId, conversationId, entry);
    });
    deps.events.on("queue.resolved", async (event) => {
      const entry = await deps.queue.entry(event.companyId, event.type, event.id);
      if (!entry) return;
      const [message] = await this.db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.companyId, event.companyId), eq(conversationMessages.cardKey, `${entry.type}:${entry.id}`)));
      if (!message) return;
      const found = await this.find(event.companyId, message.conversationId);
      if (!found) return;
      this.publish(message.conversationId, { type: "card", message, entry });
      for (const listener of this.cardListeners)
        await Promise.resolve(listener(found.conversation, message, entry, event.by)).catch((error) => console.error("[conversations]", error));
    });
  }

  private get db() {
    return this.deps.handle.db;
  }

  /** Changes to one conversation run one after another, so message numbers never collide. */
  /** Resolves once the writes under way are done (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
  }

  private async serialized<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.queues.set(conversationId, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(conversationId) === tail) this.queues.delete(conversationId);
    }
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  async create(companyId: string, input: CreateInput): Promise<ConversationWithParticipants> {
    const [row] = await this.db
      .insert(conversations)
      .values({
        companyId,
        kind: input.kind,
        aboutId: input.aboutId ?? null,
        title: truncate((input.title ?? "").replace(/\s+/g, " ").trim(), 200),
        name: input.name ?? null,
        parentId: input.parentId ?? null,
        dmKey: input.dmKey ?? null,
        departmentId: input.departmentId ?? null,
        visibility: input.visibility ?? "participants",
        createdBy: input.createdBy,
      })
      .returning();
    const members: { actor: Actor; role: string }[] = [];
    // A direct message has no owner: its people are equals.
    if (input.createdBy.kind !== "system") members.push({ actor: input.createdBy, role: input.kind === "dm" ? "member" : "owner" });
    for (const actor of input.participants ?? []) {
      if (!members.some((m) => sameActor(m.actor, actor))) members.push({ actor, role: "member" });
    }
    if (members.length) {
      await this.db
        .insert(conversationParticipants)
        .values(
          members.map((m) => ({ companyId, conversationId: row!.id, actorKind: m.actor.kind, actorId: m.actor.id, actorName: m.actor.name, role: m.role })),
        )
        .onConflictDoNothing();
    }
    return this.withParent({ conversation: row!, participants: await this.participantsOf(row!.id) });
  }

  /** The one conversation about a task, thing, Studio thread, root message (a thread) or built-in channel, made on first use. */
  async ensureFor(
    companyId: string,
    kind: "task" | "thing" | "studio" | "thread" | "channel",
    aboutId: string,
    defaults: Omit<CreateInput, "kind" | "aboutId">,
  ): Promise<ConversationWithParticipants> {
    const existing = await this.findAbout(companyId, kind, aboutId);
    if (existing) return existing;
    try {
      return await this.create(companyId, { ...defaults, kind, aboutId });
    } catch (error) {
      // Two callers at once: the unique index let one through; take theirs.
      const again = await this.findAbout(companyId, kind, aboutId);
      if (again) return again;
      throw error;
    }
  }

  async findAbout(companyId: string, kind: ConversationKind, aboutId: string): Promise<ConversationWithParticipants | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, companyId), eq(conversations.kind, kind), eq(conversations.aboutId, aboutId)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ? this.withParent({ conversation: row, participants: await this.participantsOf(row.id) }) : undefined;
  }

  /** The conversation of a task: its department's people may read it; its AI employee is in it. */
  async forTask(companyId: string, task: TaskRow): Promise<ConversationWithParticipants> {
    const existing = await this.findAbout(companyId, "task", task.id);
    if (existing) return existing;
    const agent = await this.deps.agents.find(companyId, task.agentId);
    const made = await this.ensureFor(companyId, "task", task.id, {
      title: task.title,
      departmentId: agent?.row.departmentId ?? null,
      visibility: agent?.row.departmentId ? "department" : "company",
      createdBy: SYSTEM_ACTOR,
      participants: agent ? [agentActor(agent)] : [],
    });
    // A task from before its conversation existed: what already waits for a person shows as cards.
    for (const entry of await this.deps.queue.openForTask(companyId, task.id)) await this.postCard(companyId, made.conversation.id, entry);
    return made;
  }

  /** The conversation about a thing of the brain, with the company brain in it. */
  async forThing(companyId: string, thing: { id: string; name: string }): Promise<ConversationWithParticipants> {
    const brain = await this.deps.agents.find(companyId, COMPANY_BRAIN_SLUG);
    return this.ensureFor(companyId, "thing", thing.id, {
      title: thing.name,
      visibility: "company",
      createdBy: SYSTEM_ACTOR,
      participants: brain ? [agentActor(brain)] : [],
    });
  }

  /** A person's own talk with an AI employee (the company brain included): theirs, newest open one, or a new one. */
  async talkWith(companyId: string, agent: AgentRecord, person: Actor): Promise<ConversationWithParticipants> {
    const rows = await this.db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(conversationParticipants, eq(conversationParticipants.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.companyId, companyId),
          eq(conversations.kind, "ai_employee"),
          eq(conversations.aboutId, agent.row.id),
          eq(conversations.status, "open"),
          eq(conversationParticipants.actorKind, person.kind),
          eq(conversationParticipants.actorId, person.id),
          eq(conversationParticipants.role, "owner"),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
      .limit(1);
    const found = rows[0]?.conversation;
    if (found) return { conversation: found, participants: await this.participantsOf(found.id) };
    return this.create(companyId, {
      kind: "ai_employee",
      aboutId: agent.row.id,
      title: agent.definition.name,
      departmentId: agent.row.departmentId,
      visibility: "participants",
      createdBy: person,
      participants: [agentActor(agent)],
    });
  }

  async find(companyId: string, id: string): Promise<ConversationWithParticipants | undefined> {
    const found = await this.load(companyId, id);
    return found ? this.withParent(found) : undefined;
  }

  private async load(companyId: string, id: string): Promise<ConversationWithParticipants | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, companyId), eq(conversations.id, id)));
    return row ? { conversation: row, participants: await this.participantsOf(row.id) } : undefined;
  }

  /** A thread comes with its channel or direct message: who may read it is decided there. */
  private async withParent(found: ConversationWithParticipants): Promise<ConversationWithParticipants> {
    if (found.conversation.kind === "thread" && found.conversation.parentId && !found.parent)
      found.parent = await this.load(found.conversation.companyId, found.conversation.parentId);
    return found;
  }

  async get(companyId: string, id: string): Promise<ConversationWithParticipants> {
    const found = await this.find(companyId, id);
    if (!found) throw new ConversationError(`Conversation ${id} not found`, 404);
    return found;
  }

  async participantsOf(conversationId: string): Promise<ParticipantRow[]> {
    return this.db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(conversationParticipants.joinedAt));
  }

  async participantOf(conversationId: string, actor: Pick<Actor, "kind" | "id">): Promise<ParticipantRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.actorKind, actor.kind),
          eq(conversationParticipants.actorId, actor.id),
        ),
      );
    return row;
  }

  async setTitle(companyId: string, id: string, title: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ title: truncate(title.replace(/\s+/g, " ").trim(), 200), updatedAt: new Date() })
      .where(and(eq(conversations.companyId, companyId), eq(conversations.id, id)));
  }

  /**
   * The conversations a reader may see, newest first: `mine` the ones they take part in; `department`
   * those too, plus their departments' and the company's; `all` everything (admins). Threads are listed
   * to their participants only. `unread` counts what people and AI employees wrote, not the app's lines.
   */
  async list(
    companyId: string,
    reader: Reader,
    filter: { scope?: "mine" | "department" | "all"; kinds?: ConversationKind[]; unreadOnly?: boolean; limit?: number } = {},
  ): Promise<ConversationSummary[]> {
    const limit = filter.limit ?? 100;
    const scope = filter.scope ?? (reader.isAdmin && !reader.actor ? "all" : "department");
    const conditions = [eq(conversations.companyId, companyId), eq(conversations.status, "open")];
    if (filter.kinds?.length) conditions.push(inArray(conversations.kind, filter.kinds));
    let rows: ConversationRow[];
    if (scope === "mine") {
      if (!reader.actor) return [];
      rows = (
        await this.db
          .select({ conversation: conversations })
          .from(conversations)
          .innerJoin(
            conversationParticipants,
            and(
              eq(conversationParticipants.conversationId, conversations.id),
              eq(conversationParticipants.actorKind, reader.actor.kind),
              eq(conversationParticipants.actorId, reader.actor.id),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
          .limit(filter.unreadOnly ? 500 : limit)
      ).map((r) => r.conversation);
    } else {
      rows = await this.db
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
        .limit(500);
    }
    if (!rows.length) return [];
    const participants = await this.db
      .select()
      .from(conversationParticipants)
      .where(
        inArray(
          conversationParticipants.conversationId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(conversationParticipants.joinedAt));
    const byConversation = new Map<string, ParticipantRow[]>();
    for (const p of participants) byConversation.set(p.conversationId, [...(byConversation.get(p.conversationId) ?? []), p]);
    const visible =
      scope === "mine" ? rows : rows.filter((c) => (scope === "all" && reader.isAdmin) || canReadConversation(c, byConversation.get(c.id) ?? [], reader));
    const ids = visible.map((c) => c.id);
    if (!ids.length) return [];
    const last = await this.db
      .select({ message: conversationMessages })
      .from(conversationMessages)
      .innerJoin(conversations, and(eq(conversations.id, conversationMessages.conversationId), eq(conversations.lastSeq, conversationMessages.seq)))
      .where(inArray(conversationMessages.conversationId, ids));
    const lastById = new Map(last.map((l) => [l.message.conversationId, l.message]));
    // What the reader hasn't read, and where they are named in it, counted where they take part.
    const actor = reader.actor;
    const mine = actor
      ? and(
          eq(conversationParticipants.conversationId, conversationMessages.conversationId),
          eq(conversationParticipants.actorKind, actor.kind),
          eq(conversationParticipants.actorId, actor.id),
        )
      : undefined;
    const counted = { conversationId: conversationMessages.conversationId, count: sql<number>`count(*)::int` };
    const unreadRows = mine
      ? await this.db
          .select(counted)
          .from(conversationMessages)
          .innerJoin(conversationParticipants, mine)
          .where(
            and(
              inArray(conversationMessages.conversationId, ids),
              gt(conversationMessages.seq, conversationParticipants.readSeq),
              ne(conversationMessages.kind, "system"),
            ),
          )
          .groupBy(conversationMessages.conversationId)
      : [];
    const mentionRows =
      mine && actor
        ? await this.db
            .select(counted)
            .from(conversationMessages)
            .innerJoin(conversationParticipants, mine)
            .where(
              and(
                inArray(conversationMessages.conversationId, ids),
                gt(conversationMessages.seq, conversationParticipants.readSeq),
                sql`${conversationMessages.mentions} @> ${JSON.stringify([{ kind: actor.kind, id: actor.id, allowed: true }])}::jsonb`,
              ),
            )
            .groupBy(conversationMessages.conversationId)
        : [];
    const unreadById = new Map(unreadRows.map((r) => [r.conversationId, r.count]));
    const mentionsById = new Map(mentionRows.map((r) => [r.conversationId, r.count]));
    const parentIds = [...new Set(visible.filter((c) => c.kind === "thread" && c.parentId).map((c) => c.parentId!))];
    const parents = parentIds.length
      ? await this.db
          .select({ id: conversations.id, kind: conversations.kind, name: conversations.name, title: conversations.title })
          .from(conversations)
          .where(inArray(conversations.id, parentIds))
      : [];
    const parentById = new Map(parents.map((p) => [p.id, p]));
    const summaries = visible.map((conversation): ConversationSummary => {
      const theirs = byConversation.get(conversation.id) ?? [];
      const me = actor ? (theirs.find((p) => p.actorKind === actor.kind && p.actorId === actor.id) ?? null) : null;
      const lastMessage = lastById.get(conversation.id);
      return {
        conversation,
        participants: theirs.slice(0, 8),
        members: theirs.length,
        me,
        unread: me ? (unreadById.get(conversation.id) ?? 0) : 0,
        mentionsMe: me ? (mentionsById.get(conversation.id) ?? 0) : 0,
        parent: (conversation.parentId && parentById.get(conversation.parentId)) || null,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              seq: lastMessage.seq,
              kind: lastMessage.kind,
              author: lastMessage.author,
              createdAt: lastMessage.createdAt,
              text: truncate(plainText(lastMessage.text), 160),
            }
          : null,
      };
    });
    const wanted = filter.unreadOnly ? summaries.filter((s) => s.unread > 0 || s.mentionsMe > 0) : summaries;
    return wanted.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  /** A channel by its name (archived ones too: a name is never reused). */
  async findByName(companyId: string, name: string): Promise<ConversationWithParticipants | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, companyId), eq(conversations.kind, "channel"), eq(conversations.name, name)))
      .limit(1);
    return row ? { conversation: row, participants: await this.participantsOf(row.id) } : undefined;
  }

  /** `base` as a channel name, or `base-2`, `base-3`… when channels with those names exist. */
  async freeChannelName(companyId: string, base: string): Promise<string> {
    const root = channelName(base) || "channel";
    const taken = new Set(
      (
        await this.db
          .select({ name: conversations.name })
          .from(conversations)
          .where(
            and(
              eq(conversations.companyId, companyId),
              eq(conversations.kind, "channel"),
              or(eq(conversations.name, root), like(conversations.name, `${root}-%`)),
            ),
          )
      ).map((r) => r.name),
    );
    if (!taken.has(root)) return root;
    for (let n = 2; ; n++) {
      const candidate = `${channelName(root.slice(0, 60 - `-${n}`.length))}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** A new channel: open to the company or to a department, or private to its people. */
  async createChannel(
    companyId: string,
    input: { name: string; title?: string; visibility: ConversationVisibility; departmentId?: string | null; createdBy: Actor; participants?: Actor[] },
  ): Promise<ConversationWithParticipants> {
    const name = channelName(input.name);
    if (!isChannelName(name)) throw new ConversationError("A channel name has letters, digits and hyphens, up to 60", 400);
    if (await this.findByName(companyId, name)) throw new ConversationError(`There is already a channel #${name}`, 409);
    if (input.visibility === "department" && !input.departmentId) throw new ConversationError("A department channel needs its department", 400);
    try {
      return await this.create(companyId, {
        kind: "channel",
        name,
        title: input.title ?? "",
        visibility: input.visibility,
        departmentId: input.departmentId ?? null,
        createdBy: input.createdBy,
        participants: input.participants,
      });
    } catch (error) {
      // Two at once: the unique index let one through.
      if (await this.findByName(companyId, name)) throw new ConversationError(`There is already a channel #${name}`, 409);
      throw error;
    }
  }

  /**
   * The built-in channels (#general and one per department): made when missing and kept in step with
   * their departments (title, who may read them, their AI employees). Tells how many were made.
   */
  async ensureChannels(companyId: string, specs: ChannelSpec[]): Promise<number> {
    let made = 0;
    for (const spec of specs) {
      const existing = await this.findAbout(companyId, "channel", spec.aboutId);
      if (!existing) {
        await this.ensureFor(companyId, "channel", spec.aboutId, {
          name: await this.freeChannelName(companyId, spec.name),
          title: spec.title ?? "",
          visibility: spec.visibility,
          departmentId: spec.departmentId ?? null,
          createdBy: SYSTEM_ACTOR,
          participants: spec.ais,
        });
        made++;
        continue;
      }
      const { conversation, participants } = existing;
      const title = truncate((spec.title ?? "").replace(/\s+/g, " ").trim(), 200);
      const departmentId = spec.departmentId ?? null;
      if (conversation.title !== title || conversation.visibility !== spec.visibility || conversation.departmentId !== departmentId)
        await this.db
          .update(conversations)
          .set({ title, visibility: spec.visibility, departmentId, updatedAt: new Date() })
          .where(eq(conversations.id, conversation.id));
      const missing = spec.ais.filter((ai) => !participants.some((p) => p.actorKind === ai.kind && p.actorId === ai.id));
      if (missing.length)
        await this.db
          .insert(conversationParticipants)
          .values(
            missing.map((ai) => ({
              companyId,
              conversationId: conversation.id,
              actorKind: ai.kind,
              actorId: ai.id,
              actorName: ai.name,
              role: "member",
              readSeq: conversation.lastSeq,
            })),
          )
          .onConflictDoNothing();
    }
    if (made) this.joined.clear();
    return made;
  }

  /**
   * A person is in #general and in their departments' channels: joined where they are not yet, reading
   * from now (the backlog is not unread for them). Remembered for a while, so lists don't check again.
   */
  async ensureMemberships(companyId: string, actor: Actor, departmentIds: string[]): Promise<void> {
    const key = `${companyId}|${actorKey(actor)}|${[...departmentIds].sort().join(",")}`;
    const at = this.joined.get(key);
    if (at && Date.now() - at < MEMBERSHIP_TTL) return;
    this.joined.set(key, Date.now());
    const channels = await this.db
      .select({ id: conversations.id, lastSeq: conversations.lastSeq })
      .from(conversations)
      .where(
        and(
          eq(conversations.companyId, companyId),
          eq(conversations.kind, "channel"),
          eq(conversations.status, "open"),
          inArray(conversations.aboutId, [GENERAL_CHANNEL, ...departmentIds]),
        ),
      );
    if (!channels.length) return;
    const mine = new Set(
      (
        await this.db
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(
            and(
              inArray(
                conversationParticipants.conversationId,
                channels.map((c) => c.id),
              ),
              eq(conversationParticipants.actorKind, actor.kind),
              eq(conversationParticipants.actorId, actor.id),
            ),
          )
      ).map((r) => r.conversationId),
    );
    const missing = channels.filter((c) => !mine.has(c.id));
    if (!missing.length) return;
    await this.db
      .insert(conversationParticipants)
      .values(
        missing.map((c) => ({
          companyId,
          conversationId: c.id,
          actorKind: actor.kind,
          actorId: actor.id,
          actorName: actor.name,
          role: "member",
          readSeq: c.lastSeq,
        })),
      )
      .onConflictDoNothing();
    for (const c of missing) this.publish(c.id, { type: "participants", participants: await this.participantsOf(c.id) });
  }

  /** Someone joins a channel they may read (open to the company, or to their department); they read from now. */
  async join(companyId: string, id: string, actor: Actor, reader: Reader): Promise<ParticipantRow[]> {
    const { conversation, participants } = await this.get(companyId, id);
    if (conversation.kind !== "channel" || conversation.status !== "open") throw new ConversationError("Only an open channel can be joined", 400);
    if (participants.some((p) => p.actorKind === actor.kind && p.actorId === actor.id)) return participants;
    if (!canReadConversation(conversation, participants, reader))
      throw new ConversationError("This channel is private: ask one of its members to bring you in", 403);
    const joined = await this.addParticipant(companyId, id, actor, { readSeq: conversation.lastSeq });
    await this.postSystem(companyId, id, `${actor.name} joined`, { joined: actorKey(actor) });
    return joined;
  }

  /** A channel is closed: it stays readable, nothing more is written in it. #general and the departments' channels stay open. */
  async archive(companyId: string, id: string, by: Actor): Promise<ConversationRow> {
    const { conversation } = await this.get(companyId, id);
    if (conversation.kind !== "channel") throw new ConversationError("Only a channel can be archived", 400);
    if (conversation.aboutId) throw new ConversationError("#general and the departments' channels stay open", 400);
    if (conversation.status !== "open") return conversation;
    await this.postSystem(companyId, id, `${by.name} archived this channel`, { archived: true });
    const [row] = await this.db.update(conversations).set({ status: "archived", updatedAt: new Date() }).where(eq(conversations.id, id)).returning();
    return row!;
  }

  /** A channel's name or description changes (not a built-in channel's: those follow their department). */
  async rename(companyId: string, id: string, input: { name?: string; title?: string }, by: Actor): Promise<ConversationRow> {
    const { conversation } = await this.get(companyId, id);
    if (conversation.kind !== "channel") throw new ConversationError("Only a channel can be renamed", 400);
    if (conversation.aboutId) throw new ConversationError("#general and the departments' channels follow the company", 400);
    const changes: { name?: string; title?: string } = {};
    if (input.name !== undefined) {
      const name = channelName(input.name);
      if (!isChannelName(name)) throw new ConversationError("A channel name has letters, digits and hyphens, up to 60", 400);
      if (name !== conversation.name) {
        if (await this.findByName(companyId, name)) throw new ConversationError(`There is already a channel #${name}`, 409);
        changes.name = name;
      }
    }
    if (input.title !== undefined) {
      const title = truncate(input.title.replace(/\s+/g, " ").trim(), 200);
      if (title !== conversation.title) changes.title = title;
    }
    if (!Object.keys(changes).length) return conversation;
    const [row] = await this.db
      .update(conversations)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    const said = changes.name ? `renamed this channel #${changes.name}` : `changed the description to “${changes.title || "nothing"}”`;
    await this.postSystem(companyId, id, `${by.name} ${said}`, { renamed: true });
    return row!;
  }

  // -------------------------------------------------------------------------
  // Direct messages and threads
  // -------------------------------------------------------------------------

  async findByDmKey(companyId: string, dmKey: string): Promise<ConversationWithParticipants | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, companyId), eq(conversations.dmKey, dmKey)))
      .limit(1);
    return row ? { conversation: row, participants: await this.participantsOf(row.id) } : undefined;
  }

  /**
   * The one direct message between these people (the one who asks included), made on first use. People
   * only: a person talks with an AI employee in their talk with it (`talkWith`).
   */
  async ensureDm(companyId: string, people: Actor[], createdBy: Actor): Promise<ConversationWithParticipants> {
    const everyone = people.filter((a, i) => people.findIndex((b) => sameActor(a, b)) === i);
    if (!everyone.some((a) => sameActor(a, createdBy))) everyone.push(createdBy);
    if (everyone.some((a) => a.kind !== "person"))
      throw new ConversationError("A direct message is between people; an AI employee is talked to on its page", 400);
    if (everyone.length < 2) throw new ConversationError("Pick someone to message", 400);
    if (everyone.length > 9) throw new ConversationError("A direct message has at most 9 people; make a channel for more", 400);
    const dmKey = dmKeyOf(everyone);
    const existing = await this.findByDmKey(companyId, dmKey);
    if (existing) return existing;
    const title = everyone
      .map((a) => a.name)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    try {
      return await this.create(companyId, { kind: "dm", dmKey, title, visibility: "participants", createdBy, participants: everyone });
    } catch (error) {
      const again = await this.findByDmKey(companyId, dmKey);
      if (again) return again;
      throw error;
    }
  }

  /** The thread under a message, made on first use: in a channel, a direct message or a talk, with the message's author in it. */
  async ensureThread(companyId: string, parent: ConversationWithParticipants, root: MessageRow): Promise<ConversationWithParticipants> {
    if (!THREADABLE_KINDS.includes(parent.conversation.kind as ConversationKind))
      throw new ConversationError("Threads open under the messages of channels and direct messages", 400);
    if (root.conversationId !== parent.conversation.id) throw new ConversationError("The message is not in this conversation", 400);
    if (root.kind === "system") throw new ConversationError("The app's own lines have no threads", 400);
    const existing = await this.findAbout(companyId, "thread", root.id);
    if (existing) return existing;
    const first = plainText(root.text).split("\n")[0]!.trim();
    return this.ensureFor(companyId, "thread", root.id, {
      parentId: parent.conversation.id,
      title: truncate(first, 60) || (root.kind === "card" ? "A card" : "A message"),
      visibility: parent.conversation.visibility as ConversationVisibility,
      departmentId: parent.conversation.departmentId,
      createdBy: SYSTEM_ACTOR,
      participants: root.author.kind === "system" ? [] : [root.author as Actor],
    });
  }

  /** A thread moved: its channel or direct message hears that the root message changed (its replies count). */
  private async afterThreadMessage(companyId: string, thread: ConversationRow): Promise<void> {
    if (!thread.parentId || !thread.aboutId) return;
    const root = await this.message(companyId, thread.aboutId);
    if (root) this.publish(thread.parentId, { type: "updated", message: root });
  }

  /** A message changed in place (a reaction, a card decided): its conversation hears it, and so does the thread under it. */
  async publishMessageUpdated(message: MessageRow): Promise<void> {
    this.publish(message.conversationId, { type: "updated", message });
    const [thread] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.kind, "thread"), eq(conversations.aboutId, message.id)))
      .limit(1);
    if (thread) this.publish(thread.id, { type: "updated", message });
  }

  /** The threads under these messages of one conversation: how many replies, when the last came, who replied. */
  async threadsOf(companyId: string, parentId: string, messageIds: string[]): Promise<Map<string, ThreadSummary>> {
    const out = new Map<string, ThreadSummary>();
    if (!messageIds.length) return out;
    const threads = await this.db
      .select({ id: conversations.id, aboutId: conversations.aboutId, lastSeq: conversations.lastSeq, lastMessageAt: conversations.lastMessageAt })
      .from(conversations)
      .where(
        and(
          eq(conversations.companyId, companyId),
          eq(conversations.kind, "thread"),
          eq(conversations.parentId, parentId),
          inArray(conversations.aboutId, messageIds),
          gt(conversations.lastSeq, 0),
        ),
      );
    if (!threads.length) return out;
    const authors = await this.db
      .select({ conversationId: conversationMessages.conversationId, author: conversationMessages.author })
      .from(conversationMessages)
      .where(
        and(
          inArray(
            conversationMessages.conversationId,
            threads.map((t) => t.id),
          ),
          ne(conversationMessages.kind, "system"),
        ),
      )
      .orderBy(asc(conversationMessages.seq));
    for (const thread of threads) {
      const repliers: Actor[] = [];
      for (const a of authors) {
        if (a.conversationId !== thread.id || repliers.some((r) => sameActor(r, a.author as Actor))) continue;
        repliers.push(a.author as Actor);
        if (repliers.length >= 5) break;
      }
      out.set(thread.aboutId!, { id: thread.id, replies: thread.lastSeq, lastReplyAt: thread.lastMessageAt, repliers });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  /** Someone reacts to a message with an emoji, or takes it back; everyone reading hears the message changed. */
  async react(companyId: string, message: MessageRow, actor: Actor, emoji: string, on: boolean): Promise<void> {
    if (on) {
      await this.db
        .insert(conversationReactions)
        .values({ companyId, messageId: message.id, actor, actorKind: actor.kind, actorId: actor.id, emoji })
        .onConflictDoNothing();
    } else {
      await this.db
        .delete(conversationReactions)
        .where(
          and(
            eq(conversationReactions.messageId, message.id),
            eq(conversationReactions.actorKind, actor.kind),
            eq(conversationReactions.actorId, actor.id),
            eq(conversationReactions.emoji, emoji),
          ),
        );
    }
    await this.publishMessageUpdated(message);
  }

  /** The reactions on these messages: each emoji in the order it first came, how many, who, and whether `viewer` is among them. */
  async reactionsOf(messageIds: string[], viewer: Pick<Actor, "kind" | "id"> | null): Promise<Map<string, ReactionView[]>> {
    const out = new Map<string, ReactionView[]>();
    if (!messageIds.length) return out;
    const rows = await this.db
      .select()
      .from(conversationReactions)
      .where(inArray(conversationReactions.messageId, messageIds))
      .orderBy(asc(conversationReactions.createdAt));
    for (const row of rows) {
      const list = out.get(row.messageId) ?? [];
      let view = list.find((v) => v.emoji === row.emoji);
      if (!view) {
        view = { emoji: row.emoji, count: 0, me: false, names: [] };
        list.push(view);
      }
      view.count++;
      if (view.names.length < 20) view.names.push(row.actor.name);
      if (viewer && row.actorKind === viewer.kind && row.actorId === viewer.id) view.me = true;
      out.set(row.messageId, list);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Participants
  // -------------------------------------------------------------------------

  async addParticipant(
    companyId: string,
    conversationId: string,
    actor: Actor,
    options: { role?: "owner" | "member"; invitedBy?: Actor; readSeq?: number } = {},
  ): Promise<ParticipantRow[]> {
    await this.db
      .insert(conversationParticipants)
      .values({
        companyId,
        conversationId,
        actorKind: actor.kind,
        actorId: actor.id,
        actorName: actor.name,
        role: options.role ?? "member",
        invitedBy: options.invitedBy ?? null,
        readSeq: options.readSeq ?? 0,
      })
      .onConflictDoNothing();
    const participants = await this.participantsOf(conversationId);
    this.publish(conversationId, { type: "participants", participants });
    return participants;
  }

  async removeParticipant(companyId: string, conversationId: string, actor: Pick<Actor, "kind" | "id">): Promise<ParticipantRow[]> {
    await this.db
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.companyId, companyId),
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.actorKind, actor.kind),
          eq(conversationParticipants.actorId, actor.id),
        ),
      );
    const participants = await this.participantsOf(conversationId);
    this.publish(conversationId, { type: "participants", participants });
    return participants;
  }

  /** A participant read up to this message (never backwards). */
  async markRead(conversationId: string, actor: Pick<Actor, "kind" | "id">, seq: number): Promise<void> {
    await this.db
      .update(conversationParticipants)
      .set({ readSeq: sql`greatest(${conversationParticipants.readSeq}, ${seq})`, lastSeenAt: new Date() })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.actorKind, actor.kind),
          eq(conversationParticipants.actorId, actor.id),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async messages(companyId: string, conversationId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): Promise<MessageRow[]> {
    const conditions = [eq(conversationMessages.companyId, companyId), eq(conversationMessages.conversationId, conversationId)];
    if (options.afterSeq !== undefined) conditions.push(gt(conversationMessages.seq, options.afterSeq));
    if (options.beforeSeq !== undefined) conditions.push(lt(conversationMessages.seq, options.beforeSeq));
    const limit = options.limit ?? 50;
    // The newest `limit` ones (oldest first): a page reads back from the end.
    const rows = await this.db
      .select()
      .from(conversationMessages)
      .where(and(...conditions))
      .orderBy(desc(conversationMessages.seq))
      .limit(limit);
    return rows.reverse();
  }

  /** The message with this number in the conversation. */
  async messageAt(companyId: string, conversationId: string, seq: number): Promise<MessageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.companyId, companyId), eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.seq, seq)));
    return row;
  }

  async message(companyId: string, messageId: string): Promise<MessageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversationMessages)
      .where(and(eq(conversationMessages.companyId, companyId), eq(conversationMessages.id, messageId)));
    return row;
  }

  /** Someone writes (or the app says something): the message is numbered, kept, and everyone listening hears it. */
  async post(companyId: string, conversationId: string, input: PostInput): Promise<MessageRow> {
    return this.serialized(conversationId, async () => {
      const found = await this.get(companyId, conversationId);
      const { conversation } = found;
      const seq = conversation.lastSeq + 1;
      const now = new Date();
      // An AI employee's (or the app's) message brings no checked mentions: what its text names counts as is.
      const mentions: Mention[] = input.mentions
        ? input.mentions.map((m) => ({ kind: m.kind, id: m.id, name: m.name, allowed: m.allowed ?? true }))
        : parseMentions(input.text).map((m) => ({ kind: m.kind, id: m.id, name: m.name, allowed: true }));
      const [message] = await this.db
        .insert(conversationMessages)
        .values({
          companyId,
          conversationId,
          seq,
          kind: input.kind ?? "text",
          author: input.author,
          authorKind: input.author.kind,
          authorId: input.author.id,
          text: input.text,
          mentions,
          fileIds: input.fileIds ?? [],
          runId: input.runId ?? null,
          replyToId: input.replyToId ?? null,
          data: input.data ?? {},
          createdAt: now,
        })
        .returning();
      // A free conversation takes its title from its first words; channels, direct messages and threads are named at creation.
      const title =
        conversation.title ||
        (!NAMED_KINDS.includes(conversation.kind as ConversationKind) && input.kind !== "system" && input.author.kind !== "system"
          ? truncate(plainText(input.text).split("\n")[0]!, 60)
          : "");
      await this.db
        .update(conversations)
        .set({ lastSeq: seq, lastMessageAt: now, updatedAt: now, ...(title !== conversation.title ? { title } : {}) })
        .where(eq(conversations.id, conversationId));
      // Whoever writes is in the conversation and has read up to their own message.
      if (input.author.kind !== "system") {
        const current = found.participants.find((p) => p.actorKind === input.author.kind && p.actorId === input.author.id);
        if (!current) await this.addParticipant(companyId, conversationId, input.author);
        await this.markRead(conversationId, input.author, seq);
      }
      // A colleague or an AI employee a person names joins the conversation (what an AI employee names does not: it only points).
      // Not into a direct message, whose people are fixed, nor into a thread under one or under a private channel they are not in.
      const parent = found.parent?.conversation;
      const joining = input.author.kind === "person" ? mentions.filter((m) => m.allowed && (m.kind === "ai_employee" || m.kind === "person")) : [];
      for (const mention of joining) {
        if (found.participants.some((p) => p.actorKind === mention.kind && p.actorId === mention.id)) continue;
        if (mention.kind === "ai_employee") {
          const agent = await this.deps.agents.find(companyId, mention.id);
          if (agent) await this.addParticipant(companyId, conversationId, agentActor(agent), { invitedBy: input.author });
        } else if (conversation.kind === "dm" || parent?.kind === "dm") {
          continue;
        } else if (
          parent &&
          parent.visibility === "participants" &&
          !found.parent!.participants.some((p) => p.actorKind === "person" && p.actorId === mention.id)
        ) {
          continue;
        } else {
          const person = await this.deps.people.get(companyId, mention.id).catch(() => undefined);
          if (person?.status === "active")
            await this.addParticipant(companyId, conversationId, { kind: "person", id: person.id, name: person.name }, { invitedBy: input.author });
        }
      }
      const after = await this.get(companyId, conversationId);
      this.publish(conversationId, { type: "message", message: message! });
      if (after.conversation.kind === "thread") await this.afterThreadMessage(companyId, after.conversation);
      await this.recordInBrain(companyId, after.conversation, message!).catch((error) => console.error("[conversations] brain event:", error));
      for (const listener of this.messageListeners) {
        Promise.resolve(listener(after.conversation, message!, after.participants)).catch((error) => console.error("[conversations] listener:", error));
      }
      return message!;
    });
  }

  /** A line from the app itself ("Invoice Processor can't answer: it reached its monthly budget"). */
  async postSystem(companyId: string, conversationId: string, text: string, data: Record<string, unknown> = {}): Promise<MessageRow> {
    return this.post(companyId, conversationId, { author: SYSTEM_ACTOR, kind: "system", text, data });
  }

  /** A work-queue item as a card in the conversation it belongs to (once per item). */
  async postCard(companyId: string, conversationId: string, entry: QueueEntry): Promise<MessageRow | undefined> {
    const author: Actor = entry.agent ? { kind: "ai_employee", id: entry.agent.id, name: entry.agent.name } : SYSTEM_ACTOR;
    return this.insertCard(companyId, conversationId, { author, card: { type: entry.type, id: entry.id } });
  }

  /**
   * A card that is not a work-queue item: what it shows lives in the message's `data` (what the brain
   * understood from a person's words, say). Once per type and id; `text` is how lists show it.
   */
  async postDataCard(
    companyId: string,
    conversationId: string,
    input: { author: Actor; type: string; id: string; text: string; data: Record<string, unknown>; replyToId?: string | null },
  ): Promise<MessageRow | undefined> {
    return this.insertCard(companyId, conversationId, {
      author: input.author,
      card: { type: input.type, id: input.id },
      text: input.text,
      data: input.data,
      replyToId: input.replyToId ?? null,
    });
  }

  private async insertCard(
    companyId: string,
    conversationId: string,
    input: { author: Actor; card: { type: string; id: string }; text?: string; data?: Record<string, unknown>; replyToId?: string | null },
  ): Promise<MessageRow | undefined> {
    return this.serialized(conversationId, async () => {
      const cardKey = `${input.card.type}:${input.card.id}`;
      const [existing] = await this.db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.cardKey, cardKey)));
      if (existing) return existing;
      const found = await this.find(companyId, conversationId);
      if (!found) return undefined;
      const seq = found.conversation.lastSeq + 1;
      const now = new Date();
      const [message] = await this.db
        .insert(conversationMessages)
        .values({
          companyId,
          conversationId,
          seq,
          kind: "card",
          author: input.author,
          authorKind: input.author.kind,
          authorId: input.author.id,
          text: input.text ?? "",
          card: input.card,
          cardKey,
          replyToId: input.replyToId ?? null,
          data: input.data ?? {},
          createdAt: now,
        })
        .returning();
      await this.db.update(conversations).set({ lastSeq: seq, lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conversationId));
      this.publish(conversationId, { type: "message", message: message! });
      if (found.conversation.kind === "thread") await this.afterThreadMessage(companyId, found.conversation);
      return message!;
    });
  }

  /**
   * Change a message's data in place (a card kept or put aside): one change at a time per conversation,
   * and the open pages hear it. `change` returns the new data, or nothing to leave it as it is; it must
   * not post to the same conversation (that would wait for itself).
   */
  async changeMessage(
    companyId: string,
    messageId: string,
    change: (message: MessageRow) => Promise<Record<string, unknown> | undefined>,
  ): Promise<MessageRow> {
    const first = await this.message(companyId, messageId);
    if (!first) throw new ConversationError("There is no such message", 404);
    return this.serialized(first.conversationId, async () => {
      const current = (await this.message(companyId, messageId)) ?? first;
      const data = await change(current);
      if (!data) return current;
      const [updated] = await this.db.update(conversationMessages).set({ data }).where(eq(conversationMessages.id, messageId)).returning();
      await this.publishMessageUpdated(updated!);
      return updated!;
    });
  }

  /** The conversation a work-queue item belongs to: the one its run was asked in, or its task's. */
  async conversationOf(companyId: string, entry: QueueEntry): Promise<string | undefined> {
    if (entry.type === "approval") {
      const [approval] = await this.db.select({ runId: approvals.runId }).from(approvals).where(eq(approvals.id, entry.id));
      if (!approval?.runId) return undefined;
      const [run] = await this.db
        .select({ trigger: runs.trigger, triggerRef: runs.triggerRef, taskId: runs.taskId })
        .from(runs)
        .where(eq(runs.id, approval.runId));
      if (!run) return undefined;
      if (run.trigger === "conversation" && run.triggerRef) return run.triggerRef;
      if (run.taskId) return this.taskConversationId(companyId, run.taskId);
      return undefined;
    }
    const item = await this.deps.work.get(companyId, entry.id).catch(() => undefined);
    if (!item) return undefined;
    if (typeof item.data.conversationId === "string") return item.data.conversationId;
    if (item.taskId) return this.taskConversationId(companyId, item.taskId);
    return undefined;
  }

  private async taskConversationId(companyId: string, taskId: string): Promise<string | undefined> {
    const task = await this.deps.tasks.byId(taskId);
    if (!task || task.companyId !== companyId) return undefined;
    return (await this.forTask(companyId, task)).conversation.id;
  }

  /** A message naming things of the brain goes on their timelines (and a thing's own conversation always does). */
  private async recordInBrain(companyId: string, conversation: ConversationRow, message: MessageRow): Promise<void> {
    // What a person teaches the brain becomes know-how when they keep it, not a message on timelines.
    if (!this.deps.brain || message.kind === "card" || !message.text.trim() || message.data.intent === "teach") return;
    const things = new Set(message.mentions.filter((m) => m.allowed && m.kind === "thing").map((m) => m.id));
    if (conversation.kind === "thing" && conversation.aboutId) things.add(conversation.aboutId);
    if (!things.size) return;
    const email = message.author.kind === "person" ? (await this.deps.people.get(companyId, message.author.id).catch(() => undefined))?.email : undefined;
    await this.deps.brain.addEvent(
      companyId,
      {
        kind: "message",
        title: truncate(`${message.author.name} in ${placeName(conversation)}`, 300),
        body: truncate(plainText(message.text), 2000),
        about: [...things],
      },
      message.author.name,
      email ?? null,
      { origin: "chat", ref: message.id, place: "Chat", data: { conversationId: conversation.id, seq: message.seq } },
    );
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  /** Hear what happens in a conversation; `watcher` says who is reading (nothing is sent to them meanwhile). */
  subscribe(conversationId: string, listener: (event: ConversationEvent) => void, watcher: Actor | null = null): () => void {
    const set = this.listeners.get(conversationId) ?? new Map<(event: ConversationEvent) => void, Actor | null>();
    set.set(listener, watcher);
    this.listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(conversationId);
    };
  }

  /** Is anyone reading this conversation right now (a page with its stream open)? */
  /** Is anyone (or this actor) reading the conversation right now? */
  isWatched(conversationId: string, actor?: Pick<Actor, "kind" | "id">): boolean {
    const set = this.listeners.get(conversationId);
    if (!set?.size) return false;
    if (!actor) return true;
    for (const watcher of set.values()) if (watcher && watcher.kind === actor.kind && watcher.id === actor.id) return true;
    return false;
  }

  publish(conversationId: string, event: ConversationEvent): void {
    for (const fn of this.listeners.get(conversationId)?.keys() ?? []) {
      try {
        fn(event);
      } catch (error) {
        console.error("[conversations] subscriber:", error);
      }
    }
  }

  /** Hears every message posted (the turn planner decides which AI employee answers). */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Hears when a card in a conversation was handled (decided, answered, checked). */
  onCardResolved(listener: CardListener): () => void {
    this.cardListeners.add(listener);
    return () => this.cardListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // What an AI employee reads
  // -------------------------------------------------------------------------

  /**
   * New messages since an AI participant last read, as lines for its prompt, plus the cards of what
   * they name; marks them read.
   */
  async unreadFor(
    companyId: string,
    conversationId: string,
    ai: Actor,
    options: { max?: number; maxChars?: number } = {},
  ): Promise<{ lines: string[]; cards: string[]; upToSeq: number; mentions: Mention[] }> {
    const found = await this.get(companyId, conversationId);
    const me = found.participants.find((p) => p.actorKind === ai.kind && p.actorId === ai.id);
    const readSeq = me?.readSeq ?? 0;
    const fresh = (await this.messages(companyId, conversationId, { afterSeq: readSeq, limit: options.max ?? 40 })).filter(
      (m) => m.kind !== "card" && !(m.authorKind === ai.kind && m.authorId === ai.id),
    );
    const budget = options.maxChars ?? 12_000;
    let used = 0;
    const lines: string[] = [];
    for (const m of fresh) {
      const who = `${m.author.kind === "system" ? "Enterprise Brain" : m.author.name}${intentNote(m)}`;
      const text = truncate(m.text, 2000);
      const line = `[#${m.seq}] ${who}: ${m.kind === "system" ? `(${text})` : text}${m.fileIds.length ? ` [files: ${m.fileIds.join(", ")}]` : ""}`;
      used += line.length;
      if (used > budget) break;
      lines.push(line);
    }
    const mentions = fresh.flatMap((m) => m.mentions.filter((x) => x.allowed && !(x.kind === "ai_employee" && x.id === ai.id))) as Mention[];
    const cards = await this.deps.cards.cards(companyId, mentions);
    return { lines, cards, upToSeq: found.conversation.lastSeq, mentions };
  }

  /**
   * The task's history, as the conversation shows it: the AI employee's notes and its answer as its
   * messages; failed, waiting, stopped, paused and resumed as lines from the app. Cards come from the
   * work queue.
   */
  async mirrorTaskEvent(companyId: string, task: TaskRow, event: { type: string; message: string; actor: string; runId: string | null }): Promise<void> {
    const kinds = new Set(["note", "done", "failed", "waiting", "stopped", "paused", "resumed", "blocked"]);
    if (!kinds.has(event.type)) return;
    if ((event.type === "done" || event.type === "failed") && task.source === "chat" && task.sourceRef) await this.tellWhereGiven(companyId, task, event);
    const { conversation } = await this.forTask(companyId, task);
    if (event.type === "note" || event.type === "done") {
      // Its notes and its answer (else its outcome) are its own words in the conversation.
      const agent = await this.deps.agents.find(companyId, task.agentId);
      if (!agent) return;
      const text = event.type === "done" ? (task.answer ?? event.message.replace(/^Done:\s*/, "")) : event.message;
      if (text.trim()) await this.post(companyId, conversation.id, { author: agentActor(agent), text, runId: event.runId, data: { [event.type]: true } });
      return;
    }
    await this.postSystem(companyId, conversation.id, event.message, { taskEvent: event.type });
  }

  /**
   * Work given in a conversation ("Give as work"): when it is done, the AI employee answers where it was
   * given: in a channel or direct message in the thread under the message that gave it, in a talk or a
   * thread right there, replying to that message. When it fails, a line from the app says so.
   */
  private async tellWhereGiven(companyId: string, task: TaskRow, event: { type: string; message: string; runId?: string | null }): Promise<void> {
    const where = await this.find(companyId, task.sourceRef!).catch(() => undefined);
    if (!where) return;
    const outcome = event.message.replace(/^(Done|Failed):\s*/, "");
    const agent = event.type === "done" ? await this.deps.agents.find(companyId, task.agentId) : undefined;
    const giving = await this.givingMessage(companyId, where.conversation.id, task.id);
    let target = where.conversation.id;
    let replyToId = giving;
    if (giving && (where.conversation.kind === "channel" || where.conversation.kind === "dm")) {
      const root = await this.message(companyId, giving);
      if (root) {
        target = (await this.ensureThread(companyId, where, root)).conversation.id;
        replyToId = null;
      }
    }
    if (!agent) {
      const line = event.type === "done" ? `${task.ref} is done: ${outcome}` : `${task.ref} failed: ${outcome}`;
      await this.postSystem(companyId, target, truncate(line, 600), { task: { id: task.id, ref: task.ref }, taskEvent: event.type });
      return;
    }
    // No answersSeq: the turn planner leaves an answer to given work alone; a reply to it reaches the AI employee.
    await this.post(companyId, target, {
      author: agentActor(agent),
      text: task.answer ?? outcome,
      runId: event.runId ?? null,
      replyToId,
      data: { task: { id: task.id, ref: task.ref, title: task.title }, taskEvent: "done" },
    });
  }

  /**
   * The person's message that gave the work. It is written once the task has started, so an answer that
   * comes very fast (offline, or a short task) waits a moment for it, to come after it.
   */
  private async givingMessage(companyId: string, conversationId: string, taskId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await this.db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.companyId, companyId),
            eq(conversationMessages.conversationId, conversationId),
            eq(conversationMessages.authorKind, "person"),
            sql`${conversationMessages.data}->'task'->>'id' = ${taskId}`,
          ),
        )
        .limit(1);
      if (row) return row.id;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return null;
  }

  /** Did a run already leave a message here (its outcome, mirrored from the task)? */
  async hasMessageOfRun(companyId: string, conversationId: string, runId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.companyId, companyId), eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.runId, runId)))
      .limit(1);
    return Boolean(row);
  }

  /** For a task's brief: the comments people wrote in its conversation since the AI employee last read them. */
  async taskBriefExtras(task: TaskRow): Promise<string | undefined> {
    const existing = await this.findAbout(task.companyId, "task", task.id);
    if (!existing || existing.conversation.lastSeq === 0) return undefined;
    const ai = existing.participants.find((p) => p.actorKind === "ai_employee" && p.actorId === task.agentId);
    const me: Actor = { kind: "ai_employee", id: task.agentId, name: ai?.actorName ?? "AI employee" };
    const { lines, cards, upToSeq } = await this.unreadFor(task.companyId, existing.conversation.id, me);
    if (!lines.length && !cards.length) return undefined;
    if (ai) await this.markRead(existing.conversation.id, me, upToSeq);
    return [
      lines.length ? `New messages in the task's conversation since you last read it (your answer there is your final text):\n${lines.join("\n")}` : "",
      cards.length ? `Things named in these messages:\n\n${cards.join("\n\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * The free topics of before channels existed become channels, or a direct message when they were two
   * people's private talk (unless those two already have one: then a private channel). Idempotent.
   */
  async adoptTopics(companyId: string): Promise<number> {
    const topics = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, companyId), sql`${conversations.kind} = 'topic'`))
      .orderBy(asc(conversations.createdAt));
    for (const topic of topics) {
      const participants = await this.participantsOf(topic.id);
      const people = participants.filter((p) => p.actorKind === "person");
      if (topic.visibility === "participants" && people.length === 2 && participants.length === 2) {
        const dmKey = dmKeyOf(people.map(participantActor));
        if (!(await this.findByDmKey(companyId, dmKey))) {
          const title = people
            .map((p) => p.actorName)
            .sort((a, b) => a.localeCompare(b))
            .join(", ");
          await this.db.update(conversations).set({ kind: "dm", dmKey, title, updatedAt: new Date() }).where(eq(conversations.id, topic.id));
          await this.db.update(conversationParticipants).set({ role: "member" }).where(eq(conversationParticipants.conversationId, topic.id));
          continue;
        }
      }
      const name = await this.freeChannelName(companyId, topic.title || "topic");
      await this.db.update(conversations).set({ kind: "channel", name, updatedAt: new Date() }).where(eq(conversations.id, topic.id));
    }
    return topics.length;
  }

  // -------------------------------------------------------------------------
  // The older chat tables
  // -------------------------------------------------------------------------

  /**
   * The conversations people had with the company assistant and with AI employees ("Talk to it") before
   * conversations existed become conversations, with the same ids so old links still open. Idempotent.
   */
  async adoptLegacyChat(companyId: string): Promise<number> {
    const brain = await this.deps.agents.find(companyId, COMPANY_BRAIN_SLUG);
    const old = await this.db.select().from(chatConversations).where(eq(chatConversations.companyId, companyId));
    if (!old.length) return 0;
    const already = new Set(
      (
        await this.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            inArray(
              conversations.id,
              old.map((c) => c.id),
            ),
          )
      ).map((r) => r.id),
    );
    let adopted = 0;
    for (const chat of old) {
      if (already.has(chat.id)) continue;
      const agent = chat.agentId ? await this.deps.agents.find(companyId, chat.agentId) : brain;
      if (!agent) continue;
      const person = chat.userId ? await this.deps.people.get(companyId, chat.userId).catch(() => undefined) : undefined;
      const owner: Actor = person ? { kind: "person", id: person.id, name: person.name } : { kind: "person", id: "owner", name: "Owner" };
      const ai = agentActor(agent);
      const messages = await this.db.select().from(chatMessages).where(eq(chatMessages.conversationId, chat.id)).orderBy(asc(chatMessages.createdAt));
      await this.db.transaction(async (tx) => {
        await tx.insert(conversations).values({
          id: chat.id,
          companyId,
          kind: "ai_employee",
          aboutId: agent.row.id,
          title: chat.title === "New conversation" ? agent.definition.name : truncate(chat.title, 200),
          departmentId: agent.row.departmentId,
          visibility: "participants",
          createdBy: owner,
          lastSeq: messages.length,
          lastMessageAt: messages.at(-1)?.createdAt ?? chat.updatedAt,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        });
        await tx.insert(conversationParticipants).values([
          {
            companyId,
            conversationId: chat.id,
            actorKind: owner.kind,
            actorId: owner.id,
            actorName: owner.name,
            role: "owner",
            readSeq: messages.length,
            joinedAt: chat.createdAt,
          },
          {
            companyId,
            conversationId: chat.id,
            actorKind: ai.kind,
            actorId: ai.id,
            actorName: ai.name,
            role: "member",
            readSeq: messages.length,
            joinedAt: chat.createdAt,
          },
        ]);
        if (messages.length) {
          await tx.insert(conversationMessages).values(
            messages.map((m, i) => {
              const author = m.role === "assistant" ? ai : owner;
              return {
                companyId,
                conversationId: chat.id,
                seq: i + 1,
                kind: "text",
                author,
                authorKind: author.kind,
                authorId: author.id,
                text: m.content,
                data: { ...(Array.isArray(m.citations) && m.citations.length ? { citations: m.citations } : {}), ...m.data, legacy: true },
                createdAt: m.createdAt,
              };
            }),
          );
        }
      });
      adopted += 1;
    }
    return adopted;
  }
}

/** How a conversation is named in a sentence: "#finance", "a direct message", or its title in quotes. */
export function placeName(conversation: Pick<ConversationRow, "kind" | "name" | "title">): string {
  if (conversation.kind === "channel") return `#${conversation.name}`;
  if (conversation.kind === "dm") return "a direct message";
  if (conversation.kind === "thread") return `a thread (“${conversation.title || "a message"}”)`;
  return `“${conversation.title || "a conversation"}”`;
}

/** Where a conversation opens in the web app: a thread as its channel or direct message with the thread pane open. */
export function conversationPath(conversation: Pick<ConversationRow, "id" | "kind" | "parentId" | "aboutId">): string {
  if (conversation.kind === "thread" && conversation.parentId && conversation.aboutId)
    return `/chat/${conversation.parentId}?thread=${encodeURIComponent(conversation.aboutId)}`;
  return `/chat/${conversation.id}`;
}
