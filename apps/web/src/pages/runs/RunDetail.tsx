import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CirclePlay, FlaskConical, ListOrdered, ListTree, Monitor, Pin, Sparkles, UserCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, isApiError, subscribe } from "../../api.ts";
import { ApprovalCard } from "../../components/ApprovalCard.tsx";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { FlowView } from "../../components/FlowView.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { FileIdLink } from "../../components/FileLink.tsx";
import { JsonDetails } from "../../components/JsonView.tsx";
import { KeyValue } from "../../components/KeyValue.tsx";
import { Page } from "../../components/Layout.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { OutputView } from "../../components/OutputView.tsx";
import { RunSteps } from "../../components/RunSteps.tsx";
import { RunTimeline, useRunDetail } from "../../components/RunViews.tsx";
import { ScreenRunView, isScreenRun } from "../../components/ScreenRun.tsx";
import { ErrorState, LoadingBlock, Spinner } from "../../components/Spinner.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { displayValue, formatDateTime, formatMoney, formatNumber, humanize, isRecord, isUuid, runDuration } from "../../lib/format.ts";
import { runTriggerLabel } from "../../lib/labels.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import { useStoredFlag } from "../../lib/preferences.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import type { RunExample, RunRow } from "../../types.ts";

function InputValue({ value }: { value: unknown }): ReactNode {
  if (isUuid(value)) return <FileIdLink fileId={value} />;
  if (Array.isArray(value) && value.length && value.every(isUuid)) {
    return (
      <div className="flex flex-col gap-1">
        {value.map((id) => (
          <FileIdLink key={id} fileId={id} />
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length));
    return (
      <div className="space-y-1 rounded-lg border border-line p-2.5">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[7rem_1fr] gap-2 text-[13px]">
            <span className="text-muted">{humanize(k)}</span>
            <span className="min-w-0 break-words whitespace-pre-wrap">
              <InputValue value={v} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "string" && value.length > 200) return <span className="block max-h-48 overflow-y-auto whitespace-pre-wrap">{value}</span>;
  return <span className="whitespace-pre-wrap">{displayValue(value)}</span>;
}

/** A name for an example from what the run was given: its first short text. */
function exampleName(input: Record<string, unknown>): string {
  const text = Object.values(input).find((v): v is string => typeof v === "string" && v.trim().length > 0 && !isUuid(v));
  return text ? text.trim().slice(0, 60) : "Example";
}

/** Keep what a run was given as an example, to try the AI employee with again. */
function PinDialog({ slug, run, open, onClose }: { slug: string; run: RunRow; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(() => exampleName(run.input ?? {}));
  const pin = useMutation({
    mutationFn: () => api.post<{ example: RunExample }>(path(`/agents/${encodeURIComponent(slug)}/examples`), { name: name.trim(), runId: run.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agent(company, slug) });
      toast.success("Pinned as an example", { description: "Try it offers it, to run the AI employee on the same input again." });
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) pin.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Pin as an example" description="What this run was given is kept: Try it can start from it again.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="example-name" className="label">
            Name
          </label>
          <input id="example-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={Pin} loading={pin.isPending} disabled={!name.trim()}>
            Pin it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function RunDetail() {
  const { id = "" } = useParams();
  useDocumentTitle("Run");
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useRunDetail(id, 5000);
  const navigate = useNavigate();
  const [delta, setDelta] = useState("");
  const [pinning, setPinning] = useState(false);
  const [asFlow, setAsFlow] = useStoredFlag("eb.run.flow", () => false);
  const timer = useRef<number | null>(null);
  const status = data?.run.status;
  const live = status === "running" || status === "queued";

  // Live updates while the run is executing: SSE events trigger a (throttled) refetch; `delta` streams text.
  useEffect(() => {
    if (!live) return;
    const scheduleRefetch = () => {
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void refetch();
      }, 600);
    };
    const unsubscribe = subscribe(
      path(`/runs/${encodeURIComponent(id)}/stream`),
      ["event", "delta", "end"],
      (event, payload) => {
        if (event === "delta") setDelta((d) => d + String((payload as { delta?: string }).delta ?? ""));
        else if (event === "event") scheduleRefetch();
        else if (event === "end") {
          void refetch();
          void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
        }
      },
      () => void refetch(),
    );
    return () => {
      unsubscribe();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [live, id, path, refetch, queryClient, company]);

  const rerun = useMutation({
    mutationFn: (fromKey: string) => api.post<RunRow>(path(`/runs/${encodeURIComponent(id)}/rerun`), { fromKey }),
    onSuccess: (again) => {
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
      toast.success("Running again", { description: "A new run: the steps before keep what they found." });
      navigate(`/runs/${again.id}`);
    },
    onError: (e) => toast.error(e),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(path(`/runs/${encodeURIComponent(id)}/cancel`)),
    onSuccess: () => {
      void refetch();
      toast.success("Run cancelled");
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <LoadingBlock className="flex-1" />;
  if (isApiError(error, 404)) {
    return (
      <Page>
        <EmptyState
          icon={CirclePlay}
          title="Run not found"
          action={
            <ButtonLink to="/work?view=tasks" variant="primary">
              All tasks
            </ButtonLink>
          }
        />
      </Page>
    );
  }
  if (error || !data) {
    return (
      <Page>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Page>
    );
  }

  const { run, events, approvals, agent } = data;
  const settled = ["succeeded", "failed", "cancelled"].includes(run.status);
  const inputEntries = Object.entries(run.input ?? {});
  const usage = run.usage ?? {};
  // Steps that worked an old system's screens: what they found, and the last screen.
  const screenSteps = Object.entries(run.context?.steps ?? {}).flatMap(([stepId, value]) =>
    isRecord(value) && isScreenRun(value.screens) ? [{ stepId, summary: typeof value.summary === "string" ? value.summary : "", screens: value.screens }] : [],
  );

  return (
    <Page>
      <div className="mb-2 text-sm">
        <Link to="/work?view=tasks" className="text-muted hover:text-fg">
          Work
        </Link>
        {run.taskId && (
          <>
            <span className="mx-1.5 text-faint">/</span>
            <Link to={`/work/${run.taskId}`} className="text-muted hover:text-fg">
              Task
            </Link>
          </>
        )}
        <span className="mx-1.5 text-faint">/</span>
        <span className="font-mono text-xs text-fg">Run {run.id.slice(0, 8)}</span>
      </div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
              {agent ? (
                <Link to={`/ai/${agent.slug}`} className="hover:underline">
                  {agent.name}
                </Link>
              ) : (
                "Run"
              )}
            </h1>
            <StatusPill status={run.status} />
            {run.isTest && (
              <Badge tone="violet" icon={FlaskConical}>
                Test run
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {runTriggerLabel(run.trigger)} · started {formatDateTime(run.startedAt ?? run.createdAt)} · {runDuration(run)}
            {usage.costUsd ? ` · ${formatMoney(usage.costUsd)}` : ""}
            {run.currentStep && live ? ` · now: ${run.currentStep}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {agent && data.canManage && Object.keys(run.input ?? {}).length > 0 && (
            <Button size="sm" icon={Pin} onClick={() => setPinning(true)}>
              Pin as an example
            </Button>
          )}
          {agent && (
            <ButtonLink to={`/ai/${agent.slug}/app`} size="sm">
              Open app
            </ButtonLink>
          )}
          {(live || run.status === "waiting_approval") && (
            <Button size="sm" variant="danger" icon={Ban} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel run
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-6">
          {approvals.some((a) => a.status === "pending") && (
            <div className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
                <UserCheck className="size-4 text-amber-500" /> Waiting for your decision
              </h2>
              {approvals
                .filter((a) => a.status === "pending")
                .map((a) => (
                  <ApprovalCard key={a.id} approval={{ ...a, agentName: agent?.name }} showAgent={false} />
                ))}
            </div>
          )}

          {live && (
            <Card className="border-sky-200 dark:border-sky-400/20">
              <div className="flex items-center gap-2 px-5 py-4 text-sm font-medium text-fg">
                <Spinner size="sm" /> Running{run.currentStep ? ` — ${run.currentStep}` : "…"}
              </div>
              {delta && (
                <div className="border-t border-line px-5 py-3">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                    <Sparkles className="size-3.5" /> Writing
                  </p>
                  <Markdown compact>{delta}</Markdown>
                </div>
              )}
            </Card>
          )}

          {run.status === "failed" && <ErrorState title="The run failed" error={run.error ?? "Unknown error"} />}

          <Card>
            <CardHeader title="Output" icon={Sparkles} />
            <div className="p-5">
              {run.output && Object.keys(run.output).length ? (
                <OutputView output={run.output} fields={agent?.outputs ?? []} highlight={agent?.ui?.highlight ?? []} />
              ) : (
                <p className="text-sm text-muted">
                  {live
                    ? "The output appears when the run finishes."
                    : run.status === "waiting_approval"
                      ? "The run continues after the approval."
                      : "No output."}
                </p>
              )}
            </div>
          </Card>

          {(data.steps?.length ?? 0) > 0 && (
            <Card className="overflow-hidden">
              <CardHeader
                title="Steps"
                icon={ListOrdered}
                subtitle={
                  data.canManage && settled && data.rerunFrom?.length
                    ? "What each step was given and gave. Run the job again from a step: the steps before it keep what they found."
                    : "What each step was given and gave, in the order they ran."
                }
                actions={
                  agent?.workflow?.length ? (
                    <Segmented<"list" | "flow">
                      value={asFlow ? "flow" : "list"}
                      onChange={(v) => setAsFlow(v === "flow")}
                      options={[
                        { value: "list", label: "Steps" },
                        { value: "flow", label: "Flow" },
                      ]}
                    />
                  ) : undefined
                }
              />
              {asFlow && agent?.workflow?.length ? (
                <div className="p-4">
                  <FlowView
                    definition={{
                      workflow: agent.workflow,
                      triggers: [],
                      tools: [],
                      connectors: [],
                      guardrails: { approvalRequiredFor: [], personalData: "none" },
                    }}
                    starts={[runTriggerLabel(run.trigger)]}
                    runSteps={data.steps}
                    className="max-h-[36rem]"
                  />
                </div>
              ) : (
                <RunSteps
                  steps={data.steps ?? []}
                  workflow={agent?.workflow}
                  rerunFrom={data.canManage && settled ? (data.rerunFrom ?? []) : []}
                  onRerun={(key) => rerun.mutate(key)}
                  rerunning={rerun.isPending ? (rerun.variables ?? null) : null}
                />
              )}
            </Card>
          )}

          {screenSteps.length > 0 && (
            <Card>
              <CardHeader title="On the screens" icon={Monitor} subtitle="What it did in systems without an API, and the last screen it saw" />
              <div className="space-y-6 p-5">
                {screenSteps.map((step) => (
                  <div key={step.stepId}>
                    <p className="mb-2 text-sm text-fg">
                      <span className="font-mono text-xs text-muted">{step.stepId}</span>
                      {step.summary ? ` · ${step.summary}` : ""}
                    </p>
                    <ScreenRunView run={step.screens} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Input" />
            <div className="px-5 py-2">
              {inputEntries.length ? (
                <KeyValue items={inputEntries.map(([k, v]) => [humanize(k), <InputValue key={k} value={v} />])} />
              ) : (
                <p className="py-3 text-sm text-muted">No input.</p>
              )}
            </div>
          </Card>

          {approvals.some((a) => a.status !== "pending") && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-fg">Decisions</h2>
              {approvals
                .filter((a) => a.status !== "pending")
                .map((a) => (
                  <ApprovalCard key={a.id} approval={{ ...a, agentName: agent?.name }} showAgent={false} />
                ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Timeline" icon={ListTree} subtitle={`${events.length} events`} />
            <div className="px-5 pt-4 pb-1">
              <RunTimeline events={events} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Usage" />
            <div className="px-5 py-2">
              <KeyValue
                dense
                items={[
                  ["Model calls", formatNumber(typeof usage.calls === "number" ? usage.calls : 0)],
                  ["Input tokens", formatNumber(typeof usage.inputTokens === "number" ? usage.inputTokens : 0)],
                  ["Output tokens", formatNumber(typeof usage.outputTokens === "number" ? usage.outputTokens : 0)],
                  ["Cost", formatMoney(typeof usage.costUsd === "number" ? usage.costUsd : 0)],
                  ["Agent version", `v${run.agentVersion}`],
                  ["Finished", formatDateTime(run.finishedAt)],
                ]}
              />
              <JsonDetails data={run} label="Raw run" className="py-3" />
            </div>
          </Card>
        </div>
      </div>
      {agent && pinning && <PinDialog slug={agent.slug} run={run} open={pinning} onClose={() => setPinning(false)} />}
    </Page>
  );
}
