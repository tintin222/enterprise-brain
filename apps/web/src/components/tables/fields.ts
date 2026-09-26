import { AlignLeft, Banknote, CalendarDays, Hash, Link2, List, Mail, Paperclip, Globe, ToggleLeft, Type, UserRound, type LucideIcon } from "lucide-react";
import { formatDate } from "../../lib/format.ts";
import type { TableField, TableFieldType } from "../../types.ts";

/** Each kind of field as people know it. */
export const FIELD_KINDS: { type: TableFieldType; label: string; icon: LucideIcon }[] = [
  { type: "text", label: "Text", icon: Type },
  { type: "long_text", label: "Longer text", icon: AlignLeft },
  { type: "number", label: "Number", icon: Hash },
  { type: "money", label: "Amount of money", icon: Banknote },
  { type: "date", label: "Date", icon: CalendarDays },
  { type: "yes_no", label: "Yes or no", icon: ToggleLeft },
  { type: "choice", label: "One of a list", icon: List },
  { type: "person", label: "A person", icon: UserRound },
  { type: "email", label: "Email address", icon: Mail },
  { type: "url", label: "Web address", icon: Globe },
  { type: "file", label: "File", icon: Paperclip },
  { type: "link", label: "A record of another table", icon: Link2 },
];

export function kindOf(type: TableFieldType) {
  return FIELD_KINDS.find((k) => k.type === type) ?? FIELD_KINDS[0]!;
}

const RESERVED = new Set(["id", "number", "created_at", "updated_at", "created_by", "updated_by", "record", "search", "limit"]);

/** A field key from its label ("Order number" → "order_number"), not one of the taken ones. */
export function fieldKeyOf(label: string, taken: Iterable<string>): string {
  let key = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!/^[a-z]/.test(key)) key = `f_${key || "field"}`;
  if (RESERVED.has(key)) key = `${key}_value`;
  const used = new Set(taken);
  let candidate = key;
  for (let n = 2; used.has(candidate); n++) candidate = `${key}_${n}`;
  return candidate;
}

/** A value as people read it in a list: money with its currency, dates, yes or no, people and links by name. */
export function formatValue(field: TableField, value: unknown, display?: string): string {
  if (value === undefined || value === null || value === "") return "";
  switch (field.type) {
    case "money": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      const amount = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return field.currency ? `${amount} ${field.currency}` : amount;
    }
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    case "date":
      return formatDate(String(value));
    case "yes_no":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "person":
    case "link":
      return display ?? String(value);
    case "file":
      return "File";
    default:
      return String(value);
  }
}

/** A value from a record in the form an input shows it. */
export function inputValue(field: TableField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (field.type === "yes_no") return value === true ? "yes" : value === false ? "no" : "";
  return String(value);
}
