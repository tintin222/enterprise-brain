import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { api, qs } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { MENTION_ICONS } from "../../lib/mentions.ts";
import { keys } from "../../lib/queries.ts";
import type { MentionHit, MentionKind } from "../../types.ts";

/** What "@" offers for a query: people, AI employees, things of the brain, data, files and tasks the viewer may see. */
export function useMentionHits(query: string | null, options: { conversationId?: string | null; kinds?: MentionKind[] } = {}) {
  const { company, path } = useCompany();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    if (query === null) {
      setDebounced(null);
      return;
    }
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const kinds = options.kinds?.join(",");
  return useQuery({
    queryKey: [...keys.conversations(company), "mention", { q: debounced, conversation: options.conversationId ?? null, kinds: kinds ?? null }],
    queryFn: () => api.get<MentionHit[]>(path(`/mention${qs({ q: debounced, conversation: options.conversationId ?? undefined, kinds })}`)),
    enabled: debounced !== null,
    placeholderData: (previous) => previous,
    staleTime: 20_000,
  });
}

/** The list under an "@": grouped, one row highlighted, picked with the keyboard or the mouse. */
export function MentionPicker({
  hits,
  active,
  looking,
  onHover,
  onPick,
  className,
}: {
  hits: MentionHit[];
  active: number;
  looking?: boolean;
  onHover: (index: number) => void;
  onPick: (hit: MentionHit) => void;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const groups: { name: string; items: { hit: MentionHit; index: number }[] }[] = [];
  hits.forEach((hit, index) => {
    let group = groups.find((g) => g.name === hit.group);
    if (!group) {
      group = { name: hit.group, items: [] };
      groups.push(group);
    }
    group.items.push({ hit, index });
  });
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Who or what to name"
      className={clsx("max-h-72 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl", className)}
    >
      {hits.length === 0 && <p className="px-3 py-2 text-xs text-muted">{looking ? "Looking…" : "Nothing found. Type part of a name."}</p>}
      {groups.map((group) => (
        <div key={group.name}>
          <p className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-faint uppercase">{group.name}</p>
          {group.items.map(({ hit, index }) => {
            const Icon = MENTION_ICONS[hit.kind];
            return (
              <button
                key={`${hit.kind}:${hit.id}`}
                type="button"
                role="option"
                aria-selected={index === active}
                data-index={index}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(hit)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                  index === active ? "bg-brand-50 dark:bg-brand-400/15" : "hover:bg-subtle",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{hit.name}</span>
                  {hit.detail && <span className="block truncate text-[11px] text-muted">{hit.detail}</span>}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
