import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Brain, MessagesSquare, MessageSquarePlus, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ConversationList } from "../../components/chat/ConversationList.tsx";
import { ConversationView } from "../../components/chat/ConversationView.tsx";
import { useMentionHits } from "../../components/chat/MentionPicker.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { ErrorState, LoadingBlock, Skeleton } from "../../components/Spinner.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { MENTION_ICONS } from "../../lib/mentions.ts";
import { keys, useConversationFor, useConversations, type ConversationScope } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ConversationView as ConversationData, ConversationVisibility, MentionHit } from "../../types.ts";

const SCOPES: { id: ConversationScope; label: string; hint: string }[] = [
  { id: "mine", label: "Mine", hint: "Conversations you are in" },
  { id: "department", label: "My departments", hint: "Your departments' conversations, yours included" },
  { id: "all", label: "Everything", hint: "Every conversation you may see" },
];

const FOR_KINDS = ["task", "thing", "ai_employee"] as const;
type ForKind = (typeof FOR_KINDS)[number];

/** `/chat/for/:kind/:about`: the conversation about something, then its own address. */
function ResolveFor({ kind, about, q }: { kind: ForKind; about: string; q?: string }) {
  const navigate = useNavigate();
  const found = useConversationFor(kind, about);
  useEffect(() => {
    if (found.data) navigate(`/chat/${found.data.conversation.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`, { replace: true });
  }, [found.data, navigate, q]);
  if (found.error) {
    return (
      <div className="p-6">
        <ErrorState error={found.error} onRetry={() => void found.refetch()} />
      </div>
    );
  }
  return <LoadingBlock className="flex-1" />;
}

/** A new topic: who is in it, who may read it. The first message gives it its name. */
function NewConversationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const viewer = useViewer();
  const departments = viewer?.departments ?? [];
  const [title, setTitle] = useState("");
  const [who, setWho] = useState<MentionHit[]>([]);
  const [q, setQ] = useState("");
  const [visibility, setVisibility] = useState<ConversationVisibility>("participants");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const hits = useMentionHits(open ? q : null, { kinds: ["person", "ai_employee"] });
  const chosen = new Set(who.map((w) => `${w.kind}:${w.id}`));
  const candidates = (hits.data ?? []).filter((h) => !chosen.has(`${h.kind}:${h.id}`)).slice(0, 8);
  const create = useMutation({
    mutationFn: () =>
      api.post<ConversationData>(path("/conversations"), {
        title: title.trim() || undefined,
        participants: who.map((w) => ({ kind: w.kind, id: w.id })),
        visibility,
        departmentId: visibility === "department" ? departmentId : undefined,
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations(company) });
      setTitle("");
      setWho([]);
      setQ("");
      onClose();
      navigate(`/chat/${data.conversation.id}`);
    },
    onError: (error) => toast.error(error),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New conversation"
      description="People and AI employees together. Name anyone later with @, too."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={MessagesSquare} loading={create.isPending} onClick={() => create.mutate()}>
            Start
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="About" hint="Optional: the first message names it otherwise.">
          {(id) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kaya Çelik invoices" autoFocus />}
        </Field>
        <Field label="Who is in it">
          {(id) => (
            <div>
              {who.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {who.map((w) => {
                    const Icon = MENTION_ICONS[w.kind];
                    return (
                      <span
                        key={`${w.kind}:${w.id}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pr-1.5 pl-2 text-xs"
                      >
                        <Icon className="size-3.5 text-muted" />
                        <span className="font-medium text-fg">{w.name}</span>
                        <button
                          type="button"
                          onClick={() => setWho(who.filter((x) => x !== w))}
                          className="rounded p-0.5 text-faint hover:bg-subtle hover:text-fg"
                          aria-label={`Remove ${w.name}`}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <input
                id={id}
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="A colleague, an AI employee…"
                aria-label="Who to add"
              />
              {candidates.length > 0 && (
                <ul className="mt-1 max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {candidates.map((hit) => {
                    const Icon = MENTION_ICONS[hit.kind];
                    return (
                      <li key={`${hit.kind}:${hit.id}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setWho([...who, hit]);
                            setQ("");
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-subtle"
                        >
                          <Icon className="size-4 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-fg">{hit.name}</span>
                            {hit.detail && <span className="block truncate text-xs text-muted">{hit.detail}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </Field>
        <Field label="Who may read it">
          {(id) => (
            <div id={id} className="space-y-1.5" role="radiogroup">
              {(
                [
                  ["participants", "Only the people in it"],
                  ["department", "Everyone in a department"],
                  ["company", "Everyone in the company"],
                ] as [ConversationVisibility, string][]
              )
                .filter(([value]) => value !== "department" || departments.length > 0)
                .map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2 text-sm text-fg">
                    <input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} />
                    {label}
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
      </div>
    </Dialog>
  );
}

function Welcome({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={MessagesSquare}
        className="max-w-lg border-0"
        title="Pick a conversation, or start one"
        description="People and AI employees in one thread. Name anyone, or anything of the company, with @: the AI employees can look it up when they answer."
        action={
          <>
            <Button variant="primary" icon={MessageSquarePlus} onClick={onNew}>
              New conversation
            </Button>
            <Link
              to="/chat/for/ai_employee/company-brain"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg shadow-xs hover:bg-subtle"
            >
              <Brain className="size-4 text-brand-600 dark:text-brand-300" /> Ask the company brain
            </Link>
          </>
        }
      />
    </div>
  );
}

/** Chat: the viewer's conversations with people and AI employees. */
export default function Chat() {
  const { id, kind, about } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { info } = useCompany();
  useDocumentTitle("Chat");
  const [scope, setScope] = useState<ConversationScope>("mine");
  const [creating, setCreating] = useState(false);
  const list = useConversations({ scope });
  const legacy = params.get("c");
  const q = params.get("q") ?? undefined;
  const open = Boolean(id || kind);

  if (!open && legacy) return <Navigate to={`/chat/${encodeURIComponent(legacy)}`} replace />;

  const clearQ = () => {
    const next = new URLSearchParams(params);
    next.delete("q");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex min-h-0 flex-1 lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:overflow-hidden">
      <aside className={clsx("w-full shrink-0 flex-col border-r border-line bg-surface lg:flex lg:w-80", open ? "hidden" : "flex")}>
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold text-fg">Chat</h1>
          <Button size="xs" variant="soft" icon={MessageSquarePlus} onClick={() => setCreating(true)}>
            New
          </Button>
        </div>
        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5" role="tablist" aria-label="Which conversations">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              title={s.hint}
              onClick={() => setScope(s.id)}
              className={clsx("rounded-md px-2 py-1 text-xs font-medium", scope === s.id ? "bg-subtle text-fg" : "text-muted hover:text-fg")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.isLoading && <Skeleton className="m-2 h-24" />}
          {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
          {list.data && list.data.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted">
              {scope === "mine" ? "No conversations yet. Start one, or ask the company brain." : "Nothing here yet."}
            </p>
          )}
          {list.data && <ConversationList items={list.data} selectedId={id} onSelect={(c) => navigate(`/chat/${c}`)} />}
        </div>
        <div className="border-t border-line p-2">
          <Link
            to="/chat/for/ai_employee/company-brain"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-fg hover:bg-subtle"
          >
            <Brain className="size-4 text-brand-600 dark:text-brand-300" /> Ask the company brain
          </Link>
          <p className="flex items-start gap-1.5 px-3 pt-1 pb-1 text-[11px] leading-relaxed text-muted">
            <ShieldCheck className="mt-px size-3.5 shrink-0" />
            {info.llm.available
              ? "AI employees act with their level: a Supervised one asks before it changes anything."
              : "Offline mode: AI employees answer with what they find, without writing it up."}
          </p>
        </div>
      </aside>
      <div className={clsx("min-w-0 flex-1 flex-col", open ? "flex" : "hidden lg:flex")}>
        {kind && about ? (
          (FOR_KINDS as readonly string[]).includes(kind) ? (
            <ResolveFor kind={kind as ForKind} about={about} q={q} />
          ) : (
            <div className="p-6">
              <EmptyState
                icon={MessagesSquare}
                title="No such conversation"
                description="A conversation is about a task, a thing of the brain, or an AI employee."
              />
            </div>
          )
        ) : id ? (
          <ConversationView
            key={id}
            id={id}
            onBack={() => navigate("/chat")}
            initialText={q}
            onSentInitial={clearQ}
            className="min-h-[70vh] flex-1 lg:min-h-0"
          />
        ) : (
          <Welcome onNew={() => setCreating(true)} />
        )}
      </div>
      <NewConversationDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
