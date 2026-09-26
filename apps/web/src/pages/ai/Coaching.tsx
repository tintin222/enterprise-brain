import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, ChevronDown, CircleCheck, FlaskConical, GraduationCap, History, ListChecks, Rocket, TriangleAlert, Undo2, UserRound, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge, type Tone } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { Checkbox } from "../../components/Form.tsx";
import { Callout, ErrorState, LoadingBlock, Spinner } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { displayValue, formatDateTime, plural, timeAgo } from "../../lib/format.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AgentDetail, CoachingNote, CoachingNoteKind, CoachingOverview, CoachingProposal, JobChange, ReplayItem } from "../../types.ts";

export const NOTE_KIND: Record<CoachingNoteKind, string> = {
  task: "Marked a task as wrong",
  check: "Checked the work: wrong",
  correction: "Corrected it before approving",
  rejection: "Said no, with a reason",
};

const coachingKey = (company: string, slug: string) => [...keys.agent(company, slug), "coaching"] as const;

/** An AI employee's corrections and proposals; polls while a replay runs. */
export function useCoaching(slug: string) {
  const { company, path } = useCompany();
  return useQuery({
    queryKey: coachingKey(company, slug),
    queryFn: () => api.get<CoachingOverview>(path(`/agents/${encodeURIComponent(slug)}/coaching`)),
    refetchInterval: (query) => (query.state.data?.proposals.some((p) => p.status === "replaying") ? 1_500 : false),
  });
}

function useCoachingActions(slug: string) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: coachingKey(company, slug) });
    void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
  };
  const propose = useMutation({
    mutationFn: (noteIds: string[]) => api.post<CoachingProposal>(path(`/agents/${encodeURIComponent(slug)}/coaching/proposals`), { noteIds }),
    onSuccess: () => {
      refresh();
      toast.success("The Studio is turning them into rules", { description: "It replays recent tasks with them; nothing is sent or changed." });
    },
    onError: (error) => toast.error(error),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "publish" | "keep" }) =>
      api.post<CoachingProposal>(path(`/coaching/proposals/${id}/${decision}`), {}),
    onSuccess: (proposal, { decision }) => {
      refresh();
      toast.success(decision === "publish" ? `Version ${proposal.publishedVersion} is live` : `Kept version ${proposal.currentVersion}`, {
        description: decision === "publish" ? "New tasks follow the new rules." : "The corrections are closed; nothing changed.",
      });
    },
    onError: (error) => toast.error(error),
  });
  return { propose, decide };
}

function NoteLine({ note, children }: { note: CoachingNote; children?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm text-fg">{note.note}</p>
      <p className="mt-0.5 text-xs text-muted">
        {NOTE_KIND[note.kind]} · {note.by} · <span title={formatDateTime(note.createdAt)}>{timeAgo(note.createdAt)}</span>
        {note.taskRef && (
          <>
            {" · "}
            <Link to={`/work/${note.taskRef}`} className="font-mono text-[12px] text-brand-700 hover:underline dark:text-brand-300">
              {note.taskRef}
            </Link>
          </>
        )}
        {children}
      </p>
    </div>
  );
}

function Chips({ values, tone, sign }: { values: string[]; tone: Tone; sign: string }) {
  return (
    <>
      {values.map((value) => (
        <Badge key={`${sign}${value}`} tone={tone} size="xs" className="max-w-[18rem] truncate" title={value}>
          {sign} {value}
        </Badge>
      ))}
    </>
  );
}

function ChangeRow({ change }: { change: JobChange }) {
  const lists = (change.added?.length ?? 0) + (change.removed?.length ?? 0) > 0;
  const lines = [...(change.added ?? []), ...(change.removed ?? [])].some((item) => item.length > 48);
  return (
    <li className="py-2">
      <p className="text-[13px] font-medium text-fg">{change.label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px]">
        {lists && lines ? (
          <ul className="w-full space-y-1">
            {(change.added ?? []).map((line) => (
              <li key={`+${line}`} className="flex gap-2 text-fg">
                <span className="font-mono text-emerald-600 dark:text-emerald-400">+</span>
                {line}
              </li>
            ))}
            {(change.removed ?? []).map((line) => (
              <li key={`-${line}`} className="flex gap-2 text-muted line-through decoration-faint">
                <span className="font-mono text-red-600 no-underline dark:text-red-400">−</span>
                {line}
              </li>
            ))}
          </ul>
        ) : lists ? (
          <>
            <Chips values={change.added ?? []} tone="green" sign="+" />
            <Chips values={change.removed ?? []} tone="red" sign="−" />
          </>
        ) : (
          <>
            <span className="text-muted line-through decoration-faint">{displayValue(change.before)}</span>
            <ArrowRight className="size-3.5 text-faint" />
            <span className="text-fg">{displayValue(change.after)}</span>
          </>
        )}
      </div>
    </li>
  );
}

const ITEM_STATUS: Record<ReplayItem["status"], { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "neutral" },
  same: { label: "Same result", tone: "neutral" },
  changed: { label: "Would change", tone: "amber" },
  failed: { label: "Couldn't replay", tone: "red" },
};

function ReplayRow({ item }: { item: ReplayItem }) {
  const [open, setOpen] = useState(false);
  const outcome = item.changes.filter((c) => c.kind === "outcome");
  const wording = item.changes.filter((c) => c.kind === "wording");
  const status = ITEM_STATUS[item.status];
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/work/${item.ref}`} className="font-mono text-[12px] text-brand-700 hover:underline dark:text-brand-300">
          {item.ref}
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={item.title}>
          {item.title}
        </span>
        {item.corrected && (
          <Badge tone="violet" size="xs" icon={GraduationCap}>
            Was marked wrong
          </Badge>
        )}
        {item.status === "pending" ? <Spinner size="sm" /> : <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      {(outcome.length > 0 || item.steps.length > 0 || wording.length > 0 || item.error) && (
        <div className="mt-2 space-y-1 pl-0.5 text-[13px]">
          {outcome.map((c) => (
            <p key={c.key} className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted">{c.label}:</span>
              <span className="text-muted line-through decoration-faint">{displayValue(c.before)}</span>
              <ArrowRight className="size-3.5 text-faint" />
              <span className="font-medium text-fg">{displayValue(c.after)}</span>
            </p>
          ))}
          {item.steps.map((s) => (
            <p key={s.stepId} className="flex items-center gap-1.5 text-fg">
              {s.kind === "person" ? <UserRound className="size-3.5 text-amber-600" /> : <Wrench className="size-3.5 text-sky-600" />}
              {s.kind === "person"
                ? s.change === "added"
                  ? "Would now ask a person: "
                  : "Would no longer ask a person: "
                : s.change === "added"
                  ? "Would now also: "
                  : "Would no longer: "}
              {s.name}
            </p>
          ))}
          {wording.length > 0 && (
            <button type="button" className="text-xs text-muted underline decoration-dotted hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Hide" : "Show"} new wording ({wording.map((c) => c.label).join(", ")})
            </button>
          )}
          {open &&
            wording.map((c) => (
              <div key={c.key} className="grid gap-2 rounded-lg border border-line bg-subtle/40 p-2.5 text-xs sm:grid-cols-2">
                <div>
                  <p className="mb-1 font-medium text-muted">{c.label}: before</p>
                  <p className="whitespace-pre-wrap text-fg/80">{displayValue(c.before)}</p>
                </div>
                <div>
                  <p className="mb-1 font-medium text-muted">{c.label}: with the new rules</p>
                  <p className="whitespace-pre-wrap text-fg">{displayValue(c.after)}</p>
                </div>
              </div>
            ))}
          {item.error && <p className="text-red-700 dark:text-red-300">{item.error}</p>}
        </div>
      )}
    </li>
  );
}

function replaySentence(proposal: CoachingProposal): string {
  const { summary } = proposal.replay;
  if (!summary.total) return "There were no finished tasks to replay yet.";
  const changed = summary.changed === 0 ? "None would come out differently" : `${summary.changed} of ${summary.total} would come out differently`;
  const corrected =
    summary.corrected === 0
      ? ""
      : summary.correctedChanged === summary.corrected
        ? summary.corrected === 1
          ? ", including the task that was marked wrong"
          : `, including all ${summary.corrected} that were marked wrong`
        : `; ${summary.corrected - summary.correctedChanged} of the ${plural(summary.corrected, "task")} marked wrong would still come out the same`;
  return `${changed}${corrected}.${summary.failed ? ` ${plural(summary.failed, "task")} couldn't be replayed.` : ""}`;
}

function proposalTitle(proposal: CoachingProposal): string {
  const next = proposal.baseVersion + 1;
  if (proposal.status === "published") return `Version ${proposal.publishedVersion}, published by ${proposal.decidedBy}`;
  if (proposal.status === "kept") return `Proposed version ${next}, not published`;
  if (proposal.status === "superseded") return `Proposed version ${next}, replaced by a newer proposal`;
  return `Proposed version ${next}`;
}

export function ProposalPanel({ proposal, name, canDecide, slug }: { proposal: CoachingProposal; name: string; canDecide: boolean; slug: string }) {
  const { decide } = useCoachingActions(slug);
  const next = proposal.baseVersion + 1;
  const undecided = proposal.status === "replaying" || proposal.status === "ready";
  const { summary } = proposal.replay;
  const replaying = proposal.status === "replaying";
  const busy = decide.isPending;
  return (
    <Card className={clsx("overflow-hidden", undecided && "border-brand-200 dark:border-brand-400/30")}>
      <CardHeader
        title={proposalTitle(proposal)}
        icon={FlaskConical}
        subtitle={`From ${plural(proposal.notes.length, "correction")} · asked by ${proposal.createdBy} ${timeAgo(proposal.createdAt)}`}
      />
      <div className="space-y-5 px-5 py-4">
        {proposal.stale && (
          <Callout tone="warning" icon={TriangleAlert} title={`${name} changed since this was proposed`}>
            It is at version {proposal.currentVersion} now. Keep this proposal and turn the corrections into rules again, from the current version.
          </Callout>
        )}
        {proposal.status === "failed" && (
          <Callout tone="danger" icon={TriangleAlert} title="The replay didn't finish">
            {proposal.replay.error ?? "Something went wrong while replaying."}
          </Callout>
        )}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-fg">New rules</h3>
          <ul className="space-y-1.5">
            {proposal.rules.map((rule) => (
              <li key={rule} className="flex gap-2 text-sm text-fg">
                <GraduationCap className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-300" />
                {rule}
              </li>
            ))}
          </ul>
          {proposal.explanation && <p className="mt-2 text-[13px] text-muted">{proposal.explanation}</p>}
        </section>
        {proposal.changes.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold text-fg">What changes in its job</h3>
            <ul className="divide-y divide-line">
              {proposal.changes.map((change) => (
                <ChangeRow key={`${change.path}-${change.label}`} change={change} />
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="border-t border-line">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2">
          <h3 className="text-sm font-semibold text-fg">Tested on recent tasks</h3>
          <span className="text-xs text-muted">Each ran again with the new rules, as a test: nothing was sent or changed in any system.</span>
        </div>
        {replaying && (
          <p className="flex items-center gap-2 px-5 pb-2 text-sm text-muted">
            <Spinner size="sm" /> Replaying {summary.done} of {summary.total || "…"}
          </p>
        )}
        {!replaying && proposal.status !== "failed" && <p className="px-5 pb-2 text-sm text-fg">{replaySentence(proposal)}</p>}
        <ul className="divide-y divide-line">
          {proposal.replay.items.map((item) => (
            <ReplayRow key={item.taskId} item={item} />
          ))}
        </ul>
      </div>
      {canDecide && undecided && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-subtle/40 px-5 py-3">
          <p className="mr-auto text-xs text-muted">
            {replaying ? "You can decide once the replay is done." : `Publishing makes version ${next} live for new tasks.`}
          </p>
          <Button
            icon={Undo2}
            disabled={busy || replaying}
            loading={busy && decide.variables?.decision === "keep"}
            onClick={() => decide.mutate({ id: proposal.id, decision: "keep" })}
          >
            Keep version {proposal.currentVersion}
          </Button>
          <Button
            variant="primary"
            icon={Rocket}
            disabled={busy || proposal.status !== "ready" || proposal.stale}
            loading={busy && decide.variables?.decision === "publish"}
            onClick={() => decide.mutate({ id: proposal.id, decision: "publish" })}
          >
            Publish version {next}
          </Button>
        </div>
      )}
    </Card>
  );
}

const DECIDED: Record<string, { label: (p: CoachingProposal) => string; tone: Tone }> = {
  published: { label: (p) => `Published as version ${p.publishedVersion}`, tone: "green" },
  kept: { label: (p) => `Kept version ${p.baseVersion}`, tone: "neutral" },
  superseded: { label: () => "Replaced by a newer proposal", tone: "neutral" },
  failed: { label: () => "Replay failed", tone: "red" },
};

export function CoachingTab({ detail }: { detail: AgentDetail }) {
  const slug = detail.agent.slug;
  const name = detail.definition.name;
  const { data, isLoading, error, refetch } = useCoaching(slug);
  const { propose } = useCoachingActions(slug);
  const open = useMemo(() => (data?.notes ?? []).filter((n) => n.status === "open"), [data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<string | null>(null);
  const openIds = open.map((n) => n.id).join(",");
  useEffect(() => setSelected(new Set(openIds ? openIds.split(",") : [])), [openIds]);

  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const current = data.proposals.find((p) => p.status === "replaying" || p.status === "ready");
  const earlier = data.proposals.filter((p) => p !== current && p.status !== "replaying" && p.status !== "ready");
  const closed = data.notes.filter((n) => n.status !== "open");
  const inCurrent = new Set(current?.notes.map((n) => n.id) ?? []);
  const fresh = open.filter((n) => !inCurrent.has(n.id));

  return (
    <div className="space-y-6">
      {current && <ProposalPanel proposal={current} name={name} canDecide={data.canDecide} slug={slug} />}
      <Card className="overflow-hidden">
        <CardHeader
          title="Corrections"
          icon={GraduationCap}
          subtitle="What people said it got wrong. The Studio turns them into rules for its next version, and tests them on recent tasks first."
        />
        {open.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">
            None open. When someone marks a finished task as wrong, corrects a change before approving it, or says no with a reason, it shows here.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {open.map((note) => (
                <li key={note.id} className="flex items-start gap-3 px-5 py-3">
                  {data.canDecide ? (
                    <Checkbox
                      className="pt-0.5"
                      checked={selected.has(note.id)}
                      onChange={(checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(note.id);
                        else next.delete(note.id);
                        setSelected(next);
                      }}
                      label={<span className="sr-only">Include</span>}
                    />
                  ) : (
                    <GraduationCap className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-300" />
                  )}
                  <NoteLine note={note}>{inCurrent.has(note.id) && " · in the proposal above"}</NoteLine>
                </li>
              ))}
            </ul>
            {data.canDecide && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line bg-subtle/40 px-5 py-3">
                <p className="mr-auto text-xs text-muted">
                  {data.llm.available
                    ? "The Studio writes each lesson as a rule, adjusts its job where needed, and replays recent tasks. Nothing is sent or changed."
                    : "No language model is set up: the corrections are added to its instructions as they were written."}
                </p>
                <Button
                  variant={current && fresh.length === 0 ? "secondary" : "primary"}
                  icon={FlaskConical}
                  disabled={selected.size === 0 || current?.status === "replaying"}
                  loading={propose.isPending}
                  onClick={() => propose.mutate([...selected])}
                >
                  {current ? "Propose again with these" : `Turn ${selected.size === 1 ? "it" : "them"} into rules and test`}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      {(earlier.length > 0 || closed.length > 0) && (
        <Card className="overflow-hidden">
          <CardHeader title="Earlier coaching" icon={History} />
          <ul className="divide-y divide-line">
            {earlier.map((p) => {
              const decided = DECIDED[p.status]!;
              return (
                <li key={p.id} className="px-5 py-3">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
                    onClick={() => setShown(shown === p.id ? null : p.id)}
                    aria-expanded={shown === p.id}
                  >
                    <Badge tone={decided.tone} icon={p.status === "published" ? CircleCheck : undefined}>
                      {decided.label(p)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg" title={p.rules.join(" · ")}>
                      {p.rules.join(" · ")}
                    </span>
                    <span className="text-xs text-faint">
                      {p.decidedBy ?? p.createdBy} · {timeAgo(p.decidedAt ?? p.createdAt)}
                    </span>
                    <ChevronDown className={clsx("size-4 text-faint transition-transform", shown === p.id && "rotate-180")} />
                  </button>
                  {shown === p.id && (
                    <div className="mt-3">
                      <ProposalPanel proposal={p} name={name} canDecide={false} slug={slug} />
                    </div>
                  )}
                </li>
              );
            })}
            {closed.map((note) => (
              <li key={note.id} className={clsx("flex items-start gap-3 px-5 py-3")}>
                <ListChecks className="mt-0.5 size-4 shrink-0 text-faint" />
                <NoteLine note={note}>{note.status === "applied" ? ` · a rule since version ${note.appliedVersion}` : " · kept as it was"}</NoteLine>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
