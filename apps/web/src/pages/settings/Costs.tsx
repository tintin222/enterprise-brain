import { clsx } from "clsx";
import { Wallet } from "lucide-react";
import { Link } from "react-router";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { PROBATION } from "../../components/Employment.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { formatMoney } from "../../lib/format.ts";
import { useCosts } from "../../lib/queries.ts";

function monthName(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(year!, (m ?? 1) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** What each AI employee the viewer manages cost this month, against its budget. */
export default function Costs() {
  const costs = useCosts();
  const data = costs.data;
  return (
    <Page>
      <PageHeader
        icon={Wallet}
        title="Costs"
        description="What your AI employees cost this month in language-model use. Each one stops starting new work at its monthly budget and tells its manager."
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
              <p className="text-xs font-medium text-muted">AI employees</p>
              <p className="mt-1 text-2xl font-semibold text-fg tabular-nums">{data.aiEmployees.length}</p>
            </Card>
            <Card className="px-5 py-4">
              <p className="text-xs font-medium text-muted">Stopped by their budget</p>
              <p
                className={clsx(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  data.aiEmployees.some((a) => a.stoppedByBudget) ? "text-red-600 dark:text-red-400" : "text-fg",
                )}
              >
                {data.aiEmployees.filter((a) => a.stoppedByBudget).length}
              </p>
            </Card>
          </div>
          <Card className="overflow-hidden">
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
                      <th className="px-4 py-2.5 font-medium">Budget</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.aiEmployees.map((a) => {
                      const used = a.monthlyBudgetUsd ? Math.min(100, Math.round((a.costThisMonthUsd / a.monthlyBudgetUsd) * 100)) : null;
                      return (
                        <tr key={a.slug} className="align-middle">
                          <td className="px-4 py-3">
                            <Link to={`/ai/${a.slug}?tab=rules`} className="font-medium text-fg hover:underline">
                              {a.name}
                            </Link>
                            <p className="flex items-center gap-1.5 text-xs text-muted">
                              {a.department ?? "Company-wide"}
                              {a.status !== "active" && <StatusPill status={a.status} size="xs" />}
                            </p>
                          </td>
                          <td className="hidden px-4 py-3 text-muted md:table-cell">{a.manager ?? "—"}</td>
                          <td className="hidden px-4 py-3 sm:table-cell">
                            <Badge size="xs">{PROBATION[a.probation].label}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-fg tabular-nums">{formatMoney(a.costThisMonthUsd)}</td>
                          <td className="px-4 py-3">
                            {used === null ? (
                              <span className="text-xs text-faint">No limit</span>
                            ) : (
                              <div className="min-w-28">
                                <p className={clsx("text-xs tabular-nums", a.stoppedByBudget ? "font-medium text-red-600 dark:text-red-400" : "text-muted")}>
                                  {a.stoppedByBudget ? "Reached " : ""}
                                  {formatMoney(a.monthlyBudgetUsd)}
                                </p>
                                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                                  <div
                                    className={clsx("h-full rounded-full", used >= 100 ? "bg-red-500" : used >= 80 ? "bg-amber-500" : "bg-emerald-500")}
                                    style={{ width: `${used}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="mt-3 text-xs text-muted">Change a budget on the AI employee's page, under Probation and rules.</p>
        </>
      )}
    </Page>
  );
}
