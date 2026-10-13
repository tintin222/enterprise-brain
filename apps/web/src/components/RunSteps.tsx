import { clsx } from "clsx";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, Hourglass, RotateCcw, SkipForward, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { formatDuration, formatMoney } from "../lib/format.ts";
import { stepIcon } from "../lib/icons.tsx";
import { STEP_TYPE_LABELS } from "../lib/labels.ts";
import type { RunStep, WorkflowStep } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";

const STATUS: Record<RunStep["status"], { icon: LucideIcon; tone: string; label: string }> = {
  succeeded: { icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400", label: "Done" },
  failed: { icon: CircleX, tone: "text-red-600 dark:text-red-400", label: "Failed" },
  skipped: { icon: SkipForward, tone: "text-faint", label: "Left out" },
  waiting: { icon: Hourglass, tone: "text-amber-600 dark:text-amber-300", label: "Waiting" },
  running: { icon: CircleDashed, tone: "text-sky-600 dark:text-sky-300", label: "Running" },
};

/** One step of the run: its attempts (the last one shown), where it is in the job, and how deep. */
interface StepRow {
  key: string;
  attempts: RunStep[];
  latest: RunStep;
  depth: number;
  round: number | null;
}

/** Rows by step key, in the order they first ran; a key's depth is how many loops it is in. */
function rowsOf(steps: RunStep[]): StepRow[] {
  const byKey = new Map<string, RunStep[]>();
  for (const step of steps) byKey.set(step.key, [...(byKey.get(step.key) ?? []), step]);
  return [...byKey.entries()].map(([key, attempts]) => {
    const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt);
    return { key, attempts: sorted, latest: sorted.at(-1)!, depth: key.split("/").length - 1, round: sorted.at(-1)!.iteration };
  });
}

/** How deep each step id is held in the job (inside decisions and loops), for indenting rows whose key does not say. */
function depthsOf(steps: WorkflowStep[], depth = 0, out = new Map<string, number>()): Map<string, number> {
  for (const step of steps) {
    out.set(step.id, depth);
    if (step.type === "branch") {
      for (const c of step.cases) depthsOf(c.steps, depth + 1, out);
      if (step.else) depthsOf(step.else, depth + 1, out);
    } else if (step.type === "each") depthsOf(step.steps, depth + 1, out);
  }
  return out;
}

function Data({ label, value, truncated }: { label: string; value: unknown; truncated: boolean }) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted">
        {label}
        {truncated && <span className="font-normal"> · the first 64 kB</span>}
      </p>
      <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-subtle/60 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">
        {text}
      </pre>
    </div>
  );
}

/**
 * Every step of a run, in the order they ran: what each was given (its templates resolved), what it gave,
 * its error, how long it took and what it cost; steps inside decisions and loops are indented, a loop's
 * rounds numbered. A manager runs the job again from one of its top-level steps.
 */
export function RunSteps({
  steps,
  workflow,
  rerunFrom = [],
  onRerun,
  rerunning,
}: {
  steps: RunStep[];
  workflow?: WorkflowStep[];
  /** Keys it may run again from (none when the viewer may not, or the run is still going). */
  rerunFrom?: string[];
  onRerun?: (key: string) => void;
  rerunning?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!steps.length) return <p className="px-5 py-4 text-sm text-muted">No steps ran yet.</p>;
  const depths = depthsOf(workflow ?? []);
  return (
    <ul className="divide-y divide-line">
      {rowsOf(steps).map((row) => {
        const { latest } = row;
        const status = STATUS[latest.status] ?? STATUS.running;
        const Icon = stepIcon(latest.type);
        const expanded = open === row.key;
        const cost = typeof latest.usage?.costUsd === "number" ? latest.usage.costUsd : 0;
        const depth = Math.max(row.depth, depths.get(latest.stepId) ?? 0);
        const failures = row.attempts.filter((a) => a.status === "failed" && a !== latest);
        return (
          <li key={row.key}>
            <div className="flex items-center gap-2 px-4 py-2.5 sm:px-5" style={{ paddingLeft: `calc(${depth * 1.25}rem + 1rem)` }}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : row.key)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-muted" />}
                <status.icon className={clsx("size-4 shrink-0", status.tone)} aria-label={status.label} />
                <Icon className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 truncate text-sm font-medium text-fg">{latest.stepId}</span>
                <span className="hidden text-xs text-muted sm:inline">{STEP_TYPE_LABELS[latest.type as WorkflowStep["type"]] ?? latest.type}</span>
                {row.round !== null && (
                  <Badge size="xs" tone="neutral">
                    round {row.round + 1}
                  </Badge>
                )}
                {row.attempts.length > 1 && (
                  <Badge size="xs" tone="amber">
                    {row.attempts.length} attempts
                  </Badge>
                )}
              </button>
              <span className="shrink-0 text-xs whitespace-nowrap text-muted tabular-nums">
                {formatDuration(latest.durationMs)}
                {cost ? ` · ${formatMoney(cost)}` : ""}
              </span>
              {onRerun && rerunFrom.includes(row.key) && (
                <Button
                  size="xs"
                  variant="ghost"
                  icon={RotateCcw}
                  loading={rerunning === row.key}
                  onClick={() => onRerun(row.key)}
                  title="A new run of the job as it is now: the steps before this one keep what they found"
                >
                  <span className="hidden sm:inline">Run again from here</span>
                  <span className="sm:hidden">Again</span>
                </Button>
              )}
            </div>
            {expanded && (
              <div className="space-y-3 px-4 pb-4 sm:px-5" style={{ paddingLeft: `calc(${depth * 1.25}rem + 2.75rem)` }}>
                {latest.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-400/10 dark:text-red-200">{latest.error}</p>}
                {failures.map((a) => (
                  <p key={a.id} className="text-xs text-muted">
                    Attempt {a.attempt} failed{a.error ? `: ${a.error}` : ""}
                  </p>
                ))}
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <Data label="Given" value={latest.input} truncated={latest.inputTruncated} />
                  <Data label={latest.status === "waiting" ? "Waiting for" : "Gave"} value={latest.output} truncated={latest.outputTruncated} />
                </div>
                {latest.input == null && latest.output == null && !latest.error && <p className="text-xs text-muted">Nothing to show for this step.</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
