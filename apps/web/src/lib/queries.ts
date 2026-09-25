import { useQuery } from "@tanstack/react-query";
import { api, qs } from "../api.ts";
import type {
  AgentDetail,
  AgentRow,
  Approval,
  BuilderSessionSummary,
  CatalogResponse,
  ConnectorInstance,
  ConnectorManifest,
  InstalledDepartment,
  KnowledgeCollection,
  Mailbox,
  Person,
  RunRow,
  SessionView,
  StoredFile,
} from "../types.ts";
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
  chat: (company: string) => [company, "chat"] as const,
  files: (company: string) => [company, "files"] as const,
  activity: (company: string) => [company, "activity"] as const,
  people: (company: string) => [company, "people"] as const,
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

export function useApprovals(status?: string, poll = 20_000) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...keys.approvals(company), { status }],
    queryFn: () => api.get<Approval[]>(path(`/approvals${qs({ status })}`)),
    refetchInterval: poll,
  });
}

export function useBuilderSessions() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: [...keys.builder(company), "list"], queryFn: () => api.get<BuilderSessionSummary[]>(path("/builder/sessions")) });
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
    queryKey: [...keys.files(company), "list"],
    queryFn: () => api.get<StoredFile[]>(path("/files")),
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
