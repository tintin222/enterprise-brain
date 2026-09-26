/**
 * Domain and API types used by the console. Shapes mirror packages/core
 * (agent.ts, fields.ts, builder.ts, catalog.ts, connector.ts) and docs/API.md.
 * They are copied here on purpose: the web app never imports server packages.
 */

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "email"
  | "phone"
  | "url"
  | "select"
  | "multiselect"
  | "file"
  | "files"
  | "list"
  | "object";

export interface FieldOption {
  value: string;
  label?: string;
  description?: string;
}

export interface FieldSpec {
  key: string;
  label?: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  options?: FieldOption[];
  itemType?: FieldType;
  fields?: FieldSpec[];
  accept?: string[];
  hints?: string[];
  example?: unknown;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type Archetype = "document-processing" | "mail-triage" | "conversational" | "excel-automation" | "search" | "process-automation" | "report-generation";

export type TriggerSpec =
  | { type: "manual" }
  | { type: "form"; description?: string }
  | {
      type: "mailbox";
      mailbox: string;
      filter?: { subjectContains?: string[]; fromDomains?: string[]; hasAttachment?: boolean; categories?: string[] };
    }
  | { type: "schedule"; cron: string; timezone?: string }
  | { type: "webhook"; description?: string }
  | { type: "chat" }
  | { type: "paperclip"; description?: string }
  | { type: "connector-event"; connector: string; event: string };

export interface Criterion {
  id: string;
  label: string;
  description?: string;
  kind: "must" | "nice" | "knockout";
  weight: number;
  keywords?: string[];
}

export interface Category {
  value: string;
  label?: string;
  description?: string;
  keywords?: string[];
}

interface StepBase {
  id: string;
  name?: string;
  when?: string;
  onError?: "fail" | "continue";
}

export type WorkflowStep = StepBase &
  (
    | { type: "extract"; from: string; ocr?: "auto" | "always" | "never" }
    | { type: "llm.extract"; from: string; fields: FieldSpec[]; instructions?: string }
    | { type: "llm.classify"; from: string; categories: Category[]; multi?: boolean; instructions?: string }
    | { type: "llm.evaluate"; from: string; criteria: Criterion[]; context?: string; passScore?: number; instructions?: string }
    | { type: "llm.generate"; prompt: string; format?: "text" | "markdown" | "html"; fallback?: string }
    | { type: "knowledge.search"; query: string; collections?: string[]; topK?: number }
    | { type: "connector"; connector: string; operation: string; input: Record<string, unknown>; requiresApproval?: boolean }
    | { type: "approval"; title: string; details?: string; assigneeRole?: string }
    | { type: "mail.send"; to: string; subject: string; body: string; inReplyTo?: string; requiresApproval?: boolean }
    | { type: "excel.read"; from: string; sheet?: string }
    | { type: "excel.write"; data: string; fileName?: string }
    | { type: "agent"; task: string; tools: string[]; maxTurns?: number }
    | { type: "wait"; for: "reply" | "time"; days?: number; until?: string }
    | { type: "output"; value: Record<string, unknown> }
  );

export type WorkflowStepType = WorkflowStep["type"];

export interface ConnectorBinding {
  ref: string;
  category: string;
  instanceId?: string;
  purpose?: string;
  operations?: string[];
}

export type UiLayout = "form-results" | "chat" | "inbox" | "table" | "none";

export interface UiSpec {
  layout: UiLayout;
  title?: string;
  description?: string;
  submitLabel?: string;
  resultView?: "cards" | "table" | "json";
  highlight?: string[];
}

export interface Guardrails {
  approvalRequiredFor: string[];
  personalData: "none" | "contains" | "sensitive";
  retentionDays?: number;
  notes?: string[];
}

export interface AgentKpi {
  id: string;
  name: string;
  target?: string;
}

export interface AgentTest {
  name: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
}

export interface AgentDefinition {
  slug: string;
  name: string;
  title?: string;
  summary: string;
  department?: string;
  process?: string;
  archetype: Archetype;
  templateId?: string;
  instructions: string;
  model?: { model?: string; effort?: string; maxTokens?: number };
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  workflow: WorkflowStep[];
  tools: string[];
  triggers: TriggerSpec[];
  knowledge: { collections: string[] };
  connectors: ConnectorBinding[];
  guardrails: Guardrails;
  ui: UiSpec;
  kpis: AgentKpi[];
  tests: AgentTest[];
  paperclip?: { role?: string; title?: string; reportsTo?: string; capabilities?: string };
}

export type AgentStatus = "draft" | "testing" | "active" | "paused" | "archived";
export type AgentSource = "template" | "builder" | "manual";

/** Row of GET /agents (list), definition omitted. */
export interface AgentRow {
  id: string;
  companyId: string;
  departmentId: string | null;
  processId: string | null;
  slug: string;
  name: string;
  summary: string;
  archetype: Archetype;
  status: AgentStatus;
  source: AgentSource;
  templateId: string | null;
  builderSessionId: string | null;
  version: number;
  paperclipAgentId: string | null;
  managerUserId?: string | null;
  probation?: Probation;
  monthlyBudgetUsd?: number | null;
  createdAt: string;
  updatedAt: string;
  title?: string;
  department?: string;
  triggers?: TriggerSpec[];
  ui?: UiSpec;
  steps?: number;
}

export interface AgentVersion {
  version: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AgentDetail {
  agent: AgentRow;
  definition: AgentDefinition;
  versions: AgentVersion[];
  recentRuns: RunRow[];
  employment?: Employment;
  /** The viewer may change it (a manager of its department, or an admin). */
  canManage?: boolean;
  managerCandidates?: { id: string; name: string; title: string | null }[];
  /** Changes to it and coaching notes from people, newest first. */
  activity?: { id: string; actor: string; action: string; summary: string; createdAt: string }[];
}

/** How much an AI employee may do alone. */
export type Probation = "shadow" | "supervised" | "trusted";

export interface TrustLimits {
  maxAmount?: number;
  currency?: string;
  maxActionsPerDay?: number;
  mailDomains?: string[];
}

export interface Employment {
  manager: { id: string; name: string; email: string; title: string | null } | null;
  probation: Probation;
  limits: TrustLimits;
  monthlyBudgetUsd: number | null;
  costThisMonthUsd: number;
  /** It reached its budget, or its department reached its own. */
  stoppedByBudget: boolean;
  /** Its department's budget for all its AI employees together. */
  departmentBudget: { name: string; budgetUsd: number; spentUsd: number; reached: boolean } | null;
  changesToday: number;
  duties: { kind: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Runs & approvals
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface Usage {
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface RunRow {
  id: string;
  companyId?: string;
  agentId: string;
  agentVersion: number;
  trigger: string;
  triggerRef: string | null;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  usage: Usage;
  isTest: boolean;
  /** The task this run works on (none for test runs). */
  taskId?: string | null;
  currentStep: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentName?: string;
  agentSlug?: string;
  /** What each step returned (a run's own page only). */
  context?: { steps?: Record<string, unknown> } | null;
}

export interface RunEvent {
  id?: string;
  runId: string;
  seq: number;
  type: string;
  stepId: string | null;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type ApprovalAction =
  | { type: "decision"; result?: unknown; error?: string }
  | {
      type: "connector";
      ref: string;
      category: string;
      instanceId?: string;
      operation: string;
      operationName?: string;
      system?: string;
      input: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }
  | {
      type: "mail.send";
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string;
      mailbox?: string;
      result?: unknown;
      error?: string;
    };

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Approval {
  id: string;
  companyId?: string;
  runId: string | null;
  agentId: string;
  agentName?: string;
  origin: "workflow" | "deferred";
  stepId: string;
  title: string;
  details: string;
  action: ApprovalAction;
  assigneeRole: string | null;
  /** Why a person is asked ("Supervised: every change goes to a person"). */
  reason?: string | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface RunDetail {
  run: RunRow;
  events: RunEvent[];
  approvals: Approval[];
  agent: { id: string; slug: string; name: string; outputs: FieldSpec[]; ui: UiSpec } | null;
}

// ---------------------------------------------------------------------------
// Instance, companies, dashboard, activity, files
// ---------------------------------------------------------------------------

export interface Info {
  name: string;
  version: string;
  llm: { available: boolean; provider: string; model: string };
  embeddings: { model: string };
  database: string;
  defaultCompany: string;
  publicUrl: string;
  /** Where OAuth 2.0 providers send people back after signing a connection in. */
  oauthRedirectUrl?: string;
  /** Open mode protected by EB_API_KEY: the console asks for the key. */
  authRequired: boolean;
  auth?: { mode: "accounts" | "open" };
  paperclip: { configured: boolean; url: string | null };
}

// ---------------------------------------------------------------------------
// People and sign-in
// ---------------------------------------------------------------------------

export type MembershipRole = "manager" | "worker";

export interface Viewer {
  kind: "session" | "api-key" | "open";
  id: string | null;
  name: string;
  email: string | null;
  isAdmin: boolean;
  departments: { id: string; key: string; name: string; role: MembershipRole }[];
}

export interface DemoPerson {
  email: string;
  name: string;
  title: string | null;
  isAdmin: boolean;
  departments: { name: string; role: MembershipRole }[];
}

export interface AuthState {
  mode: "accounts" | "open";
  company: { slug: string; name: string } | null;
  /** Nobody has an account yet: the first person to arrive becomes the admin. */
  setupRequired: boolean;
  viewer: Viewer | null;
  providers: { id: string; label: string }[];
  demo: DemoPerson[];
}

export interface Person {
  id: string;
  companyId: string;
  email: string;
  name: string;
  title: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
  departments: { departmentId: string; key: string; name: string; role: MembershipRole }[];
  /** Admins only (hidden from other people). */
  hasPassword?: boolean;
  authProvider?: string | null;
  lastSignInAt?: string | null;
  createdAt: string;
}

interface ProviderSettings {
  configured: boolean;
  /** "environment": set with EB_AUTH_* variables; Settings can override it. */
  source: "settings" | "environment" | null;
  clientId: string;
}

export interface SignInSettings {
  redirectUris: { microsoft: string; google: string };
  microsoft: ProviderSettings & { tenant: string };
  google: ProviderSettings & { hostedDomain: string };
  autoJoinDomains: string[];
  demo: boolean;
}

export interface Company {
  id: string;
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
  createdAt?: string;
}

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Dashboard {
  company: Company;
  counts: {
    agents: number;
    activeAgents: number;
    runs24h: number;
    succeeded24h: number;
    failed24h: number;
    pendingApprovals: number;
    departments: number;
    knowledgeDocuments: number;
    openBuilderSessions: number;
  };
  costMonthUsd: number;
  recentRuns: RunRow[];
  recentActivity: ActivityEntry[];
}

export interface UploadedFile {
  field: string;
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export interface KnowledgeCollection {
  id: string;
  key: string;
  name: string;
  description: string;
  departmentId?: string | null;
  documentCount: number;
  chunkCount: number;
  createdAt?: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  mimeType: string | null;
  createdAt: string;
  collectionId: string;
  fileId?: string | null;
  uri?: string | null;
  error?: string | null;
}

export interface KnowledgeChunk {
  id: string;
  ordinal: number;
  content: string;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  chunks: KnowledgeChunk[];
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  collectionId?: string;
  collectionKey: string;
  title: string;
  content: string;
  score: number;
  vectorRank?: number;
  textRank?: number;
  vectorScore?: number;
  textScore?: number;
  uri?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  tookMs: number;
  embeddingModel: string;
  hits: SearchHit[];
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export interface ConfigField {
  key: string;
  label: string;
  type: "string" | "password" | "url" | "number" | "boolean" | "select" | "textarea";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  /** Shown only when another field has one of these values. */
  showWhen?: { key: string; values: string[] };
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  format?: string;
  [key: string]: unknown;
}

export interface OperationManifest {
  id: string;
  name: string;
  description: string;
  kind: "read" | "write";
  input: JsonSchema;
  output?: JsonSchema;
}

export interface ConnectorManifest {
  type: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  auth: string;
  config: ConfigField[];
  operations: OperationManifest[];
  events?: { id: string; name: string; description: string }[];
  docsUrl?: string;
  maturity: "stable" | "preview" | "sandbox";
  itRequirements: string[];
  /** Kept by the platform (the company's tables): nobody adds or changes it. */
  managed?: boolean;
}

export interface ConnectorInstance {
  id: string;
  type: string;
  name: string;
  category: string;
  config: Record<string, unknown>;
  secretFields: string[];
  status: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  sandbox: boolean;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface Mailbox {
  mailbox: string;
  total: number;
  unprocessed: number;
  agents: { id: string; slug: string; name: string; status: AgentStatus }[];
}

export interface MailAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface MailMessage {
  id: string;
  mailbox: string;
  direction: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  bodyText: string;
  attachments: MailAttachment[];
  status: string;
  classification: Record<string, unknown> | null;
  runId: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  receivedAt: string;
}

export interface MailMessageDetail {
  message: MailMessage;
  run: RunRow | null;
  approvals: Approval[];
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  agentId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  n: number;
  title: string;
  collection: string;
  documentId: string;
  snippet: string;
}

export interface ChatMessage {
  id: string;
  conversationId?: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Catalog (templates)
// ---------------------------------------------------------------------------

export interface Kpi {
  id: string;
  name: string;
  unit?: string;
  target?: string;
  description?: string;
}

export interface HumanRole {
  id: string;
  title: string;
  description?: string;
}

export interface DepartmentTemplate {
  id: string;
  name: string;
  icon?: string;
  summary: string;
  mission: string;
  kpis: Kpi[];
  roles: HumanRole[];
  systems: { category: string; examples: string[]; purpose?: string }[];
  processes: string[];
  tags: string[];
}

export interface ProcessStep {
  id: string;
  name: string;
  actor: string;
  description?: string;
  approval?: boolean;
  sla?: string;
}

export interface ProcessTemplate {
  id: string;
  department: string;
  name: string;
  summary: string;
  description?: string;
  trigger: { type: string; description: string };
  frequency?: string;
  steps: ProcessStep[];
  agents: string[];
  kpis: Kpi[];
  integrations: { category: string; purpose: string; required: boolean }[];
  useCases: string[];
  value?: { hoursSavedPerMonth?: number; description?: string };
  maturity: "ready" | "beta" | "concept";
}

export interface AgentTemplateSummary {
  id: string;
  slug: string;
  name: string;
  title?: string;
  summary: string;
  department: string;
  process?: string;
  archetype: Archetype;
  capabilities: string[];
  triggers: TriggerSpec[];
  connectors: ConnectorBinding[];
  tags: string[];
  steps: number;
}

export interface AgentTemplate extends AgentDefinition {
  id: string;
  department: string;
  capabilities: string[];
  reportsTo?: string;
  tags: string[];
}

export interface UseCase {
  id: string;
  name: string;
  icon?: string;
  archetype: Archetype;
  summary: string;
  description: string;
  capabilities: string[];
  connectors: string[];
  defaultAgent?: string;
  app?: string;
  examples: string[];
  triggers: TriggerSpec[];
}

export interface CatalogResponse {
  departments: DepartmentTemplate[];
  processes: ProcessTemplate[];
  agents: AgentTemplateSummary[];
  useCases: UseCase[];
}

export interface CatalogSearchResult {
  kind: "agent" | "process" | "use-case" | "department";
  id: string;
  name: string;
  summary: string;
  department?: string;
  archetype?: Archetype;
  score: number;
  matched: string[];
}

export interface ProcessRow {
  id: string;
  departmentId: string | null;
  key: string;
  templateId: string | null;
  name: string;
  summary: string;
  status: string;
  data: Partial<ProcessTemplate>;
  createdAt?: string;
}

export interface InstalledDepartment {
  id: string;
  key: string;
  templateId: string | null;
  name: string;
  summary: string;
  icon: string | null;
  data: Partial<DepartmentTemplate>;
  createdAt?: string;
  /** The viewer works there (or is an admin): its AI employees are listed. */
  visible?: boolean;
  processes: ProcessRow[];
  agents: { id: string; slug: string; name: string; status: AgentStatus; archetype: Archetype; processId: string | null; source: AgentSource }[];
}

// ---------------------------------------------------------------------------
// Agent Builder
// ---------------------------------------------------------------------------

export type RequirementSection = "purpose" | "users" | "inputs" | "processing" | "outputs" | "actions" | "integrations" | "governance" | "ui" | "operations";

export type StakeholderRole = "requester" | "it" | "security" | "legal" | "dpo" | "finance" | "process-owner" | "data-owner" | "management";

export type AnswerType = "single" | "multi" | "text" | "number" | "boolean" | "files" | "fields" | "criteria" | "categories";

export interface RequirementOption {
  value: string;
  label: string;
  description?: string;
}

export interface RequirementNode {
  id: string;
  section: RequirementSection;
  title: string;
  question: string;
  why?: string;
  kind: "decision" | "fact";
  answerType: AnswerType;
  options?: RequirementOption[];
  recommended?: unknown;
  recommendationReason?: string;
  prerequisites: string[];
  /** Applicability condition (see Condition in packages/core/src/builder.ts). */
  when?: unknown;
  owner: StakeholderRole;
  delegable?: boolean;
  specPath?: string;
  priority: number;
  source: "base" | "archetype" | "template" | "dynamic";
}

export type NodeStatus = "open" | "asked" | "answered" | "assumed" | "delegated" | "skipped";

export interface NodeState {
  status: NodeStatus;
  value?: unknown;
  answerText?: string;
  answeredBy?: "requester" | "stakeholder" | "system" | "default";
  evidence?: string;
  round?: number;
  delegationId?: string;
  updatedAt?: string;
}

export interface RequirementTree {
  nodes: RequirementNode[];
  states: Record<string, NodeState>;
}

export interface RoundQuestion {
  number: number;
  nodeId: string;
  title: string;
  question: string;
  why?: string;
  answerType: AnswerType;
  options?: RequirementOption[];
  recommended?: unknown;
  recommendationText?: string;
  owner: StakeholderRole;
  delegable: boolean;
}

export interface BuilderRound {
  number: number;
  questions: RoundQuestion[];
  intro?: string;
  askedAt: string;
  answeredAt?: string;
}

export type BuilderStatus = "interviewing" | "awaiting-stakeholders" | "confirming" | "generating" | "testing" | "deployed" | "archived";

export interface SampleAnalysis {
  fileId: string;
  fileName: string;
  mimeType: string;
  pages?: number;
  language?: string;
  needsOcr?: boolean;
  documentType?: string;
  detectedFields?: string[];
  summary?: string;
}

export interface BuilderSessionSummary {
  id: string;
  title: string;
  status: BuilderStatus;
  archetype: Archetype | null;
  templateId: string | null;
  department: string | null;
  requesterName: string | null;
  requesterRole: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuilderSession extends BuilderSessionSummary {
  description: string;
  language: string;
  requesterEmail: string | null;
  samples: SampleAnalysis[];
  summary?: string | null;
}

export interface BuilderMessage {
  id: string;
  sessionId?: string;
  role: "user" | "analyst" | "system";
  content: string;
  round: number | null;
  attachments?: { fileId: string; name: string }[];
  data: {
    round?: BuilderRound;
    requestId?: string;
    summary?: boolean;
    samples?: SampleAnalysis[];
    agentId?: string;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface StakeholderQuestion {
  nodeId: string;
  question: string;
  why?: string;
  answer?: string;
}

export type RequestStatus = "draft" | "sent" | "answered";

export interface StakeholderRequest {
  id: string;
  sessionId?: string;
  role: StakeholderRole;
  recipientName: string | null;
  recipientEmail: string | null;
  subject: string;
  body: string;
  questionnaire: string;
  questions: StakeholderQuestion[];
  status: RequestStatus;
  token: string;
  sentAt?: string | null;
  answeredAt?: string | null;
  answeredBy?: string | null;
  createdAt?: string;
}

export interface TreeProgress {
  total: number;
  settled: number;
  delegated: number;
  open: number;
  percent: number;
  bySection: Record<string, { total: number; settled: number }>;
}

export interface SessionView {
  session: BuilderSession;
  tree: RequirementTree;
  messages: BuilderMessage[];
  requests: StakeholderRequest[];
  currentRound?: BuilderRound;
  progress: TreeProgress;
  draft?: AgentDefinition;
  /** The job description in plain words, built as the manager answers. */
  job?: JobDescription;
  agent?: { id: string; slug: string; status: string; name: string };
  llm: { available: boolean; provider: string; model: string };
}

export type NeedStatus = "ready" | "to-ask" | "asked" | "answered" | "yours" | "manual" | "open";

export interface JobDescription {
  duties: string[];
  needs: { text: string; status: NeedStatus; who: string }[];
  never: string[];
  level: { value: Probation; label: string; alone: string; person: string };
  samples: number;
  manager: string | null;
}

export interface ReplyAnswer {
  nodeId: string;
  action?: "answer" | "accept" | "delegate" | "skip";
  value?: unknown;
  delegateTo?: StakeholderRole;
}

export interface PublicRequest {
  id: string;
  status: RequestStatus;
  role: StakeholderRole;
  subject: string;
  agentName: string;
  requesterName: string;
  requesterRole: string;
  goal: string;
  questions: StakeholderQuestion[];
  language: string;
}

// ---------------------------------------------------------------------------
// Paperclip
// ---------------------------------------------------------------------------

export interface PaperclipPackage {
  files: Record<string, string>;
  warnings: string[];
  agentSlugs: string[];
  specialists: { paperclipSlug: string; ebSlug: string }[];
  summary: { departments: number; agents: number; routines: number };
}

export interface PaperclipPushResult {
  ok: boolean;
  summary: { departments: number; agents: number; routines: number };
  warnings: string[];
  /** Enterprise Brain agents that got their own Paperclip API key (to close their tasks). */
  agentKeys?: number;
  paperclip: unknown;
}

export interface PaperclipConnection {
  hermes: { apiBaseUrl: string; apiKey: string | null; keySource: "env" | "api-key" | "generated" | null };
  paperclip: { url: string | null; configured: boolean; companyId: string | null; agentsWithKeys: number };
  /** EB_PAPERCLIP_AUTOCONNECT (the Docker bundle): Enterprise Brain connects itself to Paperclip on start. */
  autoConnect: { state: "off" | "waiting" | "connecting" | "connected" | "failed"; message: string; updatedAt: string };
}

// ---------------------------------------------------------------------------
// Tasks, the work queue, Home
// ---------------------------------------------------------------------------

export type TaskStatus = "working" | "waiting" | "needs_person" | "paused" | "done" | "stopped" | "failed";

export interface TaskRow {
  id: string;
  ref: string;
  title: string;
  status: TaskStatus;
  source: string;
  sourceRef: string | null;
  requestedBy: string | null;
  input: Record<string, unknown>;
  waitingFor: { kind?: "reply" | "time"; since?: string; days?: number; note?: string; replyMessageId?: string; pausedFrom?: string } | null;
  nextCheckAt: string | null;
  outcome: string | null;
  wakeups: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  agent?: { id: string; slug: string; name: string; departmentId: string | null } | null;
}

export interface TaskEvent {
  id: string;
  type: string;
  message: string;
  actor: string;
  runId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDetail {
  task: TaskRow;
  agent: { id: string; slug: string; name: string; departmentId: string | null; status: AgentStatus };
  events: TaskEvent[];
  runs: RunRow[];
  mails: { id: string; direction: "inbound" | "outbound"; from: string; to: string[]; subject: string; body: string; receivedAt: string }[];
  approvals: Approval[];
  /** Corrections people made to this task's work, for its AI employee's next version. */
  coaching: { id: string; kind: CoachingNoteKind; note: string; by: string; status: CoachingNoteStatus; appliedVersion: number | null; createdAt: string }[];
  canManage: boolean;
  /** May the viewer mark this (finished) task as wrong? */
  canCorrect: boolean;
}

export type WorkType = "approval" | "question" | "review" | "failure" | "notice";

export interface WorkEntry {
  type: WorkType;
  id: string;
  title: string;
  details: string;
  reason: string | null;
  suggestion: string | null;
  options: string[] | null;
  action: ApprovalAction | null;
  task: { id: string; ref: string; title: string; status: TaskStatus } | null;
  agent: { id: string; slug: string; name: string } | null;
  departmentId: string | null;
  assignee: { id: string; name: string } | null;
  forMe: boolean;
  canHandle: boolean;
  status: string;
  resolvedBy: string | null;
  createdAt: string;
}

export interface HomeData {
  person: { name: string; departments: string[]; isManager: boolean };
  aiEmployees: {
    id: string;
    slug: string;
    name: string;
    title: string | null;
    department: string | null;
    departmentId: string | null;
    status: AgentStatus;
    probation: Probation;
    today: { started: number; done: number; open: number; needsPerson: number; failed: number };
    costTodayUsd: number;
  }[];
  aiMailbox: string | null;
}

export interface CostOverview {
  month: string;
  totalUsd: number;
  departments: {
    id: string;
    key: string;
    name: string;
    aiEmployees: number;
    costThisMonthUsd: number;
    monthlyBudgetUsd: number | null;
    stoppedByBudget: boolean;
  }[];
  aiEmployees: {
    slug: string;
    name: string;
    departmentId: string | null;
    department: string | null;
    manager: string | null;
    status: AgentStatus;
    probation: Probation;
    costThisMonthUsd: number;
    monthlyBudgetUsd: number | null;
    stoppedByBudget: boolean;
    stoppedBy: "own" | "department" | null;
  }[];
  /** The last six months, oldest first: the total and each department's (by id; "company" for company-wide ones). */
  months: { month: string; totalUsd: number; byDepartment: Record<string, number> }[];
}

export interface ActionParam {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "date";
  description?: string;
  required: boolean;
}

export interface NamedAction {
  id: string;
  name: string;
  description: string;
  kind: "read" | "write";
  requiresApproval?: boolean;
  params: ActionParam[];
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
  sql?: string;
  /** MCP servers: the tool the action calls, and its input schema. */
  tool?: string;
  inputSchema?: Record<string, unknown>;
  /** Old systems' screens: what to do there in plain words, with {params}, and the values to bring back. */
  goal?: string;
  returns?: { key: string; type: ActionParam["type"]; description?: string }[];
  watch?: { cursorField: string; idField?: string; start?: string };
}

/** How an action on an old system's screens went: its steps, and the last screen (a stored file). */
export interface ScreenRun {
  steps: number;
  trail: string[];
  lastScreenFileId?: string;
}

export interface WatcherStatus {
  connection: string;
  connectionId: string;
  watching: string;
  agent: string | null;
  lastPolledAt: string | null;
  lastCount: number;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Coaching: corrections become rules in an AI employee's next version, tested on past tasks first
// ---------------------------------------------------------------------------

export type CoachingNoteKind = "task" | "check" | "correction" | "rejection";
export type CoachingNoteStatus = "open" | "applied" | "kept";

export interface CoachingNote {
  id: string;
  kind: CoachingNoteKind;
  note: string;
  by: string;
  status: CoachingNoteStatus;
  taskId: string | null;
  taskRef: string | null;
  taskTitle: string | null;
  proposalId: string | null;
  appliedVersion: number | null;
  createdAt: string;
}

export interface JobChange {
  path: string;
  label: string;
  before?: unknown;
  after?: unknown;
  added?: string[];
  removed?: string[];
}

export interface ReplayItem {
  taskId: string;
  ref: string;
  title: string;
  corrected: boolean;
  notes: string[];
  originalRunId?: string;
  runId?: string;
  status: "pending" | "same" | "changed" | "failed";
  error?: string;
  changes: { key: string; label: string; before: unknown; after: unknown; kind: "outcome" | "wording" }[];
  steps: { stepId: string; name: string; kind: "person" | "action"; change: "added" | "removed" }[];
}

export interface CoachingProposal {
  id: string;
  agentId: string;
  baseVersion: number;
  currentVersion: number;
  stale: boolean;
  status: "replaying" | "ready" | "published" | "kept" | "failed" | "superseded";
  rules: string[];
  explanation: string;
  changes: JobChange[];
  replay: {
    items: ReplayItem[];
    summary: { total: number; done: number; changed: number; failed: number; corrected: number; correctedChanged: number };
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  notes: CoachingNote[];
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  publishedVersion: number | null;
  canDecide?: boolean;
}

export interface CoachingOverview {
  notes: CoachingNote[];
  proposals: CoachingProposal[];
  llm: { available: boolean };
  canDecide: boolean;
}

// ---------------------------------------------------------------------------
// Performance reports
// ---------------------------------------------------------------------------

export type ReportPeriodKey = "last-4-weeks" | "this-week" | "last-week" | "this-month" | "last-month";

export interface PerformanceMeasures {
  started: number;
  finished: number;
  failed: number;
  finishedAlone: number;
  aloneShare: number | null;
  corrected: number;
  correctedShare: number | null;
  handled: number;
  medianHandlingHours: number | null;
  costUsd: number;
  costPerTaskUsd: number | null;
}

export interface AfterProbation {
  aiEmployees: number;
  finished: number;
  finishedAlone: number;
  aloneShare: number | null;
}

export interface PerformanceTargets {
  aloneShare: number;
  medianHandlingHours: number;
  correctedShare: number;
  readyMadeHours: number;
  studioHours: number;
}

export interface WorkingHours {
  days: number[];
  start: string;
  end: string;
  timeZone: string;
}

export interface ReportPeriod {
  key: ReportPeriodKey;
  label: string;
  from: string;
  to: string;
}

export interface HiringRow {
  id: string;
  slug: string;
  name: string;
  departmentId: string | null;
  source: "ready-made" | "studio" | "other";
  startedAt: string;
  atWorkAt: string | null;
  hours: number | null;
  targetHours: number | null;
  met: boolean | null;
}

export interface PerformanceReport {
  period: ReportPeriod;
  workingHours: WorkingHours;
  targets: PerformanceTargets;
  total: { measures: PerformanceMeasures; afterProbation: AfterProbation };
  departments: { id: string | null; key: string | null; name: string; aiEmployees: number; measures: PerformanceMeasures; afterProbation: AfterProbation }[];
  aiEmployees: {
    id: string;
    slug: string;
    name: string;
    departmentId: string | null;
    status: AgentStatus;
    probation: Probation;
    measures: PerformanceMeasures;
  }[];
  weeks: { start: string; measures: PerformanceMeasures; afterProbation: AfterProbation }[];
  hiring: HiringRow[];
}

export interface AgentPerformance {
  period: ReportPeriod;
  workingHours: WorkingHours;
  targets: PerformanceTargets;
  probation: Probation;
  measures: PerformanceMeasures;
  weeks: { start: string; measures: PerformanceMeasures }[];
}

// ---------------------------------------------------------------------------
// Tables: business data people describe in plain words
// ---------------------------------------------------------------------------

export type TableFieldType = "text" | "long_text" | "number" | "money" | "date" | "yes_no" | "choice" | "person" | "email" | "url" | "file" | "link";

export interface TableField {
  key: string;
  label: string;
  type: TableFieldType;
  description?: string;
  required?: boolean;
  /** choice: the values people pick from. */
  choices?: string[];
  /** money: its currency (TRY). */
  currency?: string;
  /** link: the key of the table its records point at. */
  table?: string;
  /** Personal data (KVKK/GDPR). */
  personal?: boolean;
  /** The value a new record starts with. */
  default?: string | number | boolean;
}

export interface TableSettings {
  visibility: "department" | "company";
  editors: "members" | "managers";
}

export interface TableDesign {
  key: string;
  name: string;
  description: string;
  fields: TableField[];
  titleField?: string;
}

export interface TableView {
  id: string;
  key: string;
  name: string;
  description: string;
  departmentId: string | null;
  fields: TableField[];
  titleField: string;
  settings: TableSettings;
  version: number;
  records: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** What the viewer may do: add and change records, change the table. */
  can: { edit: boolean; design: boolean };
}

export interface RecordView {
  id: string;
  number: number;
  title: string;
  values: Record<string, unknown>;
  /** How links and people read: "#3 Akın Metal", "Zeynep Kaya". */
  display: Record<string, string>;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface RecordChange {
  id: string;
  action: "created" | "updated" | "archived" | "restored" | "imported";
  changes: { key: string; label: string; from: unknown; to: unknown }[];
  by: string;
  ai: boolean;
  runId: string | null;
  createdAt: string;
}

export interface RecordPage {
  table: TableView;
  records: RecordView[];
  total: number;
}

export interface TableProposal {
  design: TableDesign;
  notes: string[];
  drafted: "model" | "words";
}

export interface TableImport {
  columns: Record<string, string>;
  ignored: string[];
  ready: number;
  added: number;
  problems: { row: number; problems: string[] }[];
  fileId: string;
  fileName: string;
  sheet: string;
  rows: number;
}
