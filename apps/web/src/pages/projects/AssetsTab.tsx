import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Brain, Layers, Plug, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader } from "../../components/Card.tsx";
import { MentionPicker, useMentionHits } from "../../components/chat/MentionPicker.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Dropzone } from "../../components/Dropzone.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { FileLink } from "../../components/FileLink.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { paths } from "../../lib/paths.ts";
import { keys, useAgents, useConnectorCatalog, useConnectors, useProjectAssets } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { MentionHit, ProjectAsset, ProjectAssetKind, ProjectView } from "../../types.ts";
import { ASSET_ICONS, ASSET_KINDS, ASSET_LABELS, assetHref } from "./shared.tsx";

/** What "@" would offer, as the picker of things to add: things of the brain, tables, apps, calculations, documents and files. */
function AddFromBrainDialog({
  project,
  open,
  onClose,
  onAdd,
}: {
  project: ProjectView;
  open: boolean;
  onClose: () => void;
  onAdd: (hit: MentionHit) => Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const hits = useMentionHits(open ? query : null, { kinds: ["thing", "table", "app", "calculation", "document", "file"], scope: "company" });
  const list = hits.data ?? [];
  const pick = async (hit: MentionHit) => {
    setBusy(`${hit.kind}:${hit.id}`);
    try {
      await onAdd(hit);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add to ${project.name}`}
      description="Search the brain and the company's data: things, tables, apps, calculations, documents and files."
    >
      <input
        className="input w-full"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(list.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && list[active]) {
            e.preventDefault();
            void pick(list[active]);
          }
        }}
        placeholder="Type part of a name…"
        aria-label="What to add"
        autoFocus
      />
      <div className="mt-3">
        <MentionPicker
          hits={list}
          active={active}
          looking={hits.isLoading || Boolean(busy)}
          onHover={setActive}
          onPick={(hit) => void pick(hit)}
          className="w-full max-w-none shadow-none"
        />
      </div>
    </Dialog>
  );
}

function AssetRow({ asset, canEdit, onRemove }: { asset: ProjectAsset; canEdit: boolean; onRemove: (asset: ProjectAsset) => void }) {
  const Icon = ASSET_ICONS[asset.kind];
  const href = assetHref(asset);
  const name =
    asset.kind === "file" && asset.exists ? (
      <FileLink fileId={asset.ref} name={asset.name} icon={false} className="font-medium text-fg hover:underline" />
    ) : href && asset.exists ? (
      <Link to={href} className="font-medium text-fg hover:underline">
        {asset.name}
      </Link>
    ) : (
      <span className="font-medium text-fg">{asset.name}</span>
    );
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          {name}
          {!asset.exists && (
            <Badge tone="red" size="xs">
              gone
            </Badge>
          )}
        </p>
        <p className="truncate text-xs text-muted">
          {asset.detail}
          {asset.note ? ` · ${asset.note}` : ""}
        </p>
        <p className="text-[11px] text-faint">
          Added by {asset.addedBy.name} {timeAgo(asset.createdAt)}
        </p>
      </div>
      {canEdit && <Button size="xs" variant="ghost" icon={Trash2} aria-label={`Take ${asset.name} out of the project`} onClick={() => onRemove(asset)} />}
    </li>
  );
}

/** What the project uses, grouped by kind, with the ways to add more. */
export function AssetsTab({ project }: { project: ProjectView }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const assets = useProjectAssets(project.id);
  const connectors = useConnectors();
  const catalog = useConnectorCatalog();
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [connection, setConnection] = useState("");
  const [agent, setAgent] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.project(company, project.id) }),
      queryClient.invalidateQueries({ queryKey: keys.project(company, project.slug) }),
      queryClient.invalidateQueries({ queryKey: keys.projects(company) }),
    ]);
  const add = useMutation({
    mutationFn: (input: { kind: ProjectAssetKind; ref: string; note?: string }) => api.post<ProjectAsset>(path(`/projects/${project.id}/assets`), input),
    onSuccess: async (asset) => {
      toast.success(`Added ${asset.name}`);
      await refresh();
    },
    onError: (error) => toast.error(error),
  });
  const remove = useMutation({
    mutationFn: (asset: ProjectAsset) => api.del(path(`/projects/${project.id}/assets/${asset.id}`)),
    onSuccess: refresh,
    onError: (error) => toast.error(error),
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      return api.upload<ProjectAsset[]>(path(`/projects/${project.id}/files`), form);
    },
    onSuccess: async (added) => {
      toast.success(`Added ${added.length} file${added.length === 1 ? "" : "s"}`);
      await refresh();
    },
    onError: (error) => toast.error(error),
  });
  const list = assets.data?.assets ?? [];
  const groups = ASSET_KINDS.map((kind) => ({ kind, items: list.filter((a) => a.kind === kind) })).filter((g) => g.items.length);
  const held = new Set(list.map((a) => `${a.kind}:${a.ref}`));
  // Real connections first; then the built-in demo systems whose category nothing real serves yet (the runtime's rule).
  const connected = (connectors.data ?? []).filter((c) => !held.has(`connection:${c.id}`));
  const realCategories = new Set((connectors.data ?? []).filter((c) => !c.sandbox).map((c) => c.category));
  const demoSystems = (catalog.data ?? []).filter(
    (m, i, all) =>
      m.maturity === "sandbox" && !held.has(`connection:${m.type}`) && !realCategories.has(m.category) && all.findIndex((o) => o.type === m.type) === i,
  );
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {assets.error && <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />}
        {assets.isLoading && <Skeleton className="h-40" />}
        {assets.data && list.length === 0 && (
          <EmptyState
            icon={Layers}
            title="Nothing picked yet"
            description="Add what the AI employees of this project will need: the processes, systems and people from the brain, the tables and documents, the connections. The Studio adds what it finds, too."
            action={
              project.canEdit ? (
                <Button variant="primary" icon={Brain} onClick={() => setAdding(true)}>
                  Add from the brain
                </Button>
              ) : undefined
            }
          />
        )}
        {groups.map(({ kind, items }) => {
          const Icon = ASSET_ICONS[kind];
          return (
            <Card key={kind} className="overflow-hidden">
              <CardHeader title={ASSET_LABELS[kind][items.length === 1 ? 0 : 1]} icon={Icon} subtitle={`${items.length}`} />
              <ul className="divide-y divide-line">
                {items.map((asset) => (
                  <AssetRow key={asset.id} asset={asset} canEdit={project.canEdit} onRemove={(a) => remove.mutate(a)} />
                ))}
              </ul>
            </Card>
          );
        })}
        {assets.data && assets.data.hidden > 0 && (
          <p className="text-xs text-muted">
            {assets.data.hidden} more belong{assets.data.hidden === 1 ? "s" : ""} to departments you are not in.
          </p>
        )}
      </div>
      {project.canEdit && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Add" subtitle="What the package will carry" />
            <CardBody className="space-y-4">
              <Button variant="primary" icon={Brain} className="w-full" onClick={() => setAdding(true)}>
                Add from the brain and the data
              </Button>
              <Field
                label="A connection"
                hint={
                  <>
                    Named actions go into the package; secrets never do. Connections are set up under{" "}
                    <Link to={paths.settings("connections")} className="font-medium text-fg hover:underline">
                      Settings → Connections
                    </Link>
                    ; the demo systems stand in until then.
                  </>
                }
              >
                {(id) => (
                  <div className="flex gap-2">
                    <select id={id} className="input min-w-0 flex-1" value={connection} onChange={(e) => setConnection(e.target.value)}>
                      <option value="">Choose…</option>
                      {connected.length > 0 && (
                        <optgroup label="Connected">
                          {connected.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {demoSystems.length > 0 && (
                        <optgroup label="Demo systems">
                          {demoSystems.map((m) => (
                            <option key={m.type} value={m.type}>
                              {m.name} (demo)
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <Button
                      icon={Plug}
                      disabled={!connection}
                      loading={add.isPending}
                      onClick={() => add.mutate({ kind: "connection", ref: connection }, { onSuccess: () => setConnection("") })}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Field>
              <Field label="An existing AI employee" hint="One to take as a model, or to be rebuilt outside the platform.">
                {(id) => (
                  <div className="flex gap-2">
                    <select id={id} className="input min-w-0 flex-1" value={agent} onChange={(e) => setAgent(e.target.value)}>
                      <option value="">Choose…</option>
                      {(agents.data ?? [])
                        .filter((a) => !held.has(`agent:${a.id}`))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                    <Button
                      icon={Bot}
                      disabled={!agent}
                      loading={add.isPending}
                      onClick={() => add.mutate({ kind: "agent", ref: agent }, { onSuccess: () => setAgent("") })}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Field>
              <Field label="Files" hint="Specifications, exports, screenshots: they go into the package as they are.">
                <Dropzone
                  compact
                  busy={upload.isPending}
                  onFiles={(files) => upload.mutate(files)}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Upload className="size-4" /> Drop files here, or click
                    </span>
                  }
                />
              </Field>
            </CardBody>
          </Card>
        </div>
      )}
      <AddFromBrainDialog
        project={project}
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(hit) => add.mutateAsync({ kind: hit.kind as ProjectAssetKind, ref: hit.id })}
      />
    </div>
  );
}
