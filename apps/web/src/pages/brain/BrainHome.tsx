import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, Brain, Cable, CircleAlert, Lightbulb, MessageCircleQuestion, Plus, Send, Sparkles, Target, TriangleAlert, UserRound } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDate } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import type { BrainOverview, BrainSource } from "../../types.ts";
import {
  DIMENSION_COLORS,
  DIMENSION_ICONS,
  KindIcon,
  ThingChip,
  brainKeys,
  brainPath,
  lowerName,
  originName,
  useBrainEvents,
  useBrainModel,
  useBrainOverview,
  useMayEditBrain,
} from "./brain.tsx";
import { EntityForm } from "./EntityForm.tsx";
import { EventItem } from "./EventItem.tsx";
import { TellTheBrain } from "./TellTheBrain.tsx";
import { toneOf } from "./values.tsx";

const QUESTIONS = [
  "Who knows the 8D complaint process?",
  "What is happening with Petrokim?",
  "Which systems have an API for sales orders?",
  "Who should I ask about SAP invoice errors?",
];

/** The question box: asks the company assistant, which looks in the brain. */
function AskBox() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const ask = (question: string) => question.trim() && navigate(`/brain/ask?q=${encodeURIComponent(question.trim())}`);
  return (
    <div className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-violet-50 p-4 dark:border-brand-400/25 dark:from-brand-400/10 dark:to-violet-400/10">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-brand-500" />
          <input
            className="input h-11 pl-10 text-[15px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask anything about the company…"
            aria-label="Ask the company brain"
          />
        </div>
        <Button type="submit" variant="primary" size="lg" icon={Send} disabled={!text.trim()}>
          Ask
        </Button>
      </form>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => ask(q)}
            className="rounded-full bg-white/70 px-2.5 py-1 text-xs text-brand-800 ring-1 ring-brand-200 hover:bg-white dark:bg-white/5 dark:text-brand-100 dark:ring-brand-400/25"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function Empty({ onFilled }: { onFilled: () => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const mayEdit = useMayEditBrain();
  const fill = useMutation({
    mutationFn: () => api.post<{ sources: BrainSource[] }>(path("/brain/sources/sync-all")),
    onSuccess: () => {
      toast.success("The brain is filled from the demo sources");
      onFilled();
    },
    onError: (error) => toast.error(error),
  });
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-6 p-6 md:grid-cols-[1.2fr_1fr] md:p-8">
        <div>
          <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-lg shadow-brand-600/20">
            <Brain className="size-6" />
          </span>
          <h2 className="mt-4 text-xl font-semibold text-fg">The company brain is empty</h2>
          <p className="mt-2 text-sm text-muted">
            It learns the company from its systems: who works where and knows what, how each process is done, which systems there are (with their APIs and
            databases), clients, projects, and what people talk about. Then anyone can ask it, the CEO sees what is happening, and the Studio builds AI
            employees that work the way the company does.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {mayEdit && (
              <Button variant="primary" icon={Sparkles} onClick={() => fill.mutate()} loading={fill.isPending}>
                Fill it from the demo sources
              </Button>
            )}
            <ButtonLink to="/brain/sources" icon={Cable}>
              Choose sources
            </ButtonLink>
          </div>
          {!mayEdit && <p className="mt-3 text-xs text-muted">A manager or IT fills it. You can already add know-how with “Tell the brain”.</p>}
        </div>
        <ul className="grid content-start gap-2 text-sm">
          {[
            ["HR system", "people, managers, roles, skills"],
            ["IT inventory", "systems, APIs, databases and tables"],
            ["Intranet", "processes step by step, policies, know-how"],
            ["CRM and ERP", "clients, deals, issues, suppliers, products"],
            ["Jira", "projects and who works on what"],
            ["Teams, Slack and email", "what is happening now"],
          ].map(([name, what]) => (
            <li key={name} className="flex items-start gap-2 rounded-lg border border-line bg-subtle/40 px-3 py-2">
              <Cable className="mt-0.5 size-4 shrink-0 text-brand-500" />
              <span>
                <span className="font-medium text-fg">{name}</span> <span className="text-muted">— {what}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function Areas({ overview }: { overview: BrainOverview }) {
  const { data: model } = useBrainModel();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {model?.dimensions.map((dimension) => {
        const Icon = DIMENSION_ICONS[dimension.key] ?? Brain;
        const colors = DIMENSION_COLORS[dimension.key]!;
        const kinds = model.kinds.filter((k) => k.dimension === dimension.key);
        const total = kinds.reduce((sum, k) => sum + (overview.counts[k.key] ?? 0), 0);
        const first = kinds.find((k) => overview.counts[k.key]) ?? kinds[0];
        return (
          <Link
            key={dimension.key}
            to={`/brain/k/${first?.key ?? ""}`}
            className="group rounded-xl border border-line bg-surface p-3.5 shadow-xs hover:border-line-strong hover:shadow-sm"
            title={dimension.description}
          >
            <div className="flex items-center justify-between">
              <span className={clsx("flex size-8 items-center justify-center rounded-lg", colors.icon)}>
                <Icon className="size-4" />
              </span>
              <span className="text-xl font-semibold text-fg tabular-nums">{total}</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-fg">{dimension.name}</p>
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
              {kinds
                .filter((k) => overview.counts[k.key])
                .map((k) => `${overview.counts[k.key]} ${lowerName(overview.counts[k.key] === 1 ? k.name : k.plural)}`)
                .join(" · ") || "Nothing yet"}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

const HEALTH_BAR: Record<string, string> = { "On track": "bg-emerald-500", "At risk": "bg-amber-500", "Off track": "bg-red-500" };

function Projects({ overview }: { overview: BrainOverview }) {
  const { data: model } = useBrainModel();
  return (
    <Card>
      <CardHeader
        title="Projects"
        subtitle="Where each one stands"
        icon={Target}
        actions={
          <ButtonLink to="/brain/k/project" size="xs" variant="ghost" iconRight={ArrowRight}>
            All
          </ButtonLink>
        }
      />
      <ul className="divide-y divide-line">
        {overview.projects.length === 0 && <li className="px-5 py-4 text-sm text-muted">No projects yet.</li>}
        {overview.projects.map((project) => (
          <li key={project.id} className="px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={brainPath(project.id)} className="min-w-0 flex-1 truncate text-sm font-semibold text-fg hover:underline">
                {project.name}
              </Link>
              {project.health && (
                <Badge tone={toneOf(project.health)} dot>
                  {project.health}
                </Badge>
              )}
              {project.status && project.status !== "Active" && <Badge tone={toneOf(project.status)}>{project.status}</Badge>}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                <div
                  className={clsx("h-full rounded-full", HEALTH_BAR[project.health ?? ""] ?? "bg-brand-500")}
                  style={{ width: `${project.progress ?? 0}%` }}
                />
              </div>
              <span className="w-9 text-right text-xs text-muted tabular-nums">{project.progress ?? 0}%</span>
            </div>
            {project.now && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{project.now}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
              {project.client && <ThingChip thing={{ ...project.client, kind: "client" }} model={model} className="!py-0 !text-[11px]" />}
              {project.lead && <ThingChip thing={{ ...project.lead, kind: "person" }} model={model} className="!py-0 !text-[11px]" />}
              <span>{project.openTasks} open tasks</span>
              {project.end && <span>· due {formatDate(project.end)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Attention({ overview }: { overview: BrainOverview }) {
  const { data: model } = useBrainModel();
  return (
    <Card>
      <CardHeader
        title="Needs attention"
        subtitle="Projects at risk, urgent customer issues, late tasks, deals about to close, goals slipping"
        icon={TriangleAlert}
      />
      <ul className="divide-y divide-line">
        {overview.attention.length === 0 && <li className="px-5 py-4 text-sm text-muted">Nothing needs attention now.</li>}
        {overview.attention.map((item, i) => (
          <li key={`${item.entity.id}-${i}`} className="flex gap-3 px-5 py-3">
            <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", item.severity === "high" ? "bg-red-500" : "bg-amber-500")} />
            <div className="min-w-0 flex-1">
              <Link to={brainPath(item.entity.id)} className="text-sm font-medium text-fg hover:underline">
                {item.title}
              </Link>
              {item.detail && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{item.detail}</p>}
            </div>
            <KindIcon kind={item.entity.kind} model={model} size="sm" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Goals({ overview }: { overview: BrainOverview }) {
  if (!overview.goals.length) return null;
  return (
    <Card>
      <CardHeader title="Goals" icon={Target} />
      <ul className="divide-y divide-line">
        {overview.goals.map((goal) => {
          const status = goal.brief.find(([label]) => label === "Status")?.[1];
          const target = goal.brief.find(([label]) => label === "Target")?.[1];
          return (
            <li key={goal.id} className="px-5 py-2.5">
              <div className="flex items-start gap-2">
                <Link to={brainPath(goal.id)} className="min-w-0 flex-1 text-[13px] font-medium text-fg hover:underline">
                  {goal.name}
                </Link>
                {status && (
                  <Badge tone={toneOf(status)} size="xs">
                    {status}
                  </Badge>
                )}
              </div>
              {target && <p className="text-[11px] text-muted">Target {target}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const GAP_LABELS: Record<string, string> = {
  "on-leave-expert": "Know-how away",
  "single-expert": "Only one person",
  "no-owner": "No one responsible",
  "no-steps": "Not written down",
};

function Gaps({ overview }: { overview: BrainOverview }) {
  const [all, setAll] = useState(false);
  if (!overview.gaps.length) return null;
  const shown = all ? overview.gaps : overview.gaps.slice(0, 6);
  return (
    <Card>
      <CardHeader title="Know-how at risk" subtitle="What only one person knows, and what no one owns" icon={Lightbulb} />
      <ul className="divide-y divide-line">
        {shown.map((gap) => (
          <li key={`${gap.type}-${gap.entity.id}`} className="px-5 py-2.5">
            <div className="flex items-start gap-2">
              {gap.type === "on-leave-expert" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
              ) : (
                <UserRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
              )}
              <div className="min-w-0">
                <Link to={brainPath(gap.entity.id)} className="text-[13px] font-medium text-fg hover:underline">
                  {gap.title}
                </Link>
                <p className="text-[11px] text-muted">
                  {GAP_LABELS[gap.type] ?? gap.type} · {gap.detail}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {overview.gaps.length > 6 && (
        <div className="border-t border-line px-5 py-2">
          <button type="button" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${overview.gaps.length}`}
          </button>
        </div>
      )}
    </Card>
  );
}

function Busy({ overview }: { overview: BrainOverview }) {
  if (!overview.busy.length) return null;
  return (
    <Card>
      <CardHeader title="Who works on what" subtitle="Open tasks per person" icon={UserRound} />
      <ul className="divide-y divide-line">
        {overview.busy.map(({ person, open, tasks }) => (
          <li key={person.id} className="px-5 py-2.5">
            <div className="flex items-center gap-2">
              <Link to={brainPath(person.id)} className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg hover:underline">
                {person.name}
              </Link>
              <span className="text-xs text-muted tabular-nums">{open} open</span>
            </div>
            <p className="truncate text-[11px] text-muted">{tasks.join(" · ")}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Happening({ overview }: { overview: BrainOverview }) {
  const { data: model } = useBrainModel();
  const [origin, setOrigin] = useState<string | null>(null);
  const filtered = useBrainEvents({ origin: origin ?? undefined, limit: 15 });
  const sources = Object.entries(overview.events.bySource).filter(([, n]) => n > 0);
  const events = origin ? (filtered.data ?? []) : overview.recent;
  return (
    <Card>
      <CardHeader
        title="What's happening"
        subtitle={`${overview.events.lastWeek} things this week, from ${sources.length} source${sources.length === 1 ? "" : "s"}`}
        icon={Sparkles}
      />
      <CardBody>
        {sources.length > 1 && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {[null, ...sources.map(([key]) => key)].map((key) => (
              <button
                key={key ?? "all"}
                type="button"
                onClick={() => setOrigin(key)}
                className={clsx(
                  "rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                  origin === key ? "bg-fg text-canvas ring-fg" : "text-muted ring-line-strong hover:bg-subtle",
                )}
              >
                {key ? `${originName(key)} ${overview.events.bySource[key]}` : "All"}
              </button>
            ))}
          </div>
        )}
        {events.length ? (
          <ul className="divide-y divide-line/70">
            {events.map((event) => (
              <EventItem key={event.id} event={event} model={model} />
            ))}
          </ul>
        ) : origin && filtered.isLoading ? (
          <Skeleton className="h-32" />
        ) : (
          <p className="text-sm text-muted">Nothing yet: connect Teams, Slack or email in Sources.</p>
        )}
      </CardBody>
    </Card>
  );
}

/** The brain's front page, and the CEO's view of the company. */
export default function BrainHome() {
  const { company } = useCompany();
  const queryClient = useQueryClient();
  const overview = useBrainOverview();
  const mayEdit = useMayEditBrain();
  const [telling, setTelling] = useState(false);
  const [adding, setAdding] = useState(false);
  const data = overview.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });

  return (
    <Page wide>
      <PageHeader
        icon={Brain}
        title={data?.company?.name ? `${data.company.name}` : "Company brain"}
        eyebrow="Company brain"
        description={
          data?.company?.summary || "Everything the company knows about itself: its people, processes, systems, clients, projects, and what is happening."
        }
        actions={
          <>
            <Button icon={Lightbulb} onClick={() => setTelling(true)}>
              Tell the brain
            </Button>
            {mayEdit && (
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                Add
              </Button>
            )}
          </>
        }
      />
      {overview.error ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !data ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-64" />
        </div>
      ) : data.total === 0 ? (
        <Empty onFilled={refresh} />
      ) : (
        <div className="space-y-6">
          <AskBox />
          <Areas overview={data} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              <Attention overview={data} />
              <Projects overview={data} />
              <Happening overview={data} />
            </div>
            <div className="min-w-0 space-y-6">
              <Goals overview={data} />
              <Gaps overview={data} />
              <Busy overview={data} />
            </div>
          </div>
        </div>
      )}
      <TellTheBrain open={telling} onClose={() => setTelling(false)} />
      {adding && <EntityForm open={adding} onClose={() => setAdding(false)} />}
    </Page>
  );
}
