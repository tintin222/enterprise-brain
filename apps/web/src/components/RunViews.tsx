import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Ban,
  Check,
  CircleCheck,
  CircleCheckBig,
  CirclePlay,
  CircleX,
  ExternalLink,
  FlaskConical,
  Hourglass,
  Play,
  SkipForward,
  TriangleAlert,
  UserCheck,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatMoney, formatTime, runDuration, timeAgo } from "../lib/format.ts";
import { stepIcon } from "../lib/icons.tsx";
import { runTriggerLabel } from "../lib/labels.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDefinition, FieldSpec, RunDetail, RunEvent, RunRow, UploadedFile } from "../types.ts";
import { Badge, StatusPill } from "./Badge.tsx";
import { Button, ButtonLink } from "./Button.tsx";
import { DemoSamplesButton } from "./DemoSamples.tsx";
import { buildRunForm, FieldForm, missingRequired, type FieldValue, type FormValues } from "./FieldForm.tsx";
import { CellValue, OutputView } from "./OutputView.tsx";
import { Callout, ErrorState, Spinner } from "./Spinner.tsx";
import { Timeline, type TimelineItem } from "./Timeline.tsx";

export const LIVE_STATUSES = new Set(["running", "queued"]);

/** Run detail; polls while the run is live. */
export function useRunDetail(runId: string | undefined, poll = 1200) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: keys.run(company, runId ?? ""),
    queryFn: () => api.get<RunDetail>(path(`/runs/${encodeURIComponent(runId ?? "")}`)),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data && LIVE_STATUSES.has(query.state.data.run.status) ? poll : false),
  });
}

// ---------------------------------------------------------------------------
// Events timeline
// ---------------------------------------------------------------------------

function eventVisual(event: RunEvent): { icon: LucideIcon; tone: TimelineItem["tone"] } {
  switch (event.type) {
    case "run.started":
      return { icon: CirclePlay, tone: "brand" };
    case "step.started":
      return { icon: stepIcon(String(event.data?.type ?? "")), tone: "blue" };
    case "step.completed":
      return { icon: CircleCheck, tone: "green" };
    case "step.skipped":
      return { icon: SkipForward, tone: "neutral" };
    case "step.failed":
    case "run.failed":
      return { icon: CircleX, tone: "red" };
    case "approval.requested":
      return { icon: UserCheck, tone: "amber" };
    case "approval.decided":
      return { icon: /rejected/i.test(event.message) ? X : Check, tone: /rejected/i.test(event.message) ? "red" : "green" };
    case "approval.executed":
    case "run.succeeded":
      return { icon: CircleCheckBig, tone: "green" };
    case "run.cancelled":
      return { icon: Ban, tone: "neutral" };
    case "tool.call":
    case "tool.result":
      return { icon: Wrench, tone: "neutral" };
    case "warning":
      return { icon: TriangleAlert, tone: "amber" };
    default:
      return { icon: CircleCheck, tone: "neutral" };
  }
}

function eventDetails(event: RunEvent) {
  const data = event.data ?? {};
  const preview = typeof data.preview === "string" ? data.preview : undefined;
  const rest = Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== "preview" && k !== "type" && v !== null && v !== undefined));
  if (!preview && !Object.keys(rest).length) return undefined;
  return (
    <div className="space-y-2">
      {preview && <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-subtle/60 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">{preview}</pre>}
      {Object.keys(rest).length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-subtle/60 p-2.5 font-mono text-[11px] whitespace-pre-wrap text-muted">{JSON.stringify(rest, null, 2)}</pre>
      )}
    </div>
  );
}

export function RunTimeline({ events, compact }: { events: RunEvent[]; compact?: boolean }) {
  const shown = compact ? events.filter((e) => !["tool.result"].includes(e.type)) : events;
  const items: TimelineItem[] = shown.map((e) => {
    const visual = eventVisual(e);
    const duration = typeof e.data?.durationMs === "number" ? `${(e.data.durationMs / 1000).toFixed(1)} s` : undefined;
    return {
      id: e.seq,
      icon: visual.icon,
      tone: visual.tone,
      title: e.message || e.type,
      meta: [e.stepId, duration].filter(Boolean).join(" · ") || undefined,
      time: formatTime(e.createdAt),
      details: compact ? undefined : eventDetails(e),
    };
  });
  if (!items.length) return <p className="text-sm text-muted">No events yet.</p>;
  return <Timeline items={items} />;
}

// ---------------------------------------------------------------------------
// Live result of one run (progress → output)
// ---------------------------------------------------------------------------

export function LiveRunResult({
  runId,
  outputs,
  highlight,
  onDismiss,
}: {
  runId: string;
  outputs?: FieldSpec[];
  highlight?: string[];
  onDismiss?: () => void;
}) {
  const { data, error, refetch } = useRunDetail(runId);
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted">
        <Spinner size="sm" /> Starting…
      </div>
    );
  }
  const { run, events } = data;
  const fields = outputs ?? data.agent?.outputs ?? [];
  const hl = highlight ?? data.agent?.ui?.highlight ?? [];
  const live = LIVE_STATUSES.has(run.status);
  const lastStep = [...events].reverse().find((e) => e.type === "step.started" || e.type === "step.completed");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={run.status} />
          {run.isTest && (
            <Badge tone="violet" icon={FlaskConical}>
              Test run
            </Badge>
          )}
          <span className="text-xs text-muted">
            {runDuration(run)}
            {run.usage?.costUsd ? ` · ${formatMoney(run.usage.costUsd)}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <ButtonLink to={`/runs/${run.id}`} size="xs" variant="ghost" iconRight={ExternalLink}>
            Run details
          </ButtonLink>
          {onDismiss && !live && (
            <Button size="xs" variant="ghost" icon={X} onClick={onDismiss} aria-label="Dismiss result">
              Close
            </Button>
          )}
        </div>
      </div>
      {live && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-400/20 dark:bg-sky-400/5">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Spinner size="sm" /> {lastStep?.message ?? "Working…"}
          </p>
          <div className="mt-3">
            <RunTimeline events={events} compact />
          </div>
        </div>
      )}
      {run.status === "waiting_approval" && (
        <Callout
          tone="warning"
          icon={Hourglass}
          title="Waiting for a person to approve"
          actions={
            <ButtonLink size="sm" variant="secondary" to="/approvals">
              Open approvals
            </ButtonLink>
          }
        >
          {data.approvals.find((a) => a.status === "pending")?.title ?? "The run pauses until the approval is decided, then continues automatically."}
        </Callout>
      )}
      {run.status === "failed" && <ErrorState title="The run failed" error={run.error ?? "Unknown error"} />}
      {run.status === "cancelled" && <Callout tone="info">This run was cancelled.</Callout>}
      {run.output && Object.keys(run.output).length > 0 && <OutputView output={run.output} fields={fields} highlight={hl} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run form (generated from the agent's inputs)
// ---------------------------------------------------------------------------

export function RunForm({
  slug,
  definition,
  test,
  submitLabel,
  onStarted,
  compact,
}: {
  slug: string;
  definition: AgentDefinition;
  test?: boolean;
  submitLabel?: string;
  onStarted: (run: RunRow) => void;
  compact?: boolean;
}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<FormValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const fileField = definition.inputs.find((f) => f.type === "file" || f.type === "files");

  const upload = async (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    return api.upload<UploadedFile[]>(path("/files"), form);
  };

  const start = useMutation({
    mutationFn: async () => {
      const form = await buildRunForm(definition.inputs, values, upload, { test, wait: false });
      return api.upload<RunRow>(path(`/agents/${encodeURIComponent(slug)}/runs`), form);
    },
    onSuccess: (run) => {
      onStarted(run);
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
      void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
    },
    onError: (error) => toast.error(error),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const miss = missingRequired(definition.inputs, values);
    setMissing(miss);
    if (miss.length) return;
    start.mutate();
  };

  const setValue = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setMissing([]);
  };

  return (
    <form onSubmit={submit} className={clsx("space-y-5", compact && "space-y-4")}>
      <FieldForm fields={definition.inputs} values={values} onChange={setValue} disabled={start.isPending} />
      {missing.length > 0 && <p className="text-sm text-red-600 dark:text-red-400">Please fill in: {missing.join(", ")}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button type="submit" variant="primary" icon={Play} loading={start.isPending}>
          {submitLabel ?? definition.ui.submitLabel ?? "Run"}
        </Button>
        {fileField && (
          <DemoSamplesButton
            label="Try with a demo file"
            onPick={(_ids, _label, files) =>
              setValue(
                fileField.key,
                fileField.type === "file"
                  ? files[0]
                    ? { fileId: files[0].id, name: files[0].name, size: files[0].size }
                    : undefined
                  : files.map((f) => ({ fileId: f.id, name: f.name, size: f.size })),
              )
            }
          />
        )}
        {test && <span className="text-xs text-muted">Test runs never write to real systems; approvals are simulated.</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Runs table
// ---------------------------------------------------------------------------

export function RunsTable({
  runs,
  showAgent = true,
  highlight = [],
  outputs = [],
  empty,
}: {
  runs: RunRow[];
  showAgent?: boolean;
  highlight?: string[];
  outputs?: FieldSpec[];
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  if (!runs.length) return <>{empty ?? <p className="px-5 py-8 text-center text-sm text-muted">No runs yet.</p>}</>;
  const byKey = new Map(outputs.map((f) => [f.key, f]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-subtle/50 text-xs text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">Status</th>
            {showAgent && <th className="px-4 py-2.5 font-medium">Agent</th>}
            {highlight.map((k) => (
              <th key={k} className="px-4 py-2.5 font-medium whitespace-nowrap">
                {byKey.get(k)?.label ?? k}
              </th>
            ))}
            <th className="px-4 py-2.5 font-medium">Trigger</th>
            <th className="px-4 py-2.5 font-medium">Started</th>
            <th className="px-4 py-2.5 text-right font-medium">Duration</th>
            <th className="px-4 py-2.5 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr
              key={run.id}
              onClick={() => navigate(`/runs/${run.id}`)}
              className="cursor-pointer align-middle transition-colors hover:bg-subtle/60"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/runs/${run.id}`)}
            >
              <td className="px-4 py-2.5 whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  <StatusPill status={run.status} size="xs" />
                  {run.isTest && (
                    <Badge size="xs" tone="violet">
                      test
                    </Badge>
                  )}
                </span>
              </td>
              {showAgent && (
                <td className="max-w-[14rem] truncate px-4 py-2.5 font-medium text-fg">
                  {run.agentSlug ? (
                    <Link to={`/agents/${run.agentSlug}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                      {run.agentName ?? run.agentSlug}
                    </Link>
                  ) : (
                    (run.agentName ?? "Agent")
                  )}
                </td>
              )}
              {highlight.map((k) => (
                <td key={k} className="max-w-[16rem] px-4 py-2.5">
                  <CellValue name={k} value={run.output?.[k]} field={byKey.get(k)} />
                </td>
              ))}
              <td className="px-4 py-2.5 whitespace-nowrap text-muted">{runTriggerLabel(run.trigger)}</td>
              <td className="px-4 py-2.5 whitespace-nowrap text-muted" title={run.createdAt}>
                {timeAgo(run.startedAt ?? run.createdAt)}
              </td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted tabular-nums">{runDuration(run)}</td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted tabular-nums">{run.usage?.costUsd ? formatMoney(run.usage.costUsd) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
