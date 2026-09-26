import { clsx } from "clsx";
import { Clock, Gauge, GraduationCap, UserCheck, UserPlus, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../../components/Card.tsx";
import { StackedBars, Sparkline } from "../../components/Charts.tsx";
import { PROBATION } from "../../components/Employment.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Chip } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { Callout, ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { formatDate, formatMoney, percent, plural, workingHoursText } from "../../lib/format.ts";
import { useViewer } from "../../lib/auth.tsx";
import { useDepartments, usePerformance } from "../../lib/queries.ts";
import type { HiringRow, PerformanceMeasures, PerformanceReport, ReportPeriodKey, WorkingHours } from "../../types.ts";

const PERIODS: { key: ReportPeriodKey; label: string }[] = [
  { key: "last-4-weeks", label: "Last 4 weeks" },
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysText(days: number[]): string {
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const contiguous = sorted.every((d, i) => i === 0 || (sorted[i - 1]! + 1) % 7 === d);
  return contiguous && sorted.length > 2 ? `${DAY_NAMES[sorted[0]!]}–${DAY_NAMES[sorted.at(-1)!]}` : sorted.map((d) => DAY_NAMES[d]).join(", ");
}

export function workingHoursNote(hours: WorkingHours): string {
  return `Working hours: ${daysText(hours.days)} ${hours.start}–${hours.end} (${hours.timeZone.replace(/_/g, " ")}).`;
}

function weekLabel(start: string): string {
  return new Date(`${start}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

type Verdict = "met" | "missed" | "none";

const VERDICT_TONE: Record<Verdict, string> = {
  met: "text-emerald-700 dark:text-emerald-300",
  missed: "text-amber-700 dark:text-amber-300",
  none: "text-muted",
};

function Measure({
  icon: Icon,
  title,
  value,
  detail,
  target,
  verdict,
  trend,
}: {
  icon: typeof Gauge;
  title: string;
  value: string;
  detail: ReactNode;
  target?: string;
  verdict: Verdict;
  trend?: ReactNode;
}) {
  return (
    <Card className="flex flex-col px-5 py-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon className="size-3.5" /> {title}
      </p>
      <p className="mt-1 text-2xl font-semibold text-fg tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{detail}</p>
      {target && (
        <p className={clsx("mt-1 text-xs font-medium", VERDICT_TONE[verdict])}>
          {verdict === "met" ? "On target" : verdict === "missed" ? "Off target" : "Target"}: {target}
        </p>
      )}
      {trend && <div className="mt-auto pt-3">{trend}</div>}
    </Card>
  );
}

function verdictOf(value: number | null, target: number, better: "higher" | "lower"): Verdict {
  if (value === null) return "none";
  return (better === "higher" ? value >= target : value <= target) ? "met" : "missed";
}

/** A share, with a decimal when whole percents would hide which side of its target it is on (69.7%, not 70%). */
function shareAgainst(value: number | null, target: number, better: "higher" | "lower"): string {
  if (value === null) return "—";
  const whole = Math.round(value * 100);
  const met = better === "higher" ? value >= target : value < target;
  const looksMet = better === "higher" ? whole >= target * 100 : whole < target * 100;
  if (met === looksMet) return `${whole}%`;
  const tenth = value < target ? Math.floor(value * 1000) / 10 : Math.ceil(value * 1000) / 10;
  return `${tenth.toFixed(1)}%`;
}

function MeasureCells({ m, strong }: { m: PerformanceMeasures; strong?: boolean }) {
  return (
    <>
      <td className={clsx("px-3 py-2.5 text-right tabular-nums", strong && "font-medium")}>{m.finished}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{percent(m.aloneShare)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{workingHoursText(m.medianHandlingHours)}</td>
      <td
        className={clsx("px-3 py-2.5 text-right tabular-nums", m.correctedShare !== null && m.correctedShare >= 0.05 && "text-amber-700 dark:text-amber-300")}
      >
        {m.corrected ? `${m.corrected} (${percent(m.correctedShare)})` : "0"}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(m.costUsd)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{m.costPerTaskUsd === null ? "—" : formatMoney(m.costPerTaskUsd, 3)}</td>
    </>
  );
}

const HEAD = ["Finished", "Alone", "People took", "Corrected", "Cost", "Per task"];

function Overview({ report }: { report: PerformanceReport }) {
  const { total, targets, weeks } = report;
  const m = total.measures;
  const trusted = total.afterProbation;
  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Measure
          icon={Gauge}
          title="Finished alone, after probation"
          value={trusted.aiEmployees ? shareAgainst(trusted.aloneShare, targets.aloneShare, "higher") : "—"}
          detail={
            trusted.aiEmployees
              ? `${trusted.finishedAlone} of ${plural(trusted.finished, "task")} by ${plural(trusted.aiEmployees, "Trusted AI employee")}${
                  m.finished !== trusted.finished ? `; ${percent(m.aloneShare)} of all ${m.finished}` : ""
                }`
              : `No AI employee is Trusted yet; ${percent(m.aloneShare)} of all ${plural(m.finished, "finished task")}`
          }
          target={`${percent(targets.aloneShare)} or more`}
          verdict={trusted.aiEmployees ? verdictOf(trusted.aloneShare, targets.aloneShare, "higher") : "none"}
          trend={<Sparkline values={weeks.map((w) => w.afterProbation.aloneShare)} target={targets.aloneShare} max={1} tone="green" />}
        />
        <Measure
          icon={Clock}
          title="People took, to handle what it asked"
          value={workingHoursText(m.medianHandlingHours)}
          detail={m.handled ? `Median of ${plural(m.handled, "item")}, in working hours` : "Nothing was handled by people"}
          target={`under ${targets.medianHandlingHours} working hours`}
          verdict={verdictOf(m.medianHandlingHours, targets.medianHandlingHours, "lower")}
          trend={<Sparkline values={weeks.map((w) => w.measures.medianHandlingHours)} target={targets.medianHandlingHours} tone="brand" />}
        />
        <Measure
          icon={GraduationCap}
          title="Corrected later"
          value={shareAgainst(m.correctedShare, targets.correctedShare, "lower")}
          detail={`${m.corrected} of ${plural(m.finished, "finished task")} marked as wrong`}
          target={`under ${percent(targets.correctedShare)}`}
          verdict={m.correctedShare === null ? "none" : m.correctedShare < targets.correctedShare ? "met" : "missed"}
          trend={<Sparkline values={weeks.map((w) => w.measures.correctedShare)} target={targets.correctedShare} tone="amber" />}
        />
        <Measure
          icon={Wallet}
          title="Cost per finished task"
          value={m.costPerTaskUsd === null ? "—" : formatMoney(m.costPerTaskUsd, 3)}
          detail={`${formatMoney(m.costUsd)} in all, tests included`}
          verdict="none"
          trend={<Sparkline values={weeks.map((w) => w.measures.costPerTaskUsd)} tone="slate" />}
        />
      </div>
      <Card className="mb-6">
        <CardHeader title="Tasks finished, by week" icon={UserCheck} subtitle="Finished alone, and with a person approving, answering or checking." />
        <div className="px-5 pt-3 pb-4">
          <StackedBars
            bars={weeks.map((w) => ({
              label: weekLabel(w.start),
              parts: [
                { value: w.measures.finishedAlone, tone: "green" as const, label: "alone" },
                { value: w.measures.finished - w.measures.finishedAlone, tone: "brand" as const, label: "with a person" },
                { value: w.measures.failed, tone: "red" as const, label: "stopped with a problem" },
              ],
            }))}
          />
        </div>
      </Card>
    </>
  );
}

function hiringSummary(rows: HiringRow[], kind: HiringRow["source"], name: string, within: string): string | null {
  const own = rows.filter((h) => h.source === kind);
  if (!own.length) return null;
  const late = own.filter((h) => h.met === false).length;
  const waiting = own.filter((h) => h.hours === null && h.met !== false).length;
  return `${name}: ${own.length} hired, ${late ? `${late} not at work within ${within}` : `all at work within ${within}`}${waiting ? `, ${waiting} still on the way` : ""}.`;
}

function Hiring({ report }: { report: PerformanceReport }) {
  const [all, setAll] = useState(false);
  if (!report.hiring.length) return null;
  const { targets } = report;
  const shown = all ? report.hiring : report.hiring.slice(0, 5);
  const summary = [
    hiringSummary(report.hiring, "ready-made", "Ready-made", `${targets.readyMadeHours / 24} day`),
    hiringSummary(report.hiring, "studio", "Built in the Studio", `${targets.studioHours / 24} days`),
  ].filter(Boolean);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Hiring, last 90 days"
        icon={UserPlus}
        subtitle={`A ready-made AI employee should be at work within ${targets.readyMadeHours / 24} day, one built in the Studio within ${targets.studioHours / 24} days, IT's part included.`}
      />
      {summary.length > 0 && <p className="border-b border-line px-5 py-3 text-sm text-fg">{summary.join(" ")}</p>}
      <ul className="divide-y divide-line">
        {shown.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
            <Link to={`/ai/${h.slug}`} className="min-w-0 basis-full truncate text-sm font-medium text-fg hover:underline sm:basis-auto sm:flex-1">
              {h.name}
            </Link>
            <Badge tone={h.source === "studio" ? "violet" : "neutral"}>
              {h.source === "studio" ? "Built in the Studio" : h.source === "ready-made" ? "Ready-made" : "Made by hand"}
            </Badge>
            <span className="text-xs text-muted">started {formatDate(h.startedAt)}</span>
            <span className="text-sm text-fg tabular-nums">
              {h.hours === null ? "not at work yet" : `at work after ${h.hours < 48 ? `${Math.round(h.hours)} h` : `${Math.round(h.hours / 24)} days`}`}
            </span>
            {h.met !== null && <Badge tone={h.met ? "green" : "amber"}>{h.met ? "On time" : "Late"}</Badge>}
          </li>
        ))}
      </ul>
      {report.hiring.length > shown.length && (
        <button
          type="button"
          className="w-full border-t border-line px-5 py-2.5 text-left text-sm text-muted hover:bg-subtle/60 hover:text-fg"
          onClick={() => setAll(true)}
        >
          Show all {report.hiring.length}
        </button>
      )}
    </Card>
  );
}

/** How AI employees work: what they finish alone, how fast people help them, what people correct, what it costs. */
export default function Performance() {
  const [params, setParams] = useSearchParams();
  const period = (PERIODS.find((p) => p.key === params.get("period"))?.key ?? "last-4-weeks") as ReportPeriodKey;
  const department = params.get("department") ?? undefined;
  const set = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const { data, isLoading, error, refetch } = usePerformance(period, department);
  const viewer = useViewer();
  const installed = useDepartments();
  // The departments the viewer manages (all for admins), to narrow the report to one.
  const managed = (installed.data ?? []).filter((d) => viewer?.isAdmin || viewer?.departments.some((m) => m.id === d.id && m.role === "manager"));
  const departmentName = (id: string | null) => (installed.data ?? []).find((d) => d.id === id)?.name ?? "";
  const busy = (m: PerformanceMeasures) => m.started + m.finished + m.failed + m.handled > 0 || m.costUsd > 0;
  const working = (data?.aiEmployees ?? []).filter((a) => busy(a.measures));
  const idle = (data?.aiEmployees ?? []).filter((a) => !busy(a.measures));

  return (
    <Page>
      <div className="mb-2 text-sm">
        <Link to="/company" className="text-muted hover:text-fg">
          Company
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <span className="text-fg">Performance</span>
      </div>
      <PageHeader
        icon={Gauge}
        title="Performance"
        description="How your AI employees work: what they finish alone, how long people take to help them, what people correct later, and what it costs."
        actions={
          <ButtonLink to="/settings/costs" icon={Wallet}>
            Costs and budgets
          </ButtonLink>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <Chip key={p.key} role="radio" selected={p.key === period} onClick={() => set("period", p.key === "last-4-weeks" ? undefined : p.key)}>
            {p.label}
          </Chip>
        ))}
        {managed.length > 1 && (
          <select
            className="input ml-auto h-8 w-auto py-0 text-[13px]"
            value={department ?? ""}
            onChange={(e) => set("department", e.target.value || undefined)}
            aria-label="Department"
          >
            <option value="">All departments</option>
            {managed.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {isLoading && <LoadingBlock />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.aiEmployees.length === 0 && (
        <EmptyState icon={Gauge} title="No AI employees to report on" description="You see the AI employees of the departments you manage." />
      )}
      {data && data.aiEmployees.length > 0 && (
        <div className="space-y-6">
          {working.length === 0 && <Callout tone="info">None of these AI employees worked in this period.</Callout>}
          <Overview report={data} />
          {data.departments.length > 1 && (
            <Card className="overflow-hidden">
              <CardHeader title="Departments" icon={Gauge} subtitle={`${data.period.label}.`} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="border-b border-line bg-subtle/50 text-xs text-muted">
                    <tr>
                      <th className="px-5 py-2 text-left font-medium">Department</th>
                      {HEAD.map((h) => (
                        <th key={h} className="px-3 py-2 text-right font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.departments.map((d) => (
                      <tr key={d.id ?? "company"}>
                        <td className="px-5 py-2.5">
                          {d.key ? (
                            <button type="button" className="font-medium text-fg hover:underline" onClick={() => set("department", d.key!)}>
                              {d.name}
                            </button>
                          ) : (
                            <span className="font-medium text-fg">{d.name}</span>
                          )}
                          <span className="block text-xs text-muted">{plural(d.aiEmployees, "AI employee")}</span>
                        </td>
                        <MeasureCells m={d.measures} strong />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Card className="overflow-hidden">
            <CardHeader
              title="AI employees"
              icon={UserCheck}
              subtitle={`${data.period.label}. "Alone": finished with no person approving, answering, checking or retrying.${idle.length ? ` ${plural(idle.length, "other")} had no work.` : ""}`}
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="border-b border-line bg-subtle/50 text-xs text-muted">
                  <tr>
                    <th className="px-5 py-2 text-left font-medium">AI employee</th>
                    {HEAD.map((h) => (
                      <th key={h} className="px-3 py-2 text-right font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {working.map((a) => (
                    <tr key={a.id}>
                      <td className="px-5 py-2.5">
                        <Link to={`/ai/${a.slug}`} className="font-medium text-fg hover:underline">
                          {a.name}
                        </Link>
                        <span className="block text-xs text-muted">
                          {[departmentName(a.departmentId), PROBATION[a.probation].label].filter(Boolean).join(" · ")}
                          {a.status !== "active" && (
                            <>
                              {" · "}
                              <StatusPill status={a.status} size="xs" />
                            </>
                          )}
                        </span>
                      </td>
                      <MeasureCells m={a.measures} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Hiring report={data} />
          <p className="text-xs text-faint">
            {workingHoursNote(data.workingHours)} Costs are the language model's, tests included; cost per task counts real work only.
          </p>
        </div>
      )}
    </Page>
  );
}
