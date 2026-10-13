import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, Link2, MessageSquareText, Rocket, WandSparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useIsManager } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { paths } from "../../lib/paths.ts";
import { keys, useBuilderSessions, useProjectDesigns, useStudioThreads } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ProjectView } from "../../types.ts";

/** Puts one of the viewer's own Studio conversations or interviews into the project. */
function AttachDialog({ project, open, onClose, taken }: { project: ProjectView; open: boolean; onClose: () => void; taken: Set<string> }) {
  const { company, info, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const threads = useStudioThreads({ enabled: open && info.llm.available });
  const interviews = useBuilderSessions({ enabled: open });
  const attach = useMutation({
    mutationFn: (design: { kind: "thread" | "interview"; id: string }) => api.post(path(`/projects/${project.id}/designs`), design),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.project(company, project.id) }),
        queryClient.invalidateQueries({ queryKey: keys.project(company, project.slug) }),
      ]);
      toast.success("Attached");
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const freeThreads = (threads.data ?? []).filter((t) => !taken.has(t.id));
  const freeInterviews = (interviews.data ?? []).filter((s) => !taken.has(s.id));
  return (
    <Dialog open={open} onClose={onClose} title="Attach a design" description="One of your Studio conversations or interviews that belongs to this project.">
      {freeThreads.length === 0 && freeInterviews.length === 0 ? (
        <p className="text-sm text-muted">Nothing to attach: every design of yours is already in a project, or there is none yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {freeThreads.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <WandSparkles className="size-4 shrink-0 text-muted" />
                <span className="truncate">{t.title}</span>
              </span>
              <Button size="xs" loading={attach.isPending} onClick={() => attach.mutate({ kind: "thread", id: t.id })}>
                Attach
              </Button>
            </li>
          ))}
          {freeInterviews.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <MessageSquareText className="size-4 shrink-0 text-muted" />
                <span className="truncate">{s.title}</span>
              </span>
              <Button size="xs" loading={attach.isPending} onClick={() => attach.mutate({ kind: "interview", id: s.id })}>
                Attach
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** The designs made in the project: Studio conversations, interviews and the AI employees they made. */
export function DesignsTab({ project }: { project: ProjectView }) {
  const { info } = useCompany();
  const manager = useIsManager();
  const designs = useProjectDesigns(project.id);
  const [attaching, setAttaching] = useState(false);
  const data = designs.data;
  const taken = new Set([...(data?.threads ?? []).map((t) => t.id), ...(data?.interviews ?? []).map((i) => i.id)]);
  const empty = data && data.threads.length === 0 && data.interviews.length === 0 && data.agents.length === 0;
  return (
    <div className="space-y-6">
      {manager && (
        <div className="flex flex-wrap gap-2">
          {info.llm.available && (
            <ButtonLink to={paths.studioConversation("new", { project: project.id })} variant="primary" icon={WandSparkles}>
              New design with the Studio agent
            </ButtonLink>
          )}
          <ButtonLink to={paths.interview("new", { project: project.id })} icon={MessageSquareText}>
            New guided interview
          </ButtonLink>
          {project.canEdit && (
            <Button icon={Link2} onClick={() => setAttaching(true)}>
              Attach an existing one
            </Button>
          )}
        </div>
      )}
      {designs.error && <ErrorState error={designs.error} onRetry={() => void designs.refetch()} />}
      {designs.isLoading && <Skeleton className="h-32" />}
      {empty && (
        <EmptyState
          icon={WandSparkles}
          title="No designs yet"
          description="Start a design here: the Studio agent knows the project and what it uses, adds what it finds in the brain to it, and leaves you tasks for what only you can do."
        />
      )}
      {data && data.threads.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Conversations with the Studio agent" icon={WandSparkles} />
          <ul className="divide-y divide-line">
            {data.threads.map((t) => (
              <li key={t.id} className="flex items-center gap-4 px-5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  {t.builtAt ? <Rocket className="size-4" /> : <WandSparkles className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {t.canOpen ? (
                      <Link to={paths.studioConversation(t.id)} className="truncate text-sm font-semibold text-fg hover:underline">
                        {t.title}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-semibold text-fg">{t.title}</span>
                    )}
                    <StatusPill
                      status={t.builtAt ? "active" : t.status === "asking" ? "waiting" : t.status}
                      label={t.builtAt ? "At work" : undefined}
                      size="xs"
                    />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {t.owner} · {t.agentIds.length ? `${t.agentIds.length} AI employee${t.agentIds.length === 1 ? "" : "s"}` : "nothing saved yet"}
                    {t.canOpen ? "" : " · theirs to open"}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-faint sm:block">{timeAgo(t.updatedAt)}</span>
                {t.canOpen && <ArrowRight className="size-4 shrink-0 text-faint" />}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data && data.interviews.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Guided interviews" icon={MessageSquareText} />
          <ul className="divide-y divide-line">
            {data.interviews.map((s) => (
              <li key={s.id} className="flex items-center gap-4 px-5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  <MessageSquareText className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {s.canOpen ? (
                      <Link to={paths.interview(s.id)} className="truncate text-sm font-semibold text-fg hover:underline">
                        {s.title}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-semibold text-fg">{s.title}</span>
                    )}
                    <StatusPill status={s.status} size="xs" />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {s.requesterEmail ?? "A manager"}
                    {s.canOpen ? "" : " · theirs to open"}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-faint sm:block">{timeAgo(s.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data && data.agents.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="AI employees" icon={Bot} subtitle="Made here, or attached as a model" />
          <ul className="divide-y divide-line">
            {data.agents.map((a) => (
              <li key={a.id} className="flex items-center gap-4 px-5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
                  <Bot className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link to={paths.ai(a.slug, "studio")} className="truncate text-sm font-semibold text-fg hover:underline">
                      {a.name}
                    </Link>
                    <StatusPill status={a.status} size="xs" />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {a.from === "studio" ? "Designed with the Studio agent" : a.from === "interview" ? "Designed in an interview" : "Attached"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AttachDialog project={project} open={attaching} onClose={() => setAttaching(false)} taken={taken} />
    </div>
  );
}
