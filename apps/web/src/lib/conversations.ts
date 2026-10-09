import { Bot, Brain, Hash, ListChecks, MessageSquare, MessageSquareReply, Sparkles, type LucideIcon } from "lucide-react";
import type { Actor, Conversation, ConversationKind, ConversationSummary, ConversationVisibility, Participant } from "../types.ts";

export const KIND_META: Record<ConversationKind, { label: string; icon: LucideIcon }> = {
  channel: { label: "Channel", icon: Hash },
  dm: { label: "Direct message", icon: MessageSquare },
  thread: { label: "Thread", icon: MessageSquareReply },
  task: { label: "Task", icon: ListChecks },
  ai_employee: { label: "AI employee", icon: Bot },
  thing: { label: "In the brain", icon: Brain },
  studio: { label: "Studio", icon: Sparkles },
};

export const VISIBILITY_LABELS: Record<ConversationVisibility, string> = {
  participants: "Only its members",
  department: "Its department",
  company: "Everyone in the company",
};

/** The emoji a message can be reacted to with (the same list the server takes). */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "✅", "👀", "🙏", "🚀", "🤔", "👏", "🔥", "💯", "😮", "😢", "⏳", "❌"];

/** The built-in channel everyone is in. */
export const GENERAL_CHANNEL = "general";

/** The viewer's talk with the company brain (the sidebar pins it first). */
export function isCompanyBrainTalk(item: ConversationSummary): boolean {
  return item.conversation.kind === "ai_employee" && item.participants.some((p) => p.actorKind === "ai_employee" && p.actorName === "Company brain");
}

/** #general and the departments' channels: made by the app, they follow the company. */
export function isBuiltInChannel(conversation: Pick<Conversation, "kind" | "aboutId">): boolean {
  return conversation.kind === "channel" && Boolean(conversation.aboutId);
}

/** A channel name as the server will take it: lowercase, runs of anything else become one hyphen, at most 60 characters. */
export function channelName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function participantActor(p: Pick<Participant, "actorKind" | "actorId" | "actorName">): Actor {
  return { kind: p.actorKind, id: p.actorId, name: p.actorName };
}

export function sameActor(a: Pick<Actor, "kind" | "id">, b: Pick<Actor, "kind" | "id">): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** The others in a conversation, by name (a direct message is named after them). */
export function othersIn(participants: Pick<Participant, "actorKind" | "actorId" | "actorName">[], me?: Actor | null): string[] {
  return participants.filter((p) => !(me && sameActor(participantActor(p), me))).map((p) => p.actorName);
}

/** A channel as #name; a direct message as the others in it; the rest by their title. */
export function conversationTitle(conversation: Conversation, participants: Participant[], me?: Actor | null): string {
  if (conversation.kind === "channel") return `#${conversation.name ?? conversation.title}`;
  if (conversation.kind === "dm") return othersIn(participants, me).join(", ") || conversation.title || "Direct message";
  if (conversation.title) return conversation.title;
  return othersIn(participants, me).join(", ") || "New conversation";
}

/** What the composer suggests, by what the conversation is. */
export function placeholderFor(conversation: Conversation, participants: Participant[], me?: Actor | null): string {
  const ai = participants.filter((p) => p.actorKind === "ai_employee").map((p) => p.actorName);
  switch (conversation.kind) {
    case "channel":
      return `Message #${conversation.name ?? ""}. @ names a colleague or an AI employee`;
    case "dm":
      return `Message ${othersIn(participants, me).join(", ") || "them"}`;
    case "thread":
      return "Reply…";
    case "ai_employee":
      return `Message ${ai[0] ?? "the AI employee"}…`;
    case "task":
      return ai[0] ? `Write to colleagues, or to ${ai[0]}: it reads this on its next step` : "Write to colleagues about this task";
    case "thing":
      return "Ask @Company brain, or leave a note for colleagues";
    default:
      return "Write a message. @ names a person, an AI employee, or something of the company";
  }
}

/** "3 replies", "1 reply". */
export function repliesText(count: number): string {
  return count === 1 ? "1 reply" : `${count} replies`;
}
