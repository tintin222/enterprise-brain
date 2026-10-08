import { proposeLearning, type BrainService } from "@enterprise-brain/brain";
import { SYSTEM_ACTOR, actorString, isRecord, mentionToken, namesOnly, plainText, truncate, type Actor } from "@enterprise-brain/core";
import type { KnowledgeService } from "@enterprise-brain/knowledge";
import type { LlmClient } from "@enterprise-brain/llm";
import type { AgentRecord, AgentService } from "./agents.ts";
import { COMPANY_BRAIN_SLUG } from "./company-brain.ts";
import { agentActor, participantActor, type ConversationRow, type ConversationService, type MessageRow, type ParticipantRow } from "./conversations.ts";
import { BudgetError, RunError, type RunEngine } from "./engine.ts";
import type { MentionCards } from "./mentions.ts";
import { offlineAnswer } from "./offline-answer.ts";
import type { PeopleService } from "./people.ts";
import type { QueueEntry } from "./queue.ts";
import type { ConversationScope } from "./run-types.ts";
import type { TaskService } from "./tasks.ts";

export interface TurnPlannerDeps {
  conversations: ConversationService;
  engine: RunEngine;
  agents: AgentService;
  tasks: TaskService;
  people: PeopleService;
  cards: MentionCards;
  llm: LlmClient;
  knowledge: KnowledgeService;
  brain?: BrainService;
}

/** At most this many AI employees answer one message. */
const MAX_PER_MESSAGE = 3;
/** At most this many AI turns in a conversation per hour; then they pause there for an hour. */
const MAX_PER_HOUR = 20;
const HOUR = 3_600_000;

const KIND_WORDS: Record<string, string> = {
  topic: "a topic several people and AI employees share",
  task: "about a task",
  ai_employee: "a person talking with you",
  thing: "about one thing the company knows",
  studio: "a Studio thread",
};

/**
 * Who answers in a conversation, and when: like a polite colleague. An AI employee answers when it is
 * named, when the conversation is about it, or when someone replies to it; it never answers another AI
 * employee unless a person named both (and then that is the end of it). Each turn is a normal run, so
 * levels, approvals, costs and audit apply as always. Turns of one AI employee in one conversation go
 * one at a time; messages that arrive meanwhile are read by the next turn.
 */
export class TurnPlanner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, TurnInput>();
  private readonly recent = new Map<string, number[]>();
  private readonly pausedUntil = new Map<string, number>();
  private colleaguesOf?: (companyId: string, person: Actor) => Promise<AgentRecord[]>;

  constructor(private readonly deps: TurnPlannerDeps) {
    deps.conversations.onMessage((conversation, message, participants) => this.afterMessage(conversation, message, participants));
    deps.conversations.onCardResolved((conversation, message, entry, by) => this.afterCard(conversation, message, entry, by));
  }

  /**
   * How to find the AI employees a person may see (the server knows departments and the open ones). An AI
   * employee hands a matter over only to those; without it, nothing is handed over.
   */
  useColleagues(find: (companyId: string, person: Actor) => Promise<AgentRecord[]>): void {
    this.colleaguesOf = find;
  }

  /** A message was posted: pick the AI employees that answer, and run their turns. */
  async afterMessage(conversation: ConversationRow, message: MessageRow, participants: ParticipantRow[]): Promise<void> {
    if (message.kind !== "text" || message.author.kind === "system") return;
    // Taught to the brain: it says what it understood, as a card. Given as work: the task does it.
    if (message.data.intent === "teach") return this.track(`learn:${message.id}`, this.learnTurn(conversation, message));
    if (message.data.intent) return;
    const named = message.mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id);
    const namedPeople = message.mentions.some((m) => m.allowed && m.kind === "person");
    let targets: string[] = [];
    let hop = 0;

    if (message.author.kind === "ai_employee") {
      // One AI employee answers another only when the person's message named both, and never a third time.
      if (Number(message.data.hop ?? 0) > 0 || typeof message.data.answersSeq !== "number") return;
      const origin = await this.deps.conversations.messageAt(conversation.companyId, conversation.id, message.data.answersSeq);
      if (!origin || origin.author.kind === "ai_employee") return;
      // A hand-over: the colleague answers the person's message, once (its reply is the last hop).
      const handOver = message.data.handOver as { to?: { id?: string }; reason?: string } | undefined;
      if (handOver?.to?.id) {
        const colleague = origin.author.kind === "person" ? await this.deps.agents.find(conversation.companyId, handOver.to.id) : undefined;
        if (colleague) {
          const decision = `${message.author.name} handed you ${origin.author.name}'s message #${origin.seq}: “${truncate(plainText(origin.text), 600)}”${handOver.reason ? `. Why: ${handOver.reason}` : ""}`;
          void this.schedule(conversation, colleague, { answersSeq: origin.seq, hop: 1, actor: actorString(origin.author as Actor), decision });
        }
        return;
      }
      const both = new Set(origin.mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id));
      targets = named.filter((id) => both.has(id) && id !== message.author.id);
      hop = 1;
    } else {
      targets = named;
      if (!targets.length && !namedPeople) {
        // A reply goes to the AI employee replied to (in a talk too: one that was handed the matter);
        // otherwise to the AI employee the talk or the task is about.
        const replied =
          message.replyToId && conversation.kind !== "task" ? await this.deps.conversations.message(conversation.companyId, message.replyToId) : undefined;
        if (replied?.author.kind === "ai_employee") targets = [replied.author.id];
        else if (conversation.kind === "ai_employee" && conversation.aboutId) targets = [conversation.aboutId];
        else if (conversation.kind === "task" && conversation.aboutId) {
          const task = await this.deps.tasks.byId(conversation.aboutId);
          if (task) targets = [task.agentId];
        }
      }
    }
    targets = [...new Set(targets)].slice(0, MAX_PER_MESSAGE);
    for (const aiId of targets) {
      const agent = await this.deps.agents.find(conversation.companyId, aiId);
      if (!agent) continue;
      void this.schedule(conversation, agent, { answersSeq: message.seq, hop, actor: actorString(message.author as Actor) });
    }
  }

  /** A card in a conversation was handled: the AI employee that asked hears the answer (task conversations wake through their task). */
  async afterCard(conversation: ConversationRow, _message: MessageRow, entry: QueueEntry, by: string): Promise<void> {
    if (conversation.kind === "task" || !entry.agent || entry.status === "pending" || entry.status === "open") return;
    const agent = await this.deps.agents.find(conversation.companyId, entry.agent.id);
    if (!agent) return;
    const verb =
      entry.type === "approval"
        ? entry.status === "approved"
          ? "approved"
          : entry.status === "rejected"
            ? "rejected"
            : entry.status
        : entry.status === "dismissed"
          ? "dismissed"
          : "answered";
    const line = `${by} ${verb} "${entry.title}"${entry.answer ? `: ${entry.answer}` : ""}`;
    void this.schedule(conversation, agent, { answersSeq: conversation.lastSeq, hop: 0, actor: by, decision: line });
  }

  /** One turn at a time per AI employee and conversation; a message during a turn means one more turn after it. */
  private async schedule(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<void> {
    const key = `${conversation.id}:${agent.row.id}`;
    if (this.running.has(key)) {
      // The latest request stands for all that arrive during a turn: one more turn reads everything new.
      this.pending.set(key, turn);
      return;
    }
    const run = this.turn(conversation, agent, turn)
      .catch((error) => console.error("[conversations] turn:", error))
      .finally(() => {
        this.running.delete(key);
        const next = this.pending.get(key);
        this.pending.delete(key);
        if (next) void this.schedule(conversation, agent, next);
      });
    this.running.set(key, run);
    await run;
  }

  /** Work that is not a turn of the queue (reading what was taught), kept until done so `idle` waits for it. */
  private track(key: string, work: Promise<void>): Promise<void> {
    const run = work.catch((error) => console.error("[conversations] turn:", error)).finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  /** Resolves once the turns under way are done, or after the given time (a model call can be long). */
  async idle(timeoutMs = 5_000): Promise<void> {
    if (!this.running.size) return;
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
  }

  private tooMany(conversationId: string): boolean {
    const now = Date.now();
    const paused = this.pausedUntil.get(conversationId);
    if (paused && paused > now) return true;
    const times = (this.recent.get(conversationId) ?? []).filter((t) => now - t < HOUR);
    if (times.length >= MAX_PER_HOUR) {
      this.pausedUntil.set(conversationId, now + HOUR);
      return true;
    }
    times.push(now);
    this.recent.set(conversationId, times);
    return false;
  }

  /** Too many AI turns here this hour: say so once, and do nothing more for an hour. */
  private async paused(conversation: ConversationRow): Promise<boolean> {
    if (!this.tooMany(conversation.id)) return false;
    const paused = this.pausedUntil.get(conversation.id) ?? 0;
    if (paused > Date.now() - 1000)
      await this.deps.conversations.postSystem(conversation.companyId, conversation.id, "AI employees paused here for an hour: too many replies in a row.", {
        paused: true,
      });
    return true;
  }

  private async turn(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<void> {
    const { companyId } = conversation;
    const ai = agentActor(agent);
    if (conversation.status !== "open") return;
    if (await this.paused(conversation)) return;
    this.deps.conversations.publish(conversation.id, { type: "working", actor: ai, on: true });
    try {
      if (conversation.kind === "task" && conversation.aboutId) await this.taskTurn(conversation, agent, turn);
      else await this.conversationTurn(conversation, agent, turn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BudgetError || error instanceof RunError) {
        await this.deps.conversations.postSystem(companyId, conversation.id, `${ai.name} can't answer now: ${message}`, { error: true });
      } else {
        console.error("[conversations] turn failed:", error);
        await this.deps.conversations.postSystem(companyId, conversation.id, `${ai.name} couldn't answer: ${truncate(message, 300)}`, { error: true });
      }
    } finally {
      this.deps.conversations.publish(conversation.id, { type: "working", actor: ai, on: false });
    }
  }

  /**
   * "Teach the brain": the company brain reads what a person told it and says, as a card, what it would
   * add or change; the person keeps what is right. Without a model the words are kept as know-how.
   */
  private async learnTurn(conversation: ConversationRow, message: MessageRow): Promise<void> {
    const { companyId } = conversation;
    const brain = this.deps.brain;
    if (!brain || conversation.status !== "open") return;
    const agent = await this.deps.agents.find(companyId, COMPANY_BRAIN_SLUG);
    const author: Actor = agent ? agentActor(agent) : SYSTEM_ACTOR;
    if (await this.paused(conversation)) return;
    this.deps.conversations.publish(conversation.id, { type: "working", actor: author, on: true });
    try {
      // What the conversation is about is what they look at; the things they named with "@" come along.
      const named = message.mentions.filter((m) => m.allowed && m.kind === "thing").map((m) => ({ id: m.id, name: m.name }));
      const about = conversation.kind === "thing" && conversation.aboutId ? conversation.aboutId : undefined;
      const words = namesOnly(message.text);
      const proposal = await proposeLearning(brain, this.deps.llm, companyId, words, about, { named }).catch((error: unknown) => {
        console.error("[conversations] learning:", error);
        return proposeLearning(brain, this.deps.llm, companyId, words, about, { named, offline: true });
      });
      await this.deps.conversations.postDataCard(companyId, conversation.id, {
        author,
        type: "learning",
        id: message.id,
        text: proposal.understood || "What the company brain understood",
        replyToId: message.id,
        data: {
          learning: {
            by: message.author,
            forSeq: message.seq,
            about: about ?? null,
            understood: proposal.understood,
            offline: proposal.offline,
            changes: proposal.changes,
            status: "open",
          },
        },
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.deps.conversations.postSystem(companyId, conversation.id, `The company brain couldn't read that: ${truncate(text, 300)}`, { error: true });
    } finally {
      this.deps.conversations.publish(conversation.id, { type: "working", actor: author, on: false });
    }
  }

  /** A turn in a topic, a talk or a thing's conversation: a run with no task, whose final text is the message. */
  private async conversationTurn(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<void> {
    const { companyId } = conversation;
    const ai = agentActor(agent);
    const { participants } = await this.deps.conversations.get(companyId, conversation.id);
    const unread = await this.deps.conversations.unreadFor(companyId, conversation.id, ai);
    if (!unread.lines.length && !turn.decision) return;
    if (!this.deps.llm.available) {
      // No model: the closest things and passages for what was asked, as the AI employee's message (no run).
      await this.deps.conversations.markRead(conversation.id, ai, unread.upToSeq);
      if (turn.decision) return;
      const origin = await this.deps.conversations.messageAt(companyId, conversation.id, turn.answersSeq);
      const question = plainText(origin?.text ?? unread.lines.join("\n"));
      const answer = await offlineAnswer({ knowledge: this.deps.knowledge, brain: this.deps.brain }, companyId, agent.definition, question);
      await this.deps.conversations.post(companyId, conversation.id, {
        author: ai,
        text: answer.text,
        data: { answersSeq: turn.answersSeq, hop: turn.hop, offline: true },
      });
      return;
    }
    const brief = await this.brief(conversation, participants, ai, unread, turn);
    const colleagues = await this.colleaguesFor(conversation, agent, turn);
    const run = await this.deps.engine.start(
      companyId,
      agent.row.id,
      {},
      {
        trigger: "conversation",
        triggerRef: conversation.id,
        task: brief,
        wait: true,
        actor: turn.actor,
        conversation: {
          id: conversation.id,
          upToSeq: unread.upToSeq,
          participants: participants.filter((p) => p.actorKind !== "ai_employee").map((p) => ({ kind: p.actorKind, id: p.actorId, name: p.actorName })),
          ...(colleagues.length ? { colleagues } : {}),
        },
      },
    );
    await this.deps.conversations.markRead(conversation.id, ai, unread.upToSeq);
    if (run.status === "failed") {
      await this.deps.conversations.postSystem(companyId, conversation.id, `${ai.name} couldn't answer: ${truncate(run.error ?? "it failed", 300)}`, {
        error: true,
        runId: run.id,
      });
      return;
    }
    const handOver = handOverOf(run.output);
    if (handOver) return this.handOver(conversation, agent, turn, handOver, run.id);
    const text = outputTextOf(run.output);
    if (!text) return;
    await this.deps.conversations.post(companyId, conversation.id, {
      author: ai,
      text,
      runId: run.id,
      data: { answersSeq: turn.answersSeq, hop: turn.hop },
    });
  }

  /**
   * Who it may hand the matter to: only on a turn answering a person's message (not a hop, not a decision),
   * AI employees at work or on trial that this person may see, other than itself and those the message named.
   */
  private async colleaguesFor(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<NonNullable<ConversationScope["colleagues"]>> {
    if (!this.colleaguesOf || turn.hop !== 0 || turn.decision) return [];
    const origin = await this.deps.conversations.messageAt(conversation.companyId, conversation.id, turn.answersSeq);
    if (!origin || origin.author.kind !== "person") return [];
    const named = new Set(origin.mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id));
    const sameDepartment = (a: AgentRecord) => Number(a.row.departmentId === agent.row.departmentId);
    return (await this.colleaguesOf(conversation.companyId, origin.author as Actor))
      .filter((a) => a.row.id !== agent.row.id && !named.has(a.row.id))
      .sort((a, b) => sameDepartment(b) - sameDepartment(a) || a.definition.name.localeCompare(b.definition.name))
      .slice(0, 25)
      .map((a) => ({ id: a.row.id, slug: a.row.slug, name: a.definition.name, title: a.definition.title ?? "", summary: a.definition.summary ?? "" }));
  }

  /** The AI employee passed the matter on: the colleague joins, and its message says to whom and why (the colleague answers next). */
  private async handOver(
    conversation: ConversationRow,
    from: AgentRecord,
    turn: TurnInput,
    handOver: { to: { id: string }; reason: string },
    runId: string,
  ): Promise<void> {
    const { companyId } = conversation;
    const colleague = await this.deps.agents.find(companyId, handOver.to.id);
    if (!colleague || (colleague.row.status !== "active" && colleague.row.status !== "testing")) {
      await this.deps.conversations.postSystem(
        companyId,
        conversation.id,
        `${from.definition.name} wanted to hand this over, but ${colleague?.definition.name ?? "that AI employee"} is not at work.`,
        { error: true, runId },
      );
      return;
    }
    const to = agentActor(colleague);
    await this.deps.conversations.addParticipant(companyId, conversation.id, to, { invitedBy: agentActor(from) });
    await this.deps.conversations.post(companyId, conversation.id, {
      author: agentActor(from),
      text: `Handing this over to ${mentionToken({ kind: "ai_employee", id: to.id, name: to.name })}: ${handOver.reason || "it is theirs to answer."}`,
      runId,
      data: { answersSeq: turn.answersSeq, hop: 0, handOver: { to, reason: handOver.reason } },
    });
  }

  /** A comment in a task's conversation wakes the task; the run's final text is the AI employee's message there. */
  private async taskTurn(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<void> {
    const { companyId } = conversation;
    const ai = agentActor(agent);
    const task = await this.deps.tasks.byId(conversation.aboutId!);
    if (!task) return;
    const me = await this.deps.conversations.participantOf(conversation.id, ai);
    const fresh = (await this.deps.conversations.messages(companyId, conversation.id, { afterSeq: me?.readSeq ?? 0, limit: 40 })).filter(
      (m) => m.kind === "text" && m.author.kind !== "ai_employee" && m.author.kind !== "system",
    );
    if (!fresh.length) return;
    const before = (await this.deps.tasks.runsOf(task.id)).length;
    try {
      await this.deps.engine.wakeTask(
        companyId,
        task.id,
        {
          kind: "message",
          messages: fresh.map((m) => ({ seq: m.seq, author: m.author.name, text: truncate(m.text, 2000) })),
        },
        { wait: true, actor: turn.actor },
      );
    } catch (error) {
      if (error instanceof RunError && /paused/.test(error.message)) {
        await this.deps.conversations.postSystem(companyId, conversation.id, `The task is paused: ${ai.name} will read this when it is resumed.`);
        return;
      }
      if (error instanceof RunError && /working/.test(error.message)) return; // Its next turn reads the comment.
      throw error;
    }
    const runs = await this.deps.tasks.runsOf(task.id);
    const latest = runs.length > before ? runs.at(-1) : undefined;
    if (!latest || latest.status !== "succeeded") return;
    // A task that finished says its outcome in the conversation itself (mirrored from its history): nothing to add.
    const after = await this.deps.tasks.byId(task.id);
    if (after?.status === "done" || (await this.deps.conversations.hasMessageOfRun(companyId, conversation.id, latest.id))) return;
    const text = outputTextOf(latest.output);
    if (text)
      await this.deps.conversations.post(companyId, conversation.id, { author: ai, text, runId: latest.id, data: { answersSeq: turn.answersSeq, hop: 0 } });
  }

  /** What the AI employee reads for a turn: where it is, who is there, what is new, what was named. */
  private async brief(
    conversation: ConversationRow,
    participants: ParticipantRow[],
    ai: Actor,
    unread: { lines: string[]; cards: string[] },
    turn: TurnInput,
  ): Promise<string> {
    const people = await this.deps.people.list(conversation.companyId).catch(() => []);
    const titles = new Map(people.map((p) => [p.id, p.title]));
    const who = participants.map((p) => {
      if (p.actorKind === "ai_employee") return p.actorId === ai.id ? `${p.actorName} (you)` : `${p.actorName} (AI employee)`;
      const title = titles.get(p.actorId);
      return `${p.actorName} (person${title ? ` · ${title}` : ""})`;
    });
    const about =
      conversation.kind === "thing" && conversation.aboutId
        ? await this.deps.cards.card(conversation.companyId, { kind: "thing", id: conversation.aboutId, name: conversation.title }).catch(() => undefined)
        : undefined;
    return [
      `You are in the conversation "${conversation.title || "(untitled)"}" (${KIND_WORDS[conversation.kind] ?? conversation.kind}).`,
      `Participants: ${who.join(", ")}.`,
      ...(about ? ["", "It is about:", about] : []),
      ...(turn.decision ? ["", "What just happened:", turn.decision] : []),
      "",
      unread.lines.length ? "New messages since you last read (oldest first):" : "No new messages.",
      ...unread.lines,
      ...(unread.cards.length ? ["", "Things named in these messages:", "", ...unread.cards.flatMap((c) => [c, ""])] : []),
      "",
      "Your answer is your message in the conversation. Keep it short, answer only what is for you, and name people and things as @[Name](kind:id) when you point at them.",
    ].join("\n");
  }
}

interface TurnInput {
  /** The message that caused the turn (the AI employee's reply says which). */
  answersSeq: number;
  /** 0 after a person's message; 1 after another AI employee's (the last hop). */
  hop: number;
  actor: string;
  /** A decision or answer that caused the turn, in words. */
  decision?: string;
}

/** The colleague a run handed the matter to (conversation_hand_over), if it did. */
function handOverOf(output: unknown): { to: { id: string }; reason: string } | undefined {
  if (!isRecord(output) || !isRecord(output.handOver) || !isRecord(output.handOver.to)) return undefined;
  const id = output.handOver.to.id;
  return typeof id === "string" ? { to: { id }, reason: typeof output.handOver.reason === "string" ? output.handOver.reason : "" } : undefined;
}

/** The text a run ends with (its final step's `text`), or nothing. */
export function outputTextOf(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  for (const key of ["text", "answer", "summary", "result"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export { participantActor };
