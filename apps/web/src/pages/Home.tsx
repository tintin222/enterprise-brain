import { clsx } from "clsx";
import { ArrowRight, Bot, CircleCheck, Inbox, Send, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { StatusPill } from "../components/Badge.tsx";
import { ButtonLink } from "../components/Button.tsx";
import { Card, CardHeader } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { GiveWorkForm } from "../components/GiveWork.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { WorkItemCard } from "../components/WorkItemCard.tsx";
import { plural } from "../lib/format.ts";
import { useHome, useWork } from "../lib/queries.ts";
import { useDocumentTitle } from "../lib/title.ts";
import type { HomeData } from "../types.ts";

const SHOWN = 6;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "23 done · 4 open · 2 need you": what one AI employee did today, in a line. */
function todayLine(today: HomeData["aiEmployees"][number]["today"]): string {
  const parts = [`${today.done} done`];
  if (today.open) parts.push(`${today.open} open`);
  if (today.failed) parts.push(`${today.failed} stopped with a problem`);
  return parts.join(" · ");
}

function NeedsYou() {
  const work = useWork("mine");
  const items = work.data ?? [];
  return (
    <section aria-labelledby="needs-you">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="needs-you" className="text-base font-semibold text-fg">
          Needs you{items.length ? ` (${items.length})` : ""}
        </h2>
        {items.length > SHOWN && (
          <ButtonLink to="/work" size="xs" variant="ghost" iconRight={ArrowRight}>
            All {items.length}
          </ButtonLink>
        )}
      </div>
      {work.error && <ErrorState error={work.error} onRetry={() => void work.refetch()} />}
      {work.isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      )}
      {work.data && items.length === 0 && (
        <EmptyState
          icon={CircleCheck}
          title="Nothing needs you right now"
          description="Approvals, questions and checks from your AI employees appear here the moment they need a person."
        />
      )}
      <div className="space-y-3">
        {items.slice(0, SHOWN).map((entry) => (
          <WorkItemCard key={`${entry.type}-${entry.id}`} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function AiEmployeesToday({ home }: { home: HomeData }) {
  return (
    <Card>
      <CardHeader title="Your AI employees today" icon={Bot} />
      {home.aiEmployees.length === 0 ? (
        <div className="p-4">
          <EmptyState
            compact
            icon={Bot}
            title="No AI employees yet"
            description={
              home.person.isManager ? "Hire one in the Studio, or pick a ready-made one." : "When your department hires one, you'll see its work here."
            }
            action={
              home.person.isManager ? (
                <ButtonLink to="/hire" size="sm" variant="primary" icon={UserPlus}>
                  Hire
                </ButtonLink>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {home.aiEmployees.map((ai) => (
            <li key={ai.id}>
              <Link to={`/ai/${ai.slug}`} className="flex items-center gap-3 px-5 py-3 hover:bg-subtle/60">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                  <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-fg">
                    <span className="truncate">{ai.name}</span>
                    {ai.status !== "active" && <StatusPill status={ai.status} size="xs" />}
                  </p>
                  <p className="truncate text-xs text-muted">{todayLine(ai.today)}</p>
                </div>
                {ai.today.needsPerson > 0 && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-300">
                    {ai.today.needsPerson} need{ai.today.needsPerson === 1 ? "s" : ""} you
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Home() {
  useDocumentTitle("Home");
  const home = useHome();
  const data = home.data;
  const waiting = useWork("mine").data?.length ?? 0;
  return (
    <Page>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
          {greeting()}
          {data ? `, ${firstName(data.person.name)}` : ""}
          {data?.person.departments.length ? <span className="font-normal text-muted"> · {data.person.departments.join(", ")}</span> : null}
        </h1>
        <p className={clsx("mt-1 text-sm", waiting ? "text-amber-700 dark:text-amber-300" : "text-muted")}>
          {waiting ? `${plural(waiting, "thing")} waiting for you.` : "Your AI employees are on it."}
        </p>
      </div>
      {home.error && <ErrorState error={home.error} onRetry={() => void home.refetch()} />}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <NeedsYou />
        <div className="space-y-6">
          {data ? <AiEmployeesToday home={data} /> : home.isLoading && <Skeleton className="h-56" />}
          <Card>
            <CardHeader title="Give work to an AI employee" icon={Send} subtitle="Say what you need, as you would to a colleague." />
            <div className="px-5 py-4">
              <GiveWorkForm compact />
            </div>
          </Card>
          {data?.aiMailbox && data.aiEmployees.length > 0 && (
            <p className="flex items-start gap-2 px-1 text-xs text-muted">
              <Inbox className="mt-px size-3.5 shrink-0" />
              <span>
                Or forward an email to <span className="font-medium text-fg">{data.aiMailbox}</span> and start its subject with the AI employee's name, such as
                “{data.aiEmployees[0]!.name}: …”. It becomes a task too.
              </span>
            </p>
          )}
        </div>
      </div>
    </Page>
  );
}
