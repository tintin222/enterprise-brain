import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Bot, FileUp, Pencil, Plus, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, fileUrl } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { formatDateTime, timeAgo } from "../../lib/format.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { RecordChange, RecordView, TableField, TableView } from "../../types.ts";
import { Badge } from "../Badge.tsx";
import { Button } from "../Button.tsx";
import { Dialog, Drawer } from "../Dialog.tsx";
import { ErrorState, LoadingBlock } from "../Spinner.tsx";
import { Timeline, type TimelineItem } from "../Timeline.tsx";
import { formatValue } from "./fields.ts";
import { draftOf, newDraft, RecordForm, valuesOf, type RecordDraft } from "./RecordForm.tsx";

/** How a changed value reads in the history ("—" when empty). */
function changedValue(field: TableField | undefined, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return field && field.type !== "person" && field.type !== "link" ? formatValue(field, value) : String(value);
}

const ACTIONS: Record<RecordChange["action"], { verb: string; icon: typeof Plus; tone: TimelineItem["tone"] }> = {
  created: { verb: "added it", icon: Plus, tone: "green" },
  imported: { verb: "brought it in from a sheet", icon: FileUp, tone: "green" },
  updated: { verb: "changed it", icon: Pencil, tone: "brand" },
  archived: { verb: "archived it", icon: Archive, tone: "amber" },
  restored: { verb: "brought it back", icon: RotateCcw, tone: "blue" },
};

/** A record: its values (to change, when the viewer may) and every change with who made it. */
export function RecordDrawer({ table, recordNumber, onClose }: { table: TableView; recordNumber: number | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const open = recordNumber !== null;
  const detail = useQuery({
    queryKey: [...keys.table(company, table.key), "record", recordNumber],
    queryFn: () => api.get<{ record: RecordView; history: RecordChange[] }>(path(`/tables/${encodeURIComponent(table.key)}/records/${recordNumber}`)),
    enabled: open,
  });
  const record = detail.data?.record;
  const [draft, setDraft] = useState<RecordDraft>({});
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (record) setDraft(draftOf(table, record.values));
    setEditing(false);
  }, [record, table]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
  const save = useMutation({
    mutationFn: () =>
      api.patch<RecordView>(path(`/tables/${encodeURIComponent(table.key)}/records/${recordNumber}`), {
        values: valuesOf(table, draft, draftOf(table, record?.values)),
      }),
    onSuccess: async () => {
      toast.success(`#${recordNumber} saved`);
      await refresh();
    },
    onError: (e) => toast.error(e),
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api.post<RecordView>(path(`/tables/${encodeURIComponent(table.key)}/records/${recordNumber}/${archived ? "archive" : "restore"}`)),
    onSuccess: async (_, archived) => {
      toast.success(archived ? `#${recordNumber} archived` : `#${recordNumber} is back`);
      await refresh();
    },
    onError: (e) => toast.error(e),
  });

  const fields = new Map(table.fields.map((f) => [f.key, f]));
  const history: TimelineItem[] = (detail.data?.history ?? []).map((change) => {
    const action = ACTIONS[change.action] ?? ACTIONS.updated;
    const shown = change.action === "created" || change.action === "imported" ? [] : change.changes;
    return {
      id: change.id,
      icon: change.ai ? Bot : action.icon,
      tone: change.ai ? "blue" : action.tone,
      title: (
        <span>
          {change.by} {change.action === "updated" && shown.length ? `changed ${shown.map((c) => c.label).join(", ")}` : action.verb}
          {change.ai && (
            <Badge size="xs" tone="blue" className="ml-1.5 align-middle">
              AI employee
            </Badge>
          )}
        </span>
      ),
      time: <span title={formatDateTime(change.createdAt)}>{timeAgo(change.createdAt)}</span>,
      body: shown.length ? (
        <ul className="space-y-0.5">
          {shown.map((c) => (
            <li key={c.key}>
              <span className="text-muted">{c.label}:</span> <span className="line-through decoration-faint">{changedValue(fields.get(c.key), c.from)}</span> →{" "}
              <span className="text-fg">{changedValue(fields.get(c.key), c.to)}</span>
            </li>
          ))}
        </ul>
      ) : undefined,
      meta: change.runId ? (
        <Link to={`/runs/${change.runId}`} className="text-brand-600 hover:underline dark:text-brand-300">
          See the work it was part of
        </Link>
      ) : undefined,
    };
  });

  const archived = Boolean(record?.archivedAt);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={record ? `#${record.number} ${record.title === `#${record.number}` ? "" : record.title}` : `#${recordNumber ?? ""}`}
      description={record ? `${table.name} · added by ${record.createdBy} ${timeAgo(record.createdAt)}${archived ? " · archived" : ""}` : table.name}
      footer={
        record && table.can.edit ? (
          <>
            <Button icon={archived ? ArchiveRestore : Archive} variant="ghost" loading={archive.isPending} onClick={() => archive.mutate(!archived)}>
              {archived ? "Bring back" : "Archive"}
            </Button>
            {editing ? (
              <>
                <Button onClick={() => (setDraft(draftOf(table, record.values)), setEditing(false))}>Cancel</Button>
                <Button variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setEditing(false) })}>
                  Save
                </Button>
              </>
            ) : (
              !archived && (
                <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>
                  Change
                </Button>
              )
            )}
          </>
        ) : undefined
      }
    >
      {detail.isLoading && <LoadingBlock />}
      {detail.error && <ErrorState error={detail.error} />}
      {record && (
        <div className="space-y-6">
          {editing ? (
            <RecordForm table={table} draft={draft} onChange={setDraft} display={record.display} />
          ) : (
            <dl className="divide-y divide-line/70 rounded-xl border border-line">
              {table.fields.map((field) => {
                const value = record.values[field.key];
                return (
                  <div key={field.key} className="grid grid-cols-3 gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-muted">{field.label}</dt>
                    <dd className="col-span-2 break-words whitespace-pre-wrap text-fg">
                      {value === undefined ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <ValueView field={field} value={value} display={record.display[field.key]} />
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          <section>
            <h3 className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">History</h3>
            <Timeline items={history} />
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** A value as it reads on its own: links open the file, web and email addresses are links. */
export function ValueView({ field, value, display }: { field: TableField; value: unknown; display?: string }) {
  const { company } = useCompany();
  if (field.type === "file" && typeof value === "string") {
    return (
      <a className="text-brand-600 hover:underline dark:text-brand-300" href={fileUrl(company, value)} target="_blank" rel="noopener noreferrer">
        Open the file
      </a>
    );
  }
  if (field.type === "url" && typeof value === "string") {
    return (
      <a className="text-brand-600 hover:underline dark:text-brand-300" href={value} target="_blank" rel="noopener noreferrer">
        {value}
      </a>
    );
  }
  if (field.type === "email" && typeof value === "string") {
    return (
      <a className="text-brand-600 hover:underline dark:text-brand-300" href={`mailto:${value}`}>
        {value}
      </a>
    );
  }
  return <>{formatValue(field, value, display)}</>;
}

/** A new record: its form, with each field's starting value. */
export function NewRecordDialog({
  table,
  open,
  onClose,
  onAdded,
}: {
  table: TableView;
  open: boolean;
  onClose: () => void;
  onAdded?: (record: RecordView) => void;
}) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RecordDraft>(() => newDraft(table));
  useEffect(() => {
    if (open) setDraft(newDraft(table));
  }, [open, table]);
  const add = useMutation({
    mutationFn: () => api.post<RecordView>(path(`/tables/${encodeURIComponent(table.key)}/records`), { values: valuesOf(table, draft) }),
    onSuccess: async (record) => {
      toast.success(`#${record.number} added to ${table.name}`);
      await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
      await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      onAdded?.(record);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Add to ${table.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Plus} loading={add.isPending} onClick={() => add.mutate()}>
            Add
          </Button>
        </>
      }
    >
      {add.error && <ErrorState error={add.error} title="It can't be added yet" className="mb-4" />}
      <RecordForm table={table} draft={draft} onChange={setDraft} />
    </Dialog>
  );
}
