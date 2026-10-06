import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../../api.ts";
import { Button, IconButton } from "../../components/Button.tsx";
import { Drawer } from "../../components/Dialog.tsx";
import { useCompany } from "../../lib/company.tsx";
import { useToast } from "../../lib/toast.tsx";
import type {
  BrainApi,
  BrainContact,
  BrainDataColumn,
  BrainDataDimension,
  BrainEntity,
  BrainField,
  BrainImage,
  BrainKind,
  BrainMeasure,
  BrainMilestone,
  BrainStep,
  BrainTable,
} from "../../types.ts";
import { brainKeys, brainPath, lowerName, useBrainEntities, useBrainModel } from "./brain.tsx";

type Values = Record<string, unknown>;

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function move<T>(list: T[], index: number, by: number): T[] {
  const next = [...list];
  const target = index + by;
  if (target < 0 || target >= next.length) return list;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function ItemTools({ index, count, onMove, onRemove }: { index: number; count: number; onMove: (by: number) => void; onRemove: () => void }) {
  return (
    <div className="flex shrink-0 gap-0.5">
      <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={index === 0} onClick={() => onMove(-1)} />
      <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={index === count - 1} onClick={() => onMove(1)} />
      <IconButton icon={Trash2} label="Remove" size="sm" onClick={onRemove} />
    </div>
  );
}

function StepsEditor({ value, onChange }: { value: BrainStep[]; onChange: (steps: BrainStep[]) => void }) {
  const people = useBrainEntities("person");
  const roles = useBrainEntities("role");
  const ai = useBrainEntities("ai_employee");
  const systems = useBrainEntities("system");
  const whoList = useId();
  const systemList = useId();
  const set = (i: number, patch: Partial<BrainStep>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      <datalist id={whoList}>
        {[...(people.data ?? []), ...(roles.data ?? []), ...(ai.data ?? [])].map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>
      <datalist id={systemList}>
        {(systems.data ?? []).map((s) => (
          <option key={s.id} value={s.name} />
        ))}
      </datalist>
      {value.map((step, i) => (
        <div key={i} className="rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
              {i + 1}
            </span>
            <input className="input h-8 py-1 text-[13px] font-medium" placeholder="Step" value={step.name} onChange={(e) => set(i, { name: e.target.value })} />
            <ItemTools
              index={i}
              count={value.length}
              onMove={(by) => onChange(move(value, i, by))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              className="input h-8 py-1 text-[13px]"
              list={whoList}
              placeholder="Who does it"
              value={step.who}
              onChange={(e) => set(i, { who: e.target.value })}
            />
            <input
              className="input h-8 py-1 text-[13px]"
              list={systemList}
              placeholder="In which system"
              value={step.system}
              onChange={(e) => set(i, { system: e.target.value })}
            />
          </div>
          <textarea
            className="input mt-2 min-h-12 text-[13px]"
            placeholder="What is done"
            value={step.does}
            onChange={(e) => set(i, { does: e.target.value })}
          />
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", who: "", system: "", does: "" }])}>
        Add a step
      </Button>
    </div>
  );
}

const API_STYLES = ["REST", "OData v2", "OData v4", "SOAP", "GraphQL", "RFC", "gRPC", "Files", "Database", "Other"];

function ApisEditor({ value, onChange }: { value: BrainApi[]; onChange: (apis: BrainApi[]) => void }) {
  const set = (i: number, patch: Partial<BrainApi>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div className="space-y-2">
      {value.map((api, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <input
              className="input h-8 py-1 text-[13px] font-medium"
              placeholder="Name, e.g. REST API"
              value={api.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <select className="input h-8 w-36 py-1 text-[13px]" value={api.style} onChange={(e) => set(i, { style: e.target.value })}>
              {[...new Set([api.style, ...API_STYLES])].filter(Boolean).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <ItemTools
              index={i}
              count={value.length}
              onMove={(by) => onChange(move(value, i, by))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          </div>
          <input
            className="input h-8 py-1 font-mono text-xs"
            placeholder="Address (base URL)"
            value={api.url}
            onChange={(e) => set(i, { url: e.target.value })}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input h-8 py-1 text-[13px]" placeholder="How it signs in" value={api.auth} onChange={(e) => set(i, { auth: e.target.value })} />
            <input
              className="input h-8 py-1 text-[13px]"
              placeholder="Documentation link"
              value={api.docs}
              onChange={(e) => set(i, { docs: e.target.value })}
            />
          </div>
          <textarea
            className="input min-h-20 font-mono text-xs"
            placeholder={"Endpoints, one per line:\nGET /orders/{id} — an order\nPOST /orders — create an order"}
            value={api.endpoints.join("\n")}
            onChange={(e) => set(i, { endpoints: e.target.value.split("\n") })}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="soft"
        icon={Plus}
        onClick={() => onChange([...value, { name: "", style: "REST", url: "", auth: "", docs: "", endpoints: [] }])}
      >
        Add an API
      </Button>
    </div>
  );
}

/** Tables from CREATE TABLE statements: columns, types, primary and foreign keys. */
export function tablesFromSql(sql: string): BrainTable[] {
  const tables: BrainTable[] = [];
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."[\]`]+)\s*\(([\s\S]*?)\)\s*;/gi;
  const clean = (name: string) =>
    name
      .replace(/["[\]`]/g, "")
      .split(".")
      .pop() ?? name;
  for (const match of `${sql.trim()}${sql.trim().endsWith(";") ? "" : ";"}`.matchAll(pattern)) {
    const name = clean(match[1]!);
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of match[2]!) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else current += char;
    }
    if (current.trim()) parts.push(current.trim());
    const primary = new Set<string>();
    const foreign = new Map<string, string>();
    const columns: BrainTable["columns"] = [];
    for (const part of parts) {
      const tableKey = part.match(/^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/i);
      if (tableKey) {
        for (const c of tableKey[1]!.split(",")) primary.add(clean(c.trim()));
        continue;
      }
      const fk = part.match(/^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."[\]`]+)\s*\(([^)]+)\)/i);
      if (fk) {
        foreign.set(clean(fk[1]!.trim()), `${clean(fk[2]!)}.${clean(fk[3]!.trim())}`);
        continue;
      }
      if (/^(constraint|unique|index|key|check)\b/i.test(part)) continue;
      const column = part.match(/^([\w"[\]`]+)\s+(.+)$/s);
      if (!column) continue;
      const rest = column[2]!.replace(/\s+/g, " ");
      const type = rest
        .split(/\s+(?:not\s+null|null|primary|references|default|unique|check|constraint|identity|auto_increment|generated|collate)\b/i)[0]!
        .trim();
      const ref = rest.match(/references\s+([\w."[\]`]+)\s*\(([^)]+)\)/i);
      const comment = rest.match(/comment\s+'([^']*)'/i)?.[1] ?? "";
      columns.push({
        name: clean(column[1]!),
        type,
        key: /primary\s+key/i.test(rest) ? "PK" : ref ? `FK → ${clean(ref[1]!)}.${clean(ref[2]!.trim())}` : "",
        description: comment,
      });
    }
    for (const column of columns) {
      if (primary.has(column.name)) column.key = column.key ? `PK, ${column.key}` : "PK";
      const fk = foreign.get(column.name);
      if (fk && !column.key.includes("FK")) column.key = column.key ? `${column.key}, FK → ${fk}` : `FK → ${fk}`;
    }
    tables.push({ name, description: "", columns });
  }
  return tables;
}

function columnsText(table: BrainTable): string {
  return table.columns.map((c) => [c.name, c.type, c.key, c.description].join(" | ").replace(/(\s\|\s)+$/, "")).join("\n");
}

function columnsFrom(text: string): BrainTable["columns"] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", type = "", key = "", description = ""] = line.split("|").map((p) => p.trim());
      return { name, type, key, description };
    });
}

function TablesEditor({ value, onChange }: { value: BrainTable[]; onChange: (tables: BrainTable[]) => void }) {
  const [pasting, setPasting] = useState(false);
  const [sql, setSql] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const set = (i: number, patch: Partial<BrainTable>) => onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const found = sql.trim() ? tablesFromSql(sql) : [];
  return (
    <div className="space-y-2">
      {value.map((table, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <input
              className="input h-8 py-1 font-mono text-[13px] font-medium"
              placeholder="Table name"
              value={table.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <ItemTools
              index={i}
              count={value.length}
              onMove={(by) => onChange(move(value, i, by))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          </div>
          <input
            className="input h-8 py-1 text-[13px]"
            placeholder="What it holds"
            value={table.description}
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <textarea
            className="input min-h-24 font-mono text-xs"
            placeholder={
              "Columns, one per line: name | type | key | what it holds\norder_id | int | PK | Order number\ncustomer_id | int | FK → customers.id | Customer"
            }
            value={drafts[i] ?? columnsText(table)}
            onChange={(e) => {
              setDrafts((d) => ({ ...d, [i]: e.target.value }));
              set(i, { columns: columnsFrom(e.target.value) });
            }}
          />
        </div>
      ))}
      {pasting ? (
        <div className="space-y-2 rounded-lg border border-dashed border-line-strong p-2.5">
          <textarea
            className="input min-h-28 font-mono text-xs"
            placeholder="Paste CREATE TABLE statements here"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!found.length}
              onClick={() => {
                onChange([...value, ...found]);
                setSql("");
                setPasting(false);
              }}
            >
              Add {found.length ? `${found.length} table${found.length === 1 ? "" : "s"}` : "tables"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
            {sql.trim() && !found.length && <span className="text-xs text-muted">No CREATE TABLE statement found yet.</span>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", description: "", columns: [] }])}>
            Add a table
          </Button>
          <Button size="sm" variant="ghost" icon={ClipboardPaste} onClick={() => setPasting(true)}>
            Paste CREATE TABLE
          </Button>
        </div>
      )}
    </div>
  );
}

function ContactsEditor({ value, onChange }: { value: BrainContact[]; onChange: (contacts: BrainContact[]) => void }) {
  const set = (i: number, patch: Partial<BrainContact>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-2">
      {value.map((contact, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-2">
          <input className="input h-8 py-1 text-[13px]" placeholder="Name" value={contact.name} onChange={(e) => set(i, { name: e.target.value })} />
          <div className="flex gap-2">
            <input className="input h-8 py-1 text-[13px]" placeholder="Title" value={contact.title} onChange={(e) => set(i, { title: e.target.value })} />
            <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
          <input className="input h-8 py-1 text-[13px]" placeholder="Email" value={contact.email} onChange={(e) => set(i, { email: e.target.value })} />
          <input className="input h-8 py-1 text-[13px]" placeholder="Phone" value={contact.phone} onChange={(e) => set(i, { phone: e.target.value })} />
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", title: "", email: "", phone: "" }])}>
        Add a contact
      </Button>
    </div>
  );
}

function MilestonesEditor({ value, onChange }: { value: BrainMilestone[]; onChange: (milestones: BrainMilestone[]) => void }) {
  const set = (i: number, patch: Partial<BrainMilestone>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-2">
      {value.map((milestone, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            className="input h-8 min-w-40 flex-1 py-1 text-[13px]"
            placeholder="Milestone"
            value={milestone.name}
            onChange={(e) => set(i, { name: e.target.value })}
          />
          <input className="input h-8 w-36 py-1 text-[13px]" type="date" value={milestone.due} onChange={(e) => set(i, { due: e.target.value })} />
          <select className="input h-8 w-32 py-1 text-[13px]" value={milestone.status} onChange={(e) => set(i, { status: e.target.value })}>
            {["Planned", "Done", "Moved", "Missed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <ItemTools index={i} count={value.length} onMove={(by) => onChange(move(value, i, by))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", due: "", status: "Planned" }])}>
        Add a milestone
      </Button>
    </div>
  );
}

/** A data set's columns by hand (a table's come from its database, and are described on its page). */
function ColumnsEditor({ value, onChange, existing }: { value: BrainDataColumn[]; onChange: (columns: BrainDataColumn[]) => void; existing: boolean }) {
  if (existing && value.length > 30) {
    return (
      <p className="text-sm text-muted">{value.length} columns. Describe them on the page, in the Columns card: each in business words, or with suggestions.</p>
    );
  }
  const set = (i: number, patch: Partial<BrainDataColumn>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const blank: BrainDataColumn = { name: "", type: "", key: "", comment: "", business_name: "", definition: "", personal: false, example: "" };
  return (
    <div className="space-y-2">
      {value.map((column, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input className="input h-8 py-1 font-mono text-[13px]" placeholder="Column" value={column.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input
            className="input h-8 py-1 text-[13px]"
            placeholder="Business name"
            value={column.business_name}
            onChange={(e) => set(i, { business_name: e.target.value })}
          />
          <ItemTools index={i} count={value.length} onMove={(by) => onChange(move(value, i, by))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
          <input
            className="input h-8 py-1 text-[13px] sm:col-span-2"
            placeholder="What it means"
            value={column.definition}
            onChange={(e) => set(i, { definition: e.target.value })}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={column.personal} onChange={(e) => set(i, { personal: e.target.checked })} /> Personal
          </label>
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, blank])}>
        Add a column
      </Button>
    </div>
  );
}

function MeasuresEditor({ value, onChange }: { value: BrainMeasure[]; onChange: (measures: BrainMeasure[]) => void }) {
  const set = (i: number, patch: Partial<BrainMeasure>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-2">
      {value.map((measure, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-2.5">
          <div className="flex gap-2">
            <input
              className="input h-8 min-w-0 flex-1 py-1 text-[13px]"
              placeholder="Measure"
              value={measure.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <input
              className="input h-8 w-28 py-1 font-mono text-[12px]"
              placeholder="Format"
              value={measure.format}
              onChange={(e) => set(i, { format: e.target.value })}
            />
            <ItemTools
              index={i}
              count={value.length}
              onMove={(by) => onChange(move(value, i, by))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          </div>
          <input
            className="input h-8 py-1 text-[13px]"
            placeholder="What it means"
            value={measure.definition}
            onChange={(e) => set(i, { definition: e.target.value })}
          />
          <textarea
            className="input min-h-12 py-1.5 font-mono text-[12px]"
            placeholder="How it is calculated (DAX, SQL or words)"
            value={measure.formula}
            onChange={(e) => set(i, { formula: e.target.value })}
          />
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", definition: "", formula: "", format: "" }])}>
        Add a measure
      </Button>
    </div>
  );
}

function DimensionsEditor({ value, onChange }: { value: BrainDataDimension[]; onChange: (dimensions: BrainDataDimension[]) => void }) {
  const set = (i: number, patch: Partial<BrainDataDimension>) => onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      {value.map((dimension, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input className="input h-8 py-1 text-[13px]" placeholder="Dimension" value={dimension.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input
            className="input h-8 py-1 text-[13px]"
            placeholder="Levels: Year › Quarter › Month"
            value={dimension.levels}
            onChange={(e) => set(i, { levels: e.target.value })}
          />
          <ItemTools index={i} count={value.length} onMove={(by) => onChange(move(value, i, by))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
          <input
            className="input h-8 py-1 font-mono text-[12px]"
            placeholder="From: dim_customer.country"
            value={dimension.source}
            onChange={(e) => set(i, { source: e.target.value })}
          />
          <input
            className="input h-8 py-1 text-[13px] sm:col-span-2"
            placeholder="What it is"
            value={dimension.description}
            onChange={(e) => set(i, { description: e.target.value })}
          />
        </div>
      ))}
      <Button size="sm" variant="soft" icon={Plus} onClick={() => onChange([...value, { name: "", source: "", levels: "", description: "" }])}>
        Add a dimension
      </Button>
    </div>
  );
}

/** Pictures are added on the page; here they get their captions, or go. */
function ImagesEditor({ value, onChange }: { value: BrainImage[]; onChange: (images: BrainImage[]) => void }) {
  if (!value.length) return <p className="text-sm text-muted">Add pictures on the page, with Add screenshot.</p>;
  return (
    <div className="space-y-2">
      {value.map((image, i) => (
        <div key={image.file ?? i} className="flex gap-2">
          <input
            className="input h-8 min-w-0 flex-1 py-1 text-[13px]"
            placeholder="Caption"
            value={image.caption}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))}
          />
          <ItemTools index={i} count={value.length} onMove={(by) => onChange(move(value, i, by))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  );
}

function FieldInput({ field, value, onChange, existing }: { field: BrainField; value: unknown; onChange: (value: unknown) => void; existing: boolean }) {
  switch (field.type) {
    case "long_text":
      return <textarea className="input min-h-20" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return (
        <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.choices ?? []).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      );
    case "list":
      return (
        <textarea
          className="input min-h-20"
          placeholder="One per line"
          value={Array.isArray(value) ? (value as string[]).join("\n") : String(value ?? "")}
          onChange={(e) => onChange(e.target.value.split("\n"))}
        />
      );
    case "steps":
      return <StepsEditor value={(value as BrainStep[] | null) ?? []} onChange={onChange} />;
    case "apis":
      return <ApisEditor value={(value as BrainApi[] | null) ?? []} onChange={onChange} />;
    case "tables":
      return <TablesEditor value={(value as BrainTable[] | null) ?? []} onChange={onChange} />;
    case "contacts":
      return <ContactsEditor value={(value as BrainContact[] | null) ?? []} onChange={onChange} />;
    case "milestones":
      return <MilestonesEditor value={(value as BrainMilestone[] | null) ?? []} onChange={onChange} />;
    case "columns":
      return <ColumnsEditor value={(value as BrainDataColumn[] | null) ?? []} onChange={onChange} existing={existing} />;
    case "measures":
      return <MeasuresEditor value={(value as BrainMeasure[] | null) ?? []} onChange={onChange} />;
    case "dimensions":
      return <DimensionsEditor value={(value as BrainDataDimension[] | null) ?? []} onChange={onChange} />;
    case "images":
      return <ImagesEditor value={(value as BrainImage[] | null) ?? []} onChange={onChange} />;
    default: {
      const type =
        field.type === "date"
          ? "date"
          : ["number", "money", "percent"].includes(field.type)
            ? "number"
            : field.type === "email"
              ? "email"
              : field.type === "url"
                ? "url"
                : "text";
      return (
        <input className="input" type={type} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
      );
    }
  }
}

/** Drops empty rows of lists, steps and the like before saving. */
function cleaned(field: BrainField, value: unknown): unknown {
  if (value === "" || value === undefined) return null;
  switch (field.type) {
    case "list":
      return (value as string[]).map((s) => s.trim()).filter(Boolean);
    case "steps":
      return (value as BrainStep[]).filter((s) => s.name.trim());
    case "apis":
      return (value as BrainApi[]).filter((a) => a.name.trim()).map((a) => ({ ...a, endpoints: a.endpoints.map((e) => e.trim()).filter(Boolean) }));
    case "tables":
      return (value as BrainTable[]).filter((t) => t.name.trim()).map((t) => ({ ...t, columns: t.columns.filter((c) => c.name) }));
    case "contacts":
      return (value as BrainContact[]).filter((c) => c.name.trim());
    case "milestones":
      return (value as BrainMilestone[]).filter((m) => m.name.trim());
    case "columns":
      return (value as BrainDataColumn[]).filter((c) => c.name.trim());
    case "measures":
      return (value as BrainMeasure[]).filter((m) => m.name.trim());
    case "dimensions":
      return (value as BrainDataDimension[]).filter((d) => d.name.trim());
    case "images":
      return (value as BrainImage[]).filter((i) => i.file || i.src);
    default:
      return value;
  }
}

/**
 * Add or change a thing of the brain by hand. Values written here are kept over what the sources
 * bring: the next sync doesn't overwrite them.
 */
export function EntityForm({ open, onClose, kind: initialKind, entity }: { open: boolean; onClose: () => void; kind?: string; entity?: BrainEntity }) {
  const { data: model } = useBrainModel();
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [kindKey, setKindKey] = useState(entity?.kind ?? initialKind ?? "");
  const [name, setName] = useState(entity?.name ?? "");
  const [summary, setSummary] = useState(entity?.summary ?? "");
  const [aliases, setAliases] = useState((entity?.aliases ?? []).join(", "));
  const [values, setValues] = useState<Values>(entity?.data ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind: BrainKind | undefined = model?.kinds.find((k) => k.key === kindKey);

  const save = async () => {
    if (!kind) return;
    setSaving(true);
    setError(null);
    const data: Values = {};
    for (const field of kind.fields) {
      if (field.hidden) continue;
      if (entity || values[field.key] !== undefined) data[field.key] = cleaned(field, values[field.key]);
    }
    const body = {
      name: name.trim(),
      summary: summary.trim(),
      aliases: aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      data,
    };
    try {
      const saved = entity
        ? await api.patch<BrainEntity>(path(`/brain/entities/${entity.id}`), body)
        : await api.post<BrainEntity>(path("/brain/entities"), { kind: kind.key, ...body });
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      toast.success(entity ? `Saved ${saved.name}` : `Added ${saved.name}`);
      onClose();
      if (!entity) navigate(brainPath(saved.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={entity ? `Change ${entity.name}` : kind ? `Add ${lowerName(kind.name)}` : "Add to the brain"}
      description={entity ? "What you write here is kept: the sources don't overwrite it." : kind?.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!kind || !name.trim()}>
            {entity ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!entity && (
          <Row label="What is it?">
            <select className="input" value={kindKey} onChange={(e) => setKindKey(e.target.value)}>
              <option value="">Choose…</option>
              {model?.dimensions.map((d) => (
                <optgroup key={d.key} label={d.name}>
                  {model.kinds
                    .filter((k) => k.dimension === d.key && k.key !== "ai_employee")
                    .map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Row>
        )}
        {kind && (
          <>
            <Row label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!entity} />
            </Row>
            <Row label={kind.key === "term" ? "What it means" : kind.key === "knowhow" ? "The know-how, in a sentence" : "In a sentence or two"}>
              <textarea className="input min-h-16" value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Row>
            <Row label="Other names" hint="Separated by commas: short names and abbreviations people use. The brain finds it by these in messages too.">
              <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </Row>
            {kind.fields
              .filter((f) => !f.hidden)
              .map((field) => (
                <Row key={field.key} label={field.label} hint={field.hint}>
                  <FieldInput
                    field={field}
                    value={values[field.key]}
                    existing={Boolean(entity)}
                    onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
                  />
                </Row>
              ))}
          </>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-300">{error}</p>}
      </div>
    </Drawer>
  );
}
