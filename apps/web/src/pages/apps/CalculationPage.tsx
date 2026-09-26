import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Archive, ArchiveRestore, Calculator, CircleAlert, CircleCheck, Play, Table2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../../components/Card.tsx";
import { SCHEDULES } from "../../components/calculations/NewCalculationDialog.tsx";
import { ResultView } from "../../components/calculations/ResultView.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDateTime, formatDuration, timeAgo } from "../../lib/format.ts";
import { keys, useCalculation, useDepartments, useTables } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { CalculationRun, CalculationSchedule, CalculationView } from "../../types.ts";

/** A calculation: the rule, how it works, its latest result and every run; IT also sees the code. */
export default function CalculationPage() {
  const { key = "" } = useParams();
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useCalculation(key);
  const departments = useDepartments();
  const tables = useTables();
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.calculations(company) });
  const run = useMutation({
    mutationFn: () => api.post<CalculationRun>(path(`/calculations/${encodeURIComponent(key)}/run`)),
    onSuccess: async (done) => {
      if (done.status === "succeeded") toast.success("Worked out again on today's rows");
      else toast.error(done.error ?? "It didn't work");
      setShown(null);
      await refresh();
    },
    onError: (e) => toast.error(e),
  });
  const change = useMutation({
    mutationFn: (body: { schedule?: CalculationSchedule | null }) => api.patch<CalculationView>(path(`/calculations/${encodeURIComponent(key)}`), body),
    onSuccess: async () => {
      toast.success("Saved");
      await refresh();
    },
    onError: (e) => toast.error(e),
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post<CalculationView>(path(`/calculations/${encodeURIComponent(key)}/${archived ? "archive" : "restore"}`)),
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });

  if (detail.isLoading) return <LoadingBlock className="min-h-[50vh]" />;
  if (detail.error || !detail.data) {
    return (
      <Page>
        <ErrorState error={detail.error ?? new Error("There is no such calculation")} />
      </Page>
    );
  }
  const { calculation, runs } = detail.data;
  const current = runs.find((r) => r.id === shown) ?? runs.find((r) => r.status === "succeeded") ?? runs[0];
  const department = calculation.departmentId ? departments.data?.find((d) => d.id === calculation.departmentId)?.name : "The whole company";
  const tableNames = calculation.tables.map((k) => tables.data?.find((t) => t.key === k)).filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <Page>
      <PageHeader
        icon={Calculator}
        eyebrow={`Apps · ${department ?? "A department"}`}
        title={calculation.name}
        description={<span className="italic">“{calculation.rule}”</span>}
        actions={
          <>
            {tableNames.map((t) => (
              <ButtonLink key={t.key} to={`/tables/${t.key}`} icon={Table2} variant="ghost" size="sm">
                {t.name}
              </ButtonLink>
            ))}
            <Button variant="primary" icon={Play} loading={run.isPending} disabled={Boolean(calculation.archivedAt)} onClick={() => run.mutate()}>
              Work it out now
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {calculation.explanation && (
            <Card className="p-4 text-sm">
              <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">How it works</p>
              <p className="text-fg">{calculation.explanation}</p>
            </Card>
          )}
          <Card>
            <CardHeader
              title={current?.status === "failed" ? "It didn't work" : "Result"}
              subtitle={current ? `${formatDateTime(current.createdAt)} · ${current.by} · on ${current.rows} rows` : "Not worked out yet"}
            />
            <div className="p-4">
              {!current && <p className="text-sm text-muted">Work it out to see the result.</p>}
              {current?.status === "failed" && <p className="text-sm text-red-700 dark:text-red-300">{current.error}</p>}
              {current?.status === "succeeded" && <ResultView output={calculation.output} result={current.result} />}
            </div>
          </Card>
          {detail.data.code && (
            <details className="rounded-xl border border-line bg-subtle/40 p-4 text-sm">
              <summary className="cursor-pointer font-medium text-muted">The code the Studio wrote (IT)</summary>
              <pre className="mt-3 overflow-x-auto text-xs text-fg">{detail.data.code}</pre>
            </details>
          )}
        </div>
        <div className="space-y-5">
          <Card className="p-4">
            <p className="label">It runs</p>
            <select
              className="input"
              value={calculation.schedule ?? ""}
              disabled={!calculation.can.design || change.isPending}
              onChange={(e) => change.mutate({ schedule: (e.target.value || null) as CalculationSchedule | null })}
              aria-label="When it runs"
            >
              {SCHEDULES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <p className="hint">In the company's time zone. Every run is kept below.</p>
            {calculation.can.design && (
              <Button
                className="mt-3"
                size="sm"
                variant="ghost"
                icon={calculation.archivedAt ? ArchiveRestore : Archive}
                onClick={() => archive.mutate(!calculation.archivedAt)}
              >
                {calculation.archivedAt ? "Bring it back" : "Archive it"}
              </Button>
            )}
          </Card>
          <Card>
            <CardHeader title="Runs" />
            <ul className="divide-y divide-line/70">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setShown(r.id)}
                    className={clsx(
                      "flex w-full items-start gap-2.5 px-4 py-2.5 text-left text-sm hover:bg-subtle/60",
                      current?.id === r.id && "bg-brand-50/60 dark:bg-brand-400/10",
                    )}
                  >
                    {r.status === "succeeded" ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-fg">{timeAgo(r.createdAt)}</span>
                      <span className="block text-xs text-muted">
                        {r.by} · {formatDuration(r.durationMs)}
                        {r.version > 1 && ` · version ${r.version}`}
                      </span>
                    </span>
                    {r.trigger === "schedule" && (
                      <Badge size="xs" tone="blue">
                        Scheduled
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
              {!runs.length && <li className="px-4 py-3 text-sm text-muted">No runs yet.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}
