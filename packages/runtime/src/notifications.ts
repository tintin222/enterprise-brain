import { and, desc, eq, gte, or } from "drizzle-orm";
import { isRecord, NotificationPreferences, NotificationPreferencesPatch, TimeZone, truncate, type NotificationChannel } from "@enterprise-brain/core";
import { companies, notifications, tasks, users, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentRecord, AgentService } from "./agents.ts";
import type { PlatformEventMap, PlatformEvents } from "./events.ts";
import type { ActionLinks } from "./links.ts";
import type { MailService } from "./mail.ts";
import {
  itemEmail,
  summaryEmail,
  taskNewsEmail,
  type ItemMessage,
  type RenderedEmail,
  type SummaryMessage,
  type TaskNewsMessage,
} from "./notification-templates.ts";
import { PeopleError, type PeopleService, type Person } from "./people.ts";
import { audienceOf, isUrgent, type QueueEntry, type QueueService } from "./queue.ts";

export type NotificationRow = typeof notifications.$inferSelect;

/** What a channel keeps about a delivered message, to find it again (a chat card to update in place). */
export type DeliveryRef = Record<string, unknown>;

/** A delivered item that has since been handled (by anyone, anywhere). */
export interface HandledItem {
  companyId: string;
  person: Person;
  entry: QueueEntry;
  ref: DeliveryRef;
  by: string;
  outcome: string;
}

/** A way to reach people outside the app: email here; Teams and Google Chat register once connected. */
export interface ChannelSender {
  readonly id: NotificationChannel;
  /** Can it reach this person now (an account linked, a connection working)? */
  reaches(companyId: string, person: Person): Promise<boolean>;
  sendItem(message: ItemMessage): Promise<DeliveryRef>;
  sendSummary(message: SummaryMessage): Promise<DeliveryRef>;
  sendTaskNews?(message: TaskNewsMessage): Promise<DeliveryRef>;
  /** Show on a delivered item that it was handled, and by whom (a card updated in place). */
  updateItem?(handled: HandledItem): Promise<void>;
}

/** Notifications by email, through the company's mail connection (the sandbox outbox without one). */
export class EmailChannel implements ChannelSender {
  readonly id = "email" as const;

  constructor(private readonly mail: MailService) {}

  async reaches(_companyId: string, person: Person): Promise<boolean> {
    return Boolean(person.email);
  }

  sendItem(message: ItemMessage): Promise<DeliveryRef> {
    return this.send(message.companyId, message.person, itemEmail(message));
  }

  sendSummary(message: SummaryMessage): Promise<DeliveryRef> {
    return this.send(message.companyId, message.person, summaryEmail(message));
  }

  sendTaskNews(message: TaskNewsMessage): Promise<DeliveryRef> {
    return this.send(message.companyId, message.person, taskNewsEmail(message));
  }

  private async send(companyId: string, person: Person, email: RenderedEmail): Promise<DeliveryRef> {
    const sent = await this.mail.send(companyId, { to: person.email, subject: email.subject, body: email.text, html: email.html });
    return { messageId: sent.messageId, delivery: sent.delivery };
  }
}

export interface NotificationServiceDeps {
  handle: DatabaseHandle;
  people: PeopleService;
  agents: AgentService;
  queue: QueueService;
  events: PlatformEvents;
  links: ActionLinks;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Items older than this no longer arrive one by one: the morning summary lists them. */
const FRESH_MS = 24 * HOUR;
/** The summary still goes out this long after its time (the server was down, or started later). */
const SUMMARY_WINDOW_MINUTES = 4 * 60;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * MINUTE;
/** A delivery that never reported back (the server stopped mid-way) counts as failed after this. */
const STALE_SENDING_MS = 15 * MINUTE;
const AUTO_ORDER: NotificationChannel[] = ["teams", "google-chat", "email"];

/** A person's date and minute of the day in their time zone. */
export function localTime(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

/** Is it time for the person's morning summary (from summaryAt, for a few hours)? */
export function summaryDue(now: Date, preferences: Pick<NotificationPreferences, "summaryAt" | "timeZone">): boolean {
  const [hours, minutes] = preferences.summaryAt.split(":").map(Number);
  const at = (hours ?? 8) * 60 + (minutes ?? 30);
  const local = localTime(now, preferences.timeZone).minutes;
  return local >= at && local < at + SUMMARY_WINDOW_MINUTES;
}

/** Stored preferences, with the defaults (the company's time zone) for anything unset or no longer valid. */
export function readPreferences(stored: unknown, defaults: Partial<NotificationPreferences> = {}): NotificationPreferences {
  const base = NotificationPreferences.parse(defaults);
  const value = isRecord(stored) ? stored : {};
  const parsed = NotificationPreferences.safeParse({ ...base, ...value });
  if (parsed.success) return parsed.data;
  const result: Record<string, unknown> = { ...base };
  for (const [key, field] of Object.entries(NotificationPreferences.shape)) {
    const one = field.safeParse(value[key]);
    if (one.success && value[key] !== undefined) result[key] = one.data;
  }
  return result as NotificationPreferences;
}

/**
 * What reaches people outside the app, and where. Urgent items (what an AI employee waits on: approvals
 * and questions) arrive at once; the rest, and the day's news, in one summary each morning. Each person
 * chooses otherwise in their preferences. Every item reaches a person once, over one channel; handled
 * items update the cards already delivered.
 */
export class NotificationService {
  private readonly channels = new Map<NotificationChannel, ChannelSender>();
  private publicUrl = "http://localhost:3000";
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: NotificationServiceDeps) {
    // Event-driven delivery runs only while the service is started (the server); tests call dispatch().
    deps.events.on("queue.added", (event) => {
      if (this.running) void this.schedule(event.companyId, () => this.dispatch(event.companyId));
    });
    deps.events.on("queue.resolved", (event) => {
      if (this.running) void this.schedule(event.companyId, () => this.handled(event));
    });
  }

  /** Where the app is reached from outside: links in messages point here. */
  configure(options: { publicUrl: string }): void {
    this.publicUrl = options.publicUrl.replace(/\/$/, "");
  }

  register(channel: ChannelSender): void {
    this.channels.set(channel.id, channel);
  }

  channel(id: NotificationChannel): ChannelSender | undefined {
    return this.channels.get(id);
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  async preferences(companyId: string, userId: string): Promise<NotificationPreferences> {
    return readPreferences(await this.storedPreferences(companyId, userId), await this.companyDefaults(companyId));
  }

  /**
   * Change some preferences. Only what the person chose is stored: the rest follows the defaults
   * (such as the company's time zone) as they change.
   */
  async setPreferences(companyId: string, userId: string, patch: NotificationPreferencesPatch): Promise<NotificationPreferences> {
    const changes = Object.fromEntries(Object.entries(NotificationPreferencesPatch.parse(patch)).filter(([, value]) => value !== undefined));
    const stored = await this.storedPreferences(companyId, userId);
    // Earlier choices stay, those still valid (a time zone can disappear from the system).
    const kept: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(NotificationPreferencesPatch.shape)) {
      const one = field.safeParse(stored[key]);
      if (one.success && one.data !== undefined) kept[key] = one.data;
    }
    const chosen = { ...kept, ...changes };
    await this.deps.handle.db
      .update(users)
      .set({ preferences: chosen, updatedAt: new Date() })
      .where(and(eq(users.companyId, companyId), eq(users.id, userId)));
    return readPreferences(chosen, await this.companyDefaults(companyId));
  }

  private async storedPreferences(companyId: string, userId: string): Promise<Record<string, unknown>> {
    const [row] = await this.deps.handle.db
      .select({ preferences: users.preferences })
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.id, userId)));
    if (!row) throw new PeopleError(`Person ${userId} not found`, 404);
    return isRecord(row.preferences) ? row.preferences : {};
  }

  /** The channels that reach the person now, in the order "auto" tries them. */
  async reachable(companyId: string, person: Person): Promise<NotificationChannel[]> {
    const ids: NotificationChannel[] = [];
    for (const id of AUTO_ORDER) {
      const channel = this.channels.get(id);
      if (channel && (await channel.reaches(companyId, person).catch(() => false))) ids.push(id);
    }
    return ids;
  }

  private async companyDefaults(companyId: string): Promise<Partial<NotificationPreferences>> {
    const [company] = await this.deps.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const zone = company?.settings.timeZone;
    return TimeZone.safeParse(zone).success ? { timeZone: zone as string } : {};
  }

  /** Everyone's preferences at once (someone added since reads the defaults). */
  private async preferencesOfAll(companyId: string): Promise<(person: Person) => NotificationPreferences> {
    const defaults = await this.companyDefaults(companyId);
    const rows = await this.deps.handle.db.select({ id: users.id, preferences: users.preferences }).from(users).where(eq(users.companyId, companyId));
    const byId = new Map(rows.map((row) => [row.id, readPreferences(row.preferences, defaults)]));
    return (person) => byId.get(person.id) ?? readPreferences({}, defaults);
  }

  /** The channels to try for a person, their choice first; email is the fallback for a chat they can't be reached in. */
  private async channelsFor(companyId: string, person: Person, preferences: NotificationPreferences): Promise<ChannelSender[]> {
    const reachable = (await this.reachable(companyId, person)).map((id) => this.channels.get(id)!);
    if (preferences.channel === "auto") return reachable;
    const chosen = reachable.find((c) => c.id === preferences.channel);
    return chosen ? [chosen, ...reachable.filter((c) => c !== chosen && c.id === "email")] : reachable.filter((c) => c.id === "email");
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  /** The links of an item's message for one person: act (signed, a week), open in the app, preferences. */
  linksFor(
    person: Pick<Person, "id" | "companyId">,
    entry: Pick<QueueEntry, "type" | "id" | "task">,
    options: { now?: Date; via?: NotificationChannel } = {},
  ): ItemMessage["links"] {
    const token = this.deps.links.sign(
      { companyId: person.companyId, userId: person.id, type: entry.type, id: entry.id, via: options.via },
      { now: (options.now ?? new Date()).getTime() },
    );
    return {
      act: `${this.publicUrl}/act/${token}`,
      open: entry.task ? `${this.publicUrl}/work/${encodeURIComponent(entry.task.ref)}` : `${this.publicUrl}/work`,
      preferences: `${this.publicUrl}/?notifications=1`,
    };
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /** Deliver the open items that should reach people at once. Returns how many were sent. */
  async dispatch(companyId: string, now = new Date()): Promise<number> {
    const entries = (await this.deps.queue.open(companyId)).filter((e) => now.getTime() - e.createdAt.getTime() <= FRESH_MS);
    if (!entries.length) return 0;
    const people = await this.deps.people.list(companyId);
    const preferencesOf = await this.preferencesOfAll(companyId);
    const company = await this.company(companyId);
    let sent = 0;
    for (const entry of entries) {
      for (const person of audienceOf(entry, people)) {
        const wants = preferencesOf(person);
        if (wants.deliver === "off" || wants.deliver === "summary" || (wants.deliver === "urgent" && !isUrgent(entry))) continue;
        const candidates = await this.channelsFor(companyId, person, wants);
        if (!candidates.length) continue;
        const row = await this.claim({ companyId, userId: person.id, kind: "item", itemType: entry.type, itemId: entry.id, channel: candidates[0]!.id }, now);
        if (!row) continue;
        const message = (via: NotificationChannel): ItemMessage => ({
          companyId,
          companyName: company.name,
          person,
          entry,
          links: this.linksFor(person, entry, { now, via }),
        });
        if (await this.deliver(row, retryOrder(row, candidates), person, (channel) => channel.sendItem(message(channel.id)))) sent++;
      }
    }
    return sent;
  }

  /** Morning summaries for the people whose summary time has come. Returns how many were sent. */
  async summaries(companyId: string, now = new Date()): Promise<number> {
    const people = await this.deps.people.list(companyId);
    const preferencesOf = await this.preferencesOfAll(companyId);
    const due = people.filter((p) => p.status === "active" && preferencesOf(p).deliver !== "off" && summaryDue(now, preferencesOf(p)));
    if (!due.length) return 0;
    const company = await this.company(companyId);
    const entries = await this.deps.queue.open(companyId);
    const agents = (await this.deps.agents.list(companyId)).filter((a) => a.row.status !== "archived");
    const stats = await this.taskStats(companyId, new Date(now.getTime() - 24 * HOUR));
    let sent = 0;
    for (const person of due) {
      const wants = preferencesOf(person);
      const candidates = await this.channelsFor(companyId, person, wants);
      if (!candidates.length) continue;
      const date = localTime(now, wants.timeZone).date;
      const row = await this.claim({ companyId, userId: person.id, kind: "summary", itemType: "day", itemId: date, channel: candidates[0]!.id }, now);
      if (!row) continue;
      const needsYou = entries.filter((e) => audienceOf(e, people).some((p) => p.id === person.id));
      const aiEmployees = agents
        .filter((a) => worksWith(person, a))
        .map((a) => ({
          name: a.definition.name,
          link: `${this.publicUrl}/ai/${a.row.slug}`,
          ...(stats.get(a.row.id) ?? { done: 0, started: 0, needsPerson: 0 }),
        }))
        .filter((a) => a.done + a.started + a.needsPerson > 0);
      if (!needsYou.length && !aiEmployees.length) {
        // Nothing to say today: no empty message.
        await this.mark(row.id, { status: "skipped" });
        continue;
      }
      const newestFirst = needsYou.reverse();
      const message = (via: NotificationChannel): SummaryMessage => ({
        companyId,
        companyName: company.name,
        person,
        date,
        needsYou: newestFirst.map((entry) => ({ entry, link: this.linksFor(person, entry, { now, via }).act })),
        aiEmployees,
        links: { work: `${this.publicUrl}/work`, app: this.publicUrl, preferences: `${this.publicUrl}/?notifications=1` },
      });
      if (await this.deliver(row, retryOrder(row, candidates), person, (channel) => channel.sendSummary(message(channel.id)))) sent++;
    }
    return sent;
  }

  /** An item was handled: the cards already delivered for it say so, and by whom. */
  async handled(event: PlatformEventMap["queue.resolved"]): Promise<number> {
    const rows = await this.deps.handle.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, event.companyId),
          eq(notifications.kind, "item"),
          eq(notifications.itemType, event.type),
          eq(notifications.itemId, event.id),
          eq(notifications.status, "sent"),
        ),
      );
    const updatable = rows.filter((row) => this.channels.get(row.channel as NotificationChannel)?.updateItem);
    if (!updatable.length) return 0;
    const entry = await this.deps.queue.entry(event.companyId, event.type, event.id);
    if (!entry) return 0;
    const people = new Map((await this.deps.people.list(event.companyId)).map((p) => [p.id, p]));
    let updated = 0;
    for (const row of updatable) {
      const person = people.get(row.userId);
      if (!person) continue;
      try {
        await this.channels.get(row.channel as NotificationChannel)!.updateItem!({
          companyId: event.companyId,
          person,
          entry,
          ref: row.ref,
          by: event.by,
          outcome: event.outcome,
        });
        await this.mark(row.id, { status: "updated" });
        updated++;
      } catch (error) {
        console.warn(`[notifications] updating ${row.channel} message for ${person.email}: ${messageOf(error)}`);
      }
    }
    return updated;
  }

  /** What was sent to a person, newest first. */
  async sentTo(companyId: string, userId: string, limit = 50): Promise<NotificationRow[]> {
    return this.deps.handle.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  /** One pass over every company: urgent items, retries of failed deliveries, and morning summaries. */
  async tick(now = new Date()): Promise<void> {
    for (const company of await this.deps.handle.db.select({ id: companies.id }).from(companies)) {
      await this.schedule(company.id, async () => {
        await this.dispatch(company.id, now);
        await this.summaries(company.id, now);
      });
    }
  }

  /** Deliver as things happen, and look every interval for summaries and retries. */
  start(intervalMs = 60_000): void {
    if (this.running) return;
    this.running = true;
    const run = () => {
      if (!this.running || this.ticking) return;
      this.ticking = this.tick()
        .catch((error) => console.error("[notifications]", error))
        .finally(() => (this.ticking = undefined));
    };
    if (intervalMs > 0) {
      this.timer = setInterval(run, intervalMs);
      this.timer.unref?.();
      setTimeout(run, 1_000).unref?.();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  /** Resolves once the deliveries under way are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size || this.ticking) await Promise.all([...this.chains.values(), this.ticking]);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** One job at a time per company: deliveries triggered together don't race each other. */
  private schedule(key: string, job: () => Promise<unknown>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(job).then(
      () => undefined,
      (error) => console.error("[notifications]", error),
    );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /**
   * Take the right to deliver something to a person: the first time, or again after a failure (a few
   * times, some minutes apart). Undefined when it was delivered already or is being delivered.
   */
  private async claim(
    key: { companyId: string; userId: string; kind: string; itemType: string; itemId: string; channel: NotificationChannel },
    now: Date,
  ): Promise<NotificationRow | undefined> {
    const db = this.deps.handle.db;
    const [created] = await db
      .insert(notifications)
      .values({ ...key, status: "sending", attempts: 1, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [existing] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, key.userId),
          eq(notifications.kind, key.kind),
          eq(notifications.itemType, key.itemType),
          eq(notifications.itemId, key.itemId),
        ),
      );
    if (!existing || existing.attempts >= MAX_ATTEMPTS) return undefined;
    const age = now.getTime() - existing.updatedAt.getTime();
    const again = (existing.status === "failed" && age >= RETRY_AFTER_MS) || (existing.status === "sending" && age >= STALE_SENDING_MS);
    if (!again) return undefined;
    const [claimed] = await db
      .update(notifications)
      .set({ status: "sending", attempts: existing.attempts + 1, updatedAt: now })
      .where(and(eq(notifications.id, existing.id), eq(notifications.status, existing.status), eq(notifications.attempts, existing.attempts)))
      .returning();
    // The row keeps the last attempt's channel and error until this one reports (see retryOrder).
    return claimed;
  }

  private async deliver(
    row: NotificationRow,
    candidates: ChannelSender[],
    person: Person,
    send: (channel: ChannelSender) => Promise<DeliveryRef>,
  ): Promise<boolean> {
    const channel = candidates[0]!;
    try {
      const ref = await send(channel);
      await this.mark(row.id, { status: "sent", channel: channel.id, ref, error: null });
      return true;
    } catch (error) {
      await this.mark(row.id, { status: "failed", channel: channel.id, error: truncate(messageOf(error), 500) });
      console.warn(`[notifications] ${channel.id} to ${person.email}: ${messageOf(error)}`);
      return false;
    }
  }

  private async mark(id: string, patch: Partial<Pick<NotificationRow, "status" | "channel" | "ref" | "error">>): Promise<void> {
    await this.deps.handle.db
      .update(notifications)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(notifications.id, id));
  }

  private async company(companyId: string): Promise<{ id: string; name: string }> {
    const [row] = await this.deps.handle.db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId));
    return row ?? { id: companyId, name: "Enterprise Brain" };
  }

  /** Per AI employee since a moment: tasks finished, tasks started, and tasks waiting for a person now. */
  private async taskStats(companyId: string, since: Date): Promise<Map<string, { done: number; started: number; needsPerson: number }>> {
    const rows = await this.deps.handle.db
      .select({ agentId: tasks.agentId, status: tasks.status, createdAt: tasks.createdAt, closedAt: tasks.closedAt })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), or(gte(tasks.createdAt, since), gte(tasks.updatedAt, since), eq(tasks.status, "needs_person"))));
    const stats = new Map<string, { done: number; started: number; needsPerson: number }>();
    for (const row of rows) {
      const entry = stats.get(row.agentId) ?? { done: 0, started: 0, needsPerson: 0 };
      if (row.status === "done" && row.closedAt && row.closedAt >= since) entry.done++;
      if (row.createdAt >= since) entry.started++;
      if (row.status === "needs_person") entry.needsPerson++;
      stats.set(row.agentId, entry);
    }
    return stats;
  }
}

/** A person's AI employees for the summary: their departments', the ones they manage, and (admins) the company-wide ones. */
function worksWith(person: Person, agent: AgentRecord): boolean {
  if (agent.row.managerUserId === person.id) return true;
  if (!agent.row.departmentId) return person.role === "admin";
  return person.departments.some((d) => d.departmentId === agent.row.departmentId);
}

/** After a failed attempt over a chat channel, the retry goes by email when it can. */
function retryOrder(row: NotificationRow, candidates: ChannelSender[]): ChannelSender[] {
  if (row.attempts <= 1 || !row.error) return candidates;
  const others = candidates.filter((c) => c.id !== row.channel);
  return others.length ? others : candidates;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
