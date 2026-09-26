import { clsx } from "clsx";
import { formatDate, humanize } from "../../lib/format.ts";
import type { CalculationOutput, ResultColumn } from "../../types.ts";

/** A value of a result as people read it: money with its currency, percentages, dates, ranks. */
function cell(column: ResultColumn | undefined, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    switch (column?.type) {
      case "money":
        return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${column.currency ? ` ${column.currency}` : ""}`;
      case "percent":
        return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
      case "rank":
        return `${value}.`;
      default:
        return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
  }
  if (column?.type === "date" && typeof value === "string") return formatDate(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A calculation's result: a ranking or list as a table, one figure, or a text. */
export function ResultView({ output, result, compact, className }: { output: CalculationOutput; result: unknown; compact?: boolean; className?: string }) {
  if (output.kind === "number" || typeof result === "number") {
    return (
      <p className={clsx("font-semibold text-fg tabular-nums", compact ? "text-2xl" : "text-4xl", className)}>
        {typeof result === "number" ? result.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
        {output.unit && <span className="ml-2 text-base font-normal text-muted">{output.unit}</span>}
      </p>
    );
  }
  if (output.kind === "text" || typeof result === "string")
    return <p className={clsx("text-sm whitespace-pre-wrap text-fg", className)}>{String(result ?? "")}</p>;
  const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  if (!rows.length) return <p className={clsx("text-sm text-muted", className)}>No rows this time.</p>;
  // The columns it says it gives, then any others the rows have.
  const known = output.columns.filter((c) => rows.some((r) => c.key in r));
  const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => !known.some((c) => c.key === k))
    .map((key): ResultColumn => ({ key, label: humanize(key), type: "text" }));
  const columns = [...known, ...extra];
  const numeric = (c: ResultColumn) => c.type !== "text" && c.type !== "date";
  const shown = compact ? rows.slice(0, 10) : rows;
  return (
    <div className={clsx("overflow-x-auto", className)}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={clsx("px-3 py-2 font-medium", numeric(c) && "text-right", c.type === "rank" && "w-12")}>
                {c.type === "rank" ? "#" : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {shown.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={clsx("px-3 py-2 whitespace-nowrap", numeric(c) ? "text-right tabular-nums" : "text-fg", c.type === "rank" && "text-muted")}
                >
                  {cell(c, row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {compact && rows.length > shown.length && <p className="px-3 pt-2 text-xs text-muted">and {rows.length - shown.length} more</p>}
    </div>
  );
}
