import { useMutation } from "@tanstack/react-query";
import { clsx } from "clsx";
import { SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { REACTION_EMOJI } from "../../lib/conversations.ts";
import { useToast } from "../../lib/toast.tsx";
import type { Message } from "../../types.ts";

/** Reacting to a message (or taking the reaction back): the message comes back as it is now, for the page to show. */
export function useReact(onChanged: (message: Message) => void) {
  const { path } = useCompany();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ message, emoji, on }: { message: Message; emoji: string; on: boolean }) => {
      const url = path(
        `/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}/reactions/${encodeURIComponent(emoji)}`,
      );
      return on ? api.put<Message>(url) : api.del<Message>(url);
    },
    onSuccess: onChanged,
    onError: (error) => toast.error(error),
  });
}

/** The emoji to pick from, in a small grid; closes on a pick, a click elsewhere, or Escape. */
export function EmojiPicker({ onPick, onClose, className }: { onPick: (emoji: string) => void; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="React with"
      className={clsx("z-20 grid w-72 grid-cols-8 gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-lg", className)}
    >
      {REACTION_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          onClick={() => onPick(emoji)}
          className="flex size-8 items-center justify-center rounded-lg text-lg leading-none hover:bg-subtle"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/** The reactions under a message as chips (yours highlighted; a click toggles), and a way to add one. */
export function ReactionsBar({ message, canReact, onChanged }: { message: Message; canReact: boolean; onChanged: (message: Message) => void }) {
  const react = useReact(onChanged);
  const [picking, setPicking] = useState(false);
  if (!message.reactions.length) return null;
  const toggle = (emoji: string) => react.mutate({ message, emoji, on: !message.reactions.some((r) => r.emoji === emoji && r.me) });
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={!canReact}
          onClick={() => toggle(r.emoji)}
          aria-pressed={r.me}
          title={`${r.names.join(", ")}${r.count > r.names.length ? ` and ${r.count - r.names.length} more` : ""}`}
          className={clsx(
            "inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs tabular-nums",
            r.me
              ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200"
              : "border-line bg-surface text-fg/80 hover:border-line-strong",
          )}
        >
          <span aria-hidden="true">{r.emoji}</span>
          <span>{r.count}</span>
          <span className="sr-only">{r.emoji} reactions</span>
        </button>
      ))}
      {canReact && (
        <span className="relative">
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-line text-muted hover:border-line-strong hover:text-fg"
            aria-label="Add a reaction"
            aria-expanded={picking}
          >
            <SmilePlus className="size-3.5" />
          </button>
          {picking && (
            <EmojiPicker
              className="absolute bottom-7 left-0"
              onPick={(emoji) => {
                setPicking(false);
                toggle(emoji);
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </span>
      )}
    </div>
  );
}
