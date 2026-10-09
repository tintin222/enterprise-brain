import { z } from "zod";

/**
 * Conversations: channels, direct messages and threads for people and AI employees, and the
 * conversations about a task, an AI employee or a thing of the brain. Messages name people and
 * assets with "@" mentions, written in the text as tokens so an AI can reach what was named.
 */

/**
 * channel: a named place its members share · dm: a direct message between a few people · thread: the replies
 * under one message · task, ai_employee (a person's talk with one), thing: about that · studio: a Studio thread.
 */
export const CONVERSATION_KINDS = ["channel", "dm", "thread", "task", "ai_employee", "thing", "studio"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** A channel's name ("finance", shown as #finance): lowercase letters and digits of any script, hyphens between, up to 60. */
export const CHANNEL_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,58}[\p{L}\p{N}])?$/u;

export function isChannelName(name: string): boolean {
  return CHANNEL_NAME.test(name) && name === name.toLowerCase() && !name.includes("--");
}

/** Words as a channel name: lowercase, runs of anything else become one hyphen, at most 60 characters. */
export function channelName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** The emoji a message can be reacted to with (the picker offers these, the server takes no others). */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "✅", "👀", "🙏", "🚀", "🤔", "👏", "🔥", "💯", "😮", "😢", "⏳", "❌"] as const;

/** The emoji as the list spells it (a heart with or without its variation selector is the same heart), or nothing. */
export function reactionEmoji(text: string): string | undefined {
  const bare = (s: string) => s.normalize("NFC").replace(/\uFE0F/g, "");
  return REACTION_EMOJI.find((e) => bare(e) === bare(text));
}

/** participants: only the people in it · department: everyone of its department · company: everyone signed in. */
export const CONVERSATION_VISIBILITIES = ["participants", "department", "company"] as const;
export type ConversationVisibility = (typeof CONVERSATION_VISIBILITIES)[number];

/** text: someone wrote it · system: the app says what happened · card: an approval, question, check or failure to act on. */
export const MESSAGE_KINDS = ["text", "system", "card"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MENTION_KINDS = ["person", "ai_employee", "thing", "table", "app", "calculation", "file", "document", "task"] as const;
export const MentionKind = z.enum(MENTION_KINDS);
export type MentionKind = z.infer<typeof MentionKind>;

/** A mention as stored with a message: `allowed` says whether its author could see the asset (an AI only gets allowed ones). */
export const Mention = z.object({
  kind: MentionKind,
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  allowed: z.boolean().default(true),
});
export type Mention = z.infer<typeof Mention>;
export type MentionRef = Pick<Mention, "kind" | "id" | "name">;

/** A mention in a message's text: `@[Invoice Processor](ai_employee:3f2a…)`, `@[VBAK](thing:…)`. */
export const MENTION_TOKEN = /@\[([^\]\n]{1,120})\]\((person|ai_employee|thing|table|app|calculation|file|document|task):([A-Za-z0-9_.\-]{1,80})\)/g;

export function mentionToken(mention: MentionRef): string {
  const name =
    mention.name
      .replace(/[[\]\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || mention.kind;
  return `@[${name}](${mention.kind}:${mention.id})`;
}

/** The mentions in a text, each once, in the order they appear. */
export function parseMentions(text: string): MentionRef[] {
  const seen = new Set<string>();
  const found: MentionRef[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const [, name, kind, id] = match;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind: kind as MentionKind, id: id!, name: name!.trim() });
  }
  return found;
}

/** The text with its tokens as plain "@Name": for emails, the brain's timeline and the audit log. */
export function plainText(text: string): string {
  return text.replace(MENTION_TOKEN, (_token, name: string) => `@${name.trim()}`);
}

/** The text with its tokens as the bare names, as a sentence reads: what a model reads as plain words. */
export function namesOnly(text: string): string {
  return text.replace(MENTION_TOKEN, (_token, name: string) => name.trim());
}

/** Does the text mention this one? */
export function mentions(text: string, mention: Pick<MentionRef, "kind" | "id">): boolean {
  return parseMentions(text).some((m) => m.kind === mention.kind && m.id === mention.id);
}
