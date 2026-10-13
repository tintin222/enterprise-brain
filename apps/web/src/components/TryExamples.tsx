import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pin, Play, X } from "lucide-react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { displayValue, humanize, isUuid } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDetail, RunExample, RunRow } from "../types.ts";
import { Button } from "./Button.tsx";

/** What an example gives, in a line: its first few values (files by name are shown as "a file"). */
function inputLine(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${humanize(k)}: ${isUuid(v) ? "a file" : Array.isArray(v) && v.every(isUuid) ? `${v.length} files` : displayValue(v)}`)
    .join(" · ");
}

/**
 * Examples to try the AI employee with, without filling in its form: the ones managers pinned from its
 * runs, and the ones its job came with. Each starts a test run with what it gives.
 */
export function TryExamples({ detail, onStarted }: { detail: AgentDetail; onStarted: (run: RunRow) => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const slug = detail.agent.slug;
  const pinned: (RunExample & { kind: "pinned" })[] = (detail.settings?.examples ?? []).map((e) => ({ ...e, kind: "pinned" }));
  const given = (detail.definition.tests ?? []).map((t, i) => ({ id: `test-${i}`, name: t.name, input: t.input, kind: "job" as const }));
  const examples = [...pinned, ...given];
  const start = useMutation({
    mutationFn: (example: { id: string; input: Record<string, unknown> }) =>
      api.post<RunRow>(path(`/agents/${encodeURIComponent(slug)}/runs`), { input: example.input, test: true, wait: false }),
    onSuccess: (run) => {
      onStarted(run);
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
    },
    onError: (error) => toast.error(error),
  });
  const unpin = useMutation({
    mutationFn: (id: string) => api.del(path(`/agents/${encodeURIComponent(slug)}/examples/${encodeURIComponent(id)}`)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.agent(company, slug) }),
    onError: (error) => toast.error(error),
  });
  if (!examples.length) return null;
  return (
    <div>
      <p className="label">Start from an example</p>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {examples.map((example) => (
          <li key={example.id} className="flex items-center gap-2 px-3 py-2">
            {example.kind === "pinned" && <Pin className="size-3.5 shrink-0 text-muted" aria-label="Pinned from a run" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg">{example.name}</p>
              <p className="truncate text-xs text-muted">
                {inputLine(example.input) || "No input"}
                {example.kind === "pinned" ? ` · pinned by ${example.createdBy}` : " · from its job"}
              </p>
            </div>
            {example.kind === "pinned" && detail.canManage && (
              <Button
                size="xs"
                variant="ghost"
                icon={X}
                aria-label={`Unpin ${example.name}`}
                loading={unpin.isPending && unpin.variables === example.id}
                onClick={() => unpin.mutate(example.id)}
              />
            )}
            <Button size="xs" icon={Play} loading={start.isPending && start.variables?.id === example.id} onClick={() => start.mutate(example)}>
              Try it
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Or fill in what it gets below.</p>
    </div>
  );
}
