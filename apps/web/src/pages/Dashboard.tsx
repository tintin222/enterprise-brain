import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Building,
  CircleDollarSign,
  CirclePlay,
  FileSpreadsheet,
  Inbox,
  LibraryBig,
  MessageSquare,
  ScanText,
  Search,
  UserCheck,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { ButtonLink } from "../components/Button.tsx";
import { Card, CardHeader } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { RunsTable } from "../components/RunViews.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatMoney, formatNumber, timeAgo } from "../lib/format.ts";
import { activityIcon } from "../lib/icons.tsx";
import { keys } from "../lib/queries.ts";
import type { Dashboard as DashboardData } from "../types.ts";

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  to,
  tone = "brand",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: LucideIcon;
  to?: string;
  tone?: "brand" | "amber" | "green" | "slate";
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <span
          className={clsx(
            "flex size-8 items-center justify-center rounded-lg",
            tone === "brand" && "bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300",
            tone === "amber" && "bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
            tone === "green" && "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300",
            tone === "slate" && "bg-subtle text-muted",
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </>
  );
  const cls = clsx("rounded-xl border border-line bg-surface p-4 shadow-xs", to && "transition-colors hover:border-brand-300 dark:hover:border-brand-400/40", className);
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const USE_CASES: { to: string; label: string; description: string; icon: LucideIcon }[] = [
  { to: "/assistant", label: "Assistant", description: "Ask the company knowledge base, with sources", icon: MessageSquare },
  { to: "/search", label: "Search", description: "One search box over documents and agents", icon: Search },
  { to: "/inbox", label: "Mail triage", description: "Shared mailboxes read, classified and answered", icon: Inbox },
  { to: "/documents", label: "Documents & OCR", description: "Extract data from PDFs, scans and photos", icon: ScanText },
  { to: "/excel", label: "Excel automation", description: "Reconcile, analyse and clean spreadsheets", icon: FileSpreadsheet },
  { to: "/knowledge", label: "Knowledge base", description: "Policies and procedures every agent uses", icon: BookOpen },
];

export default function Dashboard() {
  const { company, companyName, path } = useCompany();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.dashboard(company),
    queryFn: () => api.get<DashboardData>(path("/dashboard")),
    refetchInterval: 30_000,
  });
  const c = data?.counts;
  const successRate = c && c.runs24h ? Math.round((c.succeeded24h / c.runs24h) * 100) : null;

  return (
    <Page>
      <div className="relative mb-8 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-brand-600 to-violet-600 px-6 py-7 text-white shadow-sm sm:px-8 sm:py-8">
        <div className="bg-dots absolute inset-0 opacity-20" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-white/75">{companyName}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Turn how your company works into agents.</h1>
            <p className="mt-2 text-[15px] text-white/85">
              Describe a task in plain words and the AI analyst designs, tests and deploys the agent — or start from ready-made department templates.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/builder/new"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-brand-700 shadow-sm hover:bg-brand-50"
            >
              <WandSparkles className="size-4" /> Build an agent with AI
            </Link>
            <Link
              to="/catalog"
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-white/30 hover:bg-white/20"
            >
              <LibraryBig className="size-4" /> Browse department templates
            </Link>
          </div>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={() => void refetch()} className="mb-6" />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {isLoading || !c ? (
          [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <Kpi label="Active agents" value={formatNumber(c.activeAgents)} sub={`of ${c.agents} installed`} icon={Bot} to="/agents" />
            <Kpi
              label="Runs · last 24 h"
              value={formatNumber(c.runs24h)}
              icon={CirclePlay}
              to="/runs"
              className="col-span-2"
              sub={
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-emerald-700 dark:text-emerald-300">✓ {c.succeeded24h} succeeded</span>
                  <span className={c.failed24h ? "text-red-600 dark:text-red-300" : ""}>✗ {c.failed24h} failed</span>
                  {successRate !== null && (
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-red-200 dark:bg-red-400/20">
                        <span className="block h-full bg-emerald-500" style={{ width: `${successRate}%` }} />
                      </span>
                      {successRate}%
                    </span>
                  )}
                </div>
              }
            />
            <Kpi
              label="Pending approvals"
              value={formatNumber(c.pendingApprovals)}
              sub={c.pendingApprovals ? "Waiting for a decision" : "Nothing waiting"}
              icon={UserCheck}
              to="/approvals"
              tone={c.pendingApprovals ? "amber" : "slate"}
            />
            <Kpi label="Cost this month" value={formatMoney(data.costMonthUsd, 2)} sub="LLM usage across all runs" icon={CircleDollarSign} tone="green" />
            <Kpi label="Departments" value={formatNumber(c.departments)} sub="Installed operating model" icon={Building} to="/departments" tone="slate" />
            <Kpi label="Knowledge documents" value={formatNumber(c.knowledgeDocuments)} sub="Searchable by every agent" icon={BookOpen} to="/knowledge" tone="slate" />
            <Kpi label="Agents in the making" value={formatNumber(c.openBuilderSessions)} sub="Open Agent Builder sessions" icon={WandSparkles} to="/builder" />
          </>
        )}
      </div>

      <h2 className="mt-10 mb-3 text-sm font-semibold text-fg">Ready-made use cases</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map((u) => (
          <Link
            key={u.to}
            to={u.to}
            className="group flex items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:border-brand-300 dark:hover:border-brand-400/40"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-subtle text-brand-600 transition-colors group-hover:bg-brand-50 dark:text-brand-300 dark:group-hover:bg-brand-400/15">
              <u.icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-fg">{u.label}</span>
              <span className="block truncate text-xs text-muted">{u.description}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>

      <div className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <CardHeader
            title="Recent runs"
            icon={CirclePlay}
            actions={
              <ButtonLink to="/runs" size="xs" variant="ghost" iconRight={ArrowRight}>
                All runs
              </ButtonLink>
            }
          />
          {isLoading && <Skeleton className="m-4 h-40" />}
          {data && (
            <RunsTable
              runs={data.recentRuns}
              empty={
                <EmptyState
                  compact
                  className="m-4"
                  icon={CirclePlay}
                  title="No runs yet"
                  description="Open an agent's app and run it, or send a test email to a mailbox an agent listens to."
                  action={
                    <ButtonLink to="/agents" size="sm" variant="secondary">
                      Go to agents
                    </ButtonLink>
                  }
                />
              }
            />
          )}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader
            title="Recent activity"
            actions={
              <ButtonLink to="/activity" size="xs" variant="ghost" iconRight={ArrowRight}>
                Audit log
              </ButtonLink>
            }
          />
          {isLoading && <Skeleton className="m-4 h-40" />}
          {data && data.recentActivity.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted">Nothing has happened yet.</p>}
          {data && data.recentActivity.length > 0 && (
            <ul className="divide-y divide-line">
              {data.recentActivity.map((a) => {
                const Icon = activityIcon(a.action);
                return (
                  <li key={a.id} className="flex gap-3 px-5 py-3">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-fg">{a.summary}</p>
                      <p className="mt-0.5 truncate text-xs text-faint">
                        {a.actor} · {timeAgo(a.createdAt)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
