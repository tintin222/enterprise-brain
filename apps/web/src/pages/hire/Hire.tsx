import { useMutation } from "@tanstack/react-query";
import { ArrowRight, LibraryBig, MessageSquareText, Rocket, UserPlus, WandSparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api.ts";
import { StatusPill } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { archetypeIcon } from "../../lib/icons.tsx";
import { archetypeLabel } from "../../lib/labels.ts";
import { useBuilderSessions, useCatalog, useDepartments, useStudioThreads } from "../../lib/queries.ts";
import type { StudioThreadView } from "../../types.ts";

/** Tell the Studio what you need: it looks around, asks what only you can say, builds and tries it. */
function StudioStart() {
  const { path } = useCompany();
  const navigate = useNavigate();
  const viewer = useViewer();
  const departments = useDepartments();
  const [text, setText] = useState("");
  const hiresFor = (departments.data ?? []).filter((d) => !viewer || viewer.isAdmin || viewer.departments.some((m) => m.id === d.id && m.role === "manager"));
  const [department, setDepartment] = useState("");
  const chosen = department || (hiresFor.length === 1 ? hiresFor[0]!.id : "");
  const start = useMutation({
    mutationFn: () => api.post<StudioThreadView>(path("/studio/threads"), { text: text.trim(), departmentId: chosen || null }),
    onSuccess: (view) => navigate(`/studio/${view.id}`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) start.mutate();
  };
  return (
    <form onSubmit={submit} className="mb-10 rounded-2xl border border-line bg-surface p-5 shadow-xs sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
          <WandSparkles className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">Tell the Studio what you need</h2>
          <p className="mt-0.5 text-sm text-muted">
            In your own words: where the work comes from, what should happen with it, who is involved. The Studio looks at your mailboxes and systems, asks what
            only you can say, builds the AI employees, tables and screens, and tries them on real examples before anything goes to work.
          </p>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="e.g. Supplier complaints come to quality@. I want each one handled: logged, the supplier asked for an 8D report, and followed up until it's closed."
        aria-label="What you need"
        className="input mt-4 w-full resize-y"
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {hiresFor.length > 1 && (
          <select className="input h-9 w-auto py-1.5" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="For which department">
            <option value="">For which department?</option>
            {hiresFor.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" variant="primary" icon={ArrowRight} loading={start.isPending} disabled={!text.trim()}>
          Start
        </Button>
      </div>
      {start.error && <ErrorState error={start.error} className="mt-3" />}
    </form>
  );
}

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
              onClick={() => navigate(`/studio/${t.id}`)}
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
  const { info } = useCompany();
  const interviews = useBuilderSessions();
  const readyMade = catalog.data?.agents.length;
  const agent = info.llm.available;
  return (
    <Page>
      <PageHeader
        icon={UserPlus}
        title="Hire"
        description="Build what your department needs with the Studio, or start from a ready-made AI employee and adapt it."
      />
      {agent && <StudioStart />}
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        {!agent && (
          <Choice
            to="/hire/studio/new"
            icon={WandSparkles}
            title="Describe the job in the Studio"
            description="An analyst interviews you about the work, your systems and your rules, asks IT for access, tries it on your samples, and writes its job description as you answer."
            cta="Start an interview"
          />
        )}
        <Choice
          to="/hire/ready-made"
          icon={LibraryBig}
          title="Ready-made AI employees"
          description={`${readyMade ? `${readyMade} AI employees` : "AI employees"} for finance, HR, sales, procurement and more, ready to adapt to how you work.`}
          cta="Browse"
        />
        {agent && (
          <Choice
            to="/hire/studio/new"
            icon={MessageSquareText}
            title="A guided interview"
            description="Question by question, for one AI employee: the Studio's interview from before, which also works without Claude."
            cta="Start an interview"
          />
        )}
      </div>
      {agent && (
        <>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
            <WandSparkles className="size-4 text-muted" /> Conversations in the Studio
          </h2>
          <div className="mb-10">
            <StudioConversations />
          </div>
        </>
      )}
      {(!agent || Boolean(interviews.data?.length)) && (
        <>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
            <MessageSquareText className="size-4 text-muted" /> {agent ? "Guided interviews" : "Interviews in the Studio"}
          </h2>
          <StudioInterviews />
        </>
      )}
    </Page>
  );
}
