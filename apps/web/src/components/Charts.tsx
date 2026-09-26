import { clsx } from "clsx";

export type ChartTone = "brand" | "amber" | "green" | "red" | "slate";

const FILL: Record<ChartTone, string> = {
  brand: "bg-brand-500 dark:bg-brand-400",
  amber: "bg-amber-400 dark:bg-amber-300/80",
  green: "bg-emerald-500 dark:bg-emerald-400",
  red: "bg-red-500 dark:bg-red-400",
  slate: "bg-slate-300 dark:bg-slate-500",
};

const STROKE: Record<ChartTone, string> = {
  brand: "stroke-brand-500 dark:stroke-brand-300",
  amber: "stroke-amber-500 dark:stroke-amber-300",
  green: "stroke-emerald-500 dark:stroke-emerald-300",
  red: "stroke-red-500 dark:stroke-red-300",
  slate: "stroke-slate-400",
};

export interface BarPart {
  value: number;
  tone: ChartTone;
  label: string;
}

/** Stacked bars, one per period (a week), with the parts' legend under them. */
export function StackedBars({
  bars,
  height = 140,
  className,
  labels = "auto",
}: {
  bars: { label: string; parts: BarPart[] }[];
  height?: number;
  className?: string;
  /** "ends": only the first and last period are named (narrow places); "auto": ends on phones. */
  labels?: "all" | "ends" | "auto";
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.parts.reduce((sum, p) => sum + p.value, 0)));
  const legend = bars[0]?.parts ?? [];
  return (
    <div className={className}>
      <div
        className="flex items-end gap-1.5 sm:gap-3"
        style={{ height }}
        role="img"
        aria-label={bars.map((b) => `${b.label}: ${b.parts.map((p) => `${p.value} ${p.label}`).join(", ")}`).join("; ")}
      >
        {bars.map((bar) => {
          const total = bar.parts.reduce((sum, p) => sum + p.value, 0);
          return (
            <div
              key={bar.label}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${bar.label}: ${bar.parts.map((p) => `${p.value} ${p.label}`).join(", ")}`}
            >
              <span className="mb-1 text-center text-[11px] text-muted tabular-nums">{total || ""}</span>
              <div className="flex flex-col-reverse overflow-hidden rounded-md" style={{ height: `${(total / max) * 100}%` }}>
                {bar.parts.map((part) => (
                  <div key={part.label} className={FILL[part.tone]} style={{ height: total ? `${(part.value / total) * 100}%` : 0 }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {labels !== "all" && (
        <div className={clsx("mt-1.5 flex justify-between border-t border-line pt-1.5 text-[11px] text-faint", labels === "auto" && "sm:hidden")}>
          <span>{bars[0]?.label}</span>
          <span>{bars.at(-1)?.label}</span>
        </div>
      )}
      {labels !== "ends" && (
        <div className={clsx("mt-1.5 gap-1.5 border-t border-line pt-1.5 sm:gap-3", labels === "auto" ? "hidden sm:flex" : "flex")}>
          {bars.map((bar) => (
            <span key={bar.label} className="min-w-0 flex-1 truncate text-center text-[11px] text-faint">
              {bar.label}
            </span>
          ))}
        </div>
      )}
      {legend.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {legend.map((part) => (
            <span key={part.label} className="inline-flex items-center gap-1.5">
              <span className={clsx("size-2.5 rounded-sm", FILL[part.tone])} />
              {part.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small line of values over time (gaps where there is no value), with the target as a dashed line. */
export function Sparkline({
  values,
  target,
  tone = "brand",
  className,
  max: fixedMax,
}: {
  values: (number | null)[];
  target?: number;
  tone?: ChartTone;
  className?: string;
  max?: number;
}) {
  const known = values.filter((v): v is number => v !== null);
  const max = fixedMax ?? Math.max(target ?? 0, ...known, 0.0001) * 1.15;
  const x = (i: number) => (values.length <= 1 ? 50 : (i / (values.length - 1)) * 100);
  const y = (v: number) => 30 - (Math.min(v, max) / max) * 28 - 1;
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
    } else current.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={clsx("h-8 w-full overflow-visible", className)} aria-hidden="true">
      {target !== undefined && (
        <line
          x1="0"
          x2="100"
          y1={y(target)}
          y2={y(target)}
          className="stroke-slate-300 dark:stroke-slate-600"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {segments.map((points) =>
        points.includes(" ") ? (
          <polyline
            key={points}
            points={points}
            fill="none"
            className={STROKE[tone]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle
            key={points}
            cx={points.split(",")[0]}
            cy={points.split(",")[1]}
            r="1.5"
            className={clsx(STROKE[tone], "fill-current")}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </svg>
  );
}
