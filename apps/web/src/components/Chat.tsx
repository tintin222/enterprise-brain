import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BookOpen, MessageSquare, SendHorizontal, User, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { api, streamPost } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { ChatMessage, Citation, Conversation } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Logo } from "./Logo.tsx";
import { Markdown } from "./Markdown.tsx";
import { ErrorState, Spinner } from "./Spinner.tsx";

function withoutPendingQuestion(list: ChatMessage[], question: string): ChatMessage[] {
  const last = list[list.length - 1];
  return last && last.role === "user" && last.content.trim() === question ? list.slice(0, -1) : list;
}

function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-2.5 pl-1 text-xs text-fg hover:border-brand-400"
        aria-expanded={open}
      >
        <span className="flex size-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">{citation.n}</span>
        <span className="truncate">{citation.title}</span>
      </button>
      {open && (
        <span className="absolute bottom-full left-0 z-30 mb-1.5 block w-80 max-w-[80vw] animate-pop-in rounded-xl border border-line bg-surface p-3 text-left shadow-xl">
          <span className="flex items-start justify-between gap-2">
            <span className="text-[13px] font-semibold text-fg">{citation.title}</span>
            <Badge size="xs">{citation.collection}</Badge>
          </span>
          <span className="mt-1.5 block text-xs leading-relaxed text-muted">“{citation.snippet}”</span>
          <Link
            to={`/settings/knowledge?collection=${encodeURIComponent(citation.collection)}&doc=${encodeURIComponent(citation.documentId)}`}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
          >
            <BookOpen className="size-3.5" /> Open in Knowledge
          </Link>
        </span>
      )}
    </span>
  );
}

function AssistantMessage({ children, citations, at, name }: { children: ReactNode; citations?: Citation[]; at?: string; name: string }) {
  return (
    <div className="flex gap-3">
      <Logo className="size-8 rounded-lg shadow-sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">{name}</span>
          {at && (
            <time dateTime={at} title={formatDateTime(at)} className="text-[11px] text-faint">
              {timeAgo(at)}
            </time>
          )}
        </div>
        <div className="rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 shadow-xs">{children}</div>
        {citations && citations.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-faint">Sources</span>
            {citations.map((c) => (
              <CitationChip key={`${c.n}-${c.documentId}`} citation={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ children, pending }: { children: ReactNode; pending?: boolean }) {
  return (
    <div className={clsx("flex flex-row-reverse gap-3", pending && "opacity-70")}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
        <User className="size-4" />
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white shadow-sm dark:bg-brand-500">
        {children}
      </div>
    </div>
  );
}

/**
 * Conversation with the company assistant (no agent) or a conversational agent.
 * Streams the answer (`delta` events), then replaces it with the final message and its citations.
 */
export function ChatPanel({
  conversationId,
  agent,
  assistantName = "Assistant",
  suggestions = [],
  onConversationCreated,
  className,
  emptyTitle = "Ask anything about the company",
  emptyDescription = "Answers come from the company knowledge base, with sources you can check.",
}: {
  conversationId: string | null;
  agent?: string;
  assistantName?: string;
  suggestions?: string[];
  onConversationCreated?: (id: string) => void;
  className?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState<{ question: string; answer: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  const messages = useQuery({
    queryKey: [...keys.chat(company), conversationId, "messages"],
    queryFn: () => api.get<ChatMessage[]>(path(`/chat/conversations/${encodeURIComponent(conversationId ?? "")}/messages`)),
    enabled: Boolean(conversationId),
  });

  useEffect(() => () => abort.current?.abort(), []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const count = messages.data?.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [count, streaming?.answer.length, streaming?.question]);

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || streaming) return;
    setText("");
    setStreaming({ question, answer: "" });
    let id = conversationId;
    let created = false;
    try {
      if (!id) {
        const conversation = await api.post<Conversation>(path("/chat/conversations"), agent ? { agent } : {});
        id = conversation.id;
        created = true;
      }
      const controller = new AbortController();
      abort.current = controller;
      let failed: string | null = null;
      await streamPost(
        path(`/chat/conversations/${encodeURIComponent(id)}/messages/stream`),
        { text: question },
        (event, data) => {
          if (event === "delta") {
            const delta = (data as { delta?: string }).delta ?? "";
            setStreaming((s) => (s ? { ...s, answer: s.answer + delta } : s));
          } else if (event === "message") {
            const message = data as ChatMessage;
            queryClient.setQueryData<ChatMessage[]>([...keys.chat(company), id, "messages"], (old) => [
              ...withoutPendingQuestion(old ?? [], question),
              { id: `local-${Date.now()}`, role: "user", content: question, citations: [], createdAt: new Date().toISOString() },
              message,
            ]);
          } else if (event === "error") {
            failed = (data as { error?: string }).error ?? "The assistant could not answer";
          }
        },
        controller.signal,
      );
      if (failed) toast.error(failed);
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        toast.error(error);
        setText(question);
      }
    } finally {
      abort.current = null;
      setStreaming(null);
      if (id) {
        void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), id, "messages"] });
        void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), "conversations"] });
        // Tell the parent only now: it may remount this panel for the new conversation.
        if (created) onConversationCreated?.(id);
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  // While streaming, the server may already have stored the question: don't show it twice.
  const list = streaming ? withoutPendingQuestion(messages.data ?? [], streaming.question) : (messages.data ?? []);
  const empty = !list.length && !streaming;

  return (
    <div className={clsx("flex min-h-0 flex-col", className)}>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.error && <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />}
          {messages.isLoading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {empty && !messages.isLoading && (
            <div className="flex flex-col items-center py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
                <MessageSquare className="size-6" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-fg">{emptyTitle}</h2>
              <p className="mt-1 max-w-md text-sm text-muted">{emptyDescription}</p>
              {suggestions.length > 0 && (
                <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm text-fg shadow-xs transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:hover:bg-brand-400/5"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {list.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id}>{m.content}</UserMessage>
            ) : (
              <AssistantMessage key={m.id} citations={m.citations} at={m.createdAt} name={assistantName}>
                <Markdown compact>{m.content}</Markdown>
              </AssistantMessage>
            ),
          )}
          {streaming && (
            <>
              <UserMessage pending>{streaming.question}</UserMessage>
              <AssistantMessage name={assistantName}>
                {streaming.answer ? (
                  <Markdown compact>{streaming.answer}</Markdown>
                ) : (
                  <span className="flex items-center gap-2 text-sm text-muted">
                    <Spinner size="sm" /> Searching the knowledge base…
                  </span>
                )}
              </AssistantMessage>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-line bg-surface px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-line-strong bg-surface p-1.5 shadow-xs focus-within:border-brand-500 focus-within:ring-3 focus-within:ring-brand-500/20">
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${assistantName}…`}
            aria-label={`Message ${assistantName}`}
            className="max-h-[180px] min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg outline-none placeholder:text-faint"
          />
          {streaming ? (
            <Button variant="secondary" icon={X} onClick={() => abort.current?.abort()} aria-label="Stop">
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button variant="primary" icon={SendHorizontal} disabled={!text.trim()} onClick={() => void send(text)} aria-label="Send">
              <span className="hidden sm:inline">Send</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
