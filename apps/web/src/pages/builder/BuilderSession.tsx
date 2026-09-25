import { clsx } from "clsx";
import {
  ArrowLeft,
  ClipboardList,
  ExternalLink,
  Hourglass,
  LayoutTemplate,
  MessageSquare,
  Paperclip,
  Rocket,
  SendHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { isApiError } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { FileChip } from "../../components/Dropzone.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorState, LoadingBlock, Spinner } from "../../components/Spinner.tsx";
import { Segmented, Tabs } from "../../components/Tabs.tsx";
import { archetypeLabel } from "../../lib/labels.ts";
import { useBuilderSession } from "../../lib/queries.ts";
import type { SessionView } from "../../types.ts";
import { useSessionActions, type SessionActions } from "./actions.ts";
import { BlueprintPanel } from "./BlueprintPanel.tsx";
import { JobPanel } from "./JobPanel.tsx";
import { DemoSamplesButton } from "../../components/DemoSamples.tsx";
import { RequirementsPanel } from "./RequirementsPanel.tsx";
import { SamplesPanel } from "./SamplesPanel.tsx";
import { StakeholdersPanel } from "./StakeholdersPanel.tsx";
import { Transcript } from "./Transcript.tsx";
import { useDocumentTitle } from "../../lib/title.ts";

type PanelTab = "job" | "blueprint" | "requirements" | "stakeholders" | "samples";

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SessionHeader({ view }: { view: SessionView }) {
  const { session, progress, llm } = view;
  return (
    <div className="shrink-0 border-b border-line bg-surface px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/hire" className="-ml-1 rounded-lg p-1 text-muted hover:bg-subtle hover:text-fg" aria-label="All builder sessions">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-fg">{session.title}</h1>
        <StatusPill status={session.status} />
        {session.archetype && (
          <Badge tone="neutral" className="hidden sm:inline-flex">
            {archetypeLabel(session.archetype)}
          </Badge>
        )}
        <div className="ml-auto">
          {llm.available ? (
            <Badge tone="brand" icon={Sparkles} title={`${llm.provider} ${llm.model}`}>
              AI analyst · {llm.model}
            </Badge>
          ) : (
            <Badge tone="amber" title="Set ANTHROPIC_API_KEY for Claude; the platform runs with deterministic fallbacks">
              Offline analyst (checklist mode)
            </Badge>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div
          className="h-2 w-full max-w-sm flex-1 overflow-hidden rounded-full bg-subtle ring-1 ring-line ring-inset"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Requirements settled"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-[width] duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <span className="text-xs text-muted">
          <span className="font-semibold text-fg tabular-nums">{progress.percent}%</span> · {progress.settled} of {progress.total} requirements settled
          {progress.delegated > 0 && <span className="text-amber-700 dark:text-amber-300"> · {progress.delegated} waiting on others</span>}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status actions
// ---------------------------------------------------------------------------

function GeneratingSteps() {
  const steps = ["Writing its job description from your answers", "Hiring it and creating its page", "Trying it on your samples"];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setActive((a) => Math.min(a + 1, steps.length - 1)), 4000);
    return () => window.clearInterval(timer);
  }, [steps.length]);
  return (
    <ol className="mt-2 space-y-1">
      {steps.map((s, i) => (
        <li key={s} className={clsx("flex items-center gap-2 text-[13px]", i <= active ? "text-fg" : "text-faint")}>
          {i < active ? <span className="size-4 text-center text-emerald-500">✓</span> : i === active ? <Spinner size="sm" /> : <span className="size-4" />}
          {s}
        </li>
      ))}
    </ol>
  );
}

function StatusBar({ view, actions, onShowRequests }: { view: SessionView; actions: SessionActions; onShowRequests: () => void }) {
  const { session, agent } = view;
  const openRequests = view.requests.filter((r) => r.status !== "answered").length;
  switch (session.status) {
    case "awaiting-stakeholders":
      return (
        <div className="flex flex-wrap items-center gap-3 border-t border-amber-200 bg-amber-50/80 px-4 py-3 sm:px-6 dark:border-amber-400/20 dark:bg-amber-400/10">
          <Hourglass className="hidden size-5 shrink-0 text-amber-600 sm:block dark:text-amber-300" />
          <div className="min-w-[16rem] flex-1 text-[13px] text-amber-950 dark:text-amber-100">
            <p className="font-semibold">Waiting on others{openRequests ? ` — ${openRequests} request${openRequests === 1 ? "" : "s"} open` : ""}</p>
            <p className="hidden opacity-90 sm:block">
              Everything on your side is done. You can continue now with assumptions — it works on manual uploads and demo data until the other teams answer.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={onShowRequests}>
              Review requests
            </Button>
            <Button size="sm" variant="primary" loading={actions.proceed.isPending} onClick={() => actions.proceed.mutate()}>
              Continue with assumptions
            </Button>
          </div>
        </div>
      );
    case "confirming":
      return (
        <div className="flex flex-wrap items-center gap-3 border-t border-brand-200 bg-brand-50/80 px-4 py-3 sm:px-6 dark:border-brand-400/20 dark:bg-brand-400/10">
          <ClipboardList className="hidden size-5 shrink-0 text-brand-600 sm:block dark:text-brand-300" />
          <div className="min-w-[16rem] flex-1 text-[13px] text-brand-950 dark:text-brand-100">
            <p className="font-semibold">Ready to hire</p>
            <p className="hidden opacity-90 sm:block">Review the summary above. Nothing is hired until you confirm, or tell me what to change.</p>
          </div>
          <Button
            variant="primary"
            icon={WandSparkles}
            loading={actions.confirm.isPending}
            onClick={() => actions.confirm.mutate()}
            className="ml-auto shrink-0"
          >
            Confirm and hire
          </Button>
        </div>
      );
    case "generating":
      return (
        <div className="border-t border-violet-200 bg-violet-50/80 px-4 py-3 sm:px-6 dark:border-violet-400/20 dark:bg-violet-400/10">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-violet-950 dark:text-violet-100">
            <Spinner size="sm" /> Hiring it and trying it on your samples…
          </p>
          <GeneratingSteps />
        </div>
      );
    case "testing":
      return (
        <div className="flex flex-wrap items-center gap-3 border-t border-emerald-200 bg-emerald-50/80 px-4 py-3 sm:px-6 dark:border-emerald-400/20 dark:bg-emerald-400/10">
          <div className="min-w-[16rem] flex-1 text-[13px] text-emerald-950 dark:text-emerald-100">
            <p className="font-semibold">{agent?.name ?? "Your AI employee"} is hired and on trial</p>
            <p className="hidden opacity-90 sm:block">Check how it did on your samples above. Tell me what to change, or put it to work when you're happy.</p>
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap gap-2">
            {agent && (
              <>
                <ButtonLink size="sm" variant="secondary" icon={ExternalLink} to={`/ai/${agent.slug}`}>
                  Open its page
                </ButtonLink>
              </>
            )}
            <Button size="sm" variant="success" icon={Rocket} loading={actions.activate.isPending} onClick={() => actions.activate.mutate()}>
              Put to work
            </Button>
          </div>
        </div>
      );
    case "deployed":
      return (
        <div className="flex flex-wrap items-center gap-3 border-t border-emerald-200 bg-emerald-50/80 px-4 py-3 sm:px-6 dark:border-emerald-400/20 dark:bg-emerald-400/10">
          <Rocket className="hidden size-5 shrink-0 text-emerald-600 sm:block dark:text-emerald-300" />
          <div className="min-w-[16rem] flex-1 text-[13px] text-emerald-950 dark:text-emerald-100">
            <p className="font-semibold">{agent?.name ?? "Your AI employee"} is at work</p>
            <p className="hidden opacity-90 sm:block">
              Its duties run on their own now; what needs a person comes to your team's Work queue. You can still ask me for changes here.
            </p>
          </div>
          {agent && (
            <div className="ml-auto flex shrink-0 gap-2">
              <ButtonLink size="sm" variant="success" icon={ExternalLink} to={`/ai/${agent.slug}`}>
                Open its page
              </ButtonLink>
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function placeholderFor(status: string): string {
  switch (status) {
    case "confirming":
      return "Reply “confirm”, or tell me what to change…";
    case "testing":
      return "Ask for a change, or say “put to work”…";
    case "deployed":
      return "Ask for a change…";
    case "awaiting-stakeholders":
      return "Add something, or answer on behalf of a stakeholder…";
    default:
      return "Type your answers, or ask the analyst anything…";
  }
}

function Composer({ view, actions, onSending }: { view: SessionView; actions: SessionActions; onSending: (text: string | null) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const status = view.session.status;
  const disabled = status === "generating";
  const busy = actions.reply.isPending || actions.replyWithFiles.isPending;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if ((!value && !files.length) || busy || disabled) return;
    onSending(value);
    const done = {
      onSuccess: () => {
        setText("");
        setFiles([]);
      },
      onSettled: () => onSending(null),
    };
    if (files.length) actions.replyWithFiles.mutate({ text: value, files }, done);
    else actions.reply.mutate({ text: value }, done);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-3 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <FileChip key={`${f.name}-${i}`} name={f.name} size={f.size} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div
          className={clsx(
            "relative flex items-end gap-2 rounded-xl border border-line-strong bg-surface p-1.5 shadow-xs focus-within:border-brand-500 focus-within:ring-3 focus-within:ring-brand-500/20",
            disabled && "opacity-60",
          )}
        >
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-fg"
            aria-label="Attach sample files"
            title="Attach sample files"
          >
            <Paperclip className="size-[18px]" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) setFiles((prev) => [...prev, ...picked]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholderFor(status)}
            aria-label="Message the analyst"
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm text-fg outline-none placeholder:text-faint"
          />
          <Button
            variant="primary"
            size="md"
            icon={SendHorizontal}
            onClick={send}
            loading={busy}
            disabled={disabled || (!text.trim() && !files.length)}
            aria-label="Send"
          >
            <span className="hidden sm:inline">Send</span>
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            {status === "interviewing" ? (
              <>
                Answer by number: <code className="rounded bg-subtle px-1 py-px font-mono text-[11px]">1 yes, 2 b, 3 don't know — ask IT</code>
                <span className="hidden md:inline"> · </span>
              </>
            ) : null}
            <span className="hidden md:inline">Enter to send, Shift+Enter for a new line</span>
          </span>
          {status === "interviewing" && (
            <DemoSamplesButton busy={actions.demoSamples.isPending} onPick={(ids) => actions.demoSamples.mutate(ids)} className="[&>button]:py-0.5" />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SessionScreen({ view }: { view: SessionView }) {
  const actions = useSessionActions(view.session.id);
  useDocumentTitle(`${view.session.title} · Studio`);
  const [tab, setTab] = useState<PanelTab>("job");
  const [pane, setPane] = useState<"chat" | "design">("chat");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [sendingText, setSendingText] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  const openRequests = view.requests.filter((r) => r.status !== "answered").length;
  const draftRequests = view.requests.filter((r) => r.status === "draft").length;
  const busyWithoutText =
    (actions.reply.isPending && sendingText === null) || actions.demoSamples.isPending || actions.uploadSamples.isPending || actions.proceed.isPending;
  const pendingText = sendingText !== null ? sendingText : busyWithoutText ? "" : null;

  const openRequest = (id: string) => {
    setTab("stakeholders");
    setHighlight(id);
    setPane("design");
    window.setTimeout(() => setHighlight(null), 2500);
  };

  // Auto-scroll to the newest message (its start when it's taller than the viewport).
  const messageCount = view.messages.length;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const behavior: ScrollBehavior = firstScroll.current ? "auto" : "smooth";
    firstScroll.current = false;
    const nodes = el.querySelectorAll<HTMLElement>("[data-message]");
    const last = nodes[nodes.length - 1];
    if (el.scrollHeight <= el.clientHeight + 1) {
      // Narrow screens: the page scrolls, not the transcript.
      last?.scrollIntoView({ behavior, block: "start" });
      return;
    }
    if (last && last.offsetHeight > el.clientHeight * 0.75) {
      el.scrollTo({ top: last.offsetTop - 16, behavior });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, [messageCount, view.currentRound?.number]);

  useEffect(() => {
    if (pendingText === null) return;
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [pendingText]);

  const tabs = [
    { id: "job" as const, label: "Job" },
    { id: "blueprint" as const, label: "Steps" },
    { id: "requirements" as const, label: "Answers" },
    { id: "stakeholders" as const, label: "Requests", count: view.requests.length || undefined, alert: draftRequests > 0 || openRequests > 0 },
    { id: "samples" as const, label: "Samples", count: view.session.samples?.length || undefined },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:overflow-hidden">
      <SessionHeader view={view} />
      <div className="flex justify-center border-b border-line bg-surface px-4 py-2 xl:hidden">
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            {
              value: "chat",
              label: (
                <span className="flex items-center gap-1.5">
                  <MessageSquare className="size-3.5" /> Conversation
                </span>
              ),
            },
            {
              value: "design",
              label: (
                <span className="flex items-center gap-1.5">
                  <LayoutTemplate className="size-3.5" /> Design
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_440px] 2xl:grid-cols-[minmax(0,1fr)_500px]">
        <section className={clsx("min-h-0 flex-col", pane === "chat" ? "flex" : "hidden xl:flex")} aria-label="Conversation">
          <div ref={scroller} className="relative min-h-[50vh] flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:min-h-0">
            <div className="mx-auto max-w-3xl">
              <Transcript view={view} actions={actions} onOpenRequest={openRequest} pendingText={pendingText} />
            </div>
          </div>
          <div className="sticky bottom-0 z-10 bg-surface lg:static">
            <StatusBar view={view} actions={actions} onShowRequests={() => openRequest(view.requests.find((r) => r.status !== "answered")?.id ?? "")} />
            <Composer view={view} actions={actions} onSending={setSendingText} />
          </div>
        </section>
        <aside
          className={clsx("min-h-0 flex-col border-line bg-surface xl:border-l", pane === "design" ? "flex" : "hidden xl:flex")}
          aria-label="Job description"
        >
          <Tabs tabs={tabs} value={tab} onChange={setTab} size="sm" fill className="shrink-0 px-1" />
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {tab === "job" && <JobPanel view={view} />}
            {tab === "blueprint" && <BlueprintPanel draft={view.draft} />}
            {tab === "requirements" && <RequirementsPanel view={view} actions={actions} />}
            {tab === "stakeholders" && <StakeholdersPanel view={view} actions={actions} highlightId={highlight} />}
            {tab === "samples" && <SamplesPanel view={view} actions={actions} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function BuilderSessionPage() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = useBuilderSession(id);
  if (isLoading) return <LoadingBlock label="Loading the conversation…" className="flex-1" />;
  if (isApiError(error, 404) || (!data && !error)) {
    return (
      <div className="p-6">
        <EmptyState
          icon={WandSparkles}
          title="This builder session doesn't exist"
          description="It may belong to another company, or it was removed."
          action={
            <ButtonLink to="/hire" variant="primary">
              All sessions
            </ButtonLink>
          }
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }
  return <SessionScreen view={data} />;
}
