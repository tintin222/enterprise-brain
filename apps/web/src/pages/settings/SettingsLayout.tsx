import { clsx } from "clsx";
import { BookOpen, Inbox, Plug, ScrollText, Server, Settings, Users, Wallet, Waypoints, type LucideIcon } from "lucide-react";
import { Suspense } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { LoadingBlock } from "../../components/Spinner.tsx";
import { useViewer } from "../../lib/auth.tsx";

interface Section {
  to: string;
  label: string;
  icon: LucideIcon;
  /** admin: IT only; managers: managers and IT. */
  for: "admin" | "managers";
}

export const SETTINGS_SECTIONS: Section[] = [
  { to: "connections", label: "Connections", icon: Plug, for: "admin" },
  { to: "knowledge", label: "Knowledge", icon: BookOpen, for: "managers" },
  { to: "people", label: "People and roles", icon: Users, for: "managers" },
  { to: "costs", label: "Costs", icon: Wallet, for: "managers" },
  { to: "mailboxes", label: "Mailboxes", icon: Inbox, for: "managers" },
  { to: "audit", label: "Audit log", icon: ScrollText, for: "admin" },
  { to: "installation", label: "Installation", icon: Server, for: "admin" },
  { to: "paperclip", label: "Paperclip export", icon: Waypoints, for: "admin" },
];

/** The sections the viewer may open: IT sees all; managers see those for their departments. */
export function useSettingsSections(): Section[] {
  const viewer = useViewer();
  const admin = !viewer || viewer.isAdmin;
  const manager = admin || Boolean(viewer?.departments.some((d) => d.role === "manager"));
  return SETTINGS_SECTIONS.filter((s) => admin || (s.for === "managers" && manager));
}

/** Settings: a side list of sections (tabs on narrow screens) and the chosen section. */
export default function SettingsLayout() {
  const sections = useSettingsSections();
  const location = useLocation();
  const current = location.pathname.split("/")[2];
  if (!sections.length) {
    return (
      <Page>
        <EmptyState icon={Settings} title="Settings are for IT and managers" description="Ask your manager or IT if something needs changing." />
      </Page>
    );
  }
  if (!current) return <Navigate to={sections[0]!.to} replace />;
  if (!sections.some((s) => s.to === current)) {
    return (
      <Page>
        <EmptyState icon={Settings} title="Not for you" description="This part of Settings is for IT." />
      </Page>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <nav aria-label="Settings" className="shrink-0 border-b border-line bg-surface/60 lg:w-56 lg:border-r lg:border-b-0">
        <p className="hidden px-5 pt-6 pb-2 text-xs font-semibold tracking-wide text-muted uppercase lg:block">Settings</p>
        <ul className="flex gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:overflow-visible lg:py-1">
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <li key={s.to} className="shrink-0">
                <NavLink
                  to={`/settings/${s.to}`}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                      isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-muted hover:bg-subtle hover:text-fg",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  {s.label}
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
