import { and, eq } from "drizzle-orm";
import { isRecord, truncate } from "@enterprise-brain/core";
import { companies, watchCursors, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import type { ConnectorInstanceView, ConnectorService } from "./connectors.ts";
import { RunError, type RunEngine } from "./engine.ts";
import type { MailService } from "./mail.ts";
import type { TriggerService } from "./triggers.ts";

const NEW_MESSAGE = "new_message";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface WatchResult {
  /** Emails brought in (each routed as new work or as a reply to a task). */
  mail: number;
  /** Events in connected systems that started an AI employee's duty. */
  events: number;
  errors: string[];
}

/**
 * Watches connected systems on behalf of AI employees: the mailboxes they follow (Microsoft 365,
 * Gmail, IMAP) and the events that start their duties (a new record, row or file). Each connection
 * remembers where it left off, so nothing is handled twice and nothing from before is replayed.
 */
export class WatcherService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<WatchResult> | undefined;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly connectors: ConnectorService,
    private readonly mail: MailService,
    private readonly agents: AgentService,
    private readonly engine: RunEngine,
    private readonly triggers: TriggerService,
  ) {}

  /** One pass over every company. Overlapping calls share the pass in progress. */
  pollAll(): Promise<WatchResult> {
    if (!this.running) {
      this.running = (async () => {
        const total: WatchResult = { mail: 0, events: 0, errors: [] };
        for (const { id } of await this.handle.db.select({ id: companies.id }).from(companies)) {
          const result = await this.pollCompany(id);
          total.mail += result.mail;
          total.events += result.events;
          total.errors.push(...result.errors);
        }
        return total;
      })().finally(() => (this.running = undefined));
    }
    return this.running;
  }

  /** One pass over a company's connections. `wait`: finish the work it starts before returning (tests, "check now"). */
  async pollCompany(companyId: string, options: { wait?: boolean } = {}): Promise<WatchResult> {
    const result: WatchResult = { mail: 0, events: 0, errors: [] };
    const instances = (await this.connectors.list(companyId)).filter((i) => !i.sandbox);
    for (const instance of instances.filter((i) => i.category === "mail")) {
      try {
        result.mail += await this.pollMailbox(companyId, instance, options.wait ?? false);
      } catch (error) {
        result.errors.push(`${instance.name}: ${message(error)}`);
      }
    }
    try {
      result.events += await this.pollDuties(companyId, instances, result.errors, options.wait ?? false);
    } catch (error) {
      result.errors.push(message(error));
    }
    return result;
  }

  /** Bring in a mailbox's new mail and route each email: a reply goes to its task, anything else to the duties that follow the mailbox. */
  private async pollMailbox(companyId: string, instance: ConnectorInstanceView, wait: boolean): Promise<number> {
    const address = mailboxAddress(instance);
    return this.withCursor(companyId, instance.id, NEW_MESSAGE, async (cursor) => {
      const polled = await this.connectors.poll(companyId, instance.id, NEW_MESSAGE, cursor);
      if (!polled) return { cursor, count: 0 };
      let count = 0;
      for (const event of polled.events) {
        if (await this.mail.findByExternalId(companyId, event.id)) continue;
        const full = await this.connectors.executeInstance(companyId, instance.id, "get_message", { message_id: event.id }).catch(() => event.data);
        const message = isRecord(full) ? full : event.data;
        const from = parseAddress(message.from);
        const attachments = [];
        for (const attachment of Array.isArray(message.attachments) ? message.attachments.filter(isRecord) : []) {
          if (attachment.isInline === true || (attachment.kind && attachment.kind !== "file") || Number(attachment.size ?? 0) > MAX_ATTACHMENT_BYTES) continue;
          const content = await this.connectors
            .executeInstance(companyId, instance.id, "get_attachment", { message_id: event.id, attachment_id: attachment.id })
            .catch(() => undefined);
          if (!isRecord(content) || typeof content.contentBytes !== "string") continue;
          attachments.push({
            name: String(content.name ?? attachment.name ?? "attachment"),
            data: Buffer.from(content.contentBytes, "base64"),
            mimeType: typeof content.contentType === "string" ? content.contentType : undefined,
          });
        }
        const stored = await this.mail.ingest(companyId, {
          mailbox: address,
          from: from.address ?? "unknown@unknown",
          fromName: from.name ?? undefined,
          to: [...addressList(message.to), ...addressList(message.cc)],
          subject: String(message.subject ?? ""),
          body: bodyText(message),
          attachments,
          receivedAt: new Date(String(message.received_at ?? event.occurredAt)),
          externalId: event.id,
          threadId: stringOr(message.conversation_id) ?? stringOr(message.thread_id),
        });
        await this.triggers.routeInboundMail(companyId, stored, { wait });
        count += 1;
      }
      return { cursor: polled.cursor, count };
    });
  }

  /** Events in connected systems that start AI employees' duties (connector-event triggers). */
  private async pollDuties(companyId: string, instances: ConnectorInstanceView[], errors: string[], wait: boolean): Promise<number> {
    let started = 0;
    for (const agent of await this.agents.list(companyId, { status: "active" })) {
      for (const trigger of agent.definition.triggers) {
        if (trigger.type !== "connector-event") continue;
        // The trigger names a connection the job declares (its ref), a connection's id, or a connector type.
        const binding = agent.definition.connectors.find((c) => c.ref === trigger.connector);
        const instance = binding
          ? await this.connectors.resolve(companyId, binding).then((r) => instances.find((i) => i.id === r.instanceId)).catch(() => undefined)
          : instances.find((i) => i.id === trigger.connector || i.type === trigger.connector);
        if (!instance) continue;
        try {
          started += await this.withCursor(companyId, instance.id, `${trigger.event}#${agent.row.id}`, async (cursor) => {
            const polled = await this.connectors.poll(companyId, instance.id, trigger.event, cursor);
            if (!polled) return { cursor, count: 0 };
            let count = 0;
            for (const event of polled.events) {
              try {
                await this.engine.start(companyId, agent.row.id, { event: event.data, eventType: event.type, eventId: event.id }, {
                  trigger: "connector-event",
                  triggerRef: `${instance.name}: ${event.type} ${event.id}`,
                  title: `${agent.definition.name}: ${eventTitle(event.data) ?? `${event.type} ${event.id}`}`,
                  wait,
                });
                count += 1;
              } catch (error) {
                // Stopped (budget) or paused meanwhile: the event is skipped, like a duty that is off.
                if (!(error instanceof RunError)) throw error;
              }
            }
            return { cursor: polled.cursor, count };
          });
        } catch (error) {
          errors.push(`${agent.definition.name} (${instance.name}): ${message(error)}`);
        }
      }
    }
    return started;
  }

  /** Run one poll with the stored cursor, and store the new one (or the error). */
  private async withCursor(companyId: string, instanceId: string, key: string, poll: (cursor?: string) => Promise<{ cursor?: string; count: number }>): Promise<number> {
    const [row] = await this.handle.db
      .select()
      .from(watchCursors)
      .where(and(eq(watchCursors.connectorInstanceId, instanceId), eq(watchCursors.key, key)));
    try {
      const { cursor, count } = await poll(row?.cursor ?? undefined);
      const values = { cursor: cursor ?? row?.cursor ?? null, lastPolledAt: new Date(), lastCount: count, lastError: null, updatedAt: new Date() };
      if (row) await this.handle.db.update(watchCursors).set(values).where(eq(watchCursors.id, row.id));
      else await this.handle.db.insert(watchCursors).values({ companyId, connectorInstanceId: instanceId, key, ...values });
      return count;
    } catch (error) {
      const values = { lastPolledAt: new Date(), lastError: truncate(message(error), 500), updatedAt: new Date() };
      if (row) await this.handle.db.update(watchCursors).set(values).where(eq(watchCursors.id, row.id));
      else await this.handle.db.insert(watchCursors).values({ companyId, connectorInstanceId: instanceId, key, cursor: null, lastCount: 0, ...values });
      throw error;
    }
  }

  /** What each watcher saw last: for Settings → Connections. */
  async status(companyId: string) {
    return this.handle.db.select().from(watchCursors).where(eq(watchCursors.companyId, companyId));
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.pollAll()
        .then((result) => result.errors.forEach((error) => console.warn("[watch]", error)))
        .catch((error) => console.error("[watch]", error));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The mailbox a mail connection reads: its configured address, else its sender address, else its name. */
export function mailboxAddress(instance: Pick<ConnectorInstanceView, "config" | "name">): string {
  const config = instance.config;
  const candidates = [config.mailbox, config.from_address, config.username, config.user_id].filter((v): v is string => typeof v === "string" && v.includes("@"));
  return (candidates[0] ?? instance.name).toLowerCase();
}

/** Graph's { name, address } / { emailAddress }, Gmail's "Name <address>" and IMAP's { name, address } alike. */
function parseAddress(value: unknown): { name: string | null; address: string | null } {
  if (isRecord(value)) {
    const inner = isRecord(value.emailAddress) ? value.emailAddress : value;
    return { name: stringOr(inner.name) ?? null, address: stringOr(inner.address)?.toLowerCase() ?? null };
  }
  if (typeof value === "string") {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
    if (match) return { name: match[1]!.trim() || null, address: match[2]!.trim().toLowerCase() };
    return { name: null, address: value.trim().toLowerCase() || null };
  }
  return { name: null, address: null };
}

function addressList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list.map((entry) => parseAddress(entry).address).filter((a): a is string => Boolean(a));
}

function bodyText(message: Record<string, unknown>): string {
  const body = typeof message.body === "string" ? message.body : typeof message.text === "string" ? message.text : String(message.preview ?? "");
  if (message.body_format === "html" || /<(html|body|p|div|br)\b/i.test(body)) {
    return body
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return body;
}

function eventTitle(data: Record<string, unknown>): string | undefined {
  for (const key of ["title", "name", "subject", "number", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 100);
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
