import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Bot, Check, Plus, Search, Send } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { keys, useRecords, useSummary } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AppBlock, BlockFilter, Measure, RecordAction, RecordView, TableField, TableView, TaskRow } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { Button } from "../Button.tsx";
import { Card, CardHeader } from "../Card.tsx";
import { Markdown } from "../Markdown.tsx";
import { ErrorState, Skeleton } from "../Spinner.tsx";
import { formatValue } from "../tables/fields.ts";
import { RecordDrawer } from "../tables/RecordDrawer.tsx";
import { newDraft, RecordForm, valuesOf, type RecordDraft } from "../tables/RecordForm.tsx";

/** What a block needs besides itself: its table (when the viewer sees it) and the AI employees' names. */
export interface BlockContext {
  tables: Map<string, TableView>;
  agents: Map<string, string>;
}

/** Filter values as the records query takes them. */
function filters(filter: BlockFilter | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(filter ?? {}).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "yes" : "no") : String(v)]));
}

/** "Draft a reply to {customer} about {problem}" with the record's values. */
function fillAsk(ask: string, table: TableView, record: RecordView): string {
  const text = ask.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, key: string) => {
    const field = table.fields.find((f) => f.key === key);
    return field ? formatValue(field, record.values[key], record.display[key]) : `{${key}}`;
  });
  return `${text}\n\n${table.name} #${record.number}: ${record.title}`;
}

export function BlockView({ block, context }: { block: AppBlock; context: BlockContext }) {
  if (block.type === "text") return <TextBlock title={block.title} text={block.text} />;
  if (block.type === "button") return <ButtonBlock block={block} agentName={context.agents.get(block.agent)} />;
  const table = context.tables.get(block.table);
  if (!table) {
    return (
      <Card className="p-4 text-sm text-muted">
        {block.title ? <p className="font-medium text-fg">{block.title}</p> : null}
        <p>This part shows a table you can't see.</p>
      </Card>
    );
  }
  switch (block.type) {
    case "list":
      return <ListBlock block={block} table={table} context={context} />;
    case "form":
      return <FormBlock block={block} table={table} />;
    case "board":
      return <BoardBlock block={block} table={table} context={context} />;
    case "chart":
      return <ChartBlock block={block} table={table} />;
    case "number":
      return <NumberBlock block={block} table={table} />;
  }
}

// ---------------------------------------------------------------------------
// Actions on a record
// ---------------------------------------------------------------------------

function useRecordActions(table: TableView) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, record }: { action: RecordAction; record: RecordView }) => {
      if (action.set) {
        await api.patch(path(`/tables/${encodeURIComponent(table.key)}/records/${record.number}`), { values: action.set });
        return { kind: "set" as const, record, action };
      }
      const given = await api.post<{ task: TaskRow }>(path("/tasks"), { agent: action.agent, text: fillAsk(action.ask ?? action.label, table, record) });
      return { kind: "agent" as const, record, action, task: given.task };
    },
    onSuccess: async (done) => {
      if (done.kind === "set") {
        toast.success(`Done: ${done.action.label} #${done.record.number}`);
        await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
      } else {
        toast.success(`#${done.record.number} given as work`, { link: { label: "See the task", to: `/work/${done.task.ref}` } });
      }
    },
    onError: (e) => toast.error(e),
  });
}

/** The buttons of a record: each asks "Sure?" first when it says so. */
function ActionButtons({ actions, table, record }: { actions: RecordAction[]; table: TableView; record: RecordView }) {
  const run = useRecordActions(table);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (!asking) return;
    const timer = window.setTimeout(() => setAsking(null), 4000);
    return () => window.clearTimeout(timer);
  }, [asking]);
  const shown = actions.filter((a) => (a.set ? table.can.edit && !Object.entries(a.set).every(([k, v]) => record.values[k] === v) : true));
  if (!shown.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
      {shown.map((action) => {
        const sure = asking === action.label;
        return (
          <Button
            key={action.label}
            size="xs"
            variant={sure ? "primary" : action.agent ? "soft" : "secondary"}
            icon={action.agent ? Bot : sure ? Check : undefined}
            loading={run.isPending && run.variables?.action.label === action.label && run.variables.record.id === record.id}
            onClick={() => {
              if (action.confirm && !sure) return setAsking(action.label);
              setAsking(null);
              run.mutate({ action, record });
            }}
          >
            {sure ? `${action.label}: sure?` : action.label}
          </Button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function ListBlock({ block, table }: { block: Extract<AppBlock, { type: "list" }>; table: TableView; context: BlockContext }) {
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const records = useRecords(table.key, {
    search,
    sort: block.sort?.field ?? "number",
    direction: block.sort?.direction ?? (block.sort ? "asc" : "desc"),
    limit: block.limit ?? 100,
    filters: filters(block.filter),
  });
  const fields = useMemo(() => {
    const chosen = (block.fields ?? []).map((k) => table.fields.find((f) => f.key === k)).filter((f): f is TableField => Boolean(f));
    return (chosen.length ? chosen : table.fields.filter((f) => f.type !== "long_text" && f.type !== "file").slice(0, 5)).filter(
      (f) => f.key !== block.groupBy,
    );
  }, [block.fields, block.groupBy, table.fields]);
  const group = block.groupBy ? table.fields.find((f) => f.key === block.groupBy) : undefined;
  const groups = useMemo(() => {
    const list = records.data?.records ?? [];
    if (!group) return [{ label: "", records: list }];
    const map = new Map<string, RecordView[]>();
    for (const record of list) {
      const label = record.values[group.key] === undefined ? "Not given" : formatValue(group, record.values[group.key], record.display[group.key]);
      map.set(label, [...(map.get(label) ?? []), record]);
    }
    const order = (label: string) => (group.choices ?? []).indexOf(label);
    return [...map.entries()]
      .sort(([a, x], [b, y]) => (group.type === "choice" ? order(a) - order(b) : y.length - x.length || a.localeCompare(b)))
      .map(([label, list]) => ({ label, records: list }));
  }, [records.data, group]);
  const title = block.title ?? table.name;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={title}
        subtitle={records.data ? `${records.data.total} ${records.data.total === 1 ? "record" : "records"}` : undefined}
        actions={
          <Link to={`/tables/${table.key}`} className="text-xs text-muted hover:text-fg">
            The table
          </Link>
        }
      />
      {block.search && (
        <div className="border-b border-line px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              className="input pl-9"
              placeholder="Find (words, or #12)"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Find in ${title}`}
            />
          </div>
        </div>
      )}
      {records.error && <ErrorState error={records.error} className="m-4" />}
      {records.isLoading && <Skeleton className="m-4 h-24" />}
      {records.data && records.data.records.length === 0 && (
        <p className="px-5 py-6 text-center text-sm text-muted">Nothing here{search ? " matches" : " now"}.</p>
      )}
      {groups.map((g) => (
        <section key={g.label}>
          {group && (
            <h4 className="flex items-center justify-between border-b border-line bg-subtle/60 px-4 py-1.5 text-xs font-semibold text-muted">
              <span>{g.label}</span>
              <span className="tabular-nums">{g.records.length}</span>
            </h4>
          )}
          <ul className="divide-y divide-line/70">
            {g.records.map((record) => (
              <li key={record.id} className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-subtle/50" onClick={() => setOpen(record.number)}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    <span className="mr-1.5 text-muted tabular-nums">#{record.number}</span>
                    {record.title}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {fields
                      .filter((f) => f.key !== table.titleField && record.values[f.key] !== undefined)
                      .map((f) =>
                        f.type === "choice" ? (
                          <Badge key={f.key} size="xs">
                            {String(record.values[f.key])}
                          </Badge>
                        ) : (
                          <span key={f.key} className="truncate" title={f.label}>
                            {formatValue(f, record.values[f.key], record.display[f.key])}
                          </span>
                        ),
                      )}
                  </p>
                </div>
                {block.actions?.length ? <ActionButtons actions={block.actions} table={table} record={record} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {records.data && records.data.records.length < records.data.total && (
        <p className="border-t border-line px-4 py-2 text-center text-xs text-muted">
          Showing {records.data.records.length} of {records.data.total}.{" "}
          <Link to={`/tables/${table.key}`} className="text-brand-600 hover:underline dark:text-brand-300">
            All of them in the table
          </Link>
        </p>
      )}
      <RecordDrawer table={table} recordNumber={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function FormBlock({ block, table }: { block: Extract<AppBlock, { type: "form" }>; table: TableView }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  // The fields asked, and the required ones in any case (a record can't be added without them).
  const asked = useMemo(() => {
    const chosen = new Set(block.fields ?? table.fields.map((f) => f.key));
    return { ...table, fields: table.fields.filter((f) => (chosen.has(f.key) || (f.required && f.default === undefined)) && !(f.key in (block.values ?? {}))) };
  }, [block.fields, block.values, table]);
  const [draft, setDraft] = useState<RecordDraft>(() => newDraft(asked));
  const [added, setAdded] = useState<RecordView | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.post<RecordView>(path(`/tables/${encodeURIComponent(table.key)}/records`), { values: { ...valuesOf(asked, draft), ...(block.values ?? {}) } }),
    onSuccess: async (record) => {
      setAdded(record);
      setDraft(newDraft(asked));
      toast.success(`#${record.number} added to ${table.name}`);
      await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
    },
  });
  if (!table.can.edit) {
    return (
      <Card className="p-4 text-sm text-muted">
        <p className="font-medium text-fg">{block.title ?? `Add to ${table.name}`}</p>
        <p className="mt-1">
          Only {table.settings.editors === "managers" ? "its managers add" : "its department's people add"} to {table.name}.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={block.title ?? `Add to ${table.name}`} />
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        {add.error && <ErrorState error={add.error} title="It can't be added yet" />}
        {added && !add.isPending && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
            #{added.number} {added.title} was added.
          </p>
        )}
        <RecordForm table={asked} draft={draft} onChange={setDraft} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon={Plus} loading={add.isPending}>
            {block.submitLabel ?? "Add"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function BoardBlock({ block, table }: { block: Extract<AppBlock, { type: "board" }>; table: TableView; context: BlockContext }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const group = table.fields.find((f) => f.key === block.groupBy);
  const records = useRecords(table.key, { sort: "updated_at", direction: "desc", limit: 300, filters: filters(block.filter) });
  const move = useMutation({
    mutationFn: ({ record, to }: { record: RecordView; to: string }) =>
      api.patch(path(`/tables/${encodeURIComponent(table.key)}/records/${record.number}`), { values: { [block.groupBy]: to } }),
    onSuccess: async (_, { record, to }) => {
      toast.success(`#${record.number} moved to ${to}`);
      await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
    },
    onError: (e) => toast.error(e),
  });
  if (!group?.choices?.length) return <Card className="p-4 text-sm text-muted">This board's columns are no longer a list to choose from.</Card>;
  const shown = (block.fields ?? [])
    .map((k) => table.fields.find((f) => f.key === k))
    .filter((f): f is TableField => Boolean(f) && f!.key !== table.titleField);
  const columns = group.choices;
  const drop = (e: DragEvent, to: string) => {
    e.preventDefault();
    setOver(null);
    const number = Number(e.dataTransfer.getData("text/plain"));
    const record = records.data?.records.find((r) => r.number === number);
    if (record && record.values[group.key] !== to) move.mutate({ record, to });
  };
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={block.title ?? `${table.name} by ${group.label.toLowerCase()}`}
        subtitle={table.can.edit ? "Drag a card to another column to change it" : undefined}
      />
      {records.error && <ErrorState error={records.error} className="m-4" />}
      <div className="flex gap-3 overflow-x-auto p-3">
        {columns.map((column) => {
          const cards = (records.data?.records ?? []).filter((r) => r.values[group.key] === column);
          return (
            <div
              key={column}
              onDragOver={(e) => {
                if (!table.can.edit) return;
                e.preventDefault();
                setOver(column);
              }}
              onDragLeave={() => setOver((o) => (o === column ? null : o))}
              onDrop={(e) => drop(e, column)}
              className={clsx(
                "flex w-64 shrink-0 flex-col rounded-xl bg-subtle/70 p-2 transition-colors",
                over === column && "bg-brand-50 ring-2 ring-brand-300 dark:bg-brand-400/10",
              )}
            >
              <p className="flex items-center justify-between px-1.5 pb-2 text-xs font-semibold text-muted">
                <span>{column}</span>
                <span className="tabular-nums">{cards.length}</span>
              </p>
              <div className="space-y-2">
                {cards.map((record) => (
                  <div
                    key={record.id}
                    draggable={table.can.edit}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", String(record.number))}
                    onClick={() => setOpen(record.number)}
                    className="cursor-pointer rounded-lg border border-line bg-surface p-2.5 text-sm shadow-xs hover:border-brand-300"
                  >
                    <p className="font-medium text-fg">
                      <span className="mr-1 text-xs text-muted tabular-nums">#{record.number}</span>
                      {record.title}
                    </p>
                    {shown.map((f) =>
                      record.values[f.key] === undefined ? null : (
                        <p key={f.key} className="mt-0.5 truncate text-xs text-muted">
                          {formatValue(f, record.values[f.key], record.display[f.key])}
                        </p>
                      ),
                    )}
                    {table.can.edit && (
                      <select
                        className="mt-2 w-full rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-muted sm:hidden"
                        value={String(record.values[group.key] ?? "")}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => move.mutate({ record, to: e.target.value })}
                        aria-label={`Move #${record.number}`}
                      >
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    )}
                    {block.actions?.length ? (
                      <div className="mt-2">
                        <ActionButtons actions={block.actions} table={table} record={record} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <RecordDrawer table={table} recordNumber={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Chart and number
// ---------------------------------------------------------------------------

const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#8b5cf6", "#14b8a6", "#f97316", "#64748b", "#ec4899"];

/** A figure as people read it: money with its currency, averages with a decimal. */
function figure(table: TableView, measure: Measure, value: number): string {
  const field = measure.field ? table.fields.find((f) => f.key === measure.field) : undefined;
  if (measure.of !== "count" && field?.type === "money") return formatValue(field, value);
  return value.toLocaleString(undefined, { maximumFractionDigits: measure.of === "average" ? 1 : 0 });
}

/** "2026-09" → "Sep 2026". */
function groupLabel(field: TableField | undefined, label: string, key: string | null): string {
  if (field?.type !== "date" || !key || !/^\d{4}-\d{2}$/.test(key)) return label;
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function ChartBlock({ block, table }: { block: Extract<AppBlock, { type: "chart" }>; table: TableView }) {
  const group = table.fields.find((f) => f.key === block.groupBy);
  const summary = useSummary(table.key, {
    groupBy: block.groupBy,
    of: block.measure.of,
    field: block.measure.field,
    limit: block.limit,
    filters: filters(block.filter),
  });
  const title = block.title ?? `${table.name} by ${group?.label.toLowerCase() ?? block.groupBy}`;
  const groups = summary.data?.groups ?? [];
  const max = Math.max(1, ...groups.map((g) => g.value));
  const sum = groups.reduce((s, g) => s + g.value, 0) || 1;
  let body: ReactNode;
  if (summary.isLoading) body = <Skeleton className="h-32" />;
  else if (summary.error) body = <ErrorState error={summary.error} />;
  else if (!groups.length) body = <p className="py-6 text-center text-sm text-muted">Nothing to show yet.</p>;
  else if (block.kind === "pie") {
    let at = 0;
    const stops = groups.map((g, i) => {
      const from = at;
      at += (g.value / sum) * 360;
      return `${PALETTE[i % PALETTE.length]} ${from}deg ${at}deg`;
    });
    body = (
      <div className="flex flex-wrap items-center gap-5">
        <div className="relative size-32 shrink-0 rounded-full" style={{ background: `conic-gradient(${stops.join(", ")})` }} aria-hidden="true">
          <div className="absolute inset-6 rounded-full bg-surface" />
        </div>
        <ul className="min-w-0 flex-1 space-y-1 text-sm">
          {groups.map((g, i) => (
            <li key={g.key ?? "none"} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="min-w-0 flex-1 truncate text-fg">{groupLabel(group, g.label, g.key)}</span>
              <span className="text-muted tabular-nums">{figure(table, block.measure, g.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    body = (
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.key ?? "none"} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-fg">{groupLabel(group, g.label, g.key)}</span>
              <span className="shrink-0 text-muted tabular-nums">{figure(table, block.measure, g.value)}</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-subtle">
              <div className="h-2 rounded-full bg-brand-500" style={{ width: `${Math.max(2, (g.value / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Card>
      <CardHeader title={title} />
      <div className="px-5 py-4">{body}</div>
    </Card>
  );
}

function NumberBlock({ block, table }: { block: Extract<AppBlock, { type: "number" }>; table: TableView }) {
  const summary = useSummary(table.key, { of: block.measure.of, field: block.measure.field, filters: filters(block.filter) });
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{block.title}</p>
      {summary.isLoading ? (
        <Skeleton className="mt-2 h-8 w-20" />
      ) : summary.error ? (
        <p className="mt-2 text-sm text-red-600">—</p>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-fg tabular-nums">{figure(table, block.measure, summary.data?.total ?? 0)}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Button and text
// ---------------------------------------------------------------------------

function ButtonBlock({ block, agentName }: { block: Extract<AppBlock, { type: "button" }>; agentName?: string }) {
  const { path } = useCompany();
  const toast = useToast();
  const give = useMutation({
    mutationFn: () => api.post<{ task: TaskRow }>(path("/tasks"), { agent: block.agent, text: block.ask }),
    onSuccess: ({ task }) => toast.success(`Given to ${agentName ?? "the AI employee"}`, { link: { label: "See the task", to: `/work/${task.ref}` } }),
    onError: (e) => toast.error(e),
  });
  return (
    <Card className="flex h-full flex-col justify-between gap-3 p-4">
      <div>
        <p className="font-medium text-fg">{block.title}</p>
        <p className="mt-1 text-sm text-muted">{block.description ?? block.ask}</p>
      </div>
      <Button variant="soft" icon={Send} loading={give.isPending} disabled={!agentName} onClick={() => give.mutate()} className="self-start">
        {agentName ? `Ask ${agentName}` : "Its AI employee isn't available"}
      </Button>
    </Card>
  );
}

function TextBlock({ title, text }: { title?: string; text: string }) {
  return (
    <Card className="p-5">
      {title && <p className="mb-2 font-medium text-fg">{title}</p>}
      <Markdown className="text-sm">{text}</Markdown>
    </Card>
  );
}

/** How wide a block is on a wide screen (of 12 columns). */
export function blockSpan(block: AppBlock): string {
  switch (block.type) {
    case "number":
      return "sm:col-span-6 lg:col-span-3";
    case "chart":
    case "button":
      return "lg:col-span-6";
    default:
      return "lg:col-span-12";
  }
}
