import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BookOpen,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  CircleCheck,
  CirclePlay,
  Code,
  ExternalLink,
  FlaskConical,
  Gauge,
  GitCommitVertical as HistoryIcon,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutTemplate,
  ListChecks,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  Pause,
  PencilLine,
  Play,
  Plug,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Trash,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, isApiError, qs } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { ChatPanel } from "../../components/Chat.tsx";
import { Dialog, Drawer } from "../../components/Dialog.tsx";
import { EmploymentPanel, PROBATION } from "../../components/Employment.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { GiveWorkDialog } from "../../components/GiveWork.tsx";
import { Page } from "../../components/Layout.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { LiveRunResult, RunForm } from "../../components/RunViews.tsx";
import { Callout, ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { StackedBars } from "../../components/Charts.tsx";
import { TaskTable } from "../../components/TaskList.tsx";
import { WorkflowView } from "../../components/WorkflowView.tsx";
import { WorkItemCard } from "../../components/WorkItemCard.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDateTime, formatMoney, percent, plural, timeAgo, workingHoursText } from "../../lib/format.ts";
import { archetypeIcon, categoryIcon } from "../../lib/icons.tsx";
import { approvalRuleLabel, categoryLabel, describeTrigger, PERSONAL_DATA_LABELS } from "../../lib/labels.ts";
import { keys, useAgent, useAgentPerformance, useCollections, useConnectors, useDepartments, useTasks, useWork } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import type { AgentDefinition, AgentDetail, Conversation, RunRow, TaskRow } from "../../types.ts";
import { useAgentMutations } from "./actions.ts";
import { ChangeRequest, CoachingTab, useCoaching } from "./Coaching.tsx";

type Tab = "overview" | "work" | "duties" | "access" | "knowledge" | "rules" | "coaching" | "versions";

/** Rules from before probation levels ("every email", "every change"): the level decides those now. */
const LEVEL_RULES = ["mail.send", "connector:write", "connector:*"];

const ABILITIES: Record<string, string> = {
  "knowledge.search": "company knowledge",
  "documents.read": "reading documents and scans",
  "excel.read": "reading Excel files",
  "excel.write": "writing Excel files",
  "mail.draft": "drafting email",
  "mail.send": "sending email",
  "web.search": "searching the web",
};

function startOfWeek(now = new Date()): Date {
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - day);
  return monday;
}

/** What it may use, in words: "Applicant tracking (read) · email (send, after approval) · HR policies". */
function canUse(detail: AgentDetail, collections: Map<string, string>): string[] {
  const { definition } = detail;
  const level = detail.employment?.probation ?? "supervised";
  const afterApproval = level === "trusted" ? "" : ", after approval";
  const items: string[] = [];
  for (const c of definition.connectors) items.push(categoryLabel(c.category));
  for (const tool of definition.tools) {
    if (tool === "mail.send") items.push(`email (send${afterApproval})`);
    else if (tool !== "knowledge.search") items.push(ABILITIES[tool] ?? tool);
  }
  for (const key of definition.knowledge.collections) items.push(collections.get(key) ?? key);
  return items;
}

function Section({
  title,
  icon: Icon,
  children,
  className,
  actions,
  subtitle,
}: {
  title: string;
  icon: typeof Bot;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} icon={Icon} actions={actions} subtitle={subtitle} />
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

/** The last four weeks against the targets, and tasks finished each week. */
function PerformanceCard({ detail }: { detail: AgentDetail }) {
  const { data } = useAgentPerformance(detail.agent.slug);
  if (!data) return null;
  const m = data.measures;
  const rows: [string, string, boolean | null][] = [
    ["Finished", `${m.finished}${m.failed ? ` · ${m.failed} stopped with a problem` : ""}`, null],
    [
      "Alone",
      m.finished ? `${percent(m.aloneShare)} of them` : "—",
      data.probation === "trusted" && m.aloneShare !== null ? m.aloneShare >= data.targets.aloneShare : null,
    ],
    [
      "People took",
      m.handled ? `${workingHoursText(m.medianHandlingHours)} (median of ${m.handled})` : "—",
      m.medianHandlingHours === null ? null : m.medianHandlingHours <= data.targets.medianHandlingHours,
    ],
    [
      "Corrected",
      m.finished ? `${m.corrected} (${percent(m.correctedShare)})` : "—",
      m.correctedShare === null ? null : m.correctedShare < data.targets.correctedShare,
    ],
    ["Per task", m.costPerTaskUsd === null ? "—" : formatMoney(m.costPerTaskUsd, 3), null],
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Last 4 weeks"
        icon={Gauge}
        subtitle={data.probation === "trusted" ? "Against the targets." : "Finishing alone counts once it is Trusted."}
      />
      <dl className="space-y-1.5 px-5 pt-3 text-sm">
        {rows.map(([label, value, met]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{label}</dt>
            <dd
              className={clsx(
                "text-right tabular-nums",
                met === true && "text-emerald-700 dark:text-emerald-300",
                met === false && "text-amber-700 dark:text-amber-300",
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="px-5 pt-4 pb-4">
        <StackedBars
          height={64}
          labels="ends"
          bars={data.weeks.map((w) => ({
            label: new Date(`${w.start}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
            parts: [
              { value: w.measures.finishedAlone, tone: "green" as const, label: "alone" },
              { value: w.measures.finished - w.measures.finishedAlone, tone: "brand" as const, label: "with a person" },
            ],
          }))}
        />
      </div>
    </Card>
  );
}

function Overview({ detail, tasks, onTab }: { detail: AgentDetail; tasks: TaskRow[]; onTab: (tab: Tab) => void }) {
  const collections = useCollections();
  const names = new Map((collections.data ?? []).map((c) => [c.key, c.name]));
  const employment = detail.employment;
  const monday = startOfWeek();
  const week = tasks.filter((t) => new Date(t.createdAt) >= monday);
  const waiting = tasks.filter((t) => t.status === "needs_person").length;
  const uses = canUse(detail, names);
  const [showInstructions, setShowInstructions] = useState(false);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-6">
        <Card>
          <dl className="divide-y divide-line px-5 py-2">
            <Line label="Duties">
              {employment?.duties.length ? (
                employment.duties.map((d) => d.text).join("; ")
              ) : (
                <span className="text-muted">None: it works when people give it work.</span>
              )}
            </Line>
            <Line label="Can use">{uses.length ? uses.join(" · ") : <span className="text-muted">Nothing beyond its instructions.</span>}</Line>
            <Line label="This week">
              {plural(week.length, "task")} · {week.filter((t) => t.status === "done").length} done
              {waiting ? (
                <>
                  {" · "}
                  <button type="button" className="font-medium text-amber-700 hover:underline dark:text-amber-300" onClick={() => onTab("work")}>
                    {waiting} waiting for a person
                  </button>
                </>
              ) : null}
              {employment ? ` · ${formatMoney(employment.costThisMonthUsd)} this month` : ""}
            </Line>
            <Line label="Level">
              {employment ? (
                <>
                  <span className="font-medium">{PROBATION[employment.probation].label}</span>
                  <span className="text-muted">
                    {" "}
                    · alone: {PROBATION[employment.probation].alone.toLowerCase()}; asks a person: {PROBATION[employment.probation].person.toLowerCase()}
                  </span>
                </>
              ) : (
                "—"
              )}
            </Line>
          </dl>
        </Card>
        <Section
          title="Its job"
          icon={BriefcaseBusiness}
          actions={
            <Button size="xs" variant="ghost" onClick={() => setShowInstructions(!showInstructions)}>
              {showInstructions ? "Hide instructions" : "Show instructions"}
            </Button>
          }
        >
          <p className="text-sm text-fg">{detail.definition.summary}</p>
          {detail.definition.kpis.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {detail.definition.kpis.map((k) => (
                <Badge key={k.id} tone="green">
                  {k.name}
                  {k.target ? `: ${k.target}` : ""}
                </Badge>
              ))}
            </div>
          )}
          {showInstructions && (
            <div className="mt-4 max-h-96 overflow-y-auto border-t border-line pt-4">
              <Markdown compact>{detail.definition.instructions || "_No instructions._"}</Markdown>
            </div>
          )}
        </Section>
      </div>
      <div className="space-y-6">
        <PerformanceCard detail={detail} />
        <Card className="overflow-hidden">
          <CardHeader
            title="Latest tasks"
            icon={ListChecks}
            actions={
              <Button size="xs" variant="ghost" onClick={() => onTab("work")}>
                All
              </Button>
            }
          />
          {tasks.length ? (
            <ul className="divide-y divide-line">
              {tasks.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <Link to={`/work/${t.ref}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-subtle/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg">{t.title}</p>
                      <p className="text-xs text-muted">
                        <span className="font-mono text-[11px]">{t.ref}</span> · {timeAgo(t.updatedAt)}
                      </p>
                    </div>
                    <StatusPill status={t.status} size="xs" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">No tasks yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function WorkTab({ detail, tasks, loading }: { detail: AgentDetail; tasks: TaskRow[]; loading: boolean }) {
  const work = useWork("all");
  const open = (work.data ?? []).filter((w) => w.agent?.id === detail.agent.id);
  return (
    <div className="space-y-6">
      {open.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-fg">Needs a person ({open.length})</h2>
          <div className="space-y-3">
            {open.map((entry) => (
              <WorkItemCard key={`${entry.type}-${entry.id}`} entry={entry} showAgent={false} />
            ))}
          </div>
        </section>
      )}
      <Card className="overflow-hidden">
        <CardHeader title="Tasks" icon={ListChecks} subtitle="Every piece of work it did or is doing, newest first." />
        {loading ? (
          <LoadingBlock />
        ) : (
          <TaskTable
            tasks={tasks}
            showAgent={false}
            empty={
              <EmptyState
                compact
                className="m-4"
                icon={ListChecks}
                title="No tasks yet"
                description="Give it work, or let its duties start tasks on their own."
              />
            }
          />
        )}
      </Card>
    </div>
  );
}

function DutiesTab({ detail }: { detail: AgentDetail }) {
  const duties = detail.employment?.duties ?? [];
  const active = detail.agent.status === "active";
  const other = detail.definition.triggers.filter(
    (t) => t.type === "manual" || t.type === "chat" || t.type === "form" || t.type === "webhook" || t.type === "paperclip",
  );
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Section title="Duties: what it does on its own" icon={CalendarClock} className="lg:col-span-2">
        {duties.length ? (
          <ul className="space-y-2.5">
            {duties.map((d, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                {d.kind === "mailbox" ? (
                  <Inbox className="mt-0.5 size-4 shrink-0 text-muted" />
                ) : (
                  <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" />
                )}
                <span className="text-fg">{d.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">None: it works when people give it work.</p>
        )}
        {!active && duties.length > 0 && (
          <Callout tone="warning" className="mt-4">
            It is {detail.agent.status}: its duties start again when it is put back to work.
          </Callout>
        )}
      </Section>
      {detail.recurring && detail.recurring.length > 0 && (
        <Section title="Asked for regularly" icon={CalendarClock} className="lg:col-span-2">
          <ul className="space-y-2.5">
            {detail.recurring.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 text-sm">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="text-fg">
                  {r.when[0]!.toUpperCase() + r.when.slice(1)}: {r.text} <span className="text-muted">· for {r.by}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="hint mt-3">People ask for these in “What do you need?” on Home; each time it is a task for them.</p>
        </Section>
      )}
      <Section title="Other ways work reaches it" icon={CirclePlay} className="lg:col-span-2">
        <ul className="space-y-2 text-sm text-fg">
          <li className="flex items-center gap-2.5">
            <Send className="size-4 text-muted" /> People give it work in the app (Give work)
          </li>
          {other.map((t, i) => (
            <li key={i} className="flex items-center gap-2.5">
              <CirclePlay className="size-4 text-muted" />
              {describeTrigger(t)}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function AccessTab({ detail }: { detail: AgentDetail }) {
  const connectors = useConnectors();
  const { definition } = detail;
  const alwaysAsks = definition.guardrails.approvalRequiredFor.filter((r) => !LEVEL_RULES.includes(r));
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Section title="Connections" icon={Plug} subtitle="Systems IT connected that it may use.">
        {definition.connectors.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="space-y-3">
            {definition.connectors.map((c) => {
              const Icon = categoryIcon(c.category);
              const instance = connectors.data?.find((i) => i.id === c.instanceId) ?? connectors.data?.find((i) => i.category === c.category && !i.sandbox);
              return (
                <li key={c.ref} className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-fg">{instance?.name ?? categoryLabel(c.category)}</p>
                    {c.purpose && <p className="text-xs text-muted">{c.purpose}</p>}
                    <p className="mt-0.5 text-xs">
                      {instance ? (
                        <span className="text-emerald-700 dark:text-emerald-300">Connected</span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">
                          Practising on demo data until IT connects the real system.{" "}
                          <Link to="/settings/connections" className="underline">
                            Connections
                          </Link>
                        </span>
                      )}
                    </p>
                    {c.operations?.length ? <p className="mt-0.5 text-xs text-faint">Actions: {c.operations.join(", ")}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Abilities" icon={KeyRound}>
        {definition.tools.length ? (
          <ul className="space-y-1.5 text-sm text-fg">
            {definition.tools.map((t) => (
              <li key={t} className="flex items-center gap-2">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                {(ABILITIES[t] ?? t).replace(/^./, (c) => c.toUpperCase())}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Only the steps of its job.</p>
        )}
      </Section>
      <Section title="Always asks a person before" icon={ShieldCheck} subtitle="At every level, whatever its limits.">
        {alwaysAsks.length ? (
          <div className="flex flex-wrap gap-1.5">
            {alwaysAsks.map((r) => (
              <Badge key={r} tone="amber">
                {approvalRuleLabel(r)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Nothing beyond its probation level and the actions IT marked.</p>
        )}
      </Section>
      <Section title="Personal data" icon={Lock}>
        <p className="text-sm text-fg">
          {PERSONAL_DATA_LABELS[definition.guardrails.personalData] ?? definition.guardrails.personalData}
          {definition.guardrails.retentionDays ? <span className="text-muted"> · kept {definition.guardrails.retentionDays} days</span> : null}
        </p>
        {definition.guardrails.notes?.length ? (
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {definition.guardrails.notes.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function KnowledgeTab({ detail }: { detail: AgentDetail }) {
  const collections = useCollections();
  const keysUsed = detail.definition.knowledge.collections;
  const searches = detail.definition.tools.includes("knowledge.search");
  return (
    <Section title="Knowledge it answers from" icon={BookOpen} subtitle="Documents and policies it reads before it answers or decides.">
      {keysUsed.length === 0 ? (
        <p className="text-sm text-muted">
          {searches ? "All of the company's knowledge it is allowed to see." : "None: it works from its instructions and the work it is given."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {keysUsed.map((key) => {
            const c = collections.data?.find((x) => x.key === key);
            return (
              <li key={key} className="flex items-center gap-3 py-2.5">
                <BookOpen className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{c?.name ?? key}</p>
                  {c?.description && <p className="truncate text-xs text-muted">{c.description}</p>}
                </div>
                <span className="text-xs text-muted">{c ? plural(c.documentCount, "document") : "Not created yet"}</span>
                <ButtonLink to={`/settings/knowledge${qs({ collection: key })}`} size="xs" variant="ghost">
                  Open
                </ButtonLink>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function RulesTab({ detail }: { detail: AgentDetail }) {
  return (
    <div className="space-y-6">
      <EmploymentPanel detail={detail} />
    </div>
  );
}

function JobEditor({ detail }: { detail: AgentDetail }) {
  const { save } = useAgentMutations();
  const original = useMemo(() => JSON.stringify(detail.definition, null, 2), [detail.definition]);
  const [text, setText] = useState(original);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(original), [original]);
  const dirty = text !== original;
  const parse = (): AgentDefinition | null => {
    try {
      const parsed = JSON.parse(text) as Partial<AgentDefinition>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The job description must be a JSON object");
      const missing = (["slug", "name", "summary", "archetype", "instructions"] as const).filter((k) => !parsed[k]);
      if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);
      setProblem(null);
      return parsed as AgentDefinition;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="input min-h-[24rem] font-mono text-xs leading-relaxed"
        aria-label="Job description (JSON)"
      />
      {problem && <Callout tone="danger">{problem}</Callout>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="What changed and why" optional className="flex-1">
          {(id) => <input id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setText(original)} disabled={!dirty}>
            Reset
          </Button>
          <Button
            variant="primary"
            icon={Save}
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => {
              const definition = parse();
              if (definition) save.mutate({ slug: detail.agent.slug, definition, note: note.trim() || undefined }, { onSuccess: () => setNote("") });
            }}
          >
            Save as a new version
          </Button>
        </div>
      </div>
    </div>
  );
}

function VersionsTab({ detail, editing, setEditing }: { detail: AgentDetail; editing: boolean; setEditing: (open: boolean) => void }) {
  const { rollback } = useAgentMutations();
  const viewer = useViewer();
  const versions = [...detail.versions].sort((a, b) => b.version - a.version);
  const history = (detail.activity ?? []).filter((a) => !a.action.startsWith("agent.coaching"));
  return (
    <div className="space-y-6">
      <Section
        title="Change its job"
        icon={PencilLine}
        subtitle="Each change becomes a new version; you can go back to any earlier one."
        actions={
          detail.agent.builderSessionId ? (
            <ButtonLink size="xs" variant="soft" to={`/hire/studio/${detail.agent.builderSessionId}`} icon={MessageSquare}>
              Its Studio interview
            </ButtonLink>
          ) : undefined
        }
      >
        {detail.canManage && <ChangeRequest slug={detail.agent.slug} name={detail.definition.name} />}
        {editing ? (
          <div className="mt-4">
            <JobEditor detail={detail} />
          </div>
        ) : (
          viewer?.isAdmin &&
          detail.canManage && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="flex-1 text-xs text-muted">For IT: the full job description (steps, rules and connections) as JSON.</p>
              <Button size="sm" variant="ghost" icon={Code} onClick={() => setEditing(true)}>
                Edit the job description
              </Button>
            </div>
          )
        )}
      </Section>
      <Section title="How it works" icon={Workflow} subtitle="The steps it follows for each task.">
        <WorkflowView steps={detail.definition.workflow} />
      </Section>
      <Card className="overflow-hidden">
        <CardHeader title="Versions" icon={HistoryIcon} />
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
                  detail.canManage && (
                    <Button
                      size="xs"
                      icon={RotateCcw}
                      loading={rollback.isPending && rollback.variables?.version === v.version}
                      onClick={() => rollback.mutate({ slug: detail.agent.slug, version: v.version })}
                    >
                      Go back to this
                    </Button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      {history.length > 0 && (
        <Section title="Changes" icon={HistoryIcon}>
          <ul className="space-y-2">
            {history.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="text-fg">{a.summary}</span>
                <span className="text-xs text-faint">
                  {a.actor.replace(/\s*<.*>$/, "")} · {timeAgo(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function TalkDrawer({ detail, open, onClose }: { detail: AgentDetail; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const slug = detail.agent.slug;
  const conversations = useQuery({
    queryKey: [...keys.chat(company), "conversations", { agent: slug }],
    queryFn: () => api.get<Conversation[]>(path(`/chat/conversations${qs({ agent: slug })}`)),
    enabled: open,
  });
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const conversationId = selected === undefined ? (conversations.data?.[0]?.id ?? null) : selected;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={`Talk to ${detail.definition.name}`}
      description="Ask about its work, or ask it to do something. Only you see this conversation."
    >
      <div className="-mx-5 -my-4 flex h-[calc(100dvh-5.5rem)] flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <select
            className="input h-8 max-w-xs py-1 text-[13px]"
            value={conversationId ?? ""}
            onChange={(e) => setSelected(e.target.value || null)}
            aria-label="Conversation"
          >
            {!conversationId && <option value="">New conversation</option>}
            {(conversations.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {timeAgo(c.updatedAt)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" icon={MessageSquarePlus} onClick={() => setSelected(null)} className="ml-auto">
            New
          </Button>
        </div>
        <ChatPanel
          key={conversationId ?? "new"}
          className="min-h-0 flex-1"
          conversationId={conversationId}
          agent={slug}
          assistantName={detail.definition.name}
          emptyTitle={`Talk to ${detail.definition.name}`}
          emptyDescription={detail.definition.summary}
          onConversationCreated={(id) => {
            setSelected(id);
            void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), "conversations"] });
          }}
        />
      </div>
    </Drawer>
  );
}

function TryDialog({ detail, open, onClose }: { detail: AgentDetail; open: boolean; onClose: () => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  useEffect(() => {
    if (!open) setRun(null);
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Try ${detail.definition.name}`}
      description="A practice run: it changes nothing in real systems and sends no email."
    >
      {run ? (
        <div className="space-y-4">
          <LiveRunResult runId={run.id} outputs={detail.definition.outputs} highlight={detail.definition.ui.highlight} />
          <Button size="sm" icon={FlaskConical} onClick={() => setRun(null)}>
            Try again
          </Button>
        </div>
      ) : (
        <RunForm slug={detail.agent.slug} definition={detail.definition} test submitLabel="Try it" onStarted={setRun} />
      )}
    </Dialog>
  );
}

export default function AiEmployee() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const { data, isLoading, error, refetch } = useAgent(slug);
  useDocumentTitle(data?.definition.name ?? "AI employee");
  const tasks = useTasks({ agent: slug, limit: 200 });
  const coaching = useCoaching(slug ?? "");
  const departments = useDepartments();
  const { setStatus, remove } = useAgentMutations();
  const [talking, setTalking] = useState(false);
  const [giving, setGiving] = useState(false);
  const [trying, setTrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (isLoading) return <LoadingBlock className="flex-1" />;
  if (isApiError(error, 404)) {
    return (
      <Page>
        <EmptyState
          icon={Bot}
          title="AI employee not found"
          description="It may have been let go, or it works in a department you are not part of."
          action={
            <ButtonLink to="/company" variant="primary">
              Company
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
  const { agent, definition, employment } = data;
  const Icon = archetypeIcon(definition.archetype);
  const department = departments.data?.find((d) => d.id === agent.departmentId);
  const taskRows = tasks.data ?? [];
  const needsPerson = taskRows.filter((t) => t.status === "needs_person").length;
  const corrections = (coaching.data?.notes ?? []).filter((n) => n.status === "open").length;
  const deciding = (coaching.data?.proposals ?? []).some((p) => p.status === "ready");
  const working = agent.status === "active";
  const byline = [
    definition.title,
    department?.name,
    employment?.manager ? `manager: ${employment.manager.name}` : null,
    employment ? PROBATION[employment.probation].label : null,
  ].filter(Boolean);

  return (
    <Page>
      <div className="mb-2 text-sm">
        <Link to="/company" className="text-muted hover:text-fg">
          Company
        </Link>
        {department && (
          <>
            <span className="mx-1.5 text-faint">/</span>
            <Link to={`/company#department-${department.key}`} className="text-muted hover:text-fg">
              {department.name}
            </Link>
          </>
        )}
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
              <StatusPill status={agent.status} label={working ? "Working" : undefined} />
              {employment?.stoppedByBudget && <Badge tone="red">Budget reached</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">{byline.join(" · ")}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button icon={MessageSquare} onClick={() => setTalking(true)}>
            Talk to it
          </Button>
          <Button variant="primary" icon={Send} onClick={() => setGiving(true)} disabled={!working && agent.status !== "testing"}>
            Give work
          </Button>
          {data.canManage && (
            <>
              <Button
                icon={PencilLine}
                onClick={() => {
                  setEditing(true);
                  setTab("versions");
                }}
              >
                Change its job
              </Button>
              {working ? (
                <Button icon={Pause} loading={setStatus.isPending} onClick={() => setStatus.mutate({ slug: agent.slug, status: "paused" })}>
                  Pause
                </Button>
              ) : (
                <Button variant="success" icon={Play} loading={setStatus.isPending} onClick={() => setStatus.mutate({ slug: agent.slug, status: "active" })}>
                  Put to work
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutTemplate },
          { id: "work", label: "Work", icon: ListChecks, count: needsPerson || undefined, alert: needsPerson > 0 },
          { id: "duties", label: "Duties", icon: CalendarClock },
          { id: "access", label: "Access", icon: KeyRound },
          { id: "knowledge", label: "Knowledge", icon: BookOpen },
          { id: "rules", label: "Probation and rules", icon: ShieldCheck },
          { id: "coaching", label: "Coaching", icon: GraduationCap, count: corrections || undefined, alert: deciding && data.canManage },
          { id: "versions", label: "Versions", icon: HistoryIcon },
        ]}
      />

      {tab === "overview" && <Overview detail={data} tasks={taskRows} onTab={setTab} />}
      {tab === "work" && <WorkTab detail={data} tasks={taskRows} loading={tasks.isLoading} />}
      {tab === "duties" && <DutiesTab detail={data} />}
      {tab === "access" && <AccessTab detail={data} />}
      {tab === "knowledge" && <KnowledgeTab detail={data} />}
      {tab === "rules" && <RulesTab detail={data} />}
      {tab === "coaching" && <CoachingTab detail={data} />}
      {tab === "versions" && <VersionsTab detail={data} editing={editing} setEditing={setEditing} />}

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {data.canManage && (
          <Button size="sm" variant="ghost" icon={FlaskConical} onClick={() => setTrying(true)}>
            Try it without changing anything
          </Button>
        )}
        {definition.ui.layout !== "none" && (
          <ButtonLink size="sm" variant="ghost" to={`/ai/${agent.slug}/app`} icon={ExternalLink}>
            Open its page
          </ButtonLink>
        )}
        {data.canManage && (
          <Button
            size="sm"
            variant="ghost"
            icon={Trash}
            className="ml-auto text-red-600 hover:text-red-700 dark:text-red-400"
            onClick={() => setConfirmDelete(true)}
          >
            Let go
          </Button>
        )}
      </div>

      <TalkDrawer detail={data} open={talking} onClose={() => setTalking(false)} />
      <GiveWorkDialog open={giving} onClose={() => setGiving(false)} agent={agent.slug} />
      <TryDialog detail={data} open={trying} onClose={() => setTrying(false)} />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        size="sm"
        title={`Let ${definition.name} go?`}
        description="It stops working, and its versions and history are removed. This can't be undone; pausing keeps everything."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={Trash}
              loading={remove.isPending}
              onClick={() => remove.mutate(agent.slug, { onSuccess: () => navigate("/company") })}
            >
              Let go
            </Button>
          </>
        }
      />
    </Page>
  );
}
