import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadCatalog } from "@enterprise-brain/catalog";
import { createDefaultRegistry, type ConnectorRegistry } from "@enterprise-brain/connectors";
import type { Catalog } from "@enterprise-brain/core";
import { companies, createDatabase, type DatabaseHandle } from "@enterprise-brain/db";
import { KnowledgeService } from "@enterprise-brain/knowledge";
import { createEmbedderFromEnv, createLlmFromEnv, type Embedder, type LlmClient } from "@enterprise-brain/llm";
import { ActivityService } from "./activity.ts";
import { AgentService } from "./agents.ts";
import { ChannelAccounts } from "./channel-accounts.ts";
import { ChatChannelSender } from "./chat-channels.ts";
import { CatalogService } from "./catalog-service.ts";
import { ChatService } from "./chat.ts";
import { CoachingNotes } from "./coaching-notes.ts";
import { ConnectorService } from "./connectors.ts";
import { EmploymentService } from "./employment.ts";
import { RunEngine } from "./engine.ts";
import { PlatformEvents } from "./events.ts";
import { FileService } from "./files.ts";
import { GoogleChatTransport } from "./google-chat.ts";
import { ActionLinks } from "./links.ts";
import { MailService } from "./mail.ts";
import { EmailChannel, NotificationService } from "./notifications.ts";
import { PeopleService } from "./people.ts";
import { QueueService } from "./queue.ts";
import { SecretBox } from "./secrets.ts";
import { TeamsTransport } from "./teams.ts";
import { TaskService } from "./tasks.ts";
import { TriggerService } from "./triggers.ts";
import { WatcherService } from "./watchers.ts";
import { WorkService } from "./work.ts";

export type CompanyRow = typeof companies.$inferSelect;

export interface PlatformOptions {
  db: DatabaseHandle;
  dataDir: string;
  llm: LlmClient;
  embedder: Embedder;
  secretBox: SecretBox;
  catalog: Catalog;
  registry?: ConnectorRegistry;
}

/** Composition root: every platform service, wired once and shared by the server, builder and CLI. */
export class Platform {
  readonly handle: DatabaseHandle;
  readonly dataDir: string;
  readonly llm: LlmClient;
  readonly embedder: Embedder;
  readonly secretBox: SecretBox;
  readonly activity: ActivityService;
  readonly files: FileService;
  readonly connectors: ConnectorService;
  readonly knowledge: KnowledgeService;
  readonly mail: MailService;
  readonly agents: AgentService;
  readonly engine: RunEngine;
  /** Corrections from people, kept for AI employees' next versions. */
  readonly coachingNotes: CoachingNotes;
  readonly chat: ChatService;
  readonly catalog: CatalogService;
  readonly triggers: TriggerService;
  readonly people: PeopleService;
  readonly employment: EmploymentService;
  readonly tasks: TaskService;
  readonly work: WorkService;
  readonly watchers: WatcherService;
  /** What changed, for the services that react to it (notifications, chat channels). */
  readonly events: PlatformEvents;
  readonly queue: QueueService;
  /** Signed links people act through outside the app (an approval email's buttons). */
  readonly actionLinks: ActionLinks;
  readonly notifications: NotificationService;
  /** People's accounts in Teams and Google Chat, and where their conversations with the app are. */
  readonly channelAccounts: ChannelAccounts;
  /** Writes in Teams through the company's bot. */
  readonly teams: TeamsTransport;
  /** Writes in Google Chat through the company's Chat app. */
  readonly googleChat: GoogleChatTransport;

  constructor(options: PlatformOptions) {
    this.handle = options.db;
    this.dataDir = options.dataDir;
    this.llm = options.llm;
    this.embedder = options.embedder;
    this.secretBox = options.secretBox;
    this.events = new PlatformEvents();
    this.activity = new ActivityService(this.handle);
    this.people = new PeopleService(this.handle);
    this.files = new FileService(this.handle, join(options.dataDir, "files"));
    this.connectors = new ConnectorService(this.handle, options.registry ?? createDefaultRegistry(), this.secretBox, this.files);
    this.knowledge = new KnowledgeService(this.handle, this.embedder);
    this.mail = new MailService(this.handle, this.files, this.connectors);
    this.agents = new AgentService(this.handle);
    this.tasks = new TaskService(this.handle, this.events);
    this.work = new WorkService(this.handle, this.events);
    this.coachingNotes = new CoachingNotes(this.handle, this.activity);
    this.engine = new RunEngine({
      handle: this.handle,
      llm: this.llm,
      files: this.files,
      connectors: this.connectors,
      knowledge: this.knowledge,
      mail: this.mail,
      agents: this.agents,
      activity: this.activity,
      tasks: this.tasks,
      work: this.work,
      events: this.events,
      coaching: this.coachingNotes,
    });
    this.chat = new ChatService(this.handle, this.llm, this.agents, this.knowledge, this.engine.toolDeps);
    this.catalog = new CatalogService(this.handle, options.catalog, this.agents, this.knowledge, this.activity);
    this.triggers = new TriggerService(this.handle, this.agents, this.engine, this.mail, this.tasks, this.people);
    this.employment = new EmploymentService(this.agents, this.people, this.engine, this.activity, this.connectors);
    this.watchers = new WatcherService(this.handle, this.connectors, this.mail, this.agents, this.engine, this.triggers);
    this.queue = new QueueService(this.handle, this.agents, this.work);
    this.actionLinks = new ActionLinks(this.secretBox.deriveKey("action-links"));
    this.channelAccounts = new ChannelAccounts(this.handle);
    this.teams = new TeamsTransport(this.connectors);
    this.googleChat = new GoogleChatTransport(this.connectors);
    this.notifications = new NotificationService({
      handle: this.handle,
      people: this.people,
      agents: this.agents,
      queue: this.queue,
      events: this.events,
      links: this.actionLinks,
      tasks: this.tasks,
      accounts: this.channelAccounts,
    });
    this.notifications.register(new EmailChannel(this.mail));
    this.notifications.register(new ChatChannelSender("teams", this.channelAccounts, this.teams));
    this.notifications.register(new ChatChannelSender("google-chat", this.channelAccounts, this.googleChat));
  }

  /** Create a platform from the environment: embedded Postgres under dataDir unless DATABASE_URL is set. */
  static async create(options: {
    dataDir: string;
    databaseUrl?: string;
    inMemory?: boolean;
    llm?: LlmClient;
    embedder?: Embedder;
    catalog?: Catalog;
    registry?: ConnectorRegistry;
    env?: NodeJS.ProcessEnv;
  }): Promise<Platform> {
    const env = options.env ?? process.env;
    const db = await createDatabase(
      options.databaseUrl ? { url: options.databaseUrl } : options.inMemory ? {} : { dataDir: join(options.dataDir, "db") },
    );
    return new Platform({
      db,
      dataDir: options.dataDir,
      llm: options.llm ?? createLlmFromEnv(env),
      embedder: options.embedder ?? createEmbedderFromEnv(env),
      secretBox: SecretBox.fromEnvOrFile(join(options.dataDir, "master.key"), env),
      catalog: options.catalog ?? (await loadCatalog()),
      registry: options.registry,
    });
  }

  /**
   * Creates the company if it doesn't exist. Settings: `mailDomain` (e.g. "acme.com.tr")
   * replaces the catalog's placeholder addresses (careers@company.com) when templates are installed.
   */
  async ensureCompany(input: { slug: string; name: string; settings?: Record<string, unknown> }): Promise<CompanyRow> {
    const [existing] = await this.handle.db.select().from(companies).where(eq(companies.slug, input.slug));
    if (existing) return existing;
    const [row] = await this.handle.db.insert(companies).values({ slug: input.slug, name: input.name, settings: input.settings ?? {} }).returning();
    return row!;
  }

  async companies(): Promise<CompanyRow[]> {
    return this.handle.db.select().from(companies);
  }

  async company(slugOrId: string): Promise<CompanyRow | undefined> {
    const rows = await this.handle.db.select().from(companies);
    return rows.find((c) => c.id === slugOrId || c.slug === slugOrId);
  }

  async close(): Promise<void> {
    this.triggers.stop();
    this.watchers.stop();
    await this.notifications.stop();
    await this.handle.close();
  }
}
