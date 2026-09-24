import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Code } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";

function Primitive({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (value === null) return <span className="text-faint">null</span>;
  if (value === undefined) return <span className="text-faint">undefined</span>;
  if (typeof value === "string") {
    const long = value.length > 160;
    const shown = long && !expanded ? `${value.slice(0, 160)}…` : value;
    return (
      <span className="break-words whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">
        "{shown}"
        {long && (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="ml-1 text-[11px] text-brand-600 hover:underline dark:text-brand-300">
            {expanded ? "less" : `more (${value.length})`}
          </button>
        )}
      </span>
    );
  }
  if (typeof value === "number") return <span className="text-sky-700 dark:text-sky-300">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-violet-700 dark:text-violet-300">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({ name, value, depth, defaultExpandDepth }: { name?: ReactNode; value: unknown; depth: number; defaultExpandDepth: number }) {
  const isArray = Array.isArray(value);
  const isObject = typeof value === "object" && value !== null;
  const [open, setOpen] = useState(depth < defaultExpandDepth);
  const label = name !== undefined ? <span className="text-slate-600 dark:text-slate-300">{name}: </span> : null;
  if (!isObject) {
    return (
      <div className="leading-6">
        {label}
        <Primitive value={value} />
      </div>
    );
  }
  const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  if (!entries.length) {
    return (
      <div className="leading-6">
        {label}
        <span className="text-faint">{isArray ? "[]" : "{}"}</span>
      </div>
    );
  }
  return (
    <div className="leading-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="-ml-4 inline-flex items-center text-left hover:text-brand-600 dark:hover:text-brand-300">
        {open ? <ChevronDown className="size-3.5 text-faint" /> : <ChevronRight className="size-3.5 text-faint" />}
        {label}
        <span className="text-faint">{summary}</span>
      </button>
      {open && (
        <div className="ml-1 border-l border-line pl-4">
          {entries.map(([key, v]) => (
            <Node key={key} name={key} value={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible JSON tree. */
export function JsonView({ data, className, expandDepth = 1, copy = true }: { data: unknown; className?: string; expandDepth?: number; copy?: boolean }) {
  return (
    <div className={clsx("relative overflow-x-auto rounded-lg border border-line bg-subtle/60 py-2 pr-3 pl-6 font-mono text-xs", className)}>
      {copy && (
        <div className="absolute top-1.5 right-1.5">
          <CopyButton text={() => JSON.stringify(data, null, 2)} label="Copy JSON" iconOnly />
        </div>
      )}
      <Node value={data} depth={0} defaultExpandDepth={expandDepth} />
    </div>
  );
}

/** "Details" toggle that reveals raw JSON (progressive disclosure). */
export function JsonDetails({ data, label = "Details", className, expandDepth = 2 }: { data: unknown; label?: string; className?: string; expandDepth?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg"
        aria-expanded={open}
      >
        <Code className="size-3.5" />
        {label}
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && <JsonView data={data} className="mt-2" expandDepth={expandDepth} />}
    </div>
  );
}
