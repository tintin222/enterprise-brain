import { clsx } from "clsx";
import type { ReactNode } from "react";
import { displayValue, humanize, isRecord } from "../lib/format.ts";

/** Definition list: label on the left, value on the right (stacks on mobile). */
export function KeyValue({
  items,
  className,
  labelWidth = "sm:grid-cols-[minmax(8rem,30%)_1fr]",
  dense,
}: {
  items: [ReactNode, ReactNode][];
  className?: string;
  labelWidth?: string;
  dense?: boolean;
}) {
  return (
    <dl className={clsx("divide-y divide-line text-sm", className)}>
      {items.map(([label, value], i) => (
        <div key={i} className={clsx("grid grid-cols-1 gap-x-4 gap-y-0.5", labelWidth, dense ? "py-1.5" : "py-2.5")}>
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words text-fg">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Generic record → key/value rows (nested objects rendered compactly). */
export function RecordTable({ data, className }: { data: Record<string, unknown>; className?: string }) {
  const entries = Object.entries(data);
  if (!entries.length) return <p className="text-sm text-muted">No values.</p>;
  return (
    <KeyValue
      dense
      className={className}
      items={entries.map(([key, value]) => [
        humanize(key),
        isRecord(value) || (Array.isArray(value) && value.some((v) => typeof v === "object")) ? (
          <code className="font-mono text-xs break-all whitespace-pre-wrap text-muted">{JSON.stringify(value, null, 1)}</code>
        ) : (
          <span className="whitespace-pre-wrap">{displayValue(value)}</span>
        ),
      ])}
    />
  );
}
