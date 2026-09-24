import { defineConnector, defineManifest } from "../define.ts";
import { getRefreshTokenAccessToken, httpRequest, withTokenRetry, type HttpRequestOptions, type HttpResponse } from "../http.ts";
import { bool, dateTime, int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorEvent } from "../types.ts";
import {
  configString,
  isRecord,
  mapLimit,
  optBoolean,
  optEnum,
  optLimit,
  optString,
  parseIsoDateTime,
  reqString,
  requireConfig,
  requireSecret,
  type Rec,
} from "../util.ts";
import {
  advanceMailCursor,
  canonicalTime,
  htmlToText,
  initialMailCursor,
  looksLikeHtml,
  NEW_MESSAGE_EVENT,
  parseMailCursor,
  recipientList,
} from "./mail-common.ts";
import { buildMimeMessage, decodeText } from "./mime.ts";

const SERVICE = "Gmail";
const API_ROOT = "https://gmail.googleapis.com/gmail/v1/users";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];

const FOLDER_LABELS: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  sentitems: "SENT",
  drafts: "DRAFT",
  spam: "SPAM",
  junk: "SPAM",
  junkemail: "SPAM",
  trash: "TRASH",
  deleteditems: "TRASH",
  starred: "STARRED",
  important: "IMPORTANT",
};

const SYSTEM_LABELS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

function userPath(ctx: ConnectorContext): string {
  return `${API_ROOT}/${encodeURIComponent(configString(ctx, "user_id", "me") ?? "me")}`;
}

function gmail<T = unknown>(ctx: ConnectorContext, path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  return withTokenRetry(
    (force) =>
      getRefreshTokenAccessToken(
        ctx.fetch,
        {
          tokenUrl: TOKEN_URL,
          clientId: requireConfig(ctx, "client_id", "OAuth client ID"),
          clientSecret: requireSecret(ctx, "client_secret", "OAuth client secret"),
          refreshToken: requireSecret(ctx, "refresh_token", "Refresh token"),
          service: "Google OAuth",
        },
        force,
      ),
    (token) =>
      httpRequest<T>(ctx.fetch, `${userPath(ctx)}${path}`, {
        ...options,
        service: SERVICE,
        headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` },
      }),
  );
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

function header(part: GmailPart | undefined, name: string): string | undefined {
  return part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function splitAddresses(value: string | undefined): string[] {
  return value ? value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => a.trim()).filter(Boolean) : [];
}

function summarize(message: Rec): Rec {
  const payload = (isRecord(message.payload) ? message.payload : {}) as GmailPart;
  const labels = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
  return {
    id: message.id,
    thread_id: message.threadId,
    subject: header(payload, "Subject") ?? "",
    from: header(payload, "From") ?? null,
    to: splitAddresses(header(payload, "To")),
    cc: splitAddresses(header(payload, "Cc")),
    date: header(payload, "Date") ?? null,
    received_at: message.internalDate ? canonicalTime(Number(message.internalDate)) : null,
    is_read: !labels.includes("UNREAD"),
    labels,
    preview: message.snippet ?? "",
    internet_message_id: header(payload, "Message-ID") ?? null,
  };
}

function charsetOf(part: GmailPart): string | undefined {
  return /charset="?([^";]+)"?/i.exec(header(part, "Content-Type") ?? "")?.[1];
}

/** Walks the MIME tree: first text/plain and text/html bodies, plus attachments. */
function walk(part: GmailPart, found: { text?: string; html?: string; attachments: Rec[] }): void {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (part.filename && part.body?.attachmentId) {
    const disposition = header(part, "Content-Disposition") ?? "";
    found.attachments.push({
      id: part.body.attachmentId,
      name: part.filename,
      contentType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? null,
      isInline: /^\s*inline/i.test(disposition),
      part_id: part.partId ?? null,
    });
  } else if (part.body?.data && (mime === "text/plain" || mime === "text/html")) {
    const text = decodeText(Buffer.from(part.body.data, "base64url"), charsetOf(part));
    if (mime === "text/plain" && found.text === undefined) found.text = text;
    if (mime === "text/html" && found.html === undefined) found.html = text;
  }
  for (const child of part.parts ?? []) walk(child, found);
}

async function listIds(ctx: ConnectorContext, query: { q?: string; labelIds?: string[] }, max: number): Promise<{ ids: string[]; hasMore: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const response = await gmail<Rec>(ctx, "/messages", {
      query: { q: query.q, labelIds: query.labelIds, maxResults: Math.min(100, max - ids.length), pageToken },
    });
    const data = isRecord(response.data) ? response.data : {};
    if (Array.isArray(data.messages)) {
      for (const m of data.messages) if (isRecord(m) && typeof m.id === "string") ids.push(m.id);
    }
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
  } while (pageToken && ids.length < max);
  return { ids: ids.slice(0, max), hasMore: Boolean(pageToken) };
}

/** Folder names map to system labels; user labels are looked up by name (the API needs label ids). */
async function resolveLabel(ctx: ConnectorContext, folder: string): Promise<string> {
  const known = FOLDER_LABELS[folder.toLowerCase().replace(/\s+/g, "")];
  if (known) return known;
  if (SYSTEM_LABELS.has(folder.toUpperCase())) return folder.toUpperCase();
  if (/^Label_\d+$/.test(folder)) return folder;
  const response = await gmail<Rec>(ctx, "/labels");
  const labels = isRecord(response.data) && Array.isArray(response.data.labels) ? response.data.labels.filter(isRecord) : [];
  const match = labels.find((label) => typeof label.name === "string" && label.name.toLowerCase() === folder.toLowerCase());
  if (!match || typeof match.id !== "string") throw new ConnectorError(`Gmail label "${folder}" not found`, "not_found");
  return match.id;
}

function fetchMetadata(ctx: ConnectorContext, ids: string[]): Promise<Rec[]> {
  return mapLimit(ids, 5, async (id) => {
    const response = await gmail<Rec>(ctx, `/messages/${encodeURIComponent(id)}`, {
      query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    });
    return isRecord(response.data) ? response.data : { id };
  });
}

const manifest = defineManifest({
  type: "gmail",
  name: "Gmail / Google Workspace Mail",
  vendor: "Google",
  category: "mail",
  description:
    "Reads and sends e-mail of a Gmail or Google Workspace mailbox through the Gmail API with an OAuth 2.0 refresh token. Supports polling for new messages to trigger agents.",
  auth: "oauth2-refresh-token",
  docsUrl: "https://developers.google.com/gmail/api/reference/rest",
  maturity: "preview",
  config: [
    { key: "client_id", label: "OAuth client ID", type: "string", required: true, placeholder: "1234567890-abc.apps.googleusercontent.com" },
    { key: "client_secret", label: "OAuth client secret", type: "password", required: true, secret: true },
    {
      key: "refresh_token",
      label: "Refresh token",
      type: "password",
      required: true,
      secret: true,
      help: "Obtained once through the OAuth consent flow with the gmail.readonly and gmail.send scopes (offline access).",
    },
    { key: "user_id", label: "Mailbox", type: "string", default: "me", help: "'me' for the authorised account, or its address." },
    { key: "from_address", label: "From address", type: "string", help: "Optional From header, e.g. a verified send-as alias." },
  ],
  operations: [
    readOp("list_messages", "List messages", "Messages, newest first, from a folder/label with optional Gmail search syntax.", {
      folder: str("inbox (default), sent, drafts, spam, trash, starred, or a user label name / id"),
      top: int("Maximum number of messages (default 25, max 100)"),
      unread_only: bool("Only unread messages"),
      since: dateTime("Only messages received after this time (ISO 8601)"),
      query: str("Gmail search query, e.g. 'from:supplier@example.com has:attachment'"),
    }),
    readOp("get_message", "Get message", "Full message with plain-text body and the list of attachments (id, name, contentType, size).", {
      message_id: str("Message id from list_messages"),
    }, ["message_id"]),
    readOp("get_attachment", "Get attachment", "Content of an attachment as base64 (contentBytes) with name and contentType.", {
      message_id: str("Message id"),
      attachment_id: str("Attachment id from get_message"),
    }, ["message_id", "attachment_id"]),
    writeOp("send_mail", "Send e-mail", "Send an e-mail (RFC 2822, base64url encoded) from the mailbox; can continue a thread.", {
      to: str("Recipient address(es), comma-separated"),
      subject: str("Subject"),
      body: str("Message body (plain text or HTML)"),
      cc: str("CC address(es), comma-separated"),
      bcc: str("BCC address(es), comma-separated"),
      content_type: oneOf(["text", "html"], "Body format; detected automatically when omitted"),
      thread_id: str("Gmail thread id to reply within"),
      in_reply_to: str("Message-ID header of the message being answered"),
    }, ["to", "subject", "body"]),
  ],
  events: [NEW_MESSAGE_EVENT],
  itRequirements: [
    "A Google Cloud project with the Gmail API enabled and an OAuth 2.0 client (client ID and secret); for Google Workspace an internal OAuth consent screen",
    "A refresh token for the mailbox, obtained once via the OAuth consent flow with scopes https://www.googleapis.com/auth/gmail.readonly and https://www.googleapis.com/auth/gmail.send (offline access)",
    "Preferably a dedicated mailbox for the agent (e.g. invoices@company.com) rather than a personal account",
    "Outbound HTTPS from Enterprise Brain to oauth2.googleapis.com and gmail.googleapis.com",
  ],
});

export const gmailConnector = defineConnector({
  manifest,

  async test(ctx) {
    const response = await gmail<Rec>(ctx, "/profile");
    const profile = isRecord(response.data) ? response.data : {};
    return {
      ok: true,
      message: `Connected to Gmail mailbox ${String(profile.emailAddress ?? "?")} (${String(profile.messagesTotal ?? "?")} messages).`,
      details: { emailAddress: profile.emailAddress },
    };
  },

  operations: {
    async list_messages(input, ctx) {
      const top = optLimit(input, "top", 25, 100);
      const label = await resolveLabel(ctx, optString(input, "folder") ?? "inbox");
      const q: string[] = [];
      const query = optString(input, "query");
      if (query) q.push(query);
      if (optBoolean(input, "unread_only")) q.push("is:unread");
      const since = optString(input, "since");
      if (since) q.push(`after:${Math.floor(Date.parse(parseIsoDateTime(since, "since")) / 1000)}`);
      const { ids, hasMore } = await listIds(ctx, { q: q.length ? q.join(" ") : undefined, labelIds: [label] }, top);
      const items = (await fetchMetadata(ctx, ids)).map(summarize);
      return { items, total: items.length, has_more: hasMore, folder: label };
    },

    async get_message(input, ctx) {
      const id = reqString(input, "message_id");
      const response = await gmail<Rec>(ctx, `/messages/${encodeURIComponent(id)}`, { query: { format: "full" } });
      const message = isRecord(response.data) ? response.data : {};
      const found: { text?: string; html?: string; attachments: Rec[] } = { attachments: [] };
      if (isRecord(message.payload)) walk(message.payload as GmailPart, found);
      return {
        ...summarize(message),
        body: found.text ?? (found.html ? htmlToText(found.html) : ""),
        body_format: "text",
        attachments: found.attachments,
      };
    },

    async get_attachment(input, ctx) {
      const messageId = reqString(input, "message_id");
      const attachmentId = reqString(input, "attachment_id");
      const [content, message] = await Promise.all([
        gmail<Rec>(ctx, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`),
        gmail<Rec>(ctx, `/messages/${encodeURIComponent(messageId)}`, { query: { format: "full" } }),
      ]);
      const data = isRecord(content.data) ? content.data : {};
      if (typeof data.data !== "string") throw new ConnectorError(`Attachment ${attachmentId} has no content`, "not_found");
      const found: { attachments: Rec[] } = { attachments: [] };
      if (isRecord(message.data) && isRecord(message.data.payload)) walk(message.data.payload as GmailPart, found);
      // Attachment ids are not stable between requests; fall back to the only attachment when there is exactly one.
      const meta = found.attachments.find((a) => a.id === attachmentId) ?? (found.attachments.length === 1 ? found.attachments[0] : undefined);
      return {
        id: attachmentId,
        message_id: messageId,
        name: meta?.name ?? null,
        contentType: meta?.contentType ?? "application/octet-stream",
        size: data.size ?? null,
        contentBytes: Buffer.from(data.data, "base64url").toString("base64"),
      };
    },

    async send_mail(input, ctx) {
      const to = recipientList(input, "to", true);
      const cc = recipientList(input, "cc", false);
      const bcc = recipientList(input, "bcc", false);
      const subject = reqString(input, "subject");
      const body = reqString(input, "body");
      const html = (optEnum(input, "content_type", ["text", "html"] as const) ?? (looksLikeHtml(body) ? "html" : "text")) === "html";
      const raw = buildMimeMessage({
        from: configString(ctx, "from_address"),
        to,
        cc,
        bcc,
        subject,
        body,
        html,
        inReplyTo: optString(input, "in_reply_to"),
      });
      const threadId = optString(input, "thread_id");
      const response = await gmail<Rec>(ctx, "/messages/send", {
        method: "POST",
        json: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) },
      });
      const sent = isRecord(response.data) ? response.data : {};
      return { ok: true, sent: true, id: sent.id ?? null, thread_id: sent.threadId ?? null, to, cc, bcc, subject };
    },
  },

  async poll(_eventId, ctx, cursor) {
    const state = parseMailCursor(cursor);
    if (!state) return { events: [], cursor: JSON.stringify(initialMailCursor()) };
    const sinceMs = Date.parse(state.since);
    const { ids } = await listIds(ctx, { q: `after:${Math.floor(sinceMs / 1000) - 1}`, labelIds: ["INBOX"] }, 100);
    const metadata = await fetchMetadata(ctx, ids.filter((id) => !state.seen.includes(id)));
    const fresh = metadata
      .filter((m) => typeof m.id === "string" && Number(m.internalDate) >= sinceMs)
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const events: ConnectorEvent[] = fresh.map((m) => ({
      id: String(m.id),
      type: NEW_MESSAGE_EVENT.id,
      occurredAt: canonicalTime(Number(m.internalDate)),
      data: summarize(m),
    }));
    const next = advanceMailCursor(state, fresh.map((m) => ({ id: String(m.id), at: Number(m.internalDate) })));
    return { events, cursor: JSON.stringify(next) };
  },
});
