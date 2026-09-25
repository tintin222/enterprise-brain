import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Bell,
  BookOpen,
  Bot,
  Building,
  CirclePlay,
  FileSpreadsheet,
  Inbox,
  LayoutDashboard,
  LibraryBig,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Paperclip,
  Plug,
  ScanText,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Sun,
  UserCheck,
  Users,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { signOut, useViewer } from "../lib/auth.tsx";
import { useCompany } from "../lib/company.tsx";
import { initials } from "../lib/format.ts";
import { useApprovals } from "../lib/queries.ts";
import { useTheme } from "../lib/theme.ts";
import { Wordmark } from "./Logo.tsx";
import { LoadingBlock } from "./Spinner.tsx";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: "approvals";
}

const NAV: { title: string; items: NavItem[] }[] = [
  { title: "Overview", items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, end: true }] },
  {
    title: "Build",
    items: [
      { to: "/builder", label: "Agent Builder", icon: WandSparkles },
      { to: "/catalog", label: "Catalog", icon: LibraryBig },
    ],
  },
  {
    title: "Operate",
    items: [
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/runs", label: "Runs", icon: CirclePlay },
      { to: "/approvals", label: "Approvals", icon: UserCheck, badge: "approvals" },
      { to: "/inbox", label: "Inbox", icon: Inbox },
    ],
  },
  {
    title: "Use cases",
    items: [
      { to: "/assistant", label: "Assistant", icon: MessageSquare },
      { to: "/search", label: "Search", icon: Search },
      { to: "/knowledge", label: "Knowledge", icon: BookOpen },
      { to: "/documents", label: "Documents", icon: ScanText },
      { to: "/excel", label: "Excel", icon: FileSpreadsheet },
    ],
  },
  {
    title: "Integrate",
    items: [
      { to: "/connectors", label: "Connectors", icon: Plug },
      { to: "/paperclip", label: "Paperclip", icon: Paperclip },
    ],
  },
  {
    title: "Admin",
    items: [
      { to: "/departments", label: "Departments", icon: Building },
      { to: "/people", label: "People", icon: Users },
      { to: "/activity", label: "Activity", icon: ScrollText },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

function usePendingApprovals(): number {
  const { data } = useApprovals("pending");
  return data?.length ?? 0;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pending = usePendingApprovals();
  return (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="flex h-14 shrink-0 items-center border-b border-line px-4">
        <Link to="/" onClick={onNavigate} className="rounded-lg focus-visible:outline-2">
          <Wordmark />
        </Link>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV.map((group) => (
          <div key={group.title}>
            <p className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-faint uppercase">{group.title}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const count = item.badge === "approvals" ? pending : 0;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        clsx(
                          "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors",
                          isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-muted hover:bg-subtle hover:text-fg",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            className={clsx("size-[18px] shrink-0", isActive ? "text-brand-600 dark:text-brand-300" : "text-faint group-hover:text-muted")}
                          />
                          <span className="flex-1 truncate">{item.label}</span>
                          {count > 0 && (
                            <span className="rounded-full bg-amber-500 px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums">{count}</span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-line p-3">
        <Link
          to="/builder/new"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:from-brand-700 hover:to-violet-700"
        >
          <Sparkles className="size-4" />
          Build an agent
        </Link>
      </div>
    </nav>
  );
}

function LlmBadge() {
  const { info } = useCompany();
  if (info.llm.available) {
    const provider =
      info.llm.provider?.toLowerCase().includes("anthropic") || info.llm.provider?.toLowerCase().includes("claude") ? "Claude" : info.llm.provider || "LLM";
    return (
      <span
        className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg sm:inline-flex"
        title={`Language model: ${info.llm.provider} ${info.llm.model}`}
      >
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {provider} · {info.llm.model}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-amber-800 ring-1 ring-amber-600/20 ring-inset dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25"
      title="Set ANTHROPIC_API_KEY for Claude; the platform runs with deterministic fallbacks"
    >
      <span className="size-1.5 rounded-full bg-amber-500" />
      <span>
        Offline<span className="hidden sm:inline"> mode</span>
      </span>
    </span>
  );
}

/** The signed-in person: who they are, their departments, and sign out. */
function PersonMenu() {
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (viewer?.kind !== "session") return null;
  const departments = viewer.departments.map((d) => `${d.name} ${d.role}`).join(" · ");
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full p-0.5 hover:bg-subtle sm:pr-2.5"
        title={viewer.name}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
          {initials(viewer.name)}
        </span>
        <span className="hidden max-w-40 truncate text-sm font-medium sm:block">{viewer.name}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-72 animate-fade-in rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold">{viewer.name}</p>
            <p className="truncate text-xs text-muted">{viewer.email}</p>
            <p className="mt-2 text-xs text-muted">{[viewer.isAdmin ? "Admin" : "", departments].filter(Boolean).join(" · ") || "No department yet"}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut(queryClient)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-subtle"
          >
            <LogOut className="size-4 text-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { companyName } = useCompany();
  const { theme, toggle } = useTheme();
  const pending = usePendingApprovals();
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/70 sm:px-6">
      <button type="button" onClick={onMenu} className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg lg:hidden" aria-label="Open navigation">
        <Menu className="size-5" />
      </button>
      <Link
        to="/settings"
        className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-fg hover:text-brand-700 dark:hover:text-brand-300"
        title="Company"
      >
        <Building className="size-4 shrink-0 text-muted" />
        <span className="truncate">{companyName}</span>
      </Link>
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <LlmBadge />
        <Link
          to="/approvals"
          className="relative rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg"
          aria-label={pending ? `${pending} pending approvals` : "Approvals"}
          title={pending ? `${pending} pending approval${pending === 1 ? "" : "s"}` : "Approvals"}
        >
          <Bell className="size-[18px]" />
          {pending > 0 && (
            <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-4 font-bold text-white">
              {pending > 9 ? "9+" : pending}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={toggle}
          className="rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </button>
        <PersonMenu />
      </div>
    </header>
  );
}

/** Console chrome: sidebar (off-canvas on narrow screens), top bar and the routed page. */
export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-slate-950/40" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside className="relative h-full w-72 max-w-[85vw] animate-slide-in-left border-r border-line bg-surface shadow-2xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-3.5 right-3 rounded-lg p-1 text-muted hover:bg-subtle"
              aria-label="Close navigation"
            >
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <TopBar onMenu={() => setOpen(true)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Suspense fallback={<LoadingBlock />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

/** Standard page container (max width + gutters). */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={clsx("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8", wide ? "max-w-[1600px]" : "max-w-7xl", className)}>{children}</div>;
}
