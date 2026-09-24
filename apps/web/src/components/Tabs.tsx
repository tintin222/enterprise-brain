import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: LucideIcon;
  count?: number;
  /** Highlight the count (e.g. something needs attention). */
  alert?: boolean;
}

/** Accessible tab bar (arrow-key navigation). The caller renders the active panel. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  size = "md",
  fill,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  size?: "sm" | "md";
  fill?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="tablist" className={clsx("flex gap-1 overflow-x-auto border-b border-line", className)}>
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKey(e, index)}
            className={clsx(
              "relative -mb-px flex shrink-0 items-center justify-center gap-1.5 border-b-2 font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-[-2px]",
              size === "sm" ? "px-2.5 py-2 text-[13px]" : "px-3 py-2.5 text-sm",
              fill && "flex-1",
              active ? "border-brand-600 text-fg dark:border-brand-400" : "border-transparent text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {Icon && <Icon className="size-4" />}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={clsx(
                  "rounded-full px-1.5 text-[11px] leading-[18px] font-semibold",
                  tab.alert ? "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300" : "bg-subtle text-muted",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Pill-style segmented control for filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("inline-flex rounded-lg border border-line bg-subtle p-0.5", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-md px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors",
            o.value === value ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
