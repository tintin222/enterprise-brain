import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Save, Settings2, Table2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { api, isApiError } from "../../api.ts";
import { blockSpan, BlockView, type BlockContext } from "../../components/apps/Blocks.tsx";
import { Button, ButtonLink, IconButton } from "../../components/Button.tsx";
import { PageHeader } from "../../components/Card.tsx";
import { Drawer } from "../../components/Dialog.tsx";
import { Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { namedIcon } from "../../lib/icons.tsx";
import { keys, useAgent, useAppDetail, useDepartments } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AppDetail, AppPageSpec, AppView } from "../../types.ts";

/** An app: its pages as tabs, each page's blocks drawn from its tables. */
export default function AppPage() {
  const { key = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const detail = useAppDetail(key);
  const departments = useDepartments();
  const [designing, setDesigning] = useState(false);
  // Addresses from before apps: /apps/<slug> was an AI employee's own form.
  const agent = useAgent(isApiError(detail.error, 404) ? key : undefined);
  const context = useMemo<BlockContext>(
    () => ({
      tables: new Map((detail.data?.tables ?? []).map((t) => [t.key, t])),
      agents: new Map((detail.data?.agents ?? []).map((a) => [a.slug, a.name])),
      calculations: new Map((detail.data?.calculations ?? []).map((c) => [c.key, c])),
    }),
    [detail.data],
  );

  if (agent.data) return <Navigate to={`/ai/${agent.data.agent.slug}/app`} replace />;
  if (detail.isLoading || (isApiError(detail.error, 404) && agent.isLoading)) return <LoadingBlock className="min-h-[50vh]" />;
  if (detail.error || !detail.data) {
    return (
      <Page>
        <ErrorState error={detail.error ?? new Error("There is no such app")} />
      </Page>
    );
  }
  const { app } = detail.data;
  const pages = app.pages;
  const current = pages.find((p) => p.key === params.get("page")) ?? pages[0]!;
  const Icon = namedIcon(app.icon, Table2);
  const department = app.departmentId ? departments.data?.find((d) => d.id === app.departmentId)?.name : "The whole company";

  return (
    <Page wide>
      <PageHeader
        icon={Icon}
        eyebrow={`Apps · ${department ?? "A department"}`}
        title={app.name}
        description={app.description || undefined}
        actions={
          <>
            {detail.data.tables.map((t) => (
              <ButtonLink key={t.key} to={`/tables/${t.key}`} icon={Table2} variant="ghost" size="sm">
                {t.name}
              </ButtonLink>
            ))}
            {app.can.design && (
              <Button icon={Settings2} onClick={() => setDesigning(true)}>
                Change the app
              </Button>
            )}
          </>
        }
      />
      {app.archivedAt && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">This app is archived.</p>
      )}
      {pages.length > 1 && (
        <Tabs
          className="mb-5"
          tabs={pages.map((p) => ({ id: p.key, label: p.title }))}
          value={current.key}
          onChange={(page) => {
            const next = new URLSearchParams(params);
            next.set("page", page);
            setParams(next, { replace: true });
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
        {current.blocks.map((block, index) => (
          <div key={`${current.key}-${index}`} className={clsx("col-span-1 sm:col-span-12", blockSpan(block))}>
            <BlockView block={block} context={context} />
          </div>
        ))}
      </div>
      {app.can.design && <AppDesignDrawer detail={detail.data} open={designing} onClose={() => setDesigning(false)} />}
    </Page>
  );
}

/** Change an app: its name, who uses it, its pages and their order, what's on them; or archive it. */
function AppDesignDrawer({ detail, open, onClose }: { detail: AppDetail; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { app, outline } = detail;
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [visibility, setVisibility] = useState(app.settings.visibility);
  const [pages, setPages] = useState<AppPageSpec[]>(app.pages);
  useEffect(() => {
    if (!open) return;
    setName(app.name);
    setDescription(app.description);
    setVisibility(app.settings.visibility);
    setPages(app.pages);
  }, [open, app]);
  const words = new Map(outline.map((p) => [p.key, p.blocks]));
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.apps(company) });
  const save = useMutation({
    mutationFn: () => api.patch<AppView>(path(`/apps/${encodeURIComponent(app.key)}`), { name, description, pages, settings: { visibility } }),
    onSuccess: async () => {
      toast.success(`${name} changed`);
      await refresh();
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api.post<AppView>(path(`/apps/${encodeURIComponent(app.key)}/${app.archivedAt ? "restore" : "archive"}`)),
    onSuccess: async () => {
      toast.success(app.archivedAt ? `${app.name} is back` : `${app.name} archived`);
      await refresh();
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  const movePage = (index: number, by: number) => {
    const next = [...pages];
    const [page] = next.splice(index, 1);
    next.splice(index + by, 0, page!);
    setPages(next);
  };
  const removeBlock = (pageIndex: number, blockIndex: number) =>
    setPages(pages.map((p, i) => (i === pageIndex ? { ...p, blocks: p.blocks.filter((_, j) => j !== blockIndex) } : p)).filter((p) => p.blocks.length));
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={`Change ${app.name}`}
      description="Rename it, choose who uses it, and arrange its pages. To add something new, describe it to the Studio."
      footer={
        <>
          <Button variant="ghost" icon={app.archivedAt ? ArchiveRestore : Archive} loading={archive.isPending} onClick={() => archive.mutate()}>
            {app.archivedAt ? "Bring the app back" : "Archive the app"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} loading={save.isPending} disabled={!name.trim() || !pages.length} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {save.error && <ErrorState error={save.error} title="Not changed" />}
        <Field label="Name" required>
          {(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="What it's for" optional>
          {(id) => <textarea id={id} className="input min-h-16" value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Who uses it" hint="People see only the tables they may see; its department's people change the records.">
          {(id) => (
            <select id={id} className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as AppView["settings"]["visibility"])}>
              <option value="department">Its department's people</option>
              <option value="company">Everyone in the company</option>
            </select>
          )}
        </Field>
        <div>
          <p className="label">Pages</p>
          <ol className="space-y-2">
            {pages.map((page, pageIndex) => {
              const said = words.get(page.key) ?? [];
              return (
                <li key={page.key} className="rounded-xl border border-line p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="input flex-1"
                      aria-label="Page title"
                      value={page.title}
                      onChange={(e) => setPages(pages.map((p, i) => (i === pageIndex ? { ...p, title: e.target.value } : p)))}
                    />
                    <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={pageIndex === 0} onClick={() => movePage(pageIndex, -1)} />
                    <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={pageIndex === pages.length - 1} onClick={() => movePage(pageIndex, 1)} />
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {page.blocks.map((block, blockIndex) => (
                      <li key={blockIndex} className="flex items-start gap-2 text-sm text-muted">
                        <span className="min-w-0 flex-1">{said[blockIndex] ?? block.type}</span>
                        <IconButton icon={Trash2} label="Take it off the page" size="sm" onClick={() => removeBlock(pageIndex, blockIndex)} />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </Drawer>
  );
}
