import { clsx } from "clsx";
import { BookOpen, Hammer, MessagesSquare, Plug, ScrollText, Server, Settings, Users, Wallet, Waypoints, type LucideIcon } from "lucide-react";
import { Suspense } from "react";
import { Navigate, NavLink, Outlet, useMatch } from "react-router";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { FoldButton } from "../../components/SideMenu.tsx";
import { LoadingBlock } from "../../components/Spinner.tsx";
import { useIsManager, useViewer } from "../../lib/auth.tsx";
import { paths, STUDIO } from "../../lib/paths.ts";
import { useStoredFlag } from "../../lib/preferences.ts";

interface Section {
  to: string;
  label: string;
  icon: LucideIcon;
  /** admin: IT only; managers: managers and IT. */
  for: "admin" | "managers";
}

export const SETTINGS_SECTIONS: Section[] = [
  { to: "connections", label: "Connections", icon: Plug, for: "admin" },
  { to: "channels", label: "Teams and Chat", icon: MessagesSquare, for: "admin" },
  { to: "knowledge", label: "Knowledge", icon: BookOpen, for: "managers" },
  { to: "people", label: "People and roles", icon: Users, for: "managers" },
  { to: "costs", label: "Costs", icon: Wallet, for: "managers" },
  { to: "building", label: "Building", icon: Hammer, for: "admin" },
  { to: "audit", label: "Audit log", icon: ScrollText, for: "admin" },
  { to: "installation", label: "Installation", icon: Server, for: "admin" },
  { to: "paperclip", label: "Paperclip export", icon: Waypoints, for: "admin" },
];

/** The sections the viewer may open: IT sees all; managers see those for their departments. */
export function useSettingsSections(): Section[] {
  const viewer = useViewer();
  const admin = !viewer || viewer.isAdmin;
  const manager = useIsManager();
  return SETTINGS_SECTIONS.filter((s) => admin || (s.for === "managers" && manager));
}

/** Settings: a side list of sections (tabs on narrow screens, collapsible to icons on wide ones) and the chosen section. */
export default function SettingsLayout() {
  const sections = useSettingsSections();
  const current = useMatch({ path: `${STUDIO}/settings/:section`, end: false })?.params.section;
  const [folded, setFolded] = useStoredFlag("eb.settings.menu.folded", () => false);
  if (!sections.length) {
    return (
      <Page>
        <EmptyState icon={Settings} title="Settings are for IT and managers" description="Ask your manager or IT if something needs changing." />
      </Page>
    );
  }
  if (!current) return <Navigate to={paths.settings(sections[0]!.to)} replace />;
  if (!sections.some((s) => s.to === current)) {
    return (
      <Page>
        <EmptyState icon={Settings} title="Not for you" description="This part of Settings is for IT." />
      </Page>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <nav
        aria-label="Settings"
        className={clsx(
          "shrink-0 border-b border-line bg-surface/60 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:self-start lg:border-r lg:border-b-0",
          folded ? "lg:w-14" : "lg:w-56",
        )}
      >
        <div className={clsx("hidden items-center lg:flex", folded ? "justify-center pt-4 pb-2" : "justify-between pt-5 pr-2 pb-2 pl-5")}>
          {!folded && <p className="text-xs font-semibold tracking-wide text-muted uppercase">Settings</p>}
          <FoldButton folded={folded} onToggle={() => setFolded(!folded)} label="the settings menu" />
        </div>
        <ul className={clsx("flex gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:overflow-visible lg:py-1", folded && "lg:items-center lg:px-2")}>
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <li key={s.to} className="shrink-0">
                <NavLink
                  to={paths.settings(s.to)}
                  title={folded ? s.label : undefined}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                      folded && "lg:size-9 lg:justify-center lg:gap-0 lg:p-0",
                      isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-muted hover:bg-subtle hover:text-fg",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  <span className={folded ? "lg:sr-only" : undefined}>{s.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<LoadingBlock />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
