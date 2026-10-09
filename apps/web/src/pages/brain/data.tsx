import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChartColumn, ChevronLeft, ChevronRight, DatabaseZap, ImagePlus, Pencil, Search, ShieldAlert, Sparkles, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { paths } from "../../lib/paths.ts";
import { useToast } from "../../lib/toast.tsx";
import type {
  BrainDataColumn,
  BrainDefinitionSuggestions,
  BrainEntity,
  BrainEntitySummary,
  BrainField,
  BrainImage,
  BrainLineage,
  BrainModel,
  BrainReadOptions,
  BrainReadTablesResult,
} from "../../types.ts";
import { KindIcon, ThingChip, brainKeys, brainPath, useBrainModel } from "./brain.tsx";
import { toneOf } from "./values.tsx";

/**
 * The data catalog in the brain's pages: a table's columns with what they mean in business words
 * (written by people, suggested by Claude), a report's screenshots, where data comes from and goes,
 * and reading a database's tables.
 */

const described = (c: BrainDataColumn) => Boolean(c.business_name || c.definition);

function Coverage({ done, total }: { done: number; total: number }) {
  const share = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2" title={`${done} of ${total} columns described`}>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-subtle">
        <div
          className={clsx("h-full rounded-full", share === 100 ? "bg-emerald-500" : share >= 50 ? "bg-brand-500" : "bg-amber-500")}
          style={{ width: `${share}%` }}
        />
      </div>
      <span className="text-xs text-muted tabular-nums">{share}%</span>
    </div>
  );
}

/** "PK", "FK → KNA1.KUNNR": the target table links to its page when the brain has it. */
function Keys({ keys, thing, model }: { keys: string; thing: BrainEntity; model: BrainModel | undefined }) {
  if (!keys) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {keys.split(/,\s*/).map((part) => {
        if (part === "PK")
          return (
            <Badge key={part} tone="amber" size="xs">
              PK
            </Badge>
          );
        const target = /^FK → ([^.]+)\.?(.*)$/.exec(part);
        const other = target ? thing.links.find((l) => l.relation === "references" && l.direction === "out" && l.other.name === target[1])?.other : undefined;
        return other ? (
          <span key={part} className="inline-flex items-center gap-1 text-[11px] text-muted">
            FK →
            <ThingChip thing={other} model={model} className="!py-0 !text-[11px]" detail={target?.[2] || undefined} />
          </span>
        ) : (
          <Badge key={part} tone="blue" size="xs">
            {part}
          </Badge>
        );
      })}
    </span>
  );
}

interface Draft {
  business_name: string;
  definition: string;
  personal: boolean;
}

/** A table's or data set's columns, with what each means in business words. Managers and admins write them here. */
export function ColumnsCard({ thing, mayEdit }: { thing: BrainEntity; mayEdit: boolean }) {
  const { data: model } = useBrainModel();
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const columns = useMemo(() => (Array.isArray(thing.data.columns) ? (thing.data.columns as BrainDataColumn[]) : []), [thing.data.columns]);
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [table, setTable] = useState<{ business_name: string; definition: string } | null>(null);
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markDocumented, setMarkDocumented] = useState(true);
  const done = columns.filter(described).length;
  const status = typeof thing.data.status === "string" ? thing.data.status : "";
  const isTable = thing.kind === "data_table";
  const database = thing.links.find((l) => l.relation === "table_of" && l.direction === "out")?.other;

  const start = (fill: Record<string, Partial<Draft>> = {}, tableFill?: { business_name: string; definition: string } | null) => {
    const next: Record<string, Draft> = {};
    for (const c of columns) {
      const key = c.name.toLowerCase();
      next[key] = { business_name: c.business_name, definition: c.definition, personal: c.personal, ...fill[key] };
    }
    setDrafts(next);
    setTable(
      tableFill ?? {
        business_name: typeof thing.data.business_name === "string" ? thing.data.business_name : "",
        definition: typeof thing.data.definition === "string" ? thing.data.definition : "",
      },
    );
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setSuggested(new Set());
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const result = await api.post<BrainDefinitionSuggestions>(path(`/brain/entities/${thing.id}/suggest-definitions`), {});
      const fill: Record<string, Partial<Draft>> = {};
      const names = new Set<string>();
      for (const c of result.columns) {
        const before = columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        if (!c.business_name && !c.definition && !c.personal) continue;
        fill[c.name.toLowerCase()] = { business_name: c.business_name, definition: c.definition, personal: c.personal };
        if (before && (before.business_name !== c.business_name || before.definition !== c.definition || before.personal !== c.personal))
          names.add(c.name.toLowerCase());
      }
      setSuggested(names);
      start(
        fill,
        result.table
          ? {
              business_name: result.table.business_name || (typeof thing.data.business_name === "string" ? thing.data.business_name : ""),
              definition: result.table.definition || (typeof thing.data.definition === "string" ? thing.data.definition : ""),
            }
          : null,
      );
      setOnlyMissing(false);
      if (!names.size && !result.table) toast.info("No suggestions: every column already has its words, or the names say too little.");
      else
        toast.info(
          result.by === "ai"
            ? `Claude suggested words for ${names.size} column${names.size === 1 ? "" : "s"}. Check them, then save.`
            : `Read from the column names (no AI model is connected): ${names.size} suggestion${names.size === 1 ? "" : "s"}. Check them, then save.`,
        );
    } catch (error) {
      toast.error(error);
    } finally {
      setSuggesting(false);
    }
  };

  const changed = columns.filter((c) => {
    const d = drafts[c.name.toLowerCase()];
    return d && (d.business_name.trim() !== c.business_name || d.definition.trim() !== c.definition || d.personal !== c.personal);
  });
  const allDescribedAfter = columns.every((c) => {
    const d = drafts[c.name.toLowerCase()];
    return d ? Boolean(d.business_name.trim() || d.definition.trim()) : described(c);
  });
  const offerDocumented = editing && allDescribedAfter && (!status || status === "Needs definitions");

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        columns: changed.map((c) => {
          const d = drafts[c.name.toLowerCase()]!;
          return { name: c.name, business_name: d.business_name.trim(), definition: d.definition.trim(), personal: d.personal };
        }),
      };
      if (table && isTable && table.business_name.trim() !== (thing.data.business_name ?? "")) body.business_name = table.business_name.trim();
      if (table && table.definition.trim() !== (thing.data.definition ?? "")) body.definition = table.definition.trim();
      if (offerDocumented && markDocumented) body.status = "Documented";
      await api.post(path(`/brain/entities/${thing.id}/definitions`), body);
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      toast.success("Definitions saved");
      cancel();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  const words = (text: string) => text.toLowerCase();
  const shown = columns.filter((c) => {
    if (onlyMissing && described(c)) return false;
    if (!q.trim()) return true;
    const needle = words(q.trim());
    return [c.name, c.business_name, c.definition, c.comment].some((v) => words(v ?? "").includes(needle));
  });

  return (
    <Card>
      <CardHeader title="Columns" subtitle="What each column holds, in business words: for people, and for AI employees who query it" />
      <CardBody>
        {columns.length === 0 ? (
          <p className="text-sm text-muted">
            {isTable ? "No columns yet. Read the tables from its database to bring them." : "No columns written down yet."}
            {isTable && database && (
              <>
                {" "}
                <Link to={brainPath(database.id)} className="font-medium text-brand-600 hover:underline dark:text-brand-300">
                  Open {database.name}
                </Link>
              </>
            )}
          </p>
        ) : (
          <>
            {editing && table && (
              <div className="mb-4 grid gap-3 rounded-lg border border-line bg-subtle/40 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                {isTable && (
                  <label className="block">
                    <span className="label">Business name of the table</span>
                    <input
                      className="input"
                      value={table.business_name}
                      onChange={(e) => setTable({ ...table, business_name: e.target.value })}
                      placeholder="Sales orders"
                    />
                  </label>
                )}
                <label className={clsx("block", !isTable && "sm:col-span-2")}>
                  <span className="label">What it holds</span>
                  <input
                    className="input"
                    value={table.definition}
                    onChange={(e) => setTable({ ...table, definition: e.target.value })}
                    placeholder="One row per … : …"
                  />
                </label>
              </div>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-3">
                <Coverage done={done} total={columns.length} />
                <span className="text-xs text-muted">
                  {done} of {columns.length} described
                </span>
              </div>
              {columns.length > 10 && (
                <>
                  <div className="relative w-full sm:w-56">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
                    <input className="input h-8 pl-8 text-[13px]" placeholder="Find a column…" value={q} onChange={(e) => setQ(e.target.value)} />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
                    Only those not described yet
                  </label>
                </>
              )}
              {mayEdit && !editing && (
                <div className="flex gap-2 sm:ml-auto">
                  <Button size="xs" variant="soft" icon={Sparkles} loading={suggesting} onClick={() => void suggest()}>
                    Suggest definitions
                  </Button>
                  <Button size="xs" icon={Pencil} onClick={() => start()}>
                    Describe
                  </Button>
                </div>
              )}
            </div>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[560px] table-fixed text-left text-[13px]">
                <thead className="border-y border-line bg-subtle/50 text-[11px] tracking-wide text-faint uppercase">
                  <tr>
                    <th className="w-[28%] px-5 py-2 font-medium">Column</th>
                    <th className="w-[24%] px-3 py-2 font-medium">Business name</th>
                    <th className="px-3 py-2 font-medium">What it means</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {shown.map((column) => {
                    const key = column.name.toLowerCase();
                    const draft = drafts[key];
                    const fresh = suggested.has(key);
                    return (
                      <tr key={column.name} className={clsx("align-top", fresh && editing && "bg-fuchsia-50/60 dark:bg-fuchsia-400/5")}>
                        <td className="px-5 py-2">
                          <div className="flex items-center gap-1.5">
                            <code className="font-mono text-[13px] font-medium break-all text-fg">{column.name}</code>
                            {fresh && editing && <Sparkles className="size-3.5 shrink-0 text-fuchsia-500" aria-label="Suggested" />}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            {column.type && <span className="font-mono text-[11px] text-faint">{column.type}</span>}
                            <Keys keys={column.key} thing={thing} model={model} />
                          </div>
                          {column.comment && column.comment !== column.definition && (
                            <p className="mt-0.5 text-[11px] text-faint" title="The database's own comment">
                              “{column.comment}”
                            </p>
                          )}
                        </td>
                        {editing && draft ? (
                          <>
                            <td className="px-3 py-2">
                              <input
                                className="input h-8 text-[13px]"
                                value={draft.business_name}
                                aria-label={`Business name of ${column.name}`}
                                onChange={(e) => setDrafts({ ...drafts, [key]: { ...draft, business_name: e.target.value } })}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <textarea
                                className="input min-h-8 py-1.5 text-[13px]"
                                rows={Math.min(4, Math.max(1, Math.ceil(draft.definition.length / 60)))}
                                value={draft.definition}
                                aria-label={`What ${column.name} means`}
                                onChange={(e) => setDrafts({ ...drafts, [key]: { ...draft, definition: e.target.value } })}
                              />
                              <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                                <input
                                  type="checkbox"
                                  checked={draft.personal}
                                  onChange={(e) => setDrafts({ ...drafts, [key]: { ...draft, personal: e.target.checked } })}
                                />
                                Personal data
                              </label>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2 font-medium text-fg">{column.business_name || <span className="font-normal text-faint">—</span>}</td>
                            <td className="px-3 py-2 text-muted">
                              {column.definition ||
                                (!column.business_name && <span className="text-xs text-amber-700 dark:text-amber-300">Not described yet</span>)}
                              {(column.personal || column.example) && (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  {column.personal && (
                                    <Badge tone="red" size="xs">
                                      <ShieldAlert className="mr-0.5 size-2.5" /> Personal data
                                    </Badge>
                                  )}
                                  {column.example && <span className="text-[11px] text-faint">e.g. {column.example}</span>}
                                </div>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-5 py-4 text-sm text-muted">
                        {onlyMissing && !q ? "Every column is described." : "No column matches."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {editing && (
              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                {offerDocumented && (
                  <label className="mr-auto flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={markDocumented} onChange={(e) => setMarkDocumented(e.target.checked)} />
                    Every column is described: mark the definitions as documented
                  </label>
                )}
                <Button variant="ghost" size="sm" onClick={cancel}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
                  Save definitions
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** The address a picture is served at (so it can never run as a page of the app). */
function picturePath(path: (p: string) => string, id: string, field: string, index: number): string {
  return path(`/brain/entities/${encodeURIComponent(id)}/pictures/${encodeURIComponent(field)}/${index}`);
}

/** A picture to show: its own address (data: or https), or the uploaded file fetched with the session. */
function usePictureSrc(id: string, field: string, index: number, picture: BrainImage | undefined): string | undefined {
  const { company, path } = useCompany();
  const fetchIt = Boolean(id) && (picture ? !picture.src : true);
  const blob = useQuery({
    queryKey: [...brainKeys.all(company), "picture", id, field, index, picture?.file ?? ""],
    queryFn: () => api.blob(picturePath(path, id, field, index)),
    enabled: fetchIt,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob.data) return;
    const made = URL.createObjectURL(blob.data);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob.data]);
  return picture?.src ?? url;
}

function Picture({ id, field, index, picture, className }: { id: string; field: string; index: number; picture?: BrainImage; className?: string }) {
  const src = usePictureSrc(id, field, index, picture);
  if (!src) return <div className={clsx("flex items-center justify-center bg-subtle", className)} />;
  return <img src={src} alt={picture?.caption || "Screenshot"} className={className} loading="lazy" />;
}

/** A report's screenshots: a gallery that opens each one large. Managers and admins add and remove them. */
export function ScreenshotsCard({ thing, field, mayEdit }: { thing: BrainEntity; field: BrainField; mayEdit: boolean }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const pictures = Array.isArray(thing.data[field.key]) ? (thing.data[field.key] as BrainImage[]) : [];
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const keep = async (next: BrainImage[]) => {
    await api.patch(path(`/brain/entities/${thing.id}`), { data: { [field.key]: next } });
    await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
  };
  const add = async (files: FileList | null) => {
    const chosen = [...(files ?? [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!chosen.length) {
      if (files?.length) toast.error("Choose a PNG, JPEG, GIF or WebP picture");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of chosen) form.append("file", file, file.name);
      const stored = await api.upload<{ id: string; name: string }[]>(path("/files"), form);
      await keep([...pictures, ...stored.map((s) => ({ file: s.id, caption: s.name.replace(/\.[a-z0-9]+$/i, "") }))]);
      toast.success(stored.length === 1 ? "Screenshot added" : `${stored.length} screenshots added`);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async (index: number) => {
    try {
      await keep(pictures.filter((_, i) => i !== index));
      setOpen(null);
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <Card>
      <CardHeader
        title={field.label}
        subtitle={pictures.length ? `${pictures.length} page${pictures.length === 1 ? "" : "s"}` : undefined}
        actions={
          mayEdit ? (
            <>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => void add(e.target.files)}
              />
              <Button size="xs" variant="soft" icon={ImagePlus} loading={busy} onClick={() => input.current?.click()}>
                Add screenshot
              </Button>
            </>
          ) : undefined
        }
      />
      <CardBody>
        {pictures.length === 0 ? (
          <p className="text-sm text-muted">
            No screenshots yet.{mayEdit ? " Add a picture of each page, so people and AI employees know it when they see it." : ""}
          </p>
        ) : (
          <div className={clsx("grid gap-3", pictures.length > 1 && "sm:grid-cols-2")}>
            {pictures.map((picture, index) => (
              <button
                key={`${picture.file ?? index}-${picture.caption}`}
                type="button"
                onClick={() => setOpen(index)}
                className="group overflow-hidden rounded-lg border border-line bg-subtle text-left transition hover:border-brand-300 hover:shadow-sm"
              >
                <Picture id={thing.id} field={field.key} index={index} picture={picture} className="aspect-video w-full object-cover object-top" />
                {picture.caption && (
                  <p className="border-t border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted group-hover:text-fg">{picture.caption}</p>
                )}
              </button>
            ))}
          </div>
        )}
      </CardBody>
      {open !== null && pictures[open] && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          size="xl"
          title={pictures[open].caption || thing.name}
          description={`${thing.name} · ${open + 1} of ${pictures.length}`}
          footer={
            <>
              {mayEdit && (
                <Button variant="ghost" icon={Trash2} className="mr-auto text-red-600" onClick={() => void remove(open)}>
                  Remove
                </Button>
              )}
              <Button icon={ChevronLeft} disabled={open === 0} onClick={() => setOpen(open - 1)} aria-label="Previous" />
              <Button icon={ChevronRight} disabled={open === pictures.length - 1} onClick={() => setOpen(open + 1)} aria-label="Next" />
            </>
          }
        >
          <Picture id={thing.id} field={field.key} index={open} picture={pictures[open]} className="w-full rounded-lg border border-line" />
        </Dialog>
      )}
    </Card>
  );
}

const NODE_W = 200;
const NODE_H = 46;
const GAP_X = 48;
const GAP_Y = 10;

/**
 * Orders each column of a lineage by where its neighbours sit in the next column (a few sweeps
 * each way), so lines cross as little as they can.
 */
function untangle(columns: BrainLineage["nodes"][], edges: BrainLineage["edges"]): BrainLineage["nodes"][] {
  const next = columns.map((c) => [...c]);
  const neighbours = (id: string) => edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []));
  const place = (column: BrainLineage["nodes"]) => new Map(column.map((n, i) => [n.id, i]));
  const sortBy = (i: number, beside: number) => {
    const at = place(next[beside]!);
    const score = (id: string, fallback: number) => {
      const spots = neighbours(id).flatMap((n) => (at.has(n) ? [at.get(n)!] : []));
      return spots.length ? spots.reduce((a, b) => a + b, 0) / spots.length : fallback;
    };
    const current = place(next[i]!);
    next[i]!.sort((a, b) => score(a.id, current.get(a.id)!) - score(b.id, current.get(b.id)!));
  };
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let i = 1; i < next.length; i++) sortBy(i, i - 1);
    for (let i = next.length - 2; i >= 0; i--) sortBy(i, i + 1);
  }
  return next;
}

/** Where the data comes from (left) and what is built on it (right), around this thing. */
export function LineageCard({ thing }: { thing: BrainEntity }) {
  const { data: model } = useBrainModel();
  const { company, path } = useCompany();
  const lineage = useQuery({
    queryKey: [...brainKeys.all(company), "lineage", thing.id],
    queryFn: () => api.get<BrainLineage>(path(`/brain/entities/${thing.id}/lineage`)),
  });
  const layout = useMemo(() => {
    const data = lineage.data;
    if (!data || !data.edges.length) return null;
    const layers = [...new Set(data.nodes.map((n) => n.layer))].sort((a, b) => a - b);
    const columns = untangle(
      layers.map((layer) => data.nodes.filter((n) => n.layer === layer).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))),
      data.edges,
    );
    const tallest = Math.max(...columns.map((c) => c.length));
    const height = tallest * (NODE_H + GAP_Y) - GAP_Y;
    const at = new Map<string, { x: number; y: number }>();
    columns.forEach((column, i) => {
      const top = (height - (column.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
      column.forEach((node, j) => at.set(node.id, { x: i * (NODE_W + GAP_X), y: top + j * (NODE_H + GAP_Y) }));
    });
    return { columns, at, width: columns.length * (NODE_W + GAP_X) - GAP_X, height, layers };
  }, [lineage.data]);

  // Wider than the card: start with the thing itself in view, and say there is more.
  const scroller = useRef<HTMLDivElement>(null);
  const [wider, setWider] = useState(false);
  useEffect(() => {
    const box = scroller.current;
    const root = lineage.data && layout?.at.get(lineage.data.root);
    if (!box || !root) return;
    box.scrollLeft = Math.max(0, root.x + NODE_W / 2 - box.clientWidth / 2);
    setWider(box.scrollWidth > box.clientWidth + 4);
  }, [layout, lineage.data]);

  if (lineage.isLoading) return <Skeleton className="h-40" />;
  if (!layout || !lineage.data) return null;
  const { at, width, height } = layout;
  const upstream = lineage.data.nodes.some((n) => n.layer < 0);
  const downstream = lineage.data.nodes.some((n) => n.layer > 0);
  return (
    <Card>
      <CardHeader
        title="Where the data comes from"
        subtitle={
          upstream && downstream
            ? "What it is built on (left) and what is built on it (right)"
            : upstream
              ? "What it is built on, back to the database tables and the work that fills them"
              : "What is built on it, and the work that reads it"
        }
      />
      <CardBody>
        <div ref={scroller} className="-mx-5 overflow-x-auto px-5 pb-1">
          <div className="relative" style={{ width, height }}>
            <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
              {lineage.data.edges.map((edge) => {
                const from = at.get(edge.from);
                const to = at.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + NODE_W;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_H / 2;
                const bend = Math.max(24, (x2 - x1) / 2);
                return (
                  <path
                    key={`${edge.from}-${edge.to}`}
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                    className={clsx(
                      "fill-none",
                      edge.relation === "uses_data" ? "stroke-violet-300 dark:stroke-violet-500/60" : "stroke-slate-300 dark:stroke-slate-600",
                    )}
                    strokeWidth={1.5}
                    strokeDasharray={edge.relation === "uses_data" ? "4 3" : undefined}
                  >
                    {edge.detail && <title>{edge.detail}</title>}
                  </path>
                );
              })}
            </svg>
            {lineage.data.nodes.map((node) => {
              const spot = at.get(node.id)!;
              const root = node.id === lineage.data!.root;
              return (
                <Link
                  key={node.id}
                  to={brainPath(node.id)}
                  className={clsx(
                    "absolute flex items-center gap-2 rounded-lg border bg-surface px-2 shadow-xs transition hover:border-brand-300 hover:shadow-sm",
                    root ? "border-brand-400 ring-2 ring-brand-200 dark:ring-brand-400/30" : "border-line",
                  )}
                  style={{ left: spot.x, top: spot.y, width: NODE_W, height: NODE_H }}
                  title={`${node.name}${node.place ? ` · ${node.place}` : ""}`}
                >
                  <KindIcon kind={node.kind} model={model} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-fg">{node.name}</span>
                    {node.place && <span className="block truncate text-[11px] text-faint">{node.place}</span>}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-px w-5 bg-slate-400" /> built on
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-px w-5 border-t border-dashed border-violet-400" /> <Workflow className="size-3" /> work that writes or reads it
          </span>
          {wider && <span className="sm:ml-auto">Scroll sideways to see all of it</span>}
        </p>
      </CardBody>
    </Card>
  );
}

/** A database's tables, as the brain knows them: business name and how well they are described. */
export function DatabaseTablesCard({ thing, mayEdit, onRead }: { thing: BrainEntity; mayEdit: boolean; onRead: () => void }) {
  const { data: model } = useBrainModel();
  const [q, setQ] = useState("");
  const tables = thing.links
    .filter((l) => l.relation === "table_of" && l.direction === "in")
    .map((l) => l.other)
    .sort((a, b) => a.name.localeCompare(b.name));
  const brief = (t: BrainEntitySummary, label: string) => t.brief.find(([l]) => l === label)?.[1];
  const needle = q.trim().toLowerCase();
  const shown = needle ? tables.filter((t) => `${t.name} ${brief(t, "Business name") ?? ""} ${t.summary}`.toLowerCase().includes(needle)) : tables;
  return (
    <Card>
      <CardHeader
        title="Tables"
        subtitle={tables.length ? `${tables.length} tables and views` : "Read from the database: names, columns, keys and size; never a row of data"}
        icon={DatabaseZap}
        actions={
          mayEdit ? (
            <Button size="xs" variant="soft" icon={DatabaseZap} onClick={onRead}>
              Read tables
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {tables.length === 0 ? (
          <p className="text-sm text-muted">
            No tables yet.{" "}
            {mayEdit
              ? "Use Read tables: the brain reads the database's catalog through its connection, and each table gets its own page."
              : "A manager or IT can read them from the database."}
          </p>
        ) : (
          <>
            {tables.length > 12 && (
              <div className="relative mb-3 w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
                <input className="input h-8 pl-8 text-[13px]" placeholder="Find a table…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            )}
            <ul className="-mx-5 divide-y divide-line/70 border-y border-line/70">
              {shown.map((table) => {
                const status = brief(table, "Definitions");
                const business = brief(table, "Business name");
                return (
                  <li key={table.id}>
                    <Link to={brainPath(table.id)} className="flex items-center gap-3 px-5 py-2 hover:bg-subtle/50">
                      <KindIcon kind={table.kind} model={model} size="sm" />
                      <code className="w-40 shrink-0 truncate font-mono text-[13px] font-medium text-fg sm:w-48">{table.name}</code>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                        {business || table.summary || <span className="text-faint">—</span>}
                      </span>
                      {status ? (
                        <Badge tone={toneOf(status)} size="xs">
                          {status}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="xs">
                          Only in the database
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Reads a database's tables into the brain, through one of the company's SQL connections (or the demo database). */
export function ReadTablesDialog({ thing, open, onClose }: { thing: BrainEntity; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const options = useQuery({
    queryKey: [...brainKeys.all(company), "read-tables", thing.id],
    queryFn: () => api.get<BrainReadOptions>(path(`/brain/entities/${thing.id}/read-tables`)),
    enabled: open,
  });
  const [through, setThrough] = useState<string | null>(null);
  const [schema, setSchema] = useState("");
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<BrainReadTablesResult | null>(null);
  // Once read through a connection, a database is read through one (its demo stands in only until then).
  const demo = Boolean(options.data?.demo && !options.data.connectionId);
  const choice = through ?? options.data?.connectionId ?? (demo ? "" : (options.data?.connections[0]?.id ?? ""));
  const nothing = options.data && !demo && options.data.connections.length === 0;

  const read = async () => {
    setReading(true);
    try {
      const outcome = await api.post<BrainReadTablesResult>(path(`/brain/entities/${thing.id}/read-tables`), {
        connectionId: choice || undefined,
        schema: schema.trim() || undefined,
      });
      setResult(outcome);
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
    } catch (error) {
      toast.error(error);
    } finally {
      setReading(false);
    }
  };
  const close = () => {
    setResult(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Read the tables of ${thing.name}`}
      description="Reads only the database's catalog: tables and views, their columns, types, keys, comments and about how many rows. Never a row of data. What people wrote about the tables stays."
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={DatabaseZap} loading={reading} disabled={Boolean(nothing) || options.isLoading} onClick={() => void read()}>
              Read tables
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="text-fg">
            Read <strong>{result.tables}</strong> tables and views from {result.from}.
          </p>
          <ul className="grid gap-2 sm:grid-cols-3">
            {[
              ["New", result.added],
              ["Changed", result.changed],
              ["No longer there", result.gone.length],
            ].map(([label, n]) => (
              <li key={label} className="rounded-lg border border-line px-3 py-2">
                <p className="text-xl font-semibold text-fg tabular-nums">{n}</p>
                <p className="text-xs text-muted">{label}</p>
              </li>
            ))}
          </ul>
          {result.gone.length > 0 && <p className="text-xs text-muted">No longer in the database (kept, with what people wrote): {result.gone.join(", ")}.</p>}
          {result.truncated && (
            <p className="text-xs text-amber-700 dark:text-amber-300">The database has more tables than are read at once: name a schema to read the rest.</p>
          )}
          {result.notes.map((note) => (
            <p key={note} className="text-xs text-muted">
              {note}
            </p>
          ))}
        </div>
      ) : options.isLoading ? (
        <Skeleton className="h-24" />
      ) : nothing ? (
        <div className="space-y-3 text-sm text-muted">
          <p>
            There is no SQL database connection yet. IT adds one in Studio → Settings → Connections (a read-only login is enough), then you can read the tables
            here.
          </p>
          <ButtonLink to={paths.settings("connections")} size="sm">
            Open connections
          </ButtonLink>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="label">Read through</span>
            <select className="input" value={choice} onChange={(e) => setThrough(e.target.value)}>
              {demo && <option value="">The demo database (made-up catalog)</option>}
              {options.data?.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.detail ? ` · ${c.detail}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Only this schema (optional)</span>
            <input className="input" value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="dbo, public, SAPHANADB…" />
            <span className="mt-1 block text-xs text-faint">Leave empty to read every schema the login can see.</span>
          </label>
        </div>
      )}
    </Dialog>
  );
}

/** Reports as cards with their first screenshot. */
export function ReportCards({ reports, model }: { reports: BrainEntitySummary[]; model: BrainModel | undefined }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {reports.map((report) => {
        const tool = report.brief.find(([label]) => label === "Tool")?.[1];
        const status = report.brief.find(([label]) => label === "Status")?.[1];
        const owners = report.keyLinks?.Owner ?? [];
        return (
          <Card key={report.id} className="flex flex-col overflow-hidden">
            <Link to={brainPath(report.id)} className="block border-b border-line bg-subtle">
              <ReportThumb id={report.id} />
            </Link>
            <div className="flex flex-1 flex-col gap-2 p-4">
              <div className="flex items-start gap-2">
                <Link to={brainPath(report.id)} className="min-w-0 flex-1 text-sm font-semibold text-fg hover:underline">
                  {report.name}
                </Link>
                {status && (
                  <Badge tone={toneOf(status)} size="xs">
                    {status}
                  </Badge>
                )}
              </div>
              {report.summary && <p className="line-clamp-2 text-xs text-muted">{report.summary}</p>}
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                {tool && (
                  <Badge tone="neutral" size="xs">
                    {tool}
                  </Badge>
                )}
                {owners.slice(0, 2).map((owner) => (
                  <ThingChip key={owner.id} thing={owner} model={model} className="!text-[11px]" />
                ))}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ReportThumb({ id }: { id: string }) {
  const src = usePictureSrc(id, "screenshots", 0, undefined);
  return src ? (
    <img src={src} alt="" className="aspect-video w-full object-cover object-top" loading="lazy" />
  ) : (
    <div className="flex aspect-video w-full items-center justify-center text-faint">
      <ChartColumn className="size-8" />
    </div>
  );
}
