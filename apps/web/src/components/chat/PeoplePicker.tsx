import { X } from "lucide-react";
import { useState } from "react";
import { MENTION_ICONS } from "../../lib/mentions.ts";
import type { MentionHit, MentionKind } from "../../types.ts";
import { useMentionHits } from "./MentionPicker.tsx";

/**
 * Pick people (and AI employees) by name: the chosen ones as chips, a box to find more. `scope: company`
 * offers everyone active in the company; otherwise the viewer's departments.
 */
export function PeoplePicker({
  value,
  onChange,
  kinds = ["person", "ai_employee"],
  scope,
  conversationId,
  exclude,
  placeholder = "A colleague, an AI employee…",
  autoFocus,
  inputId,
}: {
  value: MentionHit[];
  onChange: (next: MentionHit[]) => void;
  kinds?: MentionKind[];
  scope?: "company";
  conversationId?: string | null;
  /** `kind:id` keys not to offer (those already in). */
  exclude?: Set<string>;
  placeholder?: string;
  autoFocus?: boolean;
  inputId?: string;
}) {
  const [q, setQ] = useState("");
  const hits = useMentionHits(q, { kinds, scope, conversationId });
  const chosen = new Set(value.map((w) => `${w.kind}:${w.id}`));
  const candidates = (hits.data ?? []).filter((h) => !chosen.has(`${h.kind}:${h.id}`) && !exclude?.has(`${h.kind}:${h.id}`)).slice(0, 8);
  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((w) => {
            const Icon = MENTION_ICONS[w.kind];
            return (
              <span key={`${w.kind}:${w.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pr-1.5 pl-2 text-xs">
                <Icon className="size-3.5 text-muted" />
                <span className="font-medium text-fg">{w.name}</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== w))}
                  className="rounded p-0.5 text-faint hover:bg-subtle hover:text-fg"
                  aria-label={`Remove ${w.name}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        id={inputId}
        className="input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label="Who to add"
        autoFocus={autoFocus}
      />
      {candidates.length > 0 && (
        <ul className="mt-1 max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {candidates.map((hit) => {
            const Icon = MENTION_ICONS[hit.kind];
            return (
              <li key={`${hit.kind}:${hit.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    onChange([...value, hit]);
                    setQ("");
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-subtle"
                >
                  <Icon className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{hit.name}</span>
                    {hit.detail && <span className="block truncate text-xs text-muted">{hit.detail}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {q && !hits.isFetching && candidates.length === 0 && <p className="mt-1 px-1 text-xs text-muted">Nobody by that name.</p>}
    </div>
  );
}
