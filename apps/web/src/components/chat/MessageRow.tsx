import { clsx } from "clsx";
import { Briefcase, CircleCheck, CornerUpLeft, Lightbulb, MessageSquareReply, SmilePlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { fileUrl } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { repliesText, sameActor } from "../../lib/conversations.ts";
import { formatDate, formatDateTime, timeAgo } from "../../lib/format.ts";
import { paths } from "../../lib/paths.ts";
import type { Actor, Message, ThreadSummary } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { FileChip } from "../Dropzone.tsx";
import { Markdown } from "../Markdown.tsx";
import { WorkItemCard } from "../WorkItemCard.tsx";
import { ActorAvatar } from "./Actors.tsx";
import { LearningCard } from "./LearningCard.tsx";
import { EmojiPicker, ReactionsBar, useReact } from "./Reactions.tsx";

/** A message put into a list, in place of an older copy of itself, in order. */
export function upsert(list: Message[] | undefined, message: Message): Message[] {
  const rest = (list ?? []).filter((m) => m.id !== message.id);
  rest.push(message);
  return rest.sort((a, b) => a.seq - b.seq);
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(date, today) ? "Today" : same(date, yesterday) ? "Yesterday" : formatDate(iso);
}

/** Two text messages by the same author within five minutes read as one (not when the first grew a thread or reactions). */
export function continues(previous: Message | undefined, message: Message): boolean {
  if (!previous || previous.kind !== "text" || message.kind !== "text" || message.replyToId) return false;
  if (!sameActor(previous.author, message.author)) return false;
  if (previous.reactions.length || (previous.thread && previous.thread.replies > 0)) return false;
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

/** Under a message given as work or taught to the brain: what became of it; under an answer to given work: its task. */
function IntentFooter({ message }: { message: Message }) {
  const data = message.data ?? {};
  if (data.taskEvent === "done" && message.author.kind === "ai_employee") {
    const done = data.task as { ref?: string } | undefined;
    if (!done?.ref) return null;
    return (
      <Link
        to={paths.work(done.ref)}
        className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
      >
        <CircleCheck className="size-3" /> {done.ref} is done · Open the task
      </Link>
    );
  }
  if (data.intent === "teach") {
    return (
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
        <Lightbulb className="size-3" /> Taught the company brain
      </p>
    );
  }
  const task = data.intent === "work" ? (data.task as { ref?: string } | undefined) : undefined;
  if (!task?.ref) return null;
  const to = data.to as Actor | undefined;
  return (
    <Link to={paths.work(task.ref)} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
      <Briefcase className="size-3" /> Given{to ? ` to ${to.name}` : ""} as {task.ref}
    </Link>
  );
}

/** "3 replies · last reply 5 min ago", with who replied: opens the thread. */
function ThreadLine({ thread, onOpen }: { thread: ThreadSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="-ml-1.5 mt-1 inline-flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-subtle"
      aria-label={`Open the thread: ${repliesText(thread.replies)}`}
    >
      {thread.repliers.length > 0 && (
        <span className="flex -space-x-1">
          {thread.repliers.slice(0, 4).map((actor) => (
            <ActorAvatar key={`${actor.kind}:${actor.id}`} actor={actor} size="xs" className="ring-2 ring-surface" />
          ))}
        </span>
      )}
      <span className="font-medium text-brand-700 dark:text-brand-300">{repliesText(thread.replies)}</span>
      {thread.lastReplyAt && <span className="truncate text-faint">Last reply {timeAgo(thread.lastReplyAt)}</span>}
    </button>
  );
}

/** What appears on hover at a message's top right: react, reply in a thread. */
function Actions({
  message,
  onOpenThread,
  canReact,
  onChanged,
}: {
  message: Message;
  onOpenThread?: (message: Message) => void;
  canReact: boolean;
  onChanged: (message: Message) => void;
}) {
  const react = useReact(onChanged);
  const [picking, setPicking] = useState(false);
  /** The picker opens upward for a message in the lower half of the screen, so it stays in view. */
  const [upward, setUpward] = useState(false);
  if (!canReact && !onOpenThread) return null;
  return (
    <div
      className={clsx(
        "absolute top-1 right-4 z-10 items-center rounded-lg border border-line bg-surface p-0.5 shadow-xs group-hover:flex sm:right-6",
        picking ? "flex" : "hidden focus-within:flex",
      )}
    >
      {canReact && (
        <span className="relative">
          <button
            type="button"
            onClick={(event) => {
              setUpward(event.currentTarget.getBoundingClientRect().top > window.innerHeight / 2);
              setPicking((v) => !v);
            }}
            className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-fg"
            aria-label="React"
            title="React"
            aria-expanded={picking}
          >
            <SmilePlus className="size-4" />
          </button>
          {picking && (
            <EmojiPicker
              className={clsx("absolute right-0", upward ? "bottom-8" : "top-8")}
              onPick={(emoji) => {
                setPicking(false);
                react.mutate({ message, emoji, on: !message.reactions.some((r) => r.emoji === emoji && r.me) });
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </span>
      )}
      {onOpenThread && (
        <button
          type="button"
          onClick={() => onOpenThread(message)}
          className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-fg"
          aria-label="Reply in thread"
          title="Reply in thread"
        >
          <MessageSquareReply className="size-4" />
        </button>
      )}
    </div>
  );
}

export interface MessageRowProps {
  message: Message;
  /** The one above, to run two of the same author together. */
  previous?: Message;
  /** The message this one quotes (older messages), when it is on the page. */
  replyTo?: Message;
  /** The message as it is after a reaction or a card decision. */
  onChanged: (message: Message) => void;
  /** Offered where threads are: channels, direct messages and talks (not in a thread, a task or a thing). */
  onOpenThread?: (message: Message) => void;
  canReact?: boolean;
}

/** One message as the page shows it: the app's lines centred, cards as live work entries, text with its reactions and thread. */
export function MessageRow({ message, previous, replyTo, onChanged, onOpenThread, canReact = true }: MessageRowProps) {
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
  const extras = (
    <>
      <ReactionsBar message={message} canReact={canReact} onChanged={onChanged} />
      {onOpenThread && message.thread && message.thread.replies > 0 && <ThreadLine thread={message.thread} onOpen={() => onOpenThread(message)} />}
    </>
  );
  if (message.kind === "card") {
    return (
      <li className="group relative px-4 py-2 sm:px-6">
        <div className="flex gap-3">
          <ActorAvatar actor={message.author} />
          <div className="min-w-0 max-w-2xl flex-1">
            <AuthorLine message={message} />
            {message.card?.type === "learning" ? (
              <LearningCard message={message} card={message.card} onChanged={onChanged} />
            ) : message.card ? (
              <WorkItemCard entry={message.card} showAgent={false} />
            ) : (
              <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">This item is no longer there.</p>
            )}
            {extras}
          </div>
        </div>
        <Actions message={message} onOpenThread={onOpenThread} canReact={canReact} onChanged={onChanged} />
      </li>
    );
  }
  const continued = continues(previous, message);
  const steps =
    message.author.kind === "ai_employee" && message.runId ? (
      <Link to={paths.run(message.runId)} className="text-faint hover:text-fg hover:underline">
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
          <IntentFooter message={message} />
          {extras}
        </div>
      </div>
      <Actions message={message} onOpenThread={onOpenThread} canReact={canReact} onChanged={onChanged} />
    </li>
  );
}
