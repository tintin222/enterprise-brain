import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BellRing,
  Check,
  ClipboardCheck,
  Mail,
  MessageCircleQuestion,
  PencilLine,
  Plug,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { displayValue, formatDateTime, isRecord, timeAgo } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { ApprovalAction, WorkEntry } from "../types.ts";
import { ActionPreview } from "./ApprovalCard.tsx";
import { StatusPill } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { Markdown } from "./Markdown.tsx";

const KIND: Record<WorkEntry["type"], { label: string; icon: LucideIcon }> = {
  approval: { label: "Approval", icon: UserCheck },
  question: { label: "Question", icon: MessageCircleQuestion },
  review: { label: "Check its work", icon: ClipboardCheck },
  failure: { label: "Stopped with a problem", icon: TriangleAlert },
  notice: { label: "For your information", icon: BellRing },
};

function kindIcon(entry: WorkEntry): LucideIcon {
  if (entry.type === "approval" && entry.action?.type === "mail.send") return Mail;
  if (entry.type === "approval" && entry.action?.type === "connector") return Plug;
  return KIND[entry.type].icon;
}

type Handle =
  | { kind: "decide"; approved: boolean; note?: string; edits?: Record<string, unknown> }
  | { kind: "answer"; answer: string }
  | { kind: "check"; verdict: "right" | "wrong"; note?: string }
  | { kind: "retry" }
  | { kind: "dismiss" };

/** Act on a work-queue item: decide an approval, answer a question, check work, retry or dismiss. */
export function useHandleWork() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ entry, handle }: { entry: WorkEntry; handle: Handle }) => {
      if (handle.kind === "decide") {
        return api.post(path(`/approvals/${encodeURIComponent(entry.id)}/decide`), {
          approved: handle.approved,
          note: handle.note,
          edits: handle.edits,
          wait: false,
        });
      }
      const body =
        handle.kind === "answer"
          ? { answer: handle.answer }
          : handle.kind === "check"
            ? { verdict: handle.verdict, note: handle.note }
            : handle.kind === "retry"
              ? { retry: true }
              : { dismiss: true };
      return api.post(path(`/work/${encodeURIComponent(entry.id)}`), body);
    },
    onSuccess: (_, { entry, handle }) => {
      for (const key of [keys.work(company), keys.tasks(company), keys.home(company), keys.approvals(company), keys.runs(company), keys.dashboard(company)]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      const message =
        handle.kind === "decide"
          ? handle.approved
            ? handle.edits
              ? "Approved with your changes: it continues"
              : "Approved: it continues"
            : "Rejected: it won't do this"
          : handle.kind === "answer"
            ? "Answered: it continues with your answer"
            : handle.kind === "check"
              ? handle.verdict === "right"
                ? "Marked as right"
                : "Marked as wrong: kept as a coaching note"
              : handle.kind === "retry"
                ? "Trying again"
                : "Dismissed";
      toast.success(message, { description: entry.title, link: entry.task ? { to: `/work/${entry.task.ref}`, label: "Follow the task" } : undefined });
    },
    onError: (error) => toast.error(error),
  });
}

/** The fields a person may correct before approving: an email's to/subject/body, or a system action's simple input fields. */
function editableFields(action: ApprovalAction): { key: string; label: string; value: string; long?: boolean }[] {
  if (action.type === "mail.send") {
    return [
      { key: "to", label: "To", value: action.to },
      { key: "subject", label: "Subject", value: action.subject },
      { key: "body", label: "Message", value: action.body, long: true },
    ];
  }
  if (action.type === "connector") {
    return Object.entries(action.input ?? {})
      .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => ({ key, label: key.replace(/[_-]+/g, " "), value: displayValue(value), long: typeof value === "string" && value.length > 80 }));
  }
  return [];
}

function EditDialog({
  entry,
  open,
  onClose,
  onApprove,
  busy,
}: {
  entry: WorkEntry;
  open: boolean;
  onClose: () => void;
  onApprove: (edits: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const action = entry.action;
  const fields = action ? editableFields(action) : [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  if (!action) return null;
  const original = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  const changed = Object.entries(values).filter(([key, value]) => value !== original[key]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!changed.length) return;
    const typed = (key: string, value: string): unknown => {
      const before = action.type === "connector" && isRecord(action.input) ? action.input[key] : undefined;
      if (typeof before === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
      if (typeof before === "boolean") return value.trim().toLowerCase() === "true" || value.trim().toLowerCase() === "yes";
      return value;
    };
    const edits = Object.fromEntries(changed.map(([key, value]) => [key, typed(key, value)]));
    onApprove(action.type === "connector" ? { input: edits } : edits);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Correct it, then approve"
      description="Your changes are used instead of the AI employee's draft, and kept so it learns from them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`edit-${entry.id}`} variant="success" icon={Check} loading={busy} disabled={!changed.length}>
            Approve with changes
          </Button>
        </>
      }
    >
      <form id={`edit-${entry.id}`} onSubmit={submit} className="space-y-4">
        {fields.length === 0 && <p className="text-sm text-muted">Nothing here can be corrected: approve or reject it as it is.</p>}
        {fields.map((field) => (
          <div key={field.key}>
            <label className="label capitalize" htmlFor={`edit-${entry.id}-${field.key}`}>
              {field.label}
            </label>
            {field.long ? (
              <textarea
                id={`edit-${entry.id}-${field.key}`}
                className="input min-h-48 font-[inherit] leading-relaxed"
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            ) : (
              <input
                id={`edit-${entry.id}-${field.key}`}
                className="input"
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            )}
          </div>
        ))}
      </form>
    </Dialog>
  );
}

function Actions({ entry }: { entry: WorkEntry }) {
  const handle = useHandleWork();
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [editing, setEditing] = useState(false);
  const [wrong, setWrong] = useState(false);
  const busy = handle.isPending && handle.variables?.entry.id === entry.id;
  const pendingKind = busy ? handle.variables?.handle : undefined;
  const run = (h: Handle) => handle.mutate({ entry, handle: h });

  if (entry.type === "approval") {
    const fields = entry.action ? editableFields(entry.action) : [];
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          className="input h-9 flex-1 py-1.5"
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            icon={X}
            disabled={busy}
            loading={pendingKind?.kind === "decide" && !pendingKind.approved}
            onClick={() => run({ kind: "decide", approved: false, note: note.trim() || undefined })}
          >
            Reject
          </Button>
          {fields.length > 0 && (
            <Button icon={PencilLine} disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button
            variant="success"
            icon={Check}
            disabled={busy}
            loading={pendingKind?.kind === "decide" && pendingKind.approved && !pendingKind.edits}
            onClick={() => run({ kind: "decide", approved: true, note: note.trim() || undefined })}
          >
            Approve
          </Button>
        </div>
        {editing && (
          <EditDialog
            entry={entry}
            open={editing}
            busy={busy}
            onClose={() => setEditing(false)}
            onApprove={(edits) =>
              handle.mutate(
                { entry, handle: { kind: "decide", approved: true, note: note.trim() || undefined, edits } },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        )}
      </div>
    );
  }

  if (entry.type === "question") {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (answer.trim()) run({ kind: "answer", answer: answer.trim() });
    };
    return (
      <div className="space-y-2">
        {(entry.options?.length || entry.suggestion) && (
          <div className="flex flex-wrap gap-2">
            {entry.suggestion && !entry.options?.includes(entry.suggestion) && (
              <Button variant="soft" size="sm" icon={Check} disabled={busy} onClick={() => run({ kind: "answer", answer: entry.suggestion! })}>
                Use its suggestion: {entry.suggestion}
              </Button>
            )}
            {entry.options?.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === entry.suggestion ? "soft" : "secondary"}
                disabled={busy}
                loading={pendingKind?.kind === "answer" && pendingKind.answer === option}
                onClick={() => run({ kind: "answer", answer: option })}
              >
                {option}
                {option === entry.suggestion && <span className="text-[11px] font-normal opacity-75">suggested</span>}
              </Button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input h-9 flex-1 py-1.5"
            placeholder={entry.options?.length ? "Or answer in your own words" : "Your answer"}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            aria-label="Answer"
          />
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => run({ kind: "dismiss" })}>
              Dismiss
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={Send}
              disabled={busy || !answer.trim()}
              loading={pendingKind?.kind === "answer" && pendingKind.answer === answer.trim()}
            >
              Answer
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (entry.type === "review") {
    return wrong ? (
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          run({ kind: "check", verdict: "wrong", note: note.trim() || undefined });
        }}
      >
        <input
          autoFocus
          className="input h-9 flex-1 py-1.5"
          placeholder="What should it have done? It learns from this."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="What was wrong"
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setWrong(false)}>
            Back
          </Button>
          <Button type="submit" variant="danger" icon={ThumbsDown} loading={busy}>
            Mark as wrong
          </Button>
        </div>
      </form>
    ) : (
      <div className="flex flex-wrap justify-end gap-2">
        <Button icon={ThumbsDown} disabled={busy} onClick={() => setWrong(true)}>
          Wrong
        </Button>
        <Button variant="success" icon={ThumbsUp} disabled={busy} loading={busy} onClick={() => run({ kind: "check", verdict: "right" })}>
          Right
        </Button>
      </div>
    );
  }

  if (entry.type === "failure") {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} loading={pendingKind?.kind === "dismiss"} onClick={() => run({ kind: "dismiss" })}>
          Dismiss
        </Button>
        {entry.task && (
          <Button variant="primary" icon={RotateCcw} disabled={busy} loading={pendingKind?.kind === "retry"} onClick={() => run({ kind: "retry" })}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <Button icon={Check} disabled={busy} loading={busy} onClick={() => run({ kind: "dismiss" })}>
        Got it
      </Button>
    </div>
  );
}

/** One thing that needs a person, with what they can do about it right there. */
export function WorkItemCard({ entry, className, showAgent = true }: { entry: WorkEntry; className?: string; showAgent?: boolean }) {
  const Icon = kindIcon(entry);
  const open = entry.status === "open" || entry.status === "pending";
  const urgent = open && (entry.type === "approval" || entry.type === "failure");
  return (
    <article className={clsx("rounded-xl border bg-surface shadow-xs", urgent ? "border-amber-200 dark:border-amber-400/25" : "border-line", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={clsx(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              !open
                ? "bg-subtle text-muted"
                : entry.type === "failure"
                  ? "bg-red-50 text-red-600 dark:bg-red-400/15 dark:text-red-300"
                  : entry.type === "notice"
                    ? "bg-sky-50 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300"
                    : "bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold break-words text-fg">{entry.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span>{KIND[entry.type].label}</span>
              {showAgent && entry.agent && (
                <>
                  <span aria-hidden="true">·</span>
                  <Link to={`/ai/${entry.agent.slug}`} className="font-medium text-fg/80 hover:underline">
                    {entry.agent.name}
                  </Link>
                </>
              )}
              {entry.task && (
                <>
                  <span aria-hidden="true">·</span>
                  <Link to={`/work/${entry.task.ref}`} className="font-mono text-[11px] hover:underline" title={entry.task.title}>
                    {entry.task.ref}
                  </Link>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span title={formatDateTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
              {entry.assignee && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>for {entry.assignee.name}</span>
                </>
              )}
            </p>
          </div>
        </div>
        {!open && <StatusPill status={entry.status} size="xs" />}
      </header>
      <div className="space-y-3 px-4 py-3">
        {entry.reason && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
            <span className="font-semibold">{entry.type === "approval" ? "Why you are asked:" : "Why:"}</span> {entry.reason}
          </p>
        )}
        {entry.details && (
          <Markdown compact breaks className="max-h-72 overflow-y-auto text-[13px]">
            {entry.details}
          </Markdown>
        )}
        {entry.action && entry.action.type !== "decision" && <ActionPreview action={entry.action} />}
        {!open && entry.resolvedBy && <p className="text-xs text-muted">Handled by {entry.resolvedBy}</p>}
      </div>
      {open && entry.canHandle && (
        <footer className="border-t border-line bg-subtle/40 px-4 py-3">
          <Actions entry={entry} />
        </footer>
      )}
      {open && !entry.canHandle && (
        <footer className="border-t border-line px-4 py-2.5 text-xs text-muted">
          {entry.assignee ? `Waiting for ${entry.assignee.name}.` : "Waiting for someone in its department."}
        </footer>
      )}
    </article>
  );
}
