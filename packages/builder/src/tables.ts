import { FIELD_TYPES, RESERVED_FIELD_KEYS, TableDesign, tableKeyOf, type JsonSchema, type TableField, type TableFieldType } from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";

/**
 * The Studio's table designer: from "supplier complaints: supplier, order number, problem, status,
 * owner, cost" to a table's fields and their kinds. With the model it understands any wording; without
 * it, the words themselves are read (a list after a colon or "with", kinds from the labels).
 */

export interface TableProposal {
  design: TableDesign;
  /** What it understood or assumed, for the person to check. */
  notes: string[];
  /** How it was drafted: with the model, or from the words alone. */
  drafted: "model" | "words";
}

/** Tables the company has, so a field can point at one ("supplier" → the Suppliers table). */
export interface ExistingTable {
  key: string;
  name: string;
}

export async function proposeTable(llm: LlmClient, input: { description: string; existing?: ExistingTable[] }): Promise<TableProposal> {
  const description = input.description.trim();
  if (!description) throw new Error("Say what the table is for");
  const existing = input.existing ?? [];
  if (llm.available) {
    const drafted = await modelDraft(llm, description, existing).catch(() => undefined);
    if (drafted) return drafted;
  }
  return wordsDraft(description, existing);
}

// ---------------------------------------------------------------------------
// With the model
// ---------------------------------------------------------------------------

interface DraftField {
  label: string;
  type: TableFieldType;
  description: string;
  required: boolean;
  choices: string[];
  startsAs: string;
  currency: string;
  linksTo: string;
  personal: boolean;
}

const SYSTEM = `You design tables for business people's data: a register, a log, a tracker, a list. They describe what they need in their own words (English or Turkish) and never see a database.

Design one table:
- name: short and plain, in the person's language ("Supplier complaints", "Tedarikçi şikayetleri").
- fields: 3 to 15, in the order a person fills them in. Labels in the person's language, short, sentence case.
- type, one of: text (a line), long_text (paragraphs), number, money, date, yes_no, choice (one of a short list: give choices, e.g. a status), person (someone in the company: an owner, a reviewer), email, url, file (a document or photo), link (a record of one of the company's existing tables: give its key in linksTo).
- Identifiers such as order or invoice numbers are text. Amounts of money are money, with an ISO currency when it is clear (TRY, EUR, USD).
- required only for what every record must have. A status starts as its first value (startsAs); leave startsAs empty otherwise.
- personal: true for data about a person outside the company (names, phone numbers, health), which KVKK/GDPR protects. Company people's fields (person type) are not.
- titleField: the label of the field that names a record (a title, a subject, a problem).
- notes: 1 to 4 short sentences on what you assumed, for the person to check.`;

async function modelDraft(llm: LlmClient, description: string, existing: ExistingTable[]): Promise<TableProposal | undefined> {
  const field: JsonSchema = {
    type: "object",
    properties: {
      label: { type: "string" },
      type: { type: "string", enum: [...FIELD_TYPES] },
      description: { type: "string", description: "What goes in it, in a few words; empty if obvious" },
      required: { type: "boolean" },
      choices: { type: "array", items: { type: "string" }, description: "For choice: the values; else empty" },
      startsAs: { type: "string", description: "The value a new record gets; empty for none" },
      currency: { type: "string", description: "For money: ISO code (TRY); else empty" },
      linksTo: { type: "string", description: "For link: the key of an existing table; else empty" },
      personal: { type: "boolean" },
    },
    required: ["label", "type", "description", "required", "choices", "startsAs", "currency", "linksTo", "personal"],
    additionalProperties: false,
  };
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", description: "One sentence: what the table keeps" },
      fields: { type: "array", items: field },
      titleField: { type: "string" },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["name", "description", "fields", "titleField", "notes"],
    additionalProperties: false,
  };
  const { data } = await llm.structured<{ name: string; description: string; fields: DraftField[]; titleField: string; notes: string[] }>({
    purpose: "studio.table",
    system: SYSTEM,
    effort: "low",
    schema,
    messages: [
      {
        role: "user",
        content: [
          `What the person needs: ${description}`,
          existing.length
            ? `The company's existing tables (key: name): ${existing.map((t) => `${t.key}: ${t.name}`).join("; ")}`
            : "The company has no tables yet.",
        ].join("\n"),
      },
    ],
  });
  if (!data?.fields?.length) return undefined;
  const notes = [...(data.notes ?? [])];
  const fields = settle(
    data.fields.map((f) => ({
      label: f.label,
      type: f.type,
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.choices.length ? { choices: f.choices } : {}),
      ...(f.startsAs.trim() ? { default: f.startsAs.trim() } : {}),
      ...(/^[A-Z]{3}$/.test(f.currency.trim().toUpperCase()) ? { currency: f.currency.trim().toUpperCase() } : {}),
      ...(f.linksTo.trim() ? { table: f.linksTo.trim() } : {}),
      ...(f.personal ? { personal: true } : {}),
    })),
    existing,
    notes,
  );
  const title = fields.find((f) => f.label.toLowerCase() === data.titleField.trim().toLowerCase());
  const name = data.name.trim() || nameOf(description);
  return {
    design: TableDesign.parse({ key: tableKeyOf(name), name, description: data.description.trim(), fields, ...(title ? { titleField: title.key } : {}) }),
    notes,
    drafted: "model",
  };
}

// ---------------------------------------------------------------------------
// From the words alone
// ---------------------------------------------------------------------------

export const TURKISH = /[ğüşıöçİĞÜŞÖÇ]|\b(ve|ile|için|durum|tarih|sorumlu)\b/i;

/** Kinds read from a label's words (English and Turkish), in order: the first that matches. */
const KINDS: [RegExp, TableFieldType][] = [
  [/\b(e-?mail|e-?posta)\b/, "email"],
  [/\b(url|website|web address|web sitesi|link to)\b/, "url"],
  [/\b(file|attachment|document|photo|picture|image|scan|certificate|dosya|belge|fotoğraf|görsel|sertifika)\b/, "file"],
  // Identifiers are text, whatever else they say ("order number", "invoice no", "sipariş no").
  [/(\bnumber|\bno\.?|\bnr\.?|\bid|\bcode|\bref|\breference|numarası|kodu)$/, "text"],
  [/\b(date|deadline|due|day|when|tarih|tarihi|since|until|born)\b|\bon$/, "date"],
  [/\b(cost|costs|amount|price|fee|value|total|budget|salary|tutar|tutarı|fiyat|fiyatı|maliyet|maliyeti|bedel|ücret)\b|[₺$€]|\b(try|tl|eur|usd)\b/, "money"],
  [/\b(count|quantity|qty|hours|minutes|days|score|rating|percent|percentage|age|weight|number of|how many|adet|miktar|sayısı|puan|yüzde)\b|%/, "number"],
  [
    /\b(owner|responsible|assignee|assigned to|manager|reported by|requested by|raised by|contact person|approver|reviewer|sorumlu|sorumlusu|yönetici|talep eden|onaylayan)\b/,
    "person",
  ],
  [/^(is|has|was|needs|requires|approved|paid|done|resolved|active|urgent|passed|onaylandı|ödendi|tamamlandı)\b|\?$/, "yes_no"],
  [/\b(status|state|stage|priority|severity|urgency|durum|durumu|öncelik|aşama)\b/, "choice"],
  [
    /\b(description|details|notes?|comments?|remarks|explanation|what happened|root cause|actions? taken|corrective action|açıklama|notlar?|yorum|detay)\b/,
    "long_text",
  ],
];

const CHOICES: [RegExp, string[], string[]][] = [
  [/\b(priority|severity|urgency|öncelik)\b/, ["Low", "Medium", "High"], ["Düşük", "Orta", "Yüksek"]],
  [/\b(stage|aşama)\b/, ["New", "In progress", "Done"], ["Yeni", "İşlemde", "Tamamlandı"]],
  [/./, ["Open", "In progress", "Closed"], ["Açık", "İşlemde", "Kapalı"]],
];

const CURRENCIES: [RegExp, string][] = [
  [/₺|\b(try|tl|lira)\b/i, "TRY"],
  [/€|\beur(o|os)?\b/i, "EUR"],
  [/\$|\busd\b|\bdollars?\b/i, "USD"],
  [/£|\bgbp\b/i, "GBP"],
];

/** A table from the words alone (no model): a list of details after a colon or "with", kinds from the labels. */
export function wordsDraft(description: string, existing: ExistingTable[]): TableProposal {
  const turkish = TURKISH.test(description);
  const notes: string[] = [];
  const { name, list } = splitDescription(description, turkish);
  const labels = list ? splitList(list) : [];
  const drafts: Omit<TableField, "key">[] = labels.length
    ? labels.map((label) => fieldFromLabel(label, turkish))
    : turkish
      ? [
          { label: "Başlık", type: "text", required: true },
          { label: "Açıklama", type: "long_text" },
          { label: "Durum", type: "choice", choices: ["Açık", "İşlemde", "Kapalı"], default: "Açık" },
          { label: "Sorumlu", type: "person" },
          { label: "Tarih", type: "date" },
        ]
      : [
          { label: "Title", type: "text", required: true },
          { label: "Details", type: "long_text" },
          { label: "Status", type: "choice", choices: ["Open", "In progress", "Closed"], default: "Open" },
          { label: "Owner", type: "person" },
          { label: "Date", type: "date" },
        ];
  if (!labels.length) {
    notes.push(
      turkish
        ? "Her kayıtta hangi bilgilerin olacağını söylemediniz; yaygın alanlarla başladı. Alan ekleyip çıkarabilirsiniz."
        : "You didn't say which details each record holds, so it starts with common ones; add or remove fields.",
    );
  }
  const currency = CURRENCIES.find(([pattern]) => pattern.test(description))?.[1];
  for (const draft of drafts) if (draft.type === "money" && !draft.currency && currency) draft.currency = currency;
  const fields = settle(drafts, existing, notes);
  // The field that names a record: a name, title, subject or problem; else the first text field.
  const title =
    fields.find((f) => f.type === "text" && /\b(name|title|subject|problem|issue|summary|ad|adı|başlık|konu|sorun)\b/i.test(f.label)) ??
    fields.find((f) => f.type === "text");
  if (title && !fields.some((f) => f.required)) title.required = true;
  for (const f of fields) {
    if (f.type === "choice" && f.default) notes.push(turkish ? `${f.label} "${f.default}" olarak başlar.` : `${f.label} starts as "${f.default}".`);
    if (f.type === "money" && !f.currency)
      notes.push(turkish ? `${f.label} için para birimi belirtilmedi.` : `${f.label} has no currency; say which if it matters.`);
  }
  const tableName = name || (turkish ? "Kayıtlar" : "Records");
  return {
    design: TableDesign.parse({
      key: tableKeyOf(tableName),
      name: tableName,
      // The name and the fields say it; the request itself isn't repeated as the description.
      description: "",
      fields,
      ...(title ? { titleField: title.key } : {}),
    }),
    notes,
    drafted: "words",
  };
}

/** The table's name and the list of details, from "Supplier complaints: supplier, order…" or "…with supplier, order…". */
function splitDescription(description: string, turkish: boolean): { name: string; list?: string } {
  const text = description.replace(/\s+/g, " ").trim();
  const colon = text.indexOf(":");
  const joiner = /\s(?:with|having|containing|including|that has|that have|which has|fields|columns|ile|içeren)\s/i.exec(text);
  let head = text;
  let list: string | undefined;
  if (colon > 0) {
    head = text.slice(0, colon);
    list = text.slice(colon + 1);
  } else if (joiner) {
    head = text.slice(0, joiner.index);
    list = text.slice(joiner.index + joiner[0].length);
  }
  return { name: nameOf(head, turkish), ...(list?.trim() ? { list } : {}) };
}

/** "I need a register of supplier complaints" → "Supplier complaints". */
export function nameOf(text: string, turkish = TURKISH.test(text)): string {
  const name = text
    .replace(/[.!?]+$/, "")
    .replace(/^(please\s+)?((i|we)\s+(need|want|would like)|let's|lets|create|make|build|set up|start|keep|track)\s+/i, "")
    .replace(/^(a|an|the|our|my)\s+/i, "")
    .replace(/^(new\s+)?(register|list|log|tracker|table|database|record|registry|catalog|catalogue|inventory|sheet)\s+(of|for)\s+/i, "")
    .replace(/\s+(register|list|log|tracker|table|database|registry|sheet|listesi|kaydı|tablosu)$/i, "")
    .trim()
    .slice(0, 80);
  return capitalize(name, turkish);
}

/** The first letter in capitals ("i" is "İ" only in Turkish). */
export function capitalize(text: string, turkish: boolean): string {
  return text ? text[0]!.toLocaleUpperCase(turkish ? "tr" : "en") + text.slice(1) : "";
}

/** Split a list of details on commas, semicolons, "and" and new lines, but not inside parentheses. */
export function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const label = current
      .replace(/^[\s\-*•\d.)]+/, "")
      .replace(/[.\s]+$/, "")
      .trim();
    if (label) parts.push(label);
    current = "";
  };
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === "," || c === ";" || c === "\n")) {
      flush();
      continue;
    }
    const rest = list.slice(i);
    const and = depth === 0 ? /^\s+(and|ve|or)\s+/i.exec(rest) : null;
    if (and) {
      flush();
      i += and[0].length - 1;
      continue;
    }
    current += c;
  }
  flush();
  return parts.slice(0, 40);
}

/** "status (open, in progress, closed)" → a choice; "cost in TRY" → money; "owner" → a person. */
export function fieldFromLabel(raw: string, turkish: boolean): Omit<TableField, "key"> {
  const listed = /\(([^)]*)\)/.exec(raw);
  const base = raw
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = base.toLocaleLowerCase("tr");
  const label = capitalize(base, turkish);
  const choices = listed?.[1]!
    .split(/[,/|]|\s+or\s+|\s+veya\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => capitalize(c, turkish));
  if (choices && choices.length >= 2) return { label, type: "choice", choices, default: choices[0] };
  const type = KINDS.find(([pattern]) => pattern.test(words))?.[1] ?? "text";
  if (type === "choice") {
    const [, en, tr] = CHOICES.find(([pattern]) => pattern.test(words))!;
    const values = turkish ? tr : en;
    return /\b(status|state|durum|durumu)\b/.test(words) ? { label, type, choices: values, default: values[0] } : { label, type, choices: values };
  }
  if (type === "money") {
    const currency = CURRENCIES.find(([pattern]) => pattern.test(raw))?.[1];
    const clean = label.replace(/\s+(in|as)\s+(try|tl|eur|euros?|usd|dollars?|gbp)$/i, "").replace(/\s*\((try|tl|eur|usd|gbp)\)$/i, "");
    return { label: clean || label, type, ...(currency ? { currency } : {}) };
  }
  return { label, type };
}

// ---------------------------------------------------------------------------
// Both ways
// ---------------------------------------------------------------------------

/**
 * Fields made valid: keys from labels (unique, not the platform's own), a field that names another
 * table points at it, a link to no table becomes text, a choice without values becomes text.
 */
export function settle(drafts: Omit<TableField, "key">[], existing: ExistingTable[], notes: string[]): TableField[] {
  const keys = new Set<string>();
  const fields: TableField[] = [];
  for (const draft of drafts.slice(0, 60)) {
    const label = draft.label.trim().slice(0, 80);
    if (!label) continue;
    let key = tableKeyOf(label).replace(/^t_/, "f_").slice(0, 44);
    if ((RESERVED_FIELD_KEYS as readonly string[]).includes(key)) key = `${key}_value`;
    for (let n = 2; keys.has(key); n++) key = `${key.replace(/_\d+$/, "")}_${n}`;
    keys.add(key);
    const field: TableField = { ...draft, key, label };
    // "Supplier" when the company has a Suppliers table: a record of it.
    const target = field.type === "link" ? existing.find((t) => t.key === field.table) : field.type === "text" ? matchTable(label, existing) : undefined;
    if (field.type === "link" && !target) {
      field.type = "text";
      delete field.table;
    } else if (target && field.type === "text") {
      field.type = "link";
      field.table = target.key;
      notes.push(`${label} points at a record of ${target.name}.`);
    }
    if (field.type === "choice") {
      field.choices = [...new Set((field.choices ?? []).map((c) => c.trim().slice(0, 80)).filter(Boolean))].slice(0, 50);
      if (!field.choices.length) {
        field.type = "text";
        delete field.choices;
      }
    } else delete field.choices;
    if (field.default !== undefined && field.type === "choice" && !field.choices?.includes(String(field.default))) delete field.default;
    if (field.default !== undefined && field.type !== "choice" && field.type !== "text" && field.type !== "yes_no") delete field.default;
    if (field.type !== "money") delete field.currency;
    if (field.type !== "link") delete field.table;
    fields.push(field);
  }
  if (!fields.length) throw new Error("Say which details the table keeps");
  return fields;
}

/** The existing table a label names: "supplier" → Suppliers, "Tedarikçi" → Tedarikçiler. */
function matchTable(label: string, existing: ExistingTable[]): ExistingTable | undefined {
  const words = label.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
  return existing.find((t) => {
    const name = t.name.toLocaleLowerCase("tr").trim();
    return name === words || name === `${words}s` || name === `${words}es` || name === `${words}ler` || name === `${words}lar` || t.key === tableKeyOf(words);
  });
}
