import { join } from "node:path";
import { eq } from "drizzle-orm";
import { BRAIN_SOURCES, BrainCatalog, BrainService, BrainSources, sourceName, sourcePriority } from "@enterprise-brain/brain";
import { loadCatalog } from "@enterprise-brain/catalog";
import { createDefaultRegistry, type ConnectorRegistry, type ScreenOperator } from "@enterprise-brain/connectors";
import { channelName, type Catalog } from "@enterprise-brain/core";
import { companies, createDatabase, type DatabaseHandle } from "@enterprise-brain/db";
import { KnowledgeService } from "@enterprise-brain/knowledge";
import { createEmbedderFromEnv, createLlmFromEnv, type Embedder, type LlmClient } from "@enterprise-brain/llm";
import { createScreensFromEnv } from "@enterprise-brain/screens";
import { ActivityService } from "./activity.ts";
import { AgentService } from "./agents.ts";
import { brainCatalogDeps, brainSourceDeps } from "./brain-deps.ts";
import { ChannelAccounts } from "./channel-accounts.ts";
import { ChatChannelSender } from "./chat-channels.ts";
import { CatalogService } from "./catalog-service.ts";
import { CoachingNotes } from "./coaching-notes.ts";
import { ensureCompanyBrain } from "./company-brain.ts";
import { TurnPlanner } from "./conversation-turns.ts";
import { agentActor, ConversationService, GENERAL_CHANNEL, type ChannelSpec } from "./conversations.ts";
import { MentionCards } from "./mentions.ts";
import { ConnectorService } from "./connectors.ts";
import { EmploymentService } from "./employment.ts";
import { RunEngine } from "./engine.ts";
import { ReportService } from "./reports.ts";
import { PlatformEvents } from "./events.ts";
import { FileService } from "./files.ts";
import { GoogleChatTransport } from "./google-chat.ts";
import { ActionLinks } from "./links.ts";
import { MailService } from "./mail.ts";
import { EmailChannel, NotificationService } from "./notifications.ts";
import { PeopleService } from "./people.ts";
import { QueueService } from "./queue.ts";
import { SecretBox } from "./secrets.ts";
import { AppService } from "./apps.ts";
import { CalculationService } from "./calculations.ts";
import { RecurringWorkService } from "./recurring.ts";
import { VersionService } from "./versions.ts";
import { ReviewService } from "./reviews.ts";
import { TableService } from "./tables.ts";
import { TeamsTransport } from "./teams.ts";
import { TaskService } from "./tasks.ts";
import { TriggerService } from "./triggers.ts";
import { WatcherService } from "./watchers.ts";
import { WorkService } from "./work.ts";

/** How often a company's built-in channels are checked against its departments when lists ask. */
const CHANNEL_SYNC_MS = 5 * 60_000;

export type CompanyRow = typeof companies.$inferSelect;

export interface PlatformOptions {
  db: DatabaseHandle;
  dataDir: string;
  llm: LlmClient;
  embedder: Embedder;
  secretBox: SecretBox;
  catalog: Catalog;
  registry?: ConnectorRegistry;
  /** Works old systems' screens (a headless browser with Claude's browser and computer use). */
  screens?: ScreenOperator & { close?(): Promise<void> };
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
  /** Performance and cost reports. */
  readonly reports: ReportService;
  /** Conversations: people and AI employees in one thread. */
  readonly conversations: ConversationService;
  /** When each company's built-in channels were last brought in step. */
  private readonly channelsSyncedAt = new Map<string, number>();
  /** Who answers in a conversation, and when. */
  readonly turns: TurnPlanner;
  /** What an AI employee gets about the things a message names with "@". */
  readonly mentionCards: MentionCards;
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
  /** Works old systems through their screens, for screen connections. */
  readonly screens?: ScreenOperator & { close?(): Promise<void> };
  /** The tables people make (business data), which AI employees reach through the Tables connection. */
  readonly tables: TableService;
  /** Apps people describe: pages of lists, forms, boards and charts on the tables, drawn by the platform. */
  readonly apps: AppService;
  /** Rules people say in plain words, run in a sandbox on the tables' rows. */
  readonly calculations: CalculationService;
  /** Every version of the tables, apps and calculations people build, to compare and go back to. */
  readonly versions: VersionService;
  /** Decisions the rules for building ask for: personal data (the data protection officer), sharing (IT). */
  readonly reviews: ReviewService;
  /** Work people ask AI employees to do regularly ("every Monday: send me the open complaints"). */
  readonly recurring: RecurringWorkService;
  /** What the company knows about itself: people, processes, systems, clients, projects and what happens. */
  readonly brain: BrainService;
  /** The systems the company brain learns from. */
  readonly brainSources: BrainSources;
  /** The company's tables in the brain, read from its databases through their connections. */
  readonly brainCatalog: BrainCatalog;

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
    this.screens = options.screens;
    this.connectors = new ConnectorService(this.handle, options.registry ?? createDefaultRegistry(), this.secretBox, this.files, this.screens);
    this.versions = new VersionService(this.handle);
    this.tables = new TableService(this.handle, this.connectors, this.files, this.versions);
    this.connectors.useTables((companyId) => this.tables.storeFor(companyId));
    this.knowledge = new KnowledgeService(this.handle, this.embedder);
    this.mail = new MailService(this.handle, this.files, this.connectors);
    this.agents = new AgentService(this.handle);
    this.calculations = new CalculationService(this.handle, this.tables, {}, this.versions);
    this.apps = new AppService(this.handle, this.tables, this.agents, this.calculations, this.versions);
    this.reviews = new ReviewService(this.handle, this.tables, this.apps);
    this.tasks = new TaskService(this.handle, this.events);
    this.work = new WorkService(this.handle, this.events);
    this.coachingNotes = new CoachingNotes(this.handle, this.activity);
    this.reports = new ReportService(this.handle);
    this.brain = new BrainService(this.handle, {
      priority: sourcePriority,
      originName: sourceName,
      onChange: (companyId, change) =>
        this.activity.record(companyId, {
          actor: change.actor,
          action: change.action,
          entityType: "brain",
          entityId: change.entityId,
          summary: change.summary,
        }),
    });
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
      brain: this.brain,
    });
    this.catalog = new CatalogService(this.handle, options.catalog, this.agents, this.knowledge, this.activity);
    this.brainSources = new BrainSources(
      this.handle,
      this.brain,
      brainSourceDeps({ handle: this.handle, catalog: this.catalog, people: this.people, agents: this.agents, connectors: this.connectors }),
      BRAIN_SOURCES,
    );
    this.brainCatalog = new BrainCatalog(this.brain, brainCatalogDeps(this.connectors));
    this.triggers = new TriggerService(this.handle, this.agents, this.engine, this.mail, this.tasks, this.people);
    this.triggers.onTick((now) => this.calculations.runDue(now));
    this.recurring = new RecurringWorkService(this.handle, this.agents, this.engine);
    this.triggers.onTick((now) => this.recurring.runDue(now));
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
    this.mentionCards = new MentionCards({
      brain: this.brain,
      tables: this.tables,
      apps: this.apps,
      calculations: this.calculations,
      files: this.files,
      knowledge: this.knowledge,
      tasks: this.tasks,
      agents: this.agents,
      people: this.people,
    });
    this.conversations = new ConversationService({
      handle: this.handle,
      people: this.people,
      agents: this.agents,
      tasks: this.tasks,
      work: this.work,
      queue: this.queue,
      events: this.events,
      activity: this.activity,
      cards: this.mentionCards,
      brain: this.brain,
    });
    this.turns = new TurnPlanner({
      conversations: this.conversations,
      engine: this.engine,
      agents: this.agents,
      tasks: this.tasks,
      people: this.people,
      cards: this.mentionCards,
      llm: this.llm,
      knowledge: this.knowledge,
      brain: this.brain,
    });
    this.notifications.watchConversations(this.conversations);
    // A task's brief carries the comments people wrote in its conversation; its history shows there too.
    this.tasks.useBriefExtras((task) => this.conversations.taskBriefExtras(task));
    this.tasks.onEvent((companyId, task, event) => this.conversations.mirrorTaskEvent(companyId, task, event));
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
    screens?: ScreenOperator & { close?(): Promise<void> };
    env?: NodeJS.ProcessEnv;
  }): Promise<Platform> {
    const env = options.env ?? process.env;
    const db = await createDatabase(
      options.databaseUrl ? { url: options.databaseUrl } : options.inMemory ? {} : { dataDir: join(options.dataDir, "db") },
    );
    const llm = options.llm ?? createLlmFromEnv(env);
    return new Platform({
      db,
      dataDir: options.dataDir,
      llm,
      embedder: options.embedder ?? createEmbedderFromEnv(env),
      secretBox: SecretBox.fromEnvOrFile(join(options.dataDir, "master.key"), env),
      catalog: options.catalog ?? (await loadCatalog()),
      registry: options.registry,
      screens: options.screens ?? createScreensFromEnv(llm, env),
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
    await this.prepareCompany(row!.id);
    return row!;
  }

  /**
   * What every company has, made or brought up to date when the app starts: the company brain as a
   * participant, the conversations people had before conversations existed, #general and the departments'
   * channels, and the free topics of before channels as channels or direct messages.
   */
  async prepareCompany(companyId: string): Promise<void> {
    await ensureCompanyBrain(this.agents, companyId);
    await this.conversations.adoptLegacyChat(companyId);
    await this.syncChannels(companyId, { force: true });
    await this.conversations.adoptTopics(companyId);
  }

  /**
   * #general and one channel per department, made when missing and kept in step with the departments
   * (names, who may read them, their AI employees at work). Once in five minutes per company unless forced.
   */
  async syncChannels(companyId: string, options: { force?: boolean } = {}): Promise<void> {
    const at = this.channelsSyncedAt.get(companyId);
    if (!options.force && at && Date.now() - at < CHANNEL_SYNC_MS) return;
    this.channelsSyncedAt.set(companyId, Date.now());
    const [departments, open, agents] = await Promise.all([
      this.catalog.departments(companyId),
      this.catalog.openDepartmentIds(companyId),
      this.agents.list(companyId),
    ]);
    const working = agents.filter((a) => a.row.status === "active" || a.row.status === "testing");
    const specs: ChannelSpec[] = [
      { aboutId: GENERAL_CHANNEL, name: GENERAL_CHANNEL, title: "Everyone in the company", visibility: "company", ais: [] },
      ...departments.map(
        (d): ChannelSpec => ({
          aboutId: d.id,
          name: channelName(d.key) || channelName(d.name) || "department",
          title: d.name,
          visibility: open.includes(d.id) ? "company" : "department",
          departmentId: d.id,
          ais: working.filter((a) => a.row.departmentId === d.id).map(agentActor),
        }),
      ),
    ];
    await this.conversations.ensureChannels(companyId, specs);
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
    // Conversations finish what they were writing (a turn's message, a task's mirrored event) before the database closes.
    await this.turns.idle();
    await this.conversations.idle();
    await this.screens?.close?.();
    await this.handle.close();
  }
}
