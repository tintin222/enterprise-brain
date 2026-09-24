import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { humanize } from "../lib/format.ts";

export type Tone = "neutral" | "brand" | "green" | "amber" | "red" | "blue" | "violet";

const tones: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-500/15 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/20",
  brand: "bg-brand-50 text-brand-700 ring-brand-600/15 dark:bg-brand-400/15 dark:text-brand-200 dark:ring-brand-400/25",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25",
  red: "bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-400/10 dark:text-red-300 dark:ring-red-400/25",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/25",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/15 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/25",
};

const dots: Record<Tone, string> = {
  neutral: "bg-slate-400",
  brand: "bg-brand-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-sky-500",
  violet: "bg-violet-500",
};

export function Badge({
  tone = "neutral",
  children,
  icon: Icon,
  dot,
  pulse,
  className,
  title,
  size = "sm",
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: LucideIcon;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  title?: string;
  size?: "xs" | "sm";
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex max-w-full items-center gap-1 rounded-full font-medium whitespace-nowrap ring-1 ring-inset",
        size === "xs" ? "px-1.5 py-px text-[11px]" : "px-2 py-0.5 text-xs",
        tones[tone],
        className,
      )}
    >
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && <span className={clsx("absolute inline-flex size-full animate-ping rounded-full opacity-60", dots[tone])} />}
          <span className={clsx("relative inline-flex size-1.5 rounded-full", dots[tone])} />
        </span>
      )}
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

interface StatusMeta {
  tone: Tone;
  label: string;
  pulse?: boolean;
}

const STATUS: Record<string, StatusMeta> = {
  // agents
  draft: { tone: "neutral", label: "Draft" },
  testing: { tone: "amber", label: "Testing" },
  active: { tone: "green", label: "Active" },
  paused: { tone: "neutral", label: "Paused" },
  archived: { tone: "neutral", label: "Archived" },
  // runs
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "blue", label: "Running", pulse: true },
  waiting_approval: { tone: "amber", label: "Waiting for approval" },
  succeeded: { tone: "green", label: "Succeeded" },
  failed: { tone: "red", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  // builder sessions
  interviewing: { tone: "brand", label: "Interviewing" },
  "awaiting-stakeholders": { tone: "amber", label: "Waiting on others" },
  confirming: { tone: "blue", label: "Ready to confirm" },
  generating: { tone: "violet", label: "Generating", pulse: true },
  deployed: { tone: "green", label: "Live" },
  // approvals
  pending: { tone: "amber", label: "Pending" },
  approved: { tone: "green", label: "Approved" },
  rejected: { tone: "red", label: "Rejected" },
  // mail
  new: { tone: "blue", label: "New" },
  processing: { tone: "violet", label: "Processing", pulse: true },
  triaged: { tone: "green", label: "Processed" },
  replied: { tone: "green", label: "Replied" },
  error: { tone: "red", label: "Error" },
  sent: { tone: "blue", label: "Sent" },
  // stakeholder requests
  answered: { tone: "green", label: "Answered" },
  // connectors
  ok: { tone: "green", label: "Connected" },
  connected: { tone: "green", label: "Connected" },
  unverified: { tone: "amber", label: "Not tested" },
  // knowledge
  indexed: { tone: "green", label: "Indexed" },
  // maturity
  stable: { tone: "green", label: "Stable" },
  preview: { tone: "blue", label: "Preview" },
  sandbox: { tone: "violet", label: "Demo data" },
  ready: { tone: "green", label: "Ready" },
  beta: { tone: "blue", label: "Beta" },
  concept: { tone: "neutral", label: "Concept" },
};

export function statusMeta(status: string | null | undefined): StatusMeta {
  if (!status) return { tone: "neutral", label: "—" };
  return STATUS[status] ?? { tone: "neutral", label: humanize(status) };
}

/** A status badge with a colored dot. Known statuses (agents, runs, builder, approvals, mail…) get their tone and label. */
export function StatusPill({ status, label, className, size }: { status: string | null | undefined; label?: string; className?: string; size?: "xs" | "sm" }) {
  const meta = statusMeta(status);
  return (
    <Badge tone={meta.tone} dot pulse={meta.pulse} className={className} size={size}>
      {label ?? meta.label}
    </Badge>
  );
}

/** Verdict-like values: pass/shortlist = green, review = amber, fail/reject = red. */
export function verdictTone(value: unknown): Tone | undefined {
  if (typeof value !== "string" && typeof value !== "boolean") return undefined;
  const v = String(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (
    [
      "pass",
      "passed",
      "shortlist",
      "shortlisted",
      "approve",
      "approved",
      "accept",
      "accepted",
      "match",
      "matched",
      "hire",
      "yes",
      "true",
      "ok",
      "valid",
      "resolved",
      "strongyes",
      "recommended",
    ].includes(v)
  )
    return "green";
  if (
    [
      "review",
      "maybe",
      "unknown",
      "unclear",
      "hold",
      "onhold",
      "check",
      "needsreview",
      "manualreview",
      "partial",
      "pricemismatch",
      "quantitymismatch",
      "mismatch",
      "escalate",
      "pending",
      "waitlist",
    ].includes(v)
  )
    return "amber";
  if (
    ["fail", "failed", "reject", "rejected", "decline", "declined", "no", "false", "invalid", "nomatch", "nopo", "blocked", "spam", "notrecommended"].includes(
      v,
    )
  )
    return "red";
  return undefined;
}
