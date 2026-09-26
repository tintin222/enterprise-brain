import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Every domain table is company-scoped (the same rule Paperclip follows), so a
 * single Enterprise Brain deployment can serve several companies with isolated data.
 */

export const EMBEDDING_DIMENSIONS = 1024;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const companyId = () => uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const departments = pgTable(
  "departments",
  {
    id: id(),
    companyId: companyId(),
    key: text("key").notNull(),
    templateId: text("template_id"),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    icon: text("icon"),
    /** Snapshot of the department template (mission, KPIs, roles, systems). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /** Its AI employees stop starting work when their model cost this month reaches it, together. */
    monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("departments_company_key").on(t.companyId, t.key)],
);

/**
 * People who use the product. "admin" runs the installation (usually IT); everyone else is a
 * "member" whose rights come from their departments (manager or worker).
 */
export const users = pgTable(
  "users",
  {
    id: id(),
    companyId: companyId(),
    /** Lower-case; the sign-in identity for passwords, Microsoft and Google alike. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    /** scrypt hash; null for people who only sign in with Microsoft or Google. */
    passwordHash: text("password_hash"),
    /** The identity provider of the last sign-in ("password", "microsoft", "google", "demo") and its subject id. */
    authProvider: text("auth_provider"),
    externalId: text("external_id"),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    /** What reaches them outside the app, and where (NotificationPreferences). */
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_company_email").on(t.companyId, t.email)],
);

/**
 * A person's account in a chat channel (Teams, Google Chat): who they are there, and where to reach
 * them (the conversation with the company's app). Linked to the person by their email.
 */
export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: id(),
    companyId: companyId(),
    /** teams · google-chat */
    channel: text("channel").notNull(),
    /** Their id in the channel: the Entra object id for Teams, users/… for Google Chat. */
    externalId: text("external_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    name: text("name"),
    /** How to reach them: Teams { serviceUrl, conversationId, tenantId, botId }; Google Chat { space }. */
    address: jsonb("address").$type<Record<string, unknown>>().notNull().default({}),
    /** In a conversation with the app, the AI employee they are talking to. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("channel_accounts_external").on(t.companyId, t.channel, t.externalId), index("channel_accounts_user").on(t.userId)],
);

/**
 * What reached whom, where: a work-queue item, a morning summary, or news of a task someone gave.
 * One row per person and thing, so nothing arrives twice; `ref` locates the message to update it.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** item · summary · task */
    kind: text("kind").notNull(),
    /** approval · question · review · failure · notice; "day" for summaries; a task status for task news */
    itemType: text("item_type").notNull(),
    /** The approval or work item id, the summary's local date, or the task id. */
    itemId: text("item_id").notNull(),
    /** email · teams · google-chat */
    channel: text("channel").notNull(),
    /** sending · sent · failed · updated */
    status: text("status").notNull().default("sending"),
    attempts: integer("attempts").notNull().default(0),
    ref: jsonb("ref").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notifications_once").on(t.userId, t.kind, t.itemType, t.itemId), index("notifications_item").on(t.companyId, t.itemId)],
);

/** Who works in which department, as its manager or as a worker. */
export const departmentMembers = pgTable(
  "department_members",
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("worker"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("department_members_department_user").on(t.departmentId, t.userId), index("department_members_user").on(t.userId)],
);

/** Browser sessions. The id is the SHA-256 of the cookie's token, so a leaked table can't be replayed. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    companyId: companyId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const processes = pgTable(
  "processes",
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    templateId: text("template_id"),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    status: text("status").notNull().default("active"),
    /** Snapshot of the process template (trigger, steps, KPIs, integrations). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("processes_company_key").on(t.companyId, t.key)],
);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    processId: uuid("process_id").references(() => processes.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    archetype: text("archetype").notNull(),
    status: text("status").notNull().default("draft"),
    source: text("source").notNull().default("manual"),
    templateId: text("template_id"),
    builderSessionId: uuid("builder_session_id"),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    paperclipAgentId: text("paperclip_agent_id"),
    // Employment: not part of the versioned job definition, so a rollback keeps them.
    /** The person accountable for this AI employee: sets its level, hears when it stops. */
    managerUserId: uuid("manager_user_id").references(() => users.id, { onDelete: "set null" }),
    /** How much it may do alone: shadow, supervised or trusted. */
    probation: text("probation").notNull().default("supervised"),
    /** What a trusted AI employee may do alone (TrustLimits). */
    limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
    /** It stops starting work when this month's model cost reaches the budget. */
    monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_company_slug").on(t.companyId, t.slug)],
);

/** Every change to an agent definition is revisioned so it can be reviewed and rolled back. */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_versions_agent_version").on(t.agentId, t.version)],
);

export const connectorInstances = pgTable(
  "connector_instances",
  {
    id: id(),
    companyId: companyId(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    /** Non-secret configuration (base URLs, tenant ids...). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM encrypted JSON of the secret configuration fields. */
    secretsCiphertext: text("secrets_ciphertext"),
    status: text("status").notNull().default("unverified"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connector_instances_company").on(t.companyId)],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    source: text("source").notNull().default("upload"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("files_company").on(t.companyId)],
);

export const knowledgeCollections = pgTable(
  "knowledge_collections",
  {
    id: id(),
    companyId: companyId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("knowledge_collections_company_key").on(t.companyId, t.key)],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: id(),
    companyId: companyId(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    source: text("source").notNull().default("upload"),
    uri: text("uri"),
    mimeType: text("mime_type"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    contentHash: text("content_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("knowledge_documents_collection").on(t.collectionId),
    index("knowledge_documents_collection_hash").on(t.collectionId, t.contentHash),
    index("knowledge_documents_company_created").on(t.companyId, t.createdAt),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    companyId: companyId(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("knowledge_chunks_document").on(t.documentId),
    index("knowledge_chunks_collection").on(t.collectionId),
    index("knowledge_chunks_company_model").on(t.companyId, t.embeddingModel),
    index("knowledge_chunks_company_collection").on(t.companyId, t.collectionId),
    index("knowledge_chunks_tsv").using("gin", t.tsv),
  ],
);

/**
 * A task: one piece of work from start to finish, lasting minutes or days. It has a status, a history
 * (task_events plus its runs) and, while it waits, a next check. Each working session is a run.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Short reference people and emails use: EB-7K2Q9. */
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    /** working | waiting | needs_person | paused | done | stopped | failed */
    status: text("status").notNull().default("working"),
    /** What started it: request (a person), mailbox, schedule, form, webhook, paperclip, connector-event */
    source: text("source").notNull().default("request"),
    sourceRef: text("source_ref"),
    requestedBy: text("requested_by"),
    /** The work as it arrived: a request's text, an email, a form's fields. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    /** What it does when no person is needed any more: complete, wait for a reply, or follow up later. */
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    /** What it waits for: a reply (by its reference or thread) or a time; a workflow run to resume. */
    waitingFor: jsonb("waiting_for").$type<Record<string, unknown>>(),
    /** When it looks at the task again on its own. */
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    outcome: text("outcome"),
    wakeups: integer("wakeups").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tasks_company_ref").on(t.companyId, t.ref),
    index("tasks_company_status").on(t.companyId, t.status, t.updatedAt),
    index("tasks_agent").on(t.agentId),
    index("tasks_next_check").on(t.status, t.nextCheckAt),
  ],
);

/** A task's history: what happened, who did it, and the run it happened in. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    companyId: companyId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull().default(""),
    actor: text("actor").notNull().default("system"),
    runId: uuid("run_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task").on(t.taskId, t.createdAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    agentVersion: integer("agent_version").notNull().default(1),
    trigger: text("trigger").notNull().default("manual"),
    triggerRef: text("trigger_ref"),
    status: text("status").notNull().default("queued"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>(),
    /** Workflow context: results of completed steps, used to resume after approvals. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    currentStep: text("current_step"),
    error: text("error"),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    isTest: boolean("is_test").notNull().default(false),
    /** The task this run works on (none for test runs, and for runs from before tasks existed). */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("runs_company_created").on(t.companyId, t.createdAt), index("runs_agent").on(t.agentId)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    stepId: text("step_id"),
    message: text("message").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    companyId: companyId(),
    /** Null for approvals requested outside a run (e.g. from a chat conversation). */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** "workflow" (pauses a run), "deferred" (tool call executed on approval) */
    origin: text("origin").notNull().default("workflow"),
    stepId: text("step_id").notNull(),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    /** What happens when approved (tool/operation + resolved input). */
    action: jsonb("action").$type<Record<string, unknown>>().notNull().default({}),
    assigneeRole: text("assignee_role"),
    /** Why a person is asked, in plain words ("Supervised: every change goes to a person"). */
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("approvals_company_status").on(t.companyId, t.status)],
);

/**
 * The work queue besides approvals: questions an AI employee asks, checks of Shadow AI employees' work,
 * tasks that failed, and notices (an AI employee stopped at its budget). Each is for a person (often the
 * AI employee's manager) or for anyone who handles its department's work.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: id(),
    companyId: companyId(),
    /** question · review · failure · notice */
    kind: text("kind").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    /** What the AI employee suggests, and why. */
    suggestion: text("suggestion"),
    reason: text("reason"),
    /** Answer choices for a question. */
    options: jsonb("options").$type<string[]>(),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    /** open · done · dismissed */
    status: text("status").notNull().default("open"),
    answer: text("answer"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("work_items_company_status").on(t.companyId, t.status, t.createdAt), index("work_items_task").on(t.taskId)],
);

export const mailMessages = pgTable(
  "mail_messages",
  {
    id: id(),
    companyId: companyId(),
    mailbox: text("mailbox").notNull(),
    direction: text("direction").notNull().default("inbound"),
    externalId: text("external_id"),
    threadId: text("thread_id"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    /** The HTML version, when it was sent with one (notifications with buttons). */
    bodyHtml: text("body_html"),
    attachments: jsonb("attachments")
      .$type<{ fileId: string; name: string; mimeType: string; size: number }[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("new"),
    classification: jsonb("classification").$type<Record<string, unknown>>(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** The task this email belongs to: sent while working on it, or a reply to it. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    inReplyTo: uuid("in_reply_to"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("mail_messages_company_mailbox").on(t.companyId, t.mailbox, t.receivedAt), index("mail_messages_external").on(t.companyId, t.externalId)],
);

/**
 * Where a watcher left off in a connected system: the mailbox's last message, the table's last row.
 * One per connection and watched event (per AI employee for events that start its duties).
 */
export const watchCursors = pgTable(
  "watch_cursors",
  {
    id: id(),
    companyId: companyId(),
    connectorInstanceId: uuid("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    cursor: text("cursor"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    /** How many new items the last poll brought. */
    lastCount: integer("last_count").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("watch_cursors_instance_key").on(t.connectorInstanceId, t.key)],
);

export const builderSessions = pgTable(
  "builder_sessions",
  {
    id: id(),
    companyId: companyId(),
    title: text("title").notNull(),
    status: text("status").notNull().default("interviewing"),
    requesterName: text("requester_name"),
    requesterEmail: text("requester_email"),
    requesterRole: text("requester_role"),
    department: text("department"),
    description: text("description").notNull().default(""),
    archetype: text("archetype"),
    templateId: text("template_id"),
    language: text("language").notNull().default("en"),
    /** RequirementTree: nodes + states. */
    tree: jsonb("tree").$type<Record<string, unknown>>().notNull().default({}),
    rounds: jsonb("rounds").$type<unknown[]>().notNull().default([]),
    samples: jsonb("samples").$type<unknown[]>().notNull().default([]),
    /** Continuously updated AgentDefinition draft (the "prototype"). */
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    summary: text("summary"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("builder_sessions_company").on(t.companyId, t.updatedAt)],
);

export const builderMessages = pgTable(
  "builder_messages",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => builderSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    round: integer("round"),
    attachments: jsonb("attachments").$type<{ fileId: string; name: string }[]>().notNull().default([]),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("builder_messages_session").on(t.sessionId, t.createdAt)],
);

export const stakeholderRequests = pgTable(
  "stakeholder_requests",
  {
    id: id(),
    companyId: companyId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => builderSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    questionnaire: text("questionnaire").notNull(),
    questions: jsonb("questions").$type<{ nodeId: string; question: string; why?: string; answer?: string }[]>().notNull(),
    status: text("status").notNull().default("draft"),
    /** Opaque token for the public answer link sent to the stakeholder. */
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
    createdAt: createdAt(),
  },
  (t) => [index("stakeholder_requests_session").on(t.sessionId)],
);

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The person who started it: conversations are private to them. Null in open mode and for machines. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_conversations_company").on(t.companyId, t.updatedAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<unknown[]>().notNull().default([]),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_conversation").on(t.conversationId, t.createdAt)],
);

/** Records kept by the built-in sandbox systems (demo ERP, CRM, HRIS, ATS, ITSM). */
export const sandboxRecords = pgTable(
  "sandbox_records",
  {
    id: id(),
    companyId: companyId(),
    system: text("system").notNull(),
    entity: text("entity").notNull(),
    externalId: text("external_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sandbox_records_key").on(t.companyId, t.system, t.entity, t.externalId)],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    companyId: companyId(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_company_created").on(t.companyId, t.createdAt)],
);

/**
 * Coaching notes: corrections from people (a finished task marked wrong and why, a check marked wrong,
 * a change corrected before approving, a reasoned rejection). Each becomes a rule in a later version.
 */
export const coachingNotes = pgTable(
  "coaching_notes",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** task (a finished task marked wrong) | check (a check marked wrong) | correction | rejection */
    kind: text("kind").notNull(),
    note: text("note").notNull(),
    by: text("by").notNull(),
    /** open | applied (in `appliedVersion`) | kept (its manager kept the version it corrected) */
    status: text("status").notNull().default("open"),
    proposalId: uuid("proposal_id"),
    appliedVersion: integer("applied_version"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("coaching_notes_agent").on(t.agentId, t.status, t.createdAt), index("coaching_notes_task").on(t.taskId)],
);

/** A change to an AI employee's job proposed from coaching notes: the rules, and how past tasks come out with it. */
export const coachingProposals = pgTable(
  "coaching_proposals",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The version it changes; publishing is refused when the job changed meanwhile. */
    baseVersion: integer("base_version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** The rules in plain words, one per correction. */
    rules: jsonb("rules").$type<string[]>().notNull().default([]),
    explanation: text("explanation").notNull().default(""),
    /** What changed in the job: paths with before and after. */
    changes: jsonb("changes").$type<Record<string, unknown>[]>().notNull().default([]),
    /** replaying | ready | published | kept | failed */
    status: text("status").notNull().default("replaying"),
    /** Past tasks run again with the proposal (as tests: nothing is sent or written), before and after. */
    replay: jsonb("replay").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    publishedVersion: integer("published_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("coaching_proposals_agent").on(t.agentId, t.createdAt)],
);

/**
 * Tables people make: business data described in plain words (supplier complaints, a training log).
 * The design (fields, who sees and edits it) is here; the records are in data_records.
 */
export const dataTables = pgTable(
  "data_tables",
  {
    id: id(),
    companyId: companyId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** The department it belongs to; null = company-wide. */
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** TableField[]: what each record holds. */
    fields: jsonb("fields").$type<Record<string, unknown>[]>().notNull(),
    titleField: text("title_field"),
    /** TableSettings: who sees it and who edits its records. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** Changes to the design, counted from 1. */
    /** Personal-data fields the data protection officer approved (keys); others hold no values until approved. */
    approvedPersonal: jsonb("approved_personal").$type<string[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    /** The number the next record gets (records are numbered per table: #1, #2…). */
    nextNumber: integer("next_number").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("data_tables_company_key").on(t.companyId, t.key)],
);

export const dataRecords = pgTable(
  "data_records",
  {
    id: id(),
    companyId: companyId(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => dataTables.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("data_records_table_number").on(t.tableId, t.number), index("data_records_table_created").on(t.tableId, t.createdAt)],
);

/** Every change to a record: who, when, and each field's value before and after. */
export const dataRecordChanges = pgTable(
  "data_record_changes",
  {
    id: id(),
    companyId: companyId(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => dataTables.id, { onDelete: "cascade" }),
    recordId: uuid("record_id")
      .notNull()
      .references(() => dataRecords.id, { onDelete: "cascade" }),
    /** created | updated | archived | restored | imported */
    action: text("action").notNull(),
    /** { field: { from, to } } */
    changes: jsonb("changes").$type<Record<string, unknown>>().notNull().default({}),
    by: text("by").notNull(),
    /** The AI employee's run that made it, when one did. */
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("data_record_changes_record").on(t.recordId, t.createdAt)],
);

/**
 * Apps people describe in plain words: pages of blocks (lists, forms, boards, charts, buttons) on the
 * company's tables, drawn by the platform. The design is data, never code.
 */
export const dataApps = pgTable(
  "data_apps",
  {
    id: id(),
    companyId: companyId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon"),
    /** The department it belongs to; null = company-wide. */
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** AppPage[]: its pages and their blocks. */
    pages: jsonb("pages").$type<Record<string, unknown>[]>().notNull(),
    /** AppSettings: who uses it. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("data_apps_company_key").on(t.companyId, t.key)],
);

/**
 * Calculations people describe as a rule ("rank suppliers by complaints per 100 deliveries"): the code
 * the Studio wrote for it runs in a sandbox on the rows of its tables. People see the rule, never the code.
 */
export const dataCalculations = pgTable(
  "data_calculations",
  {
    id: id(),
    companyId: companyId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    rule: text("rule").notNull(),
    explanation: text("explanation").notNull().default(""),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** The keys of the tables it reads. */
    tables: jsonb("tables").$type<string[]>().notNull().default([]),
    code: text("code").notNull(),
    /** CalculationOutput: rows (with columns), a number or a text. */
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    /** daily | weekly | monthly; null: when people run it. */
    schedule: text("schedule"),
    version: integer("version").notNull().default(1),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("data_calculations_company_key").on(t.companyId, t.key)],
);

/** Each run of a calculation: its result (or what went wrong), how long it took and on how many rows. */
export const dataCalculationRuns = pgTable(
  "data_calculation_runs",
  {
    id: id(),
    companyId: companyId(),
    calculationId: uuid("calculation_id")
      .notNull()
      .references(() => dataCalculations.id, { onDelete: "cascade" }),
    /** The calculation's version it ran. */
    version: integer("version").notNull(),
    /** succeeded | failed */
    status: text("status").notNull(),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    /** Rows it was given, all tables together. */
    rows: integer("rows").notNull().default(0),
    /** manual | schedule */
    trigger: text("trigger").notNull().default("manual"),
    by: text("by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("data_calculation_runs_calculation").on(t.calculationId, t.createdAt)],
);

/**
 * Recurring work a person asked for in plain words ("every Monday, send me the open complaints"):
 * on its schedule, in the company's time zone, the AI employee gets it as a task, asked by that person.
 */
export const recurringWork = pgTable(
  "recurring_work",
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The work, in the person's words (without when). */
    text: text("text").notNull(),
    /** RepeatSchedule: { every: day | weekday | week | month, weekday?, day?, time }. */
    schedule: jsonb("schedule").$type<Record<string, unknown>>().notNull(),
    /** Who asked for it: they are who the tasks are for. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    by: text("by").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastTaskId: uuid("last_task_id"),
    createdAt: createdAt(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stoppedBy: text("stopped_by"),
  },
  (t) => [index("recurring_work_company").on(t.companyId, t.agentId)],
);

/** Each version of what people build (tables, apps, calculations): its design then, to compare and go back to. */
export const dataVersions = pgTable(
  "data_versions",
  {
    id: id(),
    companyId: companyId(),
    /** table | app | calculation */
    itemType: text("item_type").notNull(),
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull(),
    /** The design at this version (a table's fields, an app's pages, a calculation's rule and code). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    note: text("note").notNull().default(""),
    by: text("by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("data_versions_item_version").on(t.itemType, t.itemId, t.version)],
);

/**
 * A decision the rules for building ask for: a table keeping personal data waits for the data
 * protection officer; sharing a table or an app beyond its department waits for IT.
 */
export const buildReviews = pgTable(
  "build_reviews",
  {
    id: id(),
    companyId: companyId(),
    /** personal-data | sharing */
    kind: text("kind").notNull(),
    /** table | app */
    itemType: text("item_type").notNull(),
    itemId: uuid("item_id").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** personal-data: { fields: [{ key, label }] }; sharing: { visibility: "company" }. */
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    /** waiting | approved | declined | withdrawn */
    status: text("status").notNull().default("waiting"),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("build_reviews_company").on(t.companyId, t.status)],
);

/**
 * A conversation with the Studio agent: Claude builds a solution (AI employees, tables, apps) with a
 * person, using the platform's own tools. `messages` is the model's conversation, only ever added to
 * (kept as written, key order and all, so earlier reasoning stays valid); `events` are what people see.
 */
export const studioThreads = pgTable(
  "studio_threads",
  {
    id: id(),
    companyId: companyId(),
    title: text("title").notNull(),
    /** The person it builds with: { userId, name, email, isAdmin, departments, openDepartmentIds }. */
    owner: jsonb("owner").$type<Record<string, unknown>>().notNull(),
    ownerId: text("owner_id"),
    /** The department it builds for, when said. */
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** idle (the Studio said its piece) | working | asking (waits for the person's answer) | failed */
    status: text("status").notNull().default("idle"),
    /** Its instructions and tools, as written when it started: { system, tools }. */
    setup: json("setup").$type<{ system: string; tools: unknown[] }>().notNull(),
    messages: json("messages").$type<unknown[]>().notNull().default([]),
    /** A question the Studio waits on: { call, results, questions }. */
    pending: json("pending").$type<Record<string, unknown> | null>(),
    /** What it built so far: AI employees, tables, apps, requests to IT, tries. */
    solution: jsonb("solution").$type<Record<string, unknown>>().notNull().default({}),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    /** When the person put the solution to work. */
    builtAt: timestamp("built_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("studio_threads_company").on(t.companyId, t.updatedAt)],
);

export const studioEvents = pgTable(
  "studio_events",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => studioThreads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** user | said | step | question | answer | part | try | request | built | error */
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("studio_events_thread_seq").on(t.threadId, t.seq)],
);
