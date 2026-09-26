import { Paperclip, X } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, fileUrl } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { usePeople, useRecords, useTables } from "../../lib/queries.ts";
import type { TableField, TableView } from "../../types.ts";
import { Field } from "../Form.tsx";
import { inputValue } from "./fields.ts";

/** The values being filled in: what people typed, by field key ("" clears a field). */
export type RecordDraft = Record<string, string>;

/** A record's values as a form draft. */
export function draftOf(table: Pick<TableView, "fields">, values: Record<string, unknown> = {}): RecordDraft {
  return Object.fromEntries(table.fields.map((f) => [f.key, inputValue(f, values[f.key])]));
}

/** A new record's form: each field starts with the value it starts as. */
export function newDraft(table: Pick<TableView, "fields">): RecordDraft {
  return Object.fromEntries(table.fields.map((f) => [f.key, f.default === undefined ? "" : inputValue(f, f.default)]));
}

/** What to send: yes/no as true/false, the rest as typed (the platform reads "1.250,50" and "02.10.2026"). */
export function valuesOf(table: Pick<TableView, "fields">, draft: RecordDraft, before?: RecordDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of table.fields) {
    const value = draft[field.key] ?? "";
    if (before && (before[field.key] ?? "") === value) continue;
    if (!before && value === "") continue;
    out[field.key] = field.type === "yes_no" && value ? value === "yes" : value;
  }
  return out;
}

/** The inputs of a record: one per field, by its kind. */
export function RecordForm({
  table,
  draft,
  onChange,
  display = {},
  disabled,
}: {
  table: TableView;
  draft: RecordDraft;
  onChange: (next: RecordDraft) => void;
  display?: Record<string, string>;
  disabled?: boolean;
}) {
  const set = (key: string, value: string) => onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      {table.fields.map((field) => (
        <Field key={field.key} label={field.label} required={field.required} hint={field.description}>
          {(id) => (
            <FieldInput
              id={id}
              field={field}
              value={draft[field.key] ?? ""}
              onChange={(v) => set(field.key, v)}
              display={display[field.key]}
              disabled={disabled}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

function FieldInput({
  id,
  field,
  value,
  onChange,
  display,
  disabled,
}: {
  id: string;
  field: TableField;
  value: string;
  onChange: (value: string) => void;
  display?: string;
  disabled?: boolean;
}) {
  switch (field.type) {
    case "long_text":
      return <textarea id={id} className="input min-h-24" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case "number":
    case "money":
      return (
        <div className="relative">
          <input id={id} className="input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
          {field.type === "money" && field.currency && (
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{field.currency}</span>
          )}
        </div>
      );
    case "date":
      return <input id={id} type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case "yes_no":
      return (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "choice":
      return (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">—</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
          {value && !(field.choices ?? []).includes(value) && <option value={value}>{value}</option>}
        </select>
      );
    case "person":
      return <PersonInput id={id} value={value} onChange={onChange} display={display} disabled={disabled} />;
    case "link":
      return <LinkInput id={id} field={field} value={value} onChange={onChange} display={display} disabled={disabled} />;
    case "file":
      return <FileInput id={id} value={value} onChange={onChange} disabled={disabled} />;
    case "email":
      return <input id={id} type="email" className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case "url":
      return <input id={id} type="url" className="input" placeholder="https://" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    default:
      return <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  }
}

/** Someone of the company, by email (the people the viewer sees). */
function PersonInput({
  id,
  value,
  onChange,
  display,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  display?: string;
  disabled?: boolean;
}) {
  const people = usePeople();
  const list = [...(people.data ?? [])].filter((p) => p.status === "active").sort((a, b) => a.name.localeCompare(b.name));
  const known = !value || list.some((p) => p.email === value);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">—</option>
      {!known && <option value={value}>{display ?? value}</option>}
      {list.map((p) => (
        <option key={p.id} value={p.email}>
          {p.name}
          {p.title ? ` · ${p.title}` : ""}
        </option>
      ))}
    </select>
  );
}

/** A record of another table: picked from its records, or typed ("#12", a name) when the viewer can't see that table. */
function LinkInput({
  id,
  field,
  value,
  onChange,
  display,
  disabled,
}: {
  id: string;
  field: TableField;
  value: string;
  onChange: (value: string) => void;
  display?: string;
  disabled?: boolean;
}) {
  const tables = useTables();
  const target = tables.data?.find((t) => t.key === field.table);
  const records = useRecords(field.table, { limit: 500, sort: target?.titleField, direction: "asc" }, { enabled: Boolean(target) });
  if (!target || records.error) {
    return (
      <input
        id={id}
        className="input"
        placeholder="The record's number (#12) or name"
        value={display && value && /^[0-9a-f-]{36}$/.test(value) ? display : value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    );
  }
  const list = records.data?.records ?? [];
  const known = !value || list.some((r) => r.id === value);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">—</option>
      {!known && <option value={value}>{display ?? value}</option>}
      {list.map((r) => (
        <option key={r.id} value={r.id}>
          #{r.number} {r.title}
        </option>
      ))}
    </select>
  );
}

/** A file: the one stored, or a new one uploaded. */
function FileInput({ id, value, onChange, disabled }: { id: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { company, path } = useCompany();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const [stored] = await api.upload<{ id: string }[]>(path("/files"), form);
      if (stored) onChange(stored.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      {value && (
        <div className="flex items-center gap-2 text-sm">
          <Paperclip className="size-4 text-muted" />
          <a href={fileUrl(company, value)} className="text-brand-600 hover:underline dark:text-brand-300" target="_blank" rel="noopener noreferrer">
            Open the file
          </a>
          {!disabled && (
            <button type="button" className="rounded p-0.5 text-faint hover:text-fg" onClick={() => onChange("")} aria-label="Remove the file">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <input
        id={id}
        type="file"
        className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg"
        disabled={disabled || busy}
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
