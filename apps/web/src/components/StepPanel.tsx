import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { stepIcon } from "../lib/icons.tsx";
import { describeStep, plainCondition, plainTemplate, STEP_TYPE_LABELS } from "../lib/labels.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDefinition, WorkflowStep } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Drawer } from "./Dialog.tsx";
import { StepSettingsForm } from "./StepSettingsForm.tsx";
import { StepConfig } from "./WorkflowView.tsx";

/** A step of a job by its id, wherever it is held. */
export function findStep(steps: readonly WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const inner =
      step.type === "branch"
        ? findStep([...step.cases.flatMap((c) => c.steps), ...(step.else ?? [])], id)
        : step.type === "each"
          ? findStep(step.steps, id)
          : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** The job's steps with one step replaced, wherever it is held. */
export function replaceStep(steps: readonly WorkflowStep[], id: string, next: WorkflowStep): WorkflowStep[] {
  return steps.map((step) => {
    if (step.id === id) return next;
    if (step.type === "branch") {
      return {
        ...step,
        cases: step.cases.map((c) => ({ ...c, steps: replaceStep(c.steps, id, next) })),
        ...(step.else ? { else: replaceStep(step.else, id, next) } : {}),
      };
    }
    if (step.type === "each") return { ...step, steps: replaceStep(step.steps, id, next) };
    return step;
  });
}

/**
 * One step of the flow, opened: what it does and its settings; its managers change them here. The whole
 * job is checked before it is saved as a new version (what its steps refer to must still be there).
 */
export function StepPanel({
  slug,
  definition,
  stepId,
  canEdit,
  onClose,
}: {
  slug: string;
  definition: AgentDefinition;
  stepId: string | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [problems, setProblems] = useState<string[]>([]);
  const step = stepId ? findStep(definition.workflow, stepId) : undefined;
  const save = useMutation({
    mutationFn: async (next: WorkflowStep) => {
      const candidate: AgentDefinition = { ...definition, workflow: replaceStep(definition.workflow, next.id, next) };
      const check = await api.post<{ ok: boolean; problems: string[] }>(path(`/agents/${encodeURIComponent(slug)}/check`), { definition: candidate });
      if (!check.ok) return { saved: false as const, problems: check.problems };
      await api.put(path(`/agents/${encodeURIComponent(slug)}`), {
        definition: candidate,
        note: `Changed step “${next.name ?? next.id}” in the flow`,
      });
      return { saved: true as const, problems: [] };
    },
    onSuccess: (result) => {
      setProblems(result.problems);
      if (!result.saved) return;
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success("Saved as a new version");
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  if (!step) return null;
  const Icon = stepIcon(step.type);
  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted" /> {step.name ? plainTemplate(step.name) : describeStep(step)}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Badge size="xs">{STEP_TYPE_LABELS[step.type] ?? step.type}</Badge>
          <span>{describeStep(step)}</span>
        </span>
      }
    >
      <div className="space-y-5 px-5 py-4">
        {step.when && <p className="text-sm text-muted">Only when {plainCondition(step.when)}</p>}
        <StepConfig step={step} />
        {canEdit ? (
          <div className="border-t border-line pt-4">
            <p className="mb-3 text-sm font-semibold text-fg">Change it</p>
            <StepSettingsForm key={step.id} step={step} saving={save.isPending} problems={problems} onSave={(next) => save.mutate(next)} />
          </div>
        ) : (
          <p className="text-xs text-muted">Its managers change its steps.</p>
        )}
      </div>
    </Drawer>
  );
}
