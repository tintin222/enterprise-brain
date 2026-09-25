import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { humanize } from "../lib/format.ts";
import { stepIcon } from "../lib/icons.tsx";
import { describeStep, plainTemplate, STEP_TYPE_LABELS } from "../lib/labels.ts";
import type { Criterion, WorkflowStep } from "../types.ts";
import { Badge, type Tone } from "./Badge.tsx";

const KIND_TONE: Record<Criterion["kind"], Tone> = { must: "brand", nice: "neutral", knockout: "red" };
const KIND_LABEL: Record<Criterion["kind"], string> = { must: "Must-have", nice: "Nice-to-have", knockout: "Deal-breaker" };

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-subtle/60 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-xs text-muted">
      <span className="font-medium text-fg/80">{label}:</span> {children}
    </p>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-subtle px-1 py-px font-mono text-[11px] text-fg">{children}</code>;
}

function StepConfig({ step }: { step: WorkflowStep }) {
  switch (step.type) {
    case "extract":
      return (
        <Meta label="From">
          <Code>{step.from}</Code> {step.ocr ? `· OCR ${step.ocr}` : ""}
        </Meta>
      );
    case "llm.extract":
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {step.fields.map((f) => (
              <Badge key={f.key} size="xs" tone={f.required ? "brand" : "neutral"}>
                {f.label ?? humanize(f.key)}
              </Badge>
            ))}
          </div>
          {step.instructions && (
            <Collapsible label="Instructions">
              <Pre>{step.instructions}</Pre>
            </Collapsible>
          )}
        </div>
      );
    case "llm.classify":
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {step.categories.map((c) => (
              <Badge key={c.value} size="xs" tone="violet" title={c.description}>
                {c.label ?? c.value}
              </Badge>
            ))}
          </div>
          {step.multi && <p className="text-xs text-muted">Can pick several categories.</p>}
        </div>
      );
    case "llm.evaluate":
      return (
        <div className="space-y-1.5">
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left text-xs">
              <thead className="bg-subtle/60 text-muted">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Criterion</th>
                  <th className="px-2.5 py-1.5 font-medium">Kind</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Weight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {step.criteria.map((c) => (
                  <tr key={c.id}>
                    <td className="px-2.5 py-1.5 text-fg">
                      {c.label}
                      {c.description && <span className="block text-muted">{c.description}</span>}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Badge size="xs" tone={KIND_TONE[c.kind]}>
                        {KIND_LABEL[c.kind]}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{c.weight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {step.passScore !== undefined && <Meta label="Pass score">{step.passScore} / 100</Meta>}
        </div>
      );
    case "llm.generate":
      return (
        <Collapsible label="Prompt">
          <Pre>{step.prompt}</Pre>
        </Collapsible>
      );
    case "knowledge.search":
      return (
        <div className="space-y-0.5">
          <Meta label="Query">
            <Code>{step.query}</Code>
          </Meta>
          {step.collections?.length ? <Meta label="Collections">{step.collections.join(", ")}</Meta> : null}
        </div>
      );
    case "connector":
      return (
        <div className="space-y-0.5">
          <Meta label="Operation">
            <Code>
              {step.connector}.{step.operation}
            </Code>
            {step.requiresApproval ? " · needs approval" : ""}
          </Meta>
          {Object.keys(step.input ?? {}).length > 0 && (
            <Collapsible label="Input mapping">
              <Pre>{JSON.stringify(step.input, null, 2)}</Pre>
            </Collapsible>
          )}
        </div>
      );
    case "approval":
      return (
        <div className="space-y-0.5">
          {step.assigneeRole && <Meta label="Approver">{humanize(step.assigneeRole)}</Meta>}
          {step.details && <p className="text-xs text-muted">{step.details}</p>}
        </div>
      );
    case "mail.send":
      return (
        <div className="space-y-0.5">
          <Meta label="To">
            <Code>{step.to}</Code>
          </Meta>
          <Meta label="Subject">
            <Code>{step.subject}</Code>
          </Meta>
        </div>
      );
    case "excel.read":
      return (
        <Meta label="From">
          <Code>{step.from}</Code>
          {step.sheet ? ` · sheet ${step.sheet}` : ""}
        </Meta>
      );
    case "excel.write":
      return (
        <Meta label="Data">
          <Code>{step.data}</Code>
          {step.fileName ? ` → ${step.fileName}` : ""}
        </Meta>
      );
    case "wait":
      return (
        <Meta label={step.for === "reply" ? "Waits for" : "Waits"}>
          {step.for === "reply" ? "a reply to the task's emails" : step.until ? <Code>{step.until}</Code> : "the set time"}
          {step.days ? ` · at most ${step.days} day${step.days === 1 ? "" : "s"}` : ""}
        </Meta>
      );
    case "agent":
      return (
        <div className="space-y-1.5">
          {step.tools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {step.tools.map((t) => (
                <Badge key={t} size="xs">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          <Collapsible label="Task">
            <Pre>{step.task}</Pre>
          </Collapsible>
        </div>
      );
    case "output":
      return (
        <div className="flex flex-wrap gap-1">
          {Object.keys(step.value ?? {}).map((k) => (
            <Badge key={k} size="xs" tone="green">
              {humanize(k)}
            </Badge>
          ))}
        </div>
      );
  }
}

/** Vertical list of workflow steps with type icons, conditions and key configuration. */
export function WorkflowView({ steps }: { steps: WorkflowStep[] }) {
  if (!steps.length) return <p className="text-sm text-muted">No fixed workflow: the agent works as an autonomous assistant with its tools.</p>;
  return (
    <ol className="relative space-y-0">
      {steps.map((step, i) => {
        const Icon = stepIcon(step.type);
        const last = i === steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-4 pb-6">
            {!last && <span className="absolute top-10 bottom-0 left-[19px] w-px bg-line" aria-hidden="true" />}
            <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-brand-600 ring-1 ring-line dark:text-brand-300">
              <Icon className="size-[18px]" />
              <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white ring-2 ring-surface">
                {i + 1}
              </span>
            </span>
            <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-fg">{step.name ? plainTemplate(step.name) : describeStep(step)}</p>
                <Badge size="xs">{STEP_TYPE_LABELS[step.type] ?? step.type}</Badge>
                {step.onError === "continue" && (
                  <Badge size="xs" tone="amber">
                    continues on error
                  </Badge>
                )}
              </div>
              {step.name && <p className="text-xs text-muted">{describeStep(step)}</p>}
              {step.when && (
                <p className="text-xs text-muted">
                  Only when <Code>{step.when}</Code>
                </p>
              )}
              <StepConfig step={step} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
