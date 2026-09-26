import { z } from "zod";

/**
 * Tables: business data people describe in plain words ("supplier complaints: supplier, order, problem,
 * status, owner"). The platform keeps them in the company's database, checks every value against its
 * field, and keeps every change; people never see the database.
 */

export const FIELD_TYPES = ["text", "long_text", "number", "money", "date", "yes_no", "choice", "person", "email", "url", "file", "link"] as const;
export type TableFieldType = (typeof FIELD_TYPES)[number];

/** How each kind of field is named to people. */
export const FIELD_TYPE_LABELS: Record<TableFieldType, string> = {
  text: "text",
  long_text: "longer text",
  number: "number",
  money: "amount of money",
  date: "date",
  yes_no: "yes or no",
  choice: "one of a list",
  person: "a person",
  email: "email address",
  url: "web address",
  file: "file",
  link: "a record of another table",
};

const KEY = /^[a-z][a-z0-9_]*$/;
/** Names the platform gives every record, which a field can't take. */
export const RESERVED_FIELD_KEYS = ["id", "number", "created_at", "updated_at", "created_by", "updated_by", "record", "search", "limit"] as const;

export const TableField = z
  .object({
    key: z.string().regex(KEY, "Use lower-case letters, digits and _ (e.g. supplier_name)").max(48),
    label: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES).default("text"),
    description: z.string().max(300).optional(),
    required: z.boolean().optional(),
    /** choice: the values people pick from. */
    choices: z.array(z.string().min(1).max(80)).max(50).optional(),
    /** money: its currency (ISO code, e.g. TRY). */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** link: the table its records point at (that table's key). */
    table: z.string().regex(KEY).optional(),
    /** Personal data (KVKK/GDPR). */
    personal: z.boolean().optional(),
    /** The value a new record gets when none is given (a status starts "Open"). */
    default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  })
  .superRefine((field, ctx) => {
    if ((RESERVED_FIELD_KEYS as readonly string[]).includes(field.key))
      ctx.addIssue({ code: "custom", message: `${field.key}: that name is taken by the platform` });
    if (field.type === "choice" && !field.choices?.length) ctx.addIssue({ code: "custom", message: `${field.label}: give the values to pick from` });
    if (field.type === "link" && !field.table) ctx.addIssue({ code: "custom", message: `${field.label}: say which table it points at` });
    if (field.type === "choice" && typeof field.default === "string" && !field.choices?.includes(field.default)) {
      ctx.addIssue({ code: "custom", message: `${field.label}: it starts as "${field.default}", which is not one of its values` });
    }
  });
export type TableField = z.infer<typeof TableField>;

export const TableSettings = z.object({
  /** department (default): its people see it; company: everyone does. */
  visibility: z.enum(["department", "company"]).default("department"),
  /** Who adds and changes records: its department's people, or only its managers. */
  editors: z.enum(["members", "managers"]).default("members"),
  /** Made in a Studio conversation (its id) not yet put to work: shown there, not with the department's tables. */
  studio: z.string().optional(),
});
export type TableSettings = z.infer<typeof TableSettings>;

/** A table's design: what the Studio proposes from a description, and what people change. */
export const TableDesign = z
  .object({
    key: z.string().regex(KEY, "Use lower-case letters, digits and _").max(48),
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    fields: z.array(TableField).min(1).max(60),
    /** The field that names a record (defaults to the first text field). */
    titleField: z.string().optional(),
  })
  .superRefine((design, ctx) => {
    const keys = new Set<string>();
    for (const field of design.fields) {
      if (keys.has(field.key)) ctx.addIssue({ code: "custom", message: `Two fields are called ${field.key}` });
      keys.add(field.key);
    }
    if (design.titleField && !keys.has(design.titleField))
      ctx.addIssue({ code: "custom", message: `The title field ${design.titleField} is not one of the fields` });
  });
export type TableDesign = z.infer<typeof TableDesign>;
export type TableDesignInput = z.input<typeof TableDesign>;

/** The field that names a record: the one chosen, else the first text field, else the first field. */
export function titleFieldOf(design: Pick<TableDesign, "fields" | "titleField">): string {
  return design.titleField ?? design.fields.find((f) => f.type === "text")?.key ?? design.fields[0]!.key;
}

/** Looks up what a value refers to: a person, a record of another table, a stored file. */
export interface ValueResolvers {
  /** A person of the company by email or name: their email, or undefined. */
  person(value: string): Promise<string | undefined>;
  /** A record of another table by id, number or title: its id, or undefined. */
  link(tableKey: string, value: string): Promise<string | undefined>;
  /** A stored file by id: true when it exists. */
  file(id: string): Promise<boolean>;
}

export class RecordValueError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "RecordValueError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "1250.5", "1.250,50", "1 250" → a number; undefined when it isn't one. With `money`, a lone dot
 * before three digits separates thousands ("1.200" TL is 1200); otherwise it is a decimal point.
 */
export function parseNumber(value: unknown, options: { money?: boolean } = {}): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\s ]/g, "").replace(/^[^\d-]+|[^\d]+$/g, "");
  if (!text) return undefined;
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas && dots) text = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (commas === 1 && !/,\d{3}$/.test(text)) text = text.replace(",", ".");
  else if (commas) text = text.replace(/,/g, "");
  else if (dots > 1 || (options.money && dots === 1 && /^-?\d{1,3}\.\d{3}$/.test(text))) text = text.replace(/\./g, "");
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** "2026-10-02", "2026-10-02T09:00:00Z", "02.10.2026", "2/10/2026" (day first) → "2026-10-02". */
export function parseDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2]!.padStart(2, "0"), dmy[1]!.padStart(2, "0")] : [];
  if (!y) return undefined;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return undefined;
  return `${y}-${m}-${d}`;
}

const YES = new Set(["yes", "true", "1", "y", "evet", "e", "on"]);
const NO = new Set(["no", "false", "0", "n", "hayır", "hayir", "h", "off"]);

/** The same words, whatever the capitals: in English ("In" is "in") and in Turkish ("İ" is "i", "I" is "ı"). */
function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() || a.toLocaleLowerCase("tr") === b.toLocaleLowerCase("tr");
}

function inSet(words: Set<string>, value: string): boolean {
  return [...words].some((word) => sameText(word, value));
}

/**
 * A record's values checked against its table's fields and put in their stored form. With `partial`,
 * only the values given are checked (a change); otherwise required fields must be there (a new record).
 * An empty value clears the field. Throws RecordValueError with every problem at once.
 */
export async function checkRecordValues(
  design: Pick<TableDesign, "fields">,
  input: Record<string, unknown>,
  resolvers: ValueResolvers,
  options: { partial?: boolean } = {},
): Promise<Record<string, unknown>> {
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  const byKey = new Map(design.fields.map((f) => [f.key, f]));
  const byLabel = new Map(design.fields.map((f) => [f.label.toLowerCase(), f]));
  const given = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) {
    const field = byKey.get(key) ?? byLabel.get(key.toLowerCase());
    if (!field) {
      problems.push(`There is no field "${key}"`);
      continue;
    }
    given.set(field.key, value);
  }
  for (const field of design.fields) {
    if (!given.has(field.key) && !options.partial && field.default !== undefined) given.set(field.key, field.default);
    if (!given.has(field.key)) {
      if (!options.partial && field.required) problems.push(`${field.label} is required`);
      continue;
    }
    const raw = given.get(field.key);
    const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (field.required) problems.push(`${field.label} is required`);
      else out[field.key] = null;
      continue;
    }
    const fail = (why: string) => problems.push(`${field.label}: ${why}`);
    switch (field.type) {
      case "text":
      case "long_text": {
        const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
        const max = field.type === "text" ? 1000 : 20000;
        if (text === undefined) fail("give text");
        else if (text.length > max) fail(`at most ${max} characters`);
        else out[field.key] = text;
        break;
      }
      case "number":
      case "money": {
        const n = parseNumber(raw, { money: field.type === "money" });
        if (n === undefined) fail("give a number");
        else out[field.key] = field.type === "money" ? Math.round(n * 100) / 100 : n;
        break;
      }
      case "date": {
        const date = parseDate(raw);
        if (!date) fail("give a date (YYYY-MM-DD)");
        else out[field.key] = date;
        break;
      }
      case "yes_no": {
        if (typeof raw === "boolean") out[field.key] = raw;
        else if (inSet(YES, String(raw).trim())) out[field.key] = true;
        else if (inSet(NO, String(raw).trim())) out[field.key] = false;
        else fail("give yes or no");
        break;
      }
      case "choice": {
        const text = String(raw).trim();
        const match = field.choices?.find((c) => c === text) ?? field.choices?.find((c) => sameText(c, text));
        if (!match) fail(`one of ${(field.choices ?? []).map((c) => `"${c}"`).join(", ")}`);
        else out[field.key] = match;
        break;
      }
      case "email": {
        const text = String(raw).trim().toLowerCase();
        if (!EMAIL.test(text)) fail("give an email address");
        else out[field.key] = text;
        break;
      }
      case "url": {
        const text = String(raw).trim();
        let ok = false;
        try {
          ok = ["http:", "https:"].includes(new URL(text).protocol);
        } catch {
          ok = false;
        }
        if (!ok) fail("give a web address (https://…)");
        else out[field.key] = text;
        break;
      }
      case "person": {
        const email = await resolvers.person(String(raw).trim());
        if (!email) fail(`"${String(raw)}" is not a person of the company`);
        else out[field.key] = email;
        break;
      }
      case "link": {
        const id = await resolvers.link(field.table!, String(raw).trim());
        if (!id) fail(`no record "${String(raw)}" in the linked table`);
        else out[field.key] = id;
        break;
      }
      case "file": {
        const id = String(raw).trim();
        if (!(await resolvers.file(id))) fail("give a stored file");
        else out[field.key] = id;
        break;
      }
    }
  }
  if (problems.length) throw new RecordValueError(problems);
  return out;
}

/** The same data, whatever the order of keys (the database keeps JSON keys in its own order). */
export function sameData(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** A table key from its name: "Supplier complaints" → "supplier_complaints". */
export function tableKeyOf(name: string): string {
  const key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  return /^[a-z]/.test(key) ? key : `t_${key || "table"}`;
}
