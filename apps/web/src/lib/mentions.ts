import { AppWindow, BookOpen, Bot, Brain, Calculator, FileText, ListChecks, Table2, UserRound, type LucideIcon } from "lucide-react";
import type { MentionHit, MentionKind, MessageMention } from "../types.ts";

/** `@[Name](kind:id)`: how a message's text names a person, an AI employee, a guest or an asset. */
export const MENTION_TOKEN = /@\[([^\]\n]{1,120})\]\((person|ai_employee|guest|thing|table|app|calculation|file|document|task):([A-Za-z0-9_.\-]{1,80})\)/g;

/** The link the Markdown component turns into a chip: `#mention?kind=…&id=…&href=…`. */
export const MENTION_LINK = "#mention?";

export const MENTION_ICONS: Record<MentionKind, LucideIcon> = {
  person: UserRound,
  ai_employee: Bot,
  guest: UserRound,
  thing: Brain,
  table: Table2,
  app: AppWindow,
  calculation: Calculator,
  file: FileText,
  document: BookOpen,
  task: ListChecks,
};

export const MENTION_LABELS: Record<MentionKind, string> = {
  person: "Person",
  ai_employee: "AI employee",
  guest: "Guest",
  thing: "In the brain",
  table: "Table",
  app: "App",
  calculation: "Calculation",
  file: "File",
  document: "Document",
  task: "Task",
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the person typed ("@Invoice Processor, look at @VBAK") with the names they picked turned into
 * tokens. Longest names first, so "Invoice Processor" is not cut by "Invoice"; a name they typed
 * without picking stays plain text.
 */
export function withTokens(text: string, picked: Pick<MentionHit, "kind" | "id" | "name">[]): string {
  const unique = new Map(picked.map((p) => [`${p.kind}:${p.id}`, p]));
  let out = text;
  for (const p of [...unique.values()].sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`@${escapeRegExp(p.name)}(?![\\p{L}\\p{N}])`, "gu"), `@[${p.name}](${p.kind}:${p.id})`);
  }
  return out;
}

/** Tokens → "@Name", for titles and previews. */
export function plainText(text: string): string {
  return text.replace(MENTION_TOKEN, "@$1");
}

/**
 * Tokens → markdown links the Markdown component draws as chips. A mention its author may not see
 * (`allowed: false`) stays plain text; one the page knows nothing about becomes a chip without a link.
 */
export function mentionsToMarkdown(text: string, mentions: MessageMention[] = []): string {
  if (!text.includes("@[")) return text;
  const known = new Map(mentions.map((m) => [`${m.kind}:${m.id}`, m]));
  return text.replace(MENTION_TOKEN, (_all, name: string, kind: string, id: string) => {
    const mention = known.get(`${kind}:${id}`);
    if (mention && !mention.allowed) return `@${name}`;
    const params = new URLSearchParams({ kind, id });
    if (mention?.href) params.set("href", mention.href);
    return `[@${name}](${MENTION_LINK}${params.toString()})`;
  });
}
