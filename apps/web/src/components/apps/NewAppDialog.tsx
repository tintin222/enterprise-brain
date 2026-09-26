import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AppProposal, AppView } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Field } from "../Form.tsx";
import { Callout, ErrorState } from "../Spinner.tsx";
import { useTableDepartments } from "../tables/NewTableDialog.tsx";
import { designOf, draftOfDesign, TableDesigner, type DesignDraft } from "../tables/TableDesigner.tsx";

const EXAMPLES = [
  "Supplier complaints: supplier, order number, problem, photo, owner, log a complaint, see the open ones by supplier, close them",
  "Visitors: name, company, host, arrival date, badge number, register a visitor, see today's visitors",
  "Maintenance requests: machine, problem, priority, reported by, report a fault, a board by status, an overview",
];

/** Say what the screens are for; the Studio proposes the app (and its table); make both. */
export function NewAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { departments, companyWide } = useTableDepartments();
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [proposal, setProposal] = useState<AppProposal | null>(null);
  const [tables, setTables] = useState<DesignDraft[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    setDescription("");
    setProposal(null);
  }, [open]);
  useEffect(() => {
    if (!departmentId && departments[0]) setDepartmentId(departments[0].id);
  }, [departmentId, departments]);

  const propose = useMutation({
    mutationFn: () => api.post<AppProposal>(path("/apps/propose"), { description }),
    onSuccess: (result) => {
      setProposal(result);
      setName(result.design.name);
      // Fields keep their keys while people rename them: the app's blocks point at them.
      setTables(result.tables.map((t) => draftOfDesign(t)));
    },
  });
  const make = useMutation({
    mutationFn: () =>
      api.post<AppView & { madeTables: string[] }>(path("/apps"), {
        ...proposal!.design,
        name,
        departmentId: departmentId || null,
        tables: proposal!.tables.map((t, i) => ({ ...t, ...designOf(tables[i]!), key: t.key })),
      }),
    onSuccess: async (app) => {
      toast.success(`${app.name} is ready${app.madeTables.length ? ", with its table" : ""}`);
      await queryClient.invalidateQueries({ queryKey: keys.apps(company) });
      await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      onClose();
      navigate(`/apps/${app.key}`);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="A new app"
      description="Say what the screens are for and what to keep. The Studio proposes the app, and its table when you don't have one yet."
      footer={
        proposal ? (
          <>
            <Button onClick={() => setProposal(null)}>Back</Button>
            <Button variant="primary" icon={LayoutGrid} loading={make.isPending} disabled={!name.trim()} onClick={() => make.mutate()}>
              Make the app
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={Sparkles} loading={propose.isPending} disabled={description.trim().length < 3} onClick={() => propose.mutate()}>
              Propose the app
            </Button>
          </>
        )
      }
    >
      {!proposal ? (
        <div className="space-y-4">
          <Field label="What do you need?" hint="What to keep track of, and what people do with it: log, see, close, count.">
            {(id) => (
              <textarea
                id={id}
                data-autofocus
                className="input min-h-28"
                placeholder={EXAMPLES[0]}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setDescription(example)}
                className="rounded-full border border-line px-3 py-1 text-left text-xs text-muted hover:border-brand-400 hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>
          <Field label="Whose is it?" hint="Its department's people use it; you can share it with the whole company later.">
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
          {propose.error && <ErrorState error={propose.error} />}
        </div>
      ) : (
        <div className="space-y-5">
          {proposal.notes.length > 0 && (
            <Callout tone="brand" icon={Sparkles} title={proposal.drafted === "model" ? "What the Studio assumed" : "Read from your words"}>
              <ul className="list-disc space-y-0.5 pl-4">
                {proposal.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Callout>
          )}
          <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <div>
            <p className="label">What it will have</p>
            <ol className="space-y-2">
              {proposal.outline.map((page) => (
                <li key={page.key} className="rounded-xl border border-line p-3">
                  <p className="text-sm font-semibold text-fg">{page.title}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
                    {page.blocks.map((block, i) => (
                      <li key={i}>{block}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
          {tables.map((draft, i) => (
            <div key={i} className="rounded-xl border border-line p-4">
              <p className="mb-3 text-sm font-semibold text-fg">The table it keeps</p>
              <TableDesigner draft={draft} onChange={(next) => setTables(tables.map((t, j) => (j === i ? next : t)))} tableKey={proposal.tables[i]!.key} />
            </div>
          ))}
          {make.error && <ErrorState error={make.error} title="It can't be made yet" />}
        </div>
      )}
    </Dialog>
  );
}
