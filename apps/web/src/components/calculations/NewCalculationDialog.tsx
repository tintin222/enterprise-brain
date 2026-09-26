import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Calculator, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { keys, useTables } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { CalculationProposal, CalculationSchedule, CalculationView } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Chip, Field } from "../Form.tsx";
import { Callout, ErrorState } from "../Spinner.tsx";
import { useTableDepartments } from "../tables/NewTableDialog.tsx";
import { ResultView } from "./ResultView.tsx";

const EXAMPLES = ["Rank suppliers by complaints per 100 deliveries last month", "Total refund by customer this year", "How many complaints are open"];

export const SCHEDULES: { value: CalculationSchedule | ""; label: string }[] = [
  { value: "", label: "When someone runs it" },
  { value: "daily", label: "Every day at 07:00" },
  { value: "weekly", label: "Every Monday at 07:00" },
  { value: "monthly", label: "On the 1st of every month at 07:00" },
];

/** Say the rule; the Studio writes it, tries it on the real rows and shows the result; keep it. */
export function NewCalculationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tables = useTables();
  const { departments, companyWide } = useTableDepartments();
  const [rule, setRule] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [proposal, setProposal] = useState<CalculationProposal | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState<CalculationSchedule | "">("");
  const [departmentId, setDepartmentId] = useState("");
  useEffect(() => {
    if (!open) return;
    setRule("");
    setChosen([]);
    setProposal(null);
  }, [open]);
  useEffect(() => {
    if (!departmentId && departments[0]) setDepartmentId(departments[0].id);
  }, [departmentId, departments]);

  const write = useMutation({
    mutationFn: () => api.post<CalculationProposal>(path("/calculations/write"), { rule, ...(chosen.length ? { tables: chosen } : {}) }),
    onSuccess: (result) => {
      setProposal(result);
      setName(result.draft.name);
      if (/month/i.test(rule)) setSchedule("monthly");
    },
  });
  const keep = useMutation({
    mutationFn: () =>
      api.post<CalculationView>(path("/calculations"), { ...proposal!.draft, name, rule, schedule: schedule || null, departmentId: departmentId || null }),
    onSuccess: async (calculation) => {
      toast.success(`${calculation.name} is kept`);
      await queryClient.invalidateQueries({ queryKey: keys.calculations(company) });
      onClose();
      navigate(`/calculations/${calculation.key}`);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="A new calculation"
      description="Say the rule in your words. The Studio works it out on your tables' real rows and shows you the result; the code stays out of sight."
      footer={
        proposal ? (
          <>
            <Button onClick={() => setProposal(null)}>Back</Button>
            <Button variant="primary" icon={Save} loading={keep.isPending} disabled={!proposal.trial.ok || !name.trim()} onClick={() => keep.mutate()}>
              Keep it
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={Sparkles} loading={write.isPending} disabled={rule.trim().length < 3} onClick={() => write.mutate()}>
              Work it out
            </Button>
          </>
        )
      }
    >
      {!proposal ? (
        <div className="space-y-4">
          <Field label="The rule" hint="What to count, add up or rank, by what, over which period.">
            {(id) => (
              <textarea id={id} data-autofocus className="input min-h-24" placeholder={EXAMPLES[0]} value={rule} onChange={(e) => setRule(e.target.value)} />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setRule(example)}
                className="rounded-full border border-line px-3 py-1 text-left text-xs text-muted hover:border-brand-400 hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>
          <div>
            <p className="label">On which tables</p>
            <div className="flex flex-wrap gap-2">
              {(tables.data ?? []).map((t) => (
                <Chip
                  key={t.key}
                  role="checkbox"
                  selected={chosen.includes(t.key)}
                  onClick={() => setChosen((c) => (c.includes(t.key) ? c.filter((k) => k !== t.key) : [...c, t.key]))}
                >
                  {t.name}
                </Chip>
              ))}
            </div>
            <p className="hint">None chosen: the Studio picks from all the tables you see.</p>
          </div>
          {write.error && <ErrorState error={write.error} title="It couldn't be worked out" />}
        </div>
      ) : (
        <div className="space-y-5">
          <Callout
            tone={proposal.trial.ok ? "brand" : "danger"}
            icon={proposal.trial.ok ? Calculator : undefined}
            title={proposal.trial.ok ? "How it works" : "It didn't work on your rows"}
          >
            <p>{proposal.trial.ok ? proposal.draft.explanation : proposal.trial.error}</p>
            {proposal.notes.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">
                {proposal.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </Callout>
          {proposal.trial.ok && (
            <div>
              <p className="label">The result on today's rows</p>
              <div className="rounded-xl border border-line p-3">
                <ResultView output={proposal.draft.output} result={proposal.trial.result} compact />
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="It runs">
              {(id) => (
                <select id={id} className="input" value={schedule} onChange={(e) => setSchedule(e.target.value as CalculationSchedule | "")}>
                  {SCHEDULES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Whose is it?">
              {(id) => (
                <select id={id} className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                  {companyWide && <option value="">The whole company</option>}
                </select>
              )}
            </Field>
          </div>
          {keep.error && <ErrorState error={keep.error} title="Not kept" />}
        </div>
      )}
    </Dialog>
  );
}
