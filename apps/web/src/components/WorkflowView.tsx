import { clsx } from "clsx";
import { ChevronDown, ChevronRight, CornerDownRight, GitBranch, Repeat } from "lucide-react";
import { useState, type ReactNode } from "react";
import { humanize } from "../lib/format.ts";
import { stepIcon } from "../lib/icons.tsx";
import { describeStep, plainCondition, plainTemplate, STEP_TYPE_LABELS, TRANSFORM_OP_LABELS } from "../lib/labels.ts";
import type { Criterion, TransformOp, WorkflowStep } from "../types.ts";
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

/** A transform's operation in words. */
function opText(op: TransformOp): string {
  switch (op.op) {
    case "set":
      return `Set ${Object.keys(op.fields).join(", ")}`;
    case "filter":
      return `Keep those where ${plainCondition(op.where)}`;
    case "sort":
      return `Sort by ${op.by}${op.order === "desc" ? ", largest first" : ""}`;
    case "aggregate": {
      const values = Object.entries(op.values).map(([name, v]) => `${name} = ${v.fn}${v.field ? ` of ${v.field}` : ""}`);
      return `Total${op.groupBy?.length ? ` by ${op.groupBy.join(", ")}` : ""}: ${values.join(", ")}`;
    }
    case "dedupe":
      return `Drop repeats${op.by?.length ? ` (same ${op.by.join(", ")})` : ""}`;
    case "pick":
      return `Keep only ${op.fields.join(", ")}`;
    case "rename":
      return `Rename ${Object.entries(op.fields)
        .map(([from, to]) => `${from} → ${to}`)
        .join(", ")}`;
    case "limit":
      return `Keep ${op.count}${op.offset ? ` after the first ${op.offset}` : ""}`;
  }
}

/** A step's error policy and limits, as badges. */
function PolicyBadges({ step }: { step: WorkflowStep }) {
  return (
    <>
      {step.retry && (
        <Badge size="xs" tone="blue">
          tries {step.retry.times + 1} times
        </Badge>
      )}
      {step.timeoutSeconds && (
        <Badge size="xs" tone="blue">
          stops after {step.timeoutSeconds} s
        </Badge>
      )}
      {step.onError === "continue" && (
        <Badge size="xs" tone="amber">
          continues on error
        </Badge>
      )}
      {step.onError === "skip" && (
        <Badge size="xs" tone="amber">
          leaves out the rest on error
        </Badge>
      )}
    </>
  );
}

export function StepConfig({ step }: { step: WorkflowStep }) {
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
        <Meta label={step.for === "time" ? "Waits" : "Waits for"}>
          {step.for === "reply" ? (
            "a reply to the task's emails"
          ) : step.for === "callback" ? (
            "another system to call the address it gives (run.callbackUrl)"
          ) : step.until ? (
            <Code>{step.until}</Code>
          ) : (
            "the set time"
          )}
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
    case "transform":
      return (
        <div className="space-y-1">
          <Meta label="From">
            <Code>{step.from}</Code>
          </Meta>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted">
            {step.ops.map((op, i) => (
              <li key={i}>
                <span className="font-medium text-fg/80">{humanize(TRANSFORM_OP_LABELS[op.op])}:</span> {opText(op)}
              </li>
            ))}
          </ol>
        </div>
      );
    case "code":
      return (
        <div className="space-y-1">
          {step.input && Object.keys(step.input).length > 0 && <Meta label="Gets">{Object.keys(step.input).join(", ")}</Meta>}
          <Collapsible label="Program">
            <Pre>{step.code}</Pre>
          </Collapsible>
        </div>
      );
    case "call":
      return (
        <div className="space-y-0.5">
          <Meta label="Colleague">{step.colleague}</Meta>
          <Meta label="Request">
            <Code>{step.request}</Code>
          </Meta>
          <Meta label="Waits">
            at most {step.days ?? 3} day{(step.days ?? 3) === 1 ? "" : "s"} for its answer
          </Meta>
        </div>
      );
    case "chat.send":
      return (
        <div className="space-y-0.5">
          <Meta label="To">
            {step.to === "task" ? "the task's conversation" : <Code>{step.to}</Code>}
            {step.via && step.via !== "chat" ? ` · in ${step.via === "teams" ? "Microsoft Teams" : "Google Chat"}` : ""}
            {step.requiresApproval ? " · a person approves it first" : ""}
          </Meta>
          <Collapsible label="Message">
            <Pre>{step.text}</Pre>
          </Collapsible>
        </div>
      );
    case "respond":
      return (
        <div className="space-y-0.5">
          <Meta label="Answer">
            {step.status ?? 200}
            {step.headers && Object.keys(step.headers).length ? ` · headers ${Object.keys(step.headers).join(", ")}` : ""}
          </Meta>
          {step.body !== undefined && (
            <Collapsible label="Body">
              <Pre>{typeof step.body === "string" ? step.body : JSON.stringify(step.body, null, 2)}</Pre>
            </Collapsible>
          )}
        </div>
      );
    case "branch":
    case "each":
      return null;
  }
}

/** The steps a decision or a loop holds, framed under it. */
function Nested({ step }: { step: WorkflowStep }) {
  if (step.type === "branch") {
    return (
      <div className="space-y-2">
        {step.cases.map((c, i) => (
          <Frame key={c.id ?? i} icon={GitBranch} title={<>When {plainCondition(c.when)}</>} hint={c.when}>
            <StepList steps={c.steps} nested />
          </Frame>
        ))}
        {step.else?.length ? (
          <Frame icon={CornerDownRight} title="Otherwise">
            <StepList steps={step.else} nested />
          </Frame>
        ) : (
          <p className="text-xs text-muted">Otherwise nothing more happens here.</p>
        )}
      </div>
    );
  }
  if (step.type === "each") {
    const limits = [
      step.batchSize ? `in batches of ${step.batchSize}` : "",
      `at most ${step.maxItems ?? 200}`,
      step.onItemError === "continue" ? "a failed round is kept with its error" : step.onItemError === "skip" ? "a failed round is left out" : "",
    ].filter(Boolean);
    return (
      <Frame
        icon={Repeat}
        title={
          <>
            For each {step.as ?? "item"} of {plainTemplate(step.over)}
          </>
        }
        hint={limits.join(" · ")}
      >
        <StepList steps={step.steps} nested />
      </Frame>
    );
  }
  return null;
}

function Frame({ icon: Icon, title, hint, children }: { icon: typeof Repeat; title: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-subtle/30 p-3">
      <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-medium text-fg">
        <Icon className="size-3.5 text-muted" /> {title}
        {hint && <span className="font-normal text-muted">· {hint}</span>}
      </p>
      {children}
    </div>
  );
}

function StepList({ steps, nested }: { steps: WorkflowStep[]; nested?: boolean }) {
  return (
    <ol className="relative space-y-0">
      {steps.map((step, i) => {
        const Icon = stepIcon(step.type);
        const last = i === steps.length - 1;
        return (
          <li key={step.id} className={clsx("relative flex gap-4", last ? "pb-0" : nested ? "pb-4" : "pb-6")}>
            {!last && <span className={clsx("absolute bottom-0 w-px bg-line", nested ? "top-8 left-[15px]" : "top-10 left-[19px]")} aria-hidden="true" />}
            <span
              className={clsx(
                "relative flex shrink-0 items-center justify-center rounded-xl bg-surface text-brand-600 ring-1 ring-line dark:text-brand-300",
                nested ? "size-8" : "size-10",
              )}
            >
              <Icon className={nested ? "size-4" : "size-[18px]"} />
              {!nested && (
                <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white ring-2 ring-surface">
                  {i + 1}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-fg">{step.name ? plainTemplate(step.name) : describeStep(step)}</p>
                <Badge size="xs">{STEP_TYPE_LABELS[step.type] ?? step.type}</Badge>
                <PolicyBadges step={step} />
              </div>
              {step.name && <p className="text-xs text-muted">{describeStep(step)}</p>}
              {step.when && (
                <p className="text-xs text-muted">
                  Only when <Code>{step.when}</Code>
                </p>
              )}
              <StepConfig step={step} />
              <Nested step={step} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The steps of a job, top to bottom: type icons, conditions, settings, and the steps decisions and loops hold. */
export function WorkflowView({ steps }: { steps: WorkflowStep[] }) {
  if (!steps.length) return <p className="text-sm text-muted">No fixed workflow: the agent works as an autonomous assistant with its tools.</p>;
  return <StepList steps={steps} />;
}
