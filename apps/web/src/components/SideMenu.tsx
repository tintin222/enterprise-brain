import { clsx } from "clsx";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router";

/** Collapses a side menu to its icons, or expands it again. */
export function FoldButton({ folded, onToggle, label, className }: { folded: boolean; onToggle: () => void; label: string; className?: string }) {
  const Icon = folded ? PanelLeftOpen : PanelLeftClose;
  const words = folded ? `Expand ${label}` : `Collapse ${label}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={words}
      aria-expanded={!folded}
      title={words}
      className={clsx("rounded-lg p-1.5 text-faint transition-colors hover:bg-subtle hover:text-fg", className)}
    >
      <Icon className="size-4" />
    </button>
  );
}

export const railLinkClass = (active: boolean) =>
  clsx(
    "relative flex size-9 items-center justify-center rounded-lg transition-colors",
    active ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-muted hover:bg-subtle hover:text-fg",
  );

/** One place in a folded menu: its icon, its name on hover. */
export function RailLink({ to, end, icon: Icon, label }: { to: string; end?: boolean; icon: LucideIcon; label: string }) {
  return (
    <NavLink to={to} end={end} title={label} aria-label={label} className={({ isActive }) => railLinkClass(isActive)}>
      <Icon className="size-[18px]" />
    </NavLink>
  );
}
