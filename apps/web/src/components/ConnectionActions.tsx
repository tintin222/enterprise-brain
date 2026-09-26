import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Braces, Check, Eye, FileCode2, FlaskConical, PencilLine, Plus, Radar, Save, ShieldCheck, Trash, Wand } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { timeAgo } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { ConnectorInstance, NamedAction, WatcherStatus } from "../types.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Drawer } from "./Dialog.tsx";
import { JsonView } from "./JsonView.tsx";
import { Callout } from "./Spinner.tsx";
import { Segmented } from "./Tabs.tsx";

/** "GET /customers/{id}" or the first line of the query. */
function technical(action: NamedAction): string {
  if (action.tool) return `tool ${action.tool}`;
  if (action.sql) return action.sql.trim().split("\n")[0]!.slice(0, 120);
  return `${action.method ?? "GET"} ${action.path ?? ""}`;
}

function ActionRow({
  action,
  onChange,
  onRemove,
  onTry,
  children,
}: {
  action: NamedAction;
  onChange: (next: NamedAction) => void;
  onRemove: () => void;
  onTry: () => void;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            {action.name}
            <Badge size="xs" tone={action.kind === "write" ? "amber" : "blue"}>
              {action.kind === "write" ? "changes data" : "reads"}
            </Badge>
            {action.requiresApproval && (
              <Badge size="xs" tone="violet" icon={ShieldCheck}>
                a person approves every use
              </Badge>
            )}
            {action.watch && (
              <Badge size="xs" tone="green" icon={Radar}>
                watched for new items
              </Badge>
            )}
          </p>
          {action.description && <p className="mt-0.5 text-xs text-muted">{action.description}</p>}
          <p className="mt-1 truncate font-mono text-[11px] text-faint">
            {action.id} · {technical(action)}
            {action.params.length ? ` · ${action.params.map((p) => `${p.key}${p.required ? "" : "?"}`).join(", ")}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="xs" variant="ghost" icon={FlaskConical} onClick={onTry}>
            Try
          </Button>
          <Button size="xs" variant="ghost" icon={PencilLine} onClick={() => setEditing(!editing)} aria-expanded={editing}>
            Edit
          </Button>
          <Button size="xs" variant="ghost" icon={Trash} onClick={onRemove} aria-label={`Remove ${action.name}`} />
        </div>
      </div>
      {editing && (
        <div className="mt-3 grid gap-3 rounded-lg border border-line bg-subtle/40 p-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`name-${action.id}`}>
              Name people see
            </label>
            <input id={`name-${action.id}`} className="input" value={action.name} onChange={(e) => onChange({ ...action, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`kind-${action.id}`}>
              It
            </label>
            <select
              id={`kind-${action.id}`}
              className="input"
              value={action.kind}
              onChange={(e) => onChange({ ...action, kind: e.target.value as NamedAction["kind"] })}
            >
              <option value="read">Only reads</option>
              <option value="write">Changes data</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor={`description-${action.id}`}>
              What it does, in plain words
            </label>
            <input
              id={`description-${action.id}`}
              className="input"
              value={action.description}
              onChange={(e) => onChange({ ...action, description: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="accent-brand-600"
              checked={Boolean(action.requiresApproval)}
              onChange={(e) => onChange({ ...action, requiresApproval: e.target.checked || undefined })}
            />
            A person approves every use, at every probation level
          </label>
        </div>
      )}
      {children}
    </li>
  );
}

function TryForm({ connection, action, onClose }: { connection: ConnectorInstance; action: NamedAction; onClose: () => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: () => {
      const input = Object.fromEntries(
        Object.entries(values)
          .filter(([, v]) => v.trim() !== "")
          .map(([key, v]) => {
            const param = action.params.find((p) => p.key === key);
            if (param && (param.type === "number" || param.type === "integer") && Number.isFinite(Number(v))) return [key, Number(v)];
            if (param?.type === "boolean") return [key, v === "true"];
            return [key, v];
          }),
      );
      return api.post<{ ok: boolean; durationMs: number; result: unknown }>(
        path(`/connectors/${encodeURIComponent(connection.id)}/actions/${encodeURIComponent(action.id)}/test`),
        { input, confirm: action.kind === "write" ? confirm : undefined },
      );
    },
    onError: (error) => toast.error(error),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-400/25 dark:bg-brand-400/5">
      <p className="text-sm font-semibold text-fg">Try “{action.name}”</p>
      {action.params.length === 0 && <p className="text-xs text-muted">It takes no values.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {action.params.map((p) => (
          <div key={p.key}>
            <label className="label" htmlFor={`try-${action.id}-${p.key}`}>
              {p.key}
              {p.required ? "" : " (optional)"}
            </label>
            <input
              id={`try-${action.id}-${p.key}`}
              className="input"
              placeholder={p.description ?? p.type}
              value={values[p.key] ?? ""}
              onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      {action.kind === "write" && (
        <label className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
          <input type="checkbox" className="accent-amber-600" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          This really changes data in {connection.name}
        </label>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" icon={FlaskConical} loading={run.isPending} disabled={action.kind === "write" && !confirm}>
          Run it
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {run.data && (
        <div>
          <p className="mb-1 text-xs text-emerald-700 dark:text-emerald-300">Worked in {run.data.durationMs} ms</p>
          <JsonView data={run.data.result} className="max-h-72 overflow-auto" />
        </div>
      )}
    </form>
  );
}

function Importer({ connection, onProposed }: { connection: ConnectorInstance; onProposed: (actions: NamedAction[]) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const [source, setSource] = useState<"openapi" | "examples">("openapi");
  const [text, setText] = useState("");
  const load = useMutation({
    mutationFn: () => {
      const trimmed = text.trim();
      const body = source === "examples" ? { examples: trimmed } : /^https?:\/\/\S+$/.test(trimmed) ? { url: trimmed } : { openapi: trimmed };
      return api.post<{ baseUrl?: string; actions: NamedAction[] }>(path(`/connectors/${encodeURIComponent(connection.id)}/actions/import`), body);
    },
    onSuccess: (res) => {
      if (!res.actions.length) toast.error("No actions found in it");
      else onProposed(res.actions);
    },
    onError: (error) => toast.error(error),
  });
  return (
    <div className="space-y-3">
      <Segmented
        value={source}
        onChange={setSource}
        options={[
          { value: "openapi", label: "OpenAPI or Swagger" },
          { value: "examples", label: "Example calls" },
        ]}
      />
      <textarea
        className="input min-h-32 font-mono text-xs"
        placeholder={
          source === "openapi"
            ? "A link to the description (https://…/openapi.json), or paste it here (JSON or YAML)"
            : 'One call per line, for example:\nGET https://erp.example.com/api/customers/C-1001\nPOST https://erp.example.com/api/orders {"customer": "C-1001"}'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={source === "openapi" ? "OpenAPI description or link" : "Example calls"}
      />
      <Button size="sm" icon={Wand} loading={load.isPending} disabled={!text.trim()} onClick={() => load.mutate()}>
        Propose actions
      </Button>
    </div>
  );
}

/** An MCP server's tools, proposed as actions (read when the tool says it only reads). */
function McpImporter({ connection, onProposed }: { connection: ConnectorInstance; onProposed: (actions: NamedAction[]) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const load = useMutation({
    mutationFn: () =>
      api.post<{ actions: NamedAction[]; warnings: string[] }>(path(`/connectors/${encodeURIComponent(connection.id)}/actions/import`), { mcp: true }),
    onSuccess: (res) => {
      if (!res.actions.length) toast.error("The server offers no tools");
      else onProposed(res.actions);
    },
    onError: (error) => toast.error(error),
  });
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        Each of the server's tools becomes an action. Tools that say they only read are marked so; check the others before adding them.
      </p>
      <Button size="sm" icon={Wand} loading={load.isPending} onClick={() => load.mutate()}>
        Import the server's tools
      </Button>
    </div>
  );
}

/**
 * The named actions of a web service or database connection: what AI employees may do there. IT imports
 * them from an OpenAPI description or example calls, names them in plain words, tries them and saves.
 */
export function ConnectionActionsDrawer({ connection, onClose }: { connection: ConnectorInstance | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = connection?.id ?? "";
  const saved = useQuery({
    queryKey: [...keys.connectors(company), id, "actions"],
    queryFn: () => api.get<{ supports: boolean; actions: NamedAction[] }>(path(`/connectors/${encodeURIComponent(id)}/actions`)),
    enabled: Boolean(connection),
  });
  const watchers = useQuery({
    queryKey: [...keys.connectors(company), "watchers"],
    queryFn: () => api.get<WatcherStatus[]>(path("/watchers")),
    enabled: Boolean(connection),
  });
  const [draft, setDraft] = useState<NamedAction[]>([]);
  const [proposed, setProposed] = useState<NamedAction[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [trying, setTrying] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data) setDraft(saved.data.actions);
  }, [saved.data]);
  useEffect(() => {
    if (!connection) {
      setProposed(null);
      setTrying(null);
      setJson(null);
    }
  }, [connection]);

  const save = useMutation({
    mutationFn: (actions: NamedAction[]) => api.put<{ actions: NamedAction[] }>(path(`/connectors/${encodeURIComponent(id)}/actions`), { actions }),
    onSuccess: (res) => {
      setDraft(res.actions);
      setJson(null);
      void queryClient.invalidateQueries({ queryKey: [...keys.connectors(company), id, "actions"] });
      toast.success(`Saved ${res.actions.length} action${res.actions.length === 1 ? "" : "s"}`, {
        description: "AI employees using this connection now see exactly these.",
      });
    },
    onError: (error) => toast.error(error),
  });

  if (!connection) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.data?.actions ?? []);
  const mine = (watchers.data ?? []).filter((w) => w.connectionId === connection.id);
  const addPicked = () => {
    const existing = new Set(draft.map((a) => a.id));
    const additions = (proposed ?? []).filter((a) => picked.has(a.id) && !existing.has(a.id));
    setDraft([...draft, ...additions]);
    setProposed(null);
    setPicked(new Set());
  };
  const saveJson = () => {
    try {
      const parsed = JSON.parse(json ?? "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("Give a list of actions: [ … ]");
      save.mutate(parsed as NamedAction[]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="xl"
      title={`${connection.name}: actions`}
      description="Name what AI employees may do in this system. They see only these actions, in plain words, and every change follows their probation level."
      footer={
        json === null ? (
          <>
            <Button variant="ghost" icon={Braces} onClick={() => setJson(JSON.stringify(draft, null, 2))}>
              Edit as JSON
            </Button>
            <Button variant="primary" icon={Save} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
              Save actions
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setJson(null)}>
              Back
            </Button>
            <Button variant="primary" icon={Save} loading={save.isPending} onClick={saveJson}>
              Save JSON
            </Button>
          </>
        )
      }
    >
      {saved.data && !saved.data.supports && (
        <Callout tone="warning" className="mb-4">
          This kind of connection has its own fixed actions; named actions are for web services and databases.
        </Callout>
      )}
      {json !== null ? (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            Each action: id, name, description, kind (read or write), params, and either method + path (web services) or sql (databases). Add a watch to start
            duties for new items.
          </p>
          <textarea
            className="input min-h-[28rem] font-mono text-xs"
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            aria-label="Actions as JSON"
          />
        </div>
      ) : (
        <div className="space-y-6">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">Actions ({draft.length})</h3>
            {draft.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
                No actions yet: AI employees can't use this connection until you add some.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {draft.map((action, index) => (
                  <ActionRow
                    key={action.id}
                    action={action}
                    onChange={(next) => setDraft(draft.map((a, i) => (i === index ? next : a)))}
                    onRemove={() => setDraft(draft.filter((_, i) => i !== index))}
                    onTry={() => setTrying(trying === action.id ? null : action.id)}
                  >
                    {trying === action.id && (
                      <div className="mt-3">
                        {!saved.data?.actions.some((a) => a.id === action.id) ? (
                          <p className="text-xs text-amber-700 dark:text-amber-300">Save first: only saved actions can be tried.</p>
                        ) : (
                          <TryForm connection={connection} action={action} onClose={() => setTrying(null)} />
                        )}
                      </div>
                    )}
                  </ActionRow>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
              <Plus className="size-4 text-muted" /> Add actions
            </h3>
            {proposed ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">Pick the ones AI employees may use. You can rename them after adding.</p>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {proposed.map((a) => {
                    const already = draft.some((d) => d.id === a.id);
                    return (
                      <li key={a.id}>
                        <label className={clsx("flex items-start gap-3 px-4 py-2.5", already ? "opacity-60" : "cursor-pointer hover:bg-subtle/50")}>
                          <input
                            type="checkbox"
                            className="mt-1 accent-brand-600"
                            disabled={already}
                            checked={picked.has(a.id)}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(a.id);
                              else next.delete(a.id);
                              setPicked(next);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                              {a.name}
                              <Badge size="xs" tone={a.kind === "write" ? "amber" : "blue"}>
                                {a.kind === "write" ? "changes data" : "reads"}
                              </Badge>
                              {already && <span className="text-xs font-normal text-muted">already added</span>}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-faint">{technical(a)}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" icon={Check} disabled={!picked.size} onClick={addPicked}>
                    Add {picked.size || ""} selected
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setProposed(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : connection.type === "mcp-server" ? (
              <McpImporter
                connection={connection}
                onProposed={(actions) => {
                  setProposed(actions);
                  setPicked(new Set(actions.filter((a) => a.kind === "read").map((a) => a.id)));
                }}
              />
            ) : connection.type === "rest-api" ? (
              <Importer
                connection={connection}
                onProposed={(actions) => {
                  setProposed(actions);
                  setPicked(new Set(actions.filter((a) => a.kind === "read").map((a) => a.id)));
                }}
              />
            ) : (
              <p className="flex items-start gap-2 text-sm text-muted">
                <FileCode2 className="mt-0.5 size-4 shrink-0" />
                For a database, write each action as a named query with <code>:param</code> values under “Edit as JSON”. Changes run only through actions marked
                “changes data”.
              </p>
            )}
          </section>

          {mine.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
                <Eye className="size-4 text-muted" /> Watched for new work
              </h3>
              <ul className="space-y-1.5 text-sm">
                {mine.map((w) => (
                  <li key={w.watching} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{w.watching}</span>
                    <span className="text-xs text-muted">
                      {w.lastPolledAt ? `checked ${timeAgo(w.lastPolledAt)} · ${w.lastCount} new last time` : "not checked yet"}
                    </span>
                    {w.lastError && <span className="text-xs text-red-600 dark:text-red-400">{w.lastError}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
