import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, Boxes, Check, Download, ExternalLink, LibraryBig, Search, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { humanize } from "../../lib/format.ts";
import { archetypeIcon, namedIcon } from "../../lib/icons.tsx";
import { ARCHETYPE_LABELS, archetypeLabel, categoryLabel, triggerShort } from "../../lib/labels.ts";
import { keys, useAgents, useCatalog, useDepartments } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AgentRow, CatalogResponse, UseCase } from "../../types.ts";
import { TemplateDrawer } from "./TemplateDrawer.tsx";

type Tab = "departments" | "agents" | "usecases";

function Departments({ catalog }: { catalog: CatalogResponse }) {
  const installed = useDepartments();
  const installedKeys = new Set((installed.data ?? []).map((d) => d.key));
  if (!catalog.departments.length) return <EmptyState icon={Boxes} title="No department templates" description="The catalog directory has no departments yet." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {catalog.departments.map((d) => {
        const Icon = namedIcon(d.icon);
        const agents = catalog.agents.filter((a) => a.department === d.id);
        const processes = catalog.processes.filter((p) => p.department === d.id);
        const hours = processes.reduce((n, p) => n + (p.value?.hoursSavedPerMonth ?? 0), 0);
        return (
          <Link
            key={d.id}
            to={`/catalog/departments/${d.id}`}
            className="group flex flex-col rounded-xl border border-line bg-surface p-5 shadow-xs transition-colors hover:border-brand-300 dark:hover:border-brand-400/40"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                <Icon className="size-5" />
              </span>
              {installedKeys.has(d.id) && (
                <Badge tone="green" icon={Check}>
                  Installed
                </Badge>
              )}
            </div>
            <h3 className="mt-4 text-base font-semibold text-fg">{d.name}</h3>
            <p className="mt-1 line-clamp-3 flex-1 text-sm text-muted">{d.summary}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Workflow className="size-3.5" /> {processes.length || d.processes.length} processes
              </span>
              <span className="flex items-center gap-1">
                <Bot className="size-3.5" /> {agents.length} agents
              </span>
              {hours > 0 && <span className="text-emerald-700 dark:text-emerald-300">~{hours} h/month saved</span>}
              <ArrowRight className="ml-auto size-4 text-faint transition-transform group-hover:translate-x-0.5" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function AgentTemplates({ catalog, installed, onOpen }: { catalog: CatalogResponse; installed: AgentRow[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [archetype, setArchetype] = useState("");
  const installedIds = new Set(installed.filter((a) => a.status !== "archived").map((a) => a.templateId));
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.agents.filter(
      (a) =>
        (!department || a.department === department) &&
        (!archetype || a.archetype === archetype) &&
        (!q || `${a.name} ${a.summary} ${a.title ?? ""} ${a.tags.join(" ")}`.toLowerCase().includes(q)),
    );
  }, [catalog.agents, query, department, archetype]);
  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input className="input pl-9" placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search templates" />
        </div>
        <select className="input w-auto" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {catalog.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={archetype} onChange={(e) => setArchetype(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(ARCHETYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {list.length === 0 && <p className="py-10 text-center text-sm text-muted">No templates match.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((a) => {
          const Icon = archetypeIcon(a.archetype);
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpen(a.id)}
              className="flex flex-col rounded-xl border border-line bg-surface p-4 text-left shadow-xs transition-colors hover:border-brand-300 dark:hover:border-brand-400/40"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-fg">{a.name}</span>
                    {installedIds.has(a.id) && (
                      <Badge size="xs" tone="green">
                        installed
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">{a.title ?? archetypeLabel(a.archetype)}</p>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 flex-1 text-[13px] text-muted">{a.summary}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge size="xs">{catalog.departments.find((d) => d.id === a.department)?.name ?? humanize(a.department)}</Badge>
                {a.triggers.slice(0, 2).map((t, i) => (
                  <Badge key={i} size="xs" tone="neutral">
                    {triggerShort(t)}
                  </Badge>
                ))}
                {a.connectors.slice(0, 3).map((c) => (
                  <Badge key={c.ref} size="xs" tone="violet">
                    {categoryLabel(c.category)}
                  </Badge>
                ))}
                <Badge size="xs" tone="brand">
                  {a.steps} steps
                </Badge>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UseCases({ catalog, installed }: { catalog: CatalogResponse; installed: AgentRow[] }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const install = useMutation({
    mutationFn: (u: UseCase) => api.post<{ agent: AgentRow | null }>(path(`/catalog/use-cases/${encodeURIComponent(u.id)}/install`)),
    onSuccess: (res, u) => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success(res.agent ? `${u.name}: ${res.agent.name} installed` : `${u.name} installed`, u.app ? { link: { to: u.app, label: "Open" } } : undefined);
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {catalog.useCases.map((u) => {
        const Icon = namedIcon(u.icon);
        const ready = u.defaultAgent ? installed.some((a) => a.templateId === u.defaultAgent && a.status !== "archived") : false;
        return (
          <Card key={u.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <span className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
                <Icon className="size-5" />
              </span>
              {ready && (
                <Badge tone="green" icon={Check}>
                  Ready
                </Badge>
              )}
            </div>
            <h3 className="mt-4 text-base font-semibold text-fg">{u.name}</h3>
            <p className="mt-1 text-sm text-muted">{u.summary}</p>
            {u.examples.length > 0 && (
              <ul className="mt-4 flex-1 space-y-1.5">
                {u.examples.slice(0, 3).map((ex) => (
                  <li key={ex} className="rounded-lg bg-subtle/70 px-2.5 py-1.5 text-xs text-muted">
                    “{ex}”
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              {u.app && (
                <ButtonLink to={u.app} size="sm" variant={ready ? "primary" : "secondary"} icon={ExternalLink}>
                  Open
                </ButtonLink>
              )}
              {!ready && u.defaultAgent && (
                <Button size="sm" variant="soft" icon={Download} loading={install.isPending && install.variables?.id === u.id} onClick={() => install.mutate(u)}>
                  Install
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export default function Catalog() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "departments";
  const template = params.get("template");
  const catalog = useCatalog();
  const agents = useAgents();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <PageHeader
        icon={LibraryBig}
        title="Catalog"
        description="Ready-made operating models: departments with their processes, human roles and systems, predefined agents and the default use cases. Install as-is or customise with the Agent Builder."
      />
      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={(t) => update({ tab: t === "departments" ? null : t })}
        tabs={[
          { id: "departments", label: "Departments", count: catalog.data?.departments.length },
          { id: "agents", label: "Agent templates", count: catalog.data?.agents.length },
          { id: "usecases", label: "Use cases", count: catalog.data?.useCases.length },
        ]}
      />
      {catalog.error && <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />}
      {catalog.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      )}
      {catalog.data && tab === "departments" && <Departments catalog={catalog.data} />}
      {catalog.data && tab === "agents" && <AgentTemplates catalog={catalog.data} installed={agents.data ?? []} onOpen={(id) => update({ template: id })} />}
      {catalog.data && tab === "usecases" && <UseCases catalog={catalog.data} installed={agents.data ?? []} />}
      <TemplateDrawer id={template} onClose={() => update({ template: null })} />
    </Page>
  );
}
