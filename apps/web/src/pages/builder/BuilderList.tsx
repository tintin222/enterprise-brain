import { ArrowRight, Plus, Sparkles, WandSparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { StatusPill } from "../../components/Badge.tsx";
import { ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { timeAgo } from "../../lib/format.ts";
import { archetypeIcon } from "../../lib/icons.tsx";
import { archetypeLabel } from "../../lib/labels.ts";
import { useBuilderSessions } from "../../lib/queries.ts";

export default function BuilderList() {
  const { data, isLoading, error, refetch } = useBuilderSessions();
  const navigate = useNavigate();
  return (
    <Page>
      <PageHeader
        icon={WandSparkles}
        title="Agent Builder"
        description="Describe the agent you need in plain words. An AI requirements analyst interviews you, involves the right people, and builds, tests and deploys the agent with its own screen."
        actions={
          <ButtonLink to="/builder/new" variant="primary" icon={Plus}>
            New agent
          </ButtonLink>
        }
      />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title="No agents in the making yet"
          description="Start by describing a task your team repeats every week — screening CVs, processing invoices, answering the same emails. The analyst takes it from there."
          action={
            <ButtonLink to="/builder/new" variant="primary" icon={WandSparkles}>
              Describe your first agent
            </ButtonLink>
          }
        />
      )}
      {data && data.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {data.map((s) => {
              const Icon = archetypeIcon(s.archetype);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/builder/${s.id}`)}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-subtle/60"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-fg">{s.title}</span>
                        <StatusPill status={s.status} size="xs" />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {archetypeLabel(s.archetype)}
                        {s.requesterName ? ` · requested by ${s.requesterName}${s.requesterRole ? ` (${s.requesterRole})` : ""}` : ""}
                        {s.templateId ? ` · from template ${s.templateId}` : ""}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs text-faint sm:block">Updated {timeAgo(s.updatedAt)}</span>
                    <ArrowRight className="size-4 shrink-0 text-faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Page>
  );
}
