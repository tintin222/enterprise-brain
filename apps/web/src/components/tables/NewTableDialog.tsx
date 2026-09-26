import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { keys, useBuilding, useDepartments } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { TableProposal, TableView } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Field } from "../Form.tsx";
import { Callout, ErrorState } from "../Spinner.tsx";
import { designOf, draftOfDesign, TableDesigner, type DesignDraft } from "./TableDesigner.tsx";

const EXAMPLES = [
  "Supplier complaints: supplier, order number, problem, status (open, in progress, closed), owner, cost in TRY",
  "A log of training: employee, course, date, hours, passed?",
  "Visitors with name, company, host, arrival date and badge number",
];

/** The departments the viewer makes tables for: those they manage (every one, for admins). */
export function useTableDepartments() {
  const viewer = useViewer();
  const departments = useDepartments();
  const building = useBuilding();
  const isAdmin = !viewer || viewer.isAdmin;
  // As the rules for building say (IT sets them); until they are known, the departments they manage.
  const builds = new Set(building.data?.buildsFor ?? viewer?.departments.filter((d) => d.role === "manager").map((d) => d.id) ?? []);
  return {
    departments: (departments.data ?? []).filter((d) => isAdmin || builds.has(d.id)),
    companyWide: isAdmin,
  };
}

/** Say what to keep track of; the Studio proposes the table; shape it; make it. */
export function NewTableDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: string }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { departments, companyWide } = useTableDepartments();
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [proposal, setProposal] = useState<TableProposal | null>(null);
  const [draft, setDraft] = useState<DesignDraft | null>(null);
  useEffect(() => {
    if (!open) return;
    setDescription(initial ?? "");
    setProposal(null);
    setDraft(null);
    // Said in the one box: proposed at once.
    if (initial && initial.trim().length >= 3) propose.mutate(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!departmentId && departments[0]) setDepartmentId(departments[0].id);
  }, [departmentId, departments]);

  const propose = useMutation({
    mutationFn: (said?: string) => api.post<TableProposal>(path("/tables/propose"), { description: said ?? description }),
    onSuccess: (result) => {
      setProposal(result);
      setDraft(draftOfDesign(result.design, true));
    },
  });
  const make = useMutation({
    mutationFn: () => api.post<TableView>(path("/tables"), { ...designOf(draft!), departmentId: departmentId || null }),
    onSuccess: async (table) => {
      toast.success(`${table.name} is ready`);
      await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      onClose();
      navigate(`/tables/${table.key}`);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="A new table"
      description="Say what you want to keep track of. The Studio proposes the table; change anything before it's made."
      footer={
        draft ? (
          <>
            <Button onClick={() => (setProposal(null), setDraft(null))}>Back</Button>
            <Button
              variant="primary"
              icon={Table2}
              loading={make.isPending}
              disabled={!draft.name.trim() || !draft.fields.some((f) => f.label.trim())}
              onClick={() => make.mutate()}
            >
              Make the table
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={Sparkles} loading={propose.isPending} disabled={description.trim().length < 3} onClick={() => propose.mutate()}>
              Propose the table
            </Button>
          </>
        )
      }
    >
      {!draft ? (
        <div className="space-y-4">
          <Field label="What do you want to keep track of?" hint="Name the details each record holds, if you know them.">
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
          <Field label="Whose is it?" hint="Its department's people see it and add to it; you can share it with the whole company later.">
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
        <div className="space-y-4">
          {proposal?.notes.length ? (
            <Callout tone="brand" icon={Sparkles} title={proposal.drafted === "model" ? "What the Studio assumed" : "Read from your words"}>
              <ul className="list-disc space-y-0.5 pl-4">
                {proposal.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <TableDesigner draft={draft} onChange={setDraft} />
          {make.error && <ErrorState error={make.error} title="It can't be made yet" />}
        </div>
      )}
    </Dialog>
  );
}
