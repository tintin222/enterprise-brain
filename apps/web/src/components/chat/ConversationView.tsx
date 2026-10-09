import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowDown, Hash, MessagesSquare } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, subscribe } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { conversationTitle, participantActor, placeholderFor } from "../../lib/conversations.ts";
import { keys, messagesKey, useConversation } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { Actor, Message } from "../../types.ts";
import { Button } from "../Button.tsx";
import { ErrorState, Spinner } from "../Spinner.tsx";
import { ActorAvatar } from "./Actors.tsx";
import { Composer, type ComposerIntent, type ComposerSend } from "./Composer.tsx";
import { ConversationHeader } from "./ConversationHeader.tsx";
import { MembersDialog } from "./MembersDialog.tsx";
import { MessageRow, dayLabel, upsert } from "./MessageRow.tsx";

const PAGE = 50;

export interface ConversationViewProps {
  id: string;
  /** Inside another page (a task, an AI employee, a thread pane): without the header, with the compact composer. */
  embedded?: boolean;
  /** The header to show instead of the usual one (`null` for none). */
  header?: ReactNode;
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
  /** Open the composer ready to give work or to teach the brain (where offered). */
  initialIntent?: ComposerIntent;
  /** Where threads are offered (channels, direct messages, talks): "Reply in thread" and the replies line under messages. */
  onOpenThread?: (message: Message) => void;
  /** A thread pane: the message the thread is under changed (a reaction on it, say). */
  onRootUpdated?: (message: Message) => void;
  /** Shown above the messages (a thread's root message). */
  lead?: ReactNode;
  canReact?: boolean;
}

/**
 * One conversation: its messages (people, AI employees, the cards they put in front of people),
 * live through the server's event stream, with the composer at the bottom.
 */
export function ConversationView({
  id,
  embedded,
  header,
  className,
  onBack,
  emptyTitle = "Nothing said yet",
  emptyDescription = "Write something. Name a person, an AI employee or anything of the company with @, and the AI employees can look it up.",
  suggestions = [],
  initialText,
  onSentInitial,
  initialIntent,
  onOpenThread,
  onRootUpdated,
  lead,
  canReact = true,
}: ConversationViewProps) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const view = useConversation(id);
  const key = messagesKey(company, id);
  const messages = useQuery({
    queryKey: key,
    queryFn: () => api.get<Message[]>(path(`/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}`)),
    staleTime: Infinity,
  });
  const list = messages.data ?? [];
  const lastSeq = list[list.length - 1]?.seq ?? 0;
  const lastSeqRef = useRef(0);
  if (lastSeq > lastSeqRef.current) lastSeqRef.current = lastSeq;
  const [working, setWorking] = useState<Map<string, Actor>>(() => new Map());
  const [members, setMembers] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [fresh, setFresh] = useState(0);
  const stuck = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), "list"] });
  }, [queryClient, company]);
  const invalidateView = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), id], exact: true });
  }, [queryClient, company, id]);
  const apply = useCallback(
    (message: Message) => {
      // What this conversation's stream says about a message of another one (a thread's root) is not ours to list.
      if (message.conversationId !== id) {
        onRootUpdated?.(message);
        return;
      }
      queryClient.setQueryData<Message[]>(key, (old) => upsert(old, message));
    },
    [queryClient, key, id, onRootUpdated],
  );
  const onEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === "message" || event === "card") {
        const { message } = data as { message: Message };
        apply(message);
        if (event === "card") void queryClient.invalidateQueries({ queryKey: keys.work(company) });
        invalidateLists();
      } else if (event === "updated") {
        apply((data as { message: Message }).message);
      } else if (event === "working") {
        const { actor, on } = data as { actor: Actor; on: boolean };
        setWorking((current) => {
          const next = new Map(current);
          const actorKey = `${actor.kind}:${actor.id}`;
          if (on) next.set(actorKey, actor);
          else next.delete(actorKey);
          return next;
        });
      } else if (event === "participants") {
        invalidateView();
      }
    },
    [apply, queryClient, company, invalidateLists, invalidateView],
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
        ["message", "card", "updated", "working", "participants"],
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
      queryClient.setQueryData<Message[]>(key, (old) => older.reduce((acc, m) => upsert(acc, m), old ?? []));
    },
    onError: (error) => toast.error(error),
  });

  const send = useCallback(
    async (input: ComposerSend) => {
      const message = await api.post<Message>(path(`/conversations/${encodeURIComponent(id)}/messages`), {
        text: input.text,
        fileIds: input.fileIds,
        replyToId: input.replyToId,
        ...(input.intent !== "send" ? { intent: input.intent } : {}),
      });
      apply(message);
      scrollToBottom();
      invalidateLists();
      // The first message makes the poster a participant: the header follows.
      if (!view.data?.me) invalidateView();
    },
    [path, id, apply, scrollToBottom, invalidateLists, view.data?.me, invalidateView],
  );

  const join = useMutation({
    mutationFn: () => api.post(path(`/conversations/${encodeURIComponent(id)}/join`)),
    onSuccess: () => {
      invalidateView();
      invalidateLists();
    },
    onError: (error) => toast.error(error),
  });

  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialText?.trim() || sentInitial.current || !view.data || !messages.isSuccess) return;
    sentInitial.current = true;
    send({ text: initialText.trim(), fileIds: [], replyToId: null, intent: "send" })
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

  const { conversation, participants, me, offers } = view.data;
  const myself = me ? participantActor(me) : null;
  const byId = new Map(list.map((m) => [m.id, m]));
  const archived = conversation.status !== "open";
  const empty = list.length === 0 && messages.isSuccess;
  // A channel open to you that you are not in yet: read it, join it to write.
  const outside = conversation.kind === "channel" && !me;
  // Messages are numbered from 1 without gaps: earlier ones exist while the first shown is not #1.
  const hasEarlier = !noMore && (list[0]?.seq ?? 1) > 1;
  let lastDay = "";

  return (
    <div className={clsx("flex min-h-0 flex-col", className)}>
      {!embedded && header === undefined ? <ConversationHeader view={view.data} onBack={onBack} onMembers={() => setMembers(true)} /> : header}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (stuck.current) setFresh(0);
        }}
        className="min-h-0 flex-1 overflow-y-auto py-3"
      >
        {lead}
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
              {conversation.kind === "channel" ? <Hash className="size-6" /> : <MessagesSquare className="size-6" />}
            </div>
            <h2 className="mt-4 text-base font-semibold text-fg">
              {conversation.kind === "channel" ? `This is the start of #${conversation.name}` : emptyTitle}
            </h2>
            <p className="mt-1 max-w-md text-sm text-muted">
              {conversation.kind === "channel" ? conversation.title || "Nothing has been said here yet." : emptyDescription}
            </p>
            {suggestions.length > 0 && !archived && !outside && (
              <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send({ text: s, fileIds: [], replyToId: null, intent: "send" }).catch((error) => toast.error(error))}
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
                  onChanged={apply}
                  onOpenThread={archived ? undefined : onOpenThread}
                  canReact={canReact && !archived && Boolean(me)}
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
          <p className="text-center text-sm text-muted">This {conversation.kind === "channel" ? "channel" : "conversation"} is archived.</p>
        ) : outside ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-subtle px-4 py-3">
            <p className="text-sm text-fg">
              You are reading <span className="font-semibold">{conversationTitle(conversation, participants, myself)}</span>. Join it to write here.
            </p>
            <Button variant="primary" size="sm" icon={Hash} loading={join.isPending} onClick={() => join.mutate()}>
              Join {conversationTitle(conversation, participants, myself)}
            </Button>
          </div>
        ) : (
          <Composer
            conversationId={id}
            onSend={send}
            compact={embedded}
            autoFocus={!embedded}
            placeholder={placeholderFor(conversation, participants, myself)}
            offers={offers}
            initialIntent={initialIntent}
          />
        )}
      </div>
      {!embedded && <MembersDialog view={view.data} open={members} onClose={() => setMembers(false)} />}
    </div>
  );
}
