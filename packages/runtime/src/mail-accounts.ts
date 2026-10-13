import { and, eq, lt, or, isNull } from "drizzle-orm";
import type { Actor } from "@enterprise-brain/core";
import { ConnectorError, type ConnectorContext } from "@enterprise-brain/connectors";
import { mailAccounts, type DatabaseHandle } from "@enterprise-brain/db";
import type { LlmClient } from "@enterprise-brain/llm";
import type { ConnectorService } from "./connectors.ts";
import { MailTaskReader, senderOf, type PersonalMail } from "./mail-tasks.ts";
import type { PeopleService } from "./people.ts";
import type { ProjectService } from "./projects.ts";
import type { SecretBox } from "./secrets.ts";
import type { TodoService } from "./todos.ts";

export type MailAccountRow = typeof mailAccounts.$inferSelect;

/** The Google OAuth client the installation signs people in with; a person's Gmail is read with it too. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** A person's mail account as its page shows it: never a secret. */
export interface MailAccountView {
  provider: string;
  address: string;
  status: string;
  tasksEnabled: boolean;
  lastCheckedAt: string | null;
  lastCount: number;
  lastError: string | null;
  /** Emails read and tasks made since it was connected. */
  checked: number;
  made: number;
  quietSenders: string[];
  connectedAt: string;
}

export interface MailCheckResult {
  /** New emails looked at. */
  checked: number;
  /** To-dos made. */
  made: number;
  /** The first check only sets where to start reading: older mail is left alone. */
  first: boolean;
}

export class MailAccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MailAccountError";
  }
}

export interface MailAccountDeps {
  handle: DatabaseHandle;
  secretBox: SecretBox;
  connectors: ConnectorService;
  todos: TodoService;
  projects: ProjectService;
  people: PeopleService;
  llm: LlmClient;
}

/** How a to-do made from mail is signed. */
const GMAIL_ACTOR: Actor = { kind: "system", id: "gmail", name: "Gmail" };
/** New emails looked at per check: the rest wait for the next pass. */
const BATCH = 25;
/** The watcher checks an account this often. */
const CHECK_EVERY_MS = 5 * 60_000;
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface AccountData {
  quietSenders?: string[];
  checked?: number;
  made?: number;
}

function dataOf(row: MailAccountRow): AccountData {
  return row.data as AccountData;
}

/**
 * A person's own mailbox (Gmail), read for their to-dos only: connected by the person with the
 * installation's Google client, polled like a mail connection through the Gmail connector, each new
 * email read for whether it needs something from them. Nothing of it reaches the shared mail pipeline,
 * the AI employees or the brain.
 */
export class MailAccountService {
  private googleClientFor: ((companyId: string) => Promise<GoogleClient | undefined>) | undefined;
  private fetchImpl: typeof fetch | undefined;
  private readonly reader: MailTaskReader;

  constructor(
    private readonly deps: MailAccountDeps,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reader = new MailTaskReader(deps.llm, now);
  }

  private get db() {
    return this.deps.handle.db;
  }

  /** Where the Google client comes from (the server's sign-in settings). */
  useGoogleClient(fn: (companyId: string) => Promise<GoogleClient | undefined>): void {
    this.googleClientFor = fn;
  }

  /** Tests: Google and Gmail stood in for. */
  useFetch(fetchImpl: typeof fetch | undefined): void {
    this.fetchImpl = fetchImpl;
  }

  async googleClient(companyId: string): Promise<GoogleClient | undefined> {
    return this.googleClientFor?.(companyId);
  }

  private async row(companyId: string, userId: string): Promise<MailAccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.companyId, companyId), eq(mailAccounts.userId, userId), eq(mailAccounts.provider, "gmail")));
    return row;
  }

  private view(row: MailAccountRow): MailAccountView {
    const data = dataOf(row);
    return {
      provider: row.provider,
      address: row.address,
      status: row.status,
      tasksEnabled: row.tasksEnabled,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastCount: row.lastCount,
      lastError: row.lastError,
      checked: data.checked ?? 0,
      made: data.made ?? 0,
      quietSenders: data.quietSenders ?? [],
      connectedAt: row.createdAt.toISOString(),
    };
  }

  async get(companyId: string, userId: string): Promise<MailAccountView | null> {
    const row = await this.row(companyId, userId);
    return row ? this.view(row) : null;
  }

  /** The person's Gmail, connected (or connected again): the refresh token is sealed; reading starts from the first check. */
  async connect(companyId: string, userId: string, input: { address: string; refreshToken: string; scope: string }): Promise<MailAccountView> {
    const secrets = this.deps.secretBox.encrypt({ refresh_token: input.refreshToken });
    const existing = await this.row(companyId, userId);
    const values = {
      address: input.address.toLowerCase(),
      secretsCiphertext: secrets,
      scope: input.scope,
      cursor: null,
      status: "ok",
      lastError: null,
      updatedAt: this.now(),
    };
    const [row] = existing
      ? await this.db.update(mailAccounts).set(values).where(eq(mailAccounts.id, existing.id)).returning()
      : await this.db
          .insert(mailAccounts)
          .values({ companyId, userId, provider: "gmail", ...values, tasksEnabled: true, data: {} })
          .returning();
    return this.view(row!);
  }

  /** Forgets the mailbox: the permission is revoked at Google (best effort) and the row goes; the to-dos it made stay. */
  async disconnect(companyId: string, userId: string): Promise<boolean> {
    const row = await this.row(companyId, userId);
    if (!row) return false;
    try {
      const { refresh_token } = this.deps.secretBox.decrypt<{ refresh_token: string }>(row.secretsCiphertext);
      await (this.fetchImpl ?? globalThis.fetch)(`${REVOKE_URL}?token=${encodeURIComponent(refresh_token)}`, { method: "POST" });
    } catch {
      // Google may already have forgotten it; the row goes either way.
    }
    await this.db.delete(mailAccounts).where(eq(mailAccounts.id, row.id));
    return true;
  }

  async setTasksEnabled(companyId: string, userId: string, enabled: boolean): Promise<MailAccountView> {
    const row = await this.row(companyId, userId);
    if (!row) throw new MailAccountError("No mailbox is connected", 404);
    const [updated] = await this.db.update(mailAccounts).set({ tasksEnabled: enabled, updatedAt: this.now() }).where(eq(mailAccounts.id, row.id)).returning();
    return this.view(updated!);
  }

  /** "Not a task": mail from this sender makes no more to-dos. */
  async quiet(companyId: string, userId: string, sender: string): Promise<void> {
    const row = await this.row(companyId, userId);
    if (!row) return;
    const address = senderOf(sender).address;
    if (!address) return;
    const data = dataOf(row);
    const quietSenders = [...new Set([...(data.quietSenders ?? []), address])].slice(-200);
    await this.db
      .update(mailAccounts)
      .set({ data: { ...data, quietSenders }, updatedAt: this.now() })
      .where(eq(mailAccounts.id, row.id));
  }

  /** Reads the person's new mail now. */
  async check(companyId: string, userId: string): Promise<MailCheckResult> {
    const row = await this.row(companyId, userId);
    if (!row) throw new MailAccountError("No mailbox is connected", 404);
    return this.checkRow(row);
  }

  /** The watcher's pass: every account with tasks on that was not checked in the last five minutes. */
  async checkDue(companyId: string, options: { every?: number } = {}): Promise<{ accounts: number; made: number; errors: string[] }> {
    const before = new Date(this.now().getTime() - (options.every ?? CHECK_EVERY_MS));
    const rows = await this.db
      .select()
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.companyId, companyId),
          eq(mailAccounts.tasksEnabled, true),
          or(isNull(mailAccounts.lastCheckedAt), lt(mailAccounts.lastCheckedAt, before)),
        ),
      );
    const result = { accounts: 0, made: 0, errors: [] as string[] };
    for (const row of rows) {
      result.accounts += 1;
      try {
        result.made += (await this.checkRow(row)).made;
      } catch (error) {
        result.errors.push(`${row.address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  private async checkRow(row: MailAccountRow): Promise<MailCheckResult> {
    const client = await this.googleClient(row.companyId);
    if (!client) throw new MailAccountError("Google sign-in is not set up: ask IT", 409);
    const impl = this.deps.connectors.registry.get("gmail");
    if (!impl?.poll) throw new MailAccountError("The Gmail connector is not available", 500);
    let secrets: { refresh_token: string };
    try {
      secrets = this.deps.secretBox.decrypt<{ refresh_token: string }>(row.secretsCiphertext);
    } catch {
      throw await this.fail(row, "The saved permission could not be read: connect Gmail again");
    }
    const saveSecrets = async (patch: Record<string, string>) => {
      if (!patch.refresh_token) return;
      secrets = { refresh_token: patch.refresh_token };
      await this.db
        .update(mailAccounts)
        .set({ secretsCiphertext: this.deps.secretBox.encrypt(secrets), updatedAt: this.now() })
        .where(eq(mailAccounts.id, row.id));
    };
    const base = this.deps.connectors.context(
      row.companyId,
      { client_id: client.clientId, user_id: "me" },
      { client_secret: client.clientSecret, refresh_token: secrets.refresh_token },
      saveSecrets,
    );
    const ctx: ConnectorContext = this.fetchImpl ? { ...base, fetch: this.fetchImpl } : base;
    try {
      const polled = await impl.poll("new_message", ctx, row.cursor ?? undefined);
      const first = !row.cursor;
      const events = first ? [] : polled.events.slice(0, BATCH);
      let made = 0;
      if (events.length) {
        const messages: PersonalMail[] = [];
        for (const event of events) {
          const full = await impl.execute("get_message", { message_id: event.id }, ctx).catch(() => event.data);
          const m = (full && typeof full === "object" ? full : event.data) as Record<string, unknown>;
          messages.push({
            id: event.id,
            threadId: typeof m.thread_id === "string" ? m.thread_id : null,
            from: typeof m.from === "string" ? m.from : "",
            subject: typeof m.subject === "string" ? m.subject : "",
            receivedAt: typeof m.received_at === "string" ? m.received_at : event.occurredAt,
            labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
            body: typeof m.body === "string" ? m.body : "",
            preview: typeof m.preview === "string" ? m.preview : "",
          });
        }
        made = await this.makeTodos(row, messages);
      }
      const data = dataOf(row);
      // The cursor moves past the emails read; the ones beyond the batch come next time.
      const cursor = polled.events.length > events.length && !first ? row.cursor : (polled.cursor ?? row.cursor);
      await this.db
        .update(mailAccounts)
        .set({
          cursor,
          status: "ok",
          lastError: null,
          lastCheckedAt: this.now(),
          lastCount: made,
          data: { ...data, checked: (data.checked ?? 0) + events.length, made: (data.made ?? 0) + made },
          updatedAt: this.now(),
        })
        .where(eq(mailAccounts.id, row.id));
      return { checked: events.length, made, first };
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      const auth = error instanceof ConnectorError && error.code === "auth";
      const message = error instanceof Error ? error.message : String(error);
      throw await this.fail(row, auth ? `Connect Gmail again: Google no longer accepts the saved permission (${message})` : message, auth ? 409 : 502);
    }
  }

  private async fail(row: MailAccountRow, message: string, status = 502): Promise<MailAccountError> {
    await this.db
      .update(mailAccounts)
      .set({ status: "error", lastError: message.slice(0, 500), lastCheckedAt: this.now(), updatedAt: this.now() })
      .where(eq(mailAccounts.id, row.id));
    return new MailAccountError(message, status);
  }

  /** Each new email that needs something becomes the person's to-do, once. */
  private async makeTodos(row: MailAccountRow, messages: PersonalMail[]): Promise<number> {
    const person = await this.deps.people.get(row.companyId, row.userId).catch(() => undefined);
    const projects = (await this.deps.projects.list(row.companyId, { status: "open" })).map((p) => ({ id: p.id, name: p.name, summary: p.summary }));
    const decided = await this.reader.read(messages, {
      person: { name: person?.name ?? row.address, email: person?.email ?? null },
      projects,
      quietSenders: dataOf(row).quietSenders ?? [],
    });
    let made = 0;
    for (const task of decided) {
      if (!task.needsAction) continue;
      const message = messages.find((m) => m.id === task.id)!;
      const { created } = await this.deps.todos.add(
        row.companyId,
        {
          userId: row.userId,
          projectId: task.projectId,
          title: task.title,
          details: task.details,
          dueAt: task.due ? new Date(`${task.due}T17:00:00`) : null,
          source: "mail",
          sourceRef: message.id,
          link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
          data: { from: message.from, subject: message.subject, receivedAt: message.receivedAt, threadId: message.threadId, reason: task.reason },
        },
        GMAIL_ACTOR,
      );
      if (created) made += 1;
    }
    return made;
  }
}
