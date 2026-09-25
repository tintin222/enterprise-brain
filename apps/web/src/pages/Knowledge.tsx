import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BookOpen, FileText, FolderPlus, Layers, Plus, Search, Trash, Type } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { api, qs } from "../api.ts";
import { Badge, StatusPill } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../components/Card.tsx";
import { Dialog, Drawer } from "../components/Dialog.tsx";
import { Dropzone } from "../components/Dropzone.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FileLink } from "../components/FileLink.tsx";
import { Field } from "../components/Form.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton, Spinner } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import { keys, useCollections } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { KnowledgeCollection, KnowledgeDocument, KnowledgeDocumentDetail, SearchResponse } from "../types.ts";

function useKnowledgeInvalidate() {
  const { company } = useCompany();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.knowledge(company) });
    void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
  };
}

function NewCollectionDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: KnowledgeCollection) => void }) {
  const { path } = useCompany();
  const toast = useToast();
  const invalidate = useKnowledgeInvalidate();
  const [form, setForm] = useState({ name: "", key: "", description: "" });
  const create = useMutation({
    mutationFn: () =>
      api.post<KnowledgeCollection>(path("/knowledge/collections"), {
        name: form.name,
        key: form.key || undefined,
        description: form.description || undefined,
      }),
    onSuccess: (c) => {
      invalidate();
      toast.success(`Collection “${c.name}” created`);
      setForm({ name: "", key: "", description: "" });
      onCreated(c);
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.name.trim()) create.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New collection"
      description="Group documents by topic and owner, e.g. “HR policies” or “Product manuals”."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.name.trim()} onClick={() => create.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" required>
          {(id) => (
            <input
              id={id}
              autoFocus
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="HR policies"
            />
          )}
        </Field>
        <Field label="Key" optional hint="How AI employees refer to the collection. Derived from the name when empty.">
          {(id) => (
            <input
              id={id}
              className="input font-mono text-xs"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="hr-policies"
            />
          )}
        </Field>
        <Field label="Description" optional>
          {(id) => <textarea id={id} rows={2} className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

function AddTextDialog({ open, onClose, collection }: { open: boolean; onClose: () => void; collection: string }) {
  const { path } = useCompany();
  const toast = useToast();
  const invalidate = useKnowledgeInvalidate();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.post<KnowledgeDocument>(path("/knowledge/documents"), { collection, title, text }),
    onSuccess: (doc) => {
      invalidate();
      toast.success(`Added “${doc.title}”`, { description: `${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"} indexed` });
      setTitle("");
      setText("");
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add text"
      description={`Paste a policy, an FAQ or any text. It's chunked and indexed into “${collection}”.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!title.trim() || !text.trim()} onClick={() => add.mutate()}>
            Add to knowledge base
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          {(id) => <input id={id} autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Travel policy 2026" />}
        </Field>
        <Field label="Text" required hint="Markdown headings help the chunker keep sections together.">
          {(id) => <textarea id={id} rows={12} className="input" value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function DocumentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const doc = useQuery({
    queryKey: [...keys.knowledge(company), "document", id],
    queryFn: () => api.get<KnowledgeDocumentDetail>(path(`/knowledge/documents/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
  });
  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      width="lg"
      title={doc.data?.title ?? "Document"}
      description={doc.data ? `${doc.data.chunkCount} chunks · ${doc.data.source} · added ${formatDateTime(doc.data.createdAt)}` : undefined}
    >
      {doc.isLoading && <Skeleton className="h-40" />}
      {doc.error && <ErrorState error={doc.error} />}
      {doc.data && (
        <div className="space-y-3">
          {doc.data.fileId && <FileLink fileId={doc.data.fileId} name="Download the original file" className="text-sm" />}
          {doc.data.chunks.map((c) => (
            <div key={c.id} className="rounded-lg border border-line p-3">
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Chunk {c.ordinal + 1}</p>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{c.content}</p>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

function SearchPlayground({ collection }: { collection?: string }) {
  const { path } = useCompany();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"current" | "all">(collection ? "current" : "all");
  const search = useMutation({
    mutationFn: (q: string) =>
      api.post<SearchResponse>(path("/knowledge/search"), { query: q, topK: 8, collections: scope === "current" && collection ? [collection] : undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) search.mutate(query.trim());
  };
  return (
    <Card>
      <CardHeader title="Search playground" subtitle="See exactly what AI employees find: vector and full-text search combined." icon={Search} />
      <div className="space-y-4 p-5">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input flex-1"
            placeholder="e.g. How many days of annual leave do I get?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
          {collection && (
            <select className="input w-auto" value={scope} onChange={(e) => setScope(e.target.value as "current" | "all")} aria-label="Scope">
              <option value="current">This collection</option>
              <option value="all">All collections</option>
            </select>
          )}
          <Button type="submit" variant="primary" icon={Search} loading={search.isPending}>
            Search
          </Button>
        </form>
        {search.error && <ErrorState error={search.error} />}
        {search.data && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {search.data.hits.length} hits in {search.data.tookMs} ms · embeddings: {search.data.embeddingModel}
            </p>
            {search.data.hits.length === 0 && <p className="text-sm text-muted">Nothing found — try other words or add documents.</p>}
            {search.data.hits.map((h, i) => (
              <div key={h.chunkId} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-faint">#{i + 1}</span>
                  <span className="text-sm font-medium text-fg">{h.title}</span>
                  <Badge size="xs">{h.collectionKey}</Badge>
                  <span className="ml-auto flex flex-wrap gap-1.5">
                    <Badge size="xs" tone="brand" title="Fused relevance score (0–1)">
                      score {h.score.toFixed(3)}
                    </Badge>
                    <Badge size="xs" title="Rank in the vector (semantic) retriever">
                      vector #{h.vectorRank ?? "—"}
                    </Badge>
                    <Badge size="xs" title="Rank in the full-text retriever">
                      text #{h.textRank ?? "—"}
                    </Badge>
                  </span>
                </div>
                <p className="mt-2 line-clamp-5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{h.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

export default function Knowledge() {
  const { company, path } = useCompany();
  const toast = useToast();
  const invalidate = useKnowledgeInvalidate();
  const [params, setParams] = useSearchParams();
  const selected = params.get("collection") ?? "";
  const openDoc = params.get("doc");
  const [newCollection, setNewCollection] = useState(false);
  const [addText, setAddText] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<KnowledgeCollection | null>(null);
  const collections = useCollections();
  const current = collections.data?.find((c) => c.key === selected || c.id === selected);

  const documents = useQuery({
    queryKey: [...keys.knowledge(company), "documents", { collection: selected }],
    queryFn: () => api.get<KnowledgeDocument[]>(path(`/knowledge/documents${qs({ collection: selected || undefined })}`)),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending" || d.status === "processing") ? 2000 : false),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      form.append("collection", current?.key ?? "general");
      for (const f of files) form.append("files", f, f.name);
      return api.upload<KnowledgeDocument[]>(path("/knowledge/documents"), form);
    },
    onSuccess: (docs) => {
      invalidate();
      const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);
      toast.success(`Indexed ${docs.length} document${docs.length === 1 ? "" : "s"}`, { description: `${chunks} chunk${chunks === 1 ? "" : "s"}` });
    },
    onError: (e) => toast.error(e),
  });

  const removeDoc = useMutation({
    mutationFn: (id: string) => api.del(path(`/knowledge/documents/${encodeURIComponent(id)}`)),
    onSuccess: () => {
      invalidate();
      toast.success("Document removed");
    },
    onError: (e) => toast.error(e),
  });

  const removeCollection = useMutation({
    mutationFn: (key: string) => api.del(path(`/knowledge/collections/${encodeURIComponent(key)}`)),
    onSuccess: () => {
      invalidate();
      toast.success("Collection deleted");
      setConfirmDelete(null);
      select(null);
    },
    onError: (e) => toast.error(e),
  });

  const select = (key: string | null) => {
    const next = new URLSearchParams(params);
    if (key) next.set("collection", key);
    else next.delete("collection");
    next.delete("doc");
    setParams(next, { replace: true });
  };
  const setDoc = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("doc", id);
    else next.delete("doc");
    setParams(next, { replace: true });
  };

  const collectionName = (id: string) => collections.data?.find((c) => c.id === id)?.name ?? "—";

  return (
    <Page wide>
      <PageHeader
        icon={BookOpen}
        title="Knowledge base"
        description="Documents and policies AI employees answer from, with sources. Upload documents or paste text into collections."
        actions={
          <Button variant="primary" icon={FolderPlus} onClick={() => setNewCollection(true)}>
            New collection
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden">
          <div className="border-b border-line px-4 py-3 text-xs font-semibold tracking-wide text-muted uppercase">Collections</div>
          {collections.isLoading && <Skeleton className="m-3 h-32" />}
          {collections.error && <ErrorState error={collections.error} className="m-3" />}
          <ul className="p-2">
            <li>
              <button
                type="button"
                onClick={() => select(null)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
                  !selected ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-400/15 dark:text-brand-200" : "text-fg hover:bg-subtle",
                )}
              >
                <Layers className="size-4 shrink-0" /> All documents
              </button>
            </li>
            {(collections.data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => select(c.key)}
                  className={clsx("w-full rounded-lg px-3 py-2 text-left", selected === c.key ? "bg-brand-50 dark:bg-brand-400/15" : "hover:bg-subtle")}
                >
                  <span className={clsx("block truncate text-sm font-medium", selected === c.key ? "text-brand-700 dark:text-brand-200" : "text-fg")}>
                    {c.name}
                  </span>
                  <span className="block text-xs text-faint">
                    {c.documentCount} docs · {c.chunkCount} chunks
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {collections.data && collections.data.length === 0 && <p className="px-4 pb-4 text-xs text-muted">No collections yet — create one to start.</p>}
          <div className="border-t border-line p-2">
            <Button size="sm" variant="ghost" icon={Plus} className="w-full justify-start" onClick={() => setNewCollection(true)}>
              New collection
            </Button>
          </div>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-fg">{current?.name ?? "All documents"}</h2>
                <p className="text-[13px] text-muted">
                  {current ? current.description || <span className="font-mono text-xs">{current.key}</span> : "Every document across all collections."}
                </p>
              </div>
              {current && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" icon={Type} onClick={() => setAddText(true)}>
                    Add text
                  </Button>
                  <Button size="sm" variant="ghost" icon={Trash} onClick={() => setConfirmDelete(current)} aria-label="Delete collection" />
                </div>
              )}
            </div>
            {current ? (
              <div className="border-b border-line p-4">
                <Dropzone
                  busy={upload.isPending}
                  onFiles={(files) => upload.mutate(files)}
                  label={`Drop files to add them to “${current.name}”`}
                  hint="PDF, Word, Excel, text, images (OCR). Several files at once."
                  compact
                />
              </div>
            ) : (
              (collections.data?.length ?? 0) > 0 && (
                <p className="border-b border-line px-5 py-3 text-xs text-muted">Select a collection to upload files or add text.</p>
              )
            )}
            {documents.isLoading && <Skeleton className="m-4 h-32" />}
            {documents.error && <ErrorState error={documents.error} className="m-4" />}
            {documents.data && documents.data.length === 0 && (
              <EmptyState
                compact
                className="m-4"
                icon={FileText}
                title="No documents yet"
                description={
                  current
                    ? "Drop files above or paste text. AI employees can use them right away."
                    : "Create a collection, then add your policies, procedures and manuals."
                }
              />
            )}
            {documents.data && documents.data.length > 0 && (
              <div className="relative overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line bg-subtle/50 text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Title</th>
                      {!current && <th className="px-4 py-2.5 font-medium">Collection</th>}
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 text-right font-medium">Chunks</th>
                      <th className="px-4 py-2.5 font-medium">Source</th>
                      <th className="px-4 py-2.5 font-medium">Added</th>
                      <th className="px-4 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {documents.data.map((d) => (
                      <tr key={d.id} className="cursor-pointer hover:bg-subtle/50" onClick={() => setDoc(d.id)}>
                        <td className="max-w-[20rem] px-4 py-2.5">
                          <span className="flex items-center gap-2">
                            <FileText className="size-4 shrink-0 text-faint" />
                            <span className="truncate font-medium text-fg">{d.title}</span>
                          </span>
                        </td>
                        {!current && <td className="px-4 py-2.5 whitespace-nowrap text-muted">{collectionName(d.collectionId)}</td>}
                        <td className="px-4 py-2.5">
                          <StatusPill status={d.status} size="xs" />
                        </td>
                        <td className="px-4 py-2.5 text-right text-muted tabular-nums">{d.chunkCount}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted">{d.source}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted">{timeAgo(d.createdAt)}</td>
                        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="xs"
                            variant="ghost"
                            icon={Trash}
                            loading={removeDoc.isPending && removeDoc.variables === d.id}
                            onClick={() => removeDoc.mutate(d.id)}
                            aria-label={`Delete ${d.title}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {upload.isPending && (
              <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-sm text-muted">
                <Spinner size="sm" /> Reading and indexing your files…
              </p>
            )}
          </Card>
          <SearchPlayground key={current?.key ?? "all"} collection={current?.key} />
        </div>
      </div>

      <NewCollectionDialog open={newCollection} onClose={() => setNewCollection(false)} onCreated={(c) => select(c.key)} />
      {current && <AddTextDialog open={addText} onClose={() => setAddText(false)} collection={current.key} />}
      <DocumentDrawer id={openDoc} onClose={() => setDoc(null)} />
      <Dialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        size="sm"
        title={`Delete “${confirmDelete?.name}”?`}
        description="All documents in the collection are removed. AI employees using it will no longer find them."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="danger" loading={removeCollection.isPending} onClick={() => confirmDelete && removeCollection.mutate(confirmDelete.key)}>
              Delete collection
            </Button>
          </>
        }
      />
    </Page>
  );
}
