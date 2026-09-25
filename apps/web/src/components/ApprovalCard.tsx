import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ExternalLink, Mail, Plug, UserCheck, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import { keys, useAgents } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { Approval } from "../types.ts";
import { Badge, StatusPill } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { JsonDetails } from "./JsonView.tsx";
import { RecordTable } from "./KeyValue.tsx";
import { Markdown } from "./Markdown.tsx";

export function useDecideApproval() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, approved, note }: { id: string; approved: boolean; note?: string }) =>
      api.post<Approval>(path(`/approvals/${encodeURIComponent(id)}/decide`), { approved, note }),
    onSuccess: (approval, vars) => {
      void queryClient.invalidateQueries({ queryKey: keys.approvals(company) });
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
      void queryClient.invalidateQueries({ queryKey: keys.mail(company) });
      void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
      toast.success(vars.approved ? "Approved — the agent continues" : "Rejected", {
        description: approval.title,
        link: approval.runId ? { to: `/runs/${approval.runId}`, label: "View run" } : undefined,
      });
    },
    onError: (error) => toast.error(error),
  });
}

/** What happens when the approval is granted: a system write, an outgoing email, or a plain decision. */
export function ActionPreview({ approval }: { approval: Approval }) {
  const action = approval.action;
  if (action.type === "mail.send") {
    return (
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-subtle/60 px-3 py-2 text-xs font-medium text-muted">
          <Mail className="size-3.5" /> Email to be sent
        </div>
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
          <dt className="text-muted">To</dt>
          <dd className="min-w-0 break-words text-fg">{action.to}</dd>
          <dt className="text-muted">Subject</dt>
          <dd className="min-w-0 font-medium break-words text-fg">{action.subject}</dd>
        </dl>
        <div className="max-h-72 overflow-y-auto border-t border-line px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{action.body}</div>
      </div>
    );
  }
  if (action.type === "connector") {
    return (
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-3 py-2 text-xs text-muted">
          <Plug className="size-3.5" />
          <span className="font-medium text-fg">{action.system ?? action.category.toUpperCase()}</span>
          <span>·</span>
          <span>{action.operationName ?? action.operation}</span>
          <Badge size="xs" tone="amber">
            writes data
          </Badge>
        </div>
        <div className="px-3 py-1">
          <RecordTable data={action.input ?? {}} />
        </div>
      </div>
    );
  }
  return null;
}

export function ApprovalCard({ approval, showAgent = true, className }: { approval: Approval; showAgent?: boolean; className?: string }) {
  const decide = useDecideApproval();
  const agents = useAgents();
  const agentName = approval.agentName ?? agents.data?.find((a) => a.id === approval.agentId)?.name ?? "Agent";
  const [note, setNote] = useState("");
  const pending = approval.status === "pending";
  const busy = decide.isPending && decide.variables?.id === approval.id;
  const result = "result" in approval.action ? approval.action.result : undefined;
  const failure = "error" in approval.action ? approval.action.error : undefined;
  return (
    <div className={clsx("rounded-xl border bg-surface shadow-xs", pending ? "border-amber-200 dark:border-amber-400/25" : "border-line", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={clsx(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              pending ? "bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300" : "bg-subtle text-muted",
            )}
          >
            {approval.action.type === "mail.send" ? (
              <Mail className="size-4" />
            ) : approval.action.type === "connector" ? (
              <Plug className="size-4" />
            ) : (
              <UserCheck className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{approval.title}</p>
            <p className="mt-0.5 text-xs text-muted">
              {showAgent && <span className="font-medium text-fg/80">{agentName}</span>}
              {showAgent && " · "}
              <span title={formatDateTime(approval.createdAt)}>{timeAgo(approval.createdAt)}</span>
              {approval.assigneeRole && ` · for ${approval.assigneeRole}`}
              {approval.origin === "deferred" && " · requested during a conversation"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={approval.status} size="xs" />
          {approval.runId && (
            <Link
              to={`/runs/${approval.runId}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
            >
              Run <ExternalLink className="size-3" />
            </Link>
          )}
        </div>
      </div>
      <div className="space-y-3 px-4 py-3">
        {approval.reason && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
            <span className="font-semibold">Why you are asked:</span> {approval.reason}
          </p>
        )}
        {approval.details && (
          <Markdown compact breaks className="max-h-80 overflow-y-auto text-[13px]">
            {approval.details}
          </Markdown>
        )}
        <ActionPreview approval={approval} />
        {!pending && (
          <p className="text-xs text-muted">
            {approval.status === "approved" ? "Approved" : approval.status === "rejected" ? "Rejected" : "Closed"}
            {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
            {approval.decidedAt ? ` · ${formatDateTime(approval.decidedAt)}` : ""}
            {approval.decisionNote ? ` — “${approval.decisionNote}”` : ""}
          </p>
        )}
        {failure && <p className="text-xs text-red-600 dark:text-red-400">Execution failed: {failure}</p>}
        {result !== undefined && result !== null && <JsonDetails data={result} label="Result" />}
      </div>
      {pending && (
        <div className="flex flex-col gap-2 border-t border-line bg-subtle/40 px-4 py-3 sm:flex-row sm:items-center">
          <input
            className="input h-9 flex-1 py-1.5"
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Decision note"
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="md"
              icon={X}
              disabled={busy}
              loading={busy && decide.variables?.approved === false}
              onClick={() => decide.mutate({ id: approval.id, approved: false, note: note.trim() || undefined })}
            >
              Reject
            </Button>
            <Button
              variant="success"
              size="md"
              icon={Check}
              disabled={busy}
              loading={busy && decide.variables?.approved === true}
              onClick={() => decide.mutate({ id: approval.id, approved: true, note: note.trim() || undefined })}
            >
              Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
