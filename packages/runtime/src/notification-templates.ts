import { isRecord, truncate } from "@enterprise-brain/core";
import type { Person } from "./people.ts";
import type { QueueEntry } from "./queue.ts";

/** A queue item for one person, with the links its buttons open. */
export interface ItemMessage {
  companyId: string;
  companyName: string;
  person: Person;
  entry: QueueEntry;
  links: {
    /** The page where the person confirms an action (signed; see ActionLinks). */
    act: string;
    /** The task (or the work queue) in the app. */
    open: string;
    /** Where they change what reaches them. */
    preferences: string;
  };
}

/** The morning summary: what needs the person, and what their AI employees did. */
export interface SummaryMessage {
  companyId: string;
  companyName: string;
  person: Person;
  /** The person's local date, "2026-09-26". */
  date: string;
  needsYou: { entry: QueueEntry; link: string }[];
  aiEmployees: { name: string; done: number; started: number; needsPerson: number; link: string }[];
  links: { work: string; app: string; preferences: string };
}

/** News of a task a person gave through a channel: done, needs them, stopped. */
export interface TaskNewsMessage {
  companyId: string;
  companyName: string;
  person: Person;
  task: { ref: string; title: string; status: string; outcome: string | null };
  agentName: string;
  text: string;
  link: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A safe subset of Markdown (paragraphs, bullet lists, bold) as email HTML; everything is escaped first. */
export function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];
  const inline = (text: string) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const flush = () => {
    if (paragraph.length) blocks.push(`<p style="margin:0 0 10px">${paragraph.map(inline).join("<br>")}</p>`);
    if (list.length) blocks.push(`<ul style="margin:0 0 10px;padding-left:20px">${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (!line.trim()) flush();
    else if (bullet) {
      if (paragraph.length) flush();
      list.push(bullet[1]!);
    } else if (heading) {
      flush();
      blocks.push(`<p style="margin:0 0 6px"><strong>${inline(heading[1]!)}</strong></p>`);
    } else {
      if (list.length) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks.join("");
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return truncate(JSON.stringify(value), 300);
  return truncate(String(value), 300);
}

/** The change an approval would make, as label/value rows: an email's to/subject/body, or a system action's fields. */
export function describeChange(action: Record<string, unknown> | null): { heading: string; rows: [string, string][]; body?: string } | null {
  if (!action) return null;
  if (action.type === "mail.send") {
    return {
      heading: "Email to be sent",
      rows: [
        ["To", display(action.to)],
        ["Subject", display(action.subject)],
      ],
      body: typeof action.body === "string" ? truncate(action.body, 2000) : undefined,
    };
  }
  if (action.type === "connector") {
    const input = isRecord(action.input) ? action.input : {};
    const system = typeof action.system === "string" ? action.system : String(action.category ?? "System").toUpperCase();
    const operation = typeof action.operationName === "string" ? action.operationName : String(action.operation ?? "");
    return {
      heading: `${system}: ${operation}`,
      rows: Object.entries(input)
        .slice(0, 15)
        .map(([key, value]) => [key.replace(/[_-]+/g, " "), display(value)]),
    };
  }
  return null;
}

/**
 * An item's details, unless they only restate an approval's change (generated from it: the email's
 * subject and text, the system and its fields), which is shown on its own and may have been corrected.
 */
export function explanationOf(entry: Pick<QueueEntry, "type" | "details" | "action">): string {
  const details = entry.details.trim();
  const action = entry.action;
  if (entry.type !== "approval" || !action || !details) return details;
  if (action.type === "mail.send" && /^(To|Subject): /.test(details)) return "";
  if (action.type === "connector") {
    const system = String(action.system ?? action.ref ?? "");
    if ((system && details.startsWith(`${system}: `)) || (!details.includes("\n") && / wants to .+ in .+\.$/.test(details))) return "";
  }
  return details;
}

const KIND_SUBJECT: Record<QueueEntry["type"], (entry: QueueEntry) => string> = {
  approval: (e) => `Approve? ${e.title}`,
  question: (e) => `${e.agent?.name ?? "An AI employee"} asks: ${e.title}`,
  review: (e) => `Check: ${e.title}`,
  failure: (e) => `Stopped: ${e.title}`,
  notice: (e) => e.title,
};

function button(href: string, label: string, color: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:8px;background:${color};color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(label)}</a>`;
}

function linkButton(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;color:#1e293b;font-weight:600;text-decoration:none">${escapeHtml(label)}</a>`;
}

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

function layout(companyName: string, inner: string, footer: string): string {
  return [
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px;line-height:1.5">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">`,
    `<tr><td style="padding:0 4px 12px;color:#475569;font-size:13px;font-weight:600">${escapeHtml(companyName)} · Enterprise Brain</td></tr>`,
    `<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">${inner}</td></tr>`,
    `<tr><td style="padding:12px 4px;color:#64748b;font-size:12px">${footer}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

function meta(entry: QueueEntry): string {
  return [entry.agent?.name, entry.task?.ref].filter(Boolean).join(" · ");
}

/** The email for one queue item: what it is, why the person is asked, what would change, and buttons. */
export function itemEmail(message: ItemMessage): RenderedEmail {
  const { entry, links, person } = message;
  const subject = truncate(KIND_SUBJECT[entry.type](entry), 150);
  const change = describeChange(entry.action);
  const details = explanationOf(entry);
  const actions: string[] = [];
  const textActions: string[] = [];
  if (entry.type === "approval") {
    actions.push(
      button(withParam(links.act, "choice", "approve"), "Approve", "#059669"),
      button(withParam(links.act, "choice", "reject"), "Reject", "#dc2626"),
    );
    textActions.push(`Approve: ${withParam(links.act, "choice", "approve")}`, `Reject: ${withParam(links.act, "choice", "reject")}`);
    if (change && entry.action?.type !== "decision") {
      actions.push(linkButton(withParam(links.act, "choice", "edit"), "Correct it first"));
      textActions.push(`Correct it first: ${withParam(links.act, "choice", "edit")}`);
    }
  } else if (entry.type === "question") {
    for (const option of entry.options ?? []) {
      actions.push(linkButton(withParam(links.act, "answer", option), option));
      textActions.push(`${option}: ${withParam(links.act, "answer", option)}`);
    }
    actions.push(button(links.act, "Answer", "#4f46e5"));
    textActions.push(`Answer: ${links.act}`);
  } else if (entry.type === "review") {
    actions.push(button(withParam(links.act, "verdict", "right"), "Right", "#059669"), button(withParam(links.act, "verdict", "wrong"), "Wrong", "#dc2626"));
    textActions.push(`Right: ${withParam(links.act, "verdict", "right")}`, `Wrong: ${withParam(links.act, "verdict", "wrong")}`);
  }
  actions.push(linkButton(links.open, "Open in the app"));
  textActions.push(`Open in the app: ${links.open}`);

  const html = layout(
    message.companyName,
    [
      `<p style="margin:0 0 4px;color:#64748b;font-size:12px">${escapeHtml(meta(entry))}</p>`,
      `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.3">${escapeHtml(entry.title)}</h1>`,
      entry.reason
        ? `<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#fffbeb;color:#78350f;font-size:13px"><strong>Why you are asked:</strong> ${escapeHtml(entry.reason)}</p>`
        : "",
      entry.suggestion ? `<p style="margin:0 0 12px;font-size:13px"><strong>It suggests:</strong> ${escapeHtml(entry.suggestion)}</p>` : "",
      details ? `<div style="margin:0 0 12px">${markdownToHtml(truncate(details, 4000))}</div>` : "",
      change
        ? [
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">`,
            `<tr><td colspan="2" style="padding:8px 12px;background:#f8fafc;color:#475569;font-weight:600;border-bottom:1px solid #e2e8f0">${escapeHtml(change.heading)}</td></tr>`,
            ...change.rows.map(
              ([label, value]) =>
                `<tr><td style="padding:6px 12px;color:#64748b;width:30%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 12px">${escapeHtml(value)}</td></tr>`,
            ),
            change.body
              ? `<tr><td colspan="2" style="padding:8px 12px;border-top:1px solid #e2e8f0;white-space:pre-wrap">${escapeHtml(change.body)}</td></tr>`
              : "",
            `</table>`,
          ].join("")
        : "",
      `<div style="margin-top:8px">${actions.join("")}</div>`,
      `<p style="margin:8px 0 0;color:#64748b;font-size:12px">The buttons open a page where you confirm; nothing happens until you do.</p>`,
    ].join(""),
    `Sent to ${escapeHtml(person.name)}. <a href="${escapeHtml(links.preferences)}" style="color:#475569">Change what reaches you</a>.`,
  );
  const text = [
    meta(entry),
    entry.title,
    "",
    entry.reason ? `Why you are asked: ${entry.reason}` : "",
    entry.suggestion ? `It suggests: ${entry.suggestion}` : "",
    details ? truncate(details, 4000) : "",
    change ? [change.heading, ...change.rows.map(([l, v]) => `  ${l}: ${v}`), change.body ?? ""].join("\n") : "",
    "",
    ...textActions,
    "",
    "The links open a page where you confirm; nothing happens until you do.",
    `Change what reaches you: ${links.preferences}`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return { subject, text, html };
}

/** At most this many items are listed; the rest are counted and wait in Work. */
export const SUMMARY_LIST_LIMIT = 20;

/** The morning summary: what needs the person, and what their AI employees did since yesterday. */
export function summaryEmail(message: SummaryMessage): RenderedEmail {
  const first = message.person.name.trim().split(/\s+/)[0] ?? message.person.name;
  const count = message.needsYou.length;
  const listed = message.needsYou.slice(0, SUMMARY_LIST_LIMIT);
  const more = count - listed.length;
  const subject = count
    ? `Good morning, ${first}: ${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you`
    : `Good morning, ${first}: your AI employees yesterday`;
  const html = layout(
    message.companyName,
    [
      `<h1 style="margin:0 0 16px;font-size:18px">Good morning, ${escapeHtml(first)}</h1>`,
      count
        ? `<p style="margin:0 0 8px;font-weight:600">Needs you (${count})</p><ul style="margin:0 0 16px;padding-left:20px">${listed
            .map(
              ({ entry, link }) =>
                `<li style="margin-bottom:4px"><a href="${escapeHtml(link)}" style="color:#4338ca">${escapeHtml(entry.title)}</a>${meta(entry) ? `<span style="color:#64748b"> · ${escapeHtml(meta(entry))}</span>` : ""}</li>`,
            )
            .join("")}${more > 0 ? `<li style="color:#64748b">and ${more} more in Work</li>` : ""}</ul>`
        : `<p style="margin:0 0 16px">Nothing needs you right now.</p>`,
      message.aiEmployees.length
        ? `<p style="margin:0 0 8px;font-weight:600">Your AI employees since yesterday</p><ul style="margin:0 0 16px;padding-left:20px">${message.aiEmployees
            .map(
              (a) =>
                `<li style="margin-bottom:4px"><a href="${escapeHtml(a.link)}" style="color:#4338ca">${escapeHtml(a.name)}</a>: ${a.done} done${a.started ? ` · ${a.started} started` : ""}${a.needsPerson ? ` · ${a.needsPerson} waiting for a person` : ""}</li>`,
            )
            .join("")}</ul>`
        : "",
      linkButton(message.links.work, "Open Work"),
    ].join(""),
    `Sent to ${escapeHtml(message.person.name)} each morning. <a href="${escapeHtml(message.links.preferences)}" style="color:#475569">Change what reaches you</a>.`,
  );
  const text = [
    `Good morning, ${first}`,
    "",
    count ? `Needs you (${count}):` : "Nothing needs you right now.",
    ...listed.map(({ entry, link }) => `- ${entry.title}${meta(entry) ? ` (${meta(entry)})` : ""}: ${link}`),
    more > 0 ? `- and ${more} more in Work` : "",
    "",
    message.aiEmployees.length ? "Your AI employees since yesterday:" : "",
    ...message.aiEmployees.map(
      (a) => `- ${a.name}: ${a.done} done${a.started ? `, ${a.started} started` : ""}${a.needsPerson ? `, ${a.needsPerson} waiting for a person` : ""}`,
    ),
    "",
    `Work: ${message.links.work}`,
    `Change what reaches you: ${message.links.preferences}`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return { subject, text, html };
}

/** News of a task the person gave: it's done, needs them, or stopped. */
export function taskNewsEmail(message: TaskNewsMessage): RenderedEmail {
  const subject = `[${message.task.ref}] ${message.text}`;
  const html = layout(
    message.companyName,
    [
      `<p style="margin:0 0 4px;color:#64748b;font-size:12px">${escapeHtml(message.agentName)} · ${escapeHtml(message.task.ref)}</p>`,
      `<h1 style="margin:0 0 12px;font-size:18px">${escapeHtml(message.text)}</h1>`,
      message.task.outcome ? `<div style="margin:0 0 12px">${markdownToHtml(truncate(message.task.outcome, 3000))}</div>` : "",
      linkButton(message.link, "Open the task"),
    ].join(""),
    `Sent to ${escapeHtml(message.person.name)}, who gave this task.`,
  );
  return { subject, text: [message.text, "", message.task.outcome ?? "", "", `Open the task: ${message.link}`].join("\n"), html };
}
