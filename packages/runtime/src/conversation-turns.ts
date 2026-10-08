import type { BrainService } from "@enterprise-brain/brain";
import { actorString, isRecord, plainText, truncate, type Actor } from "@enterprise-brain/core";
import type { KnowledgeService } from "@enterprise-brain/knowledge";
import type { LlmClient } from "@enterprise-brain/llm";
import type { AgentRecord, AgentService } from "./agents.ts";
import { agentActor, participantActor, type ConversationRow, type ConversationService, type MessageRow, type ParticipantRow } from "./conversations.ts";
import { BudgetError, RunError, type RunEngine } from "./engine.ts";
import type { MentionCards } from "./mentions.ts";
import { offlineAnswer } from "./offline-answer.ts";
import type { PeopleService } from "./people.ts";
import type { QueueEntry } from "./queue.ts";
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

  constructor(private readonly deps: TurnPlannerDeps) {
    deps.conversations.onMessage((conversation, message, participants) => this.afterMessage(conversation, message, participants));
    deps.conversations.onCardResolved((conversation, message, entry, by) => this.afterCard(conversation, message, entry, by));
  }

  /** A message was posted: pick the AI employees that answer, and run their turns. */
  async afterMessage(conversation: ConversationRow, message: MessageRow, participants: ParticipantRow[]): Promise<void> {
    if (message.kind !== "text" || message.author.kind === "system") return;
    const named = message.mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id);
    const namedPeople = message.mentions.some((m) => m.allowed && m.kind === "person");
    let targets: string[] = [];
    let hop = 0;

    if (message.author.kind === "ai_employee") {
      // One AI employee answers another only when the person's message named both, and never a third time.
      if (Number(message.data.hop ?? 0) > 0 || typeof message.data.answersSeq !== "number") return;
      const origin = await this.deps.conversations.messageAt(conversation.companyId, conversation.id, message.data.answersSeq);
      if (!origin || origin.author.kind === "ai_employee") return;
      const both = new Set(origin.mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id));
      targets = named.filter((id) => both.has(id) && id !== message.author.id);
      hop = 1;
    } else {
      targets = named;
      if (!targets.length && !namedPeople) {
        if (conversation.kind === "ai_employee" && conversation.aboutId) targets = [conversation.aboutId];
        else if (conversation.kind === "task" && conversation.aboutId) {
          const task = await this.deps.tasks.byId(conversation.aboutId);
          if (task) targets = [task.agentId];
        } else if (message.replyToId) {
          const replied = await this.deps.conversations.message(conversation.companyId, message.replyToId);
          if (replied?.author.kind === "ai_employee") targets = [replied.author.id];
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

  private async turn(conversation: ConversationRow, agent: AgentRecord, turn: TurnInput): Promise<void> {
    const { companyId } = conversation;
    const ai = agentActor(agent);
    if (this.tooMany(conversation.id)) {
      const paused = this.pausedUntil.get(conversation.id) ?? 0;
      if (paused > Date.now() - 1000)
        await this.deps.conversations.postSystem(companyId, conversation.id, "AI employees paused here for an hour: too many replies in a row.", {
          paused: true,
        });
      return;
    }
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
    const text = outputTextOf(run.output);
    if (!text) return;
    await this.deps.conversations.post(companyId, conversation.id, {
      author: ai,
      text,
      runId: run.id,
      data: { answersSeq: turn.answersSeq, hop: turn.hop },
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
