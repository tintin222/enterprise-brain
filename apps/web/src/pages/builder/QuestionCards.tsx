import { clsx } from "clsx";
import { Check, CheckCheck, Hourglass, Info, Lightbulb, SendHorizontal, Sparkles, Undo2, UserRoundSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Dropzone } from "../../components/Dropzone.tsx";
import { Chip } from "../../components/Form.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { DELEGATE_ROLES, stakeholderLabel } from "../../lib/labels.ts";
import type { BuilderRound, ReplyAnswer, RoundQuestion, SessionView, StakeholderRole } from "../../types.ts";
import type { SessionActions } from "./actions.ts";
import { DemoSamplesButton } from "../../components/DemoSamples.tsx";
import { formatAnswer, hasRecommendation, recommendationText } from "./utils.ts";

export type CardAnswer = { kind: "value"; value: unknown } | { kind: "accept" } | { kind: "delegate"; role: StakeholderRole } | { kind: "skip" };

const LIST_TYPES = new Set(["fields", "criteria", "categories"]);

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function isFilled(answer: CardAnswer | undefined): boolean {
  if (!answer) return false;
  if (answer.kind !== "value") return true;
  const v = answer.value;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function toReply(question: RoundQuestion, answer: CardAnswer): ReplyAnswer {
  const nodeId = question.nodeId;
  switch (answer.kind) {
    case "accept":
      return { nodeId, action: "accept" };
    case "skip":
      return { nodeId, action: "skip" };
    case "delegate":
      return { nodeId, action: "delegate", delegateTo: answer.role };
    case "value": {
      let value = answer.value;
      if (question.answerType === "single" && value === "ask-it") return { nodeId, action: "delegate", delegateTo: "it" };
      if (LIST_TYPES.has(question.answerType) && typeof value === "string") value = lines(value);
      if (question.answerType === "number" && typeof value === "string") {
        const n = Number(value.replace(",", "."));
        value = Number.isFinite(n) ? n : value;
      }
      if (typeof value === "string") value = value.trim();
      return { nodeId, action: "answer", value };
    }
  }
}

// ---------------------------------------------------------------------------
// Delegation picker
// ---------------------------------------------------------------------------

function DelegateMenu({ question, onPick }: { question: RoundQuestion; onPick: (role: StakeholderRole) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const preferred = question.owner !== "requester" ? question.owner : undefined;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const roles = [...DELEGATE_ROLES].sort((a, b) => (a.value === preferred ? -1 : b.value === preferred ? 1 : 0));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted hover:bg-subtle hover:text-fg"
      >
        <UserRoundSearch className="size-4" />
        I don't know — ask someone
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-64 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-lg" role="menu">
          <p className="px-2.5 pt-1.5 pb-1 text-xs text-muted">Who should answer? I'll draft the request for them.</p>
          {roles.map((r) => (
            <button
              key={r.value}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(r.value);
              }}
              className={clsx(
                "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-subtle",
                r.value === preferred && "bg-brand-50/70 font-medium dark:bg-brand-400/10",
              )}
            >
              {r.label}
              {r.value === preferred && <span className="text-[11px] text-brand-600 dark:text-brand-300">suggested</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answer controls
// ---------------------------------------------------------------------------

function AnswerControl({
  question,
  answer,
  onChange,
  actions,
  sampleCount,
}: {
  question: RoundQuestion;
  answer: CardAnswer | undefined;
  onChange: (answer: CardAnswer | undefined) => void;
  actions: SessionActions;
  sampleCount: number;
}) {
  const value = answer?.kind === "value" ? answer.value : undefined;
  const set = (v: unknown) => onChange({ kind: "value", value: v });
  const options = question.options ?? [];

  switch (question.answerType) {
    case "single":
      return (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={question.title}>
          {options.map((o) => (
            <Chip key={o.value} role="radio" selected={value === o.value} title={o.description} onClick={() => (value === o.value ? onChange(undefined) : set(o.value))}>
              {value === o.value && <Check className="size-3.5" />}
              {o.label}
            </Chip>
          ))}
          {!options.length && (
            <input className="input" placeholder="Your answer" value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value)} />
          )}
        </div>
      );
    case "multi": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-2" role="group" aria-label={question.title}>
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <Chip
                key={o.value}
                role="checkbox"
                selected={on}
                title={o.description}
                onClick={() => {
                  const next = on ? selected.filter((v) => v !== o.value) : [...selected, o.value];
                  onChange(next.length ? { kind: "value", value: next } : undefined);
                }}
              >
                {on && <Check className="size-3.5" />}
                {o.label}
              </Chip>
            );
          })}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex gap-2" role="radiogroup" aria-label={question.title}>
          {[
            { v: true, label: "Yes" },
            { v: false, label: "No" },
          ].map((o) => (
            <Chip key={o.label} role="radio" selected={value === o.v} onClick={() => (value === o.v ? onChange(undefined) : set(o.v))}>
              {value === o.v && <Check className="size-3.5" />}
              {o.label}
            </Chip>
          ))}
        </div>
      );
    case "number":
      return (
        <input
          type="number"
          inputMode="decimal"
          className="input max-w-xs"
          placeholder="Enter a number"
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(e) => (e.target.value ? set(e.target.value) : onChange(undefined))}
        />
      );
    case "fields":
    case "criteria":
    case "categories": {
      const text = typeof value === "string" ? value : "";
      const recommended = Array.isArray(question.recommended) ? (question.recommended as unknown[]).map(String) : [];
      const hint =
        question.answerType === "criteria"
          ? "One criterion per line — add (must), (nice) or (knockout), e.g. “5+ years of Python (must)”"
          : question.answerType === "categories"
            ? "One category per line"
            : "One item per line";
      return (
        <div>
          <textarea
            rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
            className="input"
            placeholder={recommended.length ? recommended.join("\n") : hint}
            value={text}
            onChange={(e) => (e.target.value.trim() ? set(e.target.value) : onChange(undefined))}
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">{hint}</p>
            {recommended.length > 0 && !text && (
              <button type="button" onClick={() => set(recommended.join("\n"))} className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
                Start from the recommendation
              </button>
            )}
          </div>
        </div>
      );
    }
    case "files":
      return (
        <div className="space-y-2">
          <Dropzone
            busy={actions.uploadSamples.isPending}
            label="Drop sample files here or click to browse"
            hint="PDF, Word, images (scans/photos), Excel, emails — anonymised if needed. I analyse them right away."
            onFiles={(files) => actions.uploadSamples.mutate(files)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <DemoSamplesButton busy={actions.demoSamples.isPending} onPick={(ids) => actions.demoSamples.mutate(ids)} />
            <Chip selected={answer?.kind === "skip"} onClick={() => onChange(answer?.kind === "skip" ? undefined : { kind: "skip" })}>
              I don't have samples yet
            </Chip>
            {sampleCount > 0 && (
              <Badge tone="green" icon={Check}>
                {sampleCount} sample{sampleCount === 1 ? "" : "s"} analysed
              </Badge>
            )}
          </div>
        </div>
      );
    default: {
      const text = typeof value === "string" ? value : "";
      return (
        <textarea
          rows={2}
          className="input"
          placeholder="Your answer"
          value={text}
          onChange={(e) => (e.target.value.trim() ? set(e.target.value) : onChange(e.target.value ? { kind: "value", value: e.target.value } : undefined))}
        />
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function QuestionCard({
  question,
  answer,
  onChange,
  actions,
  sampleCount,
}: {
  question: RoundQuestion;
  answer: CardAnswer | undefined;
  onChange: (answer: CardAnswer | undefined) => void;
  actions: SessionActions;
  sampleCount: number;
}) {
  const recommendation = hasRecommendation(question) ? recommendationText(question) : undefined;
  const accepted = answer?.kind === "accept";
  const delegated = answer?.kind === "delegate" ? answer.role : undefined;
  const filled = isFilled(answer);

  return (
    <div
      className={clsx(
        "rounded-xl border bg-surface p-4 shadow-xs transition-colors",
        delegated ? "border-amber-300 dark:border-amber-400/40" : accepted ? "border-brand-300 dark:border-brand-400/40" : filled ? "border-emerald-300 dark:border-emerald-400/40" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-brand-700 dark:text-brand-300">
          Q{question.number} · {question.title}
        </p>
        {question.owner !== "requester" && (
          <Badge tone="neutral" size="xs" title="Who usually knows this">
            Usually {stakeholderLabel(question.owner)}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-fg">{question.question}</p>
      {question.why && (
        <p className="mt-1.5 flex gap-1.5 text-xs text-muted">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="font-medium">Why this matters:</span> {question.why}
          </span>
        </p>
      )}

      {delegated ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
          <span className="flex items-center gap-2">
            <Hourglass className="size-4" /> I'll ask {stakeholderLabel(delegated)} and draft the email for you.
          </span>
          <button type="button" onClick={() => onChange(undefined)} className="inline-flex items-center gap-1 text-xs font-medium hover:underline">
            <Undo2 className="size-3.5" /> Undo
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <AnswerControl question={question} answer={answer} onChange={onChange} actions={actions} sampleCount={sampleCount} />
        </div>
      )}

      {recommendation && !delegated && (
        <div
          className={clsx(
            "mt-3 flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between",
            accepted ? "border-brand-300 bg-brand-50 dark:border-brand-400/40 dark:bg-brand-400/10" : "border-dashed border-line-strong bg-subtle/50",
          )}
        >
          <div className="flex min-w-0 gap-2 text-[13px] text-fg">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <Markdown compact className="min-w-0 [&_p]:my-0">
              {recommendation}
            </Markdown>
          </div>
          <Button
            size="xs"
            variant={accepted ? "primary" : "soft"}
            icon={accepted ? Check : Sparkles}
            onClick={() => onChange(accepted ? undefined : { kind: "accept" })}
            className="shrink-0 self-start sm:self-auto"
          >
            {accepted ? "Using recommendation" : "Use recommendation"}
          </Button>
        </div>
      )}

      {!delegated && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <DelegateMenu question={question} onPick={(role) => onChange({ kind: "delegate", role })} />
          {filled && answer?.kind === "value" && (
            <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
              <Check className="size-3.5" /> {question.answerType === "text" ? "Answered" : formatAnswer(question, toReply(question, answer).value)}
            </span>
          )}
          {answer?.kind === "skip" && <span className="text-xs text-muted">Skipped</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------

/** The interactive question cards of the current round, with a sticky "Send answers" bar. */
export function QuestionRound({ round, view, actions }: { round: BuilderRound; view: SessionView; actions: SessionActions }) {
  const [answers, setAnswers] = useState<Record<string, CardAnswer>>({});
  const questions = round.questions;
  const filled = questions.filter((q) => isFilled(answers[q.nodeId]));
  const recommendable = questions.filter((q) => hasRecommendation(q) && !isFilled(answers[q.nodeId]));
  const sampleCount = view.session.samples?.length ?? 0;

  const setAnswer = (nodeId: string, answer: CardAnswer | undefined) =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (answer) next[nodeId] = answer;
      else delete next[nodeId];
      return next;
    });

  const send = () => {
    const payload = questions.filter((q) => isFilled(answers[q.nodeId])).map((q) => toReply(q, answers[q.nodeId]!));
    if (!payload.length) return;
    actions.reply.mutate({ answers: payload }, { onSuccess: () => setAnswers({}) });
  };

  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <QuestionCard key={q.nodeId} question={q} answer={answers[q.nodeId]} onChange={(a) => setAnswer(q.nodeId, a)} actions={actions} sampleCount={sampleCount} />
      ))}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface/95 px-3 py-2.5 shadow-lg shadow-slate-900/5 backdrop-blur">
        <span className="text-[13px] text-muted">
          <span className="font-semibold text-fg tabular-nums">{filled.length}</span> of {questions.length} answered
          {filled.length < questions.length && <span className="hidden sm:inline"> — unanswered questions stay open</span>}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {recommendable.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              icon={CheckCheck}
              onClick={() =>
                setAnswers((prev) => {
                  const next = { ...prev };
                  for (const q of recommendable) next[q.nodeId] = { kind: "accept" };
                  return next;
                })
              }
            >
              Accept all recommendations
            </Button>
          )}
          <Button size="sm" variant="primary" icon={SendHorizontal} disabled={!filled.length} loading={actions.reply.isPending} onClick={send}>
            Send answers{filled.length ? ` (${filled.length})` : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}
