import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Lightbulb, Link2, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../../api.ts";
import { formatDateTime } from "../../lib/format.ts";
import { useCompany } from "../../lib/company.tsx";
import { useToast } from "../../lib/toast.tsx";
import { brainKeys, kindOf, lowerName, useBrainModel } from "../../pages/brain/brain.tsx";
import type { BrainLearnChange, LearningCardView, Message } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Callout } from "../Spinner.tsx";

/** One change the brain would make: what kind, its values, why; a tick box when the viewer keeps it. */
function ChangeRow({
  change,
  checked,
  locked,
  readOnly,
  onToggle,
}: {
  change: BrainLearnChange;
  checked: boolean;
  locked: boolean;
  readOnly?: boolean;
  onToggle?: () => void;
}) {
  const { data: model } = useBrainModel();
  const kind = kindOf(model, change.type === "knowhow" ? "knowhow" : change.kind);
  const relation = model?.relations.find((r) => r.key === change.relation);
  const Icon = change.type === "add" ? Plus : change.type === "update" ? Pencil : change.type === "link" ? Link2 : Lightbulb;
  const fields = Object.entries(change.fields).filter(([, v]) => v.trim());
  const body = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-medium text-fg">
          {change.type === "add" && `Add ${lowerName(kind?.name ?? change.kind)}: ${change.name}`}
          {change.type === "update" && `Change ${change.name}`}
          {change.type === "link" &&
            `${change.name} — ${relation?.label.toLowerCase() ?? change.relation} → ${change.to.name}${change.detail ? ` (${change.detail})` : ""}`}
          {change.type === "knowhow" && `Keep as know-how: ${change.name}`}
        </span>
        {change.summary && <span className="mt-0.5 block text-xs text-muted">{change.summary}</span>}
        {fields.length > 0 && (
          <span className="mt-1 block space-y-0.5 text-xs text-muted">
            {fields.map(([key, value]) => (
              <span key={key} className="block whitespace-pre-line">
                <span className="font-medium text-fg">{kind?.fields.find((f) => f.key === key)?.label ?? key}:</span> {value}
              </span>
            ))}
          </span>
        )}
        {change.type === "knowhow" && change.about.length > 0 && (
          <span className="mt-1 block text-xs text-muted">About: {change.about.map((a) => a.name).join(", ")}</span>
        )}
        {change.why && <span className="mt-1 block text-[11px] text-faint italic">“{change.why}”</span>}
        {locked && !readOnly && <span className="mt-1 block text-[11px] text-amber-700 dark:text-amber-300">A manager or an admin can add this.</span>}
      </span>
    </>
  );
  if (readOnly) return <li className="flex gap-3 rounded-lg border border-line p-3">{body}</li>;
  return (
    <li>
      <label className={clsx("flex gap-3 rounded-lg border border-line p-3", locked ? "opacity-60" : "cursor-pointer hover:bg-subtle/60")}>
        <input type="checkbox" className="mt-1 size-4 accent-brand-600" checked={checked && !locked} disabled={locked} onChange={onToggle} />
        {body}
      </label>
    </li>
  );
}

/**
 * What the company brain understood from a person's words, in the conversation: the changes it would
 * make, each with a tick box for the person who taught it. They keep what is right, or put it aside.
 */
export function LearningCard({ message, card, onChanged }: { message: Message; card: LearningCardView; onChanged: (message: Message) => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"keep" | "dismiss" | null>(null);
  const keepable = card.changes.map((c, i) => ({ c, i })).filter(({ c, i }) => !skip.has(i) && (card.mayEdit || c.type === "knowhow"));

  const settle = async (body: { keep: number[] } | { dismiss: true }) => {
    setBusy("keep" in body ? "keep" : "dismiss");
    try {
      const updated = await api.post<Message>(path(`/conversations/${encodeURIComponent(message.conversationId)}/messages/${message.id}/learn`), body);
      onChanged(updated);
      if ("keep" in body) {
        await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
        const done = updated.card?.type === "learning" ? (updated.card.result?.done ?? []) : [];
        if (done.length) toast.success(done.length === 1 ? done[0]! : `The brain learned ${done.length} things`);
      }
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Lightbulb className="size-4 text-brand-600 dark:text-brand-300" /> What the brain understood
      </p>
      {card.understood && <p className="mt-1 text-sm text-muted">{card.understood}</p>}

      {card.status === "open" && (
        <>
          {card.changes.length === 0 ? (
            <Callout tone="info" className="mt-3">
              Nothing to add from that. Say who, what or which system, and teach it again.
            </Callout>
          ) : (
            <ul className="mt-3 space-y-2">
              {card.changes.map((change, i) => (
                <ChangeRow
                  key={i}
                  change={change}
                  checked={!skip.has(i)}
                  locked={!card.mayEdit && change.type !== "knowhow"}
                  readOnly={!card.canKeep}
                  onToggle={() =>
                    setSkip((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
          {card.canKeep ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {card.changes.length > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy === "keep"}
                  disabled={busy !== null || keepable.length === 0}
                  onClick={() => void settle({ keep: keepable.map(({ i }) => i) })}
                >
                  Keep {keepable.length === 1 ? "this" : `these ${keepable.length}`}
                </Button>
              )}
              <Button variant="ghost" size="sm" loading={busy === "dismiss"} disabled={busy !== null} onClick={() => void settle({ dismiss: true })}>
                Not now
              </Button>
              {card.offline && <span className="text-xs text-muted">No AI model is connected: your words are kept as know-how.</span>}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted">{card.by.name} keeps what is right.</p>
          )}
        </>
      )}

      {card.status === "kept" && (
        <div className="mt-3 space-y-2 text-sm">
          {card.result && card.result.done.length > 0 && (
            <Callout tone="success" title="Kept">
              <ul className="list-disc pl-4">
                {card.result.done.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Callout>
          )}
          {card.result && card.result.skipped.length > 0 && (
            <Callout tone="warning" title="Not kept">
              <ul className="list-disc pl-4">
                {card.result.skipped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Callout>
          )}
          <p className="text-xs text-muted">
            Kept by {card.settledBy ?? card.by.name}
            {card.settledAt ? ` · ${formatDateTime(card.settledAt)}` : ""}
          </p>
        </div>
      )}

      {card.status === "dismissed" && (
        <p className="mt-2 text-xs text-muted">
          Put aside by {card.settledBy ?? card.by.name}
          {card.settledAt ? ` · ${formatDateTime(card.settledAt)}` : ""}
        </p>
      )}
    </div>
  );
}
