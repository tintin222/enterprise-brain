import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  ClipboardList,
  Database,
  ExternalLink,
  FlaskConical,
  KeyRound,
  ListTree,
  LogIn,
  Play,
  Plug,
  PlugZap,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api.ts";
import { Badge, StatusPill } from "../components/Badge.tsx";
import { Button, ButtonAnchor } from "../components/Button.tsx";
import { Card, CardHeader, PageHeader, SectionTitle } from "../components/Card.tsx";
import { ConnectionActionsDrawer } from "../components/ConnectionActions.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { Dialog, Drawer } from "../components/Dialog.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field, Switch } from "../components/Form.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Page } from "../components/Layout.tsx";
import { CellValue } from "../components/OutputView.tsx";
import { Callout, ErrorState, Skeleton } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, humanize, isRecord, timeAgo } from "../lib/format.ts";
import { categoryIcon } from "../lib/icons.tsx";
import { categoryLabel, CONNECTOR_CATEGORY_ORDER } from "../lib/labels.ts";
import { keys, useConnectorCatalog, useConnectors } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { ConfigField, ConnectorInstance, ConnectorManifest, JsonSchema, OperationManifest, WatcherStatus } from "../types.ts";

// ---------------------------------------------------------------------------
// Connect drawer
// ---------------------------------------------------------------------------

function ConfigInput({ field, value, onChange, id }: { field: ConfigField; value: string | boolean; onChange: (v: string | boolean) => void; id: string }) {
  if (field.type === "boolean") return <Switch id={id} checked={value === true} onChange={onChange} label={value === true ? "Yes" : "No"} />;
  if (field.type === "select") {
    return (
      <select id={id} className="input" value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "textarea")
    return (
      <textarea
        id={id}
        rows={4}
        className="input font-mono text-xs"
        placeholder={field.placeholder}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  const type = field.secret || field.type === "password" ? "password" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text";
  return (
    <input
      id={id}
      type={type}
      autoComplete={type === "password" ? "new-password" : "off"}
      className="input"
      placeholder={field.placeholder}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A field is shown when it has no condition, or the field it depends on has one of its values. */
function visible(field: ConfigField, values: Record<string, string | boolean>): boolean {
  return !field.showWhen || field.showWhen.values.includes(String(values[field.showWhen.key] ?? ""));
}

interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** A server whose host key someone has to confirm before Enterprise Brain talks to it (SFTP). */
interface HostKeyCheck {
  instance: ConnectorInstance;
  fingerprint: string;
  keyType: string;
  changed: boolean;
}

function hostKeyOf(instance: ConnectorInstance, test: TestResult): HostKeyCheck | undefined {
  const fingerprint = test.details?.host_key_fingerprint;
  if (test.ok || typeof fingerprint !== "string") return undefined;
  return { instance, fingerprint, keyType: String(test.details?.key_type ?? "host"), changed: test.details?.changed === true };
}

function testConnection(path: (p: string) => string, id: string): Promise<TestResult> {
  return api
    .post<TestResult>(path(`/connectors/${encodeURIComponent(id)}/test`))
    .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
}

/** Connect a system, or change a connection's settings (`editing`). Secrets stay stored unless replaced. */
function ConnectDrawer({
  manifest,
  editing,
  onClose,
  onHostKey,
}: {
  manifest: ConnectorManifest | null;
  editing?: ConnectorInstance | null;
  onClose: () => void;
  onHostKey: (check: HostKeyCheck) => void;
}) {
  const { company, path, info } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    if (!manifest) return;
    setName(editing?.name ?? manifest.name);
    setValues(
      Object.fromEntries(
        manifest.config.map((f) => {
          const current = editing && !f.secret ? editing.config[f.key] : undefined;
          if (typeof current === "boolean") return [f.key, current];
          if (current !== undefined && current !== null) return [f.key, String(current)];
          return [f.key, f.default ?? (f.type === "boolean" ? false : "")];
        }),
      ) as Record<string, string | boolean>,
    );
  }, [manifest, editing]);
  const stored = (f: ConfigField) => Boolean(editing && f.secret && editing.secretFields.includes(f.key));

  const connect = useMutation({
    mutationFn: async () => {
      if (!manifest) throw new Error("No connector selected");
      const shown = manifest.config.filter((f) => visible(f, values));
      let instance: ConnectorInstance;
      if (editing) {
        // Settings given empty are cleared; secrets left empty are kept.
        const changed = Object.fromEntries(
          shown.filter((f) => !(f.secret && (values[f.key] === "" || values[f.key] === undefined))).map((f) => [f.key, values[f.key] ?? ""]),
        );
        instance = await api.put<ConnectorInstance>(path(`/connectors/${encodeURIComponent(editing.id)}`), { name: name || undefined, values: changed });
      } else {
        const shownKeys = new Set(shown.map((f) => f.key));
        const clean = Object.fromEntries(Object.entries(values).filter(([key, v]) => v !== "" && v !== undefined && shownKeys.has(key)));
        instance = await api.post<ConnectorInstance>(path("/connectors"), { type: manifest.type, name: name || undefined, values: clean });
      }
      return { instance, test: await testConnection(path, instance.id) };
    },
    onSuccess: ({ instance, test }) => {
      void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
      const hostKey = hostKeyOf(instance, test);
      if (test.ok) toast.success(editing ? `${instance.name} saved` : `${instance.name} connected`, { description: test.message });
      else if (hostKey) onHostKey(hostKey);
      else toast.error(`${instance.name} saved, but the connection test failed`, { description: test.message });
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const missing =
    manifest?.config
      .filter((f) => f.required && visible(f, values) && !stored(f) && (values[f.key] === "" || values[f.key] === undefined))
      .map((f) => f.label) ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!missing.length) connect.mutate();
  };

  return (
    <Drawer
      open={Boolean(manifest)}
      onClose={onClose}
      width="md"
      title={editing ? `Settings of ${editing.name}` : manifest ? `Connect ${manifest.name}` : "Connect"}
      description={manifest ? `${manifest.vendor} · ${categoryLabel(manifest.category)} · ${humanize(manifest.auth)} authentication` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={PlugZap} loading={connect.isPending} disabled={missing.length > 0} onClick={() => connect.mutate()}>
            {editing ? "Save & test" : "Connect & test"}
          </Button>
        </>
      }
    >
      {manifest && (
        <form onSubmit={submit} className="space-y-6">
          <p className="text-sm text-muted">{manifest.description}</p>
          {!editing && manifest.itRequirements.length > 0 && (
            <Callout tone="brand" icon={ClipboardList} title="What your IT team needs to provide">
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {manifest.itRequirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Callout>
          )}
          <Field label="Connection name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          {manifest.config
            .filter((f) => visible(f, values))
            .map((f) => (
              <Field
                key={f.key}
                label={f.label}
                required={f.required && !stored(f)}
                hint={stored(f) ? "Stored encrypted: leave empty to keep it." : (f.help ?? (f.secret ? "Stored encrypted; never shown again." : undefined))}
              >
                {(id) => (
                  <ConfigInput
                    id={id}
                    field={stored(f) ? { ...f, placeholder: "•••••••• (kept)" } : f}
                    value={values[f.key] ?? ""}
                    onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                  />
                )}
              </Field>
            ))}
          {values.auth_type === "oauth2_authorization_code" && info.oauthRedirectUrl && (
            <Callout tone="brand" icon={KeyRound} title="Register this redirect URL with the provider">
              <code className="font-mono text-xs break-all">{info.oauthRedirectUrl}</code>
              <p className="mt-1">Then connect, and press Sign in on the connection: the provider asks you to allow access once.</p>
            </Callout>
          )}
          {manifest.config.length === 0 && <p className="text-sm text-muted">No configuration needed.</p>}
          {manifest.docsUrl && (
            <ButtonAnchor href={manifest.docsUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="ghost" icon={ExternalLink}>
              Vendor documentation
            </ButtonAnchor>
          )}
          <button type="submit" className="hidden" />
        </form>
      )}
    </Drawer>
  );
}

/** Someone confirms the server's host key with its administrator before Enterprise Brain trusts it. */
function HostKeyDialog({ check, onClose }: { check: HostKeyCheck | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const trust = useMutation({
    mutationFn: async (c: HostKeyCheck) => {
      await api.put(path(`/connectors/${encodeURIComponent(c.instance.id)}`), { values: { host_key_fingerprint: c.fingerprint } });
      return testConnection(path, c.instance.id);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
      if (res.ok) toast.success("Host key confirmed: the connection works", { description: res.message });
      else toast.error("Host key confirmed, but the connection test failed", { description: res.message });
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Dialog
      open={Boolean(check)}
      onClose={onClose}
      title="Confirm the server's host key"
      description={
        check
          ? `${check.instance.name} presented its ${check.keyType} key. Enterprise Brain talks to the server only once someone confirms the key is really the server's.`
          : undefined
      }
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button variant={check?.changed ? "danger" : "primary"} icon={ShieldCheck} loading={trust.isPending} onClick={() => check && trust.mutate(check)}>
            It matches: trust this key
          </Button>
        </>
      }
    >
      {check && (
        <div className="space-y-4">
          {check.changed && (
            <Callout tone="danger" icon={ShieldAlert} title="The server's key changed">
              This is not the key confirmed before. That happens when the server is replaced or its keys are renewed, and also when something pretends to be the
              server. Trust the new key only after the server's administrator confirms the change.
            </Callout>
          )}
          <div className="rounded-lg border border-line bg-subtle/60 p-3">
            <p className="text-xs text-muted">Fingerprint</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <code className="font-mono text-sm break-all text-fg">{check.fingerprint}</code>
              <CopyButton text={check.fingerprint} size="xs" variant="ghost" />
            </div>
          </div>
          <p className="text-sm text-muted">
            Ask the server's administrator for its fingerprint (on the server: <code className="font-mono text-xs">ssh-keygen -lf</code> with its host key) and
            compare every character.
          </p>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sandbox explorer
// ---------------------------------------------------------------------------

function schemaType(schema: JsonSchema): string {
  return Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? "string") : (schema.type ?? "string");
}

function coerce(schema: JsonSchema, raw: string | boolean): unknown {
  const type = schemaType(schema);
  if (type === "boolean") return raw === true;
  if (typeof raw !== "string" || raw === "") return undefined;
  if (type === "number" || type === "integer") return Number(raw);
  if (type === "array")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (type === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function ResultTable({ items }: { items: Record<string, unknown>[] }) {
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const row of items.slice(0, 20)) for (const k of Object.keys(row)) if (!seen.includes(k)) seen.push(k);
    return seen.filter((k) => items.some((r) => typeof r[k] !== "object" || r[k] === null)).slice(0, 8);
  }, [items]);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-subtle/60 text-xs text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">
                {humanize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className="max-w-[16rem] px-3 py-2 align-top">
                  <CellValue name={c} value={row[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SandboxExplorer({ manifests, initialType }: { manifests: ConnectorManifest[]; initialType?: string }) {
  const { path } = useCompany();
  const sandboxes = manifests.filter((m) => m.maturity === "sandbox");
  const [type, setType] = useState(initialType ?? sandboxes[0]?.type ?? "");
  useEffect(() => {
    if (initialType) setType(initialType);
  }, [initialType]);
  const system = sandboxes.find((m) => m.type === type);
  const reads = (system?.operations ?? []).filter((o) => o.kind === "read");
  const [opId, setOpId] = useState("");
  const op: OperationManifest | undefined = reads.find((o) => o.id === opId) ?? reads[0];
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  useEffect(() => setValues({}), [op?.id]);

  const run = useMutation({
    mutationFn: () => {
      const props = op?.input.properties ?? {};
      const input = Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, props[k] ? coerce(props[k], v) : v] as const)
          .filter(([, v]) => v !== undefined),
      );
      return api.post<{ result: unknown }>(path(`/connectors/types/${encodeURIComponent(type)}/operations/${encodeURIComponent(op?.id ?? "")}`), { input });
    },
  });

  if (!sandboxes.length) return <EmptyState compact icon={Database} title="No sandbox systems" description="Built-in demo systems appear here." />;
  const props = Object.entries(op?.input.properties ?? {});
  const required = new Set(op?.input.required ?? []);
  const result = run.data?.result;
  const items =
    isRecord(result) && Array.isArray(result.items)
      ? (result.items.filter(isRecord) as Record<string, unknown>[])
      : Array.isArray(result) && result.every(isRecord)
        ? (result as Record<string, unknown>[])
        : null;

  return (
    <Card>
      <CardHeader
        title="Sandbox explorer"
        subtitle="Browse the built-in demo ERP, CRM, HRIS, ATS and ITSM — the same data AI employees use until the real systems are connected."
        icon={FlaskConical}
      />
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="System">
            {(id) => (
              <select
                id={id}
                className="input"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setOpId("");
                  run.reset();
                }}
              >
                {sandboxes.map((m) => (
                  <option key={m.type} value={m.type}>
                    {m.name} ({categoryLabel(m.category)})
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Read operation">
            {(id) => (
              <select
                id={id}
                className="input"
                value={op?.id ?? ""}
                onChange={(e) => {
                  setOpId(e.target.value);
                  run.reset();
                }}
              >
                {reads.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {op && <p className="text-[13px] text-muted">{op.description}</p>}
        {props.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {props.map(([key, schema]) => {
              const t = schemaType(schema);
              const enumValues = Array.isArray(schema.enum) ? schema.enum.map(String) : null;
              return (
                <Field key={key} label={humanize(key)} required={required.has(key)} hint={schema.description}>
                  {(id) =>
                    t === "boolean" ? (
                      <Switch id={id} checked={values[key] === true} onChange={(v) => setValues({ ...values, [key]: v })} />
                    ) : enumValues ? (
                      <select id={id} className="input" value={String(values[key] ?? "")} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                        <option value="">Any</option>
                        {enumValues.map((v) => (
                          <option key={v} value={v}>
                            {humanize(v)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        type={t === "number" || t === "integer" ? "number" : schema.format === "date" ? "date" : "text"}
                        className="input"
                        placeholder={t === "array" ? "comma-separated" : t === "object" ? "{ JSON }" : undefined}
                        value={String(values[key] ?? "")}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      />
                    )
                  }
                </Field>
              );
            })}
          </div>
        )}
        <Button variant="primary" icon={Play} loading={run.isPending} onClick={() => run.mutate()} disabled={!op}>
          Run
        </Button>
        {run.error && <ErrorState error={run.error} />}
        {run.isSuccess &&
          (items ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                {items.length} record{items.length === 1 ? "" : "s"}
                {isRecord(result) && typeof result.total === "number" && result.total !== items.length ? ` of ${result.total}` : ""}
              </p>
              {items.length ? <ResultTable items={items} /> : null}
              <JsonView data={result} expandDepth={0} />
            </div>
          ) : (
            <JsonView data={result} expandDepth={2} />
          ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** What a watcher watches, in words: "New mail", "New files for Scan Reader". */
function watcherLabel(watcher: WatcherStatus): string {
  const what =
    watcher.watching === "new_message"
      ? "New mail"
      : watcher.watching === "new_file"
        ? "New files"
        : watcher.watching.startsWith("new:")
          ? `New items from ${humanize(watcher.watching.slice(4)).toLowerCase()}`
          : humanize(watcher.watching);
  return watcher.agent ? `${what} for ${watcher.agent}` : what;
}

/** When it was last checked, what it brought in, and what it left alone (a file too large, a missing folder). */
function WatcherLine({ watcher }: { watcher: WatcherStatus }) {
  return (
    <p className={`mt-0.5 text-xs ${watcher.lastError ? "text-amber-700 dark:text-amber-300" : "text-muted"}`}>
      {watcherLabel(watcher)} · {watcher.lastPolledAt ? `checked ${timeAgo(watcher.lastPolledAt)}` : "not checked yet"}
      {watcher.lastCount ? ` · ${watcher.lastCount} new last time` : ""}
      {watcher.lastError ? ` · ${watcher.lastError}` : ""}
    </p>
  );
}

export default function Connectors() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const catalog = useConnectorCatalog();
  const instances = useConnectors();
  const [connecting, setConnecting] = useState<ConnectorManifest | null>(null);
  const [removing, setRemoving] = useState<ConnectorInstance | null>(null);
  const [explore, setExplore] = useState<string | undefined>(undefined);
  const [naming, setNaming] = useState<ConnectorInstance | null>(null);
  const [editing, setEditing] = useState<ConnectorInstance | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyCheck | null>(null);
  // What each connection watches for AI employees (mailboxes, folders, systems), and how its last check went.
  const watchers = useQuery({ queryKey: [...keys.connectors(company), "watchers"], queryFn: () => api.get<WatcherStatus[]>(path("/watchers")) });
  const checkNow = useMutation({
    mutationFn: () => api.post<{ mail: number; events: number; errors: string[] }>(path("/watchers/poll")),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
      const brought = `${res.mail} email${res.mail === 1 ? "" : "s"} and ${res.events} event${res.events === 1 ? "" : "s"} brought in`;
      if (res.errors.length) toast.error(`Checked: ${brought}, with problems`, { description: res.errors.join("\n") });
      else toast.success(`Checked: ${brought}`);
    },
    onError: (e) => toast.error(e),
  });
  const [search, setSearch] = useSearchParams();
  // Back from signing a connection in with OAuth 2.0: say how it went.
  useEffect(() => {
    const signin = search.get("signin");
    if (!signin) return;
    if (signin === "ok") toast.success("Signed in: the connection can call the system now");
    else if (signin === "expired") toast.error("The sign-in took too long: try again");
    else toast.error("The sign-in didn't work", { description: search.get("reason") ?? undefined });
    void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
    const next = new URLSearchParams(search);
    for (const key of ["signin", "connection", "reason"]) next.delete(key);
    setSearch(next, { replace: true });
  }, [search, setSearch, toast, queryClient, company]);
  // Other pages open the form for a system with ?connect=<type> (e.g. Settings → Teams and Chat for Teams).
  useEffect(() => {
    const type = search.get("connect");
    if (!type || !catalog.data) return;
    const manifest = catalog.data.find((m) => m.type === type);
    if (manifest) setConnecting(manifest);
    const next = new URLSearchParams(search);
    next.delete("connect");
    setSearch(next, { replace: true });
  }, [search, catalog.data, setSearch]);

  const test = useMutation({
    mutationFn: (id: string) => api.post<TestResult>(path(`/connectors/${encodeURIComponent(id)}/test`)),
    onSuccess: (res, id) => {
      void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
      const instance = instances.data?.find((i) => i.id === id);
      const check = instance ? hostKeyOf(instance, res) : undefined;
      if (res.ok) toast.success("Connection works", { description: res.message });
      else if (check) setHostKey(check);
      else toast.error("Connection test failed", { description: res.message });
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(path(`/connectors/${encodeURIComponent(id)}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.connectors(company) });
      toast.success("Connection removed");
      setRemoving(null);
    },
    onError: (e) => toast.error(e),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectorManifest[]>();
    for (const m of catalog.data ?? []) map.set(m.category, [...(map.get(m.category) ?? []), m]);
    const known = CONNECTOR_CATEGORY_ORDER.filter((c) => c !== "other" && map.has(c));
    const extra = [...map.keys()].filter((c) => !CONNECTOR_CATEGORY_ORDER.includes(c)).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
    const order = [...known, ...extra, ...(map.has("other") ? ["other"] : [])];
    return order.map((c) => ({ category: c, items: map.get(c) ?? [] }));
  }, [catalog.data]);

  const configuredTypes = new Set((instances.data ?? []).map((i) => i.type));

  return (
    <Page>
      <PageHeader
        icon={Plug}
        title="Connections"
        description="Connect the company's systems: ERP, CRM, HR, mail, file servers, web services and databases. For web services and databases, name the actions AI employees may use. Until a system is connected, AI employees practise on built-in demo systems."
      />

      <SectionTitle
        actions={
          watchers.data?.length ? (
            <Button size="xs" variant="ghost" icon={RefreshCw} loading={checkNow.isPending} onClick={() => checkNow.mutate()}>
              Check now
            </Button>
          ) : undefined
        }
      >
        Connected systems
      </SectionTitle>
      <Card className="mb-10 overflow-hidden">
        {instances.isLoading && <Skeleton className="m-4 h-16" />}
        {instances.error && <ErrorState error={instances.error} className="m-4" />}
        {instances.data && instances.data.length === 0 && (
          <EmptyState
            compact
            className="m-4"
            icon={Plug}
            title="No systems connected yet"
            description="Pick a system below. AI employees keep using demo data for anything that isn't connected."
          />
        )}
        {instances.data && instances.data.length > 0 && (
          <ul className="divide-y divide-line">
            {instances.data.map((i) => {
              const Icon = categoryIcon(i.category);
              return (
                <li key={i.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                        {i.name}
                        <StatusPill status={i.status} size="xs" />
                        {i.sandbox && (
                          <Badge size="xs" tone="violet">
                            Demo data
                          </Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {i.type} · {categoryLabel(i.category)} · {i.lastCheckedAt ? `checked ${timeAgo(i.lastCheckedAt)}` : "never tested"}
                        {i.lastError ? ` · ${i.lastError}` : ""}
                      </p>
                      {(watchers.data ?? [])
                        .filter((w) => w.connectionId === i.id)
                        .map((w) => (
                          <WatcherLine key={`${w.watching}:${w.agent ?? ""}`} watcher={w} />
                        ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {i.config.auth_type === "oauth2_authorization_code" && (
                      <ButtonAnchor
                        size="sm"
                        variant={i.secretFields.includes("refresh_token") ? "ghost" : "primary"}
                        icon={LogIn}
                        href={path(`/connectors/${encodeURIComponent(i.id)}/oauth/start`)}
                        title={i.secretFields.includes("refresh_token") ? "Signed in: sign in again to renew" : "Sign in once so it may call the system"}
                      >
                        {i.secretFields.includes("refresh_token") ? "Sign in again" : "Sign in"}
                      </ButtonAnchor>
                    )}
                    {(i.type === "rest-api" || i.type === "sql-database" || i.type === "mcp-server") && (
                      <Button size="sm" variant="soft" icon={ListTree} onClick={() => setNaming(i)}>
                        Actions
                      </Button>
                    )}
                    {!i.sandbox && catalog.data?.some((m) => m.type === i.type && m.config.length > 0) && (
                      <Button size="sm" variant="ghost" icon={Settings2} onClick={() => setEditing(i)}>
                        Settings
                      </Button>
                    )}
                    <Button size="sm" icon={RefreshCw} loading={test.isPending && test.variables === i.id} onClick={() => test.mutate(i.id)}>
                      Test
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash} onClick={() => setRemoving(i)}>
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <SectionTitle>Systems you can connect</SectionTitle>
      {catalog.isLoading && <Skeleton className="h-40" />}
      {catalog.error && <ErrorState error={catalog.error} />}
      <div className="space-y-8">
        {grouped.map(({ category, items }) => {
          const Icon = categoryIcon(category);
          return (
            <section key={category}>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
                <Icon className="size-4 text-muted" /> {categoryLabel(category)}
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((m) => (
                  <Card key={m.type} className="flex flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-fg">{m.name}</p>
                        <p className="text-xs text-muted">{m.vendor}</p>
                      </div>
                      <StatusPill status={m.maturity} size="xs" />
                    </div>
                    <p className="mt-2 line-clamp-3 flex-1 text-[13px] text-muted">{m.description}</p>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                      <span className="text-xs text-faint">
                        {m.operations.length} operations · {m.operations.filter((o) => o.kind === "write").length} write
                      </span>
                      {m.maturity === "sandbox" ? (
                        <Button
                          size="xs"
                          variant="soft"
                          icon={FlaskConical}
                          onClick={() => {
                            setExplore(m.type);
                            window.setTimeout(() => document.getElementById("sandbox-explorer")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                          }}
                        >
                          Explore
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant={configuredTypes.has(m.type) ? "secondary" : "primary"}
                          icon={configuredTypes.has(m.type) ? CircleCheck : Plug}
                          onClick={() => setConnecting(m)}
                        >
                          {configuredTypes.has(m.type) ? "Add another" : "Connect"}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <div className="mt-10 scroll-mt-20" id="sandbox-explorer">
        {catalog.data && <SandboxExplorer manifests={catalog.data} initialType={explore} />}
      </div>

      <ConnectDrawer manifest={connecting} onClose={() => setConnecting(null)} onHostKey={setHostKey} />
      <ConnectDrawer
        manifest={editing ? (catalog.data?.find((m) => m.type === editing.type) ?? null) : null}
        editing={editing}
        onClose={() => setEditing(null)}
        onHostKey={setHostKey}
      />
      <HostKeyDialog check={hostKey} onClose={() => setHostKey(null)} />
      <ConnectionActionsDrawer connection={naming} onClose={() => setNaming(null)} />
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        size="sm"
        title={`Remove ${removing?.name}?`}
        description="AI employees using this system fall back to demo data. Stored credentials are deleted."
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>
              Remove
            </Button>
          </>
        }
      >
        {removing && <p className="text-sm text-muted">Last checked: {formatDateTime(removing.lastCheckedAt)}</p>}
      </Dialog>
    </Page>
  );
}
