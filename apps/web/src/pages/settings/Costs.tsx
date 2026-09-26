import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Building2, Gauge, PencilLine, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../../components/Card.tsx";
import { StackedBars, type ChartTone } from "../../components/Charts.tsx";
import { PROBATION } from "../../components/Employment.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatMoney, possessive } from "../../lib/format.ts";
import { useCosts } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { CostOverview } from "../../types.ts";

function monthName(month: string, style: "long" | "short" = "long"): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(year!, (m ?? 1) - 1, 1).toLocaleDateString("en-US", style === "long" ? { month: "long", year: "numeric" } : { month: "short" });
}

/** How much of a budget is used, as a bar: green, amber from 80%, red at the limit. */
function BudgetBar({ cost, budget, stopped }: { cost: number; budget: number | null; stopped: boolean }) {
  if (budget === null) return <span className="text-xs text-faint">No limit</span>;
  const used = budget > 0 ? Math.min(100, Math.round((cost / budget) * 100)) : 100;
  return (
    <div className="min-w-28">
      <p className={clsx("text-xs tabular-nums", stopped ? "font-medium text-red-600 dark:text-red-400" : "text-muted")}>
        {stopped ? "Reached " : `${used}% of `}
        {formatMoney(budget)}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
        <div
          className={clsx("h-full rounded-full", used >= 100 ? "bg-red-500" : used >= 80 ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

/** A department's budget, set in place by its managers and admins. */
function DepartmentBudget({ department }: { department: CostOverview["departments"][number] }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(department.monthlyBudgetUsd?.toString() ?? "");
  const save = useMutation({
    mutationFn: (monthlyBudgetUsd: number | null) => api.put(path(`/departments/${encodeURIComponent(department.key)}/budget`), { monthlyBudgetUsd }),
    onSuccess: (_, monthlyBudgetUsd) => {
      void queryClient.invalidateQueries({ queryKey: [company, "costs"] });
      void queryClient.invalidateQueries({ queryKey: [company, "agents"] });
      toast.success(
        monthlyBudgetUsd === null
          ? `${department.name} has no monthly budget now`
          : `${possessive(department.name)} monthly budget is ${formatMoney(monthlyBudgetUsd)}`,
      );
      setEditing(false);
    },
    onError: (error) => toast.error(error),
  });
  const parsed = value.trim() === "" ? null : Number(value);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <BudgetBar cost={department.costThisMonthUsd} budget={department.monthlyBudgetUsd} stopped={department.stoppedByBudget} />
        <Button size="xs" variant="ghost" icon={PencilLine} aria-label={`Change ${possessive(department.name)} budget`} onClick={() => setEditing(true)} />
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(parsed);
      }}
    >
      <input
        className="input h-8 w-28 py-0 text-[13px]"
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        placeholder="No limit"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`${possessive(department.name)} monthly budget (USD)`}
        autoFocus
      />
      <Button size="xs" variant="primary" type="submit" disabled={!valid} loading={save.isPending}>
        Save
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

const TONES: ChartTone[] = ["brand", "green", "amber", "slate", "red"];

function Trend({ data }: { data: CostOverview }) {
  const keys = [...new Set(data.months.flatMap((m) => Object.keys(m.byDepartment)))];
  if (!keys.length) return null;
  const name = (key: string) => (key === "company" ? "Company-wide" : (data.departments.find((d) => d.id === key)?.name ?? "Other"));
  // The biggest spenders get their own colour; the rest share one.
  const ranked = keys.sort(
    (a, b) => data.months.reduce((s, m) => s + (m.byDepartment[b] ?? 0), 0) - data.months.reduce((s, m) => s + (m.byDepartment[a] ?? 0), 0),
  );
  const shown = ranked.slice(0, TONES.length - 1);
  const rest = ranked.slice(TONES.length - 1);
  return (
    <Card className="mb-6">
      <CardHeader title="Last six months" icon={Gauge} subtitle="What AI employees cost each month, by department." />
      <div className="px-5 pt-3 pb-4">
        <StackedBars
          height={120}
          format={(usd) => formatMoney(usd)}
          bars={data.months.map((m) => ({
            label: monthName(m.month, "short"),
            parts: [
              ...shown.map((key, i) => ({ value: Math.round((m.byDepartment[key] ?? 0) * 100) / 100, tone: TONES[i]!, label: name(key) })),
              ...(rest.length
                ? [{ value: Math.round(rest.reduce((s, key) => s + (m.byDepartment[key] ?? 0), 0) * 100) / 100, tone: TONES.at(-1)!, label: "Others" }]
                : []),
            ],
          }))}
        />
      </div>
    </Card>
  );
}

/** What AI employees cost this month, by department and AI employee, against their budgets. */
export default function Costs() {
  const costs = useCosts();
  const data = costs.data;
  const stoppedDepartments = data?.departments.filter((d) => d.stoppedByBudget).length ?? 0;
  return (
    <Page>
      <PageHeader
        icon={Wallet}
        title="Costs and budgets"
        description="What your AI employees cost in language-model use, by department and AI employee. At its own budget or its department's, an AI employee stops starting new work and tells its manager."
        actions={
          <ButtonLink to="/company/performance" icon={Gauge}>
            Performance
          </ButtonLink>
        }
      />
      {costs.error && <ErrorState error={costs.error} onRetry={() => void costs.refetch()} />}
      {costs.isLoading && <LoadingBlock />}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="px-5 py-4">
              <p className="text-xs font-medium text-muted">{monthName(data.month)}</p>
              <p className="mt-1 text-2xl font-semibold text-fg tabular-nums">{formatMoney(data.totalUsd)}</p>
            </Card>
            <Card className="px-5 py-4">
              <p className="text-xs font-medium text-muted">Departments at their budget</p>
              <p className={clsx("mt-1 text-2xl font-semibold tabular-nums", stoppedDepartments ? "text-red-600 dark:text-red-400" : "text-fg")}>
                {stoppedDepartments} <span className="text-sm font-normal text-muted">of {data.departments.length}</span>
              </p>
            </Card>
            <Card className="px-5 py-4">
              <p className="text-xs font-medium text-muted">AI employees stopped by a budget</p>
              <p
                className={clsx(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  data.aiEmployees.some((a) => a.stoppedByBudget) ? "text-red-600 dark:text-red-400" : "text-fg",
                )}
              >
                {data.aiEmployees.filter((a) => a.stoppedByBudget).length} <span className="text-sm font-normal text-muted">of {data.aiEmployees.length}</span>
              </p>
            </Card>
          </div>
          <Trend data={data} />
          {data.departments.length > 0 && (
            <Card className="mb-6 overflow-hidden">
              <CardHeader
                title="Departments"
                icon={Building2}
                subtitle="A department's budget holds all its AI employees together. Its managers and admins set it."
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-4 py-2.5 font-medium">Department</th>
                      <th className="px-4 py-2.5 text-right font-medium">This month</th>
                      <th className="px-4 py-2.5 font-medium">Monthly budget</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.departments.map((d) => (
                      <tr key={d.id} className="align-middle">
                        <td className="px-4 py-3">
                          <p className="font-medium text-fg">{d.name}</p>
                          <p className="text-xs text-muted">
                            {d.aiEmployees} AI employee{d.aiEmployees === 1 ? "" : "s"}
                            {d.stoppedByBudget && (
                              <Badge tone="red" size="xs" className="ml-1.5">
                                Stopped
                              </Badge>
                            )}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-fg tabular-nums">{formatMoney(d.costThisMonthUsd)}</td>
                        <td className="px-4 py-3">
                          <DepartmentBudget key={`${d.id}-${d.monthlyBudgetUsd}`} department={d} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Card className="overflow-hidden">
            <CardHeader title="AI employees" icon={Wallet} subtitle="Change an AI employee's own budget on its page, under Probation and rules." />
            {data.aiEmployees.length === 0 ? (
              <EmptyState
                compact
                className="m-4"
                icon={Wallet}
                title="No AI employees to show"
                description="You see the AI employees of the departments you manage."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-4 py-2.5 font-medium">AI employee</th>
                      <th className="hidden px-4 py-2.5 font-medium md:table-cell">Manager</th>
                      <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Level</th>
                      <th className="px-4 py-2.5 text-right font-medium">This month</th>
                      <th className="px-4 py-2.5 font-medium">Its budget</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.aiEmployees.map((a) => (
                      <tr key={a.slug} className="align-middle">
                        <td className="px-4 py-3">
                          <Link to={`/ai/${a.slug}?tab=rules`} className="font-medium text-fg hover:underline">
                            {a.name}
                          </Link>
                          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            {a.department ?? "Company-wide"}
                            {a.status !== "active" && <StatusPill status={a.status} size="xs" />}
                            {a.stoppedBy === "department" && (
                              <Badge tone="red" size="xs">
                                Stopped by the department's budget
                              </Badge>
                            )}
                          </p>
                        </td>
                        <td className="hidden px-4 py-3 text-muted md:table-cell">{a.manager ?? "—"}</td>
                        <td className="hidden px-4 py-3 sm:table-cell">
                          <Badge size="xs">{PROBATION[a.probation].label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-fg tabular-nums">{formatMoney(a.costThisMonthUsd)}</td>
                        <td className="px-4 py-3">
                          <BudgetBar cost={a.costThisMonthUsd} budget={a.monthlyBudgetUsd} stopped={a.stoppedBy === "own"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
