import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AppWindow,
  BadgeDollarSign,
  BookA,
  Bot,
  Building2,
  CalendarClock,
  Database,
  FileText,
  FolderOpen,
  Gavel,
  Handshake,
  IdCard,
  Kanban,
  Lightbulb,
  ListChecks,
  MapPin,
  MessageSquareWarning,
  Network,
  Package,
  Scale,
  Server,
  Target,
  Truck,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { api, qs } from "../../api.ts";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import type { BrainEntity, BrainEntitySummary, BrainEvent, BrainGraph, BrainKind, BrainModel, BrainOverview, BrainSource } from "../../types.ts";

/** Query keys of the brain: under the company, so switching companies never mixes them. */
export const brainKeys = {
  all: (company: string) => [company, "brain"] as const,
  model: ["brain-model"] as const,
};

export function useBrainModel() {
  const { path } = useCompany();
  return useQuery({ queryKey: brainKeys.model, queryFn: () => api.get<BrainModel>(path("/brain/model")), staleTime: Infinity });
}

export function useBrainOverview() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: [...brainKeys.all(company), "overview"], queryFn: () => api.get<BrainOverview>(path("/brain/overview")) });
}

export function useBrainEntities(kind: string | undefined, q = "", options: { links?: boolean } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...brainKeys.all(company), "entities", kind ?? "", q, options.links ? "links" : ""],
    queryFn: () =>
      api.get<BrainEntitySummary[]>(path(`/brain/entities${qs({ kind, q: q.trim() || undefined, limit: 1000, with: options.links ? "links" : undefined })}`)),
    enabled: Boolean(kind) || Boolean(q.trim()),
    placeholderData: (previous) => previous,
  });
}

/** A kind's name inside a sentence: "people", but "AI employees". */
export function lowerName(name: string): string {
  return /^AI\b/.test(name) ? name : name.toLowerCase();
}

export function useBrainEntity(id: string | undefined) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...brainKeys.all(company), "entity", id ?? ""],
    queryFn: () => api.get<BrainEntity>(path(`/brain/entities/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
  });
}

export function useBrainGraph(focus: string | null, depth: number) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...brainKeys.all(company), "graph", focus ?? "", depth],
    queryFn: () => api.get<BrainGraph>(path(`/brain/graph${qs({ focus, depth, limit: 70 })}`)),
    placeholderData: (previous) => previous,
  });
}

export function useBrainSources() {
  const { company, path } = useCompany();
  return useQuery({ queryKey: [...brainKeys.all(company), "sources"], queryFn: () => api.get<BrainSource[]>(path("/brain/sources")) });
}

export function useBrainEvents(filter: { origin?: string; limit?: number } = {}) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: [...brainKeys.all(company), "events", filter.origin ?? "", filter.limit ?? 50],
    queryFn: () => api.get<BrainEvent[]>(path(`/brain/events${qs({ origin: filter.origin, limit: filter.limit ?? 50 })}`)),
  });
}

/** Managers and admins shape the brain; everyone reads it and adds know-how. */
export function useMayEditBrain(): boolean {
  const viewer = useViewer();
  return !viewer || viewer.isAdmin || viewer.departments.some((d) => d.role === "manager");
}

export const KIND_ICONS: Record<string, LucideIcon> = {
  company: Building2,
  department: Network,
  person: User,
  role: IdCard,
  ai_employee: Bot,
  site: MapPin,
  process: Workflow,
  policy: Scale,
  document: FileText,
  system: AppWindow,
  database: Database,
  data_store: FolderOpen,
  infrastructure: Server,
  client: Handshake,
  deal: BadgeDollarSign,
  case: MessageSquareWarning,
  supplier: Truck,
  product: Package,
  project: Kanban,
  task: ListChecks,
  goal: Target,
  decision: Gavel,
  knowhow: Lightbulb,
  term: BookA,
};

export const DIMENSION_ICONS: Record<string, LucideIcon> = {
  organization: Users,
  processes: Workflow,
  systems: Server,
  market: Handshake,
  work: Kanban,
  knowhow: Lightbulb,
};

export function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? CalendarClock;
}

/** Colours of each area of the brain (written out whole, so Tailwind keeps them). */
export const DIMENSION_COLORS: Record<string, { chip: string; icon: string; dot: string; fill: string; stroke: string; soft: string }> = {
  organization: {
    chip: "bg-sky-50 text-sky-800 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-400/25",
    icon: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    dot: "bg-sky-500",
    fill: "fill-sky-500",
    stroke: "stroke-sky-500",
    soft: "fill-sky-50 dark:fill-sky-950",
  },
  processes: {
    chip: "bg-violet-50 text-violet-800 ring-violet-600/15 dark:bg-violet-400/10 dark:text-violet-200 dark:ring-violet-400/25",
    icon: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    dot: "bg-violet-500",
    fill: "fill-violet-500",
    stroke: "stroke-violet-500",
    soft: "fill-violet-50 dark:fill-violet-950",
  },
  systems: {
    chip: "bg-emerald-50 text-emerald-800 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-400/25",
    icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-emerald-500",
    fill: "fill-emerald-500",
    stroke: "stroke-emerald-500",
    soft: "fill-emerald-50 dark:fill-emerald-950",
  },
  market: {
    chip: "bg-amber-50 text-amber-900 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/25",
    icon: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-500",
    fill: "fill-amber-500",
    stroke: "stroke-amber-500",
    soft: "fill-amber-50 dark:fill-amber-950",
  },
  work: {
    chip: "bg-rose-50 text-rose-800 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-200 dark:ring-rose-400/25",
    icon: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    dot: "bg-rose-500",
    fill: "fill-rose-500",
    stroke: "stroke-rose-500",
    soft: "fill-rose-50 dark:fill-rose-950",
  },
  knowhow: {
    chip: "bg-teal-50 text-teal-800 ring-teal-600/15 dark:bg-teal-400/10 dark:text-teal-200 dark:ring-teal-400/25",
    icon: "bg-teal-100 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
    dot: "bg-teal-500",
    fill: "fill-teal-500",
    stroke: "stroke-teal-500",
    soft: "fill-teal-50 dark:fill-teal-950",
  },
};

export function colorsOf(model: BrainModel | undefined, kind: string) {
  const dimension = model?.kinds.find((k) => k.key === kind)?.dimension ?? "organization";
  return DIMENSION_COLORS[dimension] ?? DIMENSION_COLORS.organization!;
}

export function kindOf(model: BrainModel | undefined, kind: string): BrainKind | undefined {
  return model?.kinds.find((k) => k.key === kind);
}

export function brainPath(id: string): string {
  return `/brain/e/${id}`;
}

/** A thing's icon in its area's colour. */
export function KindIcon({
  kind,
  model,
  size = "md",
  className,
}: {
  kind: string;
  model: BrainModel | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const Icon = kindIcon(kind);
  const colors = colorsOf(model, kind);
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center",
        size === "sm" ? "size-6 rounded-md" : size === "lg" ? "size-11 rounded-xl" : "size-8 rounded-lg",
        colors.icon,
        className,
      )}
      title={kindOf(model, kind)?.name}
    >
      <Icon className={size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

/** A link to a thing of the brain, as a small pill. */
export function ThingChip({
  thing,
  model,
  detail,
  className,
}: {
  thing: { id: string; kind: string; name: string };
  model: BrainModel | undefined;
  detail?: string;
  className?: string;
}) {
  const Icon = kindIcon(thing.kind);
  const colors = colorsOf(model, thing.kind);
  return (
    <Link
      to={brainPath(thing.id)}
      className={clsx(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset hover:opacity-80",
        colors.chip,
        className,
      )}
      title={kindOf(model, thing.kind)?.name}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{thing.name}</span>
      {detail && <span className="shrink-0 opacity-70">· {detail}</span>}
    </Link>
  );
}

/** Where values came from, in words. */
export const ORIGIN_NAMES: Record<string, string> = {
  manual: "people",
  brain: "the brain",
  platform: "Enterprise Brain",
  hr: "HR system",
  inventory: "IT inventory",
  intranet: "Intranet",
  crm: "CRM",
  erp: "ERP",
  itsm: "IT service desk",
  projects: "Project tool",
  teams: "Teams",
  slack: "Slack",
  email: "Email",
};

export function originName(origin: string): string {
  return ORIGIN_NAMES[origin] ?? origin;
}
