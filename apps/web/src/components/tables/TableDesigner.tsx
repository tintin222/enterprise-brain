import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTables } from "../../lib/queries.ts";
import type { TableDesign, TableField, TableFieldType } from "../../types.ts";
import { Button, IconButton } from "../Button.tsx";
import { Checkbox, Field } from "../Form.tsx";
import { FIELD_KINDS, fieldKeyOf } from "./fields.ts";

/** A table's design while people shape it: its name, what it keeps, and each field. */
export interface DesignDraft {
  name: string;
  description: string;
  titleField?: string;
  fields: (TableField & { /** Made here, so its key follows its label until saved. */ fresh?: boolean })[];
}

export function draftOfDesign(design: Pick<TableDesign, "name" | "description" | "fields" | "titleField">, fresh = false): DesignDraft {
  return {
    name: design.name,
    description: design.description,
    titleField: design.titleField,
    fields: design.fields.map((f) => ({ ...f, ...(fresh ? { fresh: true } : {}) })),
  };
}

/** The design to save: keys for new fields from their labels, values only where their kind uses them. */
export function designOf(draft: DesignDraft): Pick<TableDesign, "name" | "description" | "fields" | "titleField"> {
  const fields = draft.fields
    .filter((f) => f.label.trim())
    .map(({ fresh: _fresh, ...f }) => {
      const field: TableField = { ...f, label: f.label.trim() };
      if (field.type !== "choice") delete field.choices;
      else field.choices = [...new Set((field.choices ?? []).map((c) => c.trim()).filter(Boolean))];
      if (field.type !== "money") delete field.currency;
      if (field.type !== "link") delete field.table;
      if (field.default === "" || (field.type === "choice" && field.default !== undefined && !field.choices?.includes(String(field.default))))
        delete field.default;
      if (!field.description?.trim()) delete field.description;
      return field;
    });
  const titleField = fields.some((f) => f.key === draft.titleField) ? draft.titleField : undefined;
  return { name: draft.name.trim(), description: draft.description.trim(), fields, ...(titleField ? { titleField } : {}) };
}

/** Edit a table's fields: label, kind, whether it's needed, the list to pick from, where a link points. */
export function TableDesigner({ draft, onChange, tableKey }: { draft: DesignDraft; onChange: (next: DesignDraft) => void; tableKey?: string }) {
  const tables = useTables();
  const targets = (tables.data ?? []).filter((t) => t.key !== tableKey);
  const setField = (index: number, patch: Partial<DesignDraft["fields"][number]>) => {
    const fields = draft.fields.map((f, i) => {
      if (i !== index) return f;
      const next = { ...f, ...patch };
      // A new field's key follows its label; a saved one keeps its key, so its records keep their values.
      if (f.fresh && patch.label !== undefined)
        next.key = fieldKeyOf(
          patch.label,
          draft.fields.filter((_, j) => j !== index).map((x) => x.key),
        );
      return next;
    });
    onChange({ ...draft, fields });
  };
  const move = (index: number, by: number) => {
    const fields = [...draft.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + by, 0, field!);
    onChange({ ...draft, fields });
  };
  const add = () =>
    onChange({
      ...draft,
      fields: [
        ...draft.fields,
        {
          key: fieldKeyOf(
            "new_field",
            draft.fields.map((f) => f.key),
          ),
          label: "",
          type: "text",
          fresh: true,
        },
      ],
    });
  const textFields = draft.fields.filter((f) => f.type === "text" && f.label.trim());
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          {(id) => <input id={id} className="input" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />}
        </Field>
        <Field label="A record is called by" hint="The field that names a record in lists">
          {(id) => (
            <select id={id} className="input" value={draft.titleField ?? ""} onChange={(e) => onChange({ ...draft, titleField: e.target.value || undefined })}>
              <option value="">The first text field</option>
              {textFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="What it keeps" optional>
        {(id) => (
          <textarea id={id} className="input min-h-16" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
        )}
      </Field>
      <div>
        <p className="label">Fields</p>
        <ol className="space-y-2">
          {draft.fields.map((field, index) => (
            <li key={index} className="rounded-xl border border-line bg-subtle/40 p-3">
              <div className="flex flex-wrap items-start gap-2">
                <input
                  className="input min-w-40 flex-1"
                  placeholder="Label, e.g. Supplier"
                  aria-label="Label"
                  value={field.label}
                  onChange={(e) => setField(index, { label: e.target.value })}
                />
                <select
                  className="input w-auto"
                  aria-label="Kind"
                  value={field.type}
                  onChange={(e) => setField(index, { type: e.target.value as TableFieldType })}
                >
                  {FIELD_KINDS.map((k) => (
                    <option key={k.type} value={k.type}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <div className="flex items-center">
                  <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={index === draft.fields.length - 1} onClick={() => move(index, 1)} />
                  <IconButton
                    icon={Trash2}
                    label="Remove the field"
                    size="sm"
                    onClick={() => onChange({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })}
                  />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                {field.type === "choice" && (
                  <input
                    className="input min-w-56 flex-1"
                    placeholder="The values, separated by commas"
                    aria-label="Values to pick from"
                    value={(field.choices ?? []).join(", ")}
                    onChange={(e) => setField(index, { choices: e.target.value.split(",").map((c) => c.trimStart()) })}
                  />
                )}
                {field.type === "choice" && (field.choices ?? []).some((c) => c.trim()) && (
                  <select
                    className="input w-auto"
                    aria-label="Starts as"
                    value={String(field.default ?? "")}
                    onChange={(e) => setField(index, { default: e.target.value || undefined })}
                  >
                    <option value="">Starts empty</option>
                    {(field.choices ?? [])
                      .map((c) => c.trim())
                      .filter(Boolean)
                      .map((c) => (
                        <option key={c} value={c}>
                          Starts as {c}
                        </option>
                      ))}
                  </select>
                )}
                {field.type === "money" && (
                  <input
                    className="input w-28"
                    placeholder="Currency"
                    aria-label="Currency"
                    maxLength={3}
                    value={field.currency ?? ""}
                    onChange={(e) => setField(index, { currency: e.target.value.toUpperCase() || undefined })}
                  />
                )}
                {field.type === "link" && (
                  <select
                    className="input w-auto"
                    aria-label="Points at"
                    value={field.table ?? ""}
                    onChange={(e) => setField(index, { table: e.target.value || undefined })}
                  >
                    <option value="">Which table?</option>
                    {targets.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                    {tableKey && <option value={tableKey}>This table</option>}
                  </select>
                )}
                <Checkbox label="Needed" checked={Boolean(field.required)} onChange={(required) => setField(index, { required: required || undefined })} />
                <Checkbox
                  label="Personal data"
                  checked={Boolean(field.personal)}
                  onChange={(personal) => setField(index, { personal: personal || undefined })}
                />
              </div>
            </li>
          ))}
        </ol>
        <Button className="mt-2" size="sm" icon={Plus} onClick={add}>
          Add a field
        </Button>
      </div>
    </div>
  );
}
