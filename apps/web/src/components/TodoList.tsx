import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, CircleCheck, ExternalLink, Plus, RotateCcw, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { Badge, type Tone } from "../components/Badge.tsx";
import { useViewer } from "../lib/auth.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatDate, timeAgo } from "../lib/format.ts";
import { paths } from "../lib/paths.ts";
import { keys, useProjects, useTodos } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { Todo, TodoSource, TodoStatus } from "../types.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorState, Skeleton } from "./Spinner.tsx";

const SOURCE: Record<TodoSource, { label: string; tone: Tone } | null> = {
  manual: null,
  mail: { label: "From your mail", tone: "blue" },
  studio: { label: "From the Studio", tone: "violet" },
  project: null,
};

/** Overdue, due today, due later, or no date: how a due date reads and looks. */
function dueOf(todo: Todo): { text: string; className: string } | null {
  if (!todo.dueAt) return null;
  const due = new Date(todo.dueAt);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);
  if (todo.status !== "open") return { text: formatDate(due), className: "text-muted" };
  if (due < startOfToday) return { text: `Overdue · ${formatDate(due)}`, className: "text-red-600 dark:text-red-400 font-medium" };
  if (due < startOfTomorrow) return { text: "Due today", className: "text-amber-700 dark:text-amber-300 font-medium" };
  return { text: `Due ${formatDate(due)}`, className: "text-muted" };
}

/** One to-do: its title and where it came from, with Done, Not a task, and the project it belongs to. */
function TodoRow({
  todo,
  showProject,
  onStatus,
  onProject,
  busy,
}: {
  todo: Todo;
  showProject: boolean;
  onStatus: (status: TodoStatus, quiet?: boolean) => void;
  onProject: (projectId: string | null) => void;
  busy: boolean;
}) {
  const projects = useProjects({ status: "open", enabled: showProject });
  const source = SOURCE[todo.source];
  const due = dueOf(todo);
  const from = todo.source === "mail" ? [todo.data.from, todo.data.subject].filter(Boolean).join(" · ") : "";
  const open = todo.status === "open";
  return (
    <li className={clsx("flex items-start gap-3 px-4 py-3", !open && "opacity-70")}>
      <button
        type="button"
        onClick={() => onStatus(open ? "done" : "open")}
        disabled={busy}
        aria-label={open ? "Done" : "Reopen"}
        title={open ? "Done" : "Reopen"}
        className={clsx(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          open ? "border-line-strong text-transparent hover:border-emerald-500 hover:text-emerald-600" : "border-emerald-500 bg-emerald-500 text-white",
        )}
      >
        <Check className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className={clsx("text-sm text-fg", !open && "line-through")}>{todo.title}</p>
        {todo.details && <p className="mt-0.5 line-clamp-2 text-xs whitespace-pre-line text-muted">{todo.details}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {source && (
            <Badge tone={source.tone} size="xs" title={from || undefined}>
              {source.label}
            </Badge>
          )}
          {from && <span className="truncate">{from}</span>}
          {todo.project && (
            <Link to={paths.project(todo.project.slug, "tasks")} className="hover:underline">
              {todo.project.name}
            </Link>
          )}
          {due && <span className={due.className}>{due.text}</span>}
          {todo.link && (
            <a href={todo.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              {todo.source === "mail" ? "Open in Gmail" : "Open"} <ExternalLink className="size-3" />
            </a>
          )}
          {!open && (
            <span>
              {todo.status === "done" ? "Done" : "Put aside"} {timeAgo(todo.doneAt)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {showProject && open && (
          <select
            className="input h-7 max-w-36 py-0 text-xs"
            value={todo.project?.id ?? ""}
            onChange={(e) => onProject(e.target.value || null)}
            aria-label="Project"
            disabled={busy}
          >
            <option value="">No project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {todo.project && !(projects.data ?? []).some((p) => p.id === todo.project!.id) && <option value={todo.project.id}>{todo.project.name}</option>}
          </select>
        )}
        {open ? (
          <Button
            size="xs"
            variant="ghost"
            icon={X}
            title={todo.source === "mail" ? "Not a task: put it aside and ask for no more from this sender" : "Not a task"}
            aria-label="Not a task"
            disabled={busy}
            onClick={() => onStatus("dismissed", todo.source === "mail")}
          />
        ) : (
          <Button size="xs" variant="ghost" icon={RotateCcw} title="Reopen" aria-label="Reopen" disabled={busy} onClick={() => onStatus("open")} />
        )}
      </div>
    </li>
  );
}

/**
 * A person's to-dos: open ones due soonest first, with a box to add one; `projectId` keeps it to one
 * project's. Finished and put-aside ones stay reachable below.
 */
export function TodoList({ projectId, showProject = !projectId, className }: { projectId?: string; showProject?: boolean; className?: string }) {
  const { company, path } = useCompany();
  const viewer = useViewer();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"open" | "all">("open");
  const todos = useTodos(status, { projectId });
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.todos(company) }).then(() => queryClient.invalidateQueries({ queryKey: keys.projects(company) }));
  const add = useMutation({
    mutationFn: () =>
      projectId
        ? api.post<Todo>(path(`/projects/${projectId}/todos`), { title: title.trim(), dueAt: due || null })
        : api.post<Todo>(path("/todos"), { title: title.trim(), dueAt: due || null }),
    onSuccess: async () => {
      setTitle("");
      setDue("");
      await refresh();
    },
    onError: (error) => toast.error(error),
  });
  const change = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.patch<Todo>(path(`/todos/${id}`), patch),
    onSuccess: refresh,
    onError: (error) => toast.error(error),
    onSettled: () => setBusy(null),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) add.mutate();
  };
  if (viewer && viewer.kind !== "session") {
    return (
      <EmptyState
        compact
        icon={CircleCheck}
        title="Tasks need a signed-in person"
        description="To-dos belong to a person; sign in with your account to keep yours."
        className={className}
      />
    );
  }
  const list = todos.data ?? [];
  const open = list.filter((t) => t.status === "open");
  const closed = list.filter((t) => t.status !== "open");
  return (
    <div className={clsx("space-y-4", className)}>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          className="input min-w-0 flex-1"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Something you must do…"
          aria-label="New task"
        />
        <input className="input sm:w-40" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
        <Button type="submit" variant="primary" icon={Plus} loading={add.isPending} disabled={!title.trim()}>
          Add
        </Button>
      </form>
      {todos.error && <ErrorState error={todos.error} onRetry={() => void todos.refetch()} />}
      {todos.isLoading && <Skeleton className="h-24" />}
      {todos.data && open.length === 0 && (
        <EmptyState
          compact
          icon={CircleCheck}
          title="Nothing to do"
          description={projectId ? "Nothing open for this project." : "Tasks from your mail, your projects and the Studio appear here."}
        />
      )}
      {open.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {open.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                showProject={showProject}
                busy={busy === todo.id}
                onStatus={(next, quiet) => {
                  setBusy(todo.id);
                  change.mutate({ id: todo.id, patch: { status: next, ...(quiet ? { quietSender: true } : {}) } });
                }}
                onProject={(id) => {
                  setBusy(todo.id);
                  change.mutate({ id: todo.id, patch: { projectId: id } });
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      <div>
        <button type="button" className="text-xs font-medium text-muted hover:text-fg" onClick={() => setStatus(status === "open" ? "all" : "open")}>
          {status === "open" ? "Show finished and put-aside tasks" : "Hide finished tasks"}
        </button>
        {status === "all" && closed.length > 0 && (
          <Card className="mt-2 overflow-hidden">
            <ul className="divide-y divide-line">
              {closed.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  showProject={false}
                  busy={busy === todo.id}
                  onStatus={(next) => {
                    setBusy(todo.id);
                    change.mutate({ id: todo.id, patch: { status: next } });
                  }}
                  onProject={() => undefined}
                />
              ))}
            </ul>
          </Card>
        )}
        {status === "all" && todos.data && closed.length === 0 && <p className="mt-2 text-xs text-muted">Nothing finished yet.</p>}
      </div>
    </div>
  );
}
