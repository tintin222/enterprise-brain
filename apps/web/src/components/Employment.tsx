import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BriefcaseBusiness, CalendarClock, Inbox, Save, UserRound, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatMoney } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDetail, Employment, Probation, TrustLimits } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardHeader } from "./Card.tsx";

export const PROBATION: Record<Probation, { label: string; alone: string; person: string }> = {
  shadow: { label: "Shadow", alone: "Reads and prepares drafts", person: "Every action, and a check of every finished task" },
  supervised: { label: "Supervised", alone: "Reads, classifies and drafts", person: "Every change, such as sending an email or writing to a system" },
  trusted: { label: "Trusted", alone: "Acts within the limits you set", person: "Anything above its limits" },
};

const DUTY_ICONS: Record<string, LucideIcon> = { mailbox: Inbox, schedule: CalendarClock };

interface Form {
  managerUserId: string;
  probation: Probation;
  maxAmount: string;
  currency: string;
  maxActionsPerDay: string;
  mailDomains: string;
  budget: string;
}

function toForm(e: Employment): Form {
  return {
    managerUserId: e.manager?.id ?? "",
    probation: e.probation,
    maxAmount: e.limits.maxAmount?.toString() ?? "",
    currency: e.limits.currency ?? "",
    maxActionsPerDay: e.limits.maxActionsPerDay?.toString() ?? "",
    mailDomains: (e.limits.mailDomains ?? []).join(", "),
    budget: e.monthlyBudgetUsd?.toString() ?? "",
  };
}

function toLimits(form: Form): TrustLimits {
  const number = (text: string) => (text.trim() === "" ? undefined : Number(text));
  const domains = form.mailDomains.split(/[\s,;]+/).filter(Boolean);
  return {
    ...(number(form.maxAmount) !== undefined ? { maxAmount: number(form.maxAmount) } : {}),
    ...(form.currency.trim() ? { currency: form.currency.trim().toUpperCase() } : {}),
    ...(number(form.maxActionsPerDay) !== undefined ? { maxActionsPerDay: number(form.maxActionsPerDay) } : {}),
    ...(domains.length ? { mailDomains: domains } : {}),
  };
}

/**
 * An AI employee's employment: who manages it, how much it may do alone (its probation level and
 * limits), what it may spend a month, and its standing duties. Its managers change it here.
 */
export function EmploymentPanel({ detail }: { detail: AgentDetail }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const employment = detail.employment;
  const [form, setForm] = useState<Form | null>(employment ? toForm(employment) : null);
  useEffect(() => {
    if (employment) setForm(toForm(employment));
  }, [employment]);
  const save = useMutation({
    mutationFn: (f: Form) =>
      api.put(path(`/agents/${encodeURIComponent(detail.agent.slug)}/employment`), {
        managerUserId: f.managerUserId || null,
        probation: f.probation,
        limits: toLimits(f),
        monthlyBudgetUsd: f.budget.trim() === "" ? null : Number(f.budget),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success(`Saved ${detail.definition.name}'s manager, level and budget`);
    },
    onError: (error) => toast.error(error),
  });
  if (!employment || !form) return null;
  const editable = Boolean(detail.canManage);
  const changed = JSON.stringify(form) !== JSON.stringify(toForm(employment));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };
  const budget = employment.monthlyBudgetUsd;
  const used = budget ? Math.min(100, Math.round((employment.costThisMonthUsd / budget) * 100)) : 0;
  return (
    <Card>
      <CardHeader
        title="Manager, level and budget"
        icon={BriefcaseBusiness}
        subtitle={editable ? "You manage this AI employee: decide how much it does alone." : "Set by its manager."}
      />
      <form onSubmit={submit} className="space-y-6 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="employment-manager">
              Manager
            </label>
            {editable ? (
              <select
                id="employment-manager"
                className="input"
                value={form.managerUserId}
                onChange={(e) => setForm({ ...form, managerUserId: e.target.value })}
              >
                <option value="">No manager</option>
                {(detail.managerCandidates ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.title ? ` · ${p.title}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="flex items-center gap-2 text-sm">
                <UserRound className="size-4 text-muted" />
                {employment.manager ? employment.manager.name : <span className="text-muted">No manager yet</span>}
              </p>
            )}
            <p className="hint">Hears when it stops, and decides what it may do alone.</p>
          </div>
          <div>
            <label className="label" htmlFor="employment-budget">
              Monthly budget (USD)
            </label>
            <div className="relative">
              <Wallet className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
              <input
                id="employment-budget"
                type="number"
                min={0}
                step="any"
                className="input pl-9"
                placeholder="No limit"
                disabled={!editable}
                value={form.budget}
                onChange={(e) => setForm({ ...form, budget: e.target.value })}
              />
            </div>
            <p className="hint">
              {formatMoney(employment.costThisMonthUsd)} used this month{budget !== null ? ` of ${formatMoney(budget)}` : ""}. At the limit it stops starting
              work and tells its manager.
            </p>
            {budget !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                <div
                  className={clsx("h-full rounded-full", used >= 100 ? "bg-red-500" : used >= 80 ? "bg-amber-500" : "bg-emerald-500")}
                  style={{ width: `${used}%` }}
                />
              </div>
            )}
            {employment.stoppedByBudget && <p className="mt-2 text-sm font-medium text-red-600 dark:text-red-400">Stopped: it reached this month's budget.</p>}
          </div>
        </div>

        <fieldset>
          <legend className="label">Probation level: what it does alone</legend>
          <div className="grid gap-2 md:grid-cols-3">
            {(Object.keys(PROBATION) as Probation[]).map((level) => {
              const selected = form.probation === level;
              return (
                <label
                  key={level}
                  className={clsx(
                    "flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors",
                    selected ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500 dark:bg-brand-500/10" : "border-line hover:border-brand-300",
                    !editable && "cursor-default opacity-90",
                  )}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    <input
                      type="radio"
                      name="probation"
                      className="accent-brand-600"
                      checked={selected}
                      disabled={!editable}
                      onChange={() => setForm({ ...form, probation: level })}
                    />
                    {PROBATION[level].label}
                    {employment.probation === level && (
                      <Badge size="xs" tone="brand">
                        Now
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted">Alone: {PROBATION[level].alone}</span>
                  <span className="text-xs text-muted">Asks a person: {PROBATION[level].person}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {form.probation === "trusted" && (
          <fieldset className="rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-semibold">Limits: above these it asks a person</legend>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="label" htmlFor="limit-amount">
                  Largest amount alone
                </label>
                <input
                  id="limit-amount"
                  type="number"
                  min={0}
                  step="any"
                  className="input"
                  placeholder="No limit"
                  disabled={!editable}
                  value={form.maxAmount}
                  onChange={(e) => setForm({ ...form, maxAmount: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="limit-currency">
                  Currency
                </label>
                <input
                  id="limit-currency"
                  maxLength={3}
                  className="input uppercase"
                  placeholder="TRY"
                  disabled={!editable}
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="limit-day">
                  Changes a day alone
                </label>
                <input
                  id="limit-day"
                  type="number"
                  min={1}
                  step={1}
                  className="input"
                  placeholder="No limit"
                  disabled={!editable}
                  value={form.maxActionsPerDay}
                  onChange={(e) => setForm({ ...form, maxActionsPerDay: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="limit-domains">
                  Emails alone only to
                </label>
                <input
                  id="limit-domains"
                  className="input"
                  placeholder="Anyone"
                  disabled={!editable}
                  value={form.mailDomains}
                  onChange={(e) => setForm({ ...form, mailDomains: e.target.value })}
                />
              </div>
            </div>
            <p className="hint mt-3">
              An amount in another currency also goes to a person. Today it made {employment.changesToday} change{employment.changesToday === 1 ? "" : "s"}{" "}
              alone.
            </p>
          </fieldset>
        )}

        <div>
          <p className="label">Duties: what it does on its own</p>
          {employment.duties.length ? (
            <ul className="space-y-1.5">
              {employment.duties.map((duty, i) => {
                const Icon = DUTY_ICONS[duty.kind] ?? BriefcaseBusiness;
                return (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <Icon className="size-4 shrink-0 text-muted" />
                    {duty.text}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">None: it works when people give it work.</p>
          )}
          {detail.agent.status !== "active" && employment.duties.length > 0 && (
            <p className="hint text-amber-700 dark:text-amber-300">Its duties run only while it is active.</p>
          )}
        </div>

        {editable && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={!changed}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
