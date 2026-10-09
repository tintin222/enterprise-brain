import { clsx } from "clsx";
import { Brain, Compass, Hash, Lock, MessageSquarePlus, MessageSquareReply, Plus, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useCompany } from "../../lib/company.tsx";
import { GENERAL_CHANNEL, KIND_META, conversationTitle, isCompanyBrainTalk, othersIn, participantActor } from "../../lib/conversations.ts";
import { paths } from "../../lib/paths.ts";
import { useConversation, useConversations } from "../../lib/queries.ts";
import type { ConversationSummary } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { ErrorState, Skeleton } from "../Spinner.tsx";
import { ActorAvatar } from "./Actors.tsx";

/** How many threads the sidebar lists before "All threads". */
const THREADS_SHOWN = 6;

function Count({ item }: { item: ConversationSummary }) {
  if (item.mentionsMe > 0) {
    return (
      <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-bold text-white" title="Mentions you">
        @
      </span>
    );
  }
  if (item.unread > 0) {
    return (
      <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 font-bold text-white" title={`${item.unread} unread`}>
        {item.unread > 99 ? "99+" : item.unread}
      </span>
    );
  }
  return null;
}

function Row({
  to,
  icon,
  label,
  detail,
  strong,
  selected,
  trailing,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  strong?: boolean;
  selected?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        aria-current={selected ? "page" : undefined}
        className={clsx(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
          selected ? "bg-brand-50 text-fg dark:bg-brand-400/15" : "hover:bg-subtle",
          strong ? "font-semibold text-fg" : "text-fg/80",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {detail && <span className={clsx("block truncate text-[11px] font-normal", strong ? "text-fg/70" : "text-muted")}>{detail}</span>}
        </span>
        {trailing}
      </Link>
    </li>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-2 pt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
        {action}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function AddButton({ label, onClick, icon: Icon = Plus }: { label: string; onClick: () => void; icon?: typeof Plus }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md p-1 text-faint hover:bg-subtle hover:text-fg" aria-label={label} title={label}>
      <Icon className="size-3.5" />
    </button>
  );
}

const SIDEBAR_KINDS = ["channel", "dm", "ai_employee", "thread"] as const;

/**
 * The left of Chat: the channels the viewer is in, their direct messages (the company brain first) and
 * the threads they follow, with what is unread; the conversation open now when it is none of these.
 */
export function ChatSidebar({
  selectedId,
  threadsOpen,
  onNewChannel,
  onBrowse,
  onNewMessage,
}: {
  selectedId?: string;
  threadsOpen?: boolean;
  onNewChannel: () => void;
  onBrowse: () => void;
  onNewMessage: () => void;
}) {
  const { info } = useCompany();
  const list = useConversations({ scope: "mine", kinds: [...SIDEBAR_KINDS], limit: 200 });
  const current = useConversation(selectedId);
  const items = list.data ?? [];
  const channels = items
    .filter((c) => c.conversation.kind === "channel")
    .sort(
      (a, b) =>
        Number(b.conversation.aboutId === GENERAL_CHANNEL) - Number(a.conversation.aboutId === GENERAL_CHANNEL) ||
        (a.conversation.name ?? "").localeCompare(b.conversation.name ?? ""),
    );
  const direct = items
    .filter((c) => (c.conversation.kind === "dm" || c.conversation.kind === "ai_employee") && !isCompanyBrainTalk(c))
    .sort((a, b) => (b.conversation.lastMessageAt ?? b.conversation.createdAt).localeCompare(a.conversation.lastMessageAt ?? a.conversation.createdAt));
  const threads = items
    .filter((c) => c.conversation.kind === "thread")
    .sort(
      (a, b) =>
        Number(b.unread > 0 || b.mentionsMe > 0) - Number(a.unread > 0 || a.mentionsMe > 0) ||
        (b.conversation.lastMessageAt ?? b.conversation.createdAt).localeCompare(a.conversation.lastMessageAt ?? a.conversation.createdAt),
    );
  const brainTalk = items.find(isCompanyBrainTalk);
  const openNow =
    current.data && !(SIDEBAR_KINDS as readonly string[]).includes(current.data.conversation.kind) && current.data.conversation.kind !== "thread"
      ? current.data
      : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <h1 className="text-sm font-semibold text-fg">Chat</h1>
        <button
          type="button"
          onClick={onNewMessage}
          className="rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg"
          aria-label="New message"
          title="New message"
        >
          <MessageSquarePlus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {list.isLoading && <Skeleton className="m-3 h-40" />}
        {list.error && (
          <div className="p-3">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        {openNow && (
          <Section title="Open now">
            <Row
              to={paths.conversation(openNow.conversation.id)}
              icon={<OpenNowIcon kind={openNow.conversation.kind} />}
              label={conversationTitle(openNow.conversation, openNow.participants, openNow.me ? participantActor(openNow.me) : null)}
              detail={KIND_META[openNow.conversation.kind].label}
              selected
            />
          </Section>
        )}
        {list.data && (
          <>
            <Section title="Channels" action={<AddButton label="Add a channel" onClick={onNewChannel} />}>
              {channels.map((item) => (
                <Row
                  key={item.conversation.id}
                  to={paths.conversation(item.conversation.id)}
                  icon={item.conversation.visibility === "participants" ? <Lock className="size-3.5" /> : <Hash className="size-4" />}
                  label={item.conversation.name ?? item.conversation.title}
                  strong={item.unread > 0 || item.mentionsMe > 0}
                  selected={item.conversation.id === selectedId}
                  trailing={<Count item={item} />}
                />
              ))}
              <li>
                <button
                  type="button"
                  onClick={onBrowse}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-subtle hover:text-fg"
                >
                  <span className="flex size-5 items-center justify-center">
                    <Compass className="size-4" />
                  </span>
                  Browse channels
                </button>
              </li>
            </Section>
            <Section title="Direct messages" action={<AddButton label="New message" onClick={onNewMessage} />}>
              <Row
                to={brainTalk ? paths.conversation(brainTalk.conversation.id) : paths.companyBrainChat()}
                icon={<Brain className="size-4 text-brand-600 dark:text-brand-300" />}
                label="Company brain"
                strong={Boolean(brainTalk && (brainTalk.unread > 0 || brainTalk.mentionsMe > 0))}
                selected={Boolean(brainTalk && brainTalk.conversation.id === selectedId)}
                trailing={brainTalk ? <Count item={brainTalk} /> : undefined}
              />
              {direct.map((item) => {
                const me = item.me ? participantActor(item.me) : null;
                const others = item.participants.filter((p) => !(me && p.actorKind === me.kind && p.actorId === me.id));
                const first = others[0] ?? item.participants[0];
                const ai = item.conversation.kind === "ai_employee";
                return (
                  <Row
                    key={item.conversation.id}
                    to={paths.conversation(item.conversation.id)}
                    icon={first ? <ActorAvatar actor={participantActor(first)} size="xs" /> : <MessageSquarePlus className="size-4" />}
                    label={othersIn(item.participants, me).join(", ") || item.conversation.title || "Direct message"}
                    strong={item.unread > 0 || item.mentionsMe > 0}
                    selected={item.conversation.id === selectedId}
                    trailing={
                      <>
                        {ai && (
                          <Badge size="xs" tone="brand">
                            AI
                          </Badge>
                        )}
                        <Count item={item} />
                      </>
                    }
                  />
                );
              })}
              {direct.length === 0 && <li className="px-2 py-1 text-xs text-muted">Write to a colleague, or to an AI employee.</li>}
            </Section>
            {threads.length > 0 && (
              <Section
                title="Threads"
                action={
                  threads.length > THREADS_SHOWN ? (
                    <Link to={paths.threads()} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                      All {threads.length}
                    </Link>
                  ) : undefined
                }
              >
                {threads.slice(0, THREADS_SHOWN).map((item) => (
                  <Row
                    key={item.conversation.id}
                    to={
                      item.parent && item.conversation.aboutId
                        ? paths.thread(item.parent.id, item.conversation.aboutId)
                        : paths.conversation(item.conversation.id)
                    }
                    icon={<MessageSquareReply className="size-4" />}
                    label={item.conversation.title || "A message"}
                    detail={item.parent ? (item.parent.kind === "channel" ? `#${item.parent.name}` : item.parent.title || "Direct message") : undefined}
                    strong={item.unread > 0 || item.mentionsMe > 0}
                    selected={threadsOpen && item.conversation.id === selectedId}
                    trailing={<Count item={item} />}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
      <div className="border-t border-line p-3">
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          {info.llm.available
            ? "AI employees answer in a channel when you name them with @, and always in their direct message."
            : "Offline mode: AI employees answer with what they find, without writing it up."}
        </p>
      </div>
    </div>
  );
}

function OpenNowIcon({ kind }: { kind: ConversationSummary["conversation"]["kind"] }) {
  const Icon = KIND_META[kind].icon;
  return <Icon className="size-4" />;
}
