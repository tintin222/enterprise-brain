import { ArrowRight, LibraryBig, MessageSquareText, UserPlus, WandSparkles } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { StatusPill } from "../../components/Badge.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { timeAgo } from "../../lib/format.ts";
import { archetypeIcon } from "../../lib/icons.tsx";
import { archetypeLabel } from "../../lib/labels.ts";
import { useBuilderSessions, useCatalog } from "../../lib/queries.ts";

/** Jobs being described in the Studio, newest first. */
function StudioInterviews() {
  const { data, isLoading, error, refetch } = useBuilderSessions();
  const navigate = useNavigate();
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-32" />;
  if (!data?.length) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong px-5 py-6 text-center text-sm text-muted">
        No interviews yet. The first one takes about ten minutes.
      </p>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {data.map((s) => {
          const Icon = archetypeIcon(s.archetype);
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => navigate(`/hire/studio/${s.id}`)}
                className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-subtle/60"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-fg">{s.title}</span>
                    <StatusPill status={s.status} size="xs" />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {archetypeLabel(s.archetype)}
                    {s.requesterName ? ` · ${s.requesterName}${s.requesterRole ? ` (${s.requesterRole})` : ""}` : ""}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-faint sm:block">{timeAgo(s.updatedAt)}</span>
                <ArrowRight className="size-4 shrink-0 text-faint" />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Choice({ to, icon: Icon, title, description, cta }: { to: string; icon: typeof UserPlus; title: string; description: string; cta: string }) {
  return (
    <Link
      to={to}
      className="group flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-xs transition-colors hover:border-brand-300 dark:hover:border-brand-400/40"
    >
      <span className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-fg">{title}</h2>
      <p className="mt-1 flex-1 text-sm text-muted">{description}</p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 dark:text-brand-300">
        {cta} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export default function Hire() {
  const catalog = useCatalog();
  const readyMade = catalog.data?.agents.length;
  return (
    <Page>
      <PageHeader
        icon={UserPlus}
        title="Hire"
        description="Hire an AI employee for your department: describe the job in the Studio, or start from a ready-made one and adapt it."
      />
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Choice
          to="/hire/studio/new"
          icon={WandSparkles}
          title="Describe the job in the Studio"
          description="An analyst interviews you about the work, your systems and your rules, asks IT for access, tries it on your samples, and writes its job description as you answer."
          cta="Start an interview"
        />
        <Choice
          to="/hire/ready-made"
          icon={LibraryBig}
          title="Ready-made AI employees"
          description={`${readyMade ? `${readyMade} AI employees` : "AI employees"} for finance, HR, sales, procurement and more, ready to adapt to how you work.`}
          cta="Browse"
        />
      </div>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
        <MessageSquareText className="size-4 text-muted" /> Interviews in the Studio
      </h2>
      <StudioInterviews />
    </Page>
  );
}
