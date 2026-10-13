import { useState, type FormEvent } from "react";
import type { WorkflowStep } from "../types.ts";
import { Button } from "./Button.tsx";

/** One setting of a step a manager may change in the flow. */
interface Setting {
  key: string;
  label: string;
  kind: "text" | "long" | "number" | "json" | "code" | "select" | "check";
  options?: [string, string][];
  hint?: string;
}

const COMMON: Setting[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "when", label: "Only when", kind: "text", hint: "A condition, e.g. steps.check.total > 1000; empty: always" },
  {
    key: "onError",
    label: "When it fails",
    kind: "select",
    options: [
      ["fail", "Stop the work"],
      ["continue", "Keep the error and go on"],
      ["skip", "Leave out the steps after it"],
    ],
  },
  { key: "retryTimes", label: "Tries again (times)", kind: "number", hint: "0 to 5" },
  { key: "retryWait", label: "Waits before trying again (seconds)", kind: "number" },
  { key: "timeoutSeconds", label: "Stops after (seconds)", kind: "number", hint: "Empty: no limit" },
];

const BY_TYPE: Partial<Record<WorkflowStep["type"], Setting[]>> = {
  extract: [
    { key: "from", label: "The file", kind: "text" },
    {
      key: "ocr",
      label: "Text recognition",
      kind: "select",
      options: [
        ["auto", "When needed"],
        ["always", "Always"],
        ["never", "Never"],
      ],
    },
  ],
  "llm.extract": [
    { key: "from", label: "What it reads", kind: "text" },
    { key: "instructions", label: "Instructions", kind: "long" },
  ],
  "llm.classify": [
    { key: "from", label: "What it reads", kind: "text" },
    { key: "instructions", label: "Instructions", kind: "long" },
  ],
  "llm.evaluate": [
    { key: "from", label: "What it judges", kind: "text" },
    { key: "context", label: "Against", kind: "long" },
    { key: "passScore", label: "Pass score (0 to 100)", kind: "number" },
    { key: "instructions", label: "Instructions", kind: "long" },
  ],
  "llm.generate": [
    { key: "prompt", label: "What to write", kind: "long" },
    { key: "fallback", label: "Without the model, it writes", kind: "long" },
  ],
  "knowledge.search": [
    { key: "query", label: "What to look up", kind: "long" },
    { key: "topK", label: "How many results", kind: "number" },
  ],
  connector: [
    { key: "input", label: "What it sends", kind: "json" },
    { key: "requiresApproval", label: "A person approves it first", kind: "check" },
  ],
  approval: [
    { key: "title", label: "The question", kind: "text" },
    { key: "details", label: "Details", kind: "long" },
    { key: "reason", label: "Why a person is asked", kind: "long" },
    { key: "assigneeRole", label: "Who decides", kind: "text" },
  ],
  "mail.send": [
    { key: "to", label: "To", kind: "text" },
    { key: "subject", label: "Subject", kind: "text" },
    { key: "body", label: "Text", kind: "long" },
    { key: "requiresApproval", label: "A person approves it first", kind: "check" },
  ],
  "excel.read": [
    { key: "from", label: "The file", kind: "text" },
    { key: "sheet", label: "Sheet", kind: "text" },
  ],
  "excel.write": [
    { key: "data", label: "The rows", kind: "text" },
    { key: "fileName", label: "File name", kind: "text" },
  ],
  agent: [
    { key: "task", label: "What it works out", kind: "long" },
    { key: "maxTurns", label: "At most this many turns", kind: "number" },
  ],
  wait: [
    {
      key: "for",
      label: "Waits for",
      kind: "select",
      options: [
        ["reply", "A reply to its emails"],
        ["time", "A time"],
        ["callback", "A call from another system"],
      ],
    },
    { key: "days", label: "Days (at most)", kind: "number" },
    { key: "until", label: "Until (a date)", kind: "text" },
  ],
  output: [{ key: "value", label: "The result", kind: "json" }],
  transform: [
    { key: "from", label: "The list", kind: "text" },
    { key: "ops", label: "What it does with it", kind: "json" },
  ],
  code: [
    { key: "code", label: "Program (JavaScript, returns the result)", kind: "code" },
    { key: "input", label: "Values it gets (ctx.values)", kind: "json" },
  ],
  call: [
    { key: "colleague", label: "Colleague", kind: "text" },
    { key: "request", label: "What it asks", kind: "long" },
    { key: "input", label: "Values it gives", kind: "json" },
    { key: "days", label: "Waits at most (days)", kind: "number" },
  ],
  "chat.send": [
    { key: "to", label: "To", kind: "text", hint: 'A channel ("#finance"), a person\'s email, or "task"' },
    { key: "text", label: "Message", kind: "long" },
    {
      key: "via",
      label: "In",
      kind: "select",
      options: [
        ["chat", "Chat"],
        ["teams", "Microsoft Teams"],
        ["google-chat", "Google Chat"],
      ],
    },
    { key: "requiresApproval", label: "A person approves it first", kind: "check" },
  ],
  respond: [
    { key: "status", label: "Status", kind: "number" },
    { key: "headers", label: "Headers", kind: "json" },
    { key: "body", label: "Body", kind: "json" },
  ],
  each: [
    { key: "over", label: "The list", kind: "text" },
    { key: "as", label: "Each one is called", kind: "text" },
    { key: "batchSize", label: "In batches of", kind: "number" },
    { key: "maxItems", label: "At most (items)", kind: "number" },
    {
      key: "onItemError",
      label: "When a round fails",
      kind: "select",
      options: [
        ["fail", "Stop the work"],
        ["continue", "Keep its error"],
        ["skip", "Leave it out"],
      ],
    },
    { key: "collect", label: "What each round adds", kind: "json" },
  ],
};

/** The settings of a step: the common ones, its kind's, and a decision's case conditions. */
function settingsOf(step: WorkflowStep): Setting[] {
  const cases: Setting[] =
    step.type === "branch" ? step.cases.map((c, i) => ({ key: `case_${i}`, label: `Case ${c.id ?? i + 1}: when`, kind: "text" as const })) : [];
  return [...COMMON, ...cases, ...(BY_TYPE[step.type] ?? [])];
}

type Draft = Record<string, string>;

function toText(value: unknown, kind: Setting["kind"]): string {
  if (value === undefined || value === null) return kind === "check" ? "false" : "";
  if (kind === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

function draftOf(step: WorkflowStep): Draft {
  const record = step as unknown as Record<string, unknown>;
  const draft: Draft = {};
  for (const setting of settingsOf(step)) {
    if (setting.key === "retryTimes") draft.retryTimes = step.retry ? String(step.retry.times) : "0";
    else if (setting.key === "retryWait") draft.retryWait = step.retry?.waitSeconds !== undefined ? String(step.retry.waitSeconds) : "";
    else if (setting.key === "onError") draft.onError = step.onError ?? "fail";
    else if (setting.key.startsWith("case_") && step.type === "branch") draft[setting.key] = step.cases[Number(setting.key.slice(5))]?.when ?? "";
    else draft[setting.key] = toText(record[setting.key], setting.kind);
  }
  return draft;
}

/** The step as the draft says, or what is wrong with the draft. */
export function stepFromDraft(step: WorkflowStep, draft: Draft): { step: WorkflowStep; problems: string[] } {
  const problems: string[] = [];
  const next: Record<string, unknown> = { ...(step as unknown as Record<string, unknown>) };
  for (const setting of settingsOf(step)) {
    const raw = draft[setting.key] ?? "";
    if (["retryTimes", "retryWait", "onError"].includes(setting.key) || setting.key.startsWith("case_")) continue;
    if (setting.kind === "check") {
      if (raw === "true") next[setting.key] = true;
      else delete next[setting.key];
    } else if (setting.kind === "number") {
      if (raw.trim() === "") delete next[setting.key];
      else if (!Number.isFinite(Number(raw))) problems.push(`${setting.label}: a number`);
      else next[setting.key] = Number(raw);
    } else if (setting.kind === "json") {
      if (raw.trim() === "") delete next[setting.key];
      else {
        try {
          next[setting.key] = JSON.parse(raw);
        } catch {
          problems.push(`${setting.label}: not valid JSON`);
        }
      }
    } else if (raw.trim() === "" && setting.key !== "name") delete next[setting.key];
    else next[setting.key] = raw;
  }
  if (!String(next.name ?? "").trim()) delete next.name;
  // The error policy, and retries.
  if (draft.onError && draft.onError !== "fail") next.onError = draft.onError;
  else delete next.onError;
  const times = Number(draft.retryTimes || 0);
  if (!Number.isInteger(times) || times < 0 || times > 5) problems.push("Tries again: 0 to 5 times");
  else if (times > 0) next.retry = { times, ...(draft.retryWait?.trim() ? { waitSeconds: Number(draft.retryWait) } : {}) };
  else delete next.retry;
  if (step.type === "branch") {
    next.cases = step.cases.map((c, i) => ({ ...c, when: draft[`case_${i}`]?.trim() || c.when }));
  }
  return { step: next as unknown as WorkflowStep, problems };
}

/**
 * A step's settings, for a manager: its name, condition, error policy, retries and time limit, and what
 * its kind takes (an email's text, a wait's days, a loop's list). Saving checks the whole job first.
 */
export function StepSettingsForm({
  step,
  saving,
  problems,
  onSave,
}: {
  step: WorkflowStep;
  saving: boolean;
  /** What the check found wrong, or the draft's own problems. */
  problems: string[];
  onSave: (step: WorkflowStep) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(step));
  const [local, setLocal] = useState<string[]>([]);
  const settings = settingsOf(step);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = stepFromDraft(step, draft);
    setLocal(built.problems);
    if (!built.problems.length) onSave(built.step);
  };
  const shown = [...local, ...problems];
  return (
    <form onSubmit={submit} className="space-y-4">
      {settings.map((setting) => {
        const id = `step-${step.id}-${setting.key}`;
        const value = draft[setting.key] ?? "";
        const set = (next: string) => setDraft((prev) => ({ ...prev, [setting.key]: next }));
        if (setting.kind === "check") {
          return (
            <label key={setting.key} className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={value === "true"} onChange={(e) => set(e.target.checked ? "true" : "false")} />
              {setting.label}
            </label>
          );
        }
        return (
          <div key={setting.key}>
            <label htmlFor={id} className="label">
              {setting.label}
            </label>
            {setting.kind === "select" ? (
              <select id={id} className="input" value={value} onChange={(e) => set(e.target.value)}>
                {setting.options!.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            ) : setting.kind === "long" || setting.kind === "json" || setting.kind === "code" ? (
              <textarea
                id={id}
                rows={setting.kind === "long" ? 4 : 6}
                spellCheck={setting.kind === "long"}
                className={setting.kind === "long" ? "input" : "input font-mono text-xs"}
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            ) : (
              <input
                id={id}
                className="input"
                inputMode={setting.kind === "number" ? "decimal" : undefined}
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            )}
            {setting.hint && <p className="hint mt-1">{setting.hint}</p>}
          </div>
        );
      })}
      {shown.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-400/10 dark:text-red-200">
          {shown.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={saving}>
          Save as a new version
        </Button>
      </div>
    </form>
  );
}
