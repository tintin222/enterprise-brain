import type { FetchMessageObject, FetchQueryObject, ImapFlowOptions, MailboxObject, MessageStructureObject, SearchObject } from "imapflow";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { defineConnector, defineManifest } from "../define.ts";
import { bool, dateTime, int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorEvent, type ConnectorImplementation } from "../types.ts";
import {
  configBoolean,
  configNumber,
  configString,
  errorMessage,
  isRecord,
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
import { htmlToText, looksLikeHtml, NEW_MESSAGE_EVENT, recipientList } from "./mail-common.ts";

/**
 * IMAP (read) + SMTP (send) mail connector. The network clients are created
 * through injectable factories so the connector can be tested without a mail
 * server; by default imapflow and nodemailer are loaded on first use.
 */

/** The subset of imapflow's ImapFlow used by the connector. */
export interface ImapClientLike {
  readonly mailbox: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: number[] | string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(uid: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined>;
  download(
    uid: string,
    part: string | undefined,
    options: { uid: true; maxBytes?: number },
  ): Promise<{ meta: { contentType?: string; filename?: string }; content: AsyncIterable<unknown> }>;
}

export interface SmtpMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

/** The subset of a nodemailer transporter used by the connector. */
export interface SmtpTransportLike {
  sendMail(mail: SmtpMail): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  verify(): Promise<unknown>;
  close?(): void;
}

export interface ImapSmtpDeps {
  createImapClient(options: ImapFlowOptions): ImapClientLike | Promise<ImapClientLike>;
  createSmtpTransport(options: SMTPTransport.Options): SmtpTransportLike | Promise<SmtpTransportLike>;
}

const defaultDeps: ImapSmtpDeps = {
  async createImapClient(options) {
    const { ImapFlow } = await import("imapflow");
    return new ImapFlow(options);
  },
  async createSmtpTransport(options) {
    const { createTransport } = await import("nodemailer");
    return createTransport(options);
  },
};

const MAX_TEXT_BYTES = 2_000_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function defaultFolder(ctx: ConnectorContext): string {
  return configString(ctx, "mailbox", "INBOX") ?? "INBOX";
}

/** Message ids are "<folder>:<uid>" so they stay valid without a separate folder argument. */
function messageId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

function parseMessageId(id: string, fallbackFolder: string): { folder: string; uid: number } {
  const index = id.lastIndexOf(":");
  const folder = index > 0 ? id.slice(0, index) : fallbackFolder;
  const uid = Number(index >= 0 ? id.slice(index + 1) : id);
  if (!Number.isInteger(uid) || uid <= 0) throw new ConnectorError(`Invalid message id "${id}" (expected <folder>:<uid>)`, "validation");
  return { folder, uid };
}

function mapMailError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const err = isRecord(error) ? error : {};
  const code = typeof err.code === "string" ? err.code : "";
  const message = errorMessage(error);
  if (err.authenticationFailed === true || code === "EAUTH" || /auth/i.test(String(err.serverResponseCode ?? ""))) {
    return new ConnectorError(`Mail server rejected the credentials: ${message}`, "auth");
  }
  if (err.serverResponseCode === "NONEXISTENT" || /doesn't exist|does not exist|unknown mailbox/i.test(message)) {
    return new ConnectorError(`Mail folder not found: ${message}`, "not_found");
  }
  if (code === "EENVELOPE") return new ConnectorError(`Recipient rejected: ${message}`, "validation");
  return new ConnectorError(`Mail server error: ${message}`, "remote");
}

function addressList(list: Array<{ name?: string; address?: string }> | undefined): Array<{ name: string | null; address: string | null }> {
  return (list ?? []).map((a) => ({ name: a.name || null, address: a.address ?? null }));
}

interface StructureInfo {
  text?: string;
  html?: string;
  attachments: Rec[];
}

function analyzeStructure(node: MessageStructureObject | undefined, info: StructureInfo = { attachments: [] }): StructureInfo {
  if (!node) return info;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) analyzeStructure(child, info);
    return info;
  }
  const part = node.part ?? "1";
  const type = node.type.toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  const isText = type === "text/plain" || type === "text/html";
  if (node.disposition === "attachment" || (filename && !isText) || (!isText && !type.startsWith("multipart/"))) {
    info.attachments.push({
      id: part,
      name: filename ?? `attachment-${part}`,
      contentType: type,
      size: node.size ?? null,
      isInline: node.disposition === "inline",
    });
  } else if (type === "text/plain" && info.text === undefined) {
    info.text = part;
  } else if (type === "text/html" && info.html === undefined) {
    info.html = part;
  }
  return info;
}

function summarize(folder: string, message: FetchMessageObject): Rec {
  const envelope = message.envelope;
  const internalDate = message.internalDate ? new Date(message.internalDate).toISOString() : null;
  return {
    id: messageId(folder, message.uid),
    uid: message.uid,
    folder,
    subject: envelope?.subject ?? "",
    from: addressList(envelope?.from)[0] ?? null,
    to: addressList(envelope?.to),
    cc: addressList(envelope?.cc),
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    received_at: internalDate,
    is_read: message.flags?.has("\\Seen") ?? false,
    has_attachments: analyzeStructure(message.bodyStructure).attachments.length > 0,
    size: message.size ?? null,
    internet_message_id: envelope?.messageId ?? null,
  };
}

async function readAll(content: AsyncIterable<unknown>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) throw new ConnectorError(`Content exceeds ${Math.round(maxBytes / 1048576)} MB`, "validation");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Poll cursor: UIDVALIDITY of the folder and the highest UID already emitted. */
function parsePollCursor(cursor: string | undefined): { uidValidity: string; lastUid: number } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (isRecord(parsed) && typeof parsed.lastUid === "number" && typeof parsed.uidValidity === "string") {
      return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid };
    }
  } catch {
    // invalid cursor: start over
  }
  return undefined;
}

const SUMMARY_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true };

const manifest = defineManifest({
  type: "imap-smtp",
  name: "IMAP / SMTP mailbox",
  vendor: "Standard protocols",
  category: "mail",
  description:
    "Reads e-mail from any IMAP mailbox and sends through SMTP (on-premise Exchange, Dovecot, hosting providers, Yandex/Zoho...). Supports polling for new messages to trigger agents.",
  auth: "basic",
  docsUrl: "https://imapflow.com/",
  maturity: "preview",
  config: [
    { key: "imap_host", label: "IMAP host", type: "string", required: true, placeholder: "imap.acme.com" },
    { key: "imap_port", label: "IMAP port", type: "number", default: 993 },
    { key: "imap_secure", label: "IMAP over TLS (port 993)", type: "boolean", default: true },
    { key: "smtp_host", label: "SMTP host", type: "string", placeholder: "smtp.acme.com", help: "Required for sending." },
    { key: "smtp_port", label: "SMTP port", type: "number", default: 587 },
    { key: "smtp_secure", label: "SMTP over implicit TLS (port 465)", type: "boolean", default: false, help: "Off: STARTTLS is used on port 587." },
    { key: "username", label: "Username", type: "string", required: true },
    { key: "password", label: "Password / app password", type: "password", required: true, secret: true },
    { key: "from_address", label: "From address", type: "string", help: "Defaults to the username." },
    { key: "mailbox", label: "Default folder", type: "string", default: "INBOX" },
  ],
  operations: [
    readOp("list_messages", "List messages", "Messages of a folder, newest first. Message ids have the form <folder>:<uid>.", {
      folder: str("IMAP folder (default INBOX)"),
      top: int("Maximum number of messages (default 25, max 100)"),
      unread_only: bool("Only unread messages"),
      since: dateTime("Only messages received at or after this time (ISO 8601)"),
    }),
    readOp("get_message", "Get message", "Full message with plain-text body and the list of attachments (id, name, contentType, size).", {
      message_id: str("Message id from list_messages (<folder>:<uid>)"),
    }, ["message_id"]),
    readOp("get_attachment", "Get attachment", "Content of an attachment as base64 (contentBytes) with name and contentType.", {
      message_id: str("Message id (<folder>:<uid>)"),
      attachment_id: str("Attachment id (MIME part) from get_message"),
    }, ["message_id", "attachment_id"]),
    writeOp("send_mail", "Send e-mail", "Send an e-mail through SMTP.", {
      to: str("Recipient address(es), comma-separated"),
      subject: str("Subject"),
      body: str("Message body (plain text or HTML)"),
      cc: str("CC address(es), comma-separated"),
      bcc: str("BCC address(es), comma-separated"),
      content_type: oneOf(["text", "html"], "Body format; detected automatically when omitted"),
      in_reply_to: str("Message-ID of the message being answered"),
    }, ["to", "subject", "body"]),
  ],
  events: [NEW_MESSAGE_EVENT],
  itRequirements: [
    "A dedicated mailbox for the agent with IMAP (and SMTP submission for sending) enabled",
    "Host names and ports of the IMAP server (993/TLS) and the SMTP submission server (587/STARTTLS or 465/TLS)",
    "Username and password (or an app password when multi-factor authentication is enforced)",
    "Firewall rules allowing Enterprise Brain to reach the IMAP and SMTP ports",
  ],
});

export function createImapSmtpConnector(deps: Partial<ImapSmtpDeps> = {}): ConnectorImplementation {
  const factories: ImapSmtpDeps = { ...defaultDeps, ...deps };

  async function withImap<T>(ctx: ConnectorContext, folder: string | undefined, task: (client: ImapClientLike) => Promise<T>): Promise<T> {
    const client = await factories.createImapClient({
      host: requireConfig(ctx, "imap_host", "IMAP host"),
      port: configNumber(ctx, "imap_port", 993),
      secure: configBoolean(ctx, "imap_secure", true),
      auth: { user: requireConfig(ctx, "username", "Username"), pass: requireSecret(ctx, "password", "Password") },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20_000,
      greetingTimeout: 16_000,
      socketTimeout: 60_000,
    });
    try {
      await client.connect();
    } catch (error) {
      throw mapMailError(error);
    }
    try {
      if (!folder) return await task(client);
      const lock = await client.getMailboxLock(folder);
      try {
        return await task(client);
      } finally {
        lock.release();
      }
    } catch (error) {
      throw mapMailError(error);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async function smtp(ctx: ConnectorContext): Promise<SmtpTransportLike> {
    const secure = configBoolean(ctx, "smtp_secure", false);
    return factories.createSmtpTransport({
      host: requireConfig(ctx, "smtp_host", "SMTP host"),
      port: configNumber(ctx, "smtp_port", secure ? 465 : 587),
      secure,
      requireTLS: !secure,
      auth: { user: requireConfig(ctx, "username", "Username"), pass: requireSecret(ctx, "password", "Password") },
      connectionTimeout: 20_000,
    });
  }

  return defineConnector({
    manifest,

    async test(ctx) {
      const folder = defaultFolder(ctx);
      const exists = await withImap(ctx, folder, async (client) => (client.mailbox ? client.mailbox.exists : undefined));
      let smtpStatus = "not configured";
      if (configString(ctx, "smtp_host")) {
        const transport = await smtp(ctx);
        try {
          await transport.verify();
          smtpStatus = "ok";
        } catch (error) {
          throw mapMailError(error);
        } finally {
          transport.close?.();
        }
      }
      return {
        ok: true,
        message: `IMAP login ok (${folder}: ${exists ?? "?"} messages); SMTP ${smtpStatus}.`,
        details: { messages: exists, smtp: smtpStatus },
      };
    },

    operations: {
      async list_messages(input, ctx) {
        const folder = optString(input, "folder") ?? defaultFolder(ctx);
        const top = optLimit(input, "top", 25, 100);
        const unreadOnly = optBoolean(input, "unread_only") ?? false;
        const sinceInput = optString(input, "since");
        const since = sinceInput ? parseIsoDateTime(sinceInput, "since") : undefined;
        return withImap(ctx, folder, async (client) => {
          // IMAP SINCE has day granularity; the exact time is applied after fetching.
          const criteria: SearchObject = unreadOnly || since ? {} : { all: true };
          if (unreadOnly) criteria.seen = false;
          if (since) criteria.since = new Date(since);
          const uids = (await client.search(criteria, { uid: true })) || [];
          const selected = [...uids].sort((a, b) => b - a).slice(0, since ? top * 4 : top);
          if (selected.length === 0) return { items: [], total: 0, has_more: false, folder };
          const messages = await client.fetchAll(selected, SUMMARY_QUERY, { uid: true });
          const items = messages
            .filter((m) => !since || !m.internalDate || new Date(m.internalDate).toISOString() >= since)
            .sort((a, b) => b.uid - a.uid)
            .slice(0, top)
            .map((m) => summarize(folder, m));
          return { items, total: items.length, has_more: uids.length > items.length, folder };
        });
      },

      async get_message(input, ctx) {
        const { folder, uid } = parseMessageId(reqString(input, "message_id"), defaultFolder(ctx));
        return withImap(ctx, folder, async (client) => {
          const message = await client.fetchOne(String(uid), SUMMARY_QUERY, { uid: true });
          if (!message) throw new ConnectorError(`Message ${messageId(folder, uid)} not found`, "not_found");
          const structure = analyzeStructure(message.bodyStructure);
          const bodyPart = structure.text ?? structure.html;
          let body = "";
          if (bodyPart) {
            const { content } = await client.download(String(uid), bodyPart, { uid: true, maxBytes: MAX_TEXT_BYTES });
            // imapflow converts text parts to UTF-8.
            const text = (await readAll(content, MAX_TEXT_BYTES + 1024)).toString("utf8");
            body = structure.text ? text : htmlToText(text);
          }
          return { ...summarize(folder, message), body, body_format: "text", attachments: structure.attachments };
        });
      },

      async get_attachment(input, ctx) {
        const id = reqString(input, "message_id");
        const { folder, uid } = parseMessageId(id, defaultFolder(ctx));
        const part = reqString(input, "attachment_id");
        if (!/^\d+(\.\d+)*$/.test(part)) throw new ConnectorError(`attachment_id must be a MIME part number such as 2 or 1.2 (got "${part}")`, "validation");
        return withImap(ctx, folder, async (client) => {
          const { meta, content } = await client.download(String(uid), part, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES });
          const bytes = await readAll(content, MAX_ATTACHMENT_BYTES);
          return {
            id: part,
            message_id: messageId(folder, uid),
            name: meta.filename ?? `attachment-${part}`,
            contentType: meta.contentType ?? "application/octet-stream",
            size: bytes.length,
            contentBytes: bytes.toString("base64"),
          };
        });
      },

      async send_mail(input, ctx) {
        const to = recipientList(input, "to", true);
        const cc = recipientList(input, "cc", false);
        const bcc = recipientList(input, "bcc", false);
        const subject = reqString(input, "subject");
        const body = reqString(input, "body");
        const html = (optEnum(input, "content_type", ["text", "html"] as const) ?? (looksLikeHtml(body) ? "html" : "text")) === "html";
        const inReplyTo = optString(input, "in_reply_to");
        const from = configString(ctx, "from_address") ?? requireConfig(ctx, "username", "Username");
        const transport = await smtp(ctx);
        try {
          const info = await transport.sendMail({
            from,
            to,
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
            subject,
            ...(html ? { html: body, text: htmlToText(body) } : { text: body }),
            ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
          });
          return { ok: true, sent: true, message_id: info.messageId ?? null, accepted: info.accepted ?? to, rejected: info.rejected ?? [], from, to, cc, subject };
        } catch (error) {
          throw mapMailError(error);
        } finally {
          transport.close?.();
        }
      },
    },

    async poll(_eventId, ctx, cursor) {
      const folder = defaultFolder(ctx);
      const state = parsePollCursor(cursor);
      return withImap(ctx, folder, async (client) => {
        const mailbox = client.mailbox;
        const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
        const uidNext = mailbox ? mailbox.uidNext : 1;
        // First poll, or the folder was recreated (new UIDVALIDITY): start after the newest message.
        if (!state || state.uidValidity !== uidValidity) {
          return { events: [], cursor: JSON.stringify({ uidValidity, lastUid: uidNext - 1 }) };
        }
        const uids = ((await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > state.lastUid);
        if (uids.length === 0) return { events: [], cursor: JSON.stringify(state) };
        const selected = [...uids].sort((a, b) => a - b).slice(0, 100);
        const messages = (await client.fetchAll(selected, SUMMARY_QUERY, { uid: true })).sort((a, b) => a.uid - b.uid);
        const events: ConnectorEvent[] = messages.map((m) => ({
          id: messageId(folder, m.uid),
          type: NEW_MESSAGE_EVENT.id,
          occurredAt: m.internalDate ? new Date(m.internalDate).toISOString() : new Date().toISOString(),
          data: summarize(folder, m),
        }));
        const lastUid = selected[selected.length - 1] ?? state.lastUid;
        return { events, cursor: JSON.stringify({ uidValidity, lastUid }) };
      });
    },
  });
}

export const imapSmtpConnector = createImapSmtpConnector();
