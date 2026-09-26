import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, CircleCheck, Clock, ExternalLink, Info, Lock, PencilLine, RotateCcw, Send, ShieldCheck, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { api, isApiError } from "../api.ts";
import { ActionPreview } from "../components/ApprovalCard.tsx";
import { Button } from "../components/Button.tsx";
import { Logo } from "../components/Logo.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Callout, ErrorState, LoadingBlock } from "../components/Spinner.tsx";
import { formatDateTime } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/title.ts";
import type { ApprovalAction } from "../types.ts";

type ItemType = "approval" | "question" | "review" | "failure" | "notice";

interface ActItem {
  type: ItemType;
  id: string;
  title: string;
  details: string;
  reason: string | null;
  suggestion: string | null;
  options: string[] | null;
  action: ApprovalAction | null;
  agent: { name: string } | null;
  task: { ref: string; title: string; status: string } | null;
  status: string;
  resolvedBy: string | null;
  answer: string | null;
  createdAt: string;
}

interface ActView {
  company: { name: string };
  person: { name: string };
  item: ActItem;
  canAct: boolean;
  expiresAt: string;
}

interface ActBody {
  choice?: "approve" | "reject";
  note?: string;
  edits?: Record<string, unknown>;
  answer?: string;
  verdict?: "right" | "wrong";
  retry?: boolean;
  dismiss?: boolean;
}

const KIND: Record<ItemType, string> = {
  approval: "Approval",
  question: "Question",
  review: "Check",
  failure: "Stopped task",
  notice: "Notice",
};

function Shell({ company, person, children }: { company?: string; person?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-4">
          <Logo className="size-7" />
          <span className="truncate text-sm font-semibold text-fg">{company ?? "Enterprise Brain"}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
            <Lock className="size-3.5" /> {person ? `For ${person}` : "Secure link"}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-10">{children}</main>
    </div>
  );
}

function Message({
  icon: Icon,
  title,
  body,
  tone,
  children,
}: {
  icon: typeof CircleCheck;
  title: string;
  body: ReactNode;
  tone: "green" | "amber";
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
      <div
        className={clsx(
          "mx-auto mb-4 flex size-14 items-center justify-center rounded-full",
          tone === "green"
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300"
            : "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300",
        )}
      >
        <Icon className="size-7" />
      </div>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</div>
      {children && <div className="mt-5 flex justify-center gap-2">{children}</div>}
    </div>
  );
}

/** What the person pressed in the email, and that this page is where it happens. */
function presetText(type: ItemType, choice: string | null, answer: string | null, verdict: string | null): string | null {
  if (type === "approval" && choice === "approve") return "You chose Approve in the email: confirm it here.";
  if (type === "approval" && choice === "reject") return "You chose Reject in the email: add why if you like, and confirm it here.";
  if (type === "approval" && choice === "edit") return "Correct what it would send, then approve it.";
  if (type === "question" && answer) return `You chose “${answer}” in the email: send it here.`;
  if (type === "review" && verdict) return `You chose “${verdict === "right" ? "Right" : "Wrong"}” in the email: confirm it here.`;
  return null;
}

/** What happened to a handled item, in words. */
function outcome(item: ActItem): string {
  const by = item.resolvedBy ? ` by ${item.resolvedBy}` : "";
  switch (item.status) {
    case "approved":
      return `Approved${by}.`;
    case "rejected":
      return `Rejected${by}.`;
    case "cancelled":
      return "Withdrawn: the task was stopped.";
    case "dismissed":
      return `Dismissed${by}.`;
    default:
      return item.answer ? `Handled${by}: ${item.answer}` : `Handled${by}.`;
  }
}

function OpenInApp({ item }: { item: ActItem }) {
  return (
    <a
      href={item.task ? `/work/${encodeURIComponent(item.task.ref)}` : "/work"}
      className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-300"
    >
      Open in the app <ExternalLink className="size-3.5" />
    </a>
  );
}

/** The fields a person may correct before approving: an email's to/subject/body, or a system action's input. */
function Corrections({
  action,
  edits,
  onChange,
}: {
  action: ApprovalAction;
  edits: Record<string, string>;
  onChange: (edits: Record<string, string>) => void;
}) {
  const fields: { key: string; label: string; value: string; long?: boolean }[] =
    action.type === "mail.send"
      ? [
          { key: "to", label: "To", value: action.to },
          { key: "subject", label: "Subject", value: action.subject },
          { key: "body", label: "Text", value: action.body, long: true },
        ]
      : action.type === "connector"
        ? Object.entries(action.input ?? {})
            .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
            .map(([key, value]) => ({
              key,
              label: key.replace(/[_-]+/g, " "),
              value: value === null ? "" : String(value),
              long: String(value ?? "").length > 80,
            }))
        : [];
  if (!fields.length) return null;
  return (
    <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-400/25 dark:bg-brand-400/5">
      <p className="text-sm font-medium text-fg">Correct it before it goes out</p>
      {fields.map((field) => (
        <div key={field.key}>
          <label htmlFor={`edit-${field.key}`} className="label capitalize">
            {field.label}
          </label>
          {field.long ? (
            <textarea
              id={`edit-${field.key}`}
              rows={6}
              className="input"
              value={edits[field.key] ?? field.value}
              onChange={(e) => onChange({ ...edits, [field.key]: e.target.value })}
            />
          ) : (
            <input
              id={`edit-${field.key}`}
              className="input"
              value={edits[field.key] ?? field.value}
              onChange={(e) => onChange({ ...edits, [field.key]: e.target.value })}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Only the fields the person changed, typed like the original (numbers stay numbers). */
function changedEdits(action: ApprovalAction, edits: Record<string, string>): Record<string, unknown> | undefined {
  if (action.type === "mail.send") {
    const changed = Object.fromEntries(
      Object.entries(edits).filter(([key, value]) => value.trim() && value !== String((action as Record<string, unknown>)[key] ?? "")),
    );
    return Object.keys(changed).length ? changed : undefined;
  }
  if (action.type === "connector") {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(edits)) {
      const original = action.input?.[key];
      if (value === String(original ?? "")) continue;
      input[key] =
        typeof original === "number" && value.trim() !== "" && !Number.isNaN(Number(value))
          ? Number(value)
          : typeof original === "boolean"
            ? value === "true"
            : value;
    }
    return Object.keys(input).length ? { input } : undefined;
  }
  return undefined;
}

/**
 * The page an email's buttons open. It shows the item and who the link is for; nothing happens until
 * the person confirms here (mail scanners open links too). The link acts for that one person.
 */
export default function ActPage() {
  const { token = "" } = useParams();
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const queryKey = ["public-act", token];
  const view = useQuery({
    queryKey,
    queryFn: () => api.get<ActView>(`/api/public/act/${encodeURIComponent(token)}`),
    retry: false,
  });
  const preset = search.get("choice");
  const [editing, setEditing] = useState(preset === "edit");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState(search.get("answer") ?? "");
  const presetVerdict = search.get("verdict");
  const act = useMutation({
    mutationFn: (body: ActBody) => api.post<{ ok: boolean; item: ActItem | null }>(`/api/public/act/${encodeURIComponent(token)}`, body),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });
  const data = view.data;
  useDocumentTitle(data ? `${KIND[data.item.type]}: ${data.item.title}` : "Your decision");

  if (view.isLoading) {
    return (
      <Shell>
        <LoadingBlock />
      </Shell>
    );
  }
  if (view.error || !data) {
    const expired = isApiError(view.error, 410);
    const invalid = isApiError(view.error, 400) || isApiError(view.error, 404);
    const denied = isApiError(view.error, 403);
    return (
      <Shell>
        {expired || invalid || denied ? (
          <Message
            icon={Info}
            tone="amber"
            title={expired ? "This link has expired" : denied ? "This link no longer works for you" : "This link is not valid"}
            body={
              expired
                ? "Links in emails work for a week. Open Work in the app to see what needs you."
                : denied
                  ? (view.error as Error).message
                  : "Open Work in the app to see what needs you."
            }
          >
            <a href="/work" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">
              Open Work <ExternalLink className="size-3.5" />
            </a>
          </Message>
        ) : (
          <ErrorState error={view.error} onRetry={() => void view.refetch()} />
        )}
      </Shell>
    );
  }

  const { item } = data;
  const done = act.data?.item ?? null;
  if (done && act.isSuccess) {
    return (
      <Shell company={data.company.name} person={data.person.name}>
        <Message
          icon={CircleCheck}
          tone="green"
          title={outcome(done)}
          body={
            <>
              {item.agent ? `${item.agent.name} continues from your decision` : "Your decision is recorded"}
              {item.task ? ` on ${item.task.ref}` : ""}. You can close this page.
            </>
          }
        >
          <OpenInApp item={item} />
        </Message>
      </Shell>
    );
  }

  const closed = !data.canAct;
  const busy = act.isPending;
  const submit = (body: ActBody) => act.mutate({ ...body, note: note.trim() || undefined });
  const conflict = isApiError(act.error, 409);

  return (
    <Shell company={data.company.name} person={data.person.name}>
      <div className="mb-5">
        <p className="text-xs font-medium tracking-wide text-brand-600 uppercase dark:text-brand-300">
          {KIND[item.type]}
          {item.agent ? ` · ${item.agent.name}` : ""}
          {item.task ? ` · ${item.task.ref}` : ""}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{item.title}</h1>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted">
          <Clock className="size-3.5" /> {formatDateTime(item.createdAt)}
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-xs">
        {item.reason && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
            <span className="font-semibold">Why you are asked:</span> {item.reason}
          </p>
        )}
        {item.suggestion && (
          <p className="text-sm text-fg">
            <span className="font-semibold">It suggests:</span> {item.suggestion}
          </p>
        )}
        {item.details && (
          <Markdown compact breaks className="max-h-96 overflow-y-auto text-sm">
            {item.details}
          </Markdown>
        )}
        {item.action && item.action.type !== "decision" && !editing && <ActionPreview action={item.action} />}
        {item.action && editing && !closed && <Corrections action={item.action} edits={edits} onChange={setEdits} />}
      </div>

      {closed || conflict ? (
        <Callout
          tone="success"
          icon={CircleCheck}
          className="mt-5"
          title={item.status === "pending" || item.status === "open" ? "You can't act on this any more" : outcome(item)}
        >
          {conflict ? "Someone handled it while you were looking. " : ""}Nothing else is needed from you here.
          <div className="mt-2">
            <OpenInApp item={item} />
          </div>
        </Callout>
      ) : (
        <div className="mt-5 space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-xs">
          {item.type === "question" && (
            <div>
              <p className="label">Your answer</p>
              {item.options?.length ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {item.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setAnswer(option)}
                      className={clsx(
                        "rounded-lg border px-3 py-1.5 text-sm font-medium",
                        answer === option
                          ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                          : "border-line-strong text-fg hover:bg-subtle",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-label="Your answer"
                rows={3}
                className="input"
                placeholder="Write your answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </div>
          )}
          <div>
            <label htmlFor="act-note" className="label">
              {item.type === "review" ? "What was wrong?" : "Note"} <span className="text-xs font-normal text-faint">optional</span>
            </label>
            <input
              id="act-note"
              className="input"
              placeholder={item.type === "approval" ? "e.g. Checked with the supplier" : item.type === "review" ? "In plain words, for its coaching" : ""}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {presetText(item.type, preset, search.get("answer"), presetVerdict) && (
            <p className="text-sm text-muted">{presetText(item.type, preset, search.get("answer"), presetVerdict)}</p>
          )}
          {act.error && !conflict && <ErrorState error={act.error} />}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {item.type === "approval" && (
              <>
                {item.action && item.action.type !== "decision" && !editing && (
                  <Button variant="ghost" icon={PencilLine} onClick={() => setEditing(true)} disabled={busy}>
                    Correct it first
                  </Button>
                )}
                <Button
                  variant={preset === "reject" ? "danger" : "secondary"}
                  icon={X}
                  loading={busy && act.variables?.choice === "reject"}
                  disabled={busy}
                  onClick={() => submit({ choice: "reject" })}
                >
                  Reject
                </Button>
                <Button
                  variant="success"
                  icon={Check}
                  loading={busy && act.variables?.choice === "approve"}
                  disabled={busy}
                  onClick={() => submit({ choice: "approve", edits: editing && item.action ? changedEdits(item.action, edits) : undefined })}
                >
                  {editing ? "Approve with corrections" : "Approve"}
                </Button>
              </>
            )}
            {item.type === "question" && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => submit({ dismiss: true })}>
                  Dismiss
                </Button>
                <Button variant="primary" icon={Send} loading={busy} disabled={busy || !answer.trim()} onClick={() => submit({ answer: answer.trim() })}>
                  Send answer
                </Button>
              </>
            )}
            {item.type === "review" && (
              <>
                <Button
                  variant={presetVerdict === "wrong" ? "danger" : "secondary"}
                  icon={ThumbsDown}
                  disabled={busy}
                  onClick={() => submit({ verdict: "wrong" })}
                >
                  Wrong
                </Button>
                <Button variant="success" icon={ThumbsUp} disabled={busy} onClick={() => submit({ verdict: "right" })}>
                  Right
                </Button>
              </>
            )}
            {item.type === "failure" && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => submit({ dismiss: true })}>
                  Dismiss
                </Button>
                <Button variant="primary" icon={RotateCcw} loading={busy} disabled={busy} onClick={() => submit({ retry: true })}>
                  Try again
                </Button>
              </>
            )}
            {item.type === "notice" && (
              <Button variant="primary" icon={Check} loading={busy} disabled={busy} onClick={() => submit({})}>
                Mark as seen
              </Button>
            )}
          </div>
        </div>
      )}
      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5 shrink-0" /> This link acts for {data.person.name} until {formatDateTime(data.expiresAt)}. Your decision is recorded
        under your name.
      </p>
    </Shell>
  );
}
