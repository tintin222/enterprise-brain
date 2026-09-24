import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Tells the user what to do next when there's nothing to show. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong text-center",
        compact ? "px-4 py-6" : "px-6 py-12",
        className,
      )}
    >
      {Icon && (
        <div className={clsx("mb-3 flex items-center justify-center rounded-full bg-subtle text-muted", compact ? "size-9" : "size-12")}>
          <Icon className={compact ? "size-4" : "size-6"} />
        </div>
      )}
      <h3 className={clsx("font-semibold text-fg", compact ? "text-sm" : "text-base")}>{title}</h3>
      {description && <p className={clsx("mt-1 max-w-md text-muted", compact ? "text-xs" : "text-sm")}>{description}</p>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
