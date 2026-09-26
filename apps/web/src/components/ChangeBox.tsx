import { useMutation } from "@tanstack/react-query";
import { Check, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "../lib/toast.tsx";
import { Button } from "./Button.tsx";
import { Callout, ErrorState } from "./Spinner.tsx";

/** What a proposed change says back: the changes in plain words, what wouldn't work, and what wasn't understood. */
export interface ChangeSaid {
  summary: string[];
  problems?: string[];
  notes?: string[];
}

/**
 * Say what to change in plain words; see what would change (and what wouldn't work) before it is made.
 * `propose` asks the Studio; `preview` shows anything more (a new result); `apply` makes it.
 */
export function ChangeBox<T>({
  title = "Change it in plain words",
  placeholder,
  propose,
  said,
  preview,
  apply,
  applyLabel = "Make the change",
  onApplied,
  initial,
}: {
  title?: string;
  placeholder: string;
  propose: (request: string) => Promise<T>;
  said: (proposal: T) => ChangeSaid;
  preview?: (proposal: T) => ReactNode;
  apply: (proposal: T) => Promise<unknown>;
  applyLabel?: string;
  onApplied?: () => void;
  /** A change already said (from the one box): shown and worked out at once. */
  initial?: string;
}) {
  const toast = useToast();
  const [request, setRequest] = useState(initial ?? "");
  const [proposal, setProposal] = useState<T | null>(null);
  const ask = useMutation({ mutationFn: (said?: string) => propose((said ?? request).trim()), onSuccess: setProposal });
  useEffect(() => {
    if (initial && initial.trim().length >= 3) ask.mutate(initial);
    // Once, for the change it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const make = useMutation({
    mutationFn: () => apply(proposal!),
    onSuccess: () => {
      toast.success("Changed");
      setProposal(null);
      setRequest("");
      onApplied?.();
    },
  });
  const words = proposal ? said(proposal) : null;
  const blocked = Boolean(words?.problems?.length) || (words ? words.summary.length === 0 : true);
  return (
    <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-400/25 dark:bg-brand-400/5">
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Wand2 className="size-4 text-brand-600 dark:text-brand-300" /> {title}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          className="input min-h-16 flex-1"
          placeholder={placeholder}
          value={request}
          onChange={(e) => {
            setRequest(e.target.value);
            setProposal(null);
          }}
          aria-label={title}
        />
        <Button className="sm:self-start" icon={Sparkles} loading={ask.isPending} disabled={request.trim().length < 3} onClick={() => ask.mutate()}>
          See the change
        </Button>
      </div>
      {ask.error && <ErrorState error={ask.error} title="It couldn't be worked out" />}
      {words && (
        <div className="space-y-3">
          {words.summary.length > 0 ? (
            <div>
              <p className="label">What changes</p>
              <ul className="space-y-1 text-sm">
                {words.summary.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    <span className="text-fg">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted">Nothing would change.</p>
          )}
          {words.problems && words.problems.length > 0 && (
            <Callout tone="danger" title="It can't be made like this">
              <ul className="list-disc space-y-0.5 pl-4">
                {words.problems.slice(0, 8).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {words.problems.length > 8 && <li>and {words.problems.length - 8} more</li>}
              </ul>
            </Callout>
          )}
          {words.notes && words.notes.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc space-y-0.5 pl-4">
                {words.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Callout>
          )}
          {preview?.(proposal!)}
          {make.error && <ErrorState error={make.error} title="Not changed" />}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setProposal(null)}>Not this</Button>
            <Button variant="primary" loading={make.isPending} disabled={blocked} onClick={() => make.mutate()}>
              {applyLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
