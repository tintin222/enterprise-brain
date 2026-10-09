import { clsx } from "clsx";
import { Brain, Hash, MessageSquarePlus, MessageSquareReply, MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "../../components/Button.tsx";
import { BrowseChannelsDialog } from "../../components/chat/BrowseChannelsDialog.tsx";
import { ChatSidebar } from "../../components/chat/ChatSidebar.tsx";
import { ConversationView } from "../../components/chat/ConversationView.tsx";
import { NewChannelDialog } from "../../components/chat/NewChannelDialog.tsx";
import { NewMessageDialog } from "../../components/chat/NewMessageDialog.tsx";
import { ThreadPane } from "../../components/chat/ThreadPane.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorState, LoadingBlock, Skeleton } from "../../components/Spinner.tsx";
import { GENERAL_CHANNEL, repliesText } from "../../lib/conversations.ts";
import { formatDateTime, timeAgo } from "../../lib/format.ts";
import { paths } from "../../lib/paths.ts";
import { FOR_KINDS, useConversation, useConversationFor, useConversations, type ForKind } from "../../lib/queries.ts";
import { readStorage, writeStorage } from "../../lib/storage.ts";
import { useDocumentTitle } from "../../lib/title.ts";

/** Where threads can be opened from: channels, direct messages and talks with an AI employee. */
const THREADABLE = ["channel", "dm", "ai_employee"] as const;
/** The last conversation opened: /chat comes back to it. */
const LAST_KEY = "eb.chat.last";

/** `/chat/for/:kind/:about`: the conversation about something, then its own address (with `?q=`, `?teach=1`, `?work=1`). */
function ResolveFor({ kind, about, search }: { kind: ForKind; about: string; search: string }) {
  const navigate = useNavigate();
  const found = useConversationFor(kind, about);
  useEffect(() => {
    if (!found.data) return;
    const { conversation } = found.data;
    // A thread opens in its channel or direct message, with the thread pane.
    if (conversation.kind === "thread" && conversation.parentId && conversation.aboutId)
      navigate(paths.thread(conversation.parentId, conversation.aboutId), { replace: true });
    else navigate(paths.conversation(conversation.id) + (search ? `?${search}` : ""), { replace: true });
  }, [found.data, navigate, search]);
  if (found.error) {
    return (
      <div className="p-6">
        <ErrorState error={found.error} onRetry={() => void found.refetch()} />
      </div>
    );
  }
  return <LoadingBlock className="flex-1" />;
}

/** Every thread the viewer follows, the unread ones first. */
function ThreadsList() {
  const list = useConversations({ scope: "mine", kinds: ["thread"], limit: 200 });
  const items = [...(list.data ?? [])].sort(
    (a, b) =>
      Number(b.unread > 0 || b.mentionsMe > 0) - Number(a.unread > 0 || a.mentionsMe > 0) ||
      (b.conversation.lastMessageAt ?? b.conversation.createdAt).localeCompare(a.conversation.lastMessageAt ?? a.conversation.createdAt),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <MessageSquareReply className="size-5 text-muted" />
        <div>
          <h1 className="text-sm font-semibold text-fg">Threads</h1>
          <p className="text-xs text-muted">The threads you wrote in or were named in.</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {list.isLoading && <Skeleton className="h-32" />}
        {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && items.length === 0 && (
          <EmptyState
            icon={MessageSquareReply}
            title="No threads yet"
            description="Reply in a thread under any message of a channel or direct message, and it shows here."
          />
        )}
        <ul className="space-y-1">
          {items.map((item) => {
            const { conversation, parent } = item;
            const strong = item.unread > 0 || item.mentionsMe > 0;
            const to = parent && conversation.aboutId ? paths.thread(parent.id, conversation.aboutId) : paths.conversation(conversation.id);
            return (
              <li key={conversation.id}>
                <Link to={to} className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 hover:border-brand-400">
                  <MessageSquareReply className="mt-0.5 size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={clsx("truncate text-sm", strong ? "font-semibold text-fg" : "font-medium text-fg/90")}>
                        {conversation.title || "A message"}
                      </span>
                      {conversation.lastMessageAt && (
                        <time
                          className="shrink-0 text-[11px] text-faint"
                          dateTime={conversation.lastMessageAt}
                          title={formatDateTime(conversation.lastMessageAt)}
                        >
                          {timeAgo(conversation.lastMessageAt)}
                        </time>
                      )}
                    </span>
                    <span className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">
                        {parent ? (parent.kind === "channel" ? `#${parent.name}` : parent.title || "Direct message") : "A conversation"} ·{" "}
                        {repliesText(conversation.lastSeq)}
                        {item.lastMessage && ` · ${item.lastMessage.author.name}: ${item.lastMessage.text}`}
                      </span>
                      {item.mentionsMe > 0 ? (
                        <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-bold text-white">@</span>
                      ) : item.unread > 0 ? (
                        <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 font-bold text-white">{item.unread}</span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Welcome({ onNewChannel, onNewMessage }: { onNewChannel: () => void; onNewMessage: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={MessagesSquare}
        className="max-w-lg border-0"
        title="Pick a channel, or write to someone"
        description="Channels for teams and topics, direct messages for a few people. Name an AI employee with @ anywhere, and it answers; name anything of the company, and it can look it up."
        action={
          <>
            <Button variant="primary" icon={Hash} onClick={onNewChannel}>
              New channel
            </Button>
            <Button icon={MessageSquarePlus} onClick={onNewMessage}>
              New message
            </Button>
            <Link
              to={paths.companyBrainChat()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg shadow-xs hover:bg-subtle"
            >
              <Brain className="size-4 text-brand-600 dark:text-brand-300" /> Ask the company brain
            </Link>
          </>
        }
      />
    </div>
  );
}

/** Chat: channels, direct messages and threads with people and AI employees, three panes wide, one at a time on a phone. */
export default function Chat() {
  const { id, kind, about } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  useDocumentTitle("Chat");
  const threadsPage = location.pathname.replace(/\/+$/, "") === paths.threads();
  const threadId = params.get("thread");
  const [dialog, setDialog] = useState<"channel" | "browse" | "message" | null>(null);
  const legacy = params.get("c");
  const q = params.get("q") ?? undefined;
  // Opened to teach the brain or to give work: the composer starts that way (where it is offered).
  const intent = params.get("teach") ? "teach" : params.get("work") ? "work" : undefined;
  const forwarded = new URLSearchParams([...params].filter(([key]) => key === "q" || key === "teach" || key === "work")).toString();
  const open = Boolean(id || kind || threadsPage);
  const current = useConversation(id);
  const mine = useConversations({ scope: "mine", kinds: ["channel", "dm", "ai_employee", "thread"], limit: 200 });
  const [wide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);

  useEffect(() => {
    if (id && current.data && current.data.conversation.kind !== "thread") writeStorage(LAST_KEY, id);
  }, [id, current.data]);

  // /chat on a wide screen opens the last conversation seen, else #general; a phone shows the list.
  useEffect(() => {
    if (open || legacy || !wide || !mine.data) return;
    const last = readStorage(LAST_KEY);
    const target =
      (last && mine.data.find((c) => c.conversation.id === last)) ??
      mine.data.find((c) => c.conversation.kind === "channel" && c.conversation.aboutId === GENERAL_CHANNEL);
    if (target) navigate(paths.conversation(target.conversation.id), { replace: true });
  }, [open, legacy, wide, mine.data, navigate]);

  if (!open && legacy) return <Navigate to={paths.conversation(legacy)} replace />;
  // A thread's own address opens its channel or direct message with the thread pane.
  if (id && current.data?.conversation.kind === "thread" && current.data.conversation.parentId && current.data.conversation.aboutId) {
    return <Navigate to={paths.thread(current.data.conversation.parentId, current.data.conversation.aboutId)} replace />;
  }

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: key === "q" });
  };
  const threadable = current.data ? (THREADABLE as readonly string[]).includes(current.data.conversation.kind) : false;
  const threadOpen = Boolean(id && threadId && threadable);

  return (
    <div className="flex min-h-0 flex-1 lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:overflow-hidden">
      <aside className={clsx("w-full shrink-0 border-r border-line bg-surface lg:block lg:w-64", open ? "hidden" : "block")}>
        <ChatSidebar
          selectedId={id}
          threadsOpen={threadsPage}
          onNewChannel={() => setDialog("channel")}
          onBrowse={() => setDialog("browse")}
          onNewMessage={() => setDialog("message")}
        />
      </aside>
      <div className={clsx("min-w-0 flex-1 flex-col", open ? (threadOpen ? "hidden xl:flex" : "flex") : "hidden lg:flex")}>
        {threadsPage ? (
          <ThreadsList />
        ) : kind && about ? (
          (FOR_KINDS as readonly string[]).includes(kind) ? (
            <ResolveFor kind={kind as ForKind} about={about} search={forwarded} />
          ) : (
            <div className="p-6">
              <EmptyState
                icon={MessagesSquare}
                title="No such conversation"
                description="A conversation is about a task, a thing of the brain, an AI employee, a person, or a message's thread."
              />
            </div>
          )
        ) : id ? (
          <ConversationView
            key={id}
            id={id}
            onBack={() => navigate(paths.chat())}
            initialText={q}
            onSentInitial={() => setParam("q", null)}
            initialIntent={intent}
            onOpenThread={threadable ? (message) => setParam("thread", message.id) : undefined}
            className="min-h-[70vh] flex-1 lg:min-h-0"
          />
        ) : (
          <Welcome onNewChannel={() => setDialog("channel")} onNewMessage={() => setDialog("message")} />
        )}
      </div>
      {threadOpen && threadId && (
        <ThreadPane
          key={threadId}
          rootId={threadId}
          onClose={() => setParam("thread", null)}
          className="min-w-0 flex-1 xl:w-[380px] xl:flex-none xl:border-l xl:border-line 2xl:w-[440px]"
        />
      )}
      <NewChannelDialog open={dialog === "channel"} onClose={() => setDialog(null)} />
      <BrowseChannelsDialog open={dialog === "browse"} onClose={() => setDialog(null)} onNew={() => setDialog("channel")} />
      <NewMessageDialog open={dialog === "message"} onClose={() => setDialog(null)} />
    </div>
  );
}
