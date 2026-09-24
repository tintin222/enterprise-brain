import { clsx } from "clsx";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { asArray, displayValue, humanize, isRecord, isUuid, truncate } from "../lib/format.ts";
import type { FieldSpec } from "../types.ts";
import { Badge, verdictTone, type Tone } from "./Badge.tsx";
import { FileLink } from "./FileLink.tsx";
import { JsonDetails } from "./JsonView.tsx";
import { Markdown } from "./Markdown.tsx";

// ---------------------------------------------------------------------------
// Score visuals
// ---------------------------------------------------------------------------

function scoreTone(score: number): { stroke: string; text: string; bar: string } {
  if (score >= 70) return { stroke: "stroke-emerald-500", text: "text-emerald-600 dark:text-emerald-300", bar: "bg-emerald-500" };
  if (score >= 50) return { stroke: "stroke-amber-500", text: "text-amber-600 dark:text-amber-300", bar: "bg-amber-500" };
  return { stroke: "stroke-red-500", text: "text-red-600 dark:text-red-300", bar: "bg-red-500" };
}

export function ScoreRing({ score, size = 88, label }: { score: number; size?: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, score));
  const r = 42;
  const c = 2 * Math.PI * r;
  const tone = scoreTone(clamped);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label ?? "Score"}: ${Math.round(clamped)} of 100`}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-slate-200 dark:stroke-slate-700" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          className={tone.stroke}
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx("font-semibold tabular-nums", tone.text, size >= 80 ? "text-2xl" : "text-base")}>{Math.round(clamped)}</span>
        {size >= 80 && <span className="text-[10px] font-medium tracking-wide text-faint uppercase">of 100</span>}
      </div>
    </div>
  );
}

export function ScoreBar({ score, className }: { score: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, score));
  const tone = scoreTone(clamped);
  return (
    <div className={clsx("flex items-center gap-2", className)}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={clsx("h-full rounded-full", tone.bar)} style={{ width: `${clamped}%` }} />
      </div>
      <span className={clsx("text-xs font-semibold tabular-nums", tone.text)}>{Math.round(clamped)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/** 0–100 score (or a 0–1 confidence shown as a percentage). */
function scoreValue(field: FieldSpec | undefined, key: string, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const name = `${key} ${field?.label ?? ""}`.toLowerCase();
  if (!/score|fit|confidence|match|rating|percent/.test(name)) return undefined;
  if (value >= 0 && value <= 1 && /confidence|percent/.test(name)) return value * 100;
  if (value >= 0 && value <= 100) return value;
  return undefined;
}

const POSITIVE_LIST = /strength|pros|highlight|match(ed)?_|positive|benefit/i;
const NEGATIVE_LIST = /gap|risk|concern|issue|con(s)?$|warning|flag|missing|red_?flag|problem|anomal/i;

function listTone(key: string): Tone {
  if (POSITIVE_LIST.test(key)) return "green";
  if (NEGATIVE_LIST.test(key)) return "amber";
  return "neutral";
}

function optionLabel(field: FieldSpec | undefined, value: unknown): string {
  const option = field?.options?.find((o) => o.value === value);
  return option?.label ?? humanize(String(value));
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*([-*]|\d+\.)\s|\*\*|__|`|^#{1,4}\s|\n\n|\[[^\]]+\]\(/.test(text);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function Chips({ items, tone, field }: { items: unknown[]; tone: Tone; field?: FieldSpec }) {
  if (!items.length) return <span className="text-sm text-faint">None</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <Badge key={i} tone={tone} className="max-w-full !whitespace-normal">
          {field?.options ? optionLabel(field, item) : displayValue(item)}
        </Badge>
      ))}
    </div>
  );
}

const LABEL_KEYS = ["label", "name", "criterion", "title", "field", "item", "category", "description"];
const RESULT_KEYS = ["met", "result", "verdict", "status", "passed", "match", "decision", "outcome"];
const LONG_KEYS = ["evidence", "reason", "reasoning", "note", "notes", "comment", "explanation", "quote", "details"];

function columnRank(key: string): number {
  const k = key.toLowerCase();
  if (LABEL_KEYS.includes(k)) return 0;
  if (RESULT_KEYS.includes(k)) return 1;
  if (/score|weight|confidence/.test(k)) return 2;
  if (LONG_KEYS.includes(k)) return 4;
  return 3;
}

function ObjectTable({ rows, field }: { rows: Record<string, unknown>[]; field?: FieldSpec }) {
  const declared = field?.fields?.map((f) => f.key) ?? [];
  const seen = new Set<string>(declared);
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  let keysList = [...seen].filter((k) => rows.some((r) => r[k] !== undefined && r[k] !== null && r[k] !== ""));
  // An id next to a human label is noise.
  if (keysList.some((k) => LABEL_KEYS.includes(k.toLowerCase()))) keysList = keysList.filter((k) => k.toLowerCase() !== "id");
  const columns = keysList.sort((a, b) => columnRank(a) - columnRank(b)).slice(0, 6);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-subtle/70 text-xs text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">
                {field?.fields?.find((f) => f.key === c)?.label ?? humanize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={i} className="align-top">
              {columns.map((c) => (
                <td key={c} className={clsx("px-3 py-2", columnRank(c) === 4 && "min-w-[16rem]", columnRank(c) === 0 && "min-w-[9rem] font-medium text-fg")}>
                  <CellValue name={c} value={row[c]} full={columnRank(c) === 4} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact value for a table cell (verdict badges, booleans, short text). */
export function CellValue({ name, value, field, full }: { name: string; value: unknown; field?: FieldSpec; full?: boolean }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-faint">—</span>;
  const score = scoreValue(field, name, value);
  if (score !== undefined) return <ScoreBar score={score} />;
  if (typeof value === "boolean") {
    return value ? <Check className="size-4 text-emerald-500" aria-label="Yes" /> : <Minus className="size-4 text-faint" aria-label="No" />;
  }
  const tone = verdictTone(value);
  if (tone && typeof value === "string" && value.length < 30) return <Badge tone={tone}>{optionLabel(field, value)}</Badge>;
  if (field?.type === "select" && typeof value === "string") return <Badge tone="neutral">{optionLabel(field, value)}</Badge>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-faint">—</span>;
    if (value.every((v) => typeof v !== "object")) {
      const first = value.slice(0, 2).map((v) => truncate(displayValue(v), 28));
      return (
        <span className="text-[13px]">
          {first.join(", ")}
          {value.length > 2 && <span className="text-faint"> +{value.length - 2}</span>}
        </span>
      );
    }
    return <span className="text-faint">{value.length} items</span>;
  }
  if (isRecord(value)) {
    if (typeof value.fileId === "string") return <FileLink fileId={value.fileId} name={String(value.fileName ?? value.name ?? "file")} />;
    const label = value.name ?? value.full_name ?? value.title ?? value.label;
    if (typeof label === "string") return <span>{truncate(label, 60)}</span>;
    return <span className="font-mono text-xs text-muted">{truncate(JSON.stringify(value), 60)}</span>;
  }
  return <span className="break-words whitespace-pre-wrap">{full ? displayValue(value) : truncate(displayValue(value), 140)}</span>;
}

/** Full rendering of one output value, driven by its FieldSpec when available. */
export function ValueView({ field, name, value }: { field?: FieldSpec; name: string; value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0 && field?.type !== "list")) {
    return <span className="text-sm text-faint">—</span>;
  }
  const score = scoreValue(field, name, value);
  if (score !== undefined) {
    return (
      <div className="flex items-center gap-3">
        <ScoreBar score={score} className="[&>div]:w-40" />
      </div>
    );
  }
  if (typeof value === "boolean") {
    return <Badge tone={value ? "green" : "neutral"}>{value ? "Yes" : "No"}</Badge>;
  }
  if ((field?.type === "file" || field?.type === "files") && asArray(value).every(isUuid)) {
    return (
      <div className="flex flex-wrap gap-3 text-sm">
        {asArray(value).map((id) => (
          <FileLink key={String(id)} fileId={String(id)} name="Download file" />
        ))}
      </div>
    );
  }
  if (field?.type === "select" || (typeof value === "string" && verdictTone(value) && value.length < 30)) {
    const tone = verdictTone(value) ?? "brand";
    return <Badge tone={tone}>{optionLabel(field, value)}</Badge>;
  }
  if (field?.type === "multiselect" && Array.isArray(value)) return <Chips items={value} tone="brand" field={field} />;
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return <Chips items={value} tone={listTone(name)} />;
    const rows = value.filter(isRecord);
    if (rows.length === value.length) return <ObjectTable rows={rows} field={field} />;
    return <JsonDetails data={value} label={`${value.length} items`} />;
  }
  if (isRecord(value)) {
    if (typeof value.fileId === "string") {
      return (
        <div className="text-sm">
          <FileLink fileId={value.fileId} name={String(value.fileName ?? value.name ?? "Download")} />
          {typeof value.rowCount === "number" && <span className="ml-2 text-muted">{value.rowCount} rows</span>}
        </div>
      );
    }
    const all = Object.entries(value);
    const entries = all.filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0));
    const hidden = all.length - entries.length;
    return (
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-lg border border-line p-3 text-[13px] sm:grid-cols-[minmax(7rem,35%)_1fr]">
        {entries.map(([k, v]) => {
          const sub = field?.fields?.find((f) => f.key === k);
          return (
            <div key={k} className="contents">
              <dt className="text-muted">{sub?.label ?? humanize(k)}</dt>
              <dd className="min-w-0">
                <CellValue name={k} value={v} field={sub} />
              </dd>
            </div>
          );
        })}
        {hidden > 0 && (
          <p className="text-xs text-faint sm:col-span-2">
            {hidden} empty field{hidden === 1 ? "" : "s"} not shown
          </p>
        )}
      </dl>
    );
  }
  if (typeof value === "number") return <span className="text-sm font-medium tabular-nums">{displayValue(value)}</span>;
  const text = String(value);
  if (field?.type === "email" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return (
      <a className="text-sm text-brand-600 hover:underline dark:text-brand-300" href={`mailto:${text}`}>
        {text}
      </a>
    );
  }
  if (field?.type === "url" || /^https?:\/\//.test(text)) {
    return (
      <a className="text-sm break-all text-brand-600 hover:underline dark:text-brand-300" href={text} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    );
  }
  if (field?.type === "text" || text.length > 120 || looksLikeMarkdown(text)) return <Markdown compact>{text}</Markdown>;
  return <span className="text-sm break-words whitespace-pre-wrap">{text}</span>;
}

// ---------------------------------------------------------------------------
// OutputView
// ---------------------------------------------------------------------------

function isHeroScore(field: FieldSpec | undefined, key: string, value: unknown) {
  return scoreValue(field, key, value) !== undefined;
}

/**
 * Human-readable rendering of an agent's output using its outputs FieldSpec[]:
 * scores as rings/bars, verdicts as colored badges, lists as chips, text as
 * markdown, objects/lists of objects as small tables. `highlight` keys are
 * emphasised at the top. Raw JSON stays behind a "Details" toggle.
 */
export function OutputView({
  output,
  fields = [],
  highlight = [],
  className,
  showDetails = true,
}: {
  output: Record<string, unknown> | null | undefined;
  fields?: FieldSpec[];
  highlight?: string[];
  className?: string;
  showDetails?: boolean;
}) {
  if (!output || !Object.keys(output).length) {
    return <p className={clsx("text-sm text-muted", className)}>No output.</p>;
  }
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const heroKeys = highlight.filter((k) => output[k] !== undefined && output[k] !== null && output[k] !== "");
  const scoreKeys = heroKeys.filter((k) => isHeroScore(byKey.get(k), k, output[k]));
  const badgeKeys = heroKeys.filter((k) => {
    if (scoreKeys.includes(k)) return false;
    const v = output[k];
    const f = byKey.get(k);
    return f?.type === "select" || typeof v === "boolean" || (typeof v === "string" && Boolean(verdictTone(v)) && v.length < 30);
  });
  const restHero = heroKeys.filter((k) => !scoreKeys.includes(k) && !badgeKeys.includes(k));
  const declaredOrder = fields.map((f) => f.key).filter((k) => k in output && !heroKeys.includes(k));
  const extras = Object.keys(output).filter((k) => !byKey.has(k) && !heroKeys.includes(k));
  const label = (k: string) => byKey.get(k)?.label ?? humanize(k);

  return (
    <div className={clsx("space-y-5", className)}>
      {heroKeys.length > 0 && (
        <div className="rounded-xl border border-line bg-gradient-to-br from-brand-50/60 to-transparent p-4 dark:from-brand-400/5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {scoreKeys.map((k) => {
              const s = scoreValue(byKey.get(k), k, output[k]) ?? 0;
              return (
                <div key={k} className="flex items-center gap-3">
                  <ScoreRing score={s} label={label(k)} />
                  <div className="sm:hidden">
                    <p className="text-xs text-muted">{label(k)}</p>
                  </div>
                </div>
              );
            })}
            <div className="min-w-0 flex-1 space-y-3">
              {badgeKeys.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {badgeKeys.map((k) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="text-xs text-muted">{label(k)}</span>
                      <ValueView field={byKey.get(k)} name={k} value={output[k]} />
                    </div>
                  ))}
                </div>
              )}
              {restHero.map((k) => (
                <div key={k}>
                  <p className="mb-1 text-xs font-medium text-muted">{label(k)}</p>
                  <div className={clsx(typeof output[k] === "string" && "text-[15px] font-medium text-fg")}>
                    <ValueView field={byKey.get(k)} name={k} value={output[k]} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {declaredOrder.length > 0 && (
        <div className="space-y-4">
          {declaredOrder.map((k) => (
            <div key={k}>
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{label(k)}</p>
              <ValueView field={byKey.get(k)} name={k} value={output[k]} />
            </div>
          ))}
        </div>
      )}

      {extras.length > 0 && (
        <div className="space-y-4">
          {declaredOrder.length > 0 && <div className="border-t border-dashed border-line" />}
          {extras.map((k) => (
            <div key={k}>
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{humanize(k)}</p>
              <ValueView name={k} value={output[k]} />
            </div>
          ))}
        </div>
      )}

      {showDetails && <JsonDetails data={output} label="Raw output" />}
    </div>
  );
}
