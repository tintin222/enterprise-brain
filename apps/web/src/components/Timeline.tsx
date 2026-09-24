import { clsx } from "clsx";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

export interface TimelineItem {
  id: string | number;
  icon: LucideIcon;
  tone?: "neutral" | "brand" | "green" | "amber" | "red" | "blue";
  title: ReactNode;
  meta?: ReactNode;
  time?: ReactNode;
  body?: ReactNode;
  /** Collapsible extra detail. */
  details?: ReactNode;
}

const toneClass = {
  neutral: "bg-subtle text-muted ring-line",
  brand: "bg-brand-50 text-brand-600 ring-brand-600/15 dark:bg-brand-400/15 dark:text-brand-300",
  green: "bg-emerald-50 text-emerald-600 ring-emerald-600/15 dark:bg-emerald-400/15 dark:text-emerald-300",
  amber: "bg-amber-50 text-amber-600 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300",
  red: "bg-red-50 text-red-600 ring-red-600/15 dark:bg-red-400/15 dark:text-red-300",
  blue: "bg-sky-50 text-sky-600 ring-sky-600/15 dark:bg-sky-400/15 dark:text-sky-300",
};

function Row({ item, last }: { item: TimelineItem; last: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = item.icon;
  return (
    <li className="relative flex gap-3 pb-5">
      {!last && <span className="absolute top-8 bottom-0 left-[15px] w-px bg-line" aria-hidden="true" />}
      <span className={clsx("relative flex size-8 shrink-0 items-center justify-center rounded-full ring-1", toneClass[item.tone ?? "neutral"])}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="min-w-0 text-sm font-medium text-fg">{item.title}</div>
          {item.time && <div className="shrink-0 text-xs text-faint tabular-nums">{item.time}</div>}
        </div>
        {item.meta && <div className="mt-0.5 text-xs text-muted">{item.meta}</div>}
        {item.body && <div className="mt-1 text-sm text-muted">{item.body}</div>}
        {item.details && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {open ? "Hide details" : "Show details"}
            </button>
            {open && <div className="mt-2">{item.details}</div>}
          </div>
        )}
      </div>
    </li>
  );
}

export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={clsx("relative", className)}>
      {items.map((item, i) => (
        <Row key={item.id} item={item} last={i === items.length - 1} />
      ))}
    </ol>
  );
}
