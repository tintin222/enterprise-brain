import { CirclePlay } from "lucide-react";
import { useSearchParams } from "react-router";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { RunsTable } from "../../components/RunViews.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { useAgents, useRuns } from "../../lib/queries.ts";

const STATUSES = [
  { value: "", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting_approval", label: "Waiting approval" },
  { value: "waiting", label: "Waiting for a reply or a date" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

export default function RunsList() {
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const status = params.get("status") ?? "";
  const agents = useAgents();
  const runs = useRuns({ agent: agent || undefined, status: status || undefined, limit: 100 }, { poll: 15_000 });

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <PageHeader
        icon={CirclePlay}
        title="Runs"
        description="Every execution of every agent — by a person, an email, a schedule or Paperclip — with its full trail, output and cost."
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
          <select className="input h-9 w-full py-1.5 sm:w-64" value={agent} onChange={(e) => update("agent", e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {(agents.data ?? []).map((a) => (
              <option key={a.id} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
          <Segmented value={status} onChange={(v) => update("status", v)} options={STATUSES} className="overflow-x-auto" />
        </div>
        {runs.error && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} className="m-4" />}
        {runs.isLoading && (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        )}
        {runs.data && (
          <RunsTable
            runs={runs.data}
            empty={
              <EmptyState
                className="m-4"
                icon={CirclePlay}
                title={agent || status ? "No runs match these filters" : "No runs yet"}
                description="Runs appear when someone uses an agent's app, an email reaches a mailbox an agent listens to, or a schedule fires."
              />
            }
          />
        )}
      </Card>
    </Page>
  );
}
