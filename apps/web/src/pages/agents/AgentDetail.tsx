import { clsx } from "clsx";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CircleCheck,
  CirclePlay,
  Code,
  ExternalLink,
  FlaskConical,
  Gauge,
  GitCommitVertical as HistoryIcon,
  Inbox,
  LayoutTemplate,
  Lock,
  Pause,
  Plug,
  Rocket,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { isApiError } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { KeyValue } from "../../components/KeyValue.tsx";
import { Page } from "../../components/Layout.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { LiveRunResult, RunForm, RunsTable } from "../../components/RunViews.tsx";
import { Callout, ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { WorkflowView } from "../../components/WorkflowView.tsx";
import { formatDateTime, timeAgo } from "../../lib/format.ts";
import { archetypeIcon, categoryIcon } from "../../lib/icons.tsx";
import { approvalRuleLabel, archetypeLabel, categoryLabel, describeTrigger, PERSONAL_DATA_LABELS } from "../../lib/labels.ts";
import { useAgent, useConnectors, useDepartmentName } from "../../lib/queries.ts";
import type { AgentDefinition, AgentDetail as AgentDetailData, RunRow } from "../../types.ts";
import { useAgentMutations } from "./agentActions.ts";

type Tab = "overview" | "workflow" | "definition" | "versions" | "runs";

function Section({ title, icon: Icon, children, className }: { title: string; icon: typeof Bot; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader title={title} icon={Icon} />
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

function Overview({ detail }: { detail: AgentDetailData }) {
  const { definition, agent } = detail;
  const connectors = useConnectors();
  const departmentName = useDepartmentName();
  const g = definition.guardrails;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="About" icon={Bot} className="lg:col-span-2">
        <KeyValue
          items={[
            ["Summary", definition.summary],
            ["Role", definition.title ?? "—"],
            ["Type", archetypeLabel(definition.archetype)],
            ["Department", departmentName(definition.department)],
            [
              "Source",
              <span key="s">
                {agent.source === "template" ? `Catalog template ${agent.templateId ?? ""}` : agent.source === "builder" ? "Agent Builder" : "Created manually"}
                {agent.builderSessionId && (
                  <Link to={`/builder/${agent.builderSessionId}`} className="ml-2 text-brand-600 hover:underline dark:text-brand-300">
                    Open builder conversation →
                  </Link>
                )}
              </span>,
            ],
            ["Version", `v${agent.version} · updated ${timeAgo(agent.updatedAt)}`],
            ["Knowledge", definition.knowledge.collections.length ? definition.knowledge.collections.join(", ") : "—"],
            ["Tools", definition.tools.length ? definition.tools.join(", ") : "—"],
          ]}
        />
      </Section>

      <Section title="Starts when" icon={CirclePlay}>
        <ul className="space-y-2">
          {definition.triggers.map((t, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-fg">
              {t.type === "mailbox" ? <Inbox className="size-4 text-muted" /> : <CirclePlay className="size-4 text-muted" />}
              {describeTrigger(t)}
            </li>
          ))}
        </ul>
        {agent.status !== "active" && definition.triggers.some((t) => t.type !== "manual" && t.type !== "form" && t.type !== "chat") && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Automatic triggers only fire while the agent is active.</p>
        )}
      </Section>

      <Section title="Systems" icon={Plug}>
        {definition.connectors.length === 0 ? (
          <p className="text-sm text-muted">No business systems.</p>
        ) : (
          <ul className="space-y-3">
            {definition.connectors.map((c) => {
              const Icon = categoryIcon(c.category);
              const instance = connectors.data?.find((i) => i.id === c.instanceId) ?? connectors.data?.find((i) => i.category === c.category && !i.sandbox);
              return (
                <li key={c.ref} className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-fg">
                      {categoryLabel(c.category)} <span className="font-normal text-muted">({c.ref})</span>
                    </p>
                    {c.purpose && <p className="text-xs text-muted">{c.purpose}</p>}
                    <p className="mt-0.5 text-xs">
                      {instance ? (
                        <span className="text-emerald-700 dark:text-emerald-300">Connected: {instance.name}</span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">
                          Using demo data —{" "}
                          <Link to="/connectors" className="underline">
                            connect the real system
                          </Link>
                        </span>
                      )}
                    </p>
                    {c.operations?.length ? <p className="mt-0.5 text-xs text-faint">Operations: {c.operations.join(", ")}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Guardrails" icon={ShieldCheck}>
        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Human approval required for</p>
            {g.approvalRequiredFor.length ? (
              <div className="flex flex-wrap gap-1.5">
                {g.approvalRequiredFor.map((r) => (
                  <Badge key={r} tone="amber">
                    {approvalRuleLabel(r)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-muted">Nothing — fully automatic</p>
            )}
          </div>
          <p className="flex items-center gap-2 text-fg">
            <Lock className="size-4 text-muted" />
            {PERSONAL_DATA_LABELS[g.personalData] ?? g.personalData}
            {g.retentionDays ? <span className="text-muted">· retention {g.retentionDays} days</span> : null}
          </p>
          {g.notes?.length ? (
            <ul className="space-y-1 text-xs text-muted">
              {g.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Section>

      <Section title="KPIs" icon={Gauge}>
        {definition.kpis.length ? (
          <ul className="divide-y divide-line">
            {definition.kpis.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                <span className="text-fg">{k.name}</span>
                {k.target && <Badge tone="green">{k.target}</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No KPIs defined.</p>
        )}
      </Section>

      <Section title="Instructions" icon={BookOpen} className="lg:col-span-2">
        <div className="max-h-96 overflow-y-auto">
          <Markdown compact>{definition.instructions || "_No instructions._"}</Markdown>
        </div>
      </Section>
    </div>
  );
}

function DefinitionEditor({ detail }: { detail: AgentDetailData }) {
  const { save } = useAgentMutations();
  const original = useMemo(() => JSON.stringify(detail.definition, null, 2), [detail.definition]);
  const [text, setText] = useState(original);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [valid, setValid] = useState(false);
  useEffect(() => setText(original), [original]);
  const dirty = text !== original;

  const validate = (): AgentDefinition | null => {
    try {
      const parsed = JSON.parse(text) as Partial<AgentDefinition>;
      const missing = (["slug", "name", "summary", "archetype", "instructions"] as const).filter((k) => !parsed[k]);
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error("The definition must be a JSON object");
      if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);
      if (parsed.slug && !/^[a-z0-9][a-z0-9-]*$/.test(parsed.slug)) throw new Error("slug must be lowercase letters, digits and dashes");
      setProblem(null);
      setValid(true);
      return parsed as AgentDefinition;
    } catch (error) {
      setValid(false);
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  return (
    <Card>
      <CardHeader
        title="Definition"
        subtitle="The complete agent definition as JSON. Saving creates a new version you can roll back."
        icon={Code}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setText(original)} disabled={!dirty}>
            Reset
          </Button>
        }
      />
      <div className="space-y-4 p-5">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setValid(false);
          }}
          spellCheck={false}
          className="input min-h-[28rem] font-mono text-xs leading-relaxed"
          aria-label="Agent definition JSON"
        />
        {problem && <Callout tone="danger">{problem}</Callout>}
        {valid && !problem && (
          <Callout tone="success" icon={CircleCheck}>
            Valid JSON with the required fields. The server validates the full schema when you save.
          </Callout>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Version note" optional className="flex-1">
            {(id) => <input id={id} className="input" placeholder="What changed and why" value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => validate()}>Validate JSON</Button>
            <Button
              variant="primary"
              icon={Save}
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => {
                const definition = validate();
                if (definition) save.mutate({ slug: detail.agent.slug, definition, note: note.trim() || undefined }, { onSuccess: () => setNote("") });
              }}
            >
              Save as new version
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Versions({ detail }: { detail: AgentDetailData }) {
  const { rollback } = useAgentMutations();
  const versions = [...detail.versions].sort((a, b) => b.version - a.version);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Versions" subtitle="Every change to the definition is kept. Rolling back creates a new version with the old definition." icon={HistoryIcon} />
      <ul className="divide-y divide-line">
        {versions.map((v) => {
          const current = v.version === detail.agent.version;
          return (
            <li key={v.version} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span
                className={clsx(
                  "flex h-7 min-w-10 items-center justify-center rounded-lg px-2 text-xs font-semibold tabular-nums",
                  current ? "bg-brand-600 text-white" : "bg-subtle text-muted",
                )}
              >
                v{v.version}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{v.note || <span className="text-muted">No note</span>}</p>
                <p className="text-xs text-faint">
                  {v.createdBy} · {formatDateTime(v.createdAt)}
                </p>
              </div>
              {current ? (
                <Badge tone="brand">Current</Badge>
              ) : (
                <Button
                  size="xs"
                  icon={RotateCcw}
                  loading={rollback.isPending && rollback.variables?.version === v.version}
                  onClick={() => rollback.mutate({ slug: detail.agent.slug, version: v.version })}
                >
                  Roll back
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function TestDialog({ detail, open, onClose }: { detail: AgentDetailData; open: boolean; onClose: () => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  useEffect(() => {
    if (!open) setRun(null);
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Test ${detail.definition.name}`} description="Test runs never change real systems: gated actions become dry runs and approvals are simulated.">
      {run ? (
        <div className="space-y-4">
          <LiveRunResult runId={run.id} outputs={detail.definition.outputs} highlight={detail.definition.ui.highlight} />
          <Button size="sm" variant="secondary" icon={FlaskConical} onClick={() => setRun(null)}>
            Run another test
          </Button>
        </div>
      ) : (
        <RunForm slug={detail.agent.slug} definition={detail.definition} test submitLabel="Run test" onStarted={setRun} />
      )}
    </Dialog>
  );
}

export default function AgentDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data, isLoading, error, refetch } = useAgent(slug);
  const { setStatus, remove } = useAgentMutations();
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (isLoading) return <LoadingBlock className="flex-1" />;
  if (isApiError(error, 404)) {
    return (
      <Page>
        <EmptyState
          icon={Bot}
          title="Agent not found"
          action={
            <ButtonLink to="/agents" variant="primary">
              All agents
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
  const { agent, definition } = data;
  const Icon = archetypeIcon(definition.archetype);
  const busyStatus = setStatus.isPending;

  return (
    <Page>
      <div className="mb-2 text-sm">
        <Link to="/agents" className="text-muted hover:text-fg">
          Agents
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <span className="text-fg">{definition.name}</span>
      </div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
            <Icon className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{definition.name}</h1>
              <StatusPill status={agent.status} />
              <Badge>v{agent.version}</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted">{definition.summary}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:flex-nowrap">
          {definition.ui.layout !== "none" && (
            <ButtonLink to={`/apps/${agent.slug}`} icon={ExternalLink}>
              Open app
            </ButtonLink>
          )}
          <Button icon={FlaskConical} onClick={() => setTesting(true)}>
            Run test
          </Button>
          {agent.status === "active" ? (
            <Button icon={Pause} loading={busyStatus} onClick={() => setStatus.mutate({ slug: agent.slug, status: "paused" })}>
              Pause
            </Button>
          ) : (
            <Button variant="success" icon={Rocket} loading={busyStatus} onClick={() => setStatus.mutate({ slug: agent.slug, status: "active" })}>
              Activate
            </Button>
          )}
          <Button variant="ghost" icon={Trash} onClick={() => setConfirmDelete(true)} aria-label="Delete agent" />
        </div>
      </div>

      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutTemplate },
          { id: "workflow", label: "Workflow", icon: Workflow, count: definition.workflow.length },
          { id: "definition", label: "Definition", icon: Code },
          { id: "versions", label: "Versions", icon: HistoryIcon, count: data.versions.length },
          { id: "runs", label: "Runs", icon: CirclePlay, count: data.recentRuns.length },
        ]}
      />

      {tab === "overview" && <Overview detail={data} />}
      {tab === "workflow" && (
        <Card className="p-5 sm:p-6">
          <WorkflowView steps={definition.workflow} />
          {definition.tools.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-4 text-xs text-muted">
              <Wrench className="size-3.5" /> Tools available to autonomous steps:
              {definition.tools.map((t) => (
                <Badge key={t} size="xs">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}
      {tab === "definition" && <DefinitionEditor detail={data} />}
      {tab === "versions" && <Versions detail={data} />}
      {tab === "runs" && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Recent runs"
            icon={CirclePlay}
            actions={
              <ButtonLink size="xs" variant="ghost" to={`/runs?agent=${agent.slug}`} iconRight={ArrowRight}>
                All runs
              </ButtonLink>
            }
          />
          <RunsTable
            runs={data.recentRuns}
            showAgent={false}
            highlight={(definition.ui.highlight ?? []).slice(0, 3)}
            outputs={definition.outputs}
            empty={
              <EmptyState
                compact
                className="m-4"
                icon={CirclePlay}
                title="No runs yet"
                description="Run a test to see how the agent behaves."
                action={
                  <Button size="sm" icon={FlaskConical} onClick={() => setTesting(true)}>
                    Run test
                  </Button>
                }
              />
            }
          />
        </Card>
      )}

      <TestDialog detail={data} open={testing} onClose={() => setTesting(false)} />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        size="sm"
        title={`Delete ${definition.name}?`}
        description="The agent, its versions and its run history are removed. This can't be undone."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={Trash}
              loading={remove.isPending}
              onClick={() => remove.mutate(agent.slug, { onSuccess: () => navigate("/agents") })}
            >
              Delete agent
            </Button>
          </>
        }
      />
    </Page>
  );
}
