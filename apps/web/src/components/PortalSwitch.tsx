import { clsx } from "clsx";
import { BriefcaseBusiness, WandSparkles } from "lucide-react";
import { Link, useLocation } from "react-router";
import { paths, twin, usePortal, type Portal } from "../lib/paths.ts";

const LAST = (portal: Portal) => `eb.portal.last.${portal}`;

/** Remembers the page last seen in a portal, so the switch can go back to it. */
export function rememberPlace(portal: Portal, place: string): void {
  try {
    sessionStorage.setItem(LAST(portal), place);
  } catch {
    // Storage can be off (private windows): the switch then opens the portal's home.
  }
}

function lastPlace(portal: Portal): string | null {
  try {
    return sessionStorage.getItem(LAST(portal));
  } catch {
    return null;
  }
}

export const PORTAL_LABEL: Record<Portal, string> = { operations: "Operations", studio: "Studio" };
const PORTAL_HINT: Record<Portal, string> = {
  operations: "Operations: chat, tasks, mail, apps and your AI employees' work",
  studio: "Studio: design AI employees, the company brain, building and settings",
};

/**
 * Operations | Studio. The other portal opens on the same page when it has one (an AI employee, a table),
 * else on the page last seen there, else on its home.
 */
export function PortalSwitch({ className, onNavigate, stacked }: { className?: string; onNavigate?: () => void; stacked?: boolean }) {
  const portal = usePortal();
  const location = useLocation();
  const target = (to: Portal) => (to === portal ? `${location.pathname}${location.search}` : (twin(location.pathname) ?? lastPlace(to) ?? paths.home(to)));
  return (
    <nav
      aria-label="Portal"
      className={clsx("items-center rounded-lg border border-line bg-subtle/70 p-0.5", stacked ? "flex w-full" : "inline-flex", className)}
    >
      {(["operations", "studio"] as const).map((p) => {
        const Icon = p === "operations" ? BriefcaseBusiness : WandSparkles;
        const current = p === portal;
        return (
          <Link
            key={p}
            to={target(p)}
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            title={PORTAL_HINT[p]}
            className={clsx(
              "flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-colors",
              stacked && "flex-1 py-1.5",
              current
                ? p === "studio"
                  ? "bg-surface text-violet-700 shadow-xs dark:text-violet-300"
                  : "bg-surface text-fg shadow-xs"
                : "text-muted hover:text-fg",
            )}
          >
            <Icon className="size-3.5" />
            {PORTAL_LABEL[p]}
          </Link>
        );
      })}
    </nav>
  );
}
