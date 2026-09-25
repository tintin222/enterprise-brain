import { clsx } from "clsx";
import { ChevronDown, ChevronRight, FileText, Mail, ScanText, Sparkles, User } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Logo } from "../../components/Logo.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { initials, timeAgo, formatDateTime } from "../../lib/format.ts";
import { stakeholderLabel } from "../../lib/labels.ts";
import type { BuilderMessage, SampleAnalysis, SessionView } from "../../types.ts";
import type { SessionActions } from "./actions.ts";
import { QuestionRound } from "./QuestionCards.tsx";

function Time({ at }: { at: string }) {
  return (
    <time dateTime={at} title={formatDateTime(at)} className="text-[11px] text-faint">
      {timeAgo(at)}
    </time>
  );
}

export function AnalystAvatar() {
  return <Logo className="size-8 rounded-lg shadow-sm" />;
}

function AnalystBubble({ children, at, label = "Requirements analyst" }: { children: ReactNode; at?: string; label?: string }) {
  return (
    <div className="flex gap-3">
      <AnalystAvatar />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">{label}</span>
          {at && <Time at={at} />}
        </div>
        {children}
      </div>
    </div>
  );
}

function SampleCards({ samples }: { samples: SampleAnalysis[] }) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {samples.map((s) => (
        <div key={s.fileId} className="rounded-lg border border-line bg-subtle/50 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-fg">
            <FileText className="size-3.5 shrink-0 text-muted" />
            <span className="truncate">{s.fileName}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.documentType && s.documentType !== "unknown" && (
              <Badge size="xs" tone="brand">
                {s.documentType}
              </Badge>
            )}
            {s.pages !== undefined && (
              <Badge size="xs">
                {s.pages} page{s.pages === 1 ? "" : "s"}
              </Badge>
            )}
            {s.language && <Badge size="xs">{s.language.toUpperCase()}</Badge>}
            {s.needsOcr && (
              <Badge size="xs" tone="amber" icon={ScanText}>
                OCR
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PastRound({ message }: { message: BuilderMessage }) {
  const [open, setOpen] = useState(false);
  const round = message.data.round;
  const count = round?.questions.length ?? 0;
  return (
    <div className="rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 shadow-xs">
      {round?.intro && (
        <Markdown compact className="mb-2">
          {round.intro}
        </Markdown>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-fg"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Round {round?.number ?? message.round} · {count} question{count === 1 ? "" : "s"}
        {round?.answeredAt && <span className="font-normal text-faint">— answered</span>}
      </button>
      {open && (
        <Markdown compact className="mt-2 border-t border-line pt-2">
          {message.content}
        </Markdown>
      )}
    </div>
  );
}

function RequestNotice({ view, requestId, onOpenRequest }: { view: SessionView; requestId: string; onOpenRequest: (id: string) => void }) {
  const request = view.requests.find((r) => r.id === requestId);
  if (!request) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 dark:border-amber-400/25 dark:bg-amber-400/10">
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <Mail className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <span className="min-w-0">
          <span className="font-medium text-fg">Request for {stakeholderLabel(request.role)}</span>
          <span className="text-muted">
            {" "}
            · {request.questions.length} question{request.questions.length === 1 ? "" : "s"}
          </span>
        </span>
        <StatusPill status={request.status} size="xs" />
      </div>
      <Button size="xs" variant="secondary" onClick={() => onOpenRequest(request.id)}>
        {request.status === "draft" ? "Review & send" : "View request"}
      </Button>
    </div>
  );
}

export function TypingIndicator({ label = "The analyst is thinking…" }: { label?: string }) {
  return (
    <AnalystBubble>
      <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 text-sm text-muted shadow-xs">
        <span className="flex gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-brand-400" />
        </span>
        {label}
      </div>
    </AnalystBubble>
  );
}

export function UserBubble({
  children,
  at,
  name,
  pending,
  attachments,
}: {
  children: ReactNode;
  at?: string;
  name?: string | null;
  pending?: boolean;
  attachments?: { fileId: string; name: string }[];
}) {
  return (
    <div className={clsx("flex flex-row-reverse gap-3", pending && "opacity-70")}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
        {name ? initials(name) : <User className="size-4" />}
      </div>
      <div className="flex max-w-[85%] min-w-0 flex-col items-end">
        <div className="mb-1 flex items-center gap-2">
          {at && <Time at={at} />}
          <span className="text-xs font-semibold text-fg">{name || "You"}</span>
        </div>
        <div className="rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-white shadow-sm dark:bg-brand-500 [&_.md_a]:text-white [&_.md_code]:border-white/20 [&_.md_code]:bg-white/15 [&_.md_li::marker]:text-white/70">
          {children}
        </div>
        {attachments && attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap justify-end gap-1">
            {attachments.map((a) => (
              <Badge key={a.fileId} size="xs" icon={FileText}>
                {a.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The builder conversation: analyst bubbles (left), user bubbles (right),
 * system notes (centered). The current round renders as interactive question cards.
 */
export function Transcript({
  view,
  actions,
  onOpenRequest,
  pendingText,
}: {
  view: SessionView;
  actions: SessionActions;
  onOpenRequest: (id: string) => void;
  pendingText?: string | null;
}) {
  const { messages, currentRound, session } = view;
  const lastSummaryId = [...messages].reverse().find((m) => m.data?.summary)?.id;
  // The message that asked the current round (fallback: the last analyst round message).
  const currentRoundMessageId =
    currentRound &&
    ([...messages].reverse().find((m) => m.data?.round?.number === currentRound.number)?.id ??
      [...messages].reverse().find((m) => m.role === "analyst" && m.round === currentRound.number)?.id);

  const renderMessage = (m: BuilderMessage): ReactNode => {
    if (m.role === "system") {
      return (
        <div key={m.id} className="flex justify-center">
          <div className="max-w-[90%] rounded-xl bg-subtle px-3.5 py-2 text-center text-xs text-muted">
            <Markdown compact className="text-xs [&_ul]:text-left">
              {m.content}
            </Markdown>
            <Time at={m.createdAt} />
          </div>
        </div>
      );
    }
    if (m.role === "user") {
      return (
        <UserBubble key={m.id} at={m.createdAt} name={session.requesterName} attachments={m.attachments}>
          <Markdown compact>{m.content}</Markdown>
        </UserBubble>
      );
    }
    const isRound = Boolean(m.data?.round);
    if (isRound && m.id === currentRoundMessageId && currentRound) {
      return (
        <AnalystBubble key={m.id} at={m.createdAt}>
          {(currentRound.intro || m.data.round?.intro) && (
            <div className="mb-3 rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 shadow-xs">
              <Markdown compact>{currentRound.intro ?? m.data.round?.intro ?? ""}</Markdown>
            </div>
          )}
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
            <Sparkles className="size-3.5 text-brand-500" /> Round {currentRound.number} — answer with the buttons, or type below
          </p>
          <QuestionRound key={currentRound.number} round={currentRound} view={view} actions={actions} />
        </AnalystBubble>
      );
    }
    if (isRound) {
      return (
        <AnalystBubble key={m.id} at={m.createdAt}>
          <PastRound message={m} />
        </AnalystBubble>
      );
    }
    return (
      <AnalystBubble key={m.id} at={m.createdAt}>
        <div className="rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 shadow-xs">
          <Markdown compact>{m.content}</Markdown>
          {m.data?.samples && m.data.samples.length > 0 && <SampleCards samples={m.data.samples} />}
          {m.data?.requestId && <RequestNotice view={view} requestId={m.data.requestId} onOpenRequest={onOpenRequest} />}
          {m.id === lastSummaryId && session.status === "confirming" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Button variant="primary" icon={Sparkles} loading={actions.confirm.isPending} onClick={() => actions.confirm.mutate()}>
                Confirm and hire
              </Button>
              <span className="text-xs text-muted">Nothing is hired until you confirm.</span>
            </div>
          )}
          {m.data?.agentId && view.agent && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
              <ButtonLink size="sm" variant="soft" to={`/apps/${view.agent.slug}`}>
                Open its page
              </ButtonLink>
              <ButtonLink size="sm" variant="ghost" to={`/ai/${view.agent.slug}`}>
                Agent details
              </ButtonLink>
            </div>
          )}
        </div>
      </AnalystBubble>
    );
  };

  return (
    <div className="space-y-5">
      {messages.map((m) => (
        <div key={m.id} data-message="" className="scroll-mt-20">
          {renderMessage(m)}
        </div>
      ))}
      {pendingText !== undefined && pendingText !== null && (
        <>
          {pendingText && (
            <UserBubble name={session.requesterName} pending>
              <Markdown compact>{pendingText}</Markdown>
            </UserBubble>
          )}
          <TypingIndicator />
        </>
      )}
    </div>
  );
}
