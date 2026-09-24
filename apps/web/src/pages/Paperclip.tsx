import { useMutation, useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
  Network,
  Package,
  Paperclip as PaperclipIcon,
  Send,
  Server,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { api, downloadWithAuth, getApiKey, qs } from "../api.ts";
import { Badge } from "../components/Badge.tsx";
import { Button, ButtonAnchor } from "../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../components/Card.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { Checkbox, Field, Switch } from "../components/Form.tsx";
import { JsonDetails } from "../components/JsonView.tsx";
import { Page } from "../components/Layout.tsx";
import { Callout, ErrorState, Spinner } from "../components/Spinner.tsx";
import { Segmented } from "../components/Tabs.tsx";
import { useCompany } from "../lib/company.tsx";
import { useCatalog, useDepartments } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { PaperclipPackage, PaperclipPushResult } from "../types.ts";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), file: false };
  for (const p of paths.sort()) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map(), file: isFile };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function TreeView({ node, depth, selected, onSelect }: { node: TreeNode; depth: number; selected: string | null; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const children = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  if (node.file) {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={clsx(
          "flex w-full items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left text-[13px]",
          selected === node.path ? "bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-fg hover:bg-subtle",
        )}
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        <File className="size-3.5 shrink-0 text-faint" /> <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <div>
      {node.name && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1 rounded-md py-1 text-left text-[13px] font-medium text-fg hover:bg-subtle"
          style={{ paddingLeft: depth * 12 }}
        >
          {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" /> : <ChevronRight className="size-3.5 shrink-0 text-faint" />}
          <Folder className="size-3.5 shrink-0 text-amber-500" /> <span className="truncate">{node.name}</span>
        </button>
      )}
      {(open || !node.name) &&
        children.map((c) => <TreeView key={c.path} node={c} depth={node.name ? depth + 1 : depth} selected={selected} onSelect={onSelect} />)}
    </div>
  );
}

export default function Paperclip() {
  const { info, path, company } = useCompany();
  const toast = useToast();
  const origin = window.location.origin;
  const [scope, setScope] = useState<"installed" | "catalog">("installed");
  const [selectedDepts, setSelectedDepts] = useState<string[]>([]);
  const [ceo, setCeo] = useState(true);
  const [built, setBuilt] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const installed = useDepartments();
  const catalog = useCatalog();
  const departments =
    scope === "installed"
      ? (installed.data ?? []).map((d) => ({ id: d.key, name: d.name }))
      : (catalog.data?.departments ?? []).map((d) => ({ id: d.id, name: d.name }));

  const params = qs({ scope, departments: selectedDepts.join(",") || undefined, ceo: ceo ? "true" : "false" });
  const pkg = useQuery({
    queryKey: [company, "paperclip", built],
    queryFn: () => api.get<PaperclipPackage>(path(`/paperclip/package${built ?? ""}`)),
    enabled: built !== null,
  });
  const paths = useMemo(() => Object.keys(pkg.data?.files ?? {}), [pkg.data]);
  const tree = useMemo(() => buildTree(paths), [paths]);
  const current = file && pkg.data?.files[file] !== undefined ? file : (paths.find((p) => /readme|company|COMPANY/i.test(p)) ?? paths[0] ?? null);

  const [push, setPush] = useState({
    paperclipUrl: info.paperclip.url ?? "",
    paperclipApiKey: "",
    target: "new_company" as "new_company" | "existing_company",
    paperclipCompanyId: "",
  });
  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<PaperclipPushResult>(path("/paperclip/push"), {
        paperclipUrl: push.paperclipUrl || undefined,
        paperclipApiKey: push.paperclipApiKey || undefined,
        target: push.target,
        paperclipCompanyId: push.target === "existing_company" ? push.paperclipCompanyId : undefined,
        departments: selectedDepts.length ? selectedDepts : undefined,
      }),
    onSuccess: (res) =>
      toast.success("Pushed to Paperclip", {
        description: `${res.summary.agents} agents, ${res.summary.departments} departments, ${res.summary.routines} routines.`,
      }),
    onError: (e) => toast.error(e),
  });

  const zipHref = path(`/paperclip/package.zip${params}`);
  const onZip = (e: MouseEvent) => {
    if (!getApiKey()) return;
    e.preventDefault();
    downloadWithAuth(zipHref, `${company}-paperclip.zip`).catch((err) => toast.error(err));
  };

  const hermes = JSON.stringify({ apiBaseUrl: `${origin}/api/hermes`, apiKey: "<EB_HERMES_API_KEY>", payloadTemplate: { agent: "<slug>" } }, null, 2);
  const mcpUrl = `${origin}/mcp`;

  const submitPush = (e: FormEvent) => {
    e.preventDefault();
    pushMutation.mutate();
  };

  return (
    <Page>
      <PageHeader
        icon={PaperclipIcon}
        title="Paperclip"
        description="Run Enterprise Brain agents as employees of a Paperclip company: Paperclip provides the org chart, tasks, heartbeats, budgets and governance; Enterprise Brain provides the enterprise knowledge, connectors and agent runtime."
        actions={
          info.paperclip.configured ? <Badge tone="green">Connected to {info.paperclip.url}</Badge> : <Badge tone="neutral">PAPERCLIP_URL not set</Badge>
        }
      />

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: Users,
            title: "Org chart & governance",
            text: "Paperclip is the control plane: who reports to whom, tasks, heartbeats, budgets and approvals across all your AI employees.",
          },
          {
            icon: Network,
            title: "Hired via hermes_gateway",
            text: "Each Enterprise Brain agent becomes a Paperclip employee whose adapter calls this instance's Hermes gateway to do the work.",
          },
          {
            icon: Server,
            title: "Also an MCP server",
            text: "Any MCP client (Claude, IDEs, other agents) can search knowledge, list and run agents and read connected systems.",
          },
        ].map((c) => (
          <Card key={c.title} className="p-5">
            <c.icon className="size-5 text-brand-600 dark:text-brand-300" />
            <h3 className="mt-3 text-sm font-semibold text-fg">{c.title}</h3>
            <p className="mt-1 text-[13px] text-muted">{c.text}</p>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader
            title="Company package"
            subtitle="A Paperclip company import: CEO, department leads, specialists, projects and routines."
            icon={Package}
          />
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-4">
              <Segmented
                value={scope}
                onChange={(v) => {
                  setScope(v);
                  setSelectedDepts([]);
                }}
                options={[
                  { value: "installed", label: "Installed model" },
                  { value: "catalog", label: "Whole catalog" },
                ]}
              />
              <Switch checked={ceo} onChange={setCeo} label="Include a CEO" />
            </div>
            <div>
              <p className="label">Departments</p>
              {departments.length === 0 ? (
                <p className="text-sm text-muted">
                  {scope === "installed"
                    ? "No departments installed yet — switch to the whole catalog or install one first."
                    : "No departments in the catalog."}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {departments.map((d) => (
                    <Checkbox
                      key={d.id}
                      label={d.name}
                      checked={selectedDepts.includes(d.id)}
                      onChange={(on) => setSelectedDepts(on ? [...selectedDepts, d.id] : selectedDepts.filter((x) => x !== d.id))}
                    />
                  ))}
                </div>
              )}
              <p className="hint">None selected = all departments.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={Package} loading={pkg.isFetching} onClick={() => (built === params ? void pkg.refetch() : setBuilt(params))}>
                Build package
              </Button>
              <ButtonAnchor href={zipHref} onClick={onZip} icon={Download}>
                Download .zip
              </ButtonAnchor>
            </div>
            {pkg.error && <ErrorState error={pkg.error} />}
            {pkg.isFetching && !pkg.data && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner size="sm" /> Building…
              </p>
            )}
            {pkg.data && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="brand">{pkg.data.summary.departments} departments</Badge>
                  <Badge tone="brand">{pkg.data.summary.agents} agents</Badge>
                  <Badge tone="brand">{pkg.data.summary.routines} routines</Badge>
                  <Badge>{paths.length} files</Badge>
                </div>
                {pkg.data.warnings.length > 0 && (
                  <Callout tone="warning" icon={TriangleAlert} title="Warnings">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {pkg.data.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </Callout>
                )}
                <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-line md:grid-cols-[250px_minmax(0,1fr)]">
                  <div className="max-h-[480px] overflow-y-auto border-b border-line bg-subtle/40 p-2 md:border-r md:border-b-0">
                    <TreeView node={tree} depth={0} selected={current} onSelect={setFile} />
                  </div>
                  <div className="min-w-0">
                    {current && (
                      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                        <span className="truncate font-mono text-xs text-muted">{current}</span>
                        <CopyButton text={pkg.data.files[current] ?? ""} iconOnly label="Copy file" />
                      </div>
                    )}
                    <pre className="max-h-[440px] overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
                      {current ? pkg.data.files[current] : "Select a file"}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Push to Paperclip"
              subtitle="Imports the package through Paperclip's API and wires each agent's hermes_gateway key."
              icon={Send}
            />
            <form onSubmit={submitPush} className="space-y-4 p-5">
              <Field label="Paperclip URL" hint={info.paperclip.configured ? "Defaults to PAPERCLIP_URL." : undefined}>
                {(id) => (
                  <input
                    id={id}
                    type="url"
                    className="input"
                    placeholder="http://localhost:3100"
                    value={push.paperclipUrl}
                    onChange={(e) => setPush({ ...push, paperclipUrl: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Paperclip API key" optional>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    autoComplete="off"
                    className="input"
                    value={push.paperclipApiKey}
                    onChange={(e) => setPush({ ...push, paperclipApiKey: e.target.value })}
                  />
                )}
              </Field>
              <div>
                <span className="label">Target</span>
                <Segmented
                  value={push.target}
                  onChange={(v) => setPush({ ...push, target: v })}
                  options={[
                    { value: "new_company", label: "New company" },
                    { value: "existing_company", label: "Existing company" },
                  ]}
                />
              </div>
              {push.target === "existing_company" && (
                <Field label="Paperclip company id" required>
                  {(id) => (
                    <input
                      id={id}
                      className="input font-mono text-xs"
                      value={push.paperclipCompanyId}
                      onChange={(e) => setPush({ ...push, paperclipCompanyId: e.target.value })}
                    />
                  )}
                </Field>
              )}
              <Button
                type="submit"
                variant="primary"
                icon={Send}
                loading={pushMutation.isPending}
                disabled={push.target === "existing_company" && !push.paperclipCompanyId}
              >
                Push
              </Button>
              {pushMutation.data && (
                <div className="space-y-2">
                  <Callout tone="success">Imported {pushMutation.data.summary.agents} agents into Paperclip.</Callout>
                  <JsonDetails data={pushMutation.data.paperclip} label="Paperclip response" />
                </div>
              )}
            </form>
          </Card>

          <Card>
            <CardHeader title="Configuration snippets" icon={Server} />
            <div className="space-y-5 p-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-sm font-medium text-fg">hermes_gateway adapter</p>
                  <CopyButton text={hermes} label="Copy" size="xs" />
                </div>
                <pre className="overflow-x-auto rounded-lg border border-line bg-subtle/60 p-3 font-mono text-xs text-fg">{hermes}</pre>
                <p className="hint">Use in a Paperclip agent's adapter config; replace &lt;slug&gt; with the agent's slug.</p>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-sm font-medium text-fg">MCP server URL</p>
                  <CopyButton text={mcpUrl} label="Copy" size="xs" />
                </div>
                <pre className="overflow-x-auto rounded-lg border border-line bg-subtle/60 p-3 font-mono text-xs text-fg">{mcpUrl}</pre>
                <p className="hint">
                  Streamable HTTP. {info.authRequired ? "Send Authorization: Bearer <EB_API_KEY>." : "No key needed in local trusted mode."}
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
