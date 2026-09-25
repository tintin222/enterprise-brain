import { CircleCheck, History, ListChecks, UserCheck } from "lucide-react";
import { useSearchParams } from "react-router";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock, Skeleton } from "../../components/Spinner.tsx";
import { Segmented, Tabs } from "../../components/Tabs.tsx";
import { TaskTable } from "../../components/TaskList.tsx";
import { WorkItemCard } from "../../components/WorkItemCard.tsx";
import { useAgents, useDepartments, useTasks, useWork } from "../../lib/queries.ts";
import type { WorkEntry } from "../../types.ts";

type View = "queue" | "tasks" | "handled";
type Scope = "mine" | "all";

const STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: "needs_person", label: "Needs a person" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Stopped with a problem" },
  { value: "stopped", label: "Stopped" },
  { value: "all", label: "All" },
];

function Queue({
  entries,
  loading,
  error,
  retry,
  scope,
  handled,
}: {
  entries: WorkEntry[];
  loading: boolean;
  error: unknown;
  retry: () => void;
  scope: Scope;
  handled?: boolean;
}) {
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }
  if (!entries.length) {
    return handled ? (
      <EmptyState icon={History} title="Nothing handled yet" description="Approvals, answers and checks people gave appear here." />
    ) : (
      <EmptyState
        icon={CircleCheck}
        title={scope === "mine" ? "Nothing needs you" : "Nothing needs a person"}
        description="When an AI employee needs an approval, an answer or a check, it appears here, and on Home."
      />
    );
  }
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <WorkItemCard key={`${entry.type}-${entry.id}`} entry={entry} />
      ))}
    </div>
  );
}

export default function Work() {
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View | null) ?? "queue";
  const scope = (params.get("scope") as Scope | null) ?? "mine";
  const status = params.get("status") ?? "open";
  const agent = params.get("agent") ?? "";
  const department = params.get("department") ?? "";
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const queue = useWork(scope, "open");
  const mine = useWork("mine", "open");
  const handled = useWork(scope, "closed");
  const tasks = useTasks({ status: status === "all" ? undefined : status, agent: agent || undefined, limit: 300 });
  const agents = useAgents();
  const departments = useDepartments();
  const visibleDepartments = (departments.data ?? []).filter((d) => d.visible !== false);
  const taskRows = (tasks.data ?? []).filter((t) => !department || t.agent?.departmentId === department);

  return (
    <Page>
      <PageHeader icon={ListChecks} title="Work" description="Everything your AI employees are doing, and everything that needs a person." />
      <Tabs<View>
        className="mb-5"
        value={view}
        onChange={(v) => update({ view: v === "queue" ? null : v })}
        tabs={[
          { id: "queue", label: "Needs a person", icon: UserCheck, count: mine.data?.length || undefined, alert: Boolean(mine.data?.length) },
          { id: "tasks", label: "Tasks", icon: ListChecks },
          { id: "handled", label: "Handled", icon: History },
        ]}
      />

      {(view === "queue" || view === "handled") && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented<Scope>
              value={scope}
              onChange={(s) => update({ scope: s === "mine" ? null : s })}
              options={[
                { value: "mine", label: "For me" },
                { value: "all", label: "Everyone's I can see" },
              ]}
            />
          </div>
          {view === "queue" ? (
            <Queue entries={queue.data ?? []} loading={queue.isLoading} error={queue.error} retry={() => void queue.refetch()} scope={scope} />
          ) : (
            <Queue entries={handled.data ?? []} loading={handled.isLoading} error={handled.error} retry={() => void handled.refetch()} scope={scope} handled />
          )}
        </>
      )}

      {view === "tasks" && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:max-w-4xl">
            <select
              className="input"
              value={status}
              onChange={(e) => update({ status: e.target.value === "open" ? null : e.target.value })}
              aria-label="Status"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <select className="input" value={department} onChange={(e) => update({ department: e.target.value })} aria-label="Department">
              <option value="">All departments</option>
              {visibleDepartments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select className="input" value={agent} onChange={(e) => update({ agent: e.target.value })} aria-label="AI employee">
              <option value="">All AI employees</option>
              {(agents.data ?? [])
                .filter((a) => !department || a.departmentId === department)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <option key={a.id} value={a.slug}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
          <Card className="overflow-hidden">
            {tasks.error ? (
              <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} className="m-4" />
            ) : tasks.isLoading ? (
              <LoadingBlock />
            ) : (
              <TaskTable
                tasks={taskRows}
                empty={
                  <EmptyState
                    compact
                    className="m-4"
                    icon={ListChecks}
                    title="No tasks here"
                    description={
                      status === "open" ? "Nothing is in progress. Give an AI employee work, or wait for its duties to start some." : "Try another filter."
                    }
                  />
                }
              />
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
