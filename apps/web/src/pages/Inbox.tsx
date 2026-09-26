import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeft, Bot, Inbox as InboxIcon, Mail, MailPlus, Paperclip, Play, Send } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { api, qs } from "../api.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { StatusPill } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Card, PageHeader } from "../components/Card.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Dropzone, FileChip } from "../components/Dropzone.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FileLink } from "../components/FileLink.tsx";
import { Field } from "../components/Form.tsx";
import { Page } from "../components/Layout.tsx";
import { OutputView } from "../components/OutputView.tsx";
import { useRunDetail } from "../components/RunViews.tsx";
import { ErrorState, Skeleton, Spinner } from "../components/Spinner.tsx";
import { Segmented } from "../components/Tabs.tsx";
import { useViewer } from "../lib/auth.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatBytes, formatDateTime, plural, timeAgo } from "../lib/format.ts";
import { keys, useAgents, useDemoFiles, useMailboxes } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { MailMessage, MailMessageDetail, RunRow, StoredFile } from "../types.ts";

// ---------------------------------------------------------------------------
// Simulate incoming email
// ---------------------------------------------------------------------------

function ComposeDialog({
  open,
  onClose,
  mailboxes,
  initialMailbox,
  onDelivered,
}: {
  open: boolean;
  onClose: () => void;
  mailboxes: string[];
  initialMailbox?: string;
  onDelivered: (m: MailMessage) => void;
}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ mailbox: initialMailbox ?? mailboxes[0] ?? "", from: "", fromName: "", subject: "", body: "" });
  const [files, setFiles] = useState<File[]>([]);
  // Bundled sample CVs and invoices, attached by reference.
  const demo = useDemoFiles();
  const [demoFiles, setDemoFiles] = useState<StoredFile[]>([]);
  useEffect(() => {
    if (open) setForm((f) => ({ ...f, mailbox: initialMailbox ?? f.mailbox ?? mailboxes[0] ?? "" }));
  }, [open, initialMailbox, mailboxes]);

  const deliver = useMutation({
    mutationFn: () => {
      if (files.length) {
        const data = new FormData();
        for (const [k, v] of Object.entries(form)) if (v) data.append(k, v);
        if (demoFiles.length) data.append("attachmentFileIds", demoFiles.map((f) => f.id).join(","));
        for (const f of files) data.append("attachments", f, f.name);
        return api.upload<{ message: MailMessage; runs: { id: string; agentId: string; status: string }[] }>(path("/mail/messages"), data);
      }
      return api.post<{ message: MailMessage; runs: { id: string; agentId: string; status: string }[] }>(path("/mail/messages"), {
        mailbox: form.mailbox,
        from: form.from,
        fromName: form.fromName || undefined,
        subject: form.subject,
        body: form.body,
        attachmentFileIds: demoFiles.map((f) => f.id),
      });
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.mail(company) });
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
      toast.success("Email delivered", {
        description: res.runs.length
          ? `${res.runs.length} AI employee${res.runs.length === 1 ? "" : "s"} started on it.`
          : "No AI employee follows this mailbox: give it to one below.",
      });
      setForm((f) => ({ ...f, from: "", fromName: "", subject: "", body: "" }));
      setFiles([]);
      setDemoFiles([]);
      onDelivered(res.message);
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.mailbox || !form.from || !form.subject) return;
    deliver.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Simulate an incoming email"
      description="Delivers a message to a demo mailbox. AI employees following that mailbox start on it by themselves."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={Send}
            loading={deliver.isPending}
            onClick={() => deliver.mutate()}
            disabled={!form.mailbox || !form.from || !form.subject}
          >
            Deliver email
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="To mailbox" required hint="Pick a mailbox or type any address (e.g. careers@acme.com.tr).">
          {(id) => (
            <>
              <input
                id={id}
                className="input"
                list="eb-mailboxes"
                value={form.mailbox}
                onChange={(e) => setForm({ ...form, mailbox: e.target.value })}
                placeholder="info@company.com"
              />
              <datalist id="eb-mailboxes">
                {mailboxes.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="From" required>
            {(id) => (
              <input
                id={id}
                type="email"
                className="input"
                placeholder="jane.doe@example.com"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            )}
          </Field>
          <Field label="Sender name" optional>
            {(id) => (
              <input id={id} className="input" placeholder="Jane Doe" value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
            )}
          </Field>
        </div>
        <Field label="Subject" required>
          {(id) => <input id={id} className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}
        </Field>
        <Field label="Body">
          {(id) => <textarea id={id} rows={6} className="input" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}
        </Field>
        <div>
          <span className="label">Attachments</span>
          <Dropzone compact onFiles={(f) => setFiles((prev) => [...prev, ...f])} label="Attach files (CVs, invoices, …)" />
          {demo.data && demo.data.size > 0 && (
            <select
              className="input mt-2 h-9 py-1 text-[13px]"
              value=""
              aria-label="Attach a demo file"
              onChange={(e) => {
                const file = [...demo.data.values()].flat().find((f) => f.id === e.target.value);
                if (file && !demoFiles.some((f) => f.id === file.id)) setDemoFiles([...demoFiles, file]);
              }}
            >
              <option value="">Or attach a demo file…</option>
              {[...demo.data.entries()].map(([set, list]) => (
                <optgroup key={set} label={set === "cv" ? "Sample CVs" : set === "invoice" ? "Sample supplier invoices" : set}>
                  {list.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {(files.length > 0 || demoFiles.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <FileChip key={`${f.name}-${i}`} name={f.name} size={f.size} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
              ))}
              {demoFiles.map((f) => (
                <FileChip key={f.id} name={f.name} size={f.size} onRemove={() => setDemoFiles(demoFiles.filter((d) => d.id !== f.id))} />
              ))}
            </div>
          )}
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Message detail
// ---------------------------------------------------------------------------

function LinkedRun({ runId }: { runId: string }) {
  const { data, isLoading } = useRunDetail(runId);
  if (isLoading) return <Skeleton className="h-24" />;
  if (!data) return null;
  return (
    <div className="rounded-xl border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <Bot className="size-4 text-muted" /> {data.agent?.name ?? "Agent"}
          <StatusPill status={data.run.status} size="xs" />
        </p>
        <Link to={`/runs/${runId}`} className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
          View run →
        </Link>
      </div>
      <div className="p-4">
        {data.run.status === "running" ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" /> Processing…
          </p>
        ) : data.run.output ? (
          <OutputView output={data.run.output} fields={data.agent?.outputs ?? []} highlight={data.agent?.ui?.highlight ?? []} />
        ) : data.run.error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{data.run.error}</p>
        ) : (
          <p className="text-sm text-muted">No result yet.</p>
        )}
      </div>
    </div>
  );
}

function MessageDetail({ id, onBack, canProcess }: { id: string; onBack: () => void; canProcess: boolean }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const agents = useAgents();
  const [agent, setAgent] = useState("");
  const detail = useQuery({
    queryKey: [...keys.mail(company), "message", id],
    queryFn: () => api.get<MailMessageDetail>(path(`/mail/messages/${encodeURIComponent(id)}`)),
    refetchInterval: (q) => (q.state.data?.message.status === "processing" || q.state.data?.run?.status === "running" ? 2000 : false),
  });
  const process = useMutation({
    mutationFn: (slug: string) => api.post<RunRow>(path(`/mail/messages/${encodeURIComponent(id)}/process`), { agent: slug, wait: true }),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: keys.mail(company) });
      void queryClient.invalidateQueries({ queryKey: keys.runs(company) });
      toast.success(run.status === "failed" ? "Processing failed" : "Processed", { link: { to: `/runs/${run.id}`, label: "View run" } });
    },
    onError: (e) => toast.error(e),
  });

  if (detail.isLoading) return <Skeleton className="m-4 h-64" />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} className="m-4" />;
  const { message, approvals } = detail.data;
  const candidates = (agents.data ?? []).filter((a) => a.status !== "archived");
  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <div className="space-y-5 p-5">
      <button type="button" onClick={onBack} className="-mt-1 mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg lg:hidden">
        <ArrowLeft className="size-4" /> Messages
      </button>
      <div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-fg">{message.subject || "(no subject)"}</h2>
          <StatusPill status={message.status} />
        </div>
        <p className="mt-1 text-sm text-muted">
          <span className="font-medium text-fg">{message.fromName ?? message.fromAddress}</span>
          {message.fromName && <span> &lt;{message.fromAddress}&gt;</span>} → {message.toAddresses.join(", ") || message.mailbox}
        </p>
        <p className="text-xs text-faint">{formatDateTime(message.receivedAt)}</p>
      </div>
      <div className="rounded-xl border border-line bg-subtle/30 p-4 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
        {message.bodyText || <span className="text-muted">(empty body)</span>}
      </div>
      {message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {message.attachments.map((a) => (
            <span key={a.fileId} className="inline-flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
              <FileLink fileId={a.fileId} name={a.name} />
              <span className="text-xs text-faint">{formatBytes(a.size)}</span>
            </span>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-fg">Waiting for approval</h3>
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}

      {message.runId && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">What the AI employee did</h3>
          <LinkedRun runId={message.runId} />
        </div>
      )}

      {canProcess && (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong p-3 sm:flex-row sm:items-center">
          <span className="text-sm text-muted">Process with…</span>
          <select className="input h-9 flex-1 py-1.5" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="AI employee">
            <option value="">Choose an AI employee</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.slug}>
                {a.name}
                {a.status !== "active" ? ` (${a.status})` : ""}
              </option>
            ))}
          </select>
          <Button variant="primary" icon={Play} disabled={!agent} loading={process.isPending} onClick={() => process.mutate(agent)}>
            Process
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Inbox() {
  const { company, path } = useCompany();
  const [params, setParams] = useSearchParams();
  const mailbox = params.get("mailbox") ?? "";
  const selected = params.get("message");
  const [compose, setCompose] = useState(params.get("compose") === "1");
  const mailboxes = useMailboxes();
  const agents = useAgents();
  const viewer = useViewer();
  // Managers and IT see every mailbox and can send test emails; the others read their departments' ones.
  const manages = !viewer || viewer.isAdmin || viewer.departments.some((d) => d.role === "manager");

  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const messages = useQuery({
    queryKey: [...keys.mail(company), "messages", { mailbox, direction }],
    queryFn: () => api.get<MailMessage[]>(path(`/mail/messages${qs({ mailbox: mailbox || undefined, direction })}`)),
    refetchInterval: 10_000,
  });

  const allMailboxes = useMemo(() => {
    const set = new Set((mailboxes.data ?? []).map((m) => m.mailbox));
    for (const a of agents.data ?? []) for (const t of a.triggers ?? []) if (t.type === "mailbox" && t.mailbox !== "*") set.add(t.mailbox.toLowerCase());
    return [...set].sort();
  }, [mailboxes.data, agents.data]);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("compose");
    setParams(next, { replace: key !== "message" });
  };

  const totalUnprocessed = (mailboxes.data ?? []).reduce((n, m) => n + m.unprocessed, 0);

  return (
    <Page wide>
      <PageHeader
        icon={InboxIcon}
        title="Mail"
        description="The shared mailboxes AI employees follow: each email, what the AI employee did with it, and any reply waiting for approval."
        actions={
          manages && (
            <Button variant="primary" icon={MailPlus} onClick={() => setCompose(true)}>
              Simulate incoming email
            </Button>
          )
        }
      />
      {!manages && mailboxes.data?.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No shared mailbox in your department"
          description="When an AI employee of your department follows a shared mailbox, its emails and what the AI employee did with them appear here."
        />
      ) : (
        <Card className="grid grid-cols-1 overflow-hidden lg:h-[calc(100dvh-14rem)] lg:min-h-[560px] lg:grid-cols-[240px_minmax(0,380px)_minmax(0,1fr)]">
          {/* Mailboxes */}
          <nav className={clsx("border-b border-line lg:overflow-y-auto lg:border-r lg:border-b-0", selected && "hidden lg:block")} aria-label="Mailboxes">
            <ul className="p-2">
              <li>
                <button
                  type="button"
                  onClick={() => set("mailbox", null)}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
                    !mailbox ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "hover:bg-subtle",
                  )}
                >
                  <InboxIcon className="size-4 shrink-0" />
                  <span className="flex-1 font-medium">All mailboxes</span>
                  {totalUnprocessed > 0 && (
                    <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-[18px] font-semibold text-white">{totalUnprocessed}</span>
                  )}
                </button>
              </li>
              {mailboxes.isLoading && <Skeleton className="m-2 h-24" />}
              {(mailboxes.data ?? []).map((m) => (
                <li key={m.mailbox}>
                  <button
                    type="button"
                    onClick={() => set("mailbox", m.mailbox)}
                    className={clsx("w-full rounded-lg px-3 py-2 text-left", mailbox === m.mailbox ? "bg-brand-50 dark:bg-brand-400/15" : "hover:bg-subtle")}
                  >
                    <span className="flex items-center gap-2">
                      <Mail className="size-4 shrink-0 text-muted" />
                      <span
                        className={clsx(
                          "min-w-0 flex-1 truncate text-sm font-medium",
                          mailbox === m.mailbox ? "text-brand-700 dark:text-brand-200" : "text-fg",
                        )}
                      >
                        {m.mailbox}
                      </span>
                      {m.unprocessed > 0 && (
                        <span className="rounded-full bg-subtle px-1.5 text-[11px] leading-[18px] font-semibold text-muted">{m.unprocessed}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block pl-6 text-xs text-faint">{plural(m.total, "message")}</span>
                    {m.agents.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1 pl-6">
                        {m.agents.map((a) => (
                          <span key={a.id} className="inline-flex items-center gap-1 text-[11px] text-muted">
                            <span className={clsx("size-1.5 rounded-full", a.status === "active" ? "bg-emerald-500" : "bg-slate-400")} />
                            {a.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Messages */}
          <div className={clsx("min-h-0 border-b border-line lg:overflow-y-auto lg:border-r lg:border-b-0", selected && "hidden lg:block")}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
              <Segmented
                value={direction}
                onChange={setDirection}
                options={[
                  { value: "inbound", label: "Received" },
                  { value: "outbound", label: "Sent" },
                ]}
              />
              {messages.data && <span className="text-xs text-faint">{plural(messages.data.length, "message")}</span>}
            </div>
            {messages.isLoading && <Skeleton className="m-4 h-40" />}
            {messages.error && <ErrorState error={messages.error} className="m-4" />}
            {messages.data && messages.data.length === 0 && (
              <EmptyState
                compact
                className="m-4"
                icon={Mail}
                title="No messages"
                description={manages ? "Send a test email to see an AI employee pick it up." : "Emails to your department's shared mailboxes appear here."}
                action={
                  manages && (
                    <Button size="sm" icon={MailPlus} onClick={() => setCompose(true)}>
                      Simulate email
                    </Button>
                  )
                }
              />
            )}
            <ul className="divide-y divide-line">
              {(messages.data ?? []).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => set("message", m.id)}
                    className={clsx(
                      "w-full px-4 py-3 text-left transition-colors",
                      selected === m.id ? "bg-brand-50/70 dark:bg-brand-400/10" : "hover:bg-subtle/60",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={clsx("min-w-0 flex-1 truncate text-sm", m.status === "new" ? "font-semibold text-fg" : "font-medium text-fg/90")}>
                        {m.direction === "outbound" ? `To ${m.toAddresses.join(", ") || "—"}` : (m.fromName ?? m.fromAddress)}
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">{timeAgo(m.receivedAt)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {m.attachments.length > 0 && <Paperclip className="size-3.5 shrink-0 text-faint" aria-label="Has attachments" />}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.subject || "(no subject)"}</span>
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <StatusPill status={m.status} size="xs" />
                      {!mailbox && <span className="truncate text-[11px] text-faint">{m.mailbox}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Detail */}
          <div className={clsx("min-h-0 lg:overflow-y-auto", !selected && "hidden lg:block")}>
            {selected ? (
              <MessageDetail key={selected} id={selected} onBack={() => set("message", null)} canProcess={manages} />
            ) : (
              <div className="flex h-full items-center justify-center p-8">
                <EmptyState
                  compact
                  icon={Mail}
                  title="Select a message"
                  description="See the email, its attachments, what the AI employee found and any reply waiting for approval."
                  className="border-0"
                />
              </div>
            )}
          </div>
        </Card>
      )}
      <ComposeDialog
        open={compose && manages}
        onClose={() => setCompose(false)}
        mailboxes={allMailboxes}
        initialMailbox={params.get("mailbox") ?? undefined}
        onDelivered={(m) => {
          const next = new URLSearchParams(params);
          next.set("message", m.id);
          next.delete("compose");
          setParams(next);
        }}
      />
    </Page>
  );
}
