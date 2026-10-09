import { clsx } from "clsx";
import { Bot, Brain } from "lucide-react";
import { initials } from "../../lib/format.ts";
import type { Actor } from "../../types.ts";
import { Logo } from "../Logo.tsx";

/** Who wrote it: initials for people, a bot for AI employees, the brain for the company brain, the app for system lines. */
export function ActorAvatar({ actor, size = "md", className }: { actor: Actor; size?: "xs" | "sm" | "md"; className?: string }) {
  const box = size === "xs" ? "size-5 text-[9px]" : size === "sm" ? "size-6 text-[10px]" : "size-8 text-xs";
  const icon = size === "xs" ? "size-3" : size === "sm" ? "size-3.5" : "size-4";
  if (actor.kind === "ai_employee") {
    const Icon = actor.name === "Company brain" ? Brain : Bot;
    return (
      <span
        className={clsx(
          "flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm",
          box,
          className,
        )}
        title={`${actor.name} (AI employee)`}
      >
        <Icon className={icon} />
      </span>
    );
  }
  if (actor.kind === "system") return <Logo className={clsx("rounded-lg", size === "xs" ? "size-5" : size === "sm" ? "size-6" : "size-8", className)} />;
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200",
        box,
        className,
      )}
      title={actor.name}
    >
      {initials(actor.name)}
    </span>
  );
}
