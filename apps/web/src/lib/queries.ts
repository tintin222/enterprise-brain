import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "../api.ts";
import type {
  AgentDetail,
  AgentRow,
  Approval,
  BuilderSessionSummary,
  CatalogResponse,
  ConnectorInstance,
  ConnectorManifest,
  ConversationKind,
  ConversationSummary,
  ConversationView,
  AgentPerformance,
  CostOverview,
  HomeData,
  InstalledDepartment,
  KnowledgeCollection,
  Mailbox,
  PerformanceReport,
  Person,
  DevPackagePreview,
  MyMail,
  ProjectAsset,
  ProjectDesigns,
  ProjectStatus,
  ProjectSummary,
  ProjectView,
  Todo,
  TodoStatus,
  AppDetail,
  AppView,
  CalculationDetail,
  CalculationView,
  RecordPage,
  RecurringWork,
  BuildingState,
  Review,
  TableSummary,
  TableView,
  ReportPeriodKey,
  RunInsights,
  RunRow,
  RunsPage,
  SessionView,
  StoredFile,
  StudioThreadSummary,
  StudioThreadView,
  TaskDetail,
  TaskRow,
  WorkEntry,
} from "../types.ts";
import { useViewer } from "./auth.tsx";
import { useCompany } from "./company.tsx";

/** Query keys: company-scoped keys start with the company slug so switching companies never mixes data. */
export const keys = {
  catalog: ["catalog"] as const,
  connectorCatalog: ["connector-catalog"] as const,
  agents: (company: string) => [company, "agents"] as const,
  agent: (company: string, slug: string) => [company, "agents", slug] as const,
  runs: (company: string) => [company, "runs"] as const,
  run: (company: string, id: string) => [company, "runs", id] as const,
  approvals: (company: string) => [company, "approvals"] as const,
  builder: (company: string) => [company, "builder"] as const,
  session: (company: string, id: string) => [company, "builder", id] as const,
  dashboard: (company: string) => [company, "dashboard"] as const,
  departments: (company: string) => [company, "departments"] as const,
  knowledge: (company: string) => [company, "knowledge"] as const,
  connectors: (company: string) => [company, "connectors"] as const,
  mail: (company: string) => [company, "mail"] as const,
  conversations: (company: string) => [company, "conversations"] as const,
  files: (company: string) => [company, "files"] as const,
  activity: (company: string) => [company, "activity"] as const,
  people: (company: string) => [company, "people"] as const,
  tasks: (company: string) => [company, "tasks"] as const,
  work: (company: string) => [company, "work"] as const,
  home: (company: string) => [company, "home"] as const,
  tables: (company: string) => [company, "tables"] as const,
  apps: (company: string) => [company, "apps"] as const,
  calculations: (company: string) => [company, "calculations"] as const,
  table: (company: string, key: string) => [company, "tables", key] as const,
  recurring: (company: string) => [company, "recurring"] as const,
  building: (company: string) => [company, "building"] as const,
  reviews: (company: string) => [company, "reviews"] as const,
  studio: (company: string) => [company, "studio"] as const,
  projects: (company: string) => [company, "projects"] as const,
  project: (company: string, ref: string) => [company, "projects", ref] as const,
  todos: (company: string) => [company, "todos"] as const,
  myMail: ["me", "mail"] as const,
};

export function useCatalog() {
  return useQuery({ queryKey: keys.catalog, queryFn: () => api.get<CatalogResponse>("/api/catalog"), staleTime: 5 * 60_000 });
}

export function useConnectorCatalog() {
  return useQuery({ queryKey: keys.connectorCatalog, queryFn: () => api.get<ConnectorManifest[]>("/api/connectors/catalog"), staleTime: 5 * 60_000 });
}

export function useAgents(status?: string) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.agents(company), { status }],
    queryFn: () => api.get<AgentRow[]>(path(`/agents${qs({ status })}`)),
  });
}

export function useAgent(slug: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: keys.agent(company, slug ?? ""),
    queryFn: () => api.get<AgentDetail>(path(`/agents/${encodeURIComponent(slug ?? "")}`)),
    enabled: Boolean(slug),
  });
}

export function useRuns(params: { agent?: string; status?: string; limit?: number } = {}, options: { poll?: number | false } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.runs(company), params],
    queryFn: () => api.get<RunRow[]>(path(`/runs${qs(params)}`)),
    refetchInterval: (query) => {
      if (options.poll === false) return false;
      const data = query.state.data;
      const live = data?.some((r) => r.status === "running" || r.status === "queued");
      return live ? 2500 : (options.poll ?? false);
    },
  });
}

/** Which runs the Executions list shows. */
export interface RunsQuery {
  agent?: string;
  department?: string;
  status?: string;
  trigger?: string;
  from?: string;
  to?: string;
  test?: "true" | "false";
}

/** Runs as executions, page by page (newest first); refreshed while some run is going. */
export function useRunsPage(params: RunsQuery) {
  const { company, path } = useCompany();
  return useInfiniteQuery({
    queryKey: [...keys.runs(company), "page", params],
    queryFn: ({ pageParam }) => api.get<RunsPage>(path(`/runs/page${qs({ ...params, cursor: pageParam, limit: 50 })}`)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages[0]?.runs.some((r) => r.status === "running" || r.status === "queued") ? 5000 : false),
  });
}

/** What happened over a period, for the Executions list. */
export function useRunInsights(params: Pick<RunsQuery, "agent" | "department" | "from" | "to">) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.runs(company), "insights", params],
    queryFn: () => api.get<RunInsights>(path(`/runs/insights${qs({ ...params })}`)),
  });
}

export function useApprovals(status?: string, poll = 20_000) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.approvals(company), { status }],
    queryFn: () => api.get<Approval[]>(path(`/approvals${qs({ status })}`)),
    refetchInterval: poll,
  });
}

/** Guided interviews (managers and IT: pass `enabled: false` for anyone else). */
export function useBuilderSessions(options: { enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.builder(company), "list"],
    queryFn: () => api.get<BuilderSessionSummary[]>(path("/builder/sessions")),
    enabled: options.enabled ?? true,
  });
}

export function useBuilderSession(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: keys.session(company, id ?? ""),
    queryFn: () => api.get<SessionView>(path(`/builder/sessions/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.session.status;
      if (status === "generating") return 2000;
      if (status === "awaiting-stakeholders") return 10_000;
      return false;
    },
  });
}

/** Conversations with the Studio agent (managers and IT: pass `enabled: false` for anyone else). */
export function useStudioThreads(options: { enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.studio(company), "list"],
    queryFn: () => api.get<StudioThreadSummary[]>(path("/studio/threads")),
    enabled: options.enabled ?? true,
  });
}

/** A Studio conversation, followed closely while the Studio works. */
export function useStudioThread(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.studio(company), id ?? ""],
    queryFn: () => api.get<StudioThreadView>(path(`/studio/threads/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === "working" ? 1200 : false),
  });
}

export function useDepartments() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.departments(company), queryFn: () => api.get<InstalledDepartment[]>(path("/departments")) });
}

export function usePeople() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.people(company), queryFn: () => api.get<Person[]>(path("/people")) });
}

export function useCollections() {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.knowledge(company), "collections"],
    queryFn: () => api.get<KnowledgeCollection[]>(path("/knowledge/collections")),
  });
}

export function useConnectors() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.connectors(company), queryFn: () => api.get<ConnectorInstance[]>(path("/connectors")) });
}

export function useMailboxes() {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.mail(company), "mailboxes"],
    queryFn: () => api.get<Mailbox[]>(path("/mail/mailboxes")),
    refetchInterval: 15_000,
  });
}

/** Bundled demo sample files (metadata.demoSet), grouped by set. */
export function useDemoFiles() {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.files(company), "demo"],
    queryFn: () => api.get<StoredFile[]>(path("/files/demo")),
    staleTime: 60_000,
    select: (files) => {
      const sets = new Map<string, StoredFile[]>();
      for (const file of files) {
        const set = file.metadata?.demoSet;
        if (typeof set !== "string") continue;
        sets.set(set, [...(sets.get(set) ?? []), file]);
      }
      return sets;
    },
  });
}

/** Department id/key → display name from the catalog ("hr" → "Human Resources"). */
export function useDepartmentName(): (id: string | null | undefined) => string {
  const { data } = useCatalog();
  return (id) => {
    if (!id) return "—";
    const name = data?.departments.find((d) => d.id === id)?.name;
    if (name) return name;
    return id.length <= 3 ? id.toUpperCase() : id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  };
}

/** Home: what the viewer's AI employees did today. */
export function useHome() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.home(company), queryFn: () => api.get<HomeData>(path("/home")), refetchInterval: 30_000 });
}

/** The work queue: what needs a person ("mine": the viewer's to do). */
export function useWork(scope: "mine" | "all" = "mine", status: "open" | "closed" = "open") {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.work(company), scope, status],
    queryFn: () => api.get<WorkEntry[]>(path(`/work${qs({ scope, status })}`)),
    refetchInterval: 20_000,
  });
}

export function useTasks(filter: { status?: string; agent?: string; limit?: number } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.tasks(company), "list", filter],
    queryFn: () => api.get<TaskRow[]>(path(`/tasks${qs(filter)}`)),
    refetchInterval: 20_000,
  });
}

export function useTask(ref: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.tasks(company), ref],
    queryFn: () => api.get<TaskDetail>(path(`/tasks/${encodeURIComponent(ref ?? "")}`)),
    enabled: Boolean(ref),
    refetchInterval: (query) => (["working"].includes(query.state.data?.task.status ?? "") ? 3_000 : 20_000),
  });
}

export function useCosts(enabled = true) {
  const { company, path } = useCompany();
  return useQuery({ queryKey: [company, "costs"], queryFn: () => api.get<CostOverview>(path("/costs")), enabled });
}

/** Performance of the AI employees a manager runs (all for admins), optionally one department's. */
export function usePerformance(period: ReportPeriodKey, department?: string) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [company, "reports", "performance", period, department ?? null],
    queryFn: () => api.get<PerformanceReport>(path(`/reports/performance${qs({ period, department })}`)),
  });
}

/** One AI employee's performance and weekly trend. */
export function useAgentPerformance(slug: string, period: ReportPeriodKey = "last-4-weeks") {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.agent(company, slug), "performance", period],
    queryFn: () => api.get<AgentPerformance>(path(`/agents/${encodeURIComponent(slug)}/performance${qs({ period })}`)),
    enabled: Boolean(slug),
  });
}

/** The tables the viewer sees (or the archived ones). */
export function useTables(archived = false) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.tables(company), { archived }],
    queryFn: () => api.get<TableView[]>(path(`/tables${qs({ archived: archived || undefined })}`)),
  });
}

export function useTable(key: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: keys.table(company, key ?? ""),
    queryFn: () => api.get<TableView>(path(`/tables/${encodeURIComponent(key ?? "")}`)),
    enabled: Boolean(key),
  });
}

export interface RecordQuery {
  search?: string;
  sort?: string;
  direction?: "asc" | "desc";
  limit?: number;
  archived?: boolean;
  /** Field values the records must have. */
  filters?: Record<string, string>;
}

/** A table's records: found by words, filtered by field, in an order. */
export function useRecords(key: string | undefined, query: RecordQuery = {}, options: { enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  const { filters = {}, ...rest } = query;
  const params = {
    ...rest,
    archived: rest.archived || undefined,
    ...Object.fromEntries(Object.entries(filters).map(([field, value]) => [`filter.${field}`, value])),
  };
  return useQuery({
    queryKey: [...keys.table(company, key ?? ""), "records", params],
    queryFn: () => api.get<RecordPage>(path(`/tables/${encodeURIComponent(key ?? "")}/records${qs(params)}`)),
    enabled: Boolean(key) && (options.enabled ?? true),
    placeholderData: (previous) => previous,
  });
}

/** The apps the viewer uses (or the archived ones). */
export function useApps(archived = false) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.apps(company), { archived }],
    queryFn: () => api.get<AppView[]>(path(`/apps${qs({ archived: archived || undefined })}`)),
  });
}

/** An app with its tables and the AI employees its buttons ask. */
export function useAppDetail(key: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.apps(company), key ?? ""],
    queryFn: () => api.get<AppDetail>(path(`/apps/${encodeURIComponent(key ?? "")}`)),
    enabled: Boolean(key),
  });
}

/** Records counted (or a number added up or averaged) by a field, for a chart or a number. */
export function useSummary(
  key: string | undefined,
  query: { groupBy?: string; of?: "count" | "sum" | "average"; field?: string; limit?: number; filters?: Record<string, string> },
) {
  const { company, path } = useCompany();
  const { filters = {}, ...rest } = query;
  const params = { ...rest, ...Object.fromEntries(Object.entries(filters).map(([field, value]) => [`filter.${field}`, value])) };
  return useQuery({
    queryKey: [...keys.table(company, key ?? ""), "summary", params],
    queryFn: () => api.get<TableSummary>(path(`/tables/${encodeURIComponent(key ?? "")}/summary${qs(params)}`)),
    enabled: Boolean(key),
  });
}

/** The calculations the viewer sees (or the archived ones), each with its latest run. */
export function useCalculations(archived = false) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.calculations(company), { archived }],
    queryFn: () => api.get<CalculationView[]>(path(`/calculations${qs({ archived: archived || undefined })}`)),
  });
}

/** A calculation with its recent runs. */
export function useCalculation(key: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.calculations(company), key ?? ""],
    queryFn: () => api.get<CalculationDetail>(path(`/calculations/${encodeURIComponent(key ?? "")}`)),
    enabled: Boolean(key),
  });
}

/** The viewer's own recurring work (what they asked AI employees to do regularly). */
export function useRecurring() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.recurring(company), queryFn: () => api.get<RecurringWork[]>(path("/recurring")) });
}

/** The rules for building as they apply to the viewer: where they build, what they decide. */
export function useBuilding() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.building(company), queryFn: () => api.get<BuildingState>(path("/building")), staleTime: 60_000 });
}

/** Requests waiting for a decision that the viewer makes or asked for. */
export function useReviews() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: keys.reviews(company), queryFn: () => api.get<Review[]>(path("/reviews")) });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationScope = "mine" | "department" | "all";

/** The messages of a conversation, as the page keeps them. */
export const messagesKey = (company: string, id: string) => [...keys.conversations(company), id, "messages"] as const;

/**
 * The viewer's conversations (`mine`: the sidebar), their departments' and the company's open ones
 * (`department`: channels to browse), or every one they may see (`all`), newest first; `kinds` narrows them.
 */
export function useConversations(options: { scope?: ConversationScope; kinds?: ConversationKind[]; unread?: boolean; limit?: number; enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  const { enabled = true, ...rest } = options;
  const kinds = rest.kinds?.join(",");
  return useQuery({
    queryKey: [...keys.conversations(company), "list", { ...rest, kinds }],
    queryFn: () =>
      api.get<ConversationSummary[]>(path(`/conversations${qs({ scope: rest.scope, kinds, unread: rest.unread ? 1 : undefined, limit: rest.limit })}`)),
    refetchInterval: 20_000,
    enabled,
  });
}

export function useConversation(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.conversations(company), id],
    queryFn: () => api.get<ConversationView>(path(`/conversations/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
  });
}

/** What `/chat/for/:kind/:about` resolves: the conversation about a task, a thing, an AI employee (my talk), a person (our direct message) or a message (its thread). */
export const FOR_KINDS = ["task", "thing", "ai_employee", "dm", "thread"] as const;
export type ForKind = (typeof FOR_KINDS)[number];

/** The conversation about something, made on first use (see `FOR_KINDS`). */
export function useConversationFor(kind: ForKind | undefined, about: string | undefined) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [...keys.conversations(company), "for", kind, about],
    queryFn: async () => {
      const view = await api.get<ConversationView>(path(`/conversations/for/${kind}/${encodeURIComponent(about ?? "")}`));
      queryClient.setQueryData([...keys.conversations(company), view.conversation.id], view);
      return view;
    },
    enabled: Boolean(kind && about),
    staleTime: 60_000,
  });
}

/** What is new for the viewer in Chat: where they are named, and unread direct messages, talks and threads (channels wait quietly). */
export function useChatBadge(): number {
  const { data } = useConversations({ scope: "mine", unread: true, limit: 200 });
  return (data ?? []).filter((c) => c.mentionsMe > 0 || ["dm", "ai_employee", "thread"].includes(c.conversation.kind)).length;
}

// ---------------------------------------------------------------------------
// Projects and to-dos

/** The projects; `holding` ("thing:<id>") keeps those with that asset. */
export function useProjects(options: { status?: ProjectStatus | "open" | "all"; holding?: string; enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.projects(company), "list", { status: options.status ?? "all", holding: options.holding ?? null }],
    queryFn: () => api.get<ProjectSummary[]>(path(`/projects${qs({ status: options.status, holding: options.holding })}`)),
    enabled: options.enabled ?? true,
  });
}

export function useProject(ref: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: keys.project(company, ref ?? ""),
    queryFn: () => api.get<ProjectView>(path(`/projects/${encodeURIComponent(ref ?? "")}`)),
    enabled: Boolean(ref),
  });
}

export function useProjectAssets(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.project(company, id ?? ""), "assets"],
    queryFn: () => api.get<{ assets: ProjectAsset[]; hidden: number }>(path(`/projects/${encodeURIComponent(id ?? "")}/assets`)),
    enabled: Boolean(id),
  });
}

export function useProjectDesigns(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.project(company, id ?? ""), "designs"],
    queryFn: () => api.get<ProjectDesigns>(path(`/projects/${encodeURIComponent(id ?? "")}/designs`)),
    enabled: Boolean(id),
  });
}

/** What a project's development package would hold now (built on each read; nothing is kept). */
export function useProjectPackage(id: string | undefined, options: { enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.project(company, id ?? ""), "package"],
    queryFn: () => api.get<DevPackagePreview>(path(`/projects/${encodeURIComponent(id ?? "")}/package`)),
    enabled: Boolean(id) && (options.enabled ?? true),
    staleTime: 30_000,
  });
}

/** The signed-in person's to-dos (nobody's in open mode or for a machine: the query stays off). */
export function useTodos(status: TodoStatus | "all" = "open", options: { projectId?: string; enabled?: boolean } = {}) {
  const { company, path } = useCompany();
  const viewer = useViewer();
  return useQuery({
    queryKey: [...keys.todos(company), { status, project: options.projectId ?? null }],
    queryFn: () => api.get<Todo[]>(path(`/todos${qs({ status, project: options.projectId })}`)),
    enabled: (options.enabled ?? true) && viewer?.kind === "session",
    refetchInterval: 60_000,
  });
}

/** How many to-dos wait for the person (the Work badge). */
export function useTodoCount(): number {
  const { data } = useTodos("open");
  return data?.length ?? 0;
}

/** The signed-in person's own mailbox, for their to-dos (off for machines and open mode). */
export function useMyMail(options: { enabled?: boolean } = {}) {
  const viewer = useViewer();
  return useQuery({
    queryKey: keys.myMail,
    queryFn: () => api.get<MyMail>("/api/me/mail"),
    enabled: (options.enabled ?? true) && viewer?.kind === "session",
    staleTime: 30_000,
  });
}
