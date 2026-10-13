import { Activity, CircleCheck, CircleX, Clock, Coins, Hourglass, Timer, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatDuration, formatMoney, formatNumber } from "../lib/format.ts";
import { RUN_TRIGGER_LABELS } from "../lib/labels.ts";
import { useAgents, useDepartments, useRunInsights, useRunsPage, type RunsQuery } from "../lib/queries.ts";
import type { RunInsights } from "../types.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { StackedBars } from "./Charts.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { RunsTable } from "./RunViews.tsx";
import { ErrorState, LoadingBlock, Skeleton } from "./Spinner.tsx";

const STATUSES = [
  { value: "", label: "Every status" },
  { value: "succeeded", label: "Finished" },
  { value: "failed", label: "Failed" },
  { value: "waiting_approval", label: "Waiting for a person" },
  { value: "waiting", label: "Waiting (a reply, a date, a call)" },
  { value: "open", label: "Not finished yet" },
  { value: "cancelled", label: "Cancelled" },
];

const KINDS = [
  { value: "false", label: "Real work" },
  { value: "true", label: "Test runs" },
  { value: "", label: "Real work and tests" },
];

export const PERIODS = [
  { value: "1", label: "Today and yesterday", days: 2 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
];

/** What the Executions list shows: set from the page's address. */
export interface ExecutionFilters {
  status: string;
  agent: string;
  department: string;
  trigger: string;
  test: string;
  days: string;
}

function Figure({ icon: Icon, title, value, detail }: { icon: LucideIcon; title: string; value: string; detail?: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon className="size-3.5 shrink-0" /> <span className="truncate">{title}</span>
      </p>
      <p className="mt-1 text-xl font-semibold text-fg tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
    </Card>
  );
}

function hoursText(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

/** The period in numbers: runs and how they ended, how long they took, what they cost, what they saved. */
function InsightStrip({ insights, days }: { insights: RunInsights; days: number }) {
  const finishedShare = insights.runs ? Math.round((insights.succeeded / insights.runs) * 100) : null;
  const bars = insights.perDay.map((d) => ({
    label: new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }),
    parts: [
      { value: d.succeeded, tone: "green" as const, label: "finished" },
      { value: d.failed, tone: "red" as const, label: "failed" },
      { value: d.other, tone: "amber" as const, label: "waiting or going" },
    ],
  }));
  return (
    <div className="mb-5 space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Figure
          icon={Activity}
          title="Runs"
          value={formatNumber(insights.runs)}
          detail={insights.testRuns ? `and ${insights.testRuns} test runs` : "real work"}
        />
        <Figure
          icon={CircleCheck}
          title="Finished"
          value={finishedShare === null ? "—" : `${finishedShare}%`}
          detail={`${insights.succeeded} finished · ${insights.tasksFinished} task${insights.tasksFinished === 1 ? "" : "s"} done, ${insights.finishedAlone} with no person`}
        />
        <Figure
          icon={CircleX}
          title="Failed"
          value={formatNumber(insights.failed)}
          detail={insights.failed ? "Open one to see the step that failed" : "None"}
        />
        <Figure
          icon={Hourglass}
          title="Waiting"
          value={formatNumber(insights.needsPerson + insights.waiting)}
          detail={`${insights.needsPerson} for a person, ${insights.waiting} for a reply, a date or a call`}
        />
        <Figure icon={Timer} title="Typical time" value={formatDuration(insights.medianDurationMs)} detail="Median of the finished runs" />
        {insights.minutesSaved !== null ? (
          <Figure
            icon={Clock}
            title="Time saved"
            value={hoursText(insights.minutesSaved)}
            detail={`${formatMoney(insights.costUsd)} spent · managers' estimate per task`}
          />
        ) : (
          <Figure icon={Coins} title="Cost" value={formatMoney(insights.costUsd)} detail="Model use, test runs included" />
        )}
      </div>
      <Card className="px-4 py-3">
        <p className="mb-2 text-xs font-medium text-muted">Runs a day</p>
        <StackedBars bars={bars} height={96} labels={days > 14 ? "ends" : "auto"} empty="No runs in this period" />
      </Card>
    </div>
  );
}

/**
 * Every run of the AI employees the viewer may see, as executions: filters by status, AI employee,
 * department, what started it, real or test, and period; the period in numbers above the list.
 */
export function Executions({ filters, update }: { filters: ExecutionFilters; update: (patch: Partial<ExecutionFilters>) => void }) {
  const agents = useAgents();
  const departments = useDepartments();
  const period = PERIODS.find((p) => p.value === filters.days) ?? PERIODS[1]!;
  // The period starts at a whole hour, so the list and the numbers keep their keys while the page is open.
  const from = new Date(Math.floor((Date.now() - period.days * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
  const scope = { agent: filters.agent || undefined, department: filters.department || undefined };
  const query: RunsQuery = {
    ...scope,
    status: filters.status || undefined,
    trigger: filters.trigger || undefined,
    test: filters.test === "" ? undefined : (filters.test as "true" | "false"),
    from,
  };
  const page = useRunsPage(query);
  const insights = useRunInsights({ ...scope, from });
  const runs = page.data?.pages.flatMap((p) => p.runs) ?? [];
  const visibleDepartments = (departments.data ?? []).filter((d) => d.visible !== false);

  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <select className="input" value={filters.days} onChange={(e) => update({ days: e.target.value })} aria-label="Period">
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select className="input" value={filters.status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="input" value={filters.department} onChange={(e) => update({ department: e.target.value, agent: "" })} aria-label="Department">
          <option value="">All departments</option>
          {visibleDepartments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select className="input" value={filters.agent} onChange={(e) => update({ agent: e.target.value })} aria-label="AI employee">
          <option value="">All AI employees</option>
          {(agents.data ?? [])
            .filter((a) => !filters.department || a.departmentId === filters.department)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((a) => (
              <option key={a.id} value={a.slug}>
                {a.name}
              </option>
            ))}
        </select>
        <select className="input" value={filters.trigger} onChange={(e) => update({ trigger: e.target.value })} aria-label="Started by">
          <option value="">Started any way</option>
          {Object.entries(RUN_TRIGGER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select className="input" value={filters.test} onChange={(e) => update({ test: e.target.value })} aria-label="Real or test">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      {insights.error ? null : insights.data ? (
        <InsightStrip insights={insights.data} days={period.days} />
      ) : (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        {page.error ? (
          <ErrorState error={page.error} onRetry={() => void page.refetch()} className="m-4" />
        ) : page.isLoading ? (
          <LoadingBlock />
        ) : (
          <RunsTable
            runs={runs}
            empty={<EmptyState compact className="m-4" icon={Activity} title="No runs here" description="Try a longer period or another filter." />}
          />
        )}
        {page.hasNextPage && (
          <div className="border-t border-line px-4 py-3 text-center">
            <Button size="sm" variant="ghost" loading={page.isFetchingNextPage} onClick={() => void page.fetchNextPage()}>
              Show more
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
