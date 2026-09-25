import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_company_email").on(t.companyId, t.email)],
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
  (t) => [index("mail_messages_company_mailbox").on(t.companyId, t.mailbox, t.receivedAt)],
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
