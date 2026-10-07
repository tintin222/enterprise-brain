import { clsx } from "clsx";
import { KIND_META, conversationTitle, participantActor } from "../../lib/conversations.ts";
import { formatDateTime, timeAgo } from "../../lib/format.ts";
import type { ConversationSummary } from "../../types.ts";

function preview(item: ConversationSummary): string {
  const last = item.lastMessage;
  if (!last) return "Nothing said yet";
  if (last.kind === "card") return `${last.author.name} needs someone`;
  if (last.kind === "system") return last.text;
  return `${last.author.name}: ${last.text}`;
}

/** The viewer's conversations: what each is about, who wrote last, and what they haven't read. */
export function ConversationList({
  items,
  selectedId,
  onSelect,
}: {
  items: ConversationSummary[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const { conversation } = item;
        const Icon = KIND_META[conversation.kind].icon;
        const selected = conversation.id === selectedId;
        const strong = item.unread > 0;
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              aria-current={selected ? "true" : undefined}
              className={clsx(
                "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left",
                selected ? "bg-brand-50 dark:bg-brand-400/15" : "hover:bg-subtle",
              )}
            >
              <span
                className={clsx(
                  "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
                  conversation.kind === "ai_employee" ? "bg-gradient-to-br from-brand-500 to-violet-600 text-white" : "bg-subtle text-muted",
                )}
              >
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={clsx("truncate text-[13px]", strong ? "font-semibold text-fg" : "font-medium text-fg/90")}>
                    {conversationTitle(conversation, item.participants, item.me ? participantActor(item.me) : null)}
                  </span>
                  {item.lastMessage && (
                    <time className="shrink-0 text-[11px] text-faint" dateTime={item.lastMessage.createdAt} title={formatDateTime(item.lastMessage.createdAt)}>
                      {timeAgo(item.lastMessage.createdAt)}
                    </time>
                  )}
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={clsx("truncate text-xs", strong ? "text-fg/80" : "text-muted")}>{preview(item)}</span>
                  {item.mentionsMe > 0 ? (
                    <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-bold text-white" title="Mentions you">
                      @
                    </span>
                  ) : item.unread > 0 ? (
                    <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 font-bold text-white" title={`${item.unread} unread`}>
                      {item.unread > 99 ? "99+" : item.unread}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
