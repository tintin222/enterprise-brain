import { defineConnector, defineManifest } from "../define.ts";
import { odataString, odataV4Collection } from "../http.ts";
import { bool, dateTime, int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorEvent } from "../types.ts";
import {
  isRecord,
  optBoolean,
  optEnum,
  optLimit,
  optString,
  parseIsoDateTime,
  reqString,
  requireConfig,
  type Rec,
} from "../util.ts";
import {
  advanceMailCursor,
  canonicalTime,
  initialMailCursor,
  looksLikeHtml,
  NEW_MESSAGE_EVENT,
  parseMailCursor,
  recipientList,
  textToHtml,
} from "./mail-common.ts";
import { ENTRA_CONFIG, graphCollect, graphRequest } from "./microsoft.ts";

const SERVICE = "Microsoft Graph (mail)";
const SUMMARY_SELECT =
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,importance,bodyPreview,conversationId,internetMessageId,webLink";

/** Well-known folder names Graph accepts in place of folder ids. */
const WELL_KNOWN_FOLDERS = new Set([
  "inbox",
  "archive",
  "deleteditems",
  "drafts",
  "junkemail",
  "sentitems",
  "outbox",
  "clutter",
  "conversationhistory",
  "scheduled",
]);

function mailboxPath(ctx: ConnectorContext): string {
  return `/users/${encodeURIComponent(requireConfig(ctx, "mailbox", "Mailbox"))}`;
}

/** Graph datetime literal (second precision, UTC). */
function graphTime(iso: string): string {
  return canonicalTime(iso).replace(/\.\d{3}Z$/, "Z");
}

function address(value: unknown): { name: string | null; address: string | null } | null {
  const email = isRecord(value) && isRecord(value.emailAddress) ? value.emailAddress : undefined;
  if (!email) return null;
  return {
    name: typeof email.name === "string" ? email.name : null,
    address: typeof email.address === "string" ? email.address : null,
  };
}

function addresses(value: unknown): Array<{ name: string | null; address: string | null }> {
  return Array.isArray(value) ? value.map(address).filter((a): a is { name: string | null; address: string | null } => a !== null) : [];
}

function summarize(message: Rec): Rec {
  return {
    id: message.id,
    subject: message.subject ?? "",
    from: address(message.from),
    to: addresses(message.toRecipients),
    cc: addresses(message.ccRecipients),
    received_at: message.receivedDateTime,
    is_read: message.isRead,
    has_attachments: message.hasAttachments,
    importance: message.importance,
    preview: message.bodyPreview,
    conversation_id: message.conversationId,
    internet_message_id: message.internetMessageId,
    web_link: message.webLink,
  };
}

function attachmentKind(odataType: unknown): "file" | "item" | "reference" {
  if (odataType === "#microsoft.graph.itemAttachment") return "item";
  if (odataType === "#microsoft.graph.referenceAttachment") return "reference";
  return "file";
}

/** Accepts a well-known folder name, a folder id or a display name (top level or below the inbox). */
async function resolveFolder(ctx: ConnectorContext, folder: string): Promise<string> {
  const compact = folder.toLowerCase().replace(/\s+/g, "");
  if (WELL_KNOWN_FOLDERS.has(compact)) return compact;
  if (folder.length > 60 && /^[A-Za-z0-9=_+/-]+$/.test(folder)) return folder;
  const mailbox = mailboxPath(ctx);
  const query = { $filter: `displayName eq ${odataString(folder)}`, $select: "id,displayName" };
  for (const path of [`${mailbox}/mailFolders`, `${mailbox}/mailFolders/inbox/childFolders`]) {
    const response = await graphRequest(ctx, path, { query }, SERVICE);
    const id = odataV4Collection(response.data).items[0]?.id;
    if (typeof id === "string") return id;
  }
  throw new ConnectorError(`Mail folder "${folder}" not found in ${requireConfig(ctx, "mailbox")}`, "not_found");
}

function messagePath(ctx: ConnectorContext, messageId: string): string {
  return `${mailboxPath(ctx)}/messages/${encodeURIComponent(messageId)}`;
}

const manifest = defineManifest({
  type: "microsoft-365-mail",
  name: "Microsoft 365 Mail (Exchange Online)",
  vendor: "Microsoft",
  category: "mail",
  description:
    "Reads, sends, answers and files e-mail in an Exchange Online mailbox (user or shared mailbox) through Microsoft Graph with an app registration (client credentials). Supports polling for new messages to trigger agents.",
  auth: "oauth2-client-credentials",
  docsUrl: "https://learn.microsoft.com/graph/api/resources/mail-api-overview",
  maturity: "preview",
  config: [
    ...ENTRA_CONFIG,
    {
      key: "mailbox",
      label: "Mailbox",
      type: "string",
      required: true,
      placeholder: "invoices@acme.com",
      help: "User principal name or SMTP address of the mailbox the agent works with (shared mailboxes are supported).",
    },
  ],
  operations: [
    readOp("list_messages", "List messages", "Messages of a folder, newest first.", {
      folder: str("Folder: inbox (default), archive, sentitems, deleteditems, junkemail, a folder id or a folder display name"),
      top: int("Maximum number of messages (default 25, max 100)"),
      unread_only: bool("Only unread messages"),
      since: dateTime("Only messages received at or after this time (ISO 8601)"),
      from: str("Only messages from this sender address"),
    }),
    readOp("get_message", "Get message", "Full message with body (plain text by default) and the list of attachments (id, name, contentType, size).", {
      message_id: str("Message id from list_messages"),
      body_format: oneOf(["text", "html"], "Body format (default text)"),
    }, ["message_id"]),
    readOp("get_attachment", "Get attachment", "Content of a file attachment as base64 (contentBytes) with name, contentType and size.", {
      message_id: str("Message id"),
      attachment_id: str("Attachment id from get_message"),
    }, ["message_id", "attachment_id"]),
    writeOp("send_mail", "Send e-mail", "Send a new e-mail from the mailbox (saved to Sent Items).", {
      to: str("Recipient address(es), comma-separated"),
      subject: str("Subject"),
      body: str("Message body (plain text or HTML)"),
      cc: str("CC address(es), comma-separated"),
      bcc: str("BCC address(es), comma-separated"),
      content_type: oneOf(["text", "html"], "Body format; detected automatically when omitted"),
    }, ["to", "subject", "body"]),
    writeOp("reply_to_message", "Reply to message", "Reply to the sender of a message (or to all recipients) with the original message quoted.", {
      message_id: str("Message id to reply to"),
      body: str("Reply text (plain text or HTML)"),
      reply_all: bool("Reply to all recipients (default false)"),
    }, ["message_id", "body"]),
    writeOp("move_message", "Move message", "Move a message to another folder, e.g. archive or a folder such as 'Processed'.", {
      message_id: str("Message id"),
      destination_folder: str("Target folder: well-known name (archive, inbox, deleteditems...), folder id or display name"),
    }, ["message_id", "destination_folder"]),
  ],
  events: [NEW_MESSAGE_EVENT],
  itRequirements: [
    "A Microsoft Entra ID app registration (single tenant) with a client secret; provide tenant ID, client ID and the secret value",
    "Microsoft Graph application permissions Mail.ReadWrite and Mail.Send with admin consent (Mail.Read suffices when the agent only reads and never moves or sends mail)",
    "Scope the app to the agent's mailbox only, using Exchange Online RBAC for Applications (New-ManagementRoleAssignment with a management scope) or an application access policy",
    "The mailbox address the agent works with, ideally a shared mailbox such as invoices@company.com or careers@company.com",
    "Outbound HTTPS from Enterprise Brain to login.microsoftonline.com and graph.microsoft.com",
  ],
});

export const microsoft365MailConnector = defineConnector({
  manifest,

  async test(ctx) {
    const response = await graphRequest(ctx, `${mailboxPath(ctx)}/mailFolders/inbox`, {
      query: { $select: "id,displayName,totalItemCount,unreadItemCount" },
    }, SERVICE);
    const inbox = isRecord(response.data) ? response.data : {};
    return {
      ok: true,
      message: `Connected to mailbox ${requireConfig(ctx, "mailbox")}: ${String(inbox.totalItemCount ?? "?")} messages in Inbox, ${String(inbox.unreadItemCount ?? "?")} unread.`,
      details: { totalItemCount: inbox.totalItemCount, unreadItemCount: inbox.unreadItemCount },
    };
  },

  operations: {
    async list_messages(input, ctx) {
      const folder = await resolveFolder(ctx, optString(input, "folder") ?? "inbox");
      const top = optLimit(input, "top", 25, 100);
      const sinceInput = optString(input, "since");
      const since = sinceInput ? parseIsoDateTime(sinceInput, "since") : undefined;
      const unreadOnly = optBoolean(input, "unread_only") ?? false;
      const from = optString(input, "from");
      // Graph requires the $orderby property to appear first in $filter when both are used.
      const filters: string[] = [];
      if (since || unreadOnly || from) filters.push(`receivedDateTime ge ${graphTime(since ?? "1900-01-01T00:00:00Z")}`);
      if (unreadOnly) filters.push("isRead eq false");
      if (from) filters.push(`from/emailAddress/address eq ${odataString(from)}`);
      const { items, hasMore } = await graphCollect(
        ctx,
        `${mailboxPath(ctx)}/mailFolders/${encodeURIComponent(folder)}/messages`,
        {
          query: {
            $select: SUMMARY_SELECT,
            $orderby: "receivedDateTime desc",
            $top: Math.min(top, 50),
            $filter: filters.length ? filters.join(" and ") : undefined,
          },
        },
        top,
        SERVICE,
      );
      return { items: items.map(summarize), total: items.length, has_more: hasMore, folder };
    },

    async get_message(input, ctx) {
      const messageId = reqString(input, "message_id");
      const format = optEnum(input, "body_format", ["text", "html"] as const) ?? "text";
      const response = await graphRequest(ctx, messagePath(ctx, messageId), {
        query: { $select: `${SUMMARY_SELECT},body,replyTo,sentDateTime` },
        headers: { prefer: `outlook.body-content-type="${format}"` },
      }, SERVICE);
      const message = isRecord(response.data) ? response.data : {};
      let attachments: Rec[] = [];
      if (message.hasAttachments === true) {
        const list = await graphRequest(ctx, `${messagePath(ctx, messageId)}/attachments`, {
          query: { $select: "id,name,contentType,size,isInline" },
        }, SERVICE);
        attachments = odataV4Collection(list.data).items.map((a) => ({
          id: a.id,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          isInline: a.isInline,
          kind: attachmentKind(a["@odata.type"]),
        }));
      }
      const body = isRecord(message.body) ? message.body : {};
      return {
        ...summarize(message),
        sent_at: message.sentDateTime,
        reply_to: addresses(message.replyTo),
        body: typeof body.content === "string" ? body.content : "",
        body_format: String(body.contentType ?? format).toLowerCase(),
        attachments,
      };
    },

    async get_attachment(input, ctx) {
      const messageId = reqString(input, "message_id");
      const attachmentId = reqString(input, "attachment_id");
      const response = await graphRequest(ctx, `${messagePath(ctx, messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {}, SERVICE);
      const attachment = isRecord(response.data) ? response.data : {};
      const kind = attachmentKind(attachment["@odata.type"]);
      if (kind !== "file" || typeof attachment.contentBytes !== "string") {
        throw new ConnectorError(`Attachment "${String(attachment.name ?? attachmentId)}" is an ${kind} attachment without file content`, "unsupported");
      }
      return {
        id: attachment.id,
        message_id: messageId,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        isInline: attachment.isInline,
        contentBytes: attachment.contentBytes,
      };
    },

    async send_mail(input, ctx) {
      const to = recipientList(input, "to", true);
      const cc = recipientList(input, "cc", false);
      const bcc = recipientList(input, "bcc", false);
      const subject = reqString(input, "subject");
      const body = reqString(input, "body");
      const html = (optEnum(input, "content_type", ["text", "html"] as const) ?? (looksLikeHtml(body) ? "html" : "text")) === "html";
      const toRecipients = (list: string[]) => list.map((addressValue) => ({ emailAddress: { address: addressValue } }));
      await graphRequest(ctx, `${mailboxPath(ctx)}/sendMail`, {
        method: "POST",
        json: {
          message: {
            subject,
            body: { contentType: html ? "HTML" : "Text", content: body },
            toRecipients: toRecipients(to),
            ...(cc.length ? { ccRecipients: toRecipients(cc) } : {}),
            ...(bcc.length ? { bccRecipients: toRecipients(bcc) } : {}),
          },
          saveToSentItems: true,
        },
      }, SERVICE);
      return { ok: true, sent: true, from: requireConfig(ctx, "mailbox"), to, cc, bcc, subject };
    },

    async reply_to_message(input, ctx) {
      const messageId = reqString(input, "message_id");
      const replyAll = optBoolean(input, "reply_all") ?? false;
      await graphRequest(ctx, `${messagePath(ctx, messageId)}/${replyAll ? "replyAll" : "reply"}`, {
        method: "POST",
        json: { comment: textToHtml(reqString(input, "body")) },
      }, SERVICE);
      return { ok: true, replied: true, message_id: messageId, reply_all: replyAll };
    },

    async move_message(input, ctx) {
      const messageId = reqString(input, "message_id");
      const destination = await resolveFolder(ctx, reqString(input, "destination_folder"));
      const response = await graphRequest(ctx, `${messagePath(ctx, messageId)}/move`, {
        method: "POST",
        json: { destinationId: destination },
      }, SERVICE);
      const moved = isRecord(response.data) ? response.data : {};
      return { ok: true, moved: true, message_id: moved.id ?? messageId, previous_message_id: messageId, destination_folder: destination };
    },
  },

  async poll(_eventId, ctx, cursor) {
    const state = parseMailCursor(cursor);
    if (!state) return { events: [], cursor: JSON.stringify(initialMailCursor()) };
    const { items } = await graphCollect(
      ctx,
      `${mailboxPath(ctx)}/mailFolders/inbox/messages`,
      {
        query: {
          $select: SUMMARY_SELECT,
          $filter: `receivedDateTime ge ${graphTime(state.since)}`,
          $orderby: "receivedDateTime asc",
          $top: 50,
        },
      },
      200,
      SERVICE,
    );
    const fresh = items.filter((m) => typeof m.id === "string" && typeof m.receivedDateTime === "string" && !state.seen.includes(m.id));
    const events: ConnectorEvent[] = fresh.map((m) => ({
      id: String(m.id),
      type: NEW_MESSAGE_EVENT.id,
      occurredAt: canonicalTime(String(m.receivedDateTime)),
      data: summarize(m),
    }));
    const next = advanceMailCursor(state, fresh.map((m) => ({ id: String(m.id), at: String(m.receivedDateTime) })));
    return { events, cursor: JSON.stringify(next) };
  },
});
