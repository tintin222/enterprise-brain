import { Bot, Brain, Hash, ListChecks, Sparkles, type LucideIcon } from "lucide-react";
import type { Actor, Conversation, ConversationKind, ConversationVisibility, Participant } from "../types.ts";

export const KIND_META: Record<ConversationKind, { label: string; icon: LucideIcon }> = {
  topic: { label: "Topic", icon: Hash },
  task: { label: "Task", icon: ListChecks },
  ai_employee: { label: "AI employee", icon: Bot },
  thing: { label: "In the brain", icon: Brain },
  studio: { label: "Studio", icon: Sparkles },
};

export const VISIBILITY_LABELS: Record<ConversationVisibility, string> = {
  participants: "Only its participants",
  department: "Its department",
  company: "Everyone in the company",
};

export function participantActor(p: Pick<Participant, "actorKind" | "actorId" | "actorName">): Actor {
  return { kind: p.actorKind, id: p.actorId, name: p.actorName };
}

export function sameActor(a: Pick<Actor, "kind" | "id">, b: Pick<Actor, "kind" | "id">): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Its title, else the others in it. */
export function conversationTitle(conversation: Conversation, participants: Participant[], me?: Actor | null): string {
  if (conversation.title) return conversation.title;
  const others = participants.filter((p) => p.status !== "revoked" && !(me && sameActor(participantActor(p), me))).map((p) => p.actorName);
  return others.join(", ") || "New conversation";
}

/** What the composer suggests, by what the conversation is. */
export function placeholderFor(conversation: Conversation, participants: Participant[]): string {
  const ai = participants.filter((p) => p.actorKind === "ai_employee").map((p) => p.actorName);
  switch (conversation.kind) {
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
