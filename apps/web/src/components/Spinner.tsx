import { clsx } from "clsx";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "../api.ts";

export function Spinner({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <LoaderCircle
      aria-label="Loading"
      className={clsx("animate-spin text-brand-500", size === "sm" && "size-4", size === "md" && "size-5", size === "lg" && "size-8", className)}
    />
  );
}

/** Centered loading placeholder for a panel or page. */
export function LoadingBlock({ label = "Loading…", className }: { label?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted", className)}>
      <Spinner size="lg" />
      <span>{label}</span>
    </div>
  );
}

/** Skeleton line(s) for list placeholders. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-subtle", className)} />;
}

export function ErrorState({ error, onRetry, className, title = "Something went wrong" }: { error: unknown; onRetry?: () => void; className?: string; title?: string }) {
  return (
    <div
      role="alert"
      className={clsx(
        "flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-200",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 break-words opacity-90">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium hover:bg-red-100 dark:hover:bg-red-400/15"
        >
          <RefreshCw className="size-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

/** Callout box for explanations, warnings and tips. */
export function Callout({
  tone = "info",
  title,
  children,
  icon: Icon,
  className,
  actions,
}: {
  tone?: "info" | "warning" | "success" | "brand" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  icon?: typeof CircleAlert;
  className?: string;
  actions?: ReactNode;
}) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-100",
    warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100",
    brand: "border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-400/25 dark:bg-brand-400/10 dark:text-brand-100",
    danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-100",
  }[tone];
  return (
    <div className={clsx("flex gap-3 rounded-xl border p-4 text-sm", styles, className)}>
      {Icon && <Icon className="mt-0.5 size-5 shrink-0 opacity-80" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && "mt-1", "opacity-90")}>{children}</div>}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
