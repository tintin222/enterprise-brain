import { clsx } from "clsx";
import { Check, ChevronDown, ChevronRight, ExternalLink, Link2, Mail, MailCheck, Save, Send, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonAnchor } from "../../components/Button.tsx";
import { copyText, CopyButton } from "../../components/CopyButton.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { stakeholderLabel } from "../../lib/labels.ts";
import { useToast } from "../../lib/toast.tsx";
import type { SessionView, StakeholderRequest } from "../../types.ts";
import type { SessionActions } from "./actions.ts";

function answerLink(token: string): string {
  return `${window.location.origin}/answer/${token}`;
}

function RequestCard({ request, actions, highlighted }: { request: StakeholderRequest; actions: SessionActions; highlighted: boolean }) {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState({
    recipientName: request.recipientName ?? "",
    recipientEmail: request.recipientEmail ?? "",
    subject: request.subject,
    body: request.body,
  });
  const [showQuestionnaire, setShowQuestionnaire] = useState(false);

  // Server-side changes (e.g. greeting updated with the recipient's name) replace the local draft.
  useEffect(() => {
    setDraft({ recipientName: request.recipientName ?? "", recipientEmail: request.recipientEmail ?? "", subject: request.subject, body: request.body });
  }, [request.recipientName, request.recipientEmail, request.subject, request.body]);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlighted]);

  const dirty =
    draft.recipientName !== (request.recipientName ?? "") ||
    draft.recipientEmail !== (request.recipientEmail ?? "") ||
    draft.subject !== request.subject ||
    draft.body !== request.body;

  const patch = () => ({
    recipientName: draft.recipientName.trim() || undefined,
    recipientEmail: draft.recipientEmail.trim() || undefined,
    subject: draft.subject,
    body: draft.body,
  });

  const save = () => actions.updateRequest.mutateAsync({ id: request.id, patch: patch() });
  const saveThenSend = async (via: "mail" | "manual") => {
    try {
      if (dirty) await save();
      actions.sendRequest.mutate({ id: request.id, via });
    } catch {
      // toast shown by the mutation
    }
  };

  const mailto = `mailto:${encodeURIComponent(draft.recipientEmail)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  const answered = request.status === "answered";
  const busy = actions.updateRequest.isPending || actions.sendRequest.isPending;

  return (
    <div
      ref={ref}
      className={clsx(
        "scroll-mt-4 rounded-xl border bg-surface shadow-xs transition-shadow",
        highlighted ? "border-brand-400 ring-2 ring-brand-500/20" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg">{stakeholderLabel(request.role)}</p>
          <p className="text-xs text-muted">
            {request.questions.length} question{request.questions.length === 1 ? "" : "s"}
            {request.sentAt ? ` · sent ${formatDateTime(request.sentAt)}` : ""}
            {request.answeredAt ? ` · answered ${formatDateTime(request.answeredAt)}${request.answeredBy ? ` by ${request.answeredBy}` : ""}` : ""}
          </p>
        </div>
        <StatusPill status={request.status} />
      </div>

      <div className="space-y-3 px-4 py-3">
        {answered ? (
          <ul className="space-y-2.5">
            {request.questions.map((q) => (
              <li key={q.nodeId} className="text-sm">
                <p className="text-muted">{q.question}</p>
                <p className="mt-0.5 flex gap-1.5 font-medium text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  {q.answer ?? "—"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Recipient name">
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    placeholder="e.g. Murat Yılmaz"
                    value={draft.recipientName}
                    onChange={(e) => setDraft({ ...draft, recipientName: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Recipient email">
                {(id) => (
                  <input
                    id={id}
                    type="email"
                    className="input"
                    placeholder="it-director@company.com"
                    value={draft.recipientEmail}
                    onChange={(e) => setDraft({ ...draft, recipientEmail: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label="Subject">
              {(id) => <input id={id} className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />}
            </Field>
            <Field label="Email">
              {(id) => (
                <textarea
                  id={id}
                  rows={10}
                  className="input font-[inherit] text-[13px] leading-relaxed"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              )}
            </Field>
            {dirty && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="soft"
                  icon={Save}
                  loading={actions.updateRequest.isPending}
                  onClick={() => void save().then(() => toast.success("Request saved"))}
                >
                  Save changes
                </Button>
                <span className="text-xs text-muted">Unsaved changes</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <Button
                size="sm"
                variant="primary"
                icon={Send}
                disabled={!draft.recipientEmail.trim() || busy}
                title={draft.recipientEmail.trim() ? "Send from the company mailbox" : "Add the recipient's email address first"}
                loading={actions.sendRequest.isPending && actions.sendRequest.variables?.via === "mail"}
                onClick={() => void saveThenSend("mail")}
              >
                Send via company mail
              </Button>
              <ButtonAnchor size="sm" variant="secondary" icon={Mail} href={mailto}>
                Open in mail app
              </ButtonAnchor>
              <Button
                size="sm"
                variant="secondary"
                icon={MailCheck}
                disabled={busy}
                loading={actions.sendRequest.isPending && actions.sendRequest.variables?.via === "manual"}
                onClick={() => void saveThenSend("manual")}
              >
                Mark as sent
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton size="sm" variant="ghost" label="Copy email" text={() => `Subject: ${draft.subject}\n\n${draft.body}`} />
              <Button
                size="sm"
                variant="ghost"
                icon={Link2}
                onClick={() =>
                  void copyText(answerLink(request.token)).then(
                    (ok) => ok && toast.success("Answer link copied", { description: "Anyone with the link can answer these questions." }),
                  )
                }
              >
                Copy answer link
              </Button>
              <ButtonAnchor size="sm" variant="ghost" icon={ExternalLink} href={`/answer/${request.token}`} target="_blank" rel="noopener noreferrer">
                Preview answer page
              </ButtonAnchor>
            </div>
          </>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowQuestionnaire((s) => !s)}
            className="flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
            aria-expanded={showQuestionnaire}
          >
            {showQuestionnaire ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Questionnaire
          </button>
          {showQuestionnaire && (
            <div className="mt-2 rounded-lg border border-line bg-subtle/50 p-3">
              <Markdown compact>{request.questionnaire}</Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Requests the analyst drafted for other stakeholders (IT, DPO, legal…). */
export function StakeholdersPanel({ view, actions, highlightId }: { view: SessionView; actions: SessionActions; highlightId?: string | null }) {
  if (!view.requests.length) {
    return (
      <EmptyState
        compact
        icon={Users}
        title="No one else needed yet"
        description="When you answer “I don't know — ask someone”, I draft an email with the exact questions for that person, plus a link where they can answer."
      />
    );
  }
  return (
    <div className="space-y-4">
      {view.requests.map((r) => (
        <RequestCard key={r.id} request={r} actions={actions} highlighted={highlightId === r.id} />
      ))}
    </div>
  );
}
