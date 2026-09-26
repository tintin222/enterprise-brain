import { clsx } from "clsx";
import { Bot, Building2, Gauge, Lock, UserPlus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { PROBATION } from "../../components/Employment.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { initials } from "../../lib/format.ts";
import { namedIcon } from "../../lib/icons.tsx";
import { useAgents, useDepartments, usePeople } from "../../lib/queries.ts";
import type { AgentRow, Person } from "../../types.ts";

function PersonRow({ person, role }: { person: Person; role?: string }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-muted">{initials(person.name)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{person.name}</p>
        <p className="truncate text-xs text-muted">{person.title ?? person.email}</p>
      </div>
      {role === "manager" && (
        <Badge size="xs" tone="brand">
          Manager
        </Badge>
      )}
    </li>
  );
}

function AiRow({ agent, manager }: { agent: AgentRow; manager?: string }) {
  const probation = agent.probation ? PROBATION[agent.probation].label : null;
  return (
    <li>
      <Link to={`/ai/${agent.slug}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle/70">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{agent.name}</p>
          <p className="truncate text-xs text-muted">{[agent.title, manager ? `manager: ${manager}` : null, probation].filter(Boolean).join(" · ")}</p>
        </div>
        <StatusPill status={agent.status} size="xs" />
      </Link>
    </li>
  );
}

function Column({ title, icon: Icon, count, children, empty }: { title: string; icon: typeof Users; count: number; children: ReactNode; empty: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        <Icon className="size-3.5" /> {title} <span className="font-normal tabular-nums">({count})</span>
      </p>
      {count ? <ul className="divide-y divide-line/70">{children}</ul> : <p className="py-2 text-sm text-faint">{empty}</p>}
    </div>
  );
}

export default function Company() {
  const viewer = useViewer();
  const departments = useDepartments();
  const agents = useAgents();
  const people = usePeople();
  const personName = new Map((people.data ?? []).map((p) => [p.id, p.name]));
  const live = (agents.data ?? []).filter((a) => a.status !== "archived");
  const companyWide = live.filter((a) => !a.departmentId);
  const isManager = !viewer || viewer.isAdmin || viewer.departments.some((d) => d.role === "manager");
  const mine = new Set(viewer?.departments.map((d) => d.id) ?? []);
  const sorted = [...(departments.data ?? [])].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || a.name.localeCompare(b.name));
  const loading = departments.isLoading || agents.isLoading;

  return (
    <Page>
      <PageHeader
        icon={Building2}
        title="Company"
        description="Departments, with their people and AI employees. Open an AI employee to see its work, duties and rules."
        actions={
          <>
            {viewer?.isAdmin && (
              <ButtonLink to="/settings/people" icon={Users}>
                People and roles
              </ButtonLink>
            )}
            {isManager && (
              <ButtonLink to="/company/performance" icon={Gauge}>
                Performance
              </ButtonLink>
            )}
            {isManager && (
              <ButtonLink to="/hire" variant="primary" icon={UserPlus}>
                Hire an AI employee
              </ButtonLink>
            )}
          </>
        }
      />
      {(departments.error || agents.error) && <ErrorState error={departments.error ?? agents.error} onRetry={() => void departments.refetch()} />}
      {loading && (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}
      {departments.data && departments.data.length === 0 && companyWide.length === 0 && (
        <EmptyState
          icon={Building2}
          title="No departments yet"
          description="Add a ready-made department to get its processes and AI employees in one step, then add its people."
          action={
            isManager ? (
              <ButtonLink to="/hire/ready-made" variant="primary">
                Ready-made departments
              </ButtonLink>
            ) : undefined
          }
        />
      )}
      <div className="space-y-5">
        {sorted.map((d) => {
          const Icon = namedIcon(d.icon ?? d.data.icon);
          const members = (people.data ?? [])
            .map((p) => ({ person: p, role: p.departments.find((m) => m.departmentId === d.id)?.role }))
            .filter((m) => m.role)
            .sort((a, b) => Number(b.role === "manager") - Number(a.role === "manager") || a.person.name.localeCompare(b.person.name));
          const ais = live.filter((a) => a.departmentId === d.id).sort((a, b) => a.name.localeCompare(b.name));
          const visible = d.visible !== false;
          return (
            <Card key={d.id} id={`department-${d.key}`} className="overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className={clsx(
                      "flex size-10 shrink-0 items-center justify-center rounded-xl",
                      visible ? "bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300" : "bg-subtle text-faint",
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
                      {d.name}
                      {mine.has(d.id) && (
                        <Badge size="xs" tone="brand">
                          Yours
                        </Badge>
                      )}
                    </h2>
                    <p className="line-clamp-1 text-[13px] text-muted">{d.summary}</p>
                  </div>
                </div>
              </div>
              {visible ? (
                <div className="grid grid-cols-1 gap-6 px-5 py-4 md:grid-cols-2">
                  <Column title="AI employees" icon={Bot} count={ais.length} empty="No AI employees yet.">
                    {ais.map((a) => (
                      <AiRow key={a.id} agent={a} manager={a.managerUserId ? personName.get(a.managerUserId) : undefined} />
                    ))}
                  </Column>
                  <Column title="People" icon={Users} count={members.length} empty={viewer?.isAdmin ? "Nobody yet: add people in Settings." : "Nobody yet."}>
                    {members.map((m) => (
                      <PersonRow key={m.person.id} person={m.person} role={m.role} />
                    ))}
                  </Column>
                </div>
              ) : (
                <p className="flex items-center gap-2 px-5 py-3 text-sm text-muted">
                  <Lock className="size-4 shrink-0" /> Only the people of {d.name} see its AI employees and work.
                </p>
              )}
            </Card>
          );
        })}
        {companyWide.length > 0 && (
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold text-fg">Company-wide</h2>
              <p className="text-[13px] text-muted">AI employees that serve everyone.</p>
            </div>
            <div className="px-5 py-3">
              <ul className="divide-y divide-line/70 md:w-1/2 md:pr-3">
                {companyWide.map((a) => (
                  <AiRow key={a.id} agent={a} manager={a.managerUserId ? personName.get(a.managerUserId) : undefined} />
                ))}
              </ul>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
