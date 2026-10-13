import { clsx } from "clsx";
import { Lock, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "./Logo.tsx";

/** The frame of the pages people open from a link, signed in or not: the company, and whom the link is for. */
export function PublicShell({ company, note, children }: { company?: string; note?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-4">
          <Logo className="size-7" />
          <span className="truncate text-sm font-semibold text-fg">{company ?? "Enterprise Brain"}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
            <Lock className="size-3.5" /> {note ?? "Secure link"}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-10">{children}</main>
    </div>
  );
}

/** A page's one message: what happened, or why the link does not work. */
export function PublicMessage({
  icon: Icon,
  title,
  body,
  tone,
  children,
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  tone: "green" | "amber";
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
      <div
        className={clsx(
          "mx-auto mb-4 flex size-14 items-center justify-center rounded-full",
          tone === "green"
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300"
            : "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300",
        )}
      >
        <Icon className="size-7" />
      </div>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</div>
      {children && <div className="mt-5 flex justify-center gap-2">{children}</div>}
    </div>
  );
}
