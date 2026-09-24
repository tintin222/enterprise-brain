import { Readable } from "node:stream";
import type { FetchMessageObject, FetchQueryObject, ImapFlowOptions, MailboxObject, SearchObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { createImapSmtpConnector, type ImapClientLike, type SmtpMail, type SmtpTransportLike } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

interface StoredMessage {
  uid: number;
  seen: boolean;
  date: Date;
  subject: string;
  parts: Record<string, { content: string | Buffer; contentType?: string; filename?: string }>;
  structure: FetchMessageObject["bodyStructure"];
}

const plain = (uid: number, subject: string, seen: boolean, date: string): StoredMessage => ({
  uid,
  seen,
  date: new Date(date),
  subject,
  parts: { "1": { content: `Body of ${subject}` } },
  structure: { type: "text/plain", parameters: { charset: "utf-8" }, size: 20 },
});

class FakeImap implements ImapClientLike {
  readonly calls: string[] = [];
  mailbox: MailboxObject | false = false;
  constructor(
    readonly options: ImapFlowOptions,
    private readonly messages: StoredMessage[],
    private readonly failConnect?: Error,
  ) {}
  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.failConnect) throw this.failConnect;
  }
  async logout(): Promise<void> {
    this.calls.push("logout");
  }
  async getMailboxLock(path: string) {
    this.calls.push(`lock:${path}`);
    const uidNext = Math.max(0, ...this.messages.map((m) => m.uid)) + 1;
    this.mailbox = { path, uidNext, uidValidity: 1717171717n, exists: this.messages.length } as unknown as MailboxObject;
    return { release: () => this.calls.push("release") };
  }
  async search(query: SearchObject): Promise<number[]> {
    this.calls.push(`search:${JSON.stringify(query)}`);
    return this.messages
      .filter((m) => (query.seen === false ? !m.seen : true))
      .filter((m) => (query.since ? m.date >= new Date(new Date(query.since).toISOString().slice(0, 10)) : true))
      .filter((m) => (typeof query.uid === "string" ? m.uid >= Number(query.uid.split(":")[0]) : true))
      .map((m) => m.uid);
  }
  private toFetch(m: StoredMessage): FetchMessageObject {
    return {
      seq: m.uid,
      uid: m.uid,
      flags: new Set(m.seen ? ["\\Seen"] : []),
      internalDate: m.date,
      size: 1000,
      envelope: {
        subject: m.subject,
        date: m.date,
        messageId: `<${m.uid}@mail.example>`,
        from: [{ name: "Nordic Bearings AB", address: "invoices@nordicbearings.example" }],
        to: [{ address: "ap@acme.example" }],
      },
      bodyStructure: m.structure,
    };
  }
  async fetchAll(range: number[] | string, _query: FetchQueryObject): Promise<FetchMessageObject[]> {
    this.calls.push(`fetchAll:${JSON.stringify(range)}`);
    const uids = Array.isArray(range) ? range : [];
    return this.messages.filter((m) => uids.includes(m.uid)).map((m) => this.toFetch(m));
  }
  async fetchOne(uid: string): Promise<FetchMessageObject | false> {
    const message = this.messages.find((m) => m.uid === Number(uid));
    return message ? this.toFetch(message) : false;
  }
  async download(uid: string, part: string | undefined) {
    this.calls.push(`download:${uid}:${part}`);
    const message = this.messages.find((m) => m.uid === Number(uid));
    const stored = message?.parts[part ?? "1"];
    if (!stored) throw new Error("part not found");
    return { meta: { contentType: stored.contentType, filename: stored.filename }, content: Readable.from([Buffer.from(stored.content)]) };
  }
}

class FakeSmtp implements SmtpTransportLike {
  readonly sent: SmtpMail[] = [];
  verified = false;
  closed = false;
  async sendMail(mail: SmtpMail) {
    this.sent.push(mail);
    return { messageId: "<generated@acme.example>", accepted: mail.to, rejected: [] };
  }
  async verify() {
    this.verified = true;
    return true;
  }
  close() {
    this.closed = true;
  }
}

const invoiceMessage: StoredMessage = {
  uid: 42,
  seen: false,
  date: new Date("2026-09-24T07:30:00Z"),
  subject: "Invoice NB-77812",
  parts: {
    "1": { content: "Dear customer,\nplease find invoice NB-77812 attached." },
    "2": { content: Buffer.from("%PDF-1.7 invoice"), contentType: "application/pdf", filename: "NB-77812.pdf" },
  },
  structure: {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, size: 60 },
      { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "NB-77812.pdf" }, size: 48213 },
    ],
  },
};

function setup(messages: StoredMessage[], failConnect?: Error) {
  const imapClients: FakeImap[] = [];
  const smtp = new FakeSmtp();
  let smtpOptions: unknown;
  const connector = createImapSmtpConnector({
    createImapClient: (options) => {
      const client = new FakeImap(options, messages, failConnect);
      imapClients.push(client);
      return client;
    },
    createSmtpTransport: (options) => {
      smtpOptions = options;
      return smtp;
    },
  });
  const ctx = makeCtx({
    config: { imap_host: "imap.acme.example", smtp_host: "smtp.acme.example", username: "ap@acme.example", from_address: "Acme AP <ap@acme.example>" },
    secrets: { password: "app-password" },
  });
  return { connector, ctx, imapClients, smtp, smtpOptions: () => smtpOptions };
}

describe("imap-smtp", () => {
  it("lists unread messages newest first with folder-qualified ids", async () => {
    const { connector, ctx, imapClients } = setup([plain(40, "Old", true, "2026-09-20T08:00:00Z"), plain(41, "Reminder", false, "2026-09-23T08:00:00Z"), invoiceMessage]);
    const result = await run(connector, "list_messages", { unread_only: true, top: 5 }, ctx);
    expect(result.items.map((m: any) => m.id)).toEqual(["INBOX:42", "INBOX:41"]);
    expect(result.items[0]).toMatchObject({
      subject: "Invoice NB-77812",
      from: { name: "Nordic Bearings AB", address: "invoices@nordicbearings.example" },
      received_at: "2026-09-24T07:30:00.000Z",
      is_read: false,
      has_attachments: true,
    });
    expect(result.items[1].has_attachments).toBe(false);
    const client = imapClients[0]!;
    expect(client.options).toMatchObject({ host: "imap.acme.example", port: 993, secure: true, auth: { user: "ap@acme.example", pass: "app-password" }, logger: false });
    expect(client.calls).toEqual(["connect", "lock:INBOX", 'search:{"seen":false}', "fetchAll:[42,41]", "release", "logout"]);
  });

  it("filters by exact time when 'since' is given", async () => {
    const { connector, ctx } = setup([plain(41, "Morning", false, "2026-09-24T05:00:00Z"), invoiceMessage]);
    const result = await run(connector, "list_messages", { since: "2026-09-24T06:00:00Z" }, ctx);
    expect(result.items.map((m: any) => m.uid)).toEqual([42]);
  });

  it("reads a message body and its attachments", async () => {
    const { connector, ctx, imapClients } = setup([invoiceMessage]);
    const message = await run(connector, "get_message", { message_id: "INBOX:42" }, ctx);
    expect(message).toMatchObject({ id: "INBOX:42", body: "Dear customer,\nplease find invoice NB-77812 attached.", body_format: "text" });
    expect(message.attachments).toEqual([{ id: "2", name: "NB-77812.pdf", contentType: "application/pdf", size: 48213, isInline: false }]);
    const attachment = await run(connector, "get_attachment", { message_id: "INBOX:42", attachment_id: "2" }, ctx);
    expect(attachment).toEqual({
      id: "2",
      message_id: "INBOX:42",
      name: "NB-77812.pdf",
      contentType: "application/pdf",
      size: 16,
      contentBytes: Buffer.from("%PDF-1.7 invoice").toString("base64"),
    });
    expect(imapClients.every((c) => c.calls.at(-1) === "logout")).toBe(true);
    expect((await expectConnectorError(connector.execute("get_message", { message_id: "INBOX:999" }, ctx))).code).toBe("not_found");
    expect((await expectConnectorError(connector.execute("get_attachment", { message_id: "INBOX:42", attachment_id: "../1" }, ctx))).code).toBe("validation");
  });

  it("sends mail through SMTP with STARTTLS by default", async () => {
    const { connector, ctx, smtp, smtpOptions } = setup([]);
    const result = await run(connector, "send_mail", { to: "invoices@nordicbearings.example", subject: "Re: Invoice NB-77812", body: "<p>Received, thank you.</p>", in_reply_to: "<42@mail.example>" }, ctx);
    expect(result).toMatchObject({ ok: true, sent: true, message_id: "<generated@acme.example>", from: "Acme AP <ap@acme.example>" });
    expect(smtp.sent[0]).toEqual({
      from: "Acme AP <ap@acme.example>",
      to: ["invoices@nordicbearings.example"],
      subject: "Re: Invoice NB-77812",
      html: "<p>Received, thank you.</p>",
      text: "Received, thank you.",
      inReplyTo: "<42@mail.example>",
      references: "<42@mail.example>",
    });
    expect(smtpOptions()).toMatchObject({ host: "smtp.acme.example", port: 587, secure: false, requireTLS: true, auth: { user: "ap@acme.example", pass: "app-password" } });
    expect(smtp.closed).toBe(true);
  });

  it("tests IMAP login and SMTP, and maps authentication failures", async () => {
    const { connector, ctx, smtp } = setup([invoiceMessage]);
    expect(await connector.test(ctx)).toMatchObject({ ok: true, message: "IMAP login ok (INBOX: 1 messages); SMTP ok." });
    expect(smtp.verified).toBe(true);
    const failing = setup([], Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true }));
    expect(await failing.connector.test(failing.ctx)).toMatchObject({ ok: false, details: { code: "auth" } });
  });

  it("polls new messages by UID", async () => {
    const messages = [plain(40, "Before", false, "2026-09-24T06:00:00Z")];
    const { connector, ctx } = setup(messages);
    const first = await connector.poll!("new_message", ctx);
    expect(first.events).toEqual([]);
    expect(JSON.parse(first.cursor!)).toEqual({ uidValidity: "1717171717", lastUid: 40 });
    messages.push(invoiceMessage);
    const second = await connector.poll!("new_message", ctx, first.cursor);
    expect(second.events.map((e) => e.id)).toEqual(["INBOX:42"]);
    expect(second.events[0]).toMatchObject({ type: "new_message", data: { subject: "Invoice NB-77812" } });
    const third = await connector.poll!("new_message", ctx, second.cursor);
    expect(third.events).toEqual([]);
  });
});
