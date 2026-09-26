import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowRight,
  BookOpen,
  Calculator,
  CalendarClock,
  CircleHelp,
  LayoutGrid,
  MessageSquare,
  Save,
  Send,
  Sparkles,
  Table2,
  UserPlus,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type {
  CalculationProposal,
  CalculationSchedule,
  CalculationView,
  ChatMessage,
  Conversation,
  CoachingProposal,
  NeedKind,
  NeedReading,
  RecurringWork,
  RepeatSchedule,
  SessionView,
  StudioThreadView,
} from "../types.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { NewAppDialog } from "./apps/NewAppDialog.tsx";
import { SCHEDULES } from "./calculations/NewCalculationDialog.tsx";
import { ResultView } from "./calculations/ResultView.tsx";
import { FillFromEmail } from "./FillFromEmail.tsx";
import { Chip, Field } from "./Form.tsx";
import { useGiveWork } from "./GiveWork.tsx";
import { Markdown } from "./Markdown.tsx";
import { Callout, ErrorState, Skeleton } from "./Spinner.tsx";
import { NewTableDialog, useTableDepartments } from "./tables/NewTableDialog.tsx";

/** Each reading: what it is called when offered instead, and its icon. */
export const NEED: Record<NeedKind, { label: string; icon: LucideIcon }> = {
  task: { label: "An AI employee does it now", icon: Send },
  recurring: { label: "An AI employee does it regularly", icon: CalendarClock },
  answer: { label: "An answer from the company's knowledge", icon: BookOpen },
  calculation: { label: "Work it out on our tables", icon: Calculator },
  table: { label: "A table to keep track of it", icon: Table2 },
  app: { label: "An app, with its table", icon: LayoutGrid },
  "ai-employee": { label: "A new AI employee for it", icon: UserPlus },
  change: { label: "A change to something we have", icon: Wand2 },
  unclear: { label: "Something else", icon: CircleHelp },
};

const EXAMPLES = [
  "Every Monday at 9, send me the open complaints",
  "How many days of annual leave do I get?",
  "A register of supplier complaints: supplier, order number, problem, status, owner",
  "How many complaints came in last month?",
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * "What do you need?": the first place to go. Say anything; it says what it understood (work for an
 * AI employee now or regularly, an answer, a calculation, a table, an app, an AI employee, a change)
 * and does it when you say go. Another reading is one click away.
 */
export function NeedBox({ className }: { className?: string }) {
  const { path } = useCompany();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const [reading, setReading] = useState<NeedReading | null>(null);
  const read = useMutation({
    mutationFn: (input: { text: string; as?: NeedKind }) => api.post<NeedReading>(path("/needs"), input),
    onSuccess: (result, input) => {
      setReading(result);
      setAsked(input.text);
    },
  });
  const go = (said = text) => {
    const trimmed = said.trim();
    if (trimmed.length >= 3) read.mutate({ text: trimmed });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go();
  };
  const done = () => {
    setReading(null);
    setText("");
  };
  return (
    <Card className={clsx("p-4 sm:p-5", className)}>
      <form onSubmit={submit}>
        <label htmlFor="need" className="flex items-center gap-2 text-base font-semibold text-fg">
          <Sparkles className="size-[18px] text-brand-600 dark:text-brand-300" /> What do you need?
        </label>
        <p className="mt-0.5 text-sm text-muted">
          Say it as you would to a colleague: something done now or every week, a question, a list to keep, an app, a calculation, or a change.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <textarea
            id="need"
            rows={2}
            className="input min-h-[3.25rem] flex-1 resize-y"
            placeholder="Every Monday, send me the open complaints"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setReading(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                go();
              }
            }}
          />
          <Button type="submit" variant="primary" className="sm:self-start" iconRight={ArrowRight} loading={read.isPending} disabled={text.trim().length < 3}>
            Go
          </Button>
        </div>
      </form>
      {!reading && !read.isPending && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <Chip
              key={example}
              onClick={() => {
                setText(example);
                go(example);
              }}
            >
              {example}
            </Chip>
          ))}
        </div>
      )}
      {read.error && <ErrorState className="mt-3" error={read.error} title="It couldn't be understood" />}
      {reading && (
        <ReadingView
          key={`${asked}|${reading.kind}`}
          reading={reading}
          text={asked}
          busy={read.isPending}
          onOther={(kind) => read.mutate({ text: asked, as: kind })}
          onDone={done}
        />
      )}
    </Card>
  );
}

function ReadingView({
  reading,
  text,
  busy,
  onOther,
  onDone,
}: {
  reading: NeedReading;
  text: string;
  busy: boolean;
  onOther: (kind: NeedKind) => void;
  onDone: () => void;
}) {
  const Icon = NEED[reading.kind].icon;
  return (
    <div className="mt-4 space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-400/25 dark:bg-brand-400/5">
      <p className="flex items-start gap-2 text-sm font-semibold text-fg">
        <Icon className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-300" />
        <span>{reading.summary}</span>
      </p>
      {reading.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {reading.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {reading.kind === "task" && <TaskReading reading={reading} text={text} onDone={onDone} />}
      {reading.kind === "recurring" && <RecurringReading reading={reading} text={text} onDone={onDone} />}
      {reading.kind === "answer" && <AnswerReading question={reading.description ?? text} />}
      {reading.kind === "calculation" && <CalculationReading reading={reading} text={text} onDone={onDone} />}
      {(reading.kind === "table" || reading.kind === "app") && <MakeReading reading={reading} text={text} onDone={onDone} />}
      {reading.kind === "ai-employee" && <HireReading reading={reading} text={text} onDone={onDone} />}
      {reading.kind === "change" && <ChangeReading reading={reading} />}
      {reading.kind === "unclear" && (
        <div className="flex flex-wrap gap-1.5">
          {reading.alternatives.map((kind) => (
            <Chip key={kind} disabled={busy} onClick={() => onOther(kind)}>
              {NEED[kind].label}
            </Chip>
          ))}
        </div>
      )}
      {reading.kind !== "unclear" && reading.alternatives.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-3 text-xs text-muted">
          <span>Not this? It's</span>
          {reading.alternatives.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => onOther(kind)}
              className="rounded-full border border-line bg-surface px-2 py-0.5 text-fg hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:hover:text-brand-200"
            >
              {NEED[kind].label.charAt(0).toLowerCase() + NEED[kind].label.slice(1)}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

/** Who does it (the AI employee whose job fits first), and the work in the person's words. */
function WhoAndWhat({
  reading,
  agent,
  setAgent,
  work,
  setWork,
}: {
  reading: NeedReading;
  agent: string;
  setAgent: (slug: string) => void;
  work: string;
  setWork: (text: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <Field label="Who does it">
        {(id) => (
          <select id={id} className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose…</option>
            {reading.workers.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
                {w.status === "testing" ? " (on trial)" : ""}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="What">
        {(id) => <textarea id={id} rows={2} className="input min-h-[2.75rem]" value={work} onChange={(e) => setWork(e.target.value)} />}
      </Field>
    </div>
  );
}

function TaskReading({ reading, text, onDone }: { reading: NeedReading; text: string; onDone: () => void }) {
  const [agent, setAgent] = useState(reading.agent ?? "");
  const [work, setWork] = useState(reading.work ?? text);
  const give = useGiveWork(onDone);
  const name = reading.workers.find((w) => w.slug === agent)?.name;
  return (
    <>
      <WhoAndWhat reading={reading} agent={agent} setAgent={setAgent} work={work} setWork={setWork} />
      {!reading.workers.length && <Callout tone="warning">No AI employee of your department takes work yet.</Callout>}
      <div className="flex justify-end">
        <Button
          variant="primary"
          icon={Send}
          loading={give.isPending}
          disabled={!agent || work.trim().length < 3}
          onClick={() => give.mutate({ agent, text: work.trim() })}
        >
          {name ? `Give it to ${name}` : "Give it"}
        </Button>
      </div>
    </>
  );
}

/** When it repeats: every day, weekday, week (a day) or month (a date), at a time. */
function WhenPicker({ schedule, onChange }: { schedule: RepeatSchedule; onChange: (next: RepeatSchedule) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="When">
        {(id) => (
          <select
            id={id}
            className="input"
            value={schedule.every}
            onChange={(e) => {
              const every = e.target.value as RepeatSchedule["every"];
              onChange({
                every,
                time: schedule.time,
                ...(every === "week" ? { weekday: schedule.weekday ?? 1 } : {}),
                ...(every === "month" ? { day: schedule.day ?? 1 } : {}),
              });
            }}
          >
            <option value="day">Every day</option>
            <option value="weekday">Every weekday</option>
            <option value="week">Every week</option>
            <option value="month">Every month</option>
          </select>
        )}
      </Field>
      {schedule.every === "week" && (
        <select
          className="input w-auto"
          aria-label="Day of the week"
          value={schedule.weekday ?? 1}
          onChange={(e) => onChange({ ...schedule, weekday: Number(e.target.value) })}
        >
          {DAYS.map((day, i) => (
            <option key={day} value={i}>
              on {day}
            </option>
          ))}
        </select>
      )}
      {schedule.every === "month" && (
        <select
          className="input w-auto"
          aria-label="Day of the month"
          value={schedule.day ?? 1}
          onChange={(e) => onChange({ ...schedule, day: Number(e.target.value) })}
        >
          {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
            <option key={day} value={day}>
              on the {ordinal(day)}
            </option>
          ))}
        </select>
      )}
      <input
        type="time"
        className="input w-auto"
        aria-label="At"
        value={schedule.time}
        onChange={(e) => e.target.value && onChange({ ...schedule, time: e.target.value })}
      />
    </div>
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function RecurringReading({ reading, text, onDone }: { reading: NeedReading; text: string; onDone: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState(reading.agent ?? "");
  const [work, setWork] = useState(reading.work ?? text);
  const [schedule, setSchedule] = useState<RepeatSchedule>(reading.schedule ?? { every: "week", weekday: 1, time: "08:00" });
  const give = useGiveWork(onDone);
  const make = useMutation({
    mutationFn: () => api.post<RecurringWork>(path("/recurring"), { agent, text: work.trim(), schedule }),
    onSuccess: async (made) => {
      toast.success(`${made.agent?.name ?? "It"} does it ${made.when}`, {
        description: made.text,
        link: { to: `/ai/${made.agent?.slug ?? agent}?tab=duties`, label: "See its duties" },
      });
      await queryClient.invalidateQueries({ queryKey: keys.recurring(company) });
      onDone();
    },
    onError: (error) => toast.error(error),
  });
  return (
    <>
      <WhoAndWhat reading={reading} agent={agent} setAgent={setAgent} work={work} setWork={setWork} />
      <WhenPicker schedule={schedule} onChange={setSchedule} />
      <p className="text-xs text-muted">Each time, it's a task for you, as if you had given it that morning. You can stop it any time.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button loading={give.isPending} disabled={!agent || work.trim().length < 3} onClick={() => give.mutate({ agent, text: work.trim() })}>
          Just once, now
        </Button>
        <Button variant="primary" icon={CalendarClock} loading={make.isPending} disabled={!agent || work.trim().length < 3} onClick={() => make.mutate()}>
          Make it regular
        </Button>
      </div>
    </>
  );
}

/** The company assistant answers it at once, in a conversation the person can go on with. */
function AnswerReading({ question }: { question: string }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const ask = useMutation({
    mutationFn: async () => {
      const conversation = await api.post<Conversation>(path("/chat/conversations"), { title: question.slice(0, 80) });
      const message = await api.post<ChatMessage>(path(`/chat/conversations/${conversation.id}/messages`), { text: question });
      return { conversation, message };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.chat(company) }),
  });
  useEffect(() => {
    ask.mutate();
    // Once, for the question it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (ask.error) return <ErrorState error={ask.error} title="It couldn't be answered" />;
  if (!ask.data) return <Skeleton className="h-20" />;
  const { conversation, message } = ask.data;
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-line bg-surface p-3 text-sm">
        <Markdown compact>{message.content}</Markdown>
      </div>
      {message.citations.length > 0 && <p className="text-xs text-muted">From: {[...new Set(message.citations.map((c) => c.title))].join(" · ")}</p>}
      <div className="flex justify-end">
        <Link
          to={`/assistant?c=${conversation.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          <MessageSquare className="size-4" /> Go on in the Assistant
        </Link>
      </div>
    </div>
  );
}

const SCHEDULE_OF: Record<RepeatSchedule["every"], CalculationSchedule> = { day: "daily", weekday: "daily", week: "weekly", month: "monthly" };

/** Worked out at once on the real rows; managers keep it (and let it run by itself). */
function CalculationReading({ reading, text, onDone }: { reading: NeedReading; text: string; onDone: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { departments } = useTableDepartments();
  const rule = reading.description ?? text;
  const [schedule, setSchedule] = useState<CalculationSchedule | "">(reading.schedule ? SCHEDULE_OF[reading.schedule.every] : "");
  const [departmentId, setDepartmentId] = useState("");
  useEffect(() => {
    if (!departmentId && departments[0]) setDepartmentId(departments[0].id);
  }, [departmentId, departments]);
  const write = useMutation({ mutationFn: () => api.post<CalculationProposal>(path("/calculations/write"), { rule }) });
  useEffect(() => {
    write.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const keep = useMutation({
    mutationFn: () =>
      api.post<CalculationView>(path("/calculations"), { ...write.data!.draft, rule, schedule: schedule || null, departmentId: departmentId || null }),
    onSuccess: async (calculation) => {
      toast.success(`${calculation.name} is kept`);
      await queryClient.invalidateQueries({ queryKey: keys.calculations(company) });
      onDone();
      navigate(`/calculations/${calculation.key}`);
    },
    onError: (error) => toast.error(error),
  });
  if (write.error) return <ErrorState error={write.error} title="It couldn't be worked out" />;
  if (!write.data) return <Skeleton className="h-24" />;
  const { draft, trial } = write.data;
  return (
    <div className="space-y-3">
      {trial.ok ? (
        <>
          {draft.explanation && <p className="text-sm text-muted">{draft.explanation}</p>}
          <div className="rounded-lg border border-line bg-surface p-2">
            <ResultView output={draft.output} result={trial.result} compact />
          </div>
        </>
      ) : (
        <Callout tone="danger" title="It didn't work on the rows">
          {trial.error}
        </Callout>
      )}
      {trial.ok && reading.can.build && departments.length > 0 && (
        <div className="flex flex-wrap items-end justify-end gap-2">
          {departments.length > 1 && (
            <select className="input w-auto" aria-label="Whose it is" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <select className="input w-auto" aria-label="When it runs" value={schedule} onChange={(e) => setSchedule(e.target.value as CalculationSchedule | "")}>
            {SCHEDULES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Button variant="primary" icon={Save} loading={keep.isPending} onClick={() => keep.mutate()}>
            Keep it
          </Button>
        </div>
      )}
    </div>
  );
}

function OnlyManagers({ children }: { children: ReactNode }) {
  return <Callout tone="info">{children}</Callout>;
}

/** A table or an app: the Studio's proposal, with the person's words already in it. */
function MakeReading({ reading, text }: { reading: NeedReading; text: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const description = reading.description ?? text;
  if (!reading.can.build) {
    return (
      <OnlyManagers>A manager of your department makes {reading.kind === "app" ? "apps" : "tables"}: tell them what you need, in these words.</OnlyManagers>
    );
  }
  return (
    <>
      <div className="flex justify-end">
        <Button variant="primary" icon={reading.kind === "app" ? LayoutGrid : Table2} onClick={() => setOpen(true)}>
          {reading.kind === "app" ? "See the app" : "See the table"}
        </Button>
      </div>
      {reading.kind === "app" ? (
        <NewAppDialog open={open} onClose={() => setOpen(false)} initial={description} />
      ) : (
        <NewTableDialog open={open} onClose={() => setOpen(false)} initial={description} />
      )}
    </>
  );
}

/**
 * A new AI employee. Filing emails into a table needs one answer (the mailbox), so it is hired here;
 * any other job starts an interview in the Studio, from these words.
 */
function HireReading({ reading, text, onDone }: { reading: NeedReading; text: string; onDone: () => void }) {
  const { path, info } = useCompany();
  const navigate = useNavigate();
  // With Claude, the Studio agent takes it from these words; without, the guided interview.
  const start = useMutation({
    mutationFn: async () =>
      info.llm.available
        ? `/studio/${(await api.post<StudioThreadView>(path("/studio/threads"), { text })).id}`
        : `/hire/studio/${(await api.post<SessionView>(path("/builder/sessions"), { description: reading.description ?? text })).session.id}`,
    onSuccess: (to) => navigate(to),
  });
  const intake = reading.intake;
  if (intake) {
    if (!intake.can)
      return <OnlyManagers>A manager of its department hires the AI employee that fills {intake.table.name}: tell them, in these words.</OnlyManagers>;
    return (
      <div className="space-y-2">
        <FillFromEmail table={intake.table} initialMailbox={intake.mailbox} onDone={onDone} />
        <p className="text-right text-xs text-muted">
          A different job?{" "}
          <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => start.mutate()}>
            Describe it in the Studio
          </button>
        </p>
      </div>
    );
  }
  if (!reading.can.build) return <OnlyManagers>A manager of your department hires AI employees: tell them what you need, in these words.</OnlyManagers>;
  return (
    <>
      {start.error && <ErrorState error={start.error} />}
      <div className="flex justify-end">
        <Button variant="primary" icon={UserPlus} loading={start.isPending} onClick={() => start.mutate()}>
          Start in the Studio
        </Button>
      </div>
    </>
  );
}

const PAGE_OF: Record<NonNullable<NeedReading["target"]>["type"], string> = { table: "tables", app: "apps", calculation: "calculations", agent: "ai" };

/** A change: shown where it is made (a table's, an app's or a calculation's page); for an AI employee, a proposal tested on its recent tasks. */
function ChangeReading({ reading }: { reading: NeedReading }) {
  const { path } = useCompany();
  const navigate = useNavigate();
  const toast = useToast();
  const target = reading.target!;
  const change = reading.change ?? "";
  const propose = useMutation({
    mutationFn: () => api.post<CoachingProposal>(path(`/agents/${encodeURIComponent(target.key)}/changes`), { request: change }),
    onSuccess: () => {
      toast.success("The Studio is working the change in", { description: "It replays recent tasks with it; nothing changes until it is published." });
      navigate(`/ai/${target.key}?tab=coaching`);
    },
    onError: (error) => toast.error(error),
  });
  return (
    <>
      <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg">“{change}”</p>
      {!reading.can.change ? (
        <OnlyManagers>A manager of its department changes {target.name}.</OnlyManagers>
      ) : (
        <div className="flex justify-end">
          {target.type === "agent" ? (
            <Button variant="primary" icon={Wand2} loading={propose.isPending} onClick={() => propose.mutate()}>
              Propose and test it
            </Button>
          ) : (
            <Button variant="primary" icon={Wand2} onClick={() => navigate(`/${PAGE_OF[target.type]}/${target.key}?change=${encodeURIComponent(change)}`)}>
              See the change
            </Button>
          )}
        </div>
      )}
    </>
  );
}
