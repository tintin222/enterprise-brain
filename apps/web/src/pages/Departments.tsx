import { Building, ExternalLink, LibraryBig, Workflow } from "lucide-react";
import { Link } from "react-router";
import { Badge, StatusPill } from "../components/Badge.tsx";
import { ButtonLink } from "../components/Button.tsx";
import { Card, PageHeader } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { archetypeIcon, namedIcon } from "../lib/icons.tsx";
import { useDepartments } from "../lib/queries.ts";
import type { InstalledDepartment } from "../types.ts";

function AgentChip({ agent }: { agent: InstalledDepartment["agents"][number] }) {
  const Icon = archetypeIcon(agent.archetype);
  return (
    <Link
      to={`/agents/${agent.slug}`}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] hover:border-brand-300 dark:hover:border-brand-400/40"
    >
      <Icon className="size-3.5 shrink-0 text-brand-600 dark:text-brand-300" />
      <span className="truncate font-medium text-fg">{agent.name}</span>
      <StatusPill status={agent.status} size="xs" />
    </Link>
  );
}

export default function Departments() {
  const { data, isLoading, error, refetch } = useDepartments();
  return (
    <Page>
      <PageHeader
        icon={Building}
        title="Departments"
        description="Your installed operating model: departments, their processes and the agents working in each."
        actions={
          <ButtonLink to="/catalog" icon={LibraryBig}>
            Add from catalog
          </ButtonLink>
        }
      />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {isLoading && (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={Building}
          title="No departments installed yet"
          description="Install a department template to get its processes, human roles, systems and a team of predefined agents in one step."
          action={
            <ButtonLink to="/catalog" variant="primary" icon={LibraryBig}>
              Browse department templates
            </ButtonLink>
          }
        />
      )}
      <div className="space-y-6">
        {data?.map((d) => {
          const Icon = namedIcon(d.icon ?? d.data.icon);
          const unassigned = d.agents.filter((a) => !a.processId || !d.processes.some((p) => p.id === a.processId));
          const active = d.agents.filter((a) => a.status === "active").length;
          return (
            <Card key={d.id} className="overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-fg">{d.name}</h2>
                    <p className="truncate text-[13px] text-muted">{d.summary}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge>{d.processes.length} processes</Badge>
                  <Badge tone={active ? "green" : "neutral"}>
                    {active}/{d.agents.length} agents active
                  </Badge>
                  {d.templateId && (
                    <ButtonLink to={`/catalog/departments/${d.templateId}`} size="xs" variant="ghost" iconRight={ExternalLink}>
                      Template
                    </ButtonLink>
                  )}
                </div>
              </div>
              <div className="divide-y divide-line">
                {d.processes.map((p) => {
                  const agents = d.agents.filter((a) => a.processId === p.id);
                  return (
                    <div key={p.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium text-fg">
                          <Workflow className="size-4 shrink-0 text-muted" /> {p.name}
                          {p.status !== "active" && <StatusPill status={p.status} size="xs" />}
                        </p>
                        <p className="mt-0.5 line-clamp-2 pl-6 text-xs text-muted">{p.summary}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {agents.length ? agents.map((a) => <AgentChip key={a.id} agent={a} />) : <span className="text-xs text-faint">No agents in this process yet.</span>}
                      </div>
                    </div>
                  );
                })}
                {unassigned.length > 0 && (
                  <div className="px-5 py-4">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Other agents</p>
                    <div className="flex flex-wrap gap-2">
                      {unassigned.map((a) => (
                        <AgentChip key={a.id} agent={a} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
