import { ArrowRight, LibraryBig, MessageSquareText, Rocket, UserPlus, WandSparkles } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { StatusPill } from "../../components/Badge.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { NeedBox } from "../../components/NeedBox.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useIsManager } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { archetypeIcon } from "../../lib/icons.tsx";
import { archetypeLabel } from "../../lib/labels.ts";
import { paths } from "../../lib/paths.ts";
import { useBuilderSessions, useCatalog, useStudioThreads } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";

/** Conversations with the Studio agent, newest first. */
function StudioConversations() {
  const { data, isLoading, error, refetch } = useStudioThreads();
  const navigate = useNavigate();
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-24" />;
  if (!data?.length) {
    return <p className="rounded-xl border border-dashed border-line-strong px-5 py-6 text-center text-sm text-muted">No conversations yet.</p>;
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {data.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => navigate(paths.studioConversation(t.id))}
              className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-subtle/60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                {t.builtAt ? <Rocket className="size-4" /> : <WandSparkles className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-fg">{t.title}</span>
                  <StatusPill
                    status={t.builtAt ? "active" : t.status === "working" ? "running" : t.status === "asking" ? "waiting" : t.status}
                    label={
                      t.builtAt
                        ? "At work"
                        : t.status === "working"
                          ? "Working"
                          : t.status === "asking"
                            ? "Waiting for you"
                            : t.status === "idle"
                              ? "In progress"
                              : undefined
                    }
                    size="xs"
                  />
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {t.owner} · {t.parts ? `${t.parts} part${t.parts === 1 ? "" : "s"}` : "nothing built yet"}
                </span>
              </span>
              <span className="hidden shrink-0 text-xs text-faint sm:block">{timeAgo(t.updatedAt)}</span>
              <ArrowRight className="size-4 shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Jobs being described in a guided interview, newest first. */
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
                onClick={() => navigate(paths.interview(s.id))}
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

/**
 * The Studio's start: one box for what to build or change, and the ways to build an AI employee (the Studio
 * agent, a guided interview, a ready-made one), with the work in progress.
 */
export default function StudioHome() {
  useDocumentTitle(null);
  const catalog = useCatalog();
  const { info } = useCompany();
  const manager = useIsManager();
  const interviews = useBuilderSessions({ enabled: manager });
  const readyMade = catalog.data?.agents.length;
  const agent = info.llm.available;
  return (
    <Page>
      <PageHeader
        icon={WandSparkles}
        title="Studio"
        description="Design AI employees, build the tables and apps your departments keep, and look after the company brain. The work itself happens in Operations."
      />
      <NeedBox className="mb-8" />
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {manager && agent && (
          <Choice
            to={paths.studioConversation("new")}
            icon={WandSparkles}
            title="Describe it to the Studio agent"
            description="It looks at your mailboxes and systems, asks what only you can say, builds the AI employees, tables and screens, and tries them on real examples."
            cta="Start a conversation"
          />
        )}
        {manager && (
          <Choice
            to={paths.interview("new")}
            icon={MessageSquareText}
            title={agent ? "A guided interview" : "Describe the job in an interview"}
            description="Question by question, for one AI employee: the work, your systems and your rules. It also works without Claude."
            cta="Start an interview"
          />
        )}
        <Choice
          to={paths.readyMade()}
          icon={LibraryBig}
          title="Ready-made AI employees"
          description={`${readyMade ? `${readyMade} AI employees` : "AI employees"} for finance, HR, sales, procurement and more, ready to adapt to how you work.`}
          cta="Browse"
        />
      </div>
      {!manager && (
        <p className="mb-10 rounded-xl border border-line bg-subtle/50 px-5 py-4 text-sm text-muted">
          Managers build AI employees here. You can see how each one is set up under <span className="font-medium text-fg">AI employees</span>, browse and add
          to the company brain, and build tables and apps where your company allows it.
        </p>
      )}
      {manager && agent && (
        <>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
            <WandSparkles className="size-4 text-muted" /> Conversations with the Studio agent
          </h2>
          <div className="mb-10">
            <StudioConversations />
          </div>
        </>
      )}
      {manager && (!agent || Boolean(interviews.data?.length)) && (
        <>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
            <MessageSquareText className="size-4 text-muted" /> Guided interviews
          </h2>
          <StudioInterviews />
        </>
      )}
    </Page>
  );
}
