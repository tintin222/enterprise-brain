import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { api, fileUrl } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import type { ActionParam, ScreenRun } from "../types.ts";

export function isScreenRun(value: unknown): value is ScreenRun {
  return typeof value === "object" && value !== null && typeof (value as ScreenRun).steps === "number" && Array.isArray((value as ScreenRun).trail);
}

/** The {placeholders} of a screen action's goal as its values: new ones are required text, known ones keep their settings. */
export function paramsFromGoal(goal: string, existing: ActionParam[]): ActionParam[] {
  const keys = [...new Set([...goal.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!))];
  return keys.map((key) => existing.find((p) => p.key === key) ?? { key, type: "string", required: true });
}

/** An AI employee's work on an old system's screens: the last screen (fetched with the viewer's sign-in) and each step. */
export function ScreenRunView({ run, className }: { run: ScreenRun; className?: string }) {
  const { company } = useCompany();
  const [url, setUrl] = useState<string | null>(null);
  const image = useQuery({
    queryKey: [company, "files", "blob", run.lastScreenFileId],
    queryFn: () => api.blob(fileUrl(company, run.lastScreenFileId!, true)),
    enabled: Boolean(run.lastScreenFileId),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (!image.data) return;
    const next = URL.createObjectURL(image.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image.data]);
  return (
    <div className={clsx("space-y-2", className)}>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open the last screen">
          <img src={url} alt="The last screen" className="max-h-96 w-full rounded-lg border border-line bg-subtle object-cover object-top" />
        </a>
      )}
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-fg">
          <Monitor className="size-3.5" />
          {run.steps} step{run.steps === 1 ? "" : "s"} on the screens
        </summary>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-xs text-muted">
          {run.trail.map((line, i) => (
            <li key={i} className="break-words">
              {line}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
