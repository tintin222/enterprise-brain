import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { MENTION_ICONS, MENTION_LABELS } from "../../lib/mentions.ts";
import { upgrade } from "../../lib/paths.ts";
import type { MentionKind } from "../../types.ts";

/** A name in a message: a person, an AI employee, or an asset, with a link to it when the viewer may open it. */
export function MentionChip({ kind, href, children, className }: { kind: MentionKind; href?: string | null; children: ReactNode; className?: string }) {
  const Icon = MENTION_ICONS[kind];
  const classes = clsx(
    "inline-flex max-w-full items-center gap-1 rounded-md bg-brand-50 px-1.5 py-px align-baseline text-[0.92em] font-medium text-brand-700 dark:bg-brand-400/15 dark:text-brand-200",
    href && "hover:bg-brand-100 dark:hover:bg-brand-400/25",
    className,
  );
  const inner = (
    <>
      <Icon className="size-3 shrink-0 opacity-80" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </>
  );
  if (!href) {
    return (
      <span className={classes} title={MENTION_LABELS[kind]}>
        {inner}
      </span>
    );
  }
  if (href.startsWith("/api/")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes} title={MENTION_LABELS[kind]}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={upgrade(href)} className={classes} title={MENTION_LABELS[kind]}>
      {inner}
    </Link>
  );
}
