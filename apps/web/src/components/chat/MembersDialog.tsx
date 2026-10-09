import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { conversationTitle, participantActor, sameActor } from "../../lib/conversations.ts";
import { paths } from "../../lib/paths.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationView as ConversationData, MentionHit } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { ActorAvatar } from "./Actors.tsx";
import { PeoplePicker } from "./PeoplePicker.tsx";

/** Who is in a conversation: bring people and AI employees in, remove them (its owner, managers), or leave. */
export function MembersDialog({ view, open, onClose }: { view: ConversationData; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { conversation, participants, me, canInvite, canLeave } = view;
  const [adding, setAdding] = useState<MentionHit[]>([]);
  const id = conversation.id;
  const base = path(`/conversations/${encodeURIComponent(id)}`);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), id], exact: true });
    void queryClient.invalidateQueries({ queryKey: [...keys.conversations(company), "list"] });
  };
  const add = useMutation({
    mutationFn: async (hits: MentionHit[]) => {
      for (const hit of hits) await api.post(`${base}/participants`, { kind: hit.kind, id: hit.id });
    },
    onSuccess: (_, hits) => {
      toast.success(hits.length === 1 ? `${hits[0]!.name} is in` : `${hits.length} brought in`);
      setAdding([]);
      refresh();
    },
    onError: (error) => toast.error(error),
  });
  const remove = useMutation({
    mutationFn: (actor: { kind: string; id: string }) => api.del(`${base}/participants/${actor.kind}/${encodeURIComponent(actor.id)}`),
    onSuccess: (_, actor) => {
      refresh();
      if (me && sameActor(participantActor(me), actor as { kind: "person"; id: string })) {
        onClose();
        navigate(paths.chat());
      }
    },
    onError: (error) => toast.error(error),
  });
  const fixed = conversation.kind === "dm" || conversation.kind === "thread" || conversation.kind === "ai_employee";
  const mayAdd = !fixed && conversation.status === "open" && (canInvite || Boolean(me));
  const present = new Set(participants.map((p) => `${p.actorKind}:${p.actorId}`));
  const title = conversationTitle(conversation, participants, me ? participantActor(me) : null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${participants.length === 1 ? "1 member" : `${participants.length} members`} · ${title}`}
      description={
        conversation.kind === "dm"
          ? "A direct message's people are fixed: start a new one to write to someone else as well."
          : "Everyone here reads the whole conversation."
      }
      footer={
        canLeave && me ? (
          <Button icon={LogOut} loading={remove.isPending} onClick={() => remove.mutate(participantActor(me))}>
            Leave {title}
          </Button>
        ) : undefined
      }
    >
      {mayAdd && (
        <div className="mb-4">
          <PeoplePicker
            value={adding}
            onChange={setAdding}
            scope={conversation.kind === "channel" ? "company" : undefined}
            conversationId={id}
            exclude={present}
            placeholder="Bring someone in…"
          />
          {adding.length > 0 && (
            <Button className="mt-2" size="sm" variant="primary" icon={UserPlus} loading={add.isPending} onClick={() => add.mutate(adding)}>
              Add {adding.length === 1 ? adding[0]!.name : `${adding.length} people`}
            </Button>
          )}
        </div>
      )}
      <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {participants.map((p) => {
          const actor = participantActor(p);
          const isMe = me ? sameActor(actor, participantActor(me)) : false;
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <ActorAvatar actor={actor} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                  <span className="truncate">{p.actorName}</span>
                  {isMe && <span className="text-xs font-normal text-muted">(you)</span>}
                  {p.actorKind === "ai_employee" && (
                    <Badge size="xs" tone="brand">
                      AI
                    </Badge>
                  )}
                  {p.role === "owner" && <Badge size="xs">Owner</Badge>}
                </span>
                {p.invitedBy && <span className="block truncate text-xs text-muted">Brought in by {p.invitedBy.name}</span>}
              </span>
              {canInvite && !isMe && !fixed && conversation.status === "open" && (
                <Button
                  size="xs"
                  variant="ghost"
                  icon={UserMinus}
                  loading={remove.isPending && remove.variables?.id === p.actorId}
                  onClick={() => remove.mutate(actor)}
                  aria-label={`Remove ${p.actorName}`}
                >
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
