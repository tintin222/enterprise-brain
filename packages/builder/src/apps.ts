import {
  AppDesign,
  FIELD_TYPES,
  TableDesign,
  tableKeyOf,
  type AppBlock,
  type AppPage,
  type JsonSchema,
  type RecordAction,
  type TableField,
  type TableFieldType,
} from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";
import { capitalize, nameOf, settle, splitList, TURKISH, wordsDraft } from "./tables.ts";

/**
 * The Studio's app designer: from "supplier complaints: log a complaint, see the open ones by supplier,
 * close them" to an app's pages and blocks, and the table it needs when the company has none for it.
 * With the model it understands any wording; without it, it reads what to do (the verbs) and what to
 * keep (the rest) from the words.
 */

/** A table an app can show: one of the company's, or one the proposal makes. */
export interface AppTable {
  key: string;
  name: string;
  fields: TableField[];
  titleField?: string;
}

/** An AI employee an app's buttons can give work to. */
export interface AppAgent {
  slug: string;
  name: string;
  summary?: string;
}

export interface AppProposal {
  design: AppDesign;
  /** Tables to make first, for the app (none when the company's tables serve it). */
  tables: TableDesign[];
  /** What it understood or assumed, for the person to check. */
  notes: string[];
  drafted: "model" | "words";
}

export async function proposeApp(llm: LlmClient, input: { description: string; tables?: AppTable[]; agents?: AppAgent[] }): Promise<AppProposal> {
  const description = input.description.trim();
  if (!description) throw new Error("Say what the app is for");
  const tables = input.tables ?? [];
  const agents = input.agents ?? [];
  if (llm.available) {
    const drafted = await modelApp(llm, description, tables, agents).catch(() => undefined);
    if (drafted) return drafted;
  }
  return wordsApp(description, tables);
}

// ---------------------------------------------------------------------------
// Both ways: blocks made valid against their tables
// ---------------------------------------------------------------------------

/** Field keys from keys or labels, for one table; unknown ones are dropped and noted. */
function fieldResolver(tables: AppTable[], notes: string[]) {
  const byKey = new Map(tables.map((t) => [t.key, t]));
  return {
    table(ref: string): AppTable | undefined {
      const text = ref.trim().toLowerCase();
      return byKey.get(ref) ?? tables.find((t) => t.name.toLowerCase() === text || t.key === tableKeyOf(ref));
    },
    field(table: AppTable, ref: string | undefined): TableField | undefined {
      if (!ref?.trim()) return undefined;
      const text = ref.trim().toLowerCase();
      const found = table.fields.find((f) => f.key === ref || f.label.toLowerCase() === text || f.key === tableKeyOf(ref));
      if (!found) notes.push(`${table.name} has no field "${ref}"; it was left out.`);
      return found;
    },
  };
}

/** A value for a field as the table keeps it: a choice in its listed spelling. */
function valueFor(field: TableField, value: string): string | number | boolean {
  if (field.type === "choice") return field.choices?.find((c) => c.toLowerCase() === value.trim().toLowerCase()) ?? value.trim();
  if (field.type === "yes_no") return /^(yes|true|evet|1)$/i.test(value.trim());
  if (field.type === "number" || field.type === "money") return Number(value) || 0;
  return value.trim();
}

/** Page keys from titles, unique. */
function withKeys(pages: Omit<AppPage, "key">[]): AppPage[] {
  const used = new Set<string>();
  return pages.map((page) => {
    let key = tableKeyOf(page.title).slice(0, 40);
    for (let n = 2; used.has(key); n++) key = `${tableKeyOf(page.title).slice(0, 40)}_${n}`;
    used.add(key);
    return { ...page, key };
  });
}

const ICONS: [RegExp, string][] = [
  [/complain|şikayet|issue|problem|defect|incident|hata|arıza/i, "triangle-alert"],
  [/supplier|tedarik|delivery|shipment|sevkiyat/i, "truck"],
  [/visitor|ziyaret|guest/i, "users"],
  [/training|eğitim|course/i, "graduation-cap"],
  [/maintenance|bakım|repair|onarım/i, "wrench"],
  [/order|sipariş|purchase/i, "package"],
  [/invoice|fatura|expense|masraf|budget/i, "receipt"],
  [/request|talep|ticket/i, "inbox"],
  [/leave|izin|vacation/i, "calendar"],
];

function iconOf(text: string): string {
  return ICONS.find(([pattern]) => pattern.test(text))?.[1] ?? "layout-grid";
}

// ---------------------------------------------------------------------------
// With the model
// ---------------------------------------------------------------------------

const SYSTEM = `You design small business apps from a person's description (English or Turkish). An app is pages of blocks on tables; the platform draws it, so you only choose the blocks:
- form: adds a record (fields: the ones asked; all when empty).
- list: records (fields shown, a filter such as Status = Open, sorted, grouped by a field, a search box) with actions on each record: set fields ("Close" sets Status to Closed) or give the record to an AI employee as work (agent + ask, with {field} from the record).
- board: records in columns by a choice field (moving a card changes it).
- chart: records counted (or a number field summed or averaged) by a field; a date field groups by month.
- number: one figure (how many open complaints).
- button: gives an AI employee work (agent + ask).
- text: a short explanation.

Use the company's existing tables when they fit (by key). When none fits, design the table in newTables and use its name as the table of the blocks. Field kinds: ${FIELD_TYPES.join(", ")}; a status is a choice starting as its first value. Put things where people look for them: a page to add, a page to work the open ones, an overview. 2 to 5 pages, few blocks each, plain titles in the person's language. Only name AI employees from the list. notes: 1 to 4 short sentences on what you assumed.`;

interface ModelBlock {
  type: AppBlock["type"];
  title: string;
  table: string;
  fields: string[];
  filter: { field: string; value: string }[];
  sortField: string;
  sortDirection: "asc" | "desc" | "";
  groupBy: string;
  measure: "count" | "sum" | "average";
  measureField: string;
  chartKind: "bar" | "pie" | "";
  search: boolean;
  agent: string;
  ask: string;
  text: string;
  actions: { label: string; setField: string; setValue: string; agent: string; ask: string }[];
}

interface ModelField {
  label: string;
  type: TableFieldType;
  required: boolean;
  choices: string[];
  startsAs: string;
  currency: string;
  linksTo: string;
}

async function modelApp(llm: LlmClient, description: string, tables: AppTable[], agents: AppAgent[]): Promise<AppProposal | undefined> {
  const str = { type: "string" };
  const field: JsonSchema = {
    type: "object",
    properties: {
      label: str,
      type: { type: "string", enum: [...FIELD_TYPES] },
      required: { type: "boolean" },
      choices: { type: "array", items: str },
      startsAs: str,
      currency: str,
      linksTo: { type: "string", description: "For link: an existing table's key; else empty" },
    },
    required: ["label", "type", "required", "choices", "startsAs", "currency", "linksTo"],
    additionalProperties: false,
  };
  const action: JsonSchema = {
    type: "object",
    properties: { label: str, setField: str, setValue: str, agent: str, ask: str },
    required: ["label", "setField", "setValue", "agent", "ask"],
    additionalProperties: false,
  };
  const block: JsonSchema = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["form", "list", "board", "chart", "number", "button", "text"] },
      title: str,
      table: { type: "string", description: "An existing table's key, or a new table's name; empty for button and text" },
      fields: { type: "array", items: str },
      filter: { type: "array", items: { type: "object", properties: { field: str, value: str }, required: ["field", "value"], additionalProperties: false } },
      sortField: str,
      sortDirection: { type: "string", enum: ["asc", "desc", ""] },
      groupBy: str,
      measure: { type: "string", enum: ["count", "sum", "average"] },
      measureField: str,
      chartKind: { type: "string", enum: ["bar", "pie", ""] },
      search: { type: "boolean" },
      agent: { type: "string", description: "An AI employee's slug, or empty" },
      ask: str,
      text: str,
      actions: { type: "array", items: action },
    },
    required: [
      "type",
      "title",
      "table",
      "fields",
      "filter",
      "sortField",
      "sortDirection",
      "groupBy",
      "measure",
      "measureField",
      "chartKind",
      "search",
      "agent",
      "ask",
      "text",
      "actions",
    ],
    additionalProperties: false,
  };
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: str,
      description: str,
      newTables: {
        type: "array",
        items: {
          type: "object",
          properties: { name: str, description: str, titleField: str, fields: { type: "array", items: field } },
          required: ["name", "description", "titleField", "fields"],
          additionalProperties: false,
        },
      },
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: { title: str, blocks: { type: "array", items: block } },
          required: ["title", "blocks"],
          additionalProperties: false,
        },
      },
      notes: { type: "array", items: str },
    },
    required: ["name", "description", "newTables", "pages", "notes"],
    additionalProperties: false,
  };
  const { data } = await llm.structured<{
    name: string;
    description: string;
    newTables: { name: string; description: string; titleField: string; fields: ModelField[] }[];
    pages: { title: string; blocks: ModelBlock[] }[];
    notes: string[];
  }>({
    purpose: "studio.app",
    system: SYSTEM,
    effort: "medium",
    schema,
    messages: [
      {
        role: "user",
        content: [
          `What the person needs: ${description}`,
          tables.length
            ? `The company's tables:\n${tables.map((t) => `- ${t.key} (${t.name}): ${t.fields.map((f) => `${f.label} [${f.key}, ${f.type}${f.choices?.length ? `: ${f.choices.join("/")}` : ""}]`).join("; ")}`).join("\n")}`
            : "The company has no tables yet.",
          agents.length
            ? `AI employees: ${agents.map((a) => `${a.slug} (${a.name}${a.summary ? `: ${a.summary}` : ""})`).join("; ")}`
            : "No AI employees to give work to.",
        ].join("\n\n"),
      },
    ],
  });
  if (!data?.pages?.length) return undefined;
  const notes = [...(data.notes ?? [])];
  // New tables first: the blocks may name them.
  const taken = new Set(tables.map((t) => t.key));
  const made: TableDesign[] = [];
  for (const draft of data.newTables ?? []) {
    let key = tableKeyOf(draft.name);
    for (let n = 2; taken.has(key); n++) key = `${tableKeyOf(draft.name)}_${n}`;
    taken.add(key);
    const fields = settle(
      draft.fields.map((f) => ({
        label: f.label,
        type: f.type,
        ...(f.required ? { required: true } : {}),
        ...(f.choices.length ? { choices: f.choices } : {}),
        ...(f.startsAs.trim() ? { default: f.startsAs.trim() } : {}),
        ...(/^[A-Za-z]{3}$/.test(f.currency.trim()) ? { currency: f.currency.trim().toUpperCase() } : {}),
        ...(f.linksTo.trim() ? { table: f.linksTo.trim() } : {}),
      })),
      tables.map((t) => ({ key: t.key, name: t.name })),
      notes,
    );
    const title = fields.find((f) => f.label.toLowerCase() === draft.titleField.trim().toLowerCase());
    made.push(TableDesign.parse({ key, name: draft.name, description: draft.description, fields, ...(title ? { titleField: title.key } : {}) }));
  }
  const all: AppTable[] = [
    ...tables,
    ...made.map((t) => ({ key: t.key, name: t.name, fields: t.fields, ...(t.titleField ? { titleField: t.titleField } : {}) })),
  ];
  const resolve = fieldResolver(all, notes);
  const slugs = new Set(agents.map((a) => a.slug));
  const pages: Omit<AppPage, "key">[] = [];
  for (const page of data.pages) {
    const blocks: AppBlock[] = [];
    for (const raw of page.blocks) {
      const title = raw.title.trim() || undefined;
      if (raw.type === "text") {
        if (raw.text.trim()) blocks.push({ type: "text", ...(title ? { title } : {}), text: raw.text.trim() });
        continue;
      }
      if (raw.type === "button") {
        if (slugs.has(raw.agent) && raw.ask.trim()) blocks.push({ type: "button", title: title ?? "Ask", agent: raw.agent, ask: raw.ask.trim() });
        else notes.push(`The button "${raw.title}" was left out: it named no AI employee of the company.`);
        continue;
      }
      const table = resolve.table(raw.table);
      if (!table) {
        notes.push(`"${raw.title || raw.type}" was left out: there is no table "${raw.table}".`);
        continue;
      }
      const keys = (refs: string[]) => refs.map((r) => resolve.field(table, r)?.key).filter((k): k is string => Boolean(k));
      const filter = Object.fromEntries(
        raw.filter.flatMap((f) => {
          const target = resolve.field(table, f.field);
          return target && f.value.trim() ? [[target.key, valueFor(target, f.value)]] : [];
        }),
      );
      const actions = raw.actions.flatMap((a): RecordAction[] => {
        if (a.agent.trim()) return slugs.has(a.agent) && a.ask.trim() ? [{ label: a.label, agent: a.agent, ask: a.ask.trim() }] : [];
        const target = resolve.field(table, a.setField);
        return target ? [{ label: a.label, set: { [target.key]: valueFor(target, a.setValue) } }] : [];
      });
      const common = { ...(title ? { title } : {}), table: table.key };
      const filterPart = Object.keys(filter).length ? { filter } : {};
      const measure =
        raw.measure === "count"
          ? { of: "count" as const }
          : { of: raw.measure, ...(resolve.field(table, raw.measureField) ? { field: resolve.field(table, raw.measureField)!.key } : {}) };
      switch (raw.type) {
        case "form":
          blocks.push({ type: "form", ...common, ...(keys(raw.fields).length ? { fields: keys(raw.fields) } : {}) });
          break;
        case "list": {
          const sort = resolve.field(table, raw.sortField);
          const group = resolve.field(table, raw.groupBy);
          blocks.push({
            type: "list",
            ...common,
            ...(keys(raw.fields).length ? { fields: keys(raw.fields) } : {}),
            ...filterPart,
            ...(sort ? { sort: { field: sort.key, direction: raw.sortDirection === "desc" ? "desc" : "asc" } } : {}),
            ...(group ? { groupBy: group.key } : {}),
            ...(raw.search ? { search: true } : {}),
            ...(actions.length ? { actions } : {}),
          });
          break;
        }
        case "board": {
          const group = resolve.field(table, raw.groupBy) ?? table.fields.find((f) => f.type === "choice");
          if (group?.type !== "choice") {
            notes.push(`"${raw.title || "Board"}" was left out: ${table.name} has nothing to make columns of.`);
            break;
          }
          blocks.push({
            type: "board",
            ...common,
            groupBy: group.key,
            ...(keys(raw.fields).length ? { fields: keys(raw.fields).slice(0, 6) } : {}),
            ...filterPart,
            ...(actions.length ? { actions } : {}),
          });
          break;
        }
        case "chart": {
          const group = resolve.field(table, raw.groupBy);
          if (!group) break;
          blocks.push({ type: "chart", ...common, groupBy: group.key, measure, kind: raw.chartKind === "pie" ? "pie" : "bar", ...filterPart });
          break;
        }
        case "number":
          blocks.push({ type: "number", title: title ?? `${table.name}`, table: table.key, measure, ...filterPart });
          break;
      }
    }
    if (blocks.length && page.title.trim()) pages.push({ title: page.title.trim().slice(0, 60), blocks });
  }
  if (!pages.length) return undefined;
  const name = data.name.trim() || nameOf(description);
  return {
    design: AppDesign.parse({
      key: tableKeyOf(name),
      name,
      description: data.description.trim(),
      icon: iconOf(`${name} ${description}`),
      pages: withKeys(pages).slice(0, 8),
    }),
    tables: made,
    notes,
    drafted: "model",
  };
}

// ---------------------------------------------------------------------------
// From the words alone
// ---------------------------------------------------------------------------

const ADD = /^(?:please\s+)?(log|add|record|report|file|enter|register|submit|capture|create|kaydet|ekle|gir|bildir)\b/i;
const SEE = /^(?:please\s+)?(see|list|show|view|find|look|browse|follow|track|gör|listele|göster|izle|takip)\b/i;
const CLOSE = /^(?:please\s+)?(close|resolve|finish|complete|approve|reject|mark|kapat|çöz|tamamla|onayla|reddet)\b/i;
const BOARD = /\b(board|kanban|pipeline|stages?|columns?|pano)\b/i;
const OVERVIEW = /\b(chart|overview|summary|dashboard|how many|count|report|trend|per month|by month|grafik|özet|rapor)\b/i;
const VERB = new RegExp(`${ADD.source}|${SEE.source}|${CLOSE.source}|${BOARD.source}|${OVERVIEW.source}`, "i");

/** What closing means for a status: Closed, Resolved, Done… in the list's own words. */
const CLOSING: [RegExp, RegExp][] = [
  [/^(close|kapat)/i, /^(closed|kapalı|kapandı|done|resolved|tamamlandı)$/i],
  [/^(resolve|çöz)/i, /^(resolved|çözüldü|closed|kapalı|done)$/i],
  [/^(finish|complete|tamamla)/i, /^(done|completed|finished|tamamlandı|closed|kapalı)$/i],
  [/^(approve|onayla)/i, /^(approved|onaylandı)$/i],
  [/^(reject|reddet)/i, /^(rejected|reddedildi)$/i],
];
const OPEN = /\b(open|açık|new|yeni|waiting|bekleyen|in progress|işlemde)\b/i;

function wordsApp(description: string, tables: AppTable[]): AppProposal {
  const turkish = TURKISH.test(description);
  const notes: string[] = [];
  const text = description.replace(/\s+/g, " ").trim();
  // "Supplier complaints: supplier, order number, …, log a complaint, see the open ones by supplier, close them"
  const colon = text.indexOf(":");
  const head = colon > 0 ? text.slice(0, colon) : "";
  const items = splitList(colon > 0 ? text.slice(colon + 1) : text);
  // Details come from a list ("supplier, order number, problem"), not from a lone sentence.
  const listy = colon > 0 || items.length > 1;
  const intents: string[] = [];
  const details: string[] = [];
  for (const item of items) {
    if (!VERB.test(item)) {
      if (listy) details.push(item);
      continue;
    }
    // "log a complaint with supplier" is a thing to do, and a detail to keep.
    const withAt = / with (.+)$/i.exec(item);
    intents.push(withAt ? item.slice(0, withAt.index) : item);
    if (withAt) details.push(withAt[1]!);
  }

  // The table: the company's own when the description names it, else a new one from the details.
  const named = tables.find((t) => text.toLowerCase().includes(t.name.toLowerCase()));
  const logged = intents.find((i) => ADD.test(i));
  const subject =
    head ||
    (logged
      ? pluralOf(
          logged
            .replace(ADD, "")
            .replace(/^\s*(a|an|the|new|bir)\s+/i, "")
            .trim(),
        )
      : listy
        ? ""
        : text);
  const name = (named && !details.length && !head ? named.name : nameOf(subject, turkish)) || (turkish ? "Uygulama" : "App");
  const made: TableDesign[] = [];
  let table: AppTable;
  if (named && !details.length) {
    table = named;
    notes.push(`It works on your table ${named.name}.`);
  } else {
    const drafted = wordsDraft(details.length ? `${name}: ${details.join(", ")}` : name, tables);
    notes.push(...drafted.notes);
    let design = drafted.design;
    let key = design.key;
    for (let n = 2; tables.some((t) => t.key === key); n++) key = `${drafted.design.key}_${n}`;
    design = { ...design, key };
    // Seeing the open ones and closing them needs a status.
    const wantsStatus = intents.some((i) => CLOSE.test(i) || OPEN.test(i)) || BOARD.test(text);
    if (wantsStatus && !design.fields.some((f) => f.type === "choice")) {
      const values = turkish ? ["Açık", "İşlemde", "Kapalı"] : ["Open", "In progress", "Closed"];
      design = TableDesign.parse({
        ...design,
        fields: [
          ...design.fields,
          { key: turkish ? "durum" : "status", label: turkish ? "Durum" : "Status", type: "choice", choices: values, default: values[0] },
        ],
      });
      notes.push(
        turkish
          ? `Açık ve kapalı olanlar için Durum eklendi (${values.join(", ")}).`
          : `Status was added (${values.join(", ")}) so open ones can be seen and closed.`,
      );
    }
    made.push(design);
    table = { key: design.key, name: design.name, fields: design.fields, ...(design.titleField ? { titleField: design.titleField } : {}) };
  }

  const status = table.fields.find((f) => f.type === "choice");
  const groupable = (words: string) => {
    const by = / by (?:the )?([\p{L}\s]+?)(?:$|,| and )/iu.exec(words)?.[1]?.trim().toLowerCase();
    if (!by) return undefined;
    return table.fields.find((f) => f.label.toLowerCase() === by || f.label.toLowerCase().startsWith(by) || by.startsWith(f.label.toLowerCase()));
  };
  const closeActions: RecordAction[] = [];
  for (const intent of intents.filter((i) => CLOSE.test(i))) {
    const verb = CLOSE.exec(intent)![1]!;
    const target = CLOSING.find(([v]) => v.test(verb))?.[1];
    const value =
      status?.choices?.find((c) => target?.test(c)) ??
      (/as (\p{L}+)/iu.exec(intent) ? status?.choices?.find((c) => c.toLowerCase() === /as (\p{L}+)/iu.exec(intent)![1]!.toLowerCase()) : undefined);
    if (status && value) closeActions.push({ label: capitalize(verb.toLowerCase(), turkish), set: { [status.key]: value }, confirm: true });
    else notes.push(`"${intent}" needs a status to change; add one to use it.`);
  }
  const openValue = (words: string) => (OPEN.test(words) ? status?.choices?.find((c) => new RegExp(`^${OPEN.exec(words)![1]}$`, "i").test(c)) : undefined);

  const pages: Omit<AppPage, "key">[] = [];
  const shownFields = table.fields
    .filter((f) => f.type !== "long_text" && f.type !== "file")
    .slice(0, 6)
    .map((f) => f.key);
  for (const intent of intents) {
    if (ADD.test(intent)) {
      pages.push({ title: capitalize(intent, turkish).slice(0, 60), blocks: [{ type: "form", table: table.key }] });
    } else if (SEE.test(intent)) {
      const value = openValue(intent);
      const group = groupable(intent);
      pages.push({
        title: capitalize(
          intent
            .replace(SEE, "")
            .replace(/^\s*(the|all)\s+/i, "")
            .trim() || table.name,
          turkish,
        ).slice(0, 60),
        blocks: [
          {
            type: "list",
            table: table.key,
            fields: shownFields,
            ...(value && status ? { filter: { [status.key]: value } } : {}),
            ...(group ? { groupBy: group.key } : {}),
            search: true,
            ...(closeActions.length ? { actions: closeActions } : {}),
          },
        ],
      });
    } else if (BOARD.test(intent) && status) {
      pages.push({
        title: capitalize(intent, turkish).slice(0, 60),
        blocks: [
          { type: "board", table: table.key, groupBy: status.key, fields: shownFields.slice(0, 3), ...(closeActions.length ? { actions: closeActions } : {}) },
        ],
      });
    } else if (OVERVIEW.test(intent)) {
      pages.push({ title: capitalize(intent, turkish).slice(0, 60), blocks: overview(table, intent) });
    }
  }
  if (!pages.length) {
    // Nothing said about the screens: a page to add, the list to work, a board, an overview.
    pages.push({ title: turkish ? "Ekle" : "Add", blocks: [{ type: "form", table: table.key }] });
    pages.push({
      title: turkish ? "Tümü" : `All ${table.name.toLowerCase()}`,
      blocks: [{ type: "list", table: table.key, fields: shownFields, search: true, ...(closeActions.length ? { actions: closeActions } : {}) }],
    });
    if (status)
      pages.push({ title: turkish ? "Pano" : "Board", blocks: [{ type: "board", table: table.key, groupBy: status.key, fields: shownFields.slice(0, 3) }] });
    pages.push({ title: turkish ? "Özet" : "Overview", blocks: overview(table, text) });
  } else if (!pages.some((p) => p.blocks.some((b) => b.type === "list" || b.type === "board"))) {
    // Closing or finding needs a list.
    pages.push({
      title: turkish ? "Tümü" : `All ${table.name.toLowerCase()}`,
      blocks: [{ type: "list", table: table.key, fields: shownFields, search: true, ...(closeActions.length ? { actions: closeActions } : {}) }],
    });
  }
  return {
    design: AppDesign.parse({ key: tableKeyOf(name), name, description: "", icon: iconOf(text), pages: withKeys(pages) }),
    tables: made,
    notes,
    drafted: "words",
  };
}

/** "complaint" → "complaints" (English; other words stay as they are). */
function pluralOf(word: string): string {
  if (!/^[a-z ]+$/i.test(word) || /s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return /(x|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

/** How many there are, how many are open, and a chart by what matters (a status, a supplier, a month). */
function overview(table: AppTable, words: string): AppBlock[] {
  const status = table.fields.find((f) => f.type === "choice");
  const by = table.fields.find((f) => f.type === "link") ?? table.fields.find((f) => f.type === "person");
  const date = table.fields.find((f) => f.type === "date");
  const blocks: AppBlock[] = [{ type: "number", title: `All ${table.name.toLowerCase()}`, table: table.key, measure: { of: "count" } }];
  if (status?.choices?.[0])
    blocks.push({ type: "number", title: status.choices[0], table: table.key, measure: { of: "count" }, filter: { [status.key]: status.choices[0] } });
  if (status)
    blocks.push({ type: "chart", title: `By ${status.label.toLowerCase()}`, table: table.key, groupBy: status.key, measure: { of: "count" }, kind: "pie" });
  if (by)
    blocks.push({ type: "chart", title: `By ${by.label.toLowerCase()}`, table: table.key, groupBy: by.key, measure: { of: "count" }, kind: "bar", limit: 10 });
  if (date && (/month|ay\b/i.test(words) || !by))
    blocks.push({ type: "chart", title: `By month (${date.label.toLowerCase()})`, table: table.key, groupBy: date.key, measure: { of: "count" }, kind: "bar" });
  return blocks;
}
