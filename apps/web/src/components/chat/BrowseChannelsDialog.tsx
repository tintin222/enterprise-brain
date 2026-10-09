import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hash, Lock, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { paths } from "../../lib/paths.ts";
import { keys, useConversations } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationSummary } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Skeleton } from "../Spinner.tsx";

/** The channels the viewer may read: the company's, their departments', and the private ones they are in. Join one, or open it. */
export function BrowseChannelsDialog({ open, onClose, onNew }: { open: boolean; onClose: () => void; onNew: () => void }) {
  const { company, path } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const list = useConversations({ scope: "department", kinds: ["channel"], limit: 200, enabled: open });
  const join = useMutation({
    mutationFn: (item: ConversationSummary) => api.post(path(`/conversations/${encodeURIComponent(item.conversation.id)}/join`)),
    onSuccess: (_, item) => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      toast.success(`You are in #${item.conversation.name}`);
      onClose();
      navigate(paths.conversation(item.conversation.id));
    },
    onError: (error) => toast.error(error),
  });
  const needle = q.trim().toLowerCase();
  const items = (list.data ?? [])
    .filter((c) => !needle || (c.conversation.name ?? "").includes(needle) || c.conversation.title.toLowerCase().includes(needle))
    .sort((a, b) => (a.conversation.name ?? "").localeCompare(b.conversation.name ?? ""));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Channels"
      description="Every channel you may read. Join one to write in it and to see it in your list."
      footer={
        <Button
          icon={Plus}
          onClick={() => {
            onClose();
            onNew();
          }}
        >
          New channel
        </Button>
      }
    >
      <input className="input" placeholder="Find a channel…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Find a channel" />
      {list.isLoading && <Skeleton className="mt-3 h-32" />}
      {list.data && (
        <ul className="mt-3 max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {items.length === 0 && <li className="px-3 py-3 text-sm text-muted">{needle ? "No channel by that name." : "No channels yet."}</li>}
          {items.map((item) => {
            const { conversation } = item;
            const Icon = conversation.visibility === "participants" ? Lock : Hash;
            return (
              <li key={conversation.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">#{conversation.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {[conversation.title, item.members === 1 ? "1 member" : `${item.members} members`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {item.me ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      onClose();
                      navigate(paths.conversation(conversation.id));
                    }}
                  >
                    Open
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="soft"
                    loading={join.isPending && join.variables?.conversation.id === conversation.id}
                    onClick={() => join.mutate(item)}
                  >
                    Join
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
