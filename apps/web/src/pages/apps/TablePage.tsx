import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Bot, Download, FileUp, Plus, Save, Search, Settings2, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api, downloadWithAuth } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { ChangeBox } from "../../components/ChangeBox.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Drawer } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { ImportDialog } from "../../components/tables/ImportDialog.tsx";
import { NewRecordDialog, RecordDrawer } from "../../components/tables/RecordDrawer.tsx";
import { designOf, draftOfDesign, TableDesigner, type DesignDraft } from "../../components/tables/TableDesigner.tsx";
import { formatValue } from "../../components/tables/fields.ts";
import { useCompany } from "../../lib/company.tsx";
import { plural, timeAgo } from "../../lib/format.ts";
import { keys, useDepartments, useRecords, useTable } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { TableChangeProposal, TableField, TableSettings, TableView } from "../../types.ts";

const PAGE = 50;
/** Fields shown as columns (the rest are in the record). */
const COLUMNS = 7;
const FILTERABLE: TableField["type"][] = ["choice", "yes_no", "person"];

/** A table: its records found by words, filtered, sorted; each opens with its history. */
export default function TablePage() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const { company, path } = useCompany();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const table = useTable(key);
  const departments = useDepartments();
  const [typed, setTyped] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(typed);
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>({ key: "number", direction: "desc" });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [archived, setArchived] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [designing, setDesigning] = useState(false);
  const open = params.get("record");
  // A change said in the one box: the table's design opens with it worked out.
  const asked = params.get("change");
  useEffect(() => {
    if (asked && table.data?.can.design) setDesigning(true);
  }, [asked, table.data?.can.design]);
  const stopDesigning = () => {
    setDesigning(false);
    if (asked) {
      const next = new URLSearchParams(params);
      next.delete("change");
      setParams(next, { replace: true });
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [typed]);
  useEffect(() => setLimit(PAGE), [search, sort, filters, archived]);
  const records = useRecords(key, { search, sort: sort.key, direction: sort.direction, limit, archived, filters });

  const view = table.data;
  const columns = useMemo(() => (view?.fields ?? []).filter((f) => f.type !== "long_text" && f.type !== "file").slice(0, COLUMNS), [view]);
  const openRecord = (number: number | null) => {
    const next = new URLSearchParams(params);
    if (number === null) next.delete("record");
    else next.set("record", String(number));
    setParams(next, { replace: true });
  };
  const toggleSort = (field: string) =>
    setSort((s) =>
      s.key === field ? { key: field, direction: s.direction === "asc" ? "desc" : "asc" } : { key: field, direction: field === "number" ? "desc" : "asc" },
    );

  if (table.isLoading) return <LoadingBlock className="min-h-[50vh]" />;
  if (table.error || !view) {
    return (
      <Page>
        <ErrorState error={table.error ?? new Error("There is no such table")} />
      </Page>
    );
  }
  const department = view.departmentId ? departments.data?.find((d) => d.id === view.departmentId)?.name : "The whole company";
  const filterable = view.fields.filter((f) => FILTERABLE.includes(f.type));

  return (
    <Page wide>
      <PageHeader
        icon={Table2}
        eyebrow={
          <button type="button" className="hover:text-fg" onClick={() => navigate("/apps")}>
            Apps · {department ?? "A department"}
          </button>
        }
        title={view.name}
        description={view.description || undefined}
        actions={
          <>
            {view.can.design && (
              <Button icon={Settings2} onClick={() => setDesigning(true)}>
                Change the table
              </Button>
            )}
            <Button
              icon={Download}
              onClick={() =>
                void downloadWithAuth(path(`/tables/${encodeURIComponent(view.key)}/export`), `${view.name}.xlsx`).catch((e: unknown) => toast.error(e))
              }
            >
              Excel
            </Button>
            {view.can.edit && (
              <Button icon={FileUp} onClick={() => setImporting(true)}>
                Bring in a sheet
              </Button>
            )}
            {view.can.edit && (
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={Boolean(view.archivedAt)}>
                Add
              </Button>
            )}
          </>
        }
      />
      {view.archivedAt && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
          This table is archived: its records are kept, and nothing can be added. {view.can.design && "Bring it back from Change the table."}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            className="input pl-9"
            placeholder={`Find in ${view.name} (words, or #12)`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Find"
          />
        </div>
        {filterable.slice(0, 3).map((field) => (
          <select
            key={field.key}
            className="input w-auto"
            aria-label={field.label}
            value={filters[field.key] ?? ""}
            onChange={(e) =>
              setFilters((f) =>
                e.target.value ? { ...f, [field.key]: e.target.value } : Object.fromEntries(Object.entries(f).filter(([k]) => k !== field.key)),
              )
            }
          >
            <option value="">{field.label}: any</option>
            {field.type === "yes_no" && (
              <>
                <option value="yes">{field.label}: yes</option>
                <option value="no">{field.label}: no</option>
              </>
            )}
            {field.type === "choice" &&
              (field.choices ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            {field.type === "person" &&
              [
                ...new Map(
                  (records.data?.records ?? [])
                    .filter((r) => typeof r.values[field.key] === "string")
                    .map((r) => [r.values[field.key] as string, r.display[field.key] ?? ""]),
                ).entries(),
              ].map(([email, name]) => (
                <option key={email} value={email}>
                  {name || email}
                </option>
              ))}
          </select>
        ))}
        <Button variant={archived ? "soft" : "ghost"} size="sm" icon={archived ? ArchiveRestore : Archive} onClick={() => setArchived((a) => !a)}>
          {archived ? "Showing archived" : "Archived"}
        </Button>
        <span className="ml-auto text-sm text-muted tabular-nums">{records.data ? plural(records.data.total, "record") : ""}</span>
      </div>
      {records.error && <ErrorState error={records.error} className="mb-3" />}
      {records.data && records.data.total === 0 && !search && !Object.keys(filters).length && !archived ? (
        <EmptyState
          icon={Table2}
          title={`Nothing in ${view.name} yet`}
          description="Add the first record, bring in a sheet you already keep, or let an AI employee file into it."
          action={
            view.can.edit ? (
              <>
                <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                  Add
                </Button>
                <Button icon={FileUp} onClick={() => setImporting(true)}>
                  Bring in a sheet
                </Button>
              </>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {/* Phones: each record as a card (its name, its choices, two more values). */}
          <ul className="divide-y divide-line/70 sm:hidden">
            {(records.data?.records ?? []).map((record) => (
              <li key={record.id}>
                <button type="button" className="w-full px-4 py-3 text-left hover:bg-subtle/60" onClick={() => openRecord(record.number)}>
                  <p className="truncate text-sm font-medium text-fg">
                    <span className="mr-1.5 text-muted tabular-nums">#{record.number}</span>
                    {record.title}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {view.fields
                      .filter((f) => f.type === "choice" && record.values[f.key] !== undefined)
                      .map((f) => (
                        <Badge key={f.key} size="xs">
                          {String(record.values[f.key])}
                        </Badge>
                      ))}
                    {columns
                      .filter((f) => f.type !== "choice" && f.key !== view.titleField && record.values[f.key] !== undefined)
                      .slice(0, 2)
                      .map((f) => (
                        <span key={f.key} className="truncate">
                          {formatValue(f, record.values[f.key], record.display[f.key])}
                        </span>
                      ))}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-subtle/60 text-xs text-muted">
                <tr>
                  <SortHeader label="#" field="number" sort={sort} onSort={toggleSort} className="w-16" />
                  {columns.map((f) => (
                    <SortHeader key={f.key} label={f.label} field={f.key} sort={sort} onSort={toggleSort} numeric={f.type === "number" || f.type === "money"} />
                  ))}
                  <SortHeader label="Changed" field="updated_at" sort={sort} onSort={toggleSort} className="w-44" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {(records.data?.records ?? []).map((record) => (
                  <tr key={record.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => openRecord(record.number)}>
                    <td className="px-3 py-2.5 text-muted tabular-nums">#{record.number}</td>
                    {columns.map((f) => (
                      <td
                        key={f.key}
                        className={clsx("max-w-64 truncate px-3 py-2.5", f.type === "number" || f.type === "money" ? "text-right tabular-nums" : "text-fg")}
                      >
                        <Cell field={f} value={record.values[f.key]} display={record.display[f.key]} />
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted">
                      {timeAgo(record.updatedAt)} · {record.updatedBy}
                    </td>
                  </tr>
                ))}
                {records.data && records.data.records.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 2} className="px-3 py-8 text-center text-sm text-muted">
                      No records match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {records.data && records.data.records.length < records.data.total && (
            <div className="border-t border-line px-3 py-2 text-center">
              <Button variant="ghost" size="sm" loading={records.isFetching} onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({records.data.total - records.data.records.length} left)
              </Button>
            </div>
          )}
        </Card>
      )}
      <RecordDrawer table={view} recordNumber={open ? Number(open) : null} onClose={() => openRecord(null)} />
      {view.can.edit && <NewRecordDialog table={view} open={adding} onClose={() => setAdding(false)} />}
      {view.can.edit && <ImportDialog table={view} open={importing} onClose={() => setImporting(false)} />}
      {view.can.design && <DesignDrawer table={view} open={designing} onClose={stopDesigning} company={company} initialChange={asked ?? undefined} />}
    </Page>
  );
}

function SortHeader({
  label,
  field,
  sort,
  onSort,
  className,
  numeric,
}: {
  label: string;
  field: string;
  sort: { key: string; direction: "asc" | "desc" };
  onSort: (field: string) => void;
  className?: string;
  numeric?: boolean;
}) {
  const active = sort.key === field;
  const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={clsx("px-3 py-2 font-medium", numeric && "text-right", className)}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
    >
      <button type="button" className={clsx("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")} onClick={() => onSort(field)}>
        {label}
        {active && <Icon className="size-3" />}
      </button>
    </th>
  );
}

function Cell({ field, value, display }: { field: TableField; value: unknown; display?: string }) {
  if (value === undefined || value === null) return <span className="text-faint">—</span>;
  if (field.type === "choice") return <Badge size="xs">{String(value)}</Badge>;
  return <>{formatValue(field, value, display)}</>;
}

/** Change the table: its fields (tested against its records first), who sees it and who changes it, archive. */
function DesignDrawer({
  table,
  open,
  onClose,
  company,
  initialChange,
}: {
  table: TableView;
  open: boolean;
  onClose: () => void;
  company: string;
  initialChange?: string;
}) {
  const { path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DesignDraft>(() => draftOfDesign(table));
  const [settings, setSettings] = useState<TableSettings>(table.settings);
  useEffect(() => {
    if (!open) return;
    setDraft(draftOfDesign(table));
    setSettings(table.settings);
  }, [open, table]);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
    await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
  };
  const save = useMutation({
    mutationFn: () => api.patch<TableView>(path(`/tables/${encodeURIComponent(table.key)}`), { ...designOf(draft), settings }),
    onSuccess: async () => {
      toast.success(`${table.name} changed`);
      await refresh();
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api.post<TableView>(path(`/tables/${encodeURIComponent(table.key)}/${table.archivedAt ? "restore" : "archive"}`)),
    onSuccess: async () => {
      toast.success(table.archivedAt ? `${table.name} is back` : `${table.name} archived`);
      await refresh();
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="xl"
      title={`Change ${table.name}`}
      description="Records keep their values: a field whose kind changes is converted, and if some values don't fit, nothing changes and you're told which."
      footer={
        <>
          <Button variant="ghost" icon={table.archivedAt ? ArchiveRestore : Archive} loading={archive.isPending} onClick={() => archive.mutate()}>
            {table.archivedAt ? "Bring the table back" : "Archive the table"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <ChangeBox<TableChangeProposal>
          initial={initialChange}
          placeholder="Add a field for the root cause, make Owner needed, rename Done to Closed"
          propose={(request) => api.post<TableChangeProposal>(path(`/tables/${encodeURIComponent(table.key)}/changes`), { request })}
          said={(change) => change}
          apply={(change) =>
            api.patch<TableView>(path(`/tables/${encodeURIComponent(table.key)}`), {
              fields: change.design.fields,
              titleField: change.design.titleField ?? "",
              renames: change.renames,
            })
          }
          onApplied={() => void refresh().then(onClose)}
        />
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Or change it yourself</p>
        {save.error && <ErrorState error={save.error} title="Not changed" />}
        <TableDesigner draft={draft} onChange={setDraft} tableKey={table.key} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who sees it">
            {(id) => (
              <select
                id={id}
                className="input"
                value={settings.visibility}
                onChange={(e) => setSettings({ ...settings, visibility: e.target.value as TableSettings["visibility"] })}
              >
                <option value="department">Its department's people</option>
                <option value="company">Everyone in the company</option>
              </select>
            )}
          </Field>
          <Field label="Who adds and changes records">
            {(id) => (
              <select
                id={id}
                className="input"
                value={settings.editors}
                onChange={(e) => setSettings({ ...settings, editors: e.target.value as TableSettings["editors"] })}
              >
                <option value="members">Its department's people</option>
                <option value="managers">Only its managers</option>
              </select>
            )}
          </Field>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Bot className="size-3.5" /> AI employees reach it through the Tables connection; each one only does what its job allows, and its changes follow its
          probation level.
        </p>
      </div>
    </Drawer>
  );
}
