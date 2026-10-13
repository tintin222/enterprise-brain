import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileInput, KeyRound, Power, RefreshCw, Save, Webhook } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { timeAgo } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentDefinition, AgentDetail, TriggerSpec } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Button, buttonClass } from "./Button.tsx";
import { Card, CardHeader } from "./Card.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Callout, ErrorState, LoadingBlock } from "./Spinner.tsx";

interface EndpointView {
  id: string;
  kind: "webhook" | "form";
  token: string;
  status: "on" | "off";
  hasSecret: boolean;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
}

interface Addresses {
  webhook: (EndpointView & { url: string; readableUrl: string }) | null;
  form: (EndpointView & { url: string }) | null;
}

type WebhookDuty = Extract<TriggerSpec, { type: "webhook" }>;
type FormDuty = Extract<TriggerSpec, { type: "form" }>;

function Copyable({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div>
      <p className="label">{label}</p>
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-subtle/50 py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={value}>
          {value}
        </code>
        <CopyButton text={value} iconOnly label={`Copy ${label.toLowerCase()}`} />
      </div>
      {hint && <p className="hint mt-1">{hint}</p>}
    </div>
  );
}

function usedText(view: EndpointView): string {
  if (!view.uses) return "Not used yet";
  return `Used ${view.uses} time${view.uses === 1 ? "" : "s"}, last ${view.lastUsedAt ? timeAgo(view.lastUsedAt) : "—"}`;
}

/**
 * How other systems and people reach the AI employee without signing in, for its managers: its webhook
 * address (the unguessable one, the readable one with its secret, signatures, whether callers wait for
 * its answer) and its public form (the link, its words, sign-in). Settings of its duties are saved as a
 * new version; addresses, secrets and on/off take effect at once.
 */
export function Entrances({ detail }: { detail: AgentDetail }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const slug = detail.agent.slug;
  const base = path(`/agents/${encodeURIComponent(slug)}/endpoints`);
  const queryKey = [...keys.agent(company, slug), "endpoints"];
  const addresses = useQuery({ queryKey, queryFn: () => api.get<Addresses>(base), enabled: Boolean(detail.canManage) });
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = (data: Addresses) => queryClient.setQueryData(queryKey, data);

  const saveDuties = useMutation({
    mutationFn: ({ triggers, note }: { triggers: TriggerSpec[]; note: string }) =>
      api.put(path(`/agents/${encodeURIComponent(slug)}`), { definition: { ...detail.definition, triggers } satisfies AgentDefinition, note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success("Saved as a new version");
    },
    onError: (error) => toast.error(error),
  });
  const makeSecret = useMutation({
    mutationFn: () => api.post<Addresses & { secret: string }>(`${base}/webhook/secret`),
    onSuccess: (data) => {
      setSecret(data.secret);
      refresh({ webhook: data.webhook, form: data.form });
    },
    onError: (error) => toast.error(error),
  });
  const rotate = useMutation({
    mutationFn: (kind: "webhook" | "form") => api.post<Addresses>(`${base}/${kind}/rotate`),
    onSuccess: (data, kind) => {
      refresh(data);
      toast.success(kind === "webhook" ? "New address: the old one no longer works" : "New link: the old one no longer works");
    },
    onError: (error) => toast.error(error),
  });
  const turn = useMutation({
    mutationFn: ({ kind, status }: { kind: "webhook" | "form"; status: "on" | "off" }) => api.put<Addresses>(`${base}/${kind}/status`, { status }),
    onSuccess: refresh,
    onError: (error) => toast.error(error),
  });

  if (!detail.canManage) return null;
  const triggers = detail.definition.triggers;
  const hook = triggers.find((t): t is WebhookDuty => t.type === "webhook");
  const form = triggers.find((t): t is FormDuty => t.type === "form");
  const replaceDuty = (next: TriggerSpec, note: string) =>
    saveDuties.mutate({
      triggers: triggers.some((t) => t.type === next.type) ? triggers.map((t) => (t.type === next.type ? next : t)) : [...triggers, next],
      note,
    });

  return (
    <>
      <Card className="lg:col-span-2">
        <CardHeader title="Called by other systems" icon={Webhook} subtitle="Another system gives it work by calling its address; each call is a task." />
        <div className="space-y-5 px-5 py-4">
          {addresses.error ? (
            <ErrorState error={addresses.error} onRetry={() => void addresses.refetch()} />
          ) : !hook ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-muted">Other systems can't call it yet.</p>
              <Button icon={Webhook} loading={saveDuties.isPending} onClick={() => replaceDuty({ type: "webhook" }, "Other systems may call it")}>
                Let other systems call it
              </Button>
            </div>
          ) : !addresses.data?.webhook ? (
            <LoadingBlock />
          ) : (
            <WebhookSettings
              duty={hook}
              view={addresses.data.webhook}
              secret={secret}
              busy={{ secret: makeSecret.isPending, rotate: rotate.isPending && rotate.variables === "webhook", save: saveDuties.isPending }}
              onSecret={() => makeSecret.mutate()}
              onRotate={() => rotate.mutate("webhook")}
              onTurn={(status) => turn.mutate({ kind: "webhook", status })}
              onSave={(next) => replaceDuty(next, "Changed how other systems call it")}
            />
          )}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Its public form" icon={FileInput} subtitle="A page anyone with its link fills in, without an account; each send is a task." />
        <div className="space-y-5 px-5 py-4">
          {!form?.public?.enabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-muted">
                {detail.definition.inputs.length
                  ? "People outside the app can't fill in its form yet."
                  : "It asks for nothing yet: a public form shows the fields its job asks for."}
              </p>
              <Button
                icon={FileInput}
                loading={saveDuties.isPending}
                onClick={() => replaceDuty({ ...(form ?? { type: "form" }), public: { ...(form?.public ?? {}), enabled: true } }, "Opened its public form")}
              >
                Open a public form
              </Button>
            </div>
          ) : !addresses.data?.form ? (
            <LoadingBlock />
          ) : (
            <FormSettings
              duty={form}
              view={addresses.data.form}
              busy={{ rotate: rotate.isPending && rotate.variables === "form", save: saveDuties.isPending }}
              onRotate={() => rotate.mutate("form")}
              onTurn={(status) => turn.mutate({ kind: "form", status })}
              onSave={(next, note) => replaceDuty(next, note)}
            />
          )}
        </div>
      </Card>
    </>
  );
}

function WebhookSettings({
  duty,
  view,
  secret,
  busy,
  onSecret,
  onRotate,
  onTurn,
  onSave,
}: {
  duty: WebhookDuty;
  view: EndpointView & { url: string; readableUrl: string };
  secret: string | null;
  busy: { secret: boolean; rotate: boolean; save: boolean };
  onSecret: () => void;
  onRotate: () => void;
  onTurn: (status: "on" | "off") => void;
  onSave: (duty: WebhookDuty) => void;
}) {
  const [auth, setAuth] = useState<"secret" | "hmac">(duty.auth ?? "secret");
  const [respond, setRespond] = useState(Boolean(duty.respond));
  const [wait, setWait] = useState(String(duty.waitSeconds ?? 25));
  useEffect(() => {
    setAuth(duty.auth ?? "secret");
    setRespond(Boolean(duty.respond));
    setWait(String(duty.waitSeconds ?? 25));
  }, [duty]);
  const seconds = Math.min(55, Math.max(1, Math.round(Number(wait) || 25)));
  const changed = auth !== (duty.auth ?? "secret") || respond !== Boolean(duty.respond) || (respond && seconds !== (duty.waitSeconds ?? 25));
  const sample =
    auth === "hmac"
      ? `curl -X POST '${view.url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Signature: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\\n  -d "$BODY"`
      : `curl -X POST '${view.readableUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Webhook-Secret: $SECRET" \\\n  -d '{"order": "SO-1001"}'`;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge size="xs" tone={view.status === "on" ? "green" : "neutral"}>
          {view.status === "on" ? "On" : "Off"}
        </Badge>
        <span>{usedText(view)}</span>
      </div>
      {view.status === "off" && <Callout tone="warning">The address is off: calls are refused until it is turned on again.</Callout>}
      <Copyable
        label="Its address"
        value={view.url}
        hint={
          auth === "hmac"
            ? "Calls must carry a signature of their body made with its secret (X-Signature: sha256=…)."
            : "The address is the key: give it only to the system that calls it, for systems that take nothing but an address."
        }
      />
      <Copyable label="Its readable address" value={view.readableUrl} hint="Calls to it carry its secret in the X-Webhook-Secret header." />
      {secret ? (
        <Callout tone="warning" icon={KeyRound} title="Its secret: shown this once">
          <div className="mt-2">
            <Copyable label="Secret" value={secret} hint="Copy it into the calling system now; it can't be shown again." />
          </div>
        </Callout>
      ) : (
        <p className="text-sm text-muted">
          {view.hasSecret ? "It has a secret, kept encrypted. A new one replaces it." : "No secret yet: make one for the readable address or for signatures."}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="hook-auth" className="label">
            Callers prove themselves with
          </label>
          <select id="hook-auth" className="input" value={auth} onChange={(e) => setAuth(e.target.value as "secret" | "hmac")}>
            <option value="secret">The address, or the secret in a header</option>
            <option value="hmac">A signature of the body (HMAC-SHA256)</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg sm:pt-6">
          <input type="checkbox" checked={respond} onChange={(e) => setRespond(e.target.checked)} />
          The caller waits for its answer
        </label>
        {respond && (
          <div>
            <label htmlFor="hook-wait" className="label">
              Waits at most (seconds)
            </label>
            <input id="hook-wait" type="number" min={1} max={55} className="input" value={wait} onChange={(e) => setWait(e.target.value)} />
          </div>
        )}
      </div>
      {respond && (
        <p className="hint">
          It answers with what an “Answer the caller” step says, or its result when it finishes in time; otherwise the caller gets a receipt with the task's
          reference.
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">An example call</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-subtle/60 p-2.5 font-mono text-[11px] text-fg">{sample}</pre>
      </details>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {changed && (
          <Button
            variant="primary"
            icon={Save}
            loading={busy.save}
            onClick={() => onSave({ ...duty, auth, respond: respond || undefined, waitSeconds: respond ? seconds : undefined })}
          >
            Save
          </Button>
        )}
        <Button icon={KeyRound} loading={busy.secret} onClick={onSecret}>
          {view.hasSecret ? "Make a new secret" : "Make a secret"}
        </Button>
        <Button icon={RefreshCw} variant="ghost" loading={busy.rotate} onClick={onRotate}>
          New address
        </Button>
        <Button icon={Power} variant="ghost" onClick={() => onTurn(view.status === "on" ? "off" : "on")}>
          {view.status === "on" ? "Turn the address off" : "Turn it on"}
        </Button>
      </div>
    </>
  );
}

function FormSettings({
  duty,
  view,
  busy,
  onRotate,
  onTurn,
  onSave,
}: {
  duty: FormDuty;
  view: EndpointView & { url: string };
  busy: { rotate: boolean; save: boolean };
  onRotate: () => void;
  onTurn: (status: "on" | "off") => void;
  onSave: (duty: FormDuty, note: string) => void;
}) {
  const settings = duty.public ?? { enabled: true };
  const [title, setTitle] = useState(settings.title ?? "");
  const [intro, setIntro] = useState(settings.intro ?? "");
  const [thanks, setThanks] = useState(settings.thanks ?? "");
  const [signIn, setSignIn] = useState(Boolean(settings.signIn));
  useEffect(() => {
    setTitle(settings.title ?? "");
    setIntro(settings.intro ?? "");
    setThanks(settings.thanks ?? "");
    setSignIn(Boolean(settings.signIn));
  }, [settings.title, settings.intro, settings.thanks, settings.signIn]);
  const next = {
    enabled: true,
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(intro.trim() ? { intro: intro.trim() } : {}),
    ...(thanks.trim() ? { thanks: thanks.trim() } : {}),
    ...(signIn ? { signIn: true } : {}),
  };
  const changed = JSON.stringify(next) !== JSON.stringify({ ...settings, enabled: true });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge size="xs" tone={view.status === "on" ? "green" : "neutral"}>
          {view.status === "on" ? "Open" : "Closed"}
        </Badge>
        <span>
          {view.uses ? `Sent ${view.uses} time${view.uses === 1 ? "" : "s"}, last ${view.lastUsedAt ? timeAgo(view.lastUsedAt) : "—"}` : "Not sent yet"}
        </span>
      </div>
      <Copyable label="Its link" value={view.url} hint="Anyone with the link can send it; ask for sign-in to keep it to the company's people." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="form-title" className="label">
            Title
          </label>
          <input id="form-title" className="input" value={title} placeholder="Its name" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label htmlFor="form-thanks" className="label">
            What people read after sending it
          </label>
          <input id="form-thanks" className="input" value={thanks} placeholder="Thank you: your request is in." onChange={(e) => setThanks(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="form-intro" className="label">
            What it says above the fields
          </label>
          <textarea id="form-intro" rows={3} className="input" value={intro} placeholder="What it is for" onChange={(e) => setIntro(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
          <input type="checkbox" checked={signIn} onChange={(e) => setSignIn(e.target.checked)} />
          Only the company's people, signed in
        </label>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {changed && (
          <Button variant="primary" icon={Save} loading={busy.save} onClick={() => onSave({ ...duty, public: next }, "Changed its public form")}>
            Save
          </Button>
        )}
        <a href={view.url} target="_blank" rel="noreferrer" className={buttonClass("ghost", "md")}>
          <ExternalLink className="size-4" /> Open it
        </a>
        <Button icon={RefreshCw} variant="ghost" loading={busy.rotate} onClick={onRotate}>
          New link
        </Button>
        <Button icon={Power} variant="ghost" onClick={() => onTurn(view.status === "on" ? "off" : "on")}>
          {view.status === "on" ? "Close the form" : "Open it again"}
        </Button>
      </div>
    </>
  );
}
