import type { LlmClient } from "@enterprise-brain/llm";

/** An email as the reader sees it: who, what, when, and its words. */
export interface PersonalMail {
  id: string;
  threadId: string | null;
  from: string;
  subject: string;
  receivedAt: string | null;
  labels: string[];
  body: string;
  preview: string;
}

/** What the reader decided about one email. */
export interface MailTask {
  id: string;
  needsAction: boolean;
  title: string;
  details: string;
  /** A day, YYYY-MM-DD. */
  due: string | null;
  projectId: string | null;
  reason: string;
}

export interface MailReadContext {
  person: { name: string; email: string | null };
  projects: { id: string; name: string; summary: string }[];
  /** Senders the person said make no tasks ("Not a task"). */
  quietSenders: string[];
}

/** Automatic mail: nobody is waiting for an answer. */
export const AUTOMATIC_SENDER =
  /no-?reply|do-?not-?reply|notifications?|newsletter|mailer|bounce|digest|alerts?|postmaster|mailer-daemon|calendar-notification/i;
export const AUTOMATIC_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

/** "Ayşe Yılmaz <ayse@petrokim.example>" → the name and the address. */
export function senderOf(from: string): { name: string; address: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (match) return { name: match[1]!.trim(), address: match[2]!.trim().toLowerCase() };
  const address = from.trim().toLowerCase();
  return { name: "", address };
}

function isQuiet(message: PersonalMail, quiet: string[]): boolean {
  const { address } = senderOf(message.from);
  return quiet.some((q) => q.toLowerCase() === address);
}

function isAutomatic(message: PersonalMail): boolean {
  const { address } = senderOf(message.from);
  return !address || AUTOMATIC_SENDER.test(address) || message.labels.some((l) => AUTOMATIC_LABELS.includes(l));
}

/** Without Claude: every email from a person is something to answer; automatic mail makes nothing. */
export function offlineMailTask(message: PersonalMail, ctx: MailReadContext): MailTask {
  const none = (reason: string): MailTask => ({ id: message.id, needsAction: false, title: "", details: "", due: null, projectId: null, reason });
  if (isQuiet(message, ctx.quietSenders)) return none("The person asked for no tasks from this sender");
  if (isAutomatic(message)) return none("Automatic mail");
  const { name, address } = senderOf(message.from);
  const subject = message.subject.trim() || "(no subject)";
  return {
    id: message.id,
    needsAction: true,
    title: `Reply to ${name || address}: ${subject}`.slice(0, 300),
    details: (message.preview || message.body).replace(/\s+/g, " ").trim().slice(0, 300),
    due: null,
    projectId: null,
    reason: "An email from a person",
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "needs_action", "title", "details", "due", "project", "reason"],
        properties: {
          id: { type: "string", description: "The email's id, as given" },
          needs_action: { type: "boolean", description: "True when the person must answer, decide, send or do something" },
          title: { type: "string", description: "The task, as a short imperative sentence; empty when nothing is needed" },
          details: { type: "string", description: "What and why, in one or two sentences; empty when nothing is needed" },
          due: { type: ["string", "null"], description: "When it is needed as YYYY-MM-DD, only when the email names a date; else null" },
          project: { type: ["string", "null"], description: "The name of one of the person's projects when the email is clearly about it; else null" },
          reason: { type: "string", description: "Why, in a few words" },
        },
      },
    },
  },
};

const SYSTEM = [
  "You read a person's work mail and decide which emails need something from them: an answer, a decision, something to send, approve or do.",
  "Nothing is needed for newsletters, notifications, automatic mail, receipts, confirmations, mail the person only gets a copy of, and mail that asks nothing.",
  'For each email that needs something: a short task title as an imperative sentence ("Reply to Ayşe about the portal offer", "Send the signed contract to Petrokim"),',
  "details in one or two sentences (what and why), the due day as YYYY-MM-DD only when the email names one, and the person's project it clearly belongs to, by name.",
  "Write the title and details in the language of the email. Answer for every email you are given, by its id.",
].join(" ");

/**
 * Reads a person's new mail for tasks: with Claude, one structured call for the emails that could be
 * something to do (automatic and quiet senders never go to the model); without it, every email from a
 * person is something to answer.
 */
export class MailTaskReader {
  constructor(
    private readonly llm: LlmClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(messages: PersonalMail[], ctx: MailReadContext): Promise<MailTask[]> {
    const decided = new Map<string, MailTask>();
    const toAsk: PersonalMail[] = [];
    for (const message of messages) {
      const offline = offlineMailTask(message, ctx);
      if (!offline.needsAction || !this.llm.available) decided.set(message.id, offline);
      else toAsk.push(message);
    }
    if (toAsk.length) {
      let answers: { id: string; needs_action: boolean; title: string; details: string; due: string | null; project: string | null; reason: string }[] = [];
      try {
        const { data } = await this.llm.structured<{ items: typeof answers }>({
          purpose: "mail.tasks",
          system: SYSTEM,
          effort: "low",
          schema: SCHEMA,
          messages: [{ role: "user", content: this.prompt(toAsk, ctx) }],
        });
        answers = data.items ?? [];
      } catch {
        // Claude unavailable or refused: the offline rule stands in.
      }
      for (const message of toAsk) {
        const answer = answers.find((a) => a.id === message.id);
        if (!answer) {
          decided.set(message.id, offlineMailTask(message, ctx));
          continue;
        }
        const project = answer.project ? ctx.projects.find((p) => p.name.toLowerCase() === answer.project!.trim().toLowerCase()) : undefined;
        decided.set(message.id, {
          id: message.id,
          needsAction: Boolean(answer.needs_action) && Boolean(answer.title?.trim()),
          title: (answer.title ?? "").trim().slice(0, 300) || offlineMailTask(message, ctx).title,
          details: (answer.details ?? "").trim().slice(0, 2000),
          due: answer.due && /^\d{4}-\d{2}-\d{2}$/.test(answer.due) ? answer.due : null,
          projectId: project?.id ?? null,
          reason: (answer.reason ?? "").trim().slice(0, 300),
        });
      }
    }
    return messages.map((m) => decided.get(m.id)!);
  }

  private prompt(messages: PersonalMail[], ctx: MailReadContext): string {
    const today = this.now().toISOString().slice(0, 10);
    const projects = ctx.projects.length
      ? ctx.projects.map((p) => `- ${p.name}${p.summary ? `: ${p.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join("\n")
      : "- (none)";
    const mails = messages
      .map((m) =>
        [
          `<email id="${m.id}">`,
          `From: ${m.from}`,
          `Subject: ${m.subject || "(no subject)"}`,
          `Received: ${m.receivedAt ?? "unknown"}`,
          "",
          (m.body || m.preview).replace(/\r/g, "").trim().slice(0, 4000),
          "</email>",
        ].join("\n"),
      )
      .join("\n\n");
    return [
      `Today is ${today}. The person: ${ctx.person.name}${ctx.person.email ? ` <${ctx.person.email}>` : ""}.`,
      "",
      "Their open projects:",
      projects,
      "",
      "New emails:",
      "",
      mails,
    ].join("\n");
  }
}
