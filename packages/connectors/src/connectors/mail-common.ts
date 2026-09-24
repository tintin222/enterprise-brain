import { ConnectorError } from "../types.ts";
import { isEmail, optStringList, type Input } from "../util.ts";

/** Helpers shared by the mail connectors (Microsoft 365, Gmail, IMAP/SMTP). */

/** Parses a recipient list ("a@x.com, B <b@y.com>" or an array) into bare, validated addresses. */
export function recipientList(input: Input, key: string, required: boolean): string[] {
  const raw = optStringList(input, key) ?? [];
  const addresses = raw.map((entry) => {
    const match = /<([^>]+)>\s*$/.exec(entry);
    const address = (match?.[1] ?? entry).trim();
    if (!isEmail(address)) throw new ConnectorError(`${key} contains an invalid e-mail address: "${entry}"`, "validation");
    return address;
  });
  if (required && addresses.length === 0) throw new ConnectorError(`${key} needs at least one recipient`, "validation");
  return addresses;
}

export function looksLikeHtml(text: string): boolean {
  return /<(html|body|p|div|br|table|ul|ol|li|strong|em|a|span|h[1-6])\b[^>]*>/i.test(text);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text to minimal HTML (escaped, line breaks kept). HTML input is returned unchanged. */
export function textToHtml(text: string): string {
  return looksLikeHtml(text) ? text : escapeHtml(text).replace(/\r?\n/g, "<br>\n");
}

/** Very small HTML-to-text conversion for message bodies handed to agents. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const NEW_MESSAGE_EVENT = {
  id: "new_message",
  name: "New message",
  description:
    "A new message arrived in the inbox (polled). The first poll only records the starting point, so mail received before the trigger was enabled is not replayed.",
};

/** Cursor of the new_message poll: newest timestamp seen plus the ids seen at exactly that time. */
export interface MailCursor {
  since: string;
  seen: string[];
}

export function parseMailCursor(cursor: string | undefined): MailCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as Partial<MailCursor>;
    if (typeof parsed.since === "string" && Array.isArray(parsed.seen)) {
      return { since: parsed.since, seen: parsed.seen.filter((id): id is string => typeof id === "string") };
    }
  } catch {
    // fall through: a bare timestamp is accepted as well
  }
  return Number.isNaN(Date.parse(cursor)) ? undefined : { since: cursor, seen: [] };
}

/** Timestamps are compared in one canonical form (ISO 8601 UTC with milliseconds). */
export function canonicalTime(value: string | number | Date): string {
  return new Date(value).toISOString();
}

/** Starting point of a new poll: now, truncated to whole seconds. */
export function initialMailCursor(): MailCursor {
  return { since: canonicalTime(Math.floor(Date.now() / 1000) * 1000), seen: [] };
}

/** Advances the cursor over messages sorted by ascending timestamp. */
export function advanceMailCursor(previous: MailCursor, messages: Array<{ id: string; at: string | number }>): MailCursor {
  let since = canonicalTime(previous.since);
  let seen = [...previous.seen];
  for (const message of messages) {
    const at = canonicalTime(message.at);
    if (at > since) {
      since = at;
      seen = [message.id];
    } else if (at === since && !seen.includes(message.id)) {
      seen.push(message.id);
    }
  }
  return { since, seen };
}
