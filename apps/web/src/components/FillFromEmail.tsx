import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, Play, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentStatus, IntakeJob, Probation } from "../types.ts";
import { Button } from "./Button.tsx";
import { Field } from "./Form.tsx";
import { Callout, ErrorState, Skeleton } from "./Spinner.tsx";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LEVELS: { value: Probation; label: string }[] = [
  { value: "supervised", label: "Supervised: a person approves each record" },
  { value: "shadow", label: "Shadow: it proposes, a person adds" },
  { value: "trusted", label: "Trusted: it adds records on its own" },
];

/**
 * Fill a table from email: an AI employee that reads a mailbox and adds each email as a record. One
 * answer (the mailbox) and its job in plain words; it is hired on trial, and put to work here.
 */
export function FillFromEmail({
  table,
  initialMailbox,
  onDone,
}: {
  table: { key: string; name: string };
  initialMailbox?: string | null;
  onDone?: () => void;
}) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mailbox, setMailbox] = useState(initialMailbox ?? "");
  const [level, setLevel] = useState<Probation>("supervised");
  const [typed, setTyped] = useState(mailbox);
  useEffect(() => {
    const timer = window.setTimeout(() => setTyped(mailbox.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [mailbox]);
  const url = path(`/tables/${encodeURIComponent(table.key)}/intake`);
  const preview = useQuery({
    queryKey: ["intake", table.key, typed, level],
    queryFn: () => api.post<{ name: string; job: IntakeJob }>(url, { mailbox: typed, level, dryRun: true }),
    enabled: EMAIL.test(typed),
  });
  const hire = useMutation({
    mutationFn: () => api.post<{ agent: { slug: string; name: string; status: AgentStatus }; job: IntakeJob }>(url, { mailbox: mailbox.trim(), level }),
    onSuccess: async (done) => {
      toast.success(`${done.agent.name} is hired, on trial`);
      await queryClient.invalidateQueries({ queryKey: keys.agents(company) });
    },
    onError: (error) => toast.error(error),
  });
  const start = useMutation({
    mutationFn: (slug: string) => api.post(path(`/agents/${encodeURIComponent(slug)}/status`), { status: "active" }),
    onSuccess: async () => {
      toast.success("At work: each new email becomes a record");
      await queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      onDone?.();
    },
    onError: (error) => toast.error(error),
  });

  if (hire.data) {
    const hired = hire.data.agent;
    return (
      <div className="space-y-3">
        <Callout tone="success" title={`${hired.name} is hired, on trial`}>
          It works only when you try it until you put it to work. From then on, each email sent to {mailbox.trim()} becomes a record of {table.name}.
        </Callout>
        <div className="flex flex-wrap justify-end gap-2">
          <Link to={`/ai/${hired.slug}`} className="inline-flex items-center px-3 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            Open its page
          </Link>
          <Button variant="primary" icon={Play} loading={start.isPending} disabled={start.isSuccess} onClick={() => start.mutate(hired.slug)}>
            {start.isSuccess ? "At work" : "Put it to work"}
          </Button>
        </div>
      </div>
    );
  }

  const job = preview.data?.job;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="The mailbox it reads" hint="IT connects it, if it isn't yet (Settings → Connections).">
          {(id) => (
            <input id={id} className="input" type="email" placeholder="quality@company.com" value={mailbox} onChange={(e) => setMailbox(e.target.value)} />
          )}
        </Field>
        <Field label="At first">
          {(id) => (
            <select id={id} className="input" value={level} onChange={(e) => setLevel(e.target.value as Probation)}>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {preview.error && <ErrorState error={preview.error} />}
      {EMAIL.test(typed) && !job && !preview.error && <Skeleton className="h-28" />}
      {job && (
        <div className="rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="mb-2 flex items-center gap-2 font-medium text-fg">
            <Inbox className="size-4 text-muted" /> {preview.data!.name}: its job
          </p>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Duty</dt>
            <dd className="text-fg">{job.duty}</dd>
            {job.picks.length > 0 && (
              <>
                <dt className="text-muted">Picks out</dt>
                <dd className="text-fg">{job.picks.join(", ")}</dd>
              </>
            )}
            {[...job.takes, ...job.startsAs].length > 0 && (
              <>
                <dt className="text-muted">Also</dt>
                <dd className="text-fg">{[...job.takes, ...job.startsAs].join("; ")}</dd>
              </>
            )}
            {job.leaves.length > 0 && (
              <>
                <dt className="text-muted">Left to people</dt>
                <dd className="text-fg">{job.leaves.join(", ")}</dd>
              </>
            )}
            <dt className="text-muted">Never</dt>
            <dd className="text-fg">{job.never.join("; ")}</dd>
            <dt className="text-muted">At first</dt>
            <dd className="flex items-center gap-1.5 text-fg">
              <Check className="size-3.5 text-emerald-600" /> {job.levelText}
            </dd>
          </dl>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" icon={UserPlus} loading={hire.isPending} disabled={!job} onClick={() => hire.mutate()}>
          Hire it on trial
        </Button>
      </div>
    </div>
  );
}
