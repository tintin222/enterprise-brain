import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { keys, useAgents } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { TaskRow } from "../types.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

/** Hand an AI employee work in plain words: it becomes a task it follows until it is done. */
export function useGiveWork(onDone?: (task: TaskRow) => void) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { agent: string; text: string }) => api.post<{ task: TaskRow }>(path("/tasks"), input),
    onSuccess: ({ task }) => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks(company) });
      void queryClient.invalidateQueries({ queryKey: keys.home(company) });
      toast.success(`Given as ${task.ref}`, { description: task.title, link: { to: `/work/${task.ref}`, label: "Follow it" } });
      onDone?.(task);
    },
    onError: (error) => toast.error(error),
  });
}

export function GiveWorkForm({ agent: fixed, onDone, compact }: { agent?: string; onDone?: (task: TaskRow) => void; compact?: boolean }) {
  const agents = useAgents();
  const [agent, setAgent] = useState(fixed ?? "");
  const [text, setText] = useState("");
  const give = useGiveWork((task) => {
    setText("");
    onDone?.(task);
  });
  const choices = (agents.data ?? []).filter((a) => a.status === "active" || a.status === "testing").sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (fixed) setAgent(fixed);
  }, [fixed]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (agent && text.trim().length >= 3) give.mutate({ agent, text: text.trim() });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      {!fixed && (
        <div>
          <label className="label" htmlFor="give-agent">
            AI employee
          </label>
          <select id="give-agent" className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose who does it…</option>
            {choices.map((a) => (
              <option key={a.id} value={a.slug}>
                {a.name}
                {a.title ? ` · ${a.title}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        {!compact && (
          <label className="label" htmlFor="give-text">
            What should it do?
          </label>
        )}
        <textarea
          id="give-text"
          className="input min-h-24"
          placeholder="e.g. Check the invoices from Kaya Çelik this month against their orders and tell me what differs."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="hint">It becomes a task: it asks you when it needs to, waits for replies, and you can follow every step under Work.</p>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" icon={Send} loading={give.isPending} disabled={!agent || text.trim().length < 3}>
          Give the work
        </Button>
      </div>
    </form>
  );
}

export function GiveWorkDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent?: string }) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onClose={onClose} title="Give work to an AI employee" description="Say what you need in your own words, as you would to a colleague.">
      <GiveWorkForm
        agent={agent}
        onDone={(task) => {
          onClose();
          navigate(`/work/${task.ref}`);
        }}
      />
    </Dialog>
  );
}
