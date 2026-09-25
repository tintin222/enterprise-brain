import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Clock, FlaskConical, Inbox, MessageSquarePlus, Paperclip, Play, Rocket, Settings2, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, qs } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { timeAgo } from "../lib/format.ts";
import { archetypeIcon } from "../lib/icons.tsx";
import { describeTrigger } from "../lib/labels.ts";
import { keys, useMailboxes, useRuns } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDetail, Conversation, MailMessage, RunRow } from "../types.ts";
import { StatusPill } from "./Badge.tsx";
import { Button, ButtonLink } from "./Button.tsx";
import { Card, CardHeader } from "./Card.tsx";
import { ChatPanel } from "./Chat.tsx";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { CellValue } from "./OutputView.tsx";
import { LiveRunResult, RunForm, RunsTable } from "./RunViews.tsx";
import { Callout, ErrorState, Skeleton } from "./Spinner.tsx";
import { useDocumentTitle } from "../lib/title.ts";

function useActivate(slug: string) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.post(path(`/agents/${encodeURIComponent(slug)}/status`), { status: "active" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success("Put to work");
    },
    onError: (error) => toast.error(error),
  });
}

function StatusBanner({ detail }: { detail: AgentDetail }) {
  const activate = useActivate(detail.agent.slug);
  const status = detail.agent.status;
  if (status === "active") return null;
  const text =
    status === "testing"
      ? "On trial: results are for review, and its duties (like incoming email) stay off until it is put to work."
      : status === "draft"
        ? "A draft: you can try it here; put it to work to switch on its duties."
        : status === "paused"
          ? "Paused: you can still try it here; its duties are off."
          : "Let go.";
  return (
    <Callout
      tone="warning"
      icon={FlaskConical}
      title={status === "testing" ? "On trial" : status === "draft" ? "Draft" : status === "paused" ? "Paused" : "Let go"}
      className="mb-6"
      actions={
        status !== "archived" ? (
          <Button size="sm" variant="secondary" icon={Rocket} loading={activate.isPending} onClick={() => activate.mutate()}>
            Put to work
          </Button>
        ) : undefined
      }
    >
      {text}
    </Callout>
  );
}

function highlightKeys(detail: AgentDetail): string[] {
  const ui = detail.definition.ui;
  const keysList = ui.highlight?.length ? ui.highlight : detail.definition.outputs.slice(0, 3).map((f) => f.key);
  return keysList.slice(0, 4);
}

function History({ detail, title = "History" }: { detail: AgentDetail; title?: string }) {
  const runs = useRuns({ agent: detail.agent.slug, limit: 25 });
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle="Everything it did: click one for the full trail." icon={Clock} />
      {runs.error && <ErrorState error={runs.error} className="m-4" />}
      {runs.isLoading && <Skeleton className="m-4 h-24" />}
      {runs.data && (
        <RunsTable
          runs={runs.data}
          showAgent={false}
          highlight={highlightKeys(detail)}
          outputs={detail.definition.outputs}
          empty={<p className="px-5 py-8 text-center text-sm text-muted">No runs yet — results you produce here will be listed.</p>}
        />
      )}
    </Card>
  );
}

function FormResults({ detail }: { detail: AgentDetail }) {
  const [runId, setRunId] = useState<string | null>(null);
  const { definition } = detail;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={definition.ui.title ?? "Run"} subtitle={definition.ui.description ?? "Fill in the form and give it the work."} icon={Play} />
          <div className="p-5">
            <RunForm slug={detail.agent.slug} definition={definition} onStarted={(run) => setRunId(run.id)} />
          </div>
        </Card>
        <Card className={clsx(!runId && "border-dashed")}>
          <CardHeader title="Result" icon={Sparkles} />
          <div className="p-5">
            {runId ? (
              <LiveRunResult runId={runId} outputs={definition.outputs} highlight={definition.ui.highlight} onDismiss={() => setRunId(null)} />
            ) : (
              <EmptyState
                compact
                icon={Sparkles}
                title="Results appear here"
                description="Submit the form — you'll see it work step by step, then its result."
                className="border-0"
              />
            )}
          </div>
        </Card>
      </div>
      <History detail={detail} />
    </div>
  );
}

function ChatLayout({ detail }: { detail: AgentDetail }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const slug = detail.agent.slug;
  const conversations = useQuery({
    queryKey: [...keys.chat(company), "conversations", { agent: slug }],
    queryFn: () => api.get<Conversation[]>(path(`/chat/conversations${qs({ agent: slug })}`)),
  });
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const conversationId = selected === undefined ? (conversations.data?.[0]?.id ?? null) : selected;
  return (
    <Card className="flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <select
          className="input h-8 max-w-xs py-1 text-[13px]"
          value={conversationId ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
          aria-label="Conversation"
        >
          {!conversationId && <option value="">New conversation</option>}
          {(conversations.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {timeAgo(c.updatedAt)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" icon={MessageSquarePlus} onClick={() => setSelected(null)} className="ml-auto">
          New conversation
        </Button>
      </div>
      <ChatPanel
        key={conversationId ?? "new"}
        className="flex-1"
        conversationId={conversationId}
        agent={slug}
        assistantName={detail.definition.name}
        emptyTitle={detail.definition.ui.title ?? `Chat with ${detail.definition.name}`}
        emptyDescription={detail.definition.ui.description ?? detail.definition.summary}
        onConversationCreated={(id) => {
          setSelected(id);
          void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), "conversations"] });
        }}
      />
    </Card>
  );
}

function InboxLayout({ detail }: { detail: AgentDetail }) {
  const { company, path } = useCompany();
  const boxes = useMailboxes();
  const mailboxes = [
    ...new Set([
      ...detail.definition.triggers.flatMap((t) => (t.type === "mailbox" && t.mailbox !== "*" ? [t.mailbox.toLowerCase()] : [])),
      ...(boxes.data ?? []).filter((b) => b.agents.some((a) => a.id === detail.agent.id)).map((b) => b.mailbox),
    ]),
  ];
  const highlight = highlightKeys(detail).slice(0, 2);
  const outputs = new Map(detail.definition.outputs.map((f) => [f.key, f]));
  const messages = useQuery({
    queryKey: [...keys.mail(company), "messages", { mailboxes }],
    queryFn: async () => {
      const lists = await Promise.all(mailboxes.map((m) => api.get<MailMessage[]>(path(`/mail/messages${qs({ mailbox: m, direction: "inbound" })}`))));
      return lists.flat().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    },
    enabled: mailboxes.length > 0,
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Incoming email"
          subtitle={mailboxes.length ? `Listening to ${mailboxes.join(", ")}` : "It follows no mailbox yet."}
          icon={Inbox}
          actions={
            <ButtonLink size="sm" variant="secondary" to={`/settings/mailboxes${qs({ mailbox: mailboxes[0], compose: "1" })}`}>
              Simulate an email
            </ButtonLink>
          }
        />
        {messages.isLoading && <Skeleton className="m-4 h-24" />}
        {messages.error && <ErrorState error={messages.error} className="m-4" />}
        {messages.data && messages.data.length === 0 && (
          <EmptyState
            compact
            className="m-4"
            icon={Inbox}
            title="No email yet"
            description="Emails arriving in the mailbox appear here with what the AI employee did with them."
          />
        )}
        {messages.data && messages.data.length > 0 && (
          <ul className="divide-y divide-line">
            {messages.data.slice(0, 50).map((m) => (
              <li key={m.id}>
                <Link to={`/settings/mailboxes${qs({ mailbox: m.mailbox, message: m.id })}`} className="flex items-center gap-3 px-5 py-3 hover:bg-subtle/60">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm">
                      <span className="truncate font-medium text-fg">{m.fromName ?? m.fromAddress}</span>
                      {m.attachments.length > 0 && <Paperclip className="size-3.5 shrink-0 text-faint" />}
                    </p>
                    <p className="truncate text-[13px] text-muted">{m.subject}</p>
                  </div>
                  {m.classification && highlight.length > 0 && (
                    <span className="hidden max-w-[16rem] shrink-0 items-center gap-2 md:flex">
                      {highlight.map((k) => (
                        <CellValue key={k} name={k} value={m.classification?.[k]} field={outputs.get(k)} />
                      ))}
                    </span>
                  )}
                  <StatusPill status={m.status} size="xs" />
                  <span className="hidden w-24 shrink-0 text-right text-xs text-faint sm:block">{timeAgo(m.receivedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <History detail={detail} title="Processing history" />
    </div>
  );
}

function TableLayout({ detail }: { detail: AgentDetail }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const runNow = useMutation({
    mutationFn: () => api.post<RunRow>(path(`/agents/${encodeURIComponent(detail.agent.slug)}/runs`), { input: {}, wait: false }),
    onSuccess: (run) => {
      setRunId(run.id);
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
    },
    onError: (error) => toast.error(error),
  });
  const hasInputs = detail.definition.inputs.length > 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={Play} loading={runNow.isPending} onClick={() => (hasInputs ? setOpen(true) : runNow.mutate())}>
          Run now
        </Button>
        <span className="text-sm text-muted">{detail.definition.triggers.map(describeTrigger).join(" · ")}</span>
      </div>
      {runId && (
        <Card className="p-5">
          <LiveRunResult runId={runId} outputs={detail.definition.outputs} highlight={detail.definition.ui.highlight} onDismiss={() => setRunId(null)} />
        </Card>
      )}
      <History detail={detail} />
      <Dialog open={open} onClose={() => setOpen(false)} title={`Run ${detail.definition.name}`} size="lg">
        <RunForm
          slug={detail.agent.slug}
          definition={detail.definition}
          onStarted={(run) => {
            setRunId(run.id);
            setOpen(false);
          }}
        />
      </Dialog>
    </div>
  );
}

/** The generated app of an agent, driven by its definition's `ui.layout`. */
export function AgentAppView({ detail, showHeader = true }: { detail: AgentDetail; showHeader?: boolean }) {
  const { definition, agent } = detail;
  const Icon = archetypeIcon(definition.archetype);
  useDocumentTitle(definition.ui.title ?? definition.name);
  const automatic = definition.triggers.filter((t) => t.type !== "manual" && t.type !== "form" && t.type !== "chat");
  return (
    <div>
      {showHeader && (
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
              <Icon className="size-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{definition.ui.title ?? definition.name}</h1>
                <StatusPill status={agent.status} />
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted">{definition.summary}</p>
              {automatic.length > 0 && <p className="mt-1.5 text-xs text-faint">Also runs automatically: {automatic.map(describeTrigger).join(" · ")}</p>}
            </div>
          </div>
          <ButtonLink to={`/ai/${agent.slug}`} variant="secondary" size="sm" icon={Settings2}>
            Agent details
          </ButtonLink>
        </div>
      )}
      <StatusBanner detail={detail} />
      {definition.ui.layout === "chat" ? (
        <ChatLayout detail={detail} />
      ) : definition.ui.layout === "inbox" ? (
        <InboxLayout detail={detail} />
      ) : definition.ui.layout === "table" ? (
        <TableLayout detail={detail} />
      ) : definition.ui.layout === "none" ? (
        <div className="space-y-6">
          <EmptyState icon={Sparkles} title="It works in the background" description="It has no screen of its own; its runs appear below." />
          <History detail={detail} />
        </div>
      ) : (
        <FormResults detail={detail} />
      )}
    </div>
  );
}
