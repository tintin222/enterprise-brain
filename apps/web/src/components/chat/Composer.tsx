import { clsx } from "clsx";
import { AtSign, CornerUpLeft, Paperclip, SendHorizontal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { withTokens } from "../../lib/mentions.ts";
import { useToast } from "../../lib/toast.tsx";
import type { MentionHit, MentionKind, StoredFile } from "../../types.ts";
import { Button } from "../Button.tsx";
import { FileChip } from "../Dropzone.tsx";
import { MentionPicker, useMentionHits } from "./MentionPicker.tsx";

export interface ComposerSend {
  /** The text with the picked names as tokens: `@[Invoice Processor](ai_employee:…)`. */
  text: string;
  fileIds: string[];
  replyToId: string | null;
}

/** An "@" being typed: where it starts, where the caret is, and what follows the "@". */
interface Typing {
  start: number;
  end: number;
  query: string;
}

/** The "@" the caret is in, if any ("me@x" inside a word is not one). */
function typingAt(text: string, caret: number): Typing | null {
  const match = /(?:^|[\s(])@([^@\n]{0,40})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.startsWith(" ")) return null;
  return { start: caret - query.length - 1, end: caret, query };
}

const sameTyping = (a: Typing | null, b: Typing | null) =>
  a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end && a.query === b.query);

/**
 * The one text box of a conversation: Enter sends, Shift+Enter breaks the line, "@" offers people, AI
 * employees and assets (the text stays plain; picked names become tokens when the message is sent),
 * files go along with the message.
 */
export function Composer({
  conversationId,
  onSend,
  placeholder = "Write a message. @ names a person, an AI employee, or something of the company",
  disabled,
  autoFocus,
  replyTo,
  onCancelReply,
  mentionKinds,
  compact,
  className,
}: {
  conversationId: string | null;
  onSend: (message: ComposerSend) => Promise<unknown>;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  replyTo?: { id: string; author: string; text: string } | null;
  onCancelReply?: () => void;
  mentionKinds?: MentionKind[];
  /** Without the hint line. */
  compact?: boolean;
  className?: string;
}) {
  const { path } = useCompany();
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [picked, setPicked] = useState<MentionHit[]>([]);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** An "@" the person closed the list for (Escape): no list for it until the caret leaves it. */
  const dismissed = useRef<number | null>(null);
  const hits = useMentionHits(typing ? typing.query : null, { conversationId, kinds: mentionKinds });
  const list = typing ? (hits.data ?? []) : [];

  useEffect(() => setActive(0), [typing?.query]);
  // A stray "@" in a sentence: once a space follows it and nothing matches, stop offering names.
  useEffect(() => {
    if (typing && !hits.isFetching && hits.data && hits.data.length === 0 && /\s/.test(typing.query)) {
      dismissed.current = typing.start;
      setTyping(null);
    }
  }, [typing, hits.data, hits.isFetching]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  const track = (el: HTMLTextAreaElement) => {
    const next = typingAt(el.value, el.selectionStart ?? el.value.length);
    if (!next) dismissed.current = null;
    else if (dismissed.current === next.start) return setTyping(null);
    setTyping((current) => (sameTyping(current, next) ? current : next));
  };
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    track(e.target);
  };

  const placeCaret = (position: number, then?: () => void) => {
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
      then?.();
    });
  };

  const pick = (hit: MentionHit) => {
    if (!typing) return;
    const insert = `@${hit.name} `;
    setText(text.slice(0, typing.start) + insert + text.slice(typing.end));
    setPicked((p) => [...p.filter((x) => !(x.kind === hit.kind && x.id === hit.id)), hit]);
    setTyping(null);
    placeCaret(typing.start + insert.length);
  };

  /** The "@" button: an "@" at the caret, and the list. */
  const startMention = () => {
    const el = area.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const needsSpace = caret > 0 && !/\s/.test(text[caret - 1] ?? "");
    const insert = `${needsSpace ? " " : ""}@`;
    setText(text.slice(0, caret) + insert + text.slice(caret));
    const position = caret + insert.length;
    dismissed.current = null;
    placeCaret(position, () => setTyping({ start: position - 1, end: position, query: "" }));
  };

  const send = async () => {
    const trimmed = text.trim();
    if ((!trimmed && !files.length) || sending || disabled) return;
    setSending(true);
    try {
      let fileIds: string[] = [];
      if (files.length) {
        const form = new FormData();
        for (const file of files) form.append("file", file, file.name);
        fileIds = (await api.upload<StoredFile[]>(path("/files"), form)).map((f) => f.id);
      }
      await onSend({ text: withTokens(trimmed, picked), fileIds, replyToId: replyTo?.id ?? null });
      setText("");
      setFiles([]);
      setPicked([]);
      setTyping(null);
      onCancelReply?.();
      requestAnimationFrame(() => area.current?.focus());
    } catch (error) {
      toast.error(error);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (typing) {
      if (e.key === "ArrowDown" && list.length) {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, list.length - 1));
        return;
      }
      if (e.key === "ArrowUp" && list.length) {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && list[active]) {
        e.preventDefault();
        pick(list[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissed.current = typing.start;
        setTyping(null);
        return;
      }
    } else if (e.key === "Escape" && replyTo) {
      onCancelReply?.();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const canSend = !disabled && !sending && (Boolean(text.trim()) || files.length > 0);

  return (
    <div className={clsx("relative", className)}>
      {typing && (
        <MentionPicker
          className="absolute bottom-full left-0 z-30 mb-1.5"
          hits={list}
          active={active}
          looking={hits.isFetching}
          onHover={setActive}
          onPick={pick}
        />
      )}
      {replyTo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-subtle px-3 py-1.5 text-xs text-muted">
          <CornerUpLeft className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Replying to <span className="font-medium text-fg">{replyTo.author}</span>: {replyTo.text}
          </span>
          <button type="button" onClick={onCancelReply} className="rounded p-0.5 hover:bg-surface hover:text-fg" aria-label="Stop replying">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        className={clsx(
          "rounded-xl border border-line-strong bg-surface shadow-xs focus-within:border-brand-500 focus-within:ring-3 focus-within:ring-brand-500/20",
          disabled && "opacity-60",
        )}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
            {files.map((file, i) => (
              <FileChip key={`${file.name}-${i}`} name={file.name} size={file.size} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1 p-1.5">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || sending}
            className="rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg disabled:opacity-50"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              if (chosen.length) setFiles((current) => [...current, ...chosen]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) track(e.currentTarget);
            }}
            onClick={(e) => track(e.currentTarget)}
            placeholder={placeholder}
            aria-label="Message"
            disabled={disabled}
            autoFocus={autoFocus}
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-sm text-fg outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={startMention}
            disabled={disabled || sending}
            className="hidden rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg disabled:opacity-50 sm:block"
            aria-label="Name a person, an AI employee or an asset"
            title="Name a person, an AI employee or an asset (@)"
          >
            <AtSign className="size-4" />
          </button>
          <Button variant="primary" icon={SendHorizontal} loading={sending} disabled={!canSend} onClick={() => void send()} aria-label="Send">
            <span className="hidden sm:inline">Send</span>
          </Button>
        </div>
      </div>
      {!compact && (
        <p className="mt-1.5 px-1 text-[11px] text-faint">
          Enter sends, Shift+Enter starts a new line. Type @ to name a person, an AI employee, or something of the company: they can look it up.
        </p>
      )}
    </div>
  );
}
