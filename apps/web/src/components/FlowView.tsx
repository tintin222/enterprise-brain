import { clsx } from "clsx";
import { CircleCheckBig, Flag, Play, Repeat, ShieldCheck, Sparkles } from "lucide-react";
import { useId, useMemo } from "react";
import { layoutFlow, type FlowEdge, type FlowNode, type FlowTone } from "../lib/flow-layout.ts";
import { stepIcon } from "../lib/icons.tsx";
import type { AgentDefinition, RunStep } from "../types.ts";

type Status = RunStep["status"];

const TONE: Record<FlowTone, string> = {
  neutral: "border-line bg-surface",
  brand: "border-brand-300 bg-brand-50/60 dark:border-brand-400/40 dark:bg-brand-400/10",
  amber: "border-amber-300 bg-amber-50/70 dark:border-amber-400/40 dark:bg-amber-400/10",
  violet: "border-violet-300 bg-violet-50/70 dark:border-violet-400/40 dark:bg-violet-400/10",
  green: "border-emerald-300 bg-emerald-50/70 dark:border-emerald-400/40 dark:bg-emerald-400/10",
  sky: "border-sky-300 bg-sky-50/70 dark:border-sky-400/40 dark:bg-sky-400/10",
};

const STATUS_RING: Record<Status, string> = {
  succeeded: "ring-2 ring-emerald-500/80",
  failed: "ring-2 ring-red-500/80",
  waiting: "ring-2 ring-amber-400/90",
  running: "ring-2 ring-sky-500/80",
  skipped: "opacity-55",
};

const STATUS_DOT: Record<Status, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  waiting: "bg-amber-400",
  running: "bg-sky-500",
  skipped: "bg-faint",
};

const STATUS_WORD: Record<Status, string> = { succeeded: "done", failed: "failed", waiting: "waiting", running: "running", skipped: "left out" };

/** How each step went in a run: the worst of its rounds and attempts (failed, waiting, running, done, left out). */
function statusByStep(steps: RunStep[] | undefined): Map<string, Status> {
  const order: Status[] = ["failed", "waiting", "running", "succeeded", "skipped"];
  const out = new Map<string, Status>();
  const latest = new Map<string, RunStep>();
  for (const step of steps ?? []) {
    const seen = latest.get(step.key);
    if (!seen || step.attempt > seen.attempt) latest.set(step.key, step);
  }
  for (const step of latest.values()) {
    const current = out.get(step.stepId);
    if (!current || order.indexOf(step.status) < order.indexOf(current)) out.set(step.stepId, step.status);
  }
  return out;
}

function pathOf(points: FlowEdge["points"]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
}

function NodeIcon({ node }: { node: FlowNode }) {
  const Icon =
    node.kind === "trigger"
      ? Play
      : node.kind === "end"
        ? Flag
        : node.kind === "agent"
          ? Sparkles
          : node.kind === "asks"
            ? ShieldCheck
            : node.kind === "nothing"
              ? CircleCheckBig
              : stepIcon(node.stepType ?? "");
  return <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />;
}

/**
 * A job as a flow: what starts it, its steps with decisions side by side and loops framed, and the end.
 * Steps are buttons (keyboard too) that say which one was chosen; with a run's steps, each shows how it went.
 */
export function FlowView({
  definition,
  runSteps,
  selected,
  onSelect,
  starts,
  compact,
  className,
}: {
  definition: Pick<AgentDefinition, "workflow" | "triggers" | "tools" | "connectors" | "guardrails">;
  runSteps?: RunStep[];
  selected?: string | null;
  onSelect?: (stepId: string) => void;
  /** What started it, instead of its duties (a run: what started that run). */
  starts?: string[];
  compact?: boolean;
  className?: string;
}) {
  const marker = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const layout = useMemo(() => layoutFlow(definition, { compact, starts }), [definition, compact, starts]);
  const status = useMemo(() => statusByStep(runSteps), [runSteps]);
  return (
    <div className={clsx("overflow-auto", className)}>
      <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
        <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id={`arrow-${marker}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fill-line-strong" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <path key={edge.id} d={pathOf(edge.points)} className="fill-none stroke-line-strong" strokeWidth={1.5} markerEnd={`url(#arrow-${marker})`} />
          ))}
        </svg>

        {layout.groups.map((group) => {
          const state = status.get(group.stepId);
          return (
            <div
              key={group.id}
              className={clsx(
                "absolute rounded-2xl border border-dashed border-line-strong bg-subtle/40",
                state && STATUS_RING[state],
                selected === group.stepId && "ring-2 ring-brand-500",
              )}
              style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
            >
              <button
                type="button"
                onClick={() => onSelect?.(group.stepId)}
                disabled={!onSelect}
                className="flex w-full items-center gap-1.5 truncate rounded-t-2xl px-3 py-2 text-left text-xs font-medium text-fg enabled:hover:bg-subtle/80"
                title={group.subtitle}
              >
                <Repeat className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                <span className="truncate">{group.title}</span>
                {group.subtitle && <span className="hidden truncate font-normal text-muted sm:inline">· {group.subtitle}</span>}
              </button>
            </div>
          );
        })}

        {layout.edges
          .filter((edge) => edge.label && edge.labelAt)
          .map((edge) => (
            <span
              key={`${edge.id}-label`}
              className="absolute max-w-[14rem] -translate-x-1/2 -translate-y-full truncate rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] text-muted shadow-xs"
              style={{ left: edge.labelAt!.x, top: edge.labelAt!.y }}
              title={edge.label}
            >
              {edge.label}
            </span>
          ))}

        {layout.nodes.map((node) => {
          const state = node.stepId ? status.get(node.stepId) : undefined;
          const selectable = Boolean(onSelect && node.stepId);
          const round = node.kind === "trigger" || node.kind === "end";
          return (
            <button
              key={node.id}
              type="button"
              disabled={!selectable}
              onClick={() => node.stepId && onSelect?.(node.stepId)}
              aria-pressed={selectable ? selected === node.stepId : undefined}
              aria-label={`${node.title}${node.subtitle ? `: ${node.subtitle}` : ""}${state ? ` (${STATUS_WORD[state]})` : ""}`}
              className={clsx(
                "absolute flex items-center gap-2 border text-left shadow-xs transition-shadow",
                round ? "rounded-full px-3" : "rounded-xl px-3 py-2",
                node.kind === "trigger" || node.kind === "end" || node.kind === "nothing" ? "border-line bg-subtle" : TONE[node.tone],
                selectable && "cursor-pointer hover:shadow-md",
                !selectable && "cursor-default",
                state && STATUS_RING[state],
                selected === node.stepId && node.stepId && "ring-2 ring-brand-500",
              )}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            >
              <NodeIcon node={node} />
              <span className="min-w-0 flex-1">
                <span className={clsx("block truncate font-medium text-fg", compact ? "text-xs" : "text-[13px]")}>{node.title}</span>
                {node.subtitle && !compact && <span className="block truncate text-[11px] text-muted">{node.subtitle}</span>}
              </span>
              {state && <span className={clsx("size-2 shrink-0 rounded-full", STATUS_DOT[state])} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
