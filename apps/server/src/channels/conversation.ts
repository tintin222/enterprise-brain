import {
  audienceOf,
  givenCard,
  handledCard,
  helpCard,
  isOpen,
  ITEM_VERBS,
  itemCard,
  pickAgentCard,
  RunError,
  talkToCard,
  textCard,
  type AgentRecord,
  type Card,
  type ChannelAccountRow,
  type ChatChannelId,
  type ChatMessage,
  type ItemVerb,
  type Person,
  type Platform,
  type QueueEntry,
  type QueueItemType,
} from "@enterprise-brain/runtime";
import type { AuthService } from "../auth/service.ts";
import { canSeeDepartment, viewerFromPerson } from "../auth/viewer.ts";
import { statusFor } from "../http.ts";
import { actOnItem, type ItemAction } from "../work-actions.ts";

/** Who wrote, in which chat app, and where. */
export interface ChatContext {
  companyId: string;
  channel: ChatChannelId;
  account: ChannelAccountRow;
  /** The person they are; undefined when their chat account's email matches nobody. */
  person: Person | undefined;
  /** Their email in the chat app, when known (to tell them whom to ask). */
  email?: string | null;
}

/** A card to show instead of the one whose button was pressed, or a message while the card stays. */
export type ActionResult = { card: Card } | { error: string };

const HELP = /^(help|\?|hi|hello|hey|merhaba|selam|start)[.!]*$/i;
const NEEDS_ME = /^(what needs me|what's waiting|whats waiting|needs me|my work|work|queue)[?.!]*$/i;
const SWITCH = /^(switch|who|change|ai employees|agents|list)[?.!]*$/i;
const THANKS = /^(thanks|thank you|thx|ok|okay|great|👍|teşekkürler|tesekkurler|sağol|sagol)[.!]*$/i;
const ITEM_TYPES: QueueItemType[] = ["approval", "question", "review", "failure", "notice"];
const MAX_ITEMS = 5;

function firstName(person: Person): string {
  return person.name.trim().split(/\s+/)[0] ?? person.name;
}

function text(data: Record<string, unknown>, key: string): string {
  return typeof data[key] === "string" ? (data[key] as string).trim() : "";
}

/** A message that starts with an AI employee's name ("AP Clerk, check…", "@ap-clerk check…"): it and the rest. */
export function addressedTo(message: string, agents: AgentRecord[]): { agent: AgentRecord; rest: string } | undefined {
  const body = message.replace(/^@/, "");
  const lower = body.toLowerCase();
  let best: { agent: AgentRecord; length: number } | undefined;
  for (const agent of agents) {
    const names = [agent.definition.name, agent.row.slug, agent.row.slug.replace(/-/g, " "), agent.definition.title ?? ""].filter((n) => n.length >= 2);
    for (const name of names) {
      const n = name.toLowerCase();
      const next = lower.charAt(n.length);
      if (lower.startsWith(n) && (next === "" || /[\s,:;.!?—–-]/.test(next)) && (!best || n.length > best.length)) best = { agent, length: n.length };
    }
  }
  if (!best) return undefined;
  return {
    agent: best.agent,
    rest: body
      .slice(best.length)
      .replace(/^[\s,:;.!?—–-]+/, "")
      .trim(),
  };
}

/** How a handled item ended, for its card. */
function outcomeOf(entry: QueueEntry): string {
  if (entry.type === "approval") {
    if (entry.status === "cancelled") return "withdrawn";
    if (entry.status === "approved" && entry.action && "correctedBy" in entry.action) return "corrected and approved";
    return entry.status;
  }
  if (entry.status === "dismissed") return "dismissed";
  return entry.answer ?? "handled";
}

function actionFor(verb: ItemVerb, data: Record<string, unknown>): ItemAction {
  const note = text(data, "note") || undefined;
  switch (verb) {
    case "approve":
      return { choice: "approve", note };
    case "reject":
      return { choice: "reject", note };
    case "answer":
      return { answer: text(data, "answer") || text(data, "choice") || undefined };
    case "dismiss":
      return { dismiss: true };
    case "right":
      return { verdict: "right", note };
    case "wrong":
      return { verdict: "wrong", note };
    case "retry":
      return { retry: true };
    case "seen":
      return {};
  }
}

/**
 * Conversations with the app in a chat app, whichever it is: people give work in plain words (to the
 * AI employee they name, the one they talk to, or the one they pick), ask what needs them, and press
 * the buttons of the cards they got. The same rules as in the app apply.
 */
export class ChatConversations {
  constructor(
    private readonly platform: Platform,
    private readonly auth: AuthService,
  ) {}

  private get appUrl(): string {
    return this.platform.notifications.appUrl;
  }

  /** The reply to someone the app doesn't know, or whose account is off. */
  private stranger(ctx: ChatContext): ChatMessage | undefined {
    if (!ctx.person) {
      return {
        card: textCard("I don't know you yet", [
          `Ask your Enterprise Brain admin to add ${ctx.email ?? "your work email"} under Settings → People, then write to me again.`,
        ]),
      };
    }
    if (ctx.person.status !== "active") return { card: textCard("Your Enterprise Brain account is turned off", ["Ask your admin to turn it back on."]) };
    return undefined;
  }

  /** The AI employees a person may give work to: working or on trial, in departments they see. */
  async agentsFor(person: Person): Promise<AgentRecord[]> {
    const viewer = viewerFromPerson(person, await this.auth.openDepartmentIds(person.companyId));
    return (await this.platform.agents.list(person.companyId))
      .filter((a) => (a.row.status === "active" || a.row.status === "testing") && canSeeDepartment(viewer, a.row.departmentId))
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  /** The first message after someone installs the app, and the answer to "help". */
  async welcome(ctx: ChatContext): Promise<ChatMessage> {
    const stranger = this.stranger(ctx);
    if (stranger) return stranger;
    const agents = await this.agentsFor(ctx.person!);
    return {
      card: helpCard({
        firstName: firstName(ctx.person!),
        agents: agents.map((a) => ({ name: a.definition.name, summary: a.definition.summary })),
        appUrl: this.appUrl,
      }),
    };
  }

  async onText(ctx: ChatContext, message: string): Promise<ChatMessage[]> {
    const stranger = this.stranger(ctx);
    if (stranger) return [stranger];
    const work = message.replace(/<at>[^<]*<\/at>/g, "").trim();
    const plain = work.replace(/\s+/g, " ");
    if (!plain || HELP.test(plain)) return [await this.welcome(ctx)];
    if (THANKS.test(plain)) return [{ text: "You're welcome." }];
    if (NEEDS_ME.test(plain)) return this.needsMe(ctx);
    const agents = await this.agentsFor(ctx.person!);
    const current = agents.find((a) => a.row.id === ctx.account.agentId);
    if (SWITCH.test(plain)) {
      if (!agents.length) return [this.noAgents()];
      return [
        {
          card: talkToCard(
            agents.map((a) => ({ slug: a.row.slug, name: a.definition.name })),
            current ? { slug: current.row.slug, name: current.definition.name } : null,
          ),
        },
      ];
    }
    const named = addressedTo(work, agents);
    if (named) {
      if (named.rest.length < 3) {
        await this.platform.channelAccounts.talkTo(ctx.account.id, named.agent.row.id);
        return [{ card: textCard(`You're talking to ${named.agent.definition.name} now`, ["Write what it should do."]) }];
      }
      return [await this.give(ctx, named.agent, named.rest)];
    }
    if (plain.length < 3) return [await this.welcome(ctx)];
    if (current) return [await this.give(ctx, current, work)];
    if (agents.length === 1) return [await this.give(ctx, agents[0]!, work)];
    if (!agents.length) return [this.noAgents()];
    return [
      {
        card: pickAgentCard(
          agents.map((a) => ({ slug: a.row.slug, name: a.definition.name, title: a.definition.title, summary: a.definition.summary })),
          work,
        ),
      },
    ];
  }

  /** A button on a card: act on a queue item, give work to the AI employee picked, or talk to another one. */
  async onAction(ctx: ChatContext, verb: string, data: Record<string, unknown>): Promise<ActionResult> {
    const stranger = this.stranger(ctx);
    if (stranger) return { card: stranger.card! };
    const person = ctx.person!;
    if (data.eb === "give" || data.eb === "talk") {
      const agent = (await this.agentsFor(person)).find((a) => a.row.slug === text(data, "agent"));
      if (!agent) return { error: "That AI employee isn't available to you" };
      if (data.eb === "talk") {
        await this.platform.channelAccounts.talkTo(ctx.account.id, agent.row.id);
        return { card: textCard(`You're talking to ${agent.definition.name} now`, ["Write what it should do."]) };
      }
      const work = text(data, "text");
      if (work.length < 3) return { error: "Write what it should do" };
      const given = await this.give(ctx, agent, work);
      return { card: given.card! };
    }
    if (data.eb !== "act") return { error: "This button isn't for me" };
    const type = text(data, "type") as QueueItemType;
    if (!ITEM_TYPES.includes(type) || !ITEM_VERBS.includes(verb as ItemVerb)) return { error: "This button isn't for me" };
    const entry = await this.platform.queue.entry(ctx.companyId, type, text(data, "id"));
    if (!entry) return { error: "This item no longer exists" };
    const openUrl = this.platform.notifications.openUrl(entry);
    const handled = (item: QueueEntry) => ({ card: handledCard(item, { by: item.resolvedBy ?? "someone", outcome: outcomeOf(item) }, openUrl) });
    if (!isOpen(entry)) return handled(entry);
    try {
      return handled((await actOnItem(this.platform, person, entry, actionFor(verb as ItemVerb, data), ctx.channel)) ?? entry);
    } catch (error) {
      const status = statusFor(error);
      if (status === 409) return handled((await this.platform.queue.entry(ctx.companyId, type, entry.id)) ?? entry);
      if (status === 400 || status === 403) return { error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  /** Give work to an AI employee: it becomes a task, and news of it comes back here. */
  private async give(ctx: ChatContext, agent: AgentRecord, work: string): Promise<ChatMessage> {
    const person = ctx.person!;
    try {
      const run = await this.platform.engine.start(
        ctx.companyId,
        agent.row.id,
        {},
        {
          task: work,
          trigger: ctx.channel,
          triggerRef: ctx.account.id,
          actor: `${person.name} <${person.email}>`,
          requestedBy: person.name,
          wait: false,
        },
      );
      const task = await this.platform.tasks.get(ctx.companyId, run.taskId!);
      await this.platform.channelAccounts.talkTo(ctx.account.id, agent.row.id);
      return { card: givenCard(task, agent.definition.name, `${this.appUrl}/work/${encodeURIComponent(task.ref)}`) };
    } catch (error) {
      if (error instanceof RunError) return { card: textCard(`${agent.definition.name} can't take work right now`, [error.message]) };
      throw error;
    }
  }

  /** What waits for the person, newest first, as cards they can act on here. */
  private async needsMe(ctx: ChatContext): Promise<ChatMessage[]> {
    const person = ctx.person!;
    const people = await this.platform.people.list(ctx.companyId);
    const open = (await this.platform.queue.open(ctx.companyId)).filter((e) => audienceOf(e, people).some((p) => p.id === person.id)).reverse();
    const work = { label: "Open Work", url: `${this.appUrl}/work` };
    if (!open.length) return [{ card: textCard("Nothing needs you right now", [], work) }];
    const company = await this.platform.company(ctx.companyId);
    const cards: ChatMessage[] = open.slice(0, MAX_ITEMS).map((entry) => ({
      card: itemCard({
        companyId: ctx.companyId,
        companyName: company?.name ?? "Enterprise Brain",
        person,
        entry,
        links: this.platform.notifications.linksFor(person, entry, { via: ctx.channel }),
      }),
    }));
    if (open.length > MAX_ITEMS) cards.push({ card: textCard(`And ${open.length - MAX_ITEMS} more`, [], work) });
    return cards;
  }

  private noAgents(): ChatMessage {
    return {
      card: textCard("No AI employee works for your departments yet", ["A manager can hire one in the app."], { label: "Open the app", url: this.appUrl }),
    };
  }
}
