import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  Ban,
  CircleCheck,
  CirclePlay,
  Clock,
  CornerDownLeft,
  ExternalLink,
  ListChecks,
  Mail,
  MessageSquareText,
  Pause,
  Play,
  RotateCcw,
  Send,
  Square,
  TriangleAlert,
  UserCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, isApiError } from "../../api.ts";
import { StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { JsonDetails } from "../../components/JsonView.tsx";
import { Page } from "../../components/Layout.tsx";
import { Callout, ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { fromText, timeUntil, waitingText } from "../../components/TaskList.tsx";
import { Timeline, type TimelineItem } from "../../components/Timeline.tsx";
import { WorkItemCard } from "../../components/WorkItemCard.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDateTime, formatMoney, isRecord, runDuration, timeAgo } from "../../lib/format.ts";
import { runTriggerLabel } from "../../lib/labels.ts";
import { keys, useTask, useWork } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import { useDocumentTitle } from "../../lib/title.ts";
import type { TaskDetail, TaskEvent, TaskRow } from "../../types.ts";

const EVENT: Record<string, { icon: LucideIcon; tone: TimelineItem["tone"] }> = {
  created: { icon: CirclePlay, tone: "brand" },
  note: { icon: MessageSquareText, tone: "neutral" },
  waiting: { icon: Clock, tone: "blue" },
  woke: { icon: AlarmClock, tone: "blue" },
  email: { icon: Mail, tone: "neutral" },
  asked: { icon: UserRound, tone: "amber" },
  needs_person: { icon: UserRound, tone: "amber" },
  answered: { icon: UserCheck, tone: "green" },
  decided: { icon: UserCheck, tone: "green" },
  checked: { icon: UserCheck, tone: "green" },
  handled: { icon: UserCheck, tone: "green" },
  blocked: { icon: Ban, tone: "red" },
  paused: { icon: Pause, tone: "neutral" },
  resumed: { icon: Play, tone: "brand" },
  stopped: { icon: Square, tone: "neutral" },
  retried: { icon: RotateCcw, tone: "brand" },
  done: { icon: CircleCheck, tone: "green" },
  failed: { icon: TriangleAlert, tone: "red" },
  warning: { icon: TriangleAlert, tone: "amber" },
};

/** "Elif Arslan <elif@…>" → "Elif Arslan"; the AI employee's own steps show its name. */
function actorName(actor: string, agentName: string): string | null {
  if (actor === "agent" || actor.startsWith("agent:")) return agentName;
  if (actor === "system" || actor === "scheduler") return null;
  return actor.replace(/\s*<.*>$/, "");
}

function eventItem(event: TaskEvent, agentName: string): TimelineItem {
  const meta = EVENT[event.type] ?? { icon: MessageSquareText, tone: "neutral" as const };
  const who = actorName(event.actor, agentName);
  return {
    id: event.id,
    icon: meta.icon,
    tone: meta.tone,
    title: event.message,
    meta: who ?? undefined,
    time: <span title={formatDateTime(event.createdAt)}>{timeAgo(event.createdAt)}</span>,
  };
}

/** What the person asked, or what started the task: its text, or its input fields. */
function Request({ task }: { task: TaskRow }) {
  const input = task.input ?? {};
  const textKey = ["request", "task", "text"].find((key) => typeof input[key] === "string");
  const text = textKey ? (input[textKey] as string) : null;
  const email = isRecord(input.email) ? input.email : null;
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== textKey && key !== "email"));
  if (!text && !email && Object.keys(rest).length === 0) return null;
  return (
    <Card>
      <CardHeader title="What it was asked" icon={CornerDownLeft} subtitle={`${fromText(task)} · ${formatDateTime(task.createdAt)}`} />
      <div className="space-y-3 px-5 py-4 text-sm">
        {text && <p className="whitespace-pre-wrap text-fg">{text}</p>}
        {email && (
          <div className="rounded-lg border border-line px-3 py-2.5">
            <p className="font-medium text-fg">{String(email.subject ?? "(no subject)")}</p>
            <p className="text-xs text-muted">from {String(email.from ?? "?")}</p>
            {typeof email.body === "string" && <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-[13px] text-fg/90">{email.body}</p>}
          </div>
        )}
        {Object.keys(rest).length > 0 && <JsonDetails data={rest} label="Details" />}
      </div>
    </Card>
  );
}

function Emails({ mails }: { mails: TaskDetail["mails"] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!mails.length) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Emails" icon={Mail} subtitle="Sent and received for this task." />
      <ul className="divide-y divide-line">
        {mails.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-subtle/60"
              onClick={() => setOpen(open === m.id ? null : m.id)}
              aria-expanded={open === m.id}
            >
              {m.direction === "outbound" ? (
                <Send className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-300" />
              ) : (
                <Mail className="mt-0.5 size-4 shrink-0 text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{m.subject || "(no subject)"}</p>
                <p className="truncate text-xs text-muted">{m.direction === "outbound" ? `to ${m.to.join(", ")}` : `from ${m.from}`}</p>
              </div>
              <span className="shrink-0 text-xs text-faint">{timeAgo(m.receivedAt)}</span>
            </button>
            {open === m.id && (
              <div className="border-t border-line bg-subtle/30 px-5 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{m.body}</div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function useTaskAction(ref: string) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (action: "pause" | "resume" | "stop" | "retry") => api.post<TaskRow>(path(`/tasks/${encodeURIComponent(ref)}/${action}`), {}),
    onSuccess: (_, action) => {
      for (const key of [keys.tasks(company), keys.work(company), keys.home(company)]) void queryClient.invalidateQueries({ queryKey: key });
      toast.success(
        { pause: "Paused: it holds at its next step", resume: "Resumed", stop: "Stopped", retry: "Trying again from the step that failed" }[action],
      );
    },
    onError: (error) => toast.error(error),
  });
}

export default function TaskPage() {
  const { ref = "" } = useParams();
  const { data, isLoading, error, refetch } = useTask(ref);
  useDocumentTitle(data ? `${data.task.ref} ${data.task.title}` : ref);
  const work = useWork("all");
  const act = useTaskAction(ref);
  const [confirmStop, setConfirmStop] = useState(false);

  if (isLoading) return <LoadingBlock className="flex-1" />;
  if (isApiError(error, 404)) {
    return (
      <Page>
        <EmptyState
          icon={ListChecks}
          title={`No task ${ref}`}
          description="It doesn't exist, or its AI employee works in a department you are not part of."
          action={
            <ButtonLink to="/work?view=tasks" variant="primary">
              All tasks
            </ButtonLink>
          }
        />
      </Page>
    );
  }
  if (error || !data) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Page>
    );
  }

  const { task, agent, events, runs, mails, canManage } = data;
  const open = ["working", "waiting", "needs_person", "paused"].includes(task.status);
  const pending = (work.data ?? []).filter((w) => w.task?.ref === task.ref);
  const waiting = waitingText(task);
  const cost = runs.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
  const busy = act.isPending;

  return (
    <Page className="max-w-5xl">
      <div className="mb-2 text-sm">
        <Link to="/work?view=tasks" className="text-muted hover:text-fg">
          Work
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <span className="font-mono text-[13px] text-fg">{task.ref}</span>
      </div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words text-fg sm:text-2xl">{task.title}</h1>
            <StatusPill status={task.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link to={`/ai/${agent.slug}`} className="font-medium text-fg/90 hover:underline">
              {agent.name}
            </Link>
            {" · "}
            {fromText(task)}
            {" · started "}
            <span title={formatDateTime(task.createdAt)}>{timeAgo(task.createdAt)}</span>
            {task.closedAt && ` · closed ${timeAgo(task.closedAt)}`}
            {cost > 0 && ` · ${formatMoney(cost)}`}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {task.status === "failed" && (
              <Button variant="primary" icon={RotateCcw} loading={busy && act.variables === "retry"} disabled={busy} onClick={() => act.mutate("retry")}>
                Try again
              </Button>
            )}
            {open && task.status !== "paused" && (
              <Button icon={Pause} loading={busy && act.variables === "pause"} disabled={busy} onClick={() => act.mutate("pause")}>
                Pause
              </Button>
            )}
            {task.status === "paused" && (
              <Button variant="primary" icon={Play} loading={busy && act.variables === "resume"} disabled={busy} onClick={() => act.mutate("resume")}>
                Resume
              </Button>
            )}
            {open && (
              <Button variant="ghost" icon={Square} disabled={busy} onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-6">
        {waiting && (
          <Callout tone="info" icon={Clock} title={waiting}>
            {task.waitingFor?.note ?? (task.status === "paused" ? "It continues from where it stopped when someone resumes it." : null)}
            {task.nextCheckAt && task.status === "waiting" && (
              <span className="mt-1 block text-xs opacity-80">
                Next check {formatDateTime(task.nextCheckAt)} ({timeUntil(task.nextCheckAt)}). A reply wakes it sooner.
              </span>
            )}
          </Callout>
        )}
        {task.outcome && !open && (
          <Callout
            tone={task.status === "done" ? "success" : task.status === "failed" ? "danger" : "info"}
            title={task.status === "done" ? "Outcome" : "Why it stopped"}
          >
            {task.outcome}
          </Callout>
        )}
        {pending.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-fg">Needs a person</h2>
            <div className="space-y-3">
              {pending.map((entry) => (
                <WorkItemCard key={`${entry.type}-${entry.id}`} entry={entry} />
              ))}
            </div>
          </section>
        )}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card>
            <CardHeader title="History" icon={ListChecks} subtitle="Every step, newest last." />
            <div className="px-5 pt-5">
              {events.length ? <Timeline items={events.map((e) => eventItem(e, agent.name))} /> : <p className="pb-5 text-sm text-muted">Nothing yet.</p>}
            </div>
          </Card>
          <div className="space-y-6">
            <Request task={task} />
            <Emails mails={mails} />
            {runs.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader title="Technical details" icon={ExternalLink} subtitle="The runs behind this task." />
                <ul className="divide-y divide-line">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <Link to={`/runs/${r.id}`} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-subtle/60">
                        <span className="min-w-0 flex-1 truncate text-fg">
                          {runTriggerLabel(r.trigger)} · {runDuration(r)}
                        </span>
                        <StatusPill status={r.status} size="xs" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        size="sm"
        title={`Stop ${task.ref}?`}
        description="It stops for good: open questions and approvals for it are closed. Pausing keeps it."
        footer={
          <>
            <Button onClick={() => setConfirmStop(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={Square}
              loading={busy && act.variables === "stop"}
              onClick={() => act.mutate("stop", { onSuccess: () => setConfirmStop(false) })}
            >
              Stop the task
            </Button>
          </>
        }
      />
    </Page>
  );
}
