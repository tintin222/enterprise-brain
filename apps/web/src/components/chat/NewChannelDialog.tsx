import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { channelName } from "../../lib/conversations.ts";
import { paths } from "../../lib/paths.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationView as ConversationData, ConversationVisibility, MentionHit } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Field } from "../Form.tsx";
import { PeoplePicker } from "./PeoplePicker.tsx";

/** A new channel: its name, what it is for, who may read it, and who is in it from the start. */
export function NewChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const viewer = useViewer();
  const departments = viewer?.departments ?? [];
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ConversationVisibility>("company");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [who, setWho] = useState<MentionHit[]>([]);
  const shown = channelName(name);
  const reset = () => {
    setName("");
    setTitle("");
    setWho([]);
    setVisibility("company");
  };
  const create = useMutation({
    mutationFn: () =>
      api.post<ConversationData>(path("/conversations"), {
        kind: "channel",
        name: shown,
        title: title.trim() || undefined,
        visibility,
        departmentId: visibility === "department" ? departmentId : undefined,
        participants: who.map((w) => ({ kind: w.kind, id: w.id })),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      reset();
      onClose();
      navigate(paths.conversation(data.conversation.id));
    },
    onError: (error) => toast.error(error),
  });
  const choices: [ConversationVisibility, string, string][] = [
    ["company", "Public", "Everyone in the company can find and join it"],
    ["department", "A department", "Its people and IT read it; others can be brought in"],
    ["participants", "Private", "Only the people you bring in"],
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New channel"
      description="A place for a team, a project or a topic. Name AI employees with @ there to get their help."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Hash} loading={create.isPending} disabled={!shown} onClick={() => create.mutate()}>
            Create {shown ? `#${shown}` : "the channel"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint={shown && shown !== name ? `Will be #${shown}` : "Lowercase letters, digits and hyphens, like finance or q3-planning."}>
          {(id) => (
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted">#</span>
              <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="finance" autoFocus maxLength={80} />
            </div>
          )}
        </Field>
        <Field label="Description" hint="Optional: what the channel is for.">
          {(id) => (
            <input
              id={id}
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Invoices, payments and the month's close"
              maxLength={200}
            />
          )}
        </Field>
        <Field label="Who may read it">
          {(id) => (
            <div id={id} className="space-y-1.5" role="radiogroup">
              {choices
                .filter(([value]) => value !== "department" || departments.length > 0)
                .map(([value, label, hint]) => (
                  <label key={value} className="flex items-start gap-2 text-sm text-fg">
                    <input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} className="mt-1" />
                    <span>
                      <span className="font-medium">{label}</span>
                      <span className="block text-xs text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              {visibility === "department" && (
                <select className="input mt-1" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </Field>
        <Field
          label={visibility === "participants" ? "Who is in it" : "Who is in it from the start"}
          hint="Optional. Others join on their own, or you bring them in later."
        >
          {(id) => <PeoplePicker inputId={id} value={who} onChange={setWho} scope="company" />}
        </Field>
      </div>
    </Dialog>
  );
}
