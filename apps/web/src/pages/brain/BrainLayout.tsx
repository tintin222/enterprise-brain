import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Brain, Cable, LayoutDashboard, MessageCircleQuestion, Search, Share2 } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api, qs } from "../../api.ts";
import { LoadingBlock } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import type { BrainEntitySummary } from "../../types.ts";
import { DIMENSION_ICONS, KindIcon, brainKeys, brainPath, kindOf, useBrainModel, useBrainOverview } from "./brain.tsx";

/** Search across the brain from anywhere in it: results as you type, Enter opens the first. */
function BrainSearch({ className }: { className?: string }) {
  const { company, path } = useCompany();
  const { data: model } = useBrainModel();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const q = text.trim();
  const results = useQuery({
    queryKey: [...brainKeys.all(company), "search", q],
    queryFn: () => api.get<BrainEntitySummary[]>(path(`/brain/search${qs({ q })}`)),
    enabled: q.length >= 2,
    placeholderData: (previous) => previous,
  });
  const hits = q.length >= 2 ? (results.data ?? []).slice(0, 8) : [];
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const go = (id: string) => {
    setOpen(false);
    setText("");
    navigate(brainPath(id));
  };
  return (
    <div ref={box} className={clsx("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
      <input
        className="input h-9 pl-8 text-[13px]"
        placeholder="Find a person, system, client…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && hits[active]) {
            go(hits[active].id);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        aria-label="Search the company brain"
      />
      {open && q.length >= 2 && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-96 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl">
          {hits.length === 0 && <p className="px-3 py-2 text-xs text-muted">{results.isFetching ? "Looking…" : "Nothing found."}</p>}
          {hits.map((hit, i) => (
            <button
              key={hit.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => go(hit.id)}
              className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", i === active ? "bg-subtle" : "")}
            >
              <KindIcon kind={hit.kind} model={model} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{hit.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {[kindOf(model, hit.kind)?.name, ...hit.brief.map(([, v]) => v)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TOP = [
  { to: "/brain", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/brain/ask", label: "Ask", icon: MessageCircleQuestion },
  { to: "/brain/map", label: "Map", icon: Share2 },
  { to: "/brain/sources", label: "Sources", icon: Cable },
];

function linkClass({ isActive }: { isActive: boolean }) {
  return clsx(
    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
    isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-muted hover:bg-subtle hover:text-fg",
  );
}

/** The Brain place: its own menu (overview, ask, map, sources, and every kind of thing by area) beside the page. */
export default function BrainLayout() {
  const { data: model } = useBrainModel();
  const { data: overview } = useBrainOverview();
  const counts = overview?.counts ?? {};
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const kindPath = pathname.match(/^\/brain\/k\/([^/]+)/)?.[1] ?? "";

  return (
    <div className="flex flex-1">
      <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 flex-col self-start border-r border-line bg-surface lg:flex">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 text-white">
            <Brain className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-fg">Company brain</p>
            <p className="text-[11px] text-muted">
              {overview ? `${overview.total.toLocaleString("en-US")} things · ${overview.links.toLocaleString("en-US")} links` : "…"}
            </p>
          </div>
        </div>
        <div className="border-b border-line p-3">
          <BrainSearch />
        </div>
        <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" aria-label="Company brain">
          <ul className="space-y-0.5">
            {TOP.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={linkClass}>
                  <Icon className="size-4 shrink-0" /> {label}
                </NavLink>
              </li>
            ))}
          </ul>
          {model?.dimensions.map((dimension) => {
            const Icon = DIMENSION_ICONS[dimension.key] ?? Brain;
            const kinds = model.kinds.filter((k) => k.dimension === dimension.key);
            return (
              <div key={dimension.key}>
                <p className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-faint uppercase" title={dimension.description}>
                  <Icon className="size-3.5" /> {dimension.name}
                </p>
                <ul className="space-y-0.5">
                  {kinds.map((kind) => (
                    <li key={kind.key}>
                      <NavLink to={`/brain/k/${kind.key}`} className={linkClass} title={kind.description}>
                        <KindIcon kind={kind.key} model={model} size="sm" className="!size-5" />
                        <span className="flex-1 truncate">{kind.plural}</span>
                        <span className="text-[11px] text-faint tabular-nums">{counts[kind.key] ?? 0}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-2 border-b border-line bg-surface px-4 py-2.5 lg:hidden">
          <div className="flex gap-1 overflow-x-auto">
            {TOP.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={(state) => clsx(linkClass(state), "shrink-0")}>
                <Icon className="size-4" /> {label}
              </NavLink>
            ))}
          </div>
          <div className="flex gap-2">
            <select
              className="input h-9 flex-1 py-1 text-[13px]"
              value={kindPath}
              onChange={(e) => e.target.value && navigate(`/brain/k/${e.target.value}`)}
              aria-label="Kind of thing"
            >
              <option value="">Browse…</option>
              {model?.dimensions.map((dimension) => (
                <optgroup key={dimension.key} label={dimension.name}>
                  {model.kinds
                    .filter((k) => k.dimension === dimension.key)
                    .map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.plural} ({counts[k.key] ?? 0})
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <BrainSearch className="flex-1" />
          </div>
        </div>
        <Suspense fallback={<LoadingBlock />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
