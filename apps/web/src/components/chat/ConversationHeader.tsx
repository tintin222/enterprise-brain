import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Archive, ArrowLeft, ExternalLink, Lock, LogOut, MoreHorizontal, Pencil, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { KIND_META, VISIBILITY_LABELS, channelName, conversationTitle, isBuiltInChannel, participantActor } from "../../lib/conversations.ts";
import { paths } from "../../lib/paths.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationView as ConversationData } from "../../types.ts";
import { Button, ButtonLink } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Field } from "../Form.tsx";
import { ActorAvatar } from "./Actors.tsx";

/** A channel's name and description change (not a built-in channel's: those follow their department). */
function RenameDialog({ view, open, onClose }: { view: ConversationData; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { conversation } = view;
  const [name, setName] = useState(conversation.name ?? "");
  const [title, setTitle] = useState(conversation.title);
  useEffect(() => {
    if (open) {
      setName(conversation.name ?? "");
      setTitle(conversation.title);
    }
  }, [open, conversation.name, conversation.title]);
  const save = useMutation({
    mutationFn: () => api.patch(path(`/conversations/${encodeURIComponent(conversation.id)}`), { name: channelName(name), title: title.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const shown = channelName(name);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename the channel"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!shown} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint={shown && shown !== name ? `Will be #${shown}` : "Lowercase letters, digits and hyphens."}>
          {(id) => (
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted">#</span>
              <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
          )}
        </Field>
        <Field label="Description" hint="Optional: what the channel is for.">
          {(id) => (
            <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Invoices, payments and the month's close" />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** The "…" menu of a channel: rename and archive (its owner, managers), leave (members). */
function Menu({ view, onRename, onLeave, onArchive }: { view: ConversationData; onRename: () => void; onLeave: () => void; onArchive: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const { conversation, canManage, canLeave } = view;
  const manageable = canManage && conversation.kind === "channel" && !isBuiltInChannel(conversation) && conversation.status === "open";
  if (!manageable && !canLeave) return null;
  const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg hover:bg-subtle";
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="ghost" icon={MoreHorizontal} onClick={() => setOpen((v) => !v)} aria-label="More" aria-expanded={open} aria-haspopup="menu" />
      {open && (
        <div role="menu" className="absolute top-9 right-0 z-20 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg">
          {manageable && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            >
              <Pencil className="size-4 text-muted" /> Rename, describe
            </button>
          )}
          {canLeave && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onLeave();
              }}
            >
              <LogOut className="size-4 text-muted" /> Leave the channel
            </button>
          )}
          {manageable && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
            >
              <Archive className="size-4 text-muted" /> Archive the channel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** What a conversation is, under its name. */
function subtitle(view: ConversationData): string {
  const { conversation, participants } = view;
  const members = participants.length === 1 ? "1 member" : `${participants.length} members`;
  switch (conversation.kind) {
    case "channel":
      return [conversation.title, VISIBILITY_LABELS[conversation.visibility], members].filter(Boolean).join(" · ");
    case "dm":
      return participants.length > 2 ? `Direct message · ${participants.length} people` : "Direct message";
    case "ai_employee":
      return "Your talk with it: only you two read it";
    case "thread":
      return "Thread";
    default:
      return `${KIND_META[conversation.kind].label} · ${VISIBILITY_LABELS[conversation.visibility]} · ${members}`;
  }
}

/**
 * The top of a channel or direct message: its name, what it is, its members, the page it is about, and
 * the menu to rename, leave or archive it.
 */
export function ConversationHeader({ view, onBack, onMembers }: { view: ConversationData; onBack?: () => void; onMembers: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const { conversation, participants, me, about } = view;
  const myself = me ? participantActor(me) : null;
  const title = conversationTitle(conversation, participants, myself);
  const others = participants.filter((p) => !(myself && p.actorKind === myself.kind && p.actorId === myself.id));
  const Icon = conversation.kind === "channel" && conversation.visibility === "participants" ? Lock : KIND_META[conversation.kind].icon;
  const leave = useMutation({
    mutationFn: () => api.del(path(`/conversations/${encodeURIComponent(conversation.id)}/participants/${myself!.kind}/${encodeURIComponent(myself!.id)}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      toast.success(`You left ${title}`);
      navigate(paths.chat());
    },
    onError: (error) => toast.error(error),
  });
  const archive = useMutation({
    mutationFn: () => api.post(path(`/conversations/${encodeURIComponent(conversation.id)}/archive`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      setArchiving(false);
      toast.success(`${title} is archived`);
    },
    onError: (error) => toast.error(error),
  });
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3 sm:px-5">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg lg:hidden"
          aria-label="Back to the list"
        >
          <ArrowLeft className="size-5" />
        </button>
      )}
      {conversation.kind === "dm" || conversation.kind === "ai_employee" ? (
        <span className="hidden sm:flex -space-x-1.5">
          {(others.length ? others : participants).slice(0, 3).map((p) => (
            <ActorAvatar key={p.id} actor={participantActor(p)} className="ring-2 ring-surface" />
          ))}
        </span>
      ) : (
        <Icon className="hidden size-5 shrink-0 text-muted sm:block" />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-fg">{title}</h1>
        <p className="truncate text-xs text-muted">{subtitle(view)}</p>
      </div>
      {about && (
        <ButtonLink to={about.href} size="sm" variant="ghost" icon={ExternalLink} title={about.label}>
          <span className="hidden sm:inline">{about.label}</span>
        </ButtonLink>
      )}
      {conversation.kind !== "ai_employee" && (
        <Button size="sm" variant="ghost" icon={Users} onClick={onMembers} aria-label="Members" title="Members">
          <span className={clsx("tabular-nums", participants.length > 99 && "hidden sm:inline")}>{participants.length}</span>
        </Button>
      )}
      <Menu view={view} onRename={() => setRenaming(true)} onLeave={() => leave.mutate()} onArchive={() => setArchiving(true)} />
      <RenameDialog view={view} open={renaming} onClose={() => setRenaming(false)} />
      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${title}?`}
        description="It stays readable for its members; nothing more is written in it."
        size="sm"
        footer={
          <>
            <Button onClick={() => setArchiving(false)}>Keep it</Button>
            <Button variant="danger" icon={Archive} loading={archive.isPending} onClick={() => archive.mutate()}>
              Archive
            </Button>
          </>
        }
      />
    </header>
  );
}
