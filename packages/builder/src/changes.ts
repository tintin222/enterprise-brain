import {
  AppDesign,
  describeBlock,
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  TableDesign,
  tableKeyOf,
  type AppBlock,
  type AppPage,
  type JsonSchema,
  type TableField,
  type TableFieldType,
} from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";
import { modelBlockSchema, pagesFromModel, type AppAgent, type AppTable, type ModelBlock } from "./apps.ts";
import { writeCalculation, type CalculationDraft, type CalculationProposal, type CalculationTable, type TrialOutcome } from "./calculations.ts";
import { fieldFromLabel, settle, splitList, TURKISH, type ExistingTable } from "./tables.ts";

/**
 * Changes in plain words: "add a field for the root cause and make Owner required", "add a chart of
 * complaints by month", "count per 1000 deliveries". The Studio turns the request into the changed
 * design and says what changes in plain words; the platform tests it before it goes live (a table's
 * records must fit, a calculation is worked out again on the real rows).
 */

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** A choice value renamed in every record: { field key: { old value: new value } }. */
export type ValueRenames = Record<string, Record<string, string>>;

export interface TableChange {
  design: TableDesign;
  renames: ValueRenames;
  /** What changes, in plain words. */
  summary: string[];
  /** What wasn't understood or was left out. */
  notes: string[];
  drafted: "model" | "words";
}

const quoted = (value: unknown) => `“${String(value)}”`;

/** What changes between two designs of a table, in plain words. */
export function describeTableChanges(before: TableDesign, after: TableDesign, renames: ValueRenames = {}): string[] {
  const lines: string[] = [];
  if (before.name !== after.name) lines.push(`Renames the table to ${quoted(after.name)}`);
  const old = new Map(before.fields.map((f) => [f.key, f]));
  const kept = new Set(after.fields.map((f) => f.key));
  for (const field of after.fields) {
    const was = old.get(field.key);
    if (!was) {
      lines.push(
        `Adds ${field.label} (${FIELD_TYPE_LABELS[field.type]}${field.required ? ", needed" : ""}${field.choices?.length ? `: ${field.choices.join(", ")}` : ""})`,
      );
      continue;
    }
    if (was.label !== field.label) lines.push(`Renames ${was.label} to ${field.label}`);
    if (was.type !== field.type) lines.push(`${field.label} becomes ${FIELD_TYPE_LABELS[field.type]}`);
    if (Boolean(was.required) !== Boolean(field.required)) lines.push(field.required ? `${field.label} is needed now` : `${field.label} is no longer needed`);
    const renamed = renames[field.key] ?? {};
    for (const [from, to] of Object.entries(renamed)) lines.push(`${field.label}: ${quoted(from)} becomes ${quoted(to)} in every record`);
    const added = (field.choices ?? []).filter((c) => !(was.choices ?? []).includes(c) && !Object.values(renamed).includes(c));
    const removed = (was.choices ?? []).filter((c) => !(field.choices ?? []).includes(c) && !(c in renamed));
    if (added.length) lines.push(`${field.label} can also be ${added.map(quoted).join(", ")}`);
    if (removed.length) lines.push(`${field.label} can no longer be ${removed.map(quoted).join(", ")}`);
    if (was.default !== field.default)
      lines.push(field.default === undefined ? `${field.label} starts empty` : `${field.label} starts as ${quoted(field.default)}`);
    if (was.table !== field.table && field.table) lines.push(`${field.label} points at another table`);
  }
  for (const field of before.fields) if (!kept.has(field.key)) lines.push(`Takes away ${field.label} (its values stay out of sight)`);
  if (before.titleField !== after.titleField && after.titleField) {
    lines.push(`A record is called by its ${after.fields.find((f) => f.key === after.titleField)?.label ?? after.titleField}`);
  }
  return lines;
}

export async function changeTable(llm: LlmClient, input: { design: TableDesign; request: string; existing?: ExistingTable[] }): Promise<TableChange> {
  const request = input.request.trim();
  if (!request) throw new Error("Say what to change");
  if (llm.available) {
    const drafted = await modelTableChange(llm, input.design, request, input.existing ?? []).catch(() => undefined);
    if (drafted) return drafted;
  }
  return wordsTableChange(input.design, request, input.existing ?? []);
}

async function modelTableChange(llm: LlmClient, design: TableDesign, request: string, existing: ExistingTable[]): Promise<TableChange | undefined> {
  const field: JsonSchema = {
    type: "object",
    properties: {
      key: { type: "string", description: "The field's key when it is one of the table's fields (also when relabelled); empty for a new field" },
      label: { type: "string" },
      type: { type: "string", enum: [...FIELD_TYPES] },
      required: { type: "boolean" },
      choices: { type: "array", items: { type: "string" } },
      startsAs: { type: "string" },
      currency: { type: "string" },
      linksTo: { type: "string" },
      personal: { type: "boolean" },
    },
    required: ["key", "label", "type", "required", "choices", "startsAs", "currency", "linksTo", "personal"],
    additionalProperties: false,
  };
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      fields: { type: "array", items: field },
      renames: {
        type: "array",
        description: "Choice values renamed in every record",
        items: {
          type: "object",
          properties: { field: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
          required: ["field", "from", "to"],
          additionalProperties: false,
        },
      },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["name", "fields", "renames", "notes"],
    additionalProperties: false,
  };
  const { data } = await llm.structured<{
    name: string;
    fields: {
      key: string;
      label: string;
      type: TableFieldType;
      required: boolean;
      choices: string[];
      startsAs: string;
      currency: string;
      linksTo: string;
      personal: boolean;
    }[];
    renames: { field: string; from: string; to: string }[];
    notes: string[];
  }>({
    purpose: "studio.table-change",
    system:
      "You change a business table as its owner asks, in plain words. Return the whole table after the change: keep every field that isn't removed, with its key; new fields have an empty key. Change only what was asked. A renamed choice value goes in renames, so records follow.",
    effort: "low",
    schema,
    messages: [
      {
        role: "user",
        content: `The table:\n${JSON.stringify(design, null, 1)}\n\nThe company's tables: ${existing.map((t) => `${t.key} (${t.name})`).join(", ") || "none"}\n\nWhat to change: ${request}`,
      },
    ],
  });
  if (!data?.fields?.length) return undefined;
  const notes = [...(data.notes ?? [])];
  const known = new Set(design.fields.map((f) => f.key));
  const kept = data.fields.filter((f) => known.has(f.key));
  const fresh = settle(
    data.fields
      .filter((f) => !known.has(f.key))
      .map((f) => ({
        label: f.label,
        type: f.type,
        ...(f.required ? { required: true } : {}),
        ...(f.choices.length ? { choices: f.choices } : {}),
        ...(f.startsAs.trim() ? { default: f.startsAs.trim() } : {}),
        ...(/^[A-Za-z]{3}$/.test(f.currency.trim()) ? { currency: f.currency.trim().toUpperCase() } : {}),
        ...(f.linksTo.trim() ? { table: f.linksTo.trim() } : {}),
        ...(f.personal ? { personal: true } : {}),
      })),
    existing,
    notes,
  ).map((f) => ({ ...f, key: uniqueKey(f.key, known) }));
  const byKey = new Map(fresh.map((f) => [f.label, f]));
  const fields: TableField[] = data.fields.flatMap((f): TableField[] => {
    if (!known.has(f.key)) return byKey.get(f.label.trim()) ? [byKey.get(f.label.trim())!] : [];
    const before = design.fields.find((x) => x.key === f.key)!;
    return [
      {
        ...before,
        label: f.label.trim() || before.label,
        type: f.type,
        required: f.required || undefined,
        ...(f.type === "choice" ? { choices: f.choices.length ? f.choices : before.choices } : {}),
        ...(f.startsAs.trim() ? { default: f.startsAs.trim() } : { default: undefined }),
      },
    ];
  });
  for (const f of fields) {
    if (f.type !== "choice") delete f.choices;
    if (f.default === undefined) delete f.default;
    if (f.required === undefined) delete f.required;
  }
  const renames: ValueRenames = {};
  for (const r of data.renames ?? []) if (known.has(r.field) && r.from !== r.to) (renames[r.field] ??= {})[r.from] = r.to;
  if (!kept.length && !fresh.length) return undefined;
  const next = TableDesign.parse({
    ...design,
    name: data.name.trim() || design.name,
    fields,
    ...(design.titleField && fields.some((f) => f.key === design.titleField) ? {} : { titleField: undefined }),
  });
  return { design: next, renames, summary: describeTableChanges(design, next, renames), notes, drafted: "model" };
}

function uniqueKey(key: string, taken: Set<string>): string {
  let candidate = key;
  for (let n = 2; taken.has(candidate); n++) candidate = `${key}_${n}`;
  taken.add(candidate);
  return candidate;
}

/** The kind a word names ("a number", "yes or no", "a person"). */
const KIND_WORDS: [RegExp, TableFieldType][] = [
  [/^(longer text|long text|paragraph|notes?)$/i, "long_text"],
  [/^(text|a line)$/i, "text"],
  [/^(number|count)$/i, "number"],
  [/^(amount of money|money|amount|price|cost)$/i, "money"],
  [/^date$/i, "date"],
  [/^(yes or no|yes\/no|checkbox|tick)$/i, "yes_no"],
  [/^(person|someone|owner)$/i, "person"],
  [/^(email|e-mail|email address)$/i, "email"],
  [/^(web address|url|link to a page)$/i, "url"],
  [/^(file|attachment|photo|document)$/i, "file"],
];

const VERBS = /^(add|include|also keep|remove|delete|drop|take away|take out|rename|call|make|set)\b/i;

function wordsTableChange(design: TableDesign, request: string, existing: ExistingTable[]): TableChange {
  const turkish = TURKISH.test(request);
  const notes: string[] = [];
  let fields: TableField[] = design.fields.map((f) => ({ ...f, ...(f.choices ? { choices: [...f.choices] } : {}) }));
  const renames: ValueRenames = {};
  const byLabel = (label: string) => {
    const text = label
      .trim()
      .toLowerCase()
      .replace(/^(the|a|an)\s+/, "")
      .replace(/\s+(field|column)$/, "");
    return fields.find((f) => f.label.toLowerCase() === text || f.key === tableKeyOf(text));
  };
  // "add Root cause and Photo": a clause without a verb carries on the one before.
  let verb = "";
  for (const raw of splitList(request)) {
    const clause = VERBS.test(raw) ? raw : verb ? `${verb} ${raw}` : raw;
    verb = VERBS.exec(clause)?.[1]?.toLowerCase() ?? verb;
    let m: RegExpExecArray | null;
    if ((m = /^(?:add|include)\s+(.+?)\s+to\s+(?:the\s+)?(?:values of\s+|choices of\s+)?(.+)$/i.exec(clause)) && byLabel(m[2]!)?.type === "choice") {
      const field = byLabel(m[2]!)!;
      const values = m[1]!
        .split(/\s*(?:,|\/|\bor\b)\s*/)
        .map((v) => v.replace(/^["“']|["”']$/g, "").trim())
        .filter(Boolean);
      field.choices = [...new Set([...(field.choices ?? []), ...values])];
    } else if (
      (m = /^(?:add|include|also keep)\s+(?:a |an |the )?(?:field (?:for |called )?|column (?:for |called )?)?(.+?)(?:\s+(?:field|column))?$/i.exec(clause))
    ) {
      if (byLabel(m[1]!)) notes.push(`${byLabel(m[1]!)!.label} is already there.`);
      else {
        const drafted = settle([fieldFromLabel(m[1]!, turkish)], existing, notes)[0]!;
        fields.push({ ...drafted, key: uniqueKey(drafted.key, new Set(fields.map((f) => f.key))) });
      }
    } else if ((m = /^(?:remove|delete|drop|take away|take out)\s+(.+)$/i.exec(clause))) {
      const field = byLabel(m[1]!);
      if (!field) notes.push(`There is no ${m[1]} to take away.`);
      else if (fields.length === 1) notes.push(`${field.label} is the only field; it stays.`);
      else fields = fields.filter((f) => f !== field);
    } else if ((m = /^(?:rename|call)\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(clause))) {
      const from = m[1]!.replace(/^["“']|["”']$/g, "").trim();
      const to = m[2]!.replace(/^["“']|["”']$/g, "").trim();
      const field = byLabel(from);
      const holder = field ? undefined : fields.find((f) => f.type === "choice" && f.choices?.some((c) => c.toLowerCase() === from.toLowerCase()));
      if (field) field.label = to.slice(0, 80);
      else if (holder) {
        const value = holder.choices!.find((c) => c.toLowerCase() === from.toLowerCase())!;
        holder.choices = holder.choices!.map((c) => (c === value ? to : c));
        if (holder.default === value) holder.default = to;
        (renames[holder.key] ??= {})[value] = to;
      } else notes.push(`There is no ${from} to rename.`);
    } else if ((m = /^make\s+(.+?)\s+(required|needed|mandatory|compulsory|optional|not required|not needed)$/i.exec(clause))) {
      const field = byLabel(m[1]!);
      if (!field) notes.push(`There is no ${m[1]}.`);
      else if (/optional|not/i.test(m[2]!)) delete field.required;
      else field.required = true;
    } else if ((m = /^make\s+(.+?)\s+(?:a |an )?(.+)$/i.exec(clause)) && KIND_WORDS.some(([p]) => p.test(m![2]!.trim()))) {
      const field = byLabel(m[1]!);
      const type = KIND_WORDS.find(([p]) => p.test(m![2]!.trim()))![1];
      if (!field) notes.push(`There is no ${m[1]}.`);
      else field.type = type;
    } else if ((m = /^(.+?)\s+(?:should\s+)?starts?\s+(?:as|with)\s+(.+)$/i.exec(clause)) && byLabel(m[1]!)) {
      const field = byLabel(m[1]!)!;
      const value = m[2]!.replace(/^["“']|["”']$/g, "").trim();
      const choice = field.choices?.find((c) => c.toLowerCase() === value.toLowerCase());
      if (field.type === "choice" && !choice) notes.push(`${field.label} can't start as ${value}: it isn't one of its values.`);
      else field.default = choice ?? value;
    } else {
      notes.push(`Not understood: ${quoted(raw)}. Say it as add, take away, rename, make … needed, or make … a number.`);
    }
  }
  const next = TableDesign.parse({
    ...design,
    fields,
    ...(design.titleField && fields.some((f) => f.key === design.titleField) ? {} : { titleField: undefined }),
  });
  return { design: next, renames, summary: describeTableChanges(design, next, renames), notes, drafted: "words" };
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export interface AppChange {
  pages: AppPage[];
  summary: string[];
  notes: string[];
  drafted: "model" | "words";
}

export interface ChangeNames {
  table(key: string): string;
  field(table: string, key: string): string;
  agent(slug: string): string;
  calculation?(key: string): string;
}

/** What changes between two sets of pages of an app, in plain words. */
export function describeAppChanges(before: AppPage[], after: AppPage[], names: ChangeNames): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((p) => [p.key, p]));
  const now = new Set(after.map((p) => p.key));
  for (const page of after) {
    const was = old.get(page.key);
    const said = page.blocks.map((b) => describeBlock(b, names));
    if (!was) {
      lines.push(`Adds the page ${quoted(page.title)}: ${said.join("; ")}`);
      continue;
    }
    if (was.title !== page.title) lines.push(`Renames the page ${quoted(was.title)} to ${quoted(page.title)}`);
    const before = was.blocks.map((b) => describeBlock(b, names));
    const left = [...before];
    for (const line of said) {
      const i = left.indexOf(line);
      if (i >= 0) left.splice(i, 1);
      else lines.push(`${page.title}: adds ${line[0]!.toLowerCase()}${line.slice(1)}`);
    }
    for (const line of left) lines.push(`${page.title}: takes away ${line[0]!.toLowerCase()}${line.slice(1)}`);
  }
  for (const page of before) if (!now.has(page.key)) lines.push(`Takes away the page ${quoted(page.title)}`);
  return lines;
}

export async function changeApp(
  llm: LlmClient,
  input: { design: AppDesign; request: string; tables: AppTable[]; agents?: AppAgent[]; calculations?: { key: string; name: string }[] },
): Promise<AppChange> {
  const request = input.request.trim();
  if (!request) throw new Error("Say what to change");
  if (llm.available) {
    const drafted = await modelAppChange(llm, input, request).catch(() => undefined);
    if (drafted) return drafted;
  }
  return wordsAppChange(input.design, request, input.tables, input.calculations ?? []);
}

function namesOf(tables: AppTable[], agents: AppAgent[], calculations: { key: string; name: string }[]): ChangeNames {
  const byKey = new Map(tables.map((t) => [t.key, t]));
  return {
    table: (key) => byKey.get(key)?.name ?? key,
    field: (table, key) => byKey.get(table)?.fields.find((f) => f.key === key)?.label ?? key,
    agent: (slug) => agents.find((a) => a.slug === slug)?.name ?? slug,
    calculation: (key) => calculations.find((c) => c.key === key)?.name ?? key,
  };
}

/** Page keys for new pages (titles), keeping the keys of pages that stay. */
function keyed(pages: (Omit<AppPage, "key"> & { key?: string })[]): AppPage[] {
  const used = new Set(pages.flatMap((p) => (p.key ? [p.key] : [])));
  return pages.map((page) => {
    if (page.key) return page as AppPage;
    const base = tableKeyOf(page.title).slice(0, 40);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return { ...page, key };
  });
}

async function modelAppChange(
  llm: LlmClient,
  input: { design: AppDesign; tables: AppTable[]; agents?: AppAgent[]; calculations?: { key: string; name: string }[] },
  request: string,
): Promise<AppChange | undefined> {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "The page's key when it is one of the app's pages; empty for a new page" },
            title: { type: "string" },
            blocks: { type: "array", items: modelBlockSchema() },
          },
          required: ["key", "title", "blocks"],
          additionalProperties: false,
        },
      },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["pages", "notes"],
    additionalProperties: false,
  };
  const agents = input.agents ?? [];
  const calculations = input.calculations ?? [];
  const { data } = await llm.structured<{ pages: { key: string; title: string; blocks: ModelBlock[] }[]; notes: string[] }>({
    purpose: "studio.app-change",
    system:
      "You change a business app as its owner asks, in plain words. The app is pages of blocks (form, list, board, chart, number, button, result, text) on the company's tables. Return all its pages after the change, keeping the pages and blocks that don't change as they are (with their keys). Change only what was asked.",
    effort: "medium",
    schema,
    messages: [
      {
        role: "user",
        content: [
          `The app now:\n${JSON.stringify(input.design.pages, null, 1)}`,
          `Tables:\n${input.tables.map((t) => `- ${t.key} (${t.name}): ${t.fields.map((f) => `${f.key} [${f.label}, ${f.type}${f.choices?.length ? `: ${f.choices.join("/")}` : ""}]`).join("; ")}`).join("\n")}`,
          agents.length ? `AI employees: ${agents.map((a) => `${a.slug} (${a.name})`).join("; ")}` : "",
          calculations.length ? `Calculations: ${calculations.map((c) => `${c.key} (${c.name})`).join("; ")}` : "",
          `What to change: ${request}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  if (!data?.pages?.length) return undefined;
  const notes = [...(data.notes ?? [])];
  const known = new Set(input.design.pages.map((p) => p.key));
  const drafted = pagesFromModel(data.pages, input.tables, agents, notes, calculations);
  // pagesFromModel drops pages without blocks; match the rest to the model's pages by title for their keys.
  const pages = keyed(
    drafted.map((page) => {
      const source = data.pages.find((p) => p.title.trim() === page.title);
      return source && known.has(source.key) ? { ...page, key: source.key } : page;
    }),
  ).slice(0, 8);
  if (!pages.length) return undefined;
  return { pages, summary: describeAppChanges(input.design.pages, pages, namesOf(input.tables, agents, calculations)), notes, drafted: "model" };
}

function wordsAppChange(design: AppDesign, request: string, tables: AppTable[], calculations: { key: string; name: string }[]): AppChange {
  const notes: string[] = [];
  let pages: (Omit<AppPage, "key"> & { key?: string })[] = design.pages.map((p) => ({ ...p, blocks: [...p.blocks] }));
  const main = tables.find((t) => design.pages.some((p) => p.blocks.some((b) => "table" in b && b.table === t.key))) ?? tables[0];
  const fieldOf = (table: AppTable, words: string) => {
    const w = words
      .trim()
      .toLowerCase()
      .replace(/^(the|a|an)\s+/, "");
    return table.fields.find((f) => f.label.toLowerCase() === w || f.label.toLowerCase().startsWith(w) || w.startsWith(f.label.toLowerCase()));
  };
  const tableOf = (words: string | undefined) => {
    if (!words) return main;
    const w = words.trim().toLowerCase();
    return tables.find((t) => t.name.toLowerCase() === w || t.name.toLowerCase().includes(w) || w.includes(t.name.toLowerCase())) ?? main;
  };
  const pageTitled = (words: string) => {
    const w = words
      .trim()
      .toLowerCase()
      .replace(/^(the)\s+/, "")
      .replace(/\s+page$/, "");
    return pages.find((p) => p.title.toLowerCase() === w);
  };
  const toOverview = (block: AppBlock) => {
    const overview = pages.find((p) => /^(overview|özet)$/i.test(p.title));
    if (overview) overview.blocks.push(block);
    else pages.push({ title: "Overview", blocks: [block] });
  };
  // "add a chart of … and a board": a clause without a verb carries on the one before.
  const APP_VERBS = /^(add|show|put|remove|delete|drop|take away|take out|rename)\b/i;
  let verb = "";
  for (const raw of splitList(request)) {
    const clause = APP_VERBS.test(raw) ? raw : verb ? `${verb} ${raw}` : raw;
    verb = APP_VERBS.exec(clause)?.[1]?.toLowerCase() ?? verb;
    let m: RegExpExecArray | null;
    if ((m = /^add\s+(?:a\s+|an\s+)?(pie\s+|bar\s+)?chart\s+(?:of\s+(?:the\s+)?(.+?)\s+)?(?:by|per)\s+(.+)$/i.exec(clause))) {
      const table = tableOf(m[2]);
      const byMonth = /month/i.test(m[3]!) ? table?.fields.find((f) => f.type === "date") : undefined;
      const field = byMonth ?? (table ? fieldOf(table, m[3]!) : undefined);
      if (!table || !field) notes.push(`There is nothing called ${m[3]} to chart by.`);
      else
        toOverview({
          type: "chart",
          title: `${table.name} by ${byMonth ? "month" : field.label.toLowerCase()}`,
          table: table.key,
          groupBy: field.key,
          measure: { of: "count" },
          kind: /pie/i.test(m[1] ?? "") ? "pie" : "bar",
        });
    } else if ((m = /^add\s+(?:a\s+)?board(?:\s+(?:by|of)\s+(.+))?$/i.exec(clause))) {
      const field = main ? (m[1] ? fieldOf(main, m[1]) : main.fields.find((f) => f.type === "choice")) : undefined;
      if (!main || field?.type !== "choice") notes.push("A board needs a field that is one of a list, such as a status.");
      else
        pages.push({
          title: "Board",
          blocks: [
            {
              type: "board",
              table: main.key,
              groupBy: field.key,
              fields: main.fields
                .filter((f) => f.type !== "long_text" && f.key !== field.key)
                .slice(0, 3)
                .map((f) => f.key),
            },
          ],
        });
    } else if ((m = /^add\s+(?:a\s+|an\s+)?form$/i.exec(clause))) {
      if (main) pages.push({ title: "Add", blocks: [{ type: "form", table: main.key }] });
    } else if ((m = /^add\s+(?:a\s+)?(?:list|page)\s+(?:of\s+)?(?:the\s+)?(.+?)(?:\s+by\s+(.+))?$/i.exec(clause))) {
      const table = tableOf(m[1]);
      if (!table) continue;
      const status = table.fields.find((f) => f.type === "choice" && f.choices?.some((c) => new RegExp(`\\b${c}\\b`, "i").test(m![1]!)));
      const value = status?.choices?.find((c) => new RegExp(`\\b${c}\\b`, "i").test(m![1]!));
      const group = m[2] ? fieldOf(table, m[2]) : undefined;
      pages.push({
        title: `${value ?? "All"} ${table.name.toLowerCase()}${group ? ` by ${group.label.toLowerCase()}` : ""}`.replace(/^./, (c) => c.toUpperCase()),
        blocks: [
          {
            type: "list",
            table: table.key,
            ...(status && value ? { filter: { [status.key]: value } } : {}),
            ...(group ? { groupBy: group.key } : {}),
            search: true,
          },
        ],
      });
    } else if (
      (m = /^(?:add|show)\s+(?:the\s+)?(.+?)(?:\s+result)?$/i.exec(clause)) &&
      calculations.some((c) => c.name.toLowerCase() === m![1]!.trim().toLowerCase())
    ) {
      const calculation = calculations.find((c) => c.name.toLowerCase() === m![1]!.trim().toLowerCase())!;
      toOverview({ type: "result", calculation: calculation.key });
    } else if ((m = /^(?:remove|delete|drop|take away|take out)\s+(?:the\s+)?(.+?)$/i.exec(clause))) {
      const page = pageTitled(m[1]!);
      const kind = /^(board|chart|form|list|numbers?|buttons?)s?$/i.exec(m[1]!.trim())?.[1]?.toLowerCase().replace(/s$/, "");
      if (page) pages = pages.filter((p) => p !== page);
      else if (kind) {
        pages = pages.map((p) => ({ ...p, blocks: p.blocks.filter((b) => b.type !== kind) })).filter((p) => p.blocks.length);
      } else notes.push(`There is no page or part called ${m[1]}.`);
    } else if ((m = /^rename\s+(?:the\s+)?(.+?)\s+(?:page\s+)?to\s+(.+)$/i.exec(clause))) {
      const page = pageTitled(m[1]!);
      if (page)
        page.title = m[2]!
          .replace(/^["“']|["”']$/g, "")
          .trim()
          .slice(0, 60);
      else notes.push(`There is no page called ${m[1]}.`);
    } else {
      notes.push(`Not understood: ${quoted(clause)}. Say it as add a chart of … by …, add a board, add a list of …, take away …, or rename … to ….`);
    }
  }
  const next = keyed(pages).slice(0, 8);
  const names = namesOf(tables, [], calculations);
  return { pages: next, summary: describeAppChanges(design.pages, next, names), notes, drafted: "words" };
}

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

const PERIOD_WORDS = /\b(last month|this month|this week|this year|geçen ay|bu ay|bu hafta|bu yıl)\b/i;

/** The rule as it becomes: the request itself when it is a whole rule, else the rule with its period or its "per N" changed. */
export function changedRule(rule: string, request: string): string | undefined {
  const text = request.trim();
  if (/^(rank|order|sort|list|count|how many|number of|total|sum|average|mean)\b/i.test(text)) return text;
  let next = rule;
  const period = PERIOD_WORDS.exec(text);
  if (period) next = PERIOD_WORDS.test(next) ? next.replace(PERIOD_WORDS, period[1]!) : `${next} ${period[1]}`;
  const per = /\bper\s+(\d+)\b/i.exec(text);
  if (per) next = /\bper\s+\d+\b/i.test(next) ? next.replace(/\bper\s+\d+\b/i, `per ${per[1]}`) : next;
  return next === rule ? undefined : next;
}

export async function changeCalculation(
  llm: LlmClient,
  input: {
    calculation: { rule: string; code: string };
    request: string;
    tables: CalculationTable[];
    samples?: Record<string, Record<string, unknown>[]>;
    trial: (draft: CalculationDraft) => Promise<TrialOutcome>;
  },
): Promise<CalculationProposal & { rule: string }> {
  const request = input.request.trim();
  if (!request) throw new Error("Say what to change");
  const worded = changedRule(input.calculation.rule, request);
  if (!worded && !llm.available) throw new Error("Say the whole rule as it should be, for example: rank suppliers by complaints per 1000 deliveries this year");
  const proposal = await writeCalculation(llm, {
    rule: worded ?? request,
    tables: input.tables,
    samples: input.samples,
    trial: input.trial,
    current: { ...input.calculation, change: request },
  });
  return { ...proposal, rule: proposal.rule ?? worded ?? request };
}
