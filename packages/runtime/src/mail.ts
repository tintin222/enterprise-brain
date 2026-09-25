import { and, desc, eq, sql } from "drizzle-orm";
import { mailMessages, type DatabaseHandle } from "@enterprise-brain/db";
import type { ConnectorService } from "./connectors.ts";
import type { FileService } from "./files.ts";

export type MailMessage = typeof mailMessages.$inferSelect;

export interface InboundMail {
  mailbox: string;
  from: string;
  fromName?: string;
  to?: string[];
  subject: string;
  body: string;
  attachments?: { name: string; data: Buffer; mimeType?: string }[];
  attachmentFileIds?: string[];
  receivedAt?: Date;
  externalId?: string;
  threadId?: string;
}

export interface OutboundMail {
  mailbox?: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  cc?: string[];
  /** The task it is sent for. */
  taskId?: string;
}

/** The email object agents receive as `input.email` for mailbox-triggered runs. */
export interface EmailInput {
  id: string;
  mailbox: string;
  from: string;
  fromName: string | null;
  to: string[];
  subject: string;
  body: string;
  attachments: string[];
  attachmentNames: string[];
  receivedAt: string;
}

/**
 * Mailboxes. Inbound mail arrives from real mail connectors (Microsoft 365,
 * Gmail, IMAP) or the built-in sandbox mailbox; outbound mail goes through the
 * company's mail connector when one is configured, otherwise it is kept in the
 * sandbox outbox so demos never send real email.
 */
export class MailService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly fileService: FileService,
    private readonly connectors: ConnectorService,
  ) {}

  async ingest(companyId: string, mail: InboundMail): Promise<MailMessage> {
    const attachments: { fileId: string; name: string; mimeType: string; size: number }[] = [];
    for (const attachment of mail.attachments ?? []) {
      const stored = await this.fileService.put(companyId, {
        name: attachment.name,
        data: attachment.data,
        mimeType: attachment.mimeType,
        source: "mail",
      });
      attachments.push({ fileId: stored.id, name: stored.name, mimeType: stored.mimeType, size: stored.size });
    }
    for (const fileId of mail.attachmentFileIds ?? []) {
      const meta = await this.fileService.meta(companyId, fileId);
      attachments.push({ fileId, name: meta.name, mimeType: meta.mimeType, size: meta.size });
    }
    const [row] = await this.handle.db
      .insert(mailMessages)
      .values({
        companyId,
        mailbox: mail.mailbox.toLowerCase(),
        direction: "inbound",
        externalId: mail.externalId ?? null,
        threadId: mail.threadId ?? null,
        fromAddress: mail.from,
        fromName: mail.fromName ?? null,
        toAddresses: mail.to ?? [mail.mailbox],
        subject: mail.subject,
        bodyText: mail.body,
        attachments,
        status: "new",
        receivedAt: mail.receivedAt ?? new Date(),
      })
      .returning();
    return row!;
  }

  async list(companyId: string, filter: { mailbox?: string; direction?: string; status?: string; limit?: number } = {}) {
    const conditions = [eq(mailMessages.companyId, companyId)];
    if (filter.mailbox) conditions.push(eq(mailMessages.mailbox, filter.mailbox.toLowerCase()));
    if (filter.direction) conditions.push(eq(mailMessages.direction, filter.direction));
    if (filter.status) conditions.push(eq(mailMessages.status, filter.status));
    return this.handle.db
      .select()
      .from(mailMessages)
      .where(and(...conditions))
      .orderBy(desc(mailMessages.receivedAt))
      .limit(filter.limit ?? 200);
  }

  async get(companyId: string, id: string): Promise<MailMessage> {
    const [row] = await this.handle.db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.id, id)));
    if (!row) throw new Error(`Mail message ${id} not found`);
    return row;
  }

  async mailboxes(companyId: string) {
    return this.handle.db
      .select({
        mailbox: mailMessages.mailbox,
        total: sql<number>`count(*)::int`,
        unprocessed: sql<number>`count(*) filter (where ${mailMessages.status} = 'new')::int`,
      })
      .from(mailMessages)
      .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.direction, "inbound")))
      .groupBy(mailMessages.mailbox);
  }

  async update(
    companyId: string,
    id: string,
    patch: Partial<Pick<MailMessage, "status" | "classification" | "runId">>,
  ): Promise<void> {
    await this.handle.db
      .update(mailMessages)
      .set(patch)
      .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.id, id)));
  }

  async draft(companyId: string, mail: OutboundMail): Promise<MailMessage> {
    return this.recordOutbound(companyId, mail, "draft");
  }

  /** Send through the configured mail connector, or keep in the sandbox outbox. */
  async send(companyId: string, mail: OutboundMail): Promise<{ messageId: string; delivery: "connector" | "sandbox" }> {
    const instances = await this.connectors.list(companyId);
    const mailConnector = instances.find((i) => i.category === "mail" && !i.sandbox && i.status !== "error");
    let delivery: "connector" | "sandbox" = "sandbox";
    if (mailConnector) {
      const resolved = await this.connectors.resolve(companyId, { ref: "mail", category: "mail", instanceId: mailConnector.id });
      const original = mail.inReplyTo ? await this.get(companyId, mail.inReplyTo).catch(() => undefined) : undefined;
      const canReply = original?.externalId && resolved.impl.manifest.operations.some((o) => o.id === "reply_to_message");
      if (canReply) {
        await this.connectors.execute(companyId, resolved, "reply_to_message", { message_id: original!.externalId, body: mail.body });
      } else {
        await this.connectors.execute(companyId, resolved, "send_mail", {
          to: mail.to,
          subject: mail.subject,
          body: mail.body,
          ...(mail.cc?.length ? { cc: mail.cc } : {}),
        });
      }
      delivery = "connector";
    }
    const row = await this.recordOutbound(companyId, mail, "sent");
    if (mail.inReplyTo) await this.update(companyId, mail.inReplyTo, { status: "replied" }).catch(() => undefined);
    return { messageId: row.id, delivery };
  }

  private async recordOutbound(companyId: string, mail: OutboundMail, status: "draft" | "sent"): Promise<MailMessage> {
    const original = mail.inReplyTo ? await this.get(companyId, mail.inReplyTo).catch(() => undefined) : undefined;
    const [row] = await this.handle.db
      .insert(mailMessages)
      .values({
        companyId,
        mailbox: (mail.mailbox ?? original?.mailbox ?? "outbox").toLowerCase(),
        direction: "outbound",
        fromAddress: mail.mailbox ?? original?.mailbox ?? "no-reply@enterprise-brain.local",
        toAddresses: [mail.to, ...(mail.cc ?? [])],
        subject: mail.subject,
        bodyText: mail.body,
        status,
        inReplyTo: original?.id ?? null,
        threadId: original?.threadId ?? null,
        taskId: mail.taskId ?? null,
      })
      .returning();
    return row!;
  }

  static toEmailInput(message: MailMessage): EmailInput {
    return {
      id: message.id,
      mailbox: message.mailbox,
      from: message.fromAddress,
      fromName: message.fromName,
      to: message.toAddresses,
      subject: message.subject,
      body: message.bodyText,
      attachments: message.attachments.map((a) => a.fileId),
      attachmentNames: message.attachments.map((a) => a.name),
      receivedAt: message.receivedAt.toISOString(),
    };
  }
}
