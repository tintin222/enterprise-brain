import { clsx } from "clsx";
import { ArrowRightLeft, Hash, LifeBuoy, Mail, MessageSquare, NotebookPen, Phone, RefreshCw, ShoppingCart, Users, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { formatDateTime, timeAgo } from "../../lib/format.ts";
import type { BrainEvent, BrainModel } from "../../types.ts";
import { ThingChip, brainPath, originName } from "./brain.tsx";

const EVENT_ICONS: Record<BrainEvent["kind"], LucideIcon> = {
  message: MessageSquare,
  email: Mail,
  meeting: Users,
  call: Phone,
  update: RefreshCw,
  change: ArrowRightLeft,
  note: NotebookPen,
  ticket: LifeBuoy,
  order: ShoppingCart,
};

const EVENT_COLORS: Record<BrainEvent["kind"], string> = {
  message: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  email: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
  meeting: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  call: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  update: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  change: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  note: "bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
  ticket: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
  order: "bg-teal-100 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
};

/** One thing that happened: who, where, when, what it is about. */
export function EventItem({ event, model, hide }: { event: BrainEvent; model: BrainModel | undefined; hide?: string }) {
  const [open, setOpen] = useState(false);
  const Icon = event.origin === "slack" ? Hash : (EVENT_ICONS[event.kind] ?? NotebookPen);
  // A message's title is its first words: show the message once.
  const repeated = event.body && event.body.startsWith(event.title.replace(/…$/, ""));
  const title = repeated ? event.body : event.title;
  const long = event.body && !repeated;
  const about = event.about.filter((a) => a.id !== hide);
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className={clsx("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", EVENT_COLORS[event.kind])}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-fg">
          {event.actorId ? (
            <Link to={brainPath(event.actorId)} className="font-semibold hover:underline">
              {event.actor}
            </Link>
          ) : event.actor ? (
            <span className="font-semibold">{event.actor}</span>
          ) : null}
          {event.actor ? <span className="text-muted"> · </span> : null}
          <span className={clsx(event.kind === "change" && "font-medium")}>{title}</span>
        </p>
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className={clsx("mt-0.5 block text-left text-xs text-muted hover:text-fg", !open && "line-clamp-2")}
          >
            {event.body}
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          <span title={formatDateTime(event.at)}>{timeAgo(event.at)}</span>
          <span>·</span>
          <span>{event.place ? `${event.place} (${originName(event.origin)})` : originName(event.origin)}</span>
          {about.slice(0, 4).map((thing) => (
            <ThingChip key={thing.id} thing={thing} model={model} className="!py-0 !text-[11px]" />
          ))}
        </div>
      </div>
    </li>
  );
}
