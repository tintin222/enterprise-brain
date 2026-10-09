import { Bot, LibraryBig, Lock, UserPlus } from "lucide-react";
import { Badge } from "../../components/Badge.tsx";
import { ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useIsManager, useViewer } from "../../lib/auth.tsx";
import { namedIcon } from "../../lib/icons.tsx";
import { paths } from "../../lib/paths.ts";
import { useAgents, useDepartments, usePeople } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { AiRow } from "../company/Company.tsx";

/** The Studio's AI employees: how each is set up (its job, duties, access, rules, coaching and versions), by department. */
export default function AiEmployees() {
  useDocumentTitle("AI employees");
  const viewer = useViewer();
  const manager = useIsManager();
  const departments = useDepartments();
  const agents = useAgents();
  const people = usePeople();
  const personName = new Map((people.data ?? []).map((p) => [p.id, p.name]));
  const live = (agents.data ?? []).filter((a) => a.status !== "archived");
  const mine = new Set(viewer?.departments.map((d) => d.id) ?? []);
  const sorted = [...(departments.data ?? [])].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || a.name.localeCompare(b.name));
  const companyWide = live.filter((a) => !a.departmentId);
  const loading = departments.isLoading || agents.isLoading;
  const row = (a: (typeof live)[number]) => (
    <AiRow key={a.id} agent={a} manager={a.managerUserId ? personName.get(a.managerUserId) : undefined} to={paths.ai(a.slug, "studio")} />
  );
  return (
    <Page>
      <PageHeader
        icon={Bot}
        title="AI employees"
        description="How each AI employee is set up: its job, duties, access, rules, coaching and versions. Their work and results are in Operations."
        actions={
          manager ? (
            <>
              <ButtonLink to={paths.readyMade()} icon={LibraryBig}>
                Ready-made
              </ButtonLink>
              <ButtonLink to={paths.home("studio")} variant="primary" icon={UserPlus}>
                New AI employee
              </ButtonLink>
            </>
          ) : undefined
        }
      />
      {(departments.error || agents.error) && <ErrorState error={departments.error ?? agents.error} onRetry={() => void agents.refetch()} />}
      {loading && <Skeleton className="h-44" />}
      {!loading && live.length === 0 && (
        <EmptyState
          icon={Bot}
          title="No AI employees yet"
          description="Build one with the Studio, or start from a ready-made one and adapt it."
          action={
            manager ? (
              <ButtonLink to={paths.home("studio")} variant="primary">
                Studio home
              </ButtonLink>
            ) : undefined
          }
        />
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {sorted.map((d) => {
          const ais = live.filter((a) => a.departmentId === d.id).sort((a, b) => a.name.localeCompare(b.name));
          if (!ais.length && d.visible !== false) return null;
          const Icon = namedIcon(d.icon ?? d.data.icon);
          return (
            <Card key={d.id} id={`department-${d.key}`} className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  <Icon className="size-[18px]" />
                </span>
                <h2 className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-fg">
                  <span className="truncate">{d.name}</span>
                  {mine.has(d.id) && (
                    <Badge size="xs" tone="brand">
                      Yours
                    </Badge>
                  )}
                </h2>
              </div>
              {d.visible === false ? (
                <p className="flex items-center gap-2 px-5 py-3 text-sm text-muted">
                  <Lock className="size-4 shrink-0" /> Only the people of {d.name} see its AI employees.
                </p>
              ) : (
                <ul className="divide-y divide-line/70 px-5 py-2">{ais.map(row)}</ul>
              )}
            </Card>
          );
        })}
        {companyWide.length > 0 && (
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-3.5">
              <h2 className="text-base font-semibold text-fg">Company-wide</h2>
            </div>
            <ul className="divide-y divide-line/70 px-5 py-2">{companyWide.map(row)}</ul>
          </Card>
        )}
      </div>
    </Page>
  );
}
