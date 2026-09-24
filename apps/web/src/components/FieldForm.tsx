import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Mail, Paperclip } from "lucide-react";
import { useState, type ReactNode } from "react";
import { humanize } from "../lib/format.ts";
import type { FieldSpec, UploadedFile } from "../types.ts";
import { Dropzone, FileChip } from "./Dropzone.tsx";
import { Checkbox, Field, Switch } from "./Form.tsx";

/** A file already stored on the server (e.g. a bundled demo sample). */
export interface StoredRef {
  fileId: string;
  name: string;
  size?: number;
}

export type FileValue = File | StoredRef;

export interface EmailDraft {
  from: string;
  fromName: string;
  subject: string;
  body: string;
  attachments: FileValue[];
}

/**
 * Form state per field type:
 * string-like/number/select/list/object(JSON) → string · boolean → boolean ·
 * multiselect → string[] · file → FileValue · files → FileValue[] · object `email` → EmailDraft
 */
export type FieldValue = string | boolean | string[] | FileValue | FileValue[] | EmailDraft | undefined;
export type FormValues = Record<string, FieldValue>;

export function isStoredRef(value: unknown): value is StoredRef {
  return typeof value === "object" && value !== null && "fileId" in value && !(value instanceof File);
}

function isEmailField(field: FieldSpec): boolean {
  return field.type === "object" && field.key === "email";
}

export function emptyEmail(): EmailDraft {
  return { from: "", fromName: "", subject: "", body: "", attachments: [] };
}

function isEmailDraft(value: unknown): value is EmailDraft {
  return typeof value === "object" && value !== null && "subject" in value && "body" in value && "attachments" in value;
}

export function hasValue(value: FieldValue): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isEmailDraft(value)) return Boolean(value.from.trim() || value.subject.trim() || value.body.trim() || value.attachments.length);
  return true;
}

export function fieldTitle(field: FieldSpec): string {
  return field.label ?? humanize(field.key);
}

/** Labels of required fields without a value. */
export function missingRequired(fields: FieldSpec[], values: FormValues): string[] {
  return fields.filter((f) => f.required && !hasValue(values[f.key])).map(fieldTitle);
}

function lines(text: string): string[] {
  return text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function placeholderFor(field: FieldSpec): string | undefined {
  if (field.example !== undefined && field.example !== null) {
    return typeof field.example === "string" ? `e.g. ${field.example}` : `e.g. ${JSON.stringify(field.example)}`;
  }
  switch (field.type) {
    case "email":
      return "name@company.com";
    case "url":
      return "https://";
    case "phone":
      return "+90 …";
    case "list":
      return field.fields?.length ? '[{ "…": "…" }]' : "One per line";
    case "object":
      return field.fields?.length
        ? `{ ${field.fields
            .slice(0, 3)
            .map((f) => `"${f.key}": …`)
            .join(", ")} }`
        : "{ }";
    default:
      return undefined;
  }
}

function acceptFor(field: FieldSpec): string[] | undefined {
  return field.accept?.length ? field.accept : undefined;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function FileControl({ field, value, onChange, disabled }: { field: FieldSpec; value: FieldValue; onChange: (v: FieldValue) => void; disabled?: boolean }) {
  const multiple = field.type === "files";
  const list: FileValue[] = multiple ? ((value as FileValue[] | undefined) ?? []) : value ? [value as FileValue] : [];
  return (
    <div className="space-y-2">
      {(multiple || list.length === 0) && (
        <Dropzone
          accept={acceptFor(field)}
          multiple={multiple}
          disabled={disabled}
          compact={list.length > 0}
          label={multiple ? "Drop files here or click to browse" : `Drop the ${fieldTitle(field)} here or click to browse`}
          onFiles={(files) => onChange(multiple ? [...list, ...files] : files[0])}
        />
      )}
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((f, i) => (
            <FileChip
              key={`${f.name}-${i}`}
              name={f.name}
              size={f instanceof File ? f.size : f.size}
              onRemove={disabled ? undefined : () => onChange(multiple ? list.filter((_, j) => j !== i) : undefined)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmailComposer({
  value,
  onChange,
  disabled,
  required,
}: {
  value: EmailDraft;
  onChange: (v: EmailDraft) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const set = (patch: Partial<EmailDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3 rounded-xl border border-line bg-subtle/40 p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="From" required={required}>
          {(id) => (
            <input
              id={id}
              type="email"
              className="input"
              placeholder="sender@example.com"
              value={value.from}
              disabled={disabled}
              onChange={(e) => set({ from: e.target.value })}
            />
          )}
        </Field>
        <Field label="Sender name" optional>
          {(id) => (
            <input
              id={id}
              className="input"
              placeholder="Jane Doe"
              value={value.fromName}
              disabled={disabled}
              onChange={(e) => set({ fromName: e.target.value })}
            />
          )}
        </Field>
      </div>
      <Field label="Subject">
        {(id) => <input id={id} className="input" value={value.subject} disabled={disabled} onChange={(e) => set({ subject: e.target.value })} />}
      </Field>
      <Field label="Body">
        {(id) => <textarea id={id} rows={5} className="input" value={value.body} disabled={disabled} onChange={(e) => set({ body: e.target.value })} />}
      </Field>
      <div>
        <span className="label flex items-center gap-1.5">
          <Paperclip className="size-3.5" /> Attachments
        </span>
        <Dropzone compact disabled={disabled} label="Attach files" onFiles={(files) => set({ attachments: [...value.attachments, ...files] })} />
        {value.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {value.attachments.map((f, i) => (
              <FileChip
                key={`${f.name}-${i}`}
                name={f.name}
                size={f instanceof File ? f.size : f.size}
                onRemove={disabled ? undefined : () => set({ attachments: value.attachments.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function FieldControl({
  field,
  value,
  onChange,
  disabled,
  id,
}: {
  field: FieldSpec;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  disabled?: boolean;
  id?: string;
}): ReactNode {
  const text = typeof value === "string" ? value : "";
  const placeholder = placeholderFor(field);
  switch (field.type) {
    case "text":
      return (
        <textarea id={id} rows={5} className="input" placeholder={placeholder} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      );
    case "number":
    case "integer":
      return (
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={field.type === "integer" ? 1 : "any"}
          className="input sm:max-w-xs"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return <input id={id} type="date" className="input sm:max-w-xs" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "boolean":
      return <Switch id={id} checked={value === true} disabled={disabled} onChange={(v) => onChange(v)} label={value === true ? "Yes" : "No"} />;
    case "select":
      return (
        <select id={id} className="input" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label ?? o.value}
            </option>
          ))}
        </select>
      );
    case "multiselect": {
      if (!field.options?.length) {
        return (
          <textarea id={id} rows={3} className="input" placeholder="One per line" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        );
      }
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div id={id} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {field.options.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label ?? o.value}
              description={o.description}
              disabled={disabled}
              checked={selected.includes(o.value)}
              onChange={(checked) => onChange(checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
            />
          ))}
        </div>
      );
    }
    case "file":
    case "files":
      return <FileControl field={field} value={value} onChange={onChange} disabled={disabled} />;
    case "list":
      return (
        <textarea
          id={id}
          rows={field.fields?.length ? 5 : 3}
          className={clsx("input", field.fields?.length && "font-mono text-xs")}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "object":
      if (isEmailField(field)) {
        return <EmailComposer value={isEmailDraft(value) ? value : emptyEmail()} onChange={onChange} disabled={disabled} required={field.required} />;
      }
      return (
        <textarea
          id={id}
          rows={4}
          className="input font-mono text-xs"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default: {
      const type = field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "phone" ? "tel" : "text";
      return (
        <input id={id} type={type} className="input" placeholder={placeholder} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      );
    }
  }
}

function hintFor(field: FieldSpec): ReactNode {
  const bits: string[] = [];
  if (field.description) bits.push(field.description);
  if (field.type === "list" && !field.fields?.length) bits.push("One item per line.");
  if (field.type === "list" && field.fields?.length) bits.push("JSON array.");
  if (field.type === "object" && !isEmailField(field)) bits.push("JSON object.");
  return bits.length ? bits.join(" ") : undefined;
}

/** Optional email object: collapsed by default ("set automatically when mail arrives"). */
function CollapsibleEmail({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldSpec;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(hasValue(value));
  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium text-fg hover:bg-subtle/60"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
        <Mail className="size-4 text-muted" />
        {fieldTitle(field)}
        <span className="ml-auto text-xs font-normal text-faint">optional</span>
      </button>
      {open && (
        <div className="border-t border-line p-3.5 pt-3">
          {field.description && <p className="mb-3 text-xs text-muted">{field.description} Fill it in to simulate an incoming email.</p>}
          <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} />
        </div>
      )}
    </div>
  );
}

/** Renders FieldSpec[] as form controls. */
export function FieldForm({
  fields,
  values,
  onChange,
  disabled,
  className,
}: {
  fields: FieldSpec[];
  values: FormValues;
  onChange: (key: string, value: FieldValue) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!fields.length) return <p className="text-sm text-muted">This agent needs no input.</p>;
  return (
    <div className={clsx("space-y-4", className)}>
      {fields.map((field) =>
        isEmailField(field) && !field.required ? (
          <CollapsibleEmail key={field.key} field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} disabled={disabled} />
        ) : (
          <Field key={field.key} label={fieldTitle(field)} required={field.required} hint={hintFor(field)}>
            {(id) => <FieldControl id={id} field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} disabled={disabled} />}
          </Field>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build the multipart body for POST /agents/:agent/runs: one part per simple
 * field, file parts named after their field, typed/complex values (lists,
 * objects, stored file ids) in the `input` JSON part. Files inside an email
 * object are uploaded first (the email carries file ids).
 */
export async function buildRunForm(
  fields: FieldSpec[],
  values: FormValues,
  upload: (files: File[]) => Promise<UploadedFile[]>,
  options: { test?: boolean; wait?: boolean } = {},
): Promise<FormData> {
  const form = new FormData();
  const extra: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (!hasValue(value)) continue;
    const key = field.key;
    switch (field.type) {
      case "file": {
        const v = value as FileValue;
        if (v instanceof File) form.append(key, v, v.name);
        else extra[key] = v.fileId;
        break;
      }
      case "files": {
        const list = value as FileValue[];
        const refs = list.filter(isStoredRef);
        const files = list.filter((f): f is File => f instanceof File);
        if (refs.length) {
          const uploaded = files.length ? await upload(files) : [];
          extra[key] = [...refs.map((r) => r.fileId), ...uploaded.map((u) => u.id)];
        } else {
          for (const f of files) form.append(key, f, f.name);
        }
        break;
      }
      case "boolean":
        form.append(key, value ? "true" : "false");
        break;
      case "number":
      case "integer":
        form.append(key, String(value));
        break;
      case "multiselect":
        extra[key] = Array.isArray(value) ? value : lines(String(value));
        break;
      case "list":
        extra[key] = field.fields?.length ? parseJsonOr(String(value)) : lines(String(value));
        break;
      case "object": {
        if (isEmailDraft(value)) {
          const files = value.attachments.filter((f): f is File => f instanceof File);
          const refs = value.attachments.filter(isStoredRef);
          const uploaded = files.length ? await upload(files) : [];
          const attachments = [...refs.map((r) => ({ id: r.fileId, name: r.name })), ...uploaded.map((u) => ({ id: u.id, name: u.name }))];
          extra[key] = {
            from: value.from,
            fromName: value.fromName || null,
            subject: value.subject,
            body: value.body,
            to: [],
            mailbox: "",
            attachments: attachments.map((a) => a.id),
            attachmentNames: attachments.map((a) => a.name),
            receivedAt: new Date().toISOString(),
          };
        } else {
          extra[key] = parseJsonOr(String(value));
        }
        break;
      }
      default:
        form.append(key, String(value));
    }
  }
  if (Object.keys(extra).length) form.append("input", JSON.stringify(extra));
  form.append("wait", options.wait === false ? "false" : "true");
  if (options.test) form.append("test", "true");
  return form;
}
