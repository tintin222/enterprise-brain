import { Bell, Clock, Hand, Inbox, Lock, MessageSquare, MousePointerClick, Plug, ShieldCheck, Webhook, Workflow, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/Badge.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { FieldForm } from "../../components/FieldForm.tsx";
import { JsonDetails } from "../../components/JsonView.tsx";
import { archetypeIcon, stepIcon } from "../../lib/icons.tsx";
import {
  approvalRuleLabel,
  archetypeLabel,
  categoryLabel,
  describeStep,
  describeTrigger,
  PERSONAL_DATA_LABELS,
  plainTemplate,
  STEP_TYPE_LABELS,
} from "../../lib/labels.ts";
import { humanize } from "../../lib/format.ts";
import { useDepartmentName } from "../../lib/queries.ts";
import type { AgentDefinition, FieldSpec, TriggerSpec } from "../../types.ts";

const TRIGGER_ICONS: Record<TriggerSpec["type"], LucideIcon> = {
  manual: MousePointerClick,
  form: MousePointerClick,
  mailbox: Inbox,
  schedule: Clock,
  webhook: Webhook,
  chat: MessageSquare,
  paperclip: Workflow,
  "connector-event": Bell,
};

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
        {count !== undefined && <span className="rounded-full bg-subtle px-1.5 text-[10px] leading-4 text-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const TYPE_LABELS: Partial<Record<FieldSpec["type"], string>> = {
  string: "text",
  text: "long text",
  file: "file",
  files: "files",
  select: "choice",
  multiselect: "choices",
  list: "list",
  object: "record",
  boolean: "yes/no",
};

function FieldList({ fields }: { fields: FieldSpec[] }) {
  if (!fields.length) return <p className="text-sm text-faint">None</p>;
  return (
    <ul className="space-y-1.5">
      {fields.map((f) => (
        <li key={f.key} className="flex items-start justify-between gap-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium text-fg">{f.label ?? humanize(f.key)}</span>
            {f.required && <span className="ml-0.5 text-red-500">*</span>}
            {f.description && <span className="block text-xs text-muted">{f.description}</span>}
          </span>
          <Badge size="xs" className="shrink-0">
            {TYPE_LABELS[f.type] ?? f.type}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Plain-language view of an agent definition (draft or live). */
export function Blueprint({ definition, showPreview = true }: { definition: AgentDefinition; showPreview?: boolean }) {
  const Icon = archetypeIcon(definition.archetype);
  const departmentName = useDepartmentName();
  const steps = definition.workflow.filter((s) => s.type !== "output");
  const guard = definition.guardrails;
  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">{definition.name}</h2>
          <p className="text-sm text-muted">{definition.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="brand">{archetypeLabel(definition.archetype)}</Badge>
            {definition.templateId && <Badge>Template: {definition.templateId}</Badge>}
            {definition.department && <Badge>{departmentName(definition.department)}</Badge>}
          </div>
        </div>
      </div>

      <Section title="Starts when">
        <ul className="space-y-1.5">
          {definition.triggers.map((t, i) => {
            const TIcon = TRIGGER_ICONS[t.type] ?? Hand;
            return (
              <li key={i} className="flex items-center gap-2 text-sm text-fg">
                <TIcon className="size-4 shrink-0 text-muted" />
                {describeTrigger(t)}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="What it receives" count={definition.inputs.length}>
        <FieldList fields={definition.inputs} />
      </Section>

      <Section title="What it does" count={steps.length}>
        {steps.length ? (
          <ol className="space-y-2">
            {steps.map((step, i) => {
              const SIcon = stepIcon(step.type);
              return (
                <li key={step.id} className="flex gap-3">
                  <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted ring-1 ring-line">
                    <SIcon className="size-3.5" />
                    <span className="absolute -top-1.5 -left-1.5 flex size-4 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">
                      {i + 1}
                    </span>
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm text-fg">{step.name ? plainTemplate(step.name) : describeStep(step)}</p>
                    <p className="text-xs text-muted">
                      {STEP_TYPE_LABELS[step.type]}
                      {step.name && step.name !== describeStep(step) ? ` · ${describeStep(step)}` : ""}
                    </p>
                    {step.when && (
                      <p className="mt-0.5 text-xs text-faint">
                        only when <code className="rounded bg-subtle px-1 font-mono text-[11px]">{step.when}</code>
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted">Works as an assistant with tools: {definition.tools.join(", ") || "none"}.</p>
        )}
      </Section>

      <Section title="What it produces" count={definition.outputs.length}>
        <FieldList fields={definition.outputs} />
      </Section>

      <Section title="Systems" count={definition.connectors.length}>
        {definition.connectors.length ? (
          <ul className="space-y-1.5">
            {definition.connectors.map((c) => (
              <li key={c.ref} className="flex items-start gap-2 text-sm">
                <Plug className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="font-medium text-fg">{categoryLabel(c.category)}</span>
                  <span className="text-muted"> ({c.ref})</span>
                  {c.purpose && <span className="block text-xs text-muted">{c.purpose}</span>}
                  {!c.instanceId && <span className="block text-xs text-amber-700 dark:text-amber-300">Demo data until IT connects the real system</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No business systems — works on uploads and the knowledge base.</p>
        )}
      </Section>

      <Section title="Human approval for">
        {guard.approvalRequiredFor.length ? (
          <div className="flex flex-wrap gap-1.5">
            {guard.approvalRequiredFor.map((r) => (
              <Badge key={r} tone="amber" icon={ShieldCheck}>
                {approvalRuleLabel(r)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Nothing — fully automatic.</p>
        )}
      </Section>

      <Section title="Privacy">
        <div className="space-y-1.5 text-sm">
          <p className="flex items-center gap-2 text-fg">
            <Lock className="size-4 text-muted" />
            {PERSONAL_DATA_LABELS[guard.personalData] ?? guard.personalData}
            {guard.retentionDays ? <span className="text-muted">· kept {guard.retentionDays} days</span> : null}
          </p>
          {guard.notes?.map((n, i) => (
            <p key={i} className="text-xs text-muted">
              • {n}
            </p>
          ))}
        </div>
      </Section>

      {showPreview && definition.ui.layout !== "none" && (
        <Section title="Form preview">
          <div className="overflow-hidden rounded-xl border border-line shadow-xs">
            <div className="flex items-center gap-1.5 border-b border-line bg-subtle/70 px-3 py-2">
              <span className="size-2.5 rounded-full bg-red-400/70" />
              <span className="size-2.5 rounded-full bg-amber-400/70" />
              <span className="size-2.5 rounded-full bg-emerald-400/70" />
              <span className="ml-2 truncate text-xs text-muted">/apps/{definition.slug}</span>
            </div>
            <div className="bg-surface p-4">
              <p className="text-sm font-semibold text-fg">{definition.ui.title ?? definition.name}</p>
              {definition.ui.description && <p className="mb-3 text-xs text-muted">{definition.ui.description}</p>}
              {definition.ui.layout === "chat" ? (
                <div className="mt-3 rounded-lg border border-dashed border-line-strong p-4 text-center text-sm text-muted">
                  A chat screen where your team talks to the AI employee.
                </div>
              ) : definition.ui.layout === "inbox" ? (
                <div className="mt-3 rounded-lg border border-dashed border-line-strong p-4 text-center text-sm text-muted">
                  An inbox of processed emails with the AI employee's results.
                </div>
              ) : (
                <div className="mt-3 space-y-4">
                  <FieldForm fields={definition.inputs} values={{}} onChange={() => undefined} disabled />
                  <button type="button" disabled className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white opacity-60">
                    {definition.ui.submitLabel ?? "Run"}
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">This is the screen your team will use.</p>
        </Section>
      )}

      <JsonDetails data={definition} label="Technical definition" expandDepth={1} />
    </div>
  );
}

export function BlueprintPanel({ draft }: { draft?: AgentDefinition }) {
  if (!draft) {
    return (
      <EmptyState
        compact
        icon={Workflow}
        title="The blueprint appears as you answer"
        description="Each answer updates the live design of your agent: inputs, steps, outputs, systems and approvals."
      />
    );
  }
  return <Blueprint definition={draft} />;
}
