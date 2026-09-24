import { clsx } from "clsx";
import { FileText, LoaderCircle, Upload, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes } from "../lib/format.ts";

function matchesAccept(file: File, accept?: string[]): boolean {
  if (!accept?.length) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.some((a) => {
    const rule = a.toLowerCase().trim();
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/** Drag & drop (or click / keyboard) file picker. */
export function Dropzone({
  onFiles,
  accept,
  multiple = true,
  disabled,
  busy,
  label,
  hint,
  compact,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  accept?: string[];
  multiple?: boolean;
  disabled?: boolean;
  busy?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const inactive = disabled || busy;

  const take = (list: FileList | null) => {
    if (!list || inactive) return;
    const all = Array.from(list);
    const ok = all.filter((f) => matchesAccept(f, accept));
    const skipped = all.length - ok.length;
    setRejected(skipped ? `${skipped} file${skipped > 1 ? "s" : ""} skipped (accepted: ${accept?.join(", ")})` : null);
    const chosen = multiple ? ok : ok.slice(0, 1);
    if (chosen.length) onFiles(chosen);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.current?.click();
    }
  };

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={inactive ? -1 : 0}
        aria-disabled={inactive}
        aria-labelledby={`${inputId}-label`}
        onClick={() => !inactive && input.current?.click()}
        onKeyDown={onKey}
        onDragOver={(e) => {
          e.preventDefault();
          if (!inactive) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={clsx(
          "group relative flex cursor-pointer items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors",
          compact ? "gap-3 px-4 py-3" : "flex-col gap-2 px-6 py-7",
          over ? "border-brand-500 bg-brand-50/70 dark:bg-brand-400/10" : "border-line-strong bg-subtle/40 hover:border-brand-400 hover:bg-brand-50/40 dark:hover:bg-brand-400/5",
          inactive && "cursor-not-allowed opacity-60",
        )}
      >
        <span
          className={clsx(
            "flex shrink-0 items-center justify-center rounded-full bg-surface text-brand-600 shadow-xs ring-1 ring-line dark:text-brand-300",
            compact ? "size-8" : "size-10",
          )}
        >
          {busy ? <LoaderCircle className="size-5 animate-spin" /> : <Upload className={compact ? "size-4" : "size-5"} />}
        </span>
        <span className={clsx(compact && "text-left")}>
          <span id={`${inputId}-label`} className="block text-sm font-medium text-fg">
            {busy ? "Uploading…" : (label ?? (multiple ? "Drop files here or click to browse" : "Drop a file here or click to browse"))}
          </span>
          {(hint || accept?.length) && <span className="mt-0.5 block text-xs text-muted">{hint ?? `Accepted: ${accept?.join(", ")}`}</span>}
        </span>
        {children}
        <input
          ref={input}
          id={inputId}
          type="file"
          className="sr-only"
          tabIndex={-1}
          multiple={multiple}
          accept={accept?.join(",")}
          disabled={inactive}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {rejected && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">{rejected}</p>}
    </div>
  );
}

/** A selected (not yet uploaded) file, with an optional remove button. */
export function FileChip({ name, size, onRemove, className }: { name: string; size?: number; onRemove?: () => void; className?: string }) {
  return (
    <span className={clsx("inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pr-1.5 pl-2 text-xs", className)}>
      <FileText className="size-3.5 shrink-0 text-muted" />
      <span className="truncate font-medium text-fg">{name}</span>
      {size !== undefined && <span className="shrink-0 text-faint">{formatBytes(size)}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-0.5 text-faint hover:bg-subtle hover:text-fg" aria-label={`Remove ${name}`}>
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
