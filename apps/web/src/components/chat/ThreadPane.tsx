import { clsx } from "clsx";
import { ArrowLeft, MessageSquareReply, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useConversationFor } from "../../lib/queries.ts";
import type { ConversationParent, Message } from "../../types.ts";
import { ErrorState, Spinner } from "../Spinner.tsx";
import { ConversationView } from "./ConversationView.tsx";
import { MessageRow } from "./MessageRow.tsx";

function placeOf(parent: ConversationParent | null): string {
  if (!parent) return "the conversation";
  if (parent.kind === "channel") return `#${parent.name ?? parent.title}`;
  if (parent.kind === "dm") return "a direct message";
  if (parent.kind === "ai_employee") return `your talk with ${parent.title || "an AI employee"}`;
  return parent.title || "the conversation";
}

/**
 * The thread under one message: the message, then its replies, live, with its own composer. Beside the
 * conversation on wide screens; in its place on narrower ones (the arrow goes back).
 */
export function ThreadPane({ rootId, onClose, className }: { rootId: string; onClose: () => void; className?: string }) {
  const found = useConversationFor("thread", rootId);
  const [root, setRoot] = useState<Message | null>(null);
  const loadedRoot = found.data?.root ?? null;
  useEffect(() => setRoot(loadedRoot), [loadedRoot]);
  const thread = found.data;
  return (
    <aside className={clsx("flex min-h-0 flex-col bg-surface", className)} aria-label="Thread">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={onClose}
          className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg xl:hidden"
          aria-label="Back to the conversation"
        >
          <ArrowLeft className="size-5" />
        </button>
        <MessageSquareReply className="hidden size-4 shrink-0 text-muted xl:block" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">Thread</h2>
          {thread && <p className="truncate text-xs text-muted">in {placeOf(thread.parent)}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="hidden rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg xl:block"
          aria-label="Close the thread"
        >
          <X className="size-5" />
        </button>
      </header>
      {found.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : found.error || !thread ? (
        <div className="p-6">
          <ErrorState error={found.error} onRetry={() => void found.refetch()} />
        </div>
      ) : (
        <ConversationView
          key={thread.conversation.id}
          id={thread.conversation.id}
          embedded
          className="min-h-0 flex-1"
          emptyTitle="No replies yet"
          emptyDescription="Reply here: the thread stays under the message, out of the way of the conversation."
          onRootUpdated={setRoot}
          lead={
            root && (
              <ul className="mb-2 border-b border-line pb-3">
                <MessageRow message={root} onChanged={setRoot} canReact />
              </ul>
            )
          }
        />
      )}
    </aside>
  );
}
