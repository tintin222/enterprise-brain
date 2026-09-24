import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useDocumentTitle } from "../lib/title.ts";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("rounded-xl border border-line bg-surface shadow-xs", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-start justify-between gap-3 border-b border-line px-5 py-3.5", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && <Icon className="mt-0.5 size-[18px] shrink-0 text-muted" />}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("px-5 py-4", className)}>{children}</div>;
}

/** Page title block with optional actions. */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  useDocumentTitle(typeof title === "string" ? title : null);
  return (
    <div className={clsx("mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-600/10 dark:bg-brand-500/15 dark:text-brand-300">
            <Icon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 text-xs font-medium text-muted">{eyebrow}</div>}
          <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small uppercase section label. */
export function SectionTitle({ children, className, actions }: { children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <div className={clsx("mb-2 flex items-center justify-between gap-2", className)}>
      <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {actions}
    </div>
  );
}
