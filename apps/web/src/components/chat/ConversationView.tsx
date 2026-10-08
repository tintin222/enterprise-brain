import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowDown, ArrowLeft, CornerUpLeft, ExternalLink, MessagesSquare, Reply, UserPlus } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, fileUrl, subscribe } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { KIND_META, VISIBILITY_LABELS, conversationTitle, participantActor, placeholderFor, sameActor } from "../../lib/conversations.ts";
import { formatDate, formatDateTime } from "../../lib/format.ts";
import { MENTION_ICONS } from "../../lib/mentions.ts";
import { keys, useConversation } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { Actor, MentionHit, Message, Participant } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { Button, ButtonLink } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { FileChip } from "../Dropzone.tsx";
import { Markdown } from "../Markdown.tsx";
import { ErrorState, Spinner } from "../Spinner.tsx";
import { WorkItemCard } from "../WorkItemCard.tsx";
import { ActorAvatar } from "./Actors.tsx";
import { Composer, type ComposerSend } from "./Composer.tsx";
import { useMentionHits } from "./MentionPicker.tsx";

const PAGE = 50;

function upsert(list: Message[] | undefined, message: Message): Message[] {
  const rest = (list ?? []).filter((m) => m.id !== message.id);
  rest.push(message);
  return rest.sort((a, b) => a.seq - b.seq);
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(date, today) ? "Today" : same(date, yesterday) ? "Yesterday" : formatDate(iso);
}

/** Two text messages by the same author within five minutes read as one. */
function continues(previous: Message | undefined, message: Message): boolean {
  if (!previous || previous.kind !== "text" || message.kind !== "text" || message.replyToId) return false;
  if (!sameActor(previous.author, message.author)) return false;
  return new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
}

function AuthorLine({ message, extra }: { message: Message; extra?: ReactNode }) {
  const { author } = message;
  return (
    <p className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="font-semibold text-fg">{author.name}</span>
      {author.kind === "ai_employee" && (
        <Badge size="xs" tone="brand">
          AI
        </Badge>
      )}
      <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)} className="text-faint">
        {clock(message.createdAt)}
      </time>
      {extra}
    </p>
  );
}

function MessageRow({
  message,
  previous,
  replyTo,
  onReply,
}: {
  message: Message;
  previous?: Message;
  replyTo?: Message;
  onReply?: (message: Message) => void;
}) {
  const { company } = useCompany();
  if (message.kind === "system") {
    return (
      <li className="flex justify-center px-4 py-1.5">
        <p className="max-w-xl text-center text-xs text-muted">
          {message.plain}{" "}
          <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)} className="text-faint">
            · {clock(message.createdAt)}
          </time>
        </p>
      </li>
    );
  }
  if (message.kind === "card") {
    return (
      <li className="px-4 py-2 sm:px-6">
        <div className="flex gap-3">
          <ActorAvatar actor={message.author} />
          <div className="min-w-0 max-w-2xl flex-1">
            <AuthorLine message={message} />
            {message.card ? (
              <WorkItemCard entry={message.card} showAgent={false} />
            ) : (
              <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">This item is no longer there.</p>
            )}
          </div>
        </div>
      </li>
    );
  }
  const continued = continues(previous, message);
  const steps =
    message.author.kind === "ai_employee" && message.runId ? (
      <Link to={`/runs/${message.runId}`} className="text-faint hover:text-fg hover:underline">
        how it worked
      </Link>
    ) : null;
  return (
    <li className={clsx("group relative px-4 sm:px-6", continued ? "py-0.5" : "pt-3 pb-0.5")}>
      <div className="flex gap-3">
        {continued ? (
          <span
            className="w-8 shrink-0 pt-1 text-right text-[10px] leading-4 text-faint opacity-0 group-hover:opacity-100"
            title={formatDateTime(message.createdAt)}
          >
            {clock(message.createdAt)}
          </span>
        ) : (
          <ActorAvatar actor={message.author} />
        )}
        <div className="min-w-0 flex-1">
          {!continued && <AuthorLine message={message} extra={steps} />}
          {message.replyToId && (
            <p className="mb-1 flex items-center gap-1 truncate text-xs text-muted">
              <CornerUpLeft className="size-3 shrink-0" />
              {replyTo ? (
                <>
                  Replying to <span className="font-medium text-fg/80">{replyTo.author.name}</span>: {replyTo.plain.slice(0, 80)}
                </>
              ) : (
                "Replying to an earlier message"
              )}
            </p>
          )}
          {message.text.trim() && (
            <Markdown compact breaks={message.author.kind !== "ai_employee"} mentions={message.mentions} className="text-sm">
              {message.text}
            </Markdown>
          )}
          {message.files.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {message.files.map((file) => (
                <a key={file.id} href={fileUrl(company, file.id, true)} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full">
                  <FileChip name={file.name} size={file.size} className="hover:border-brand-400" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
      {onReply && (
        <button
          type="button"
          onClick={() => onReply(message)}
          className="absolute top-1 right-4 hidden items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] text-muted shadow-xs group-hover:inline-flex hover:text-fg sm:right-6"
          aria-label={`Reply to ${message.author.name}`}
        >
          <Reply className="size-3" /> Reply
        </button>
      )}
    </li>
  );
}

function ParticipantsStack({ participants }: { participants: Participant[] }) {
  const shown = participants.slice(0, 5);
  return (
    <div className="hidden items-center sm:flex" title={participants.map((p) => p.actorName).join(", ")}>
      <div className="flex -space-x-1">
        {shown.map((p) => (
          <ActorAvatar key={p.id} actor={participantActor(p)} size="sm" className="ring-2 ring-surface" />
        ))}
      </div>
      {participants.length > shown.length && <span className="ml-1.5 text-xs text-muted">+{participants.length - shown.length}</span>}
    </div>
  );
}

/** Bring a person or an AI employee in: they see the whole conversation. */
function InviteDialog({
  conversationId,
  participants,
  open,
  onClose,
}: {
  conversationId: string;
  participants: Participant[];
  open: boolean;
  onClose: () => void;
}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const hits = useMentionHits(open ? q : null, { conversationId, kinds: ["person", "ai_employee"] });
  const present = new Set(participants.map((p) => `${p.actorKind}:${p.actorId}`));
  const invite = useMutation({
    mutationFn: (hit: MentionHit) => api.post(path(`/conversations/${encodeURIComponent(conversationId)}/participants`), { kind: hit.kind, id: hit.id }),
    onSuccess: (_, hit) => {
      toast.success(`${hit.name} is in the conversation`);
      void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), conversationId], exact: true });
    },
    onError: (error) => toast.error(error),
  });
  const candidates = (hits.data ?? []).filter((h) => !present.has(`${h.kind}:${h.id}`));
  return (
    <Dialog open={open} onClose={onClose} title="Bring someone in" description="People of your departments, and AI employees. They see the whole conversation.">
      <input className="input" placeholder="A name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Who to bring in" />
      <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {candidates.length === 0 && <li className="px-3 py-3 text-sm text-muted">{hits.isFetching ? "Looking…" : "Nobody else to add."}</li>}
        {candidates.map((hit) => {
          const Icon = MENTION_ICONS[hit.kind];
          return (
            <li key={`${hit.kind}:${hit.id}`} className="flex items-center gap-3 px-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{hit.name}</span>
                {hit.detail && <span className="block truncate text-xs text-muted">{hit.detail}</span>}
              </span>
              <Button size="xs" variant="soft" icon={UserPlus} loading={invite.isPending && invite.variables?.id === hit.id} onClick={() => invite.mutate(hit)}>
                Add
              </Button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

export interface ConversationViewProps {
  id: string;
  /** Inside another page (a task, an AI employee): without the header. */
  embedded?: boolean;
  className?: string;
  /** Narrow screens: back to the list. */
  onBack?: () => void;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  /** Offered when nothing was said yet; a click sends it. */
  suggestions?: string[];
  /** Sent once when the view opens (a question typed elsewhere). */
  initialText?: string;
  onSentInitial?: () => void;
}

/**
 * One conversation: its messages (people, AI employees, the cards they put in front of people),
 * live through the server's event stream, with the composer at the bottom.
 */
export function ConversationView({
  id,
  embedded,
  className,
  onBack,
  emptyTitle = "Nothing said yet",
  emptyDescription = "Write something. Name a person, an AI employee or anything of the company with @, and the AI employees can look it up.",
  suggestions = [],
  initialText,
  onSentInitial,
}: ConversationViewProps) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const view = useConversation(id);
  const messagesKey = useMemo(() => [...keys.conversations(company), id, "messages"] as const, [company, id]);
  const messages = useQuery({
    queryKey: messagesKey,
    queryFn: () => api.get<Message[]>(path(`/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}`)),
    staleTime: Infinity,
  });
  const list = messages.data ?? [];
  const lastSeq = list[list.length - 1]?.seq ?? 0;
  const lastSeqRef = useRef(0);
  if (lastSeq > lastSeqRef.current) lastSeqRef.current = lastSeq;
  const [working, setWorking] = useState<Map<string, Actor>>(() => new Map());
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [inviting, setInviting] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [fresh, setFresh] = useState(0);
  const stuck = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), "list"] });
  }, [queryClient, company]);
  const apply = useCallback((message: Message) => queryClient.setQueryData<Message[]>(messagesKey, (old) => upsert(old, message)), [queryClient, messagesKey]);
  const onEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === "message" || event === "card") {
        const { message } = data as { message: Message };
        apply(message);
        if (event === "card") void queryClient.invalidateQueries({ queryKey: keys.work(company) });
        invalidateLists();
      } else if (event === "working") {
        const { actor, on } = data as { actor: Actor; on: boolean };
        setWorking((current) => {
          const next = new Map(current);
          const key = `${actor.kind}:${actor.id}`;
          if (on) next.set(key, actor);
          else next.delete(key);
          return next;
        });
      } else if (event === "participants") {
        void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), id], exact: true });
      }
    },
    [apply, queryClient, company, id, invalidateLists],
  );

  // Live: once the first page is here, listen from its last message on; when the server closes the
  // stream, listen again from the last message seen (nothing is missed, nothing shown twice).
  useEffect(() => {
    if (!messages.isSuccess) return;
    let closed = false;
    let attempt = 0;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (closed) return;
      stop = subscribe(
        path(`/conversations/${encodeURIComponent(id)}/stream?after=${lastSeqRef.current}`),
        ["message", "card", "working", "participants"],
        (event, data) => {
          attempt = 0;
          onEvent(event, data);
        },
        () => {
          if (closed) return;
          attempt += 1;
          timer = setTimeout(open, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
        },
      );
    };
    open();
    return () => {
      closed = true;
      stop?.();
      if (timer) clearTimeout(timer);
    };
  }, [id, messages.isSuccess, path, onEvent]);

  // Read marks: what the viewer has in front of them counts as read (and the badges follow).
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  const readRef = useRef(0);
  useEffect(() => {
    const me = view.data?.me;
    if (me) readRef.current = Math.max(readRef.current, me.readSeq);
    if (!view.data || !visible || lastSeq <= readRef.current) return;
    const timer = setTimeout(() => {
      readRef.current = lastSeq;
      api
        .post(path(`/conversations/${encodeURIComponent(id)}/read`), { seq: lastSeq })
        .then(invalidateLists)
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [view.data, visible, lastSeq, id, path, invalidateLists]);

  // Scrolling: stay at the bottom while the viewer is there; otherwise count what arrived.
  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setFresh(0);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      return;
    }
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [list.length, working.size]);
  useEffect(() => {
    if (!stuck.current && lastSeq) setFresh((f) => f + 1);
  }, [lastSeq]);

  const earlier = useMutation({
    mutationFn: () => api.get<Message[]>(path(`/conversations/${encodeURIComponent(id)}/messages?before=${list[0]?.seq ?? 0}&limit=${PAGE}`)),
    onSuccess: (older) => {
      const el = scroller.current;
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      if (older.length < PAGE) setNoMore(true);
      queryClient.setQueryData<Message[]>(messagesKey, (old) => older.reduce((acc, m) => upsert(acc, m), old ?? []));
    },
    onError: (error) => toast.error(error),
  });

  const send = useCallback(
    async (input: ComposerSend) => {
      const message = await api.post<Message>(path(`/conversations/${encodeURIComponent(id)}/messages`), {
        text: input.text,
        fileIds: input.fileIds,
        replyToId: input.replyToId,
      });
      apply(message);
      scrollToBottom();
      invalidateLists();
      // The first message makes the poster a participant: the header follows.
      if (!view.data?.me) void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), id], exact: true });
    },
    [path, id, apply, scrollToBottom, invalidateLists, view.data?.me, queryClient, company],
  );

  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialText?.trim() || sentInitial.current || !view.data || !messages.isSuccess) return;
    sentInitial.current = true;
    send({ text: initialText.trim(), fileIds: [], replyToId: null })
      .then(() => onSentInitial?.())
      .catch((error) => toast.error(error));
  }, [initialText, view.data, messages.isSuccess, send, onSentInitial, toast]);

  if (view.isLoading || (messages.isLoading && !messages.data)) {
    return (
      <div className={clsx("flex items-center justify-center", className)}>
        <Spinner />
      </div>
    );
  }
  if (view.error || !view.data) {
    return (
      <div className={clsx("p-6", className)}>
        <ErrorState error={view.error} onRetry={() => void view.refetch()} />
      </div>
    );
  }

  const { conversation, participants, me, canInvite, about } = view.data;
  const meta = KIND_META[conversation.kind];
  const KindIcon = meta.icon;
  const title = conversationTitle(conversation, participants, me ? participantActor(me) : null);
  const byId = new Map(list.map((m) => [m.id, m]));
  const archived = conversation.status !== "open";
  const empty = list.length === 0 && messages.isSuccess;
  // Messages are numbered from 1 without gaps: earlier ones exist while the first shown is not #1.
  const hasEarlier = !noMore && (list[0]?.seq ?? 1) > 1;
  let lastDay = "";

  return (
    <div className={clsx("flex min-h-0 flex-col", className)}>
      {!embedded && (
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-6">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg lg:hidden"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
          <KindIcon className="hidden size-5 shrink-0 text-muted sm:block" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-fg">{title}</h1>
            <p className="truncate text-xs text-muted">
              {meta.label} · {VISIBILITY_LABELS[conversation.visibility]} ·{" "}
              {participants.length === 1 ? "1 participant" : `${participants.length} participants`}
            </p>
          </div>
          <ParticipantsStack participants={participants} />
          {about && (
            <ButtonLink to={about.href} size="sm" variant="ghost" icon={ExternalLink}>
              <span className="hidden sm:inline">{about.label}</span>
            </ButtonLink>
          )}
          {(canInvite || me) && !archived && (
            <Button size="sm" icon={UserPlus} onClick={() => setInviting(true)}>
              <span className="hidden sm:inline">Invite</span>
            </Button>
          )}
        </header>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (stuck.current) setFresh(0);
        }}
        className="min-h-0 flex-1 overflow-y-auto py-3"
      >
        {messages.error && (
          <div className="px-6">
            <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
          </div>
        )}
        {hasEarlier && (
          <div className="flex justify-center pb-2">
            <Button size="xs" variant="ghost" loading={earlier.isPending} onClick={() => earlier.mutate()}>
              Earlier messages
            </Button>
          </div>
        )}
        {empty && (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
              <MessagesSquare className="size-6" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-fg">{emptyTitle}</h2>
            <p className="mt-1 max-w-md text-sm text-muted">{emptyDescription}</p>
            {suggestions.length > 0 && !archived && (
              <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send({ text: s, fileIds: [], replyToId: null }).catch((error) => toast.error(error))}
                    className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm text-fg shadow-xs transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:hover:bg-brand-400/5"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <ul>
          {list.map((message, i) => {
            const day = dayLabel(message.createdAt);
            const separator = day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={message.id}>
                {separator && (
                  <li className="my-2 flex items-center gap-3 px-6 text-[11px] font-medium text-faint" aria-hidden="true">
                    <span className="h-px flex-1 bg-line" />
                    {day}
                    <span className="h-px flex-1 bg-line" />
                  </li>
                )}
                <MessageRow
                  message={message}
                  previous={separator ? undefined : list[i - 1]}
                  replyTo={message.replyToId ? byId.get(message.replyToId) : undefined}
                  onReply={archived ? undefined : setReplyTo}
                />
              </Fragment>
            );
          })}
        </ul>
        {working.size > 0 && (
          <div className="space-y-1.5 px-4 pt-3 sm:px-6">
            {[...working.values()].map((actor) => (
              <p key={`${actor.kind}:${actor.id}`} className="flex items-center gap-2 text-xs text-muted">
                <ActorAvatar actor={actor} size="sm" />
                <Spinner size="sm" /> {actor.name} is working…
              </p>
            ))}
          </div>
        )}
      </div>
      {fresh > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-brand-700"
          >
            <ArrowDown className="size-3" /> New messages
          </button>
        </div>
      )}
      <div className={clsx("shrink-0 border-t border-line bg-surface", embedded ? "px-3 py-2.5" : "px-4 py-3 sm:px-6")}>
        {archived ? (
          <p className="text-center text-sm text-muted">This conversation is archived.</p>
        ) : (
          <Composer
            conversationId={id}
            onSend={send}
            replyTo={replyTo ? { id: replyTo.id, author: replyTo.author.name, text: replyTo.plain.slice(0, 120) } : null}
            onCancelReply={() => setReplyTo(null)}
            compact={embedded}
            autoFocus={!embedded}
            placeholder={placeholderFor(conversation, participants)}
          />
        )}
      </div>
      <InviteDialog conversationId={id} participants={participants} open={inviting} onClose={() => setInviting(false)} />
    </div>
  );
}
