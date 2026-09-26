import { Clock, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import type { TaskRow } from "../types.ts";
import { StatusPill } from "./Badge.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** What a task is waiting for, in words: "a reply (since 2 days ago), then checks again in 3 days". */
export function waitingText(task: TaskRow): string | null {
  const wait = task.waitingFor;
  if (task.status === "paused") return "Paused by a person";
  if (task.status !== "waiting" || !wait) return null;
  const next = task.nextCheckAt ? `checks again ${timeUntil(task.nextCheckAt)}` : null;
  if (wait.kind === "reply") return ["Waiting for a reply", next].filter(Boolean).join(", ");
  if (wait.kind === "time") return next ? `Waiting: ${next}` : "Waiting";
  return wait.note ?? "Waiting";
}

/** "in 3 days", "in 2 hours", "soon". */
export function timeUntil(value: string): string {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 60_000) return "soon";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

const SOURCE: Record<string, string> = {
  manual: "Given by a person",
  request: "Given by a person",
  mailbox: "Email",
  schedule: "Schedule",
  recurring: "Recurring request",
  form: "Web form",
  webhook: "Another system",
  paperclip: "Paperclip",
  "connector-event": "Connected system",
  chat: "Chat",
  test: "Test",
};

export function sourceLabel(source: string): string {
  return SOURCE[source] ?? source;
}

/** Where a task came from: "Given by Elif Arslan", "Email", "Schedule"… */
export function fromText(task: TaskRow): string {
  if (task.requestedBy && ["request", "manual", "chat"].includes(task.source)) return `Given by ${task.requestedBy}`;
  return `${sourceLabel(task.source)}${task.requestedBy ? ` · ${task.requestedBy}` : ""}`;
}

/** Tasks as a table (a list on narrow screens): each row opens the task's page. */
export function TaskTable({ tasks, showAgent = true, empty }: { tasks: TaskRow[]; showAgent?: boolean; empty?: ReactNode }) {
  const navigate = useNavigate();
  if (!tasks.length) return <>{empty ?? <EmptyState compact className="m-4" icon={ListChecks} title="No tasks" />}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2.5 font-medium">Task</th>
            {showAgent && <th className="hidden px-4 py-2.5 font-medium md:table-cell">AI employee</th>}
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="hidden px-4 py-2.5 font-medium lg:table-cell">From</th>
            <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {tasks.map((task) => {
            const waiting = waitingText(task);
            return (
              <tr
                key={task.id}
                className="cursor-pointer align-top hover:bg-subtle/50"
                onClick={() => navigate(`/work/${task.ref}`)}
                onKeyDown={(e) => e.key === "Enter" && navigate(`/work/${task.ref}`)}
                tabIndex={0}
              >
                <td className="max-w-0 px-4 py-3">
                  <Link
                    to={`/work/${task.ref}`}
                    onClick={(e) => e.stopPropagation()}
                    className="block truncate font-medium text-fg hover:underline"
                    title={task.title}
                  >
                    {task.title}
                  </Link>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                    <span className="font-mono text-[11px]">{task.ref}</span>
                    {showAgent && task.agent && <span className="md:hidden">· {task.agent.name}</span>}
                    {waiting && (
                      <span className="inline-flex items-center gap-1 truncate text-violet-700 dark:text-violet-300">
                        · <Clock className="size-3 shrink-0" /> {waiting}
                      </span>
                    )}
                    {!waiting && task.outcome && task.status !== "working" && <span className="truncate">· {task.outcome}</span>}
                  </p>
                </td>
                {showAgent && (
                  <td className="hidden px-4 py-3 whitespace-nowrap md:table-cell">
                    {task.agent ? (
                      <Link to={`/ai/${task.agent.slug}`} onClick={(e) => e.stopPropagation()} className="text-fg/90 hover:underline">
                        {task.agent.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td className="px-4 py-3 whitespace-nowrap">
                  <StatusPill status={task.status} size="xs" />
                </td>
                <td className="hidden px-4 py-3 whitespace-nowrap text-muted lg:table-cell">{fromText(task)}</td>
                <td className="hidden px-4 py-3 text-right whitespace-nowrap text-muted tabular-nums sm:table-cell" title={formatDateTime(task.updatedAt)}>
                  {timeAgo(task.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
