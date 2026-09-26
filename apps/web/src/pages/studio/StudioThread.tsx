import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  BookOpen,
  CircleHelp,
  Eye,
  FileText,
  FlaskConical,
  LayoutGrid,
  LayoutTemplate,
  Mail,
  MessageSquare,
  Paperclip,
  Plug,
  Rocket,
  SendHorizontal,
  Sparkles,
  Square,
  Table2,
  Trash2,
  UserPlus,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, isApiError } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { FileChip } from "../../components/Dropzone.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { ErrorState, LoadingBlock, Spinner } from "../../components/Spinner.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { keys, useStudioThread } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { StoredFile, StudioEmployee, StudioEvent, StudioQuestion, StudioThreadView } from "../../types.ts";

/**
 * The Studio as an agent: the person says what they need; Claude looks around, asks what only they
 * can say, builds the parts, tries them and fixes them. The conversation shows its work as it goes;
 * the solution, beside it, is what will go to work.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function useStudioActions(id: string) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.studio(company) });
  const send = useMutation({
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => {
      let fileIds: string[] = [];
      if (files.length) {
        const form = new FormData();
        for (const file of files) form.append("file", file, file.name);
        fileIds = (await api.upload<StoredFile[]>(path("/files"), form)).map((f) => f.id);
      }
      return api.post<StudioThreadView>(path(`/studio/threads/${id}/messages`), { text, fileIds });
    },
    onSuccess: (view) => {
      queryClient.setQueryData([...keys.studio(company), id], view);
      void refresh();
    },
    onError: (e) => toast.error(e),
  });
  const stop = useMutation({
    mutationFn: () => api.post(path(`/studio/threads/${id}/stop`), {}),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e),
  });
  const putToWork = useMutation({
    mutationFn: () => api.post<StudioThreadView>(path(`/studio/threads/${id}/put-to-work`), {}),
    onSuccess: (view) => {
      queryClient.setQueryData([...keys.studio(company), id], view);
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      void queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      void queryClient.invalidateQueries({ queryKey: keys.apps(company) });
      toast.success("It's at work");
    },
    onError: (e) => toast.error(e),
  });
  const discard = useMutation({
    mutationFn: () => api.del(path(`/studio/threads/${id}`)),
    onSuccess: () => {
      void refresh();
      navigate("/hire");
    },
    onError: (e) => toast.error(e),
  });
  return { send, stop, putToWork, discard };
}

type Actions = ReturnType<typeof useStudioActions>;

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

const STEP_ICONS: Record<string, LucideIcon> = {
  look_around: Eye,
  read_mailbox: Mail,
  read_email: Mail,
  read_file: FileText,
  look_at: Eye,
  search_knowledge: BookOpen,
  ask_it: Plug,
  save_table: Table2,
  save_ai_employee: Bot,
  save_app: LayoutGrid,
  try_ai_employee: FlaskConical,
  remove: Trash2,
};

const PART_TEXT: Record<string, [LucideIcon, string, string]> = {
  ai_employee: [Bot, "Wrote the job of", "Changed the job of"],
  table: [Table2, "Made the table", "Changed the table"],
  app: [LayoutGrid, "Planned the app", "Changed the app"],
};

function Line({ icon: Icon, children, tone = "muted" }: { icon: LucideIcon; children: React.ReactNode; tone?: "muted" | "bad" | "good" }) {
  return (
    <div
      className={clsx(
        "flex items-start gap-2 text-[13px] leading-5",
        tone === "bad" ? "text-red-700 dark:text-red-300" : tone === "good" ? "text-emerald-700 dark:text-emerald-300" : "text-muted",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Questions({ questions, active, onPick }: { questions: StudioQuestion[]; active: boolean; onPick: (text: string) => void }) {
  const recommended = questions.map((q, i) => (q.recommended ? `${questions.length > 1 ? `${i + 1}. ` : ""}${q.recommended}` : "")).filter(Boolean);
  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-400/25 dark:bg-brand-400/5">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
        <CircleHelp className="size-4 text-brand-600 dark:text-brand-300" /> {active ? "The Studio asks" : "The Studio asked"}
      </p>
      <ol className="space-y-3">
        {questions.map((q, i) => (
          <li key={i} className="text-sm">
            <p className="font-medium text-fg">
              {questions.length > 1 ? `${i + 1}. ` : ""}
              {q.question}
            </p>
            {q.why && <p className="mt-0.5 text-xs text-muted">{q.why}</p>}
            {active && (q.options?.length || q.recommended) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(q.options?.length ? q.options : [q.recommended!]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onPick(`${questions.length > 1 ? `${i + 1}. ` : ""}${option}`)}
                    className={clsx(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      option === q.recommended
                        ? "border-brand-300 bg-surface font-medium text-brand-700 hover:bg-brand-50 dark:border-brand-400/40 dark:text-brand-200"
                        : "border-line-strong bg-surface text-fg hover:bg-subtle",
                    )}
                  >
                    {option}
                    {option === q.recommended && q.options?.length ? " · recommended" : ""}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {active && recommended.length > 1 && (
        <Button size="sm" variant="soft" className="mt-3" onClick={() => onPick(recommended.join("\n"))}>
          Use the recommended answers
        </Button>
      )}
    </div>
  );
}

function EventView({ event, last, view, onPick }: { event: StudioEvent; last: boolean; view: StudioThreadView; onPick: (text: string) => void }) {
  const d = event.data;
  const text = typeof d.text === "string" ? d.text : "";
  switch (event.kind) {
    case "user":
    case "answer": {
      const files = Array.isArray(d.files) ? (d.files as { id: string; name: string }[]) : [];
      return (
        <div className="flex justify-end" data-message>
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white dark:bg-brand-500">
            {text}
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <FileChip key={f.id} name={f.name} />
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    case "note":
      return (
        <Line icon={Sparkles}>
          <span className="italic">{text}</span>
        </Line>
      );
    case "step":
      return (
        <Line icon={STEP_ICONS[String(d.tool)] ?? Sparkles} tone={d.ok === false ? "bad" : "muted"}>
          {text}
        </Line>
      );
    case "part": {
      const [icon, made, changed] = PART_TEXT[String(d.part)] ?? [Sparkles, "Saved", "Changed"];
      return (
        <Line icon={icon}>
          {d.changed ? changed : made} <span className="font-medium text-fg">{String(d.name)}</span>
        </Line>
      );
    }
    case "removed":
      return <Line icon={Trash2}>Removed {String(d.key)}</Line>;
    case "request":
      return (
        <Line icon={Plug}>
          Asked IT: <span className="font-medium text-fg">{String(d.system)}</span>: {String(d.needed)}
        </Line>
      );
    case "trying":
      return (
        <Line icon={FlaskConical}>
          Trying <span className="font-medium text-fg">{String(d.name)}</span> on {String(d.example)}
          {last && view.status === "working" ? <Spinner size="sm" className="ml-2 inline" /> : null}
        </Line>
      );
    case "try": {
      const ok = d.status === "succeeded";
      return (
        <div className="rounded-xl border border-line bg-surface p-3.5 text-sm" data-message>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <FlaskConical className="size-4 text-muted" />
            <span className="font-medium text-fg">
              Tried {String(d.name)} on {String(d.example)}
            </span>
            <StatusPill status={String(d.status)} size="xs" label={ok ? "Worked" : undefined} />
            <Link to={`/runs/${String(d.runId)}`} className="ml-auto text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
              See what it did
            </Link>
          </div>
          <Markdown compact className="text-[13px] text-muted">
            {String(d.outcome ?? "")}
          </Markdown>
          <p className="mt-1.5 text-xs text-faint">A try sends nothing and changes nothing.</p>
        </div>
      );
    }
    case "question": {
      const questions = Array.isArray(d.questions) ? (d.questions as StudioQuestion[]) : [];
      return <Questions questions={questions} active={last && view.status === "asking"} onPick={onPick} />;
    }
    case "said":
      return (
        <div className="flex gap-3" data-message>
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-violet-600 text-white">
            <WandSparkles className="size-3.5" />
          </span>
          <Markdown className="min-w-0 flex-1 text-sm">{text}</Markdown>
        </div>
      );
    case "stopped":
      return <Line icon={Square}>Stopped. Say what to do next.</Line>;
    case "built":
      return (
        <div
          className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 text-sm text-emerald-900 dark:border-emerald-400/25 dark:bg-emerald-400/5 dark:text-emerald-200"
          data-message
        >
          <p className="flex items-center gap-2 font-semibold">
            <Rocket className="size-4" /> At work
          </p>
          <p className="mt-1">Its AI employees do their duties from now on; its tables and apps are with the department.</p>
        </div>
      );
    case "error":
      return (
        <div
          className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800 dark:border-red-400/25 dark:bg-red-400/5 dark:text-red-200"
          data-message
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" /> Something went wrong
          </p>
          <p className="mt-1 break-words">{text}</p>
        </div>
      );
  }
}

function Conversation({ view, onPick }: { view: StudioThreadView; onPick: (text: string) => void }) {
  // "Trying…" gives way to the try's result.
  const shown = view.events.filter((e, i) => e.kind !== "trying" || !view.events.slice(i + 1).some((later) => later.kind === "try"));
  return (
    <div className="space-y-3">
      {shown.map((event, i) => (
        <EventView key={event.seq} event={event} last={i === shown.length - 1} view={view} onPick={onPick} />
      ))}
      {view.status === "working" && (
        <div className="flex items-center gap-2 pt-1 text-[13px] text-muted">
          <Spinner size="sm" /> The Studio is working…
        </div>
      )}
      {view.status === "interrupted" && (
        <Line icon={AlertTriangle} tone="bad">
          The Studio was interrupted (the server restarted). Send your last message again.
        </Line>
      )}
    </div>
  );
}

function Composer({ view, actions, text, setText }: { view: StudioThreadView; actions: Actions; text: string; setText: (text: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const working = view.status === "working";
  const built = Boolean(view.built);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const send = () => {
    if (!text.trim() || working || built) return;
    actions.send.mutate({ text: text.trim(), files }, { onSuccess: () => (setText(""), setFiles([])) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  if (built) return null;
  return (
    <div className="border-t border-line bg-surface px-4 py-3 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <FileChip key={`${f.name}-${i}`} name={f.name} size={f.size} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface px-2 py-1.5 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/20">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className="mb-0.5 rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg"
            aria-label="Add files: samples, examples, procedures"
            title="Add files: samples, examples, procedures"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) setFiles((prev) => [...prev, ...picked]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={view.status === "asking" ? "Answer in your own words" : "Tell the Studio what to change, or what else it should do"}
            aria-label="Message the Studio"
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm text-fg outline-none placeholder:text-faint"
          />
          {working ? (
            <Button variant="secondary" icon={Square} onClick={() => actions.stop.mutate()} loading={actions.stop.isPending} aria-label="Stop">
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button variant="primary" icon={SendHorizontal} onClick={send} loading={actions.send.isPending} disabled={!text.trim()} aria-label="Send">
              <span className="hidden sm:inline">Send</span>
            </Button>
          )}
        </div>
        <p className="mt-1.5 hidden text-xs text-muted md:block">Enter to send, Shift+Enter for a new line. Nothing works for real until you put it to work.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The solution
// ---------------------------------------------------------------------------

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
        <Icon className="size-3.5" /> {title}
      </h3>
      {children}
    </section>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <ul className="mt-0.5 space-y-0.5 text-[13px] text-fg">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span className="text-faint">·</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmployeeCard({ employee }: { employee: StudioEmployee }) {
  const atWork = employee.status === "active";
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
            {atWork ? (
              <Link to={`/ai/${employee.key}`} className="hover:underline">
                {employee.name}
              </Link>
            ) : (
              employee.name
            )}
            <Badge tone={atWork ? "green" : "neutral"} size="xs">
              {atWork ? "At work" : "Draft"}
            </Badge>
          </p>
          <p className="text-xs text-muted">
            {employee.role}
            {employee.department ? ` · ${employee.department}` : ""}
          </p>
        </div>
      </div>
      <List label="Works when" items={[...employee.duties, "People give it work"]} />
      <List label="May use" items={employee.abilities} />
      <List label="A person approves first" items={employee.approvals} />
      <p className="text-xs text-muted">{employee.levelText}</p>
      {employee.notes.map((note) => (
        <p key={note} className="flex gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {note}
        </p>
      ))}
      <p className="text-xs text-muted">
        {employee.lastTry ? (
          <>
            Tried {employee.tries} time{employee.tries === 1 ? "" : "s"}; last on {employee.lastTry.example}:{" "}
            <Link to={`/runs/${employee.lastTry.runId}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
              {employee.lastTry.status === "succeeded" ? "worked" : employee.lastTry.status}
            </Link>
          </>
        ) : (
          "Not tried yet"
        )}
      </p>
    </div>
  );
}

function SolutionPane({ view, actions }: { view: StudioThreadView; actions: Actions }) {
  const { employees, tables, apps, requests } = view.solution;
  const empty = !employees.length && !tables.length && !apps.length && !requests.length;
  const working = view.status === "working";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5">
        {empty ? (
          <EmptyState
            compact
            icon={LayoutTemplate}
            title="Nothing built yet"
            description="As you talk, the Studio builds here what will do the work: AI employees, the tables they keep and the screens people use."
          />
        ) : (
          <>
            {employees.length > 0 && (
              <Section icon={Bot} title="AI employees">
                {employees.map((e) => (
                  <EmployeeCard key={e.key} employee={e} />
                ))}
              </Section>
            )}
            {tables.length > 0 && (
              <Section icon={Table2} title="Tables">
                {tables.map((t) => (
                  <div key={t.key} className="rounded-xl border border-line bg-surface p-4">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                      <Link to={`/tables/${t.key}`} className="hover:underline">
                        {t.name}
                      </Link>
                      {t.draft && (
                        <Badge tone="neutral" size="xs">
                          Kept here until it's put to work
                        </Badge>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.fields.map((f) => (
                        <span key={f.label} className="rounded-md bg-subtle px-2 py-0.5 text-xs text-fg">
                          {f.label}
                          {f.personal ? " · personal" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>
            )}
            {apps.length > 0 && (
              <Section icon={LayoutGrid} title="Apps">
                {apps.map((a) => (
                  <div key={a.key} className="rounded-xl border border-line bg-surface p-4">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                      {a.made ? (
                        <Link to={`/apps/${a.key}`} className="hover:underline">
                          {a.name}
                        </Link>
                      ) : (
                        a.name
                      )}
                      {!a.made && (
                        <Badge tone="neutral" size="xs">
                          Made when it's put to work
                        </Badge>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted">{a.pages.join(" · ")}</p>
                  </div>
                ))}
              </Section>
            )}
            {requests.length > 0 && (
              <Section icon={Plug} title="Asked of IT">
                {requests.map((r) => (
                  <div key={r.id} className="rounded-xl border border-line bg-surface p-3.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                      {r.system} <StatusPill status={r.status === "done" ? "answered" : "waiting"} size="xs" />
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{r.needed}</p>
                    {r.answer && <p className="mt-1 text-xs text-fg">IT: {r.answer}</p>}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
      <div className={clsx("shrink-0 border-t border-line p-4 sm:px-5", empty && "hidden")}>
        {view.built ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <Rocket className="size-4" /> At work since {formatDateTime(view.built.at)}
          </p>
        ) : (
          <>
            <Button
              variant="primary"
              size="lg"
              icon={Rocket}
              className="w-full"
              disabled={working || !(employees.length || tables.length || apps.length)}
              loading={actions.putToWork.isPending}
              onClick={() => actions.putToWork.mutate()}
            >
              Put it to work
            </Button>
            <p className="mt-2 text-xs text-muted">
              {employees.length
                ? "Its AI employees start their duties, on probation: a person approves what they send or change. Its tables and apps join the department."
                : "Its tables and apps join the department."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ThreadScreen({ view }: { view: StudioThreadView }) {
  const actions = useStudioActions(view.id);
  useDocumentTitle(`${view.title} · Studio`);
  const [pane, setPane] = useState<"chat" | "solution">("chat");
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const count = view.events.length;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 1) {
      el.querySelectorAll<HTMLElement>("[data-message]")
        .item(el.querySelectorAll("[data-message]").length - 1)
        ?.scrollIntoView({ block: "start" });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [count, view.status]);
  const parts = view.solution.employees.length + view.solution.tables.length + view.solution.apps.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:overflow-hidden">
      <div className="shrink-0 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link to="/hire" className="-ml-1 rounded-lg p-1 text-muted hover:bg-subtle hover:text-fg" aria-label="Back to Hire">
            <ArrowLeft className="size-5" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-fg">{view.title}</h1>
          <StatusPill
            status={view.built ? "active" : view.status === "working" ? "running" : view.status === "asking" ? "waiting" : view.status}
            label={
              view.built
                ? "At work"
                : view.status === "working"
                  ? "Working"
                  : view.status === "asking"
                    ? "Waiting for you"
                    : view.status === "idle"
                      ? "Your turn"
                      : undefined
            }
          />
          {!view.built && (
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              disabled={view.status === "working"}
              loading={actions.discard.isPending}
              onClick={() => {
                if (window.confirm("Throw this conversation away, with the drafts it made?")) actions.discard.mutate();
              }}
            >
              <span className="hidden sm:inline">Discard</span>
            </Button>
          )}
        </div>
      </div>
      <div className="flex justify-center border-b border-line bg-surface px-4 py-2 xl:hidden">
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            {
              value: "chat",
              label: (
                <span className="flex items-center gap-1.5">
                  <MessageSquare className="size-3.5" /> Conversation
                </span>
              ),
            },
            {
              value: "solution",
              label: (
                <span className="flex items-center gap-1.5">
                  <UserPlus className="size-3.5" /> Solution{parts ? ` (${parts})` : ""}
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[minmax(0,1fr)_480px]">
        <section className={clsx("min-h-0 flex-col", pane === "chat" ? "flex" : "hidden xl:flex")} aria-label="Conversation">
          <div ref={scroller} className="relative min-h-[50vh] flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:min-h-0">
            <div className="mx-auto max-w-3xl">
              <Conversation view={view} onPick={(picked) => setText(text.trim() ? `${text.trim()}\n${picked}` : picked)} />
            </div>
          </div>
          <div className="sticky bottom-0 z-10 lg:static">
            <Composer view={view} actions={actions} text={text} setText={setText} />
          </div>
        </section>
        <aside
          className={clsx("min-h-0 flex-col border-line bg-surface xl:border-l", pane === "solution" ? "flex" : "hidden xl:flex")}
          aria-label="The solution"
        >
          <SolutionPane view={view} actions={actions} />
        </aside>
      </div>
    </div>
  );
}

export default function StudioThreadPage() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = useStudioThread(id);
  if (isLoading) return <LoadingBlock label="Loading the conversation…" className="flex-1" />;
  if (isApiError(error, 404) || isApiError(error, 403) || (!data && !error)) {
    return (
      <div className="p-6">
        <EmptyState
          icon={WandSparkles}
          title="This conversation isn't here"
          description="It may be someone else's, or it was thrown away."
          action={
            <ButtonLink to="/hire" variant="primary">
              Hire
            </ButtonLink>
          }
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }
  return <ThreadScreen view={data} />;
}
