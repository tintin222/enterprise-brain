import { clsx } from "clsx";
import { FlaskConical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { humanize } from "../lib/format.ts";
import { useDemoFiles } from "../lib/queries.ts";
import type { StoredFile } from "../types.ts";

const SET_LABELS: Record<string, string> = { cv: "Sample CVs", invoice: "Sample supplier invoices" };

/** "Use demo samples": pick one of the bundled demo sets (files with metadata.demoSet). */
export function DemoSamplesButton({
  onPick,
  busy,
  className,
  preferred,
  label = "Use demo samples",
}: {
  onPick: (fileIds: string[], label: string, files: StoredFile[]) => void;
  busy?: boolean;
  className?: string;
  /** Put this set first (e.g. "cv" for a CV screener). */
  preferred?: string;
  label?: string;
}) {
  const { data: sets } = useDemoFiles();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!sets || sets.size === 0) return null;
  const entries = [...sets.entries()].sort(([a], [b]) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)));

  return (
    <div ref={ref} className={clsx("relative inline-block", className)}>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-[13px] font-medium text-muted hover:border-brand-400 hover:text-brand-700 disabled:opacity-50 dark:hover:text-brand-300"
        aria-expanded={open}
      >
        <FlaskConical className="size-4" /> {label}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-72 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          {entries.map(([set, files]) => (
            <button
              key={set}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(
                  files.map((f) => f.id),
                  SET_LABELS[set] ?? humanize(set),
                  files,
                );
              }}
              className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-subtle"
            >
              <span className="text-sm font-medium text-fg">{SET_LABELS[set] ?? humanize(set)}</span>
              <span className="truncate text-xs text-muted">
                {files.length} file{files.length === 1 ? "" : "s"}: {files.map((f) => f.name).join(", ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
