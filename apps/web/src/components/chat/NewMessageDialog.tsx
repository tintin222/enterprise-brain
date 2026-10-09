import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { paths } from "../../lib/paths.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationView as ConversationData, MentionHit } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { PeoplePicker } from "./PeoplePicker.tsx";

/** A direct message with one or more colleagues, or the talk with one AI employee. */
export function NewMessageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [who, setWho] = useState<MentionHit[]>([]);
  const ais = who.filter((w) => w.kind === "ai_employee").length;
  const mixed = ais > 0 && who.length > 1;
  const start = useMutation({
    mutationFn: () => api.post<ConversationData>(path("/conversations"), { kind: "dm", participants: who.map((w) => ({ kind: w.kind, id: w.id })) }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      setWho([]);
      onClose();
      navigate(paths.conversation(data.conversation.id));
    },
    onError: (error) => toast.error(error),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New message"
      description="To a colleague, a few of them, or an AI employee. Direct messages are read by nobody else."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={MessageSquarePlus} loading={start.isPending} disabled={who.length === 0 || mixed} onClick={() => start.mutate()}>
            Start
          </Button>
        </>
      }
    >
      <PeoplePicker value={who} onChange={setWho} scope="company" placeholder="A name…" autoFocus />
      {mixed && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">A message goes to people, or to one AI employee: in a channel you can name both.</p>
      )}
    </Dialog>
  );
}
