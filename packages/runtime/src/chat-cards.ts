import { truncate } from "@enterprise-brain/core";
import {
  describeChange,
  explanationOf,
  itemSubject,
  SUMMARY_LIST_LIMIT,
  type ItemMessage,
  type SummaryMessage,
  type TaskNewsMessage,
} from "./notification-templates.ts";
import type { QueueEntry } from "./queue.ts";

/**
 * Cards for chat apps, written once and drawn by each app (Adaptive Cards in Teams, cards in Google
 * Chat): what an item is, why the person is asked, what would change, and buttons to act.
 */

export type CardTone = "warning" | "good" | "attention" | "accent";

export type CardBlock =
  | { kind: "text"; text: string; style?: "subtle" | "strong" }
  /** A highlighted line: why a person is asked, or how an item was handled. */
  | { kind: "notice"; text: string; tone: CardTone }
  | { kind: "facts"; facts: { label: string; value: string }[] }
  /** Text shown as it is (an email's body). */
  | { kind: "quote"; text: string }
  | { kind: "input"; id: string; label?: string; placeholder?: string; multiline?: boolean }
  /** Options to choose from: radio buttons, or a drop-down (`compact`) for long lists; `value` is chosen at first. */
  | { kind: "choice"; id: string; label?: string; options: (string | { value: string; label: string })[]; value?: string; compact?: boolean }
  | { kind: "list"; heading?: string; items: { text: string; url?: string; detail?: string }[] };

/** A button: one that acts (sent back to the app with the card's inputs), or one that opens a page. */
export type CardAction =
  | { kind: "submit"; label: string; verb: string; data: Record<string, string>; style?: "positive" | "destructive" }
  | { kind: "open"; label: string; url: string };

export interface Card {
  /** One line: the preview of a notification, and the text where a card can't be shown. */
  summary: string;
  title: string;
  subtitle?: string;
  blocks: CardBlock[];
  actions: CardAction[];
}

/** What people can do with an item from a card, as the card sends it back. */
export type ItemVerb = "approve" | "reject" | "answer" | "dismiss" | "right" | "wrong" | "retry" | "seen";
export const ITEM_VERBS: ItemVerb[] = ["approve", "reject", "answer", "dismiss", "right", "wrong", "retry", "seen"];

const KIND_LABEL: Record<QueueEntry["type"], string> = {
  approval: "Approval",
  question: "Question",
  review: "Check",
  failure: "Stopped task",
  notice: "Notice",
};

function subtitleOf(entry: QueueEntry): string {
  return [KIND_LABEL[entry.type], entry.agent?.name, entry.task?.ref].filter(Boolean).join(" · ");
}

/** The change an approval would make: its system and fields, an email's recipients and text. */
function changeBlocks(entry: QueueEntry): CardBlock[] {
  const change = describeChange(entry.action);
  if (!change) return [];
  return [
    { kind: "text", text: change.heading, style: "strong" },
    ...(change.rows.length ? [{ kind: "facts" as const, facts: change.rows.map(([label, value]) => ({ label, value })) }] : []),
    ...(change.body ? [{ kind: "quote" as const, text: truncate(change.body, 1500) }] : []),
  ];
}

/** The card for one queue item: what it is and why the person is asked, with buttons to act. */
export function itemCard(message: ItemMessage): Card {
  const { entry, links } = message;
  const data = { eb: "act", type: entry.type, id: entry.id };
  const blocks: CardBlock[] = [];
  if (entry.reason) blocks.push({ kind: "notice", text: `Why you are asked: ${entry.reason}`, tone: "warning" });
  if (entry.suggestion) blocks.push({ kind: "text", text: `It suggests: ${entry.suggestion}` });
  const details = explanationOf(entry);
  if (details) blocks.push({ kind: "text", text: truncate(details, 1500) });
  blocks.push(...changeBlocks(entry));
  const actions: CardAction[] = [];
  switch (entry.type) {
    case "approval":
      blocks.push({ kind: "input", id: "note", placeholder: "Add a note (optional)" });
      actions.push(
        { kind: "submit", label: "Approve", verb: "approve", data, style: "positive" },
        { kind: "submit", label: "Reject", verb: "reject", data, style: "destructive" },
      );
      if (describeChange(entry.action)) actions.push({ kind: "open", label: "Correct it first", url: `${links.act}?choice=edit` });
      break;
    case "question":
      if (entry.options?.length) blocks.push({ kind: "choice", id: "choice", label: "Choose", options: entry.options });
      blocks.push({ kind: "input", id: "answer", placeholder: entry.options?.length ? "Or write your answer" : "Your answer", multiline: true });
      actions.push(
        { kind: "submit", label: "Send answer", verb: "answer", data, style: "positive" },
        { kind: "submit", label: "Dismiss", verb: "dismiss", data },
      );
      break;
    case "review":
      blocks.push({ kind: "input", id: "note", placeholder: "If it was wrong: what, in plain words" });
      actions.push(
        { kind: "submit", label: "Right", verb: "right", data, style: "positive" },
        { kind: "submit", label: "Wrong", verb: "wrong", data, style: "destructive" },
      );
      break;
    case "failure":
      actions.push({ kind: "submit", label: "Try again", verb: "retry", data, style: "positive" }, { kind: "submit", label: "Dismiss", verb: "dismiss", data });
      break;
    case "notice":
      actions.push({ kind: "submit", label: "Mark as seen", verb: "seen", data });
      break;
  }
  actions.push({ kind: "open", label: "Open in the app", url: links.open });
  return { summary: itemSubject(entry), title: entry.title, subtitle: subtitleOf(entry), blocks, actions };
}

/** How an item ended, in words: "Approved by Elif Arslan", "Answered by Burak Şahin: 4200". */
export function outcomeText(entry: Pick<QueueEntry, "type">, by: string, outcome: string): string {
  if (outcome.startsWith("withdrawn")) return "Withdrawn: the task was stopped";
  if (outcome === "dismissed") return `Dismissed by ${by}`;
  switch (entry.type) {
    case "approval":
      return outcome === "corrected and approved" ? `Corrected and approved by ${by}` : outcome === "rejected" ? `Rejected by ${by}` : `Approved by ${by}`;
    case "question":
      return `Answered by ${by}: ${truncate(outcome, 300)}`;
    case "review":
      return `Checked by ${by}: ${truncate(outcome, 300)}`;
    case "failure":
      return outcome === "Retried" ? `Tried again by ${by}` : `Handled by ${by}`;
    case "notice":
      return `Seen by ${by}`;
  }
}

/** A handled item's card: no buttons any more, and who handled it. */
export function handledCard(entry: QueueEntry, handled: { by: string; outcome: string }, openUrl?: string): Card {
  const text = outcomeText(entry, handled.by, handled.outcome);
  const tone: CardTone = /^(Rejected|Withdrawn|Dismissed)/.test(text) ? "attention" : "good";
  return {
    summary: `${text}: ${entry.title}`,
    title: entry.title,
    subtitle: subtitleOf(entry),
    blocks: [{ kind: "notice", text, tone }, ...changeBlocks(entry).slice(0, 2)],
    actions: openUrl ? [{ kind: "open", label: "Open in the app", url: openUrl }] : [],
  };
}

/** The morning summary: what needs the person, and what their AI employees did since yesterday. */
export function summaryCard(message: SummaryMessage): Card {
  const first = message.person.name.trim().split(/\s+/)[0] ?? message.person.name;
  const count = message.needsYou.length;
  const listed = message.needsYou.slice(0, SUMMARY_LIST_LIMIT);
  const blocks: CardBlock[] = [];
  if (count) {
    blocks.push({
      kind: "list",
      heading: `Needs you (${count})`,
      items: [
        ...listed.map(({ entry, link }) => ({
          text: entry.title,
          url: link,
          detail: [entry.agent?.name, entry.task?.ref].filter(Boolean).join(" · ") || undefined,
        })),
        ...(count > listed.length ? [{ text: `and ${count - listed.length} more in Work` }] : []),
      ],
    });
  } else {
    blocks.push({ kind: "text", text: "Nothing needs you right now." });
  }
  if (message.aiEmployees.length) {
    blocks.push({
      kind: "list",
      heading: "Your AI employees since yesterday",
      items: message.aiEmployees.map((a) => ({
        text: a.name,
        url: a.link,
        detail: [`${a.done} done`, a.started ? `${a.started} started` : "", a.needsPerson ? `${a.needsPerson} waiting for a person` : ""]
          .filter(Boolean)
          .join(" · "),
      })),
    });
  }
  const headline = count ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you` : "Your AI employees yesterday";
  return {
    summary: `Good morning, ${first}: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`,
    title: `Good morning, ${first}`,
    subtitle: headline,
    blocks,
    actions: [{ kind: "open", label: "Open Work", url: message.links.work }],
  };
}

/** News of a task the person gave in the chat: done, or stopped. */
export function taskNewsCard(message: TaskNewsMessage): Card {
  return {
    summary: `${message.task.ref}: ${message.text}`,
    title: message.text,
    subtitle: `${message.agentName} · ${message.task.ref}`,
    blocks: message.task.outcome ? [{ kind: "text", text: truncate(message.task.outcome, 1500) }] : [],
    actions: [{ kind: "open", label: "Open the task", url: message.link }],
  };
}

interface AgentChoice {
  slug: string;
  name: string;
  title?: string | null;
  summary?: string | null;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "about",
  "from",
  "that",
  "this",
  "please",
  "can",
  "you",
  "our",
  "their",
  "them",
  "they",
  "what",
  "when",
  "all",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map((w) => w.replace(/(ing|ers|ed|es|s)$/, "")),
  );
}

/** The AI employees whose name and job share the most words with a request, best first. */
export function rankAgents<T extends AgentChoice>(agents: T[], text: string): T[] {
  const wanted = words(text);
  const score = (a: AgentChoice) => [...words(`${a.name} ${a.title ?? ""} ${a.summary ?? ""}`)].filter((w) => wanted.has(w)).length;
  return agents
    .map((agent, index) => ({ agent, index, score: score(agent) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.agent);
}

/** Which AI employee should do a request, when it isn't clear from the message: the likeliest is chosen at first. */
export function pickAgentCard(agents: AgentChoice[], text: string): Card {
  const ranked = rankAgents(agents, text);
  return {
    summary: "Who should do this?",
    title: "Who should do this?",
    blocks: [
      { kind: "quote", text: truncate(text, 600) },
      {
        kind: "choice",
        id: "agent",
        label: "AI employee",
        options: agents.map((a) => ({ value: a.slug, label: a.name })),
        value: ranked[0]?.slug,
        compact: true,
      },
      { kind: "text", text: "Next time, start with its name, e.g. “AP Clerk, …”.", style: "subtle" },
    ],
    actions: [{ kind: "submit", label: "Give it the work", verb: "give", data: { eb: "give", text: truncate(text, 2000) }, style: "positive" }],
  };
}

/** Choose the AI employee the conversation's messages go to. */
export function talkToCard(agents: AgentChoice[], current?: { slug: string; name: string } | null): Card {
  return {
    summary: "Who do you want to talk to?",
    title: "Who do you want to talk to?",
    blocks: [
      { kind: "text", text: current ? `Your messages go to ${current.name} now.` : "Your messages go to the AI employee you choose.", style: "subtle" },
      {
        kind: "choice",
        id: "agent",
        label: "AI employee",
        options: agents.map((a) => ({ value: a.slug, label: a.name })),
        value: current?.slug ?? agents[0]?.slug,
        compact: true,
      },
    ],
    actions: [{ kind: "submit", label: "Talk to it", verb: "talk", data: { eb: "talk" }, style: "positive" }],
  };
}

/** The reply once work is given: who does it, its reference, and where to follow it. */
export function givenCard(task: { ref: string; title: string }, agentName: string, link: string): Card {
  return {
    summary: `${agentName} is on it: ${task.ref}`,
    title: `${agentName} is on it`,
    subtitle: task.ref,
    blocks: [
      { kind: "text", text: task.title },
      { kind: "text", text: "I'll tell you here when it's done or if it needs you.", style: "subtle" },
    ],
    actions: [{ kind: "open", label: "Follow it", url: link }],
  };
}

/** What the app does in the chat, and whom the person can give work to. */
export function helpCard(input: { firstName: string; agents: { name: string; summary?: string | null }[]; appUrl: string }): Card {
  return {
    summary: "What your AI employees can do here",
    title: `Hi ${input.firstName}, your AI employees work here with you`,
    blocks: [
      {
        kind: "text",
        text: "Give work by writing it, starting with who should do it, e.g. “AP Clerk, check this month's Kaya Çelik invoices against their orders.” Approvals and questions arrive here as cards, and a summary each morning.",
      },
      input.agents.length
        ? {
            kind: "list",
            heading: "Your AI employees",
            items: input.agents.slice(0, 12).map((a) => ({ text: a.name, detail: a.summary ? truncate(a.summary, 120) : undefined })),
          }
        : { kind: "text", text: "No AI employee works for your departments yet: a manager can hire one in the app." },
      { kind: "text", text: "Also: “what needs me” lists what waits for you; “switch” picks another AI employee.", style: "subtle" },
    ],
    actions: [{ kind: "open", label: "Open the app", url: input.appUrl }],
  };
}

/** A plain reply as a card: a title and some lines. */
export function textCard(title: string, lines: string[] = [], openUrl?: { label: string; url: string }): Card {
  return {
    summary: title,
    title,
    blocks: lines.map((text) => ({ kind: "text" as const, text })),
    actions: openUrl ? [{ kind: "open", label: openUrl.label, url: openUrl.url }] : [],
  };
}
