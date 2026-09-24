/** Typed value recognizers used by the heuristic extractor. All are tolerant and never throw. */
import { foldText } from "./text.ts";

export interface Found<T> {
  value: T;
  index: number;
  end: number;
}

function matchesOf(re: RegExp, text: string): RegExpExecArray[] {
  return [...text.matchAll(re)];
}

// ---------------------------------------------------------------------------
// Emails and URLs

// Patterns here start only at the beginning of a run of their characters (lookbehinds) or have
// bounded repetition, which keeps them linear on hostile input such as long base64 blobs.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export function findEmails(text: string): Found<string>[] {
  return matchesOf(EMAIL_RE, text).map((m) => ({ value: m[0], index: m.index, end: m.index + m[0].length }));
}

const URL_RE = /(?:\bhttps?:\/\/|\bwww\.|(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*(?:linkedin|github|gitlab|behance|dribbble|medium)\.com\/)[^\s<>"'`|]+/gi;

/** URLs, including scheme-less "www." and profile links (linkedin.com/in/…); returned with an https:// scheme. */
export function findUrls(text: string): Found<string>[] {
  const found: Found<string>[] = [];
  for (const m of matchesOf(URL_RE, text)) {
    // Neither sentence punctuation nor an unbalanced closing bracket belongs to the URL.
    const raw = m[0].replace(/[.,;:!?'")\]}]+$/, "");
    if (m.index > 0 && text[m.index - 1] === "@") continue;
    found.push({ value: /^https?:\/\//i.test(raw) ? raw : `https://${raw}`, index: m.index, end: m.index + raw.length });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Phone numbers

// Within one line, and not glued to a preceding word, number or identifier ("FTR-2026-0042").
const PHONE_CANDIDATE_RE = /(?<![\p{L}\p{N}.,/_-])(?:\+|00)?\(?\d[\d \t().-]{5,28}\d/gu;

function isPlausiblePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  // Dates, year ranges and amounts share the character set of phone numbers.
  if (/\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/.test(candidate)) return false;
  if (/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/.test(candidate)) return false;
  if (candidate.includes(".") && candidate.includes(",")) return false;
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(candidate)) return false;
  if (/^(?:\+|00)/.test(candidate)) return digits.length >= 8;
  if (/^\(?0/.test(candidate)) return digits.length >= 9 && digits.length <= 12;
  // Without a prefix, require phone-like digit groups: "532 123 45 67", "(555) 123-4567".
  const groups = candidate.split(/[\s().-]+/).filter(Boolean);
  return groups.length >= 3 && groups[0]!.length >= 3 && groups.every((g) => g.length <= 4) && digits.length <= 11;
}

/** Phone numbers in international (+90 532 123 45 67, 0044…) or national (0212 555 12 34, (555) 123-4567) formats. */
export function findPhones(text: string): Found<string>[] {
  const found: Found<string>[] = [];
  for (const m of matchesOf(PHONE_CANDIDATE_RE, text)) {
    let candidate = m[0].trim();
    // Drop an unbalanced trailing "(" or ")" picked up from surrounding text.
    if ((candidate.match(/\(/g)?.length ?? 0) !== (candidate.match(/\)/g)?.length ?? 0)) candidate = candidate.replace(/^\(|\)$/g, "");
    if (isPlausiblePhone(candidate)) {
      found.push({ value: candidate.replace(/\s+/g, " "), index: m.index, end: m.index + m[0].length });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Dates

const MONTH_NAMES: [string, number][] = [
  // English
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  // Turkish (folded)
  ["ocak", 1], ["subat", 2], ["mart", 3], ["nisan", 4], ["mayis", 5], ["haziran", 6],
  ["temmuz", 7], ["agustos", 8], ["eylul", 9], ["ekim", 10], ["kasim", 11], ["aralik", 12],
  // German
  ["januar", 1], ["jaenner", 1], ["februar", 2], ["marz", 3], ["maerz", 3], ["mai", 5], ["juni", 6],
  ["juli", 7], ["oktober", 10], ["dezember", 12],
  // French
  ["janvier", 1], ["fevrier", 2], ["mars", 3], ["avril", 4], ["juin", 6], ["juillet", 7],
  ["aout", 8], ["septembre", 9], ["octobre", 10], ["novembre", 11], ["decembre", 12],
  // Spanish
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4], ["mayo", 5], ["junio", 6], ["julio", 7],
  ["agosto", 8], ["septiembre", 9], ["setiembre", 9], ["octubre", 10], ["noviembre", 11], ["diciembre", 12],
  // Italian
  ["gennaio", 1], ["febbraio", 2], ["aprile", 4], ["maggio", 5], ["giugno", 6], ["luglio", 7],
  ["settembre", 9], ["ottobre", 10], ["dicembre", 12],
  // Dutch
  ["januari", 1], ["februari", 2], ["maart", 3], ["mei", 5], ["augustus", 8],
  // Portuguese
  ["janeiro", 1], ["fevereiro", 2], ["marco", 3], ["maio", 5], ["junho", 6], ["julho", 7],
  ["setembro", 9], ["outubro", 10], ["novembro", 11], ["dezembro", 12],
];

/** Month number from a full or abbreviated month name in any supported language ("Sep", "Eylül", "März"). */
export function monthFromName(word: string): number | undefined {
  const name = foldText(word).replace(/\.$/, "");
  if (name.length < 3) return undefined;
  let found: number | undefined;
  for (const [candidate, month] of MONTH_NAMES) {
    if (candidate === name) return month;
    if (candidate.startsWith(name)) {
      // An abbreviation must be unambiguous ("jui" could be juin or juillet).
      if (found !== undefined && found !== month) return undefined;
      found = month;
    }
  }
  return found;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return undefined;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function fullYear(year: string): number {
  const n = Number(year);
  return year.length === 2 ? (n < 50 ? 2000 + n : 1900 + n) : n;
}

export interface FoundDate extends Found<string> {
  /** "month" for month-and-year dates ("Sep 2019"), which are returned as the first of the month. */
  precision: "day" | "month";
}

type DateParser = (m: RegExpExecArray) => string | undefined;

const DATE_PATTERNS: { re: RegExp; precision: "day" | "month"; parse: DateParser }[] = [
  // 2026-09-12, 2026/09/12, 2026.09.12
  {
    re: /(?<![\d.,])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/g,
    precision: "day",
    parse: (m) => isoDate(Number(m[1]), Number(m[3]), Number(m[4])),
  },
  // 12.09.2026, 12/09/2026, 12-09-26: day first (European) unless the first number cannot be a day's month partner.
  {
    re: /(?<![\d.,])(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?!\d|[.,]\d)/g,
    precision: "day",
    parse: (m) => {
      const a = Number(m[1]);
      const b = Number(m[3]);
      const [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
      return isoDate(fullYear(m[4]!), month, day);
    },
  },
  // 12 September 2026, 12. Eylül 2026, 12-Sep-2026, 12th of March, 2026
  {
    re: /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\.?[ \t-]*(?:of[ \t]+)?(\p{L}{3,})\.?[ \t,-]*(\d{4})(?!\d)/gu,
    precision: "day",
    parse: (m) => {
      const month = monthFromName(m[2]!);
      return month ? isoDate(Number(m[3]), month, Number(m[1])) : undefined;
    },
  },
  // 15-Oct-26, 15/Oct/26: two-digit years only with explicit separators
  {
    re: /(?<![\d./-])(\d{1,2})([-/.])(\p{L}{3,})\2(\d{2})(?![\d./-])/gu,
    precision: "day",
    parse: (m) => {
      const month = monthFromName(m[3]!);
      return month ? isoDate(fullYear(m[4]!), month, Number(m[1])) : undefined;
    },
  },
  // September 12, 2026 / Sep 12 2026
  {
    re: /(?<!\p{L})(\p{L}{3,})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?,?[ \t]+(\d{4})(?!\d)/gu,
    precision: "day",
    parse: (m) => {
      const month = monthFromName(m[1]!);
      return month ? isoDate(Number(m[3]), month, Number(m[2])) : undefined;
    },
  },
  // September 2026, Eylül 2026, Sep. 2019
  {
    re: /(?<!\p{L})(\p{L}{3,})\.?,?[ \t]+(\d{4})(?!\d)/gu,
    precision: "month",
    parse: (m) => {
      const month = monthFromName(m[1]!);
      return month ? isoDate(Number(m[2]), month, 1) : undefined;
    },
  },
  // 09/2026, 09.2026
  {
    re: /(?<![\d.,/-])(\d{1,2})[./-](\d{4})(?![\d.,/-]*\d)/g,
    precision: "month",
    parse: (m) => isoDate(Number(m[2]), Number(m[1]), 1),
  },
];

/** All dates in the text (each within one line), in document order, as ISO yyyy-mm-dd; overlaps resolve to full dates. */
export function findDates(text: string): FoundDate[] {
  const candidates: FoundDate[] = [];
  for (const { re, precision, parse } of DATE_PATTERNS) {
    for (const m of matchesOf(re, text)) {
      const value = parse(m);
      if (value) candidates.push({ value, index: m.index, end: m.index + m[0].length, precision });
    }
  }
  candidates.sort((a, b) => a.index - b.index || (a.precision === b.precision ? b.end - a.end : a.precision === "day" ? -1 : 1));
  const result: FoundDate[] = [];
  for (const candidate of candidates) {
    const overlapping = result.findIndex((r) => candidate.index < r.end && r.index < candidate.end);
    if (overlapping < 0) result.push(candidate);
    else if (result[overlapping]!.precision === "month" && candidate.precision === "day") result[overlapping] = candidate;
  }
  return result;
}

/** First date in a string as ISO yyyy-mm-dd (full dates preferred over month-and-year), or null. */
export function parseDateToIso(text: string): string | null {
  const dates = findDates(text);
  return (dates.find((d) => d.precision === "day") ?? dates[0])?.value ?? null;
}

// ---------------------------------------------------------------------------
// Numbers and amounts

export type DecimalSeparator = "," | ".";

export interface FoundNumber extends Found<number> {
  raw: string;
  decimals: number;
  percent: boolean;
  currency?: string;
}

function isGrouped(integer: string, separator: string): boolean {
  const parts = integer.split(separator);
  return parts.length > 1 && /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * Parse one numeric token with either convention: "1,234.56" and "1.234,56"
 * (the last separator is the decimal one), "12,5", "1'234.50". A lone separator
 * followed by exactly three digits ("1.234") is a thousands separator unless the
 * document's decimal separator says otherwise.
 */
function parseNumberToken(token: string, decimalSeparator?: DecimalSeparator): { value: number; decimals: number } | undefined {
  let t = token.replace(/['’]/g, "");
  let sign = 1;
  if (t.startsWith("-") || t.startsWith("−")) {
    sign = -1;
    t = t.slice(1);
  }
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let integer = t;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const at = Math.max(lastDot, lastComma);
    if (!isGrouped(t.slice(0, at), decimal === "." ? "," : ".")) return undefined;
    integer = t.slice(0, at).replace(/[.,]/g, "");
    fraction = t.slice(at + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? "." : ",";
    const parts = t.split(separator);
    if (parts.length > 2) {
      if (!isGrouped(t, separator)) return undefined;
      integer = parts.join("");
    } else {
      const [head, tail] = parts as [string, string];
      const looksGrouped = tail.length === 3 && head.length <= 3 && !head.startsWith("0");
      if (looksGrouped && decimalSeparator !== separator) integer = head + tail;
      else [integer, fraction] = [head, tail];
    }
  }
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction)) return undefined;
  const value = sign * Number(`${integer}.${fraction || "0"}`);
  return Number.isFinite(value) ? { value, decimals: fraction.length } : undefined;
}

const CURRENCIES: [string, RegExp][] = [
  ["TRY", /₺|\bTL\b|\bTRY\b|\bYTL\b/g],
  ["EUR", /€|\bEUR\b|\bEuro\b/gi],
  ["USD", /\$|\bUSD\b/g],
  ["GBP", /£|\bGBP\b/g],
  ["CHF", /\bCHF\b/g],
  ["JPY", /¥|\bJPY\b/g],
];

/** The currency mentioned most often (ISO 4217 code), e.g. "TL"/"₺" → "TRY". */
export function detectCurrency(text: string): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [code, re] of CURRENCIES) {
    const count = text.match(re)?.length ?? 0;
    if (count > bestCount) [best, bestCount] = [code, count];
  }
  return best;
}

const NUMBER_TOKEN_RE = /[-−]?\d(?:[\d.,'’]*\d)?/g;
const CURRENCY_BEFORE = /(?:[\p{Sc}]|\b(?:TL|TRY|EUR|USD|GBP|CHF)\b)\s?$/u;
const CURRENCY_AFTER = /^\s?(?:[\p{Sc}]|(?:TL|TRY|EUR|USD|GBP|CHF)\b)/u;

/**
 * Numbers in the text with context: percentages and adjacent currency markers are
 * flagged; tokens glued to letters (identifiers such as INV-2026 or A4) and
 * date-like tokens are skipped.
 */
export function findNumbers(text: string, decimalSeparator?: DecimalSeparator): FoundNumber[] {
  const found: FoundNumber[] = [];
  for (const m of matchesOf(NUMBER_TOKEN_RE, text)) {
    const raw = m[0];
    const index = m.index;
    const end = index + raw.length;
    if (index > 0 && /[\p{L}\p{N}_]/u.test(text[index - 1]!)) continue;
    const after = text.slice(end, end + 5);
    if (/^\p{L}/u.test(after) && !CURRENCY_AFTER.test(after)) continue;
    const parsed = parseNumberToken(raw, decimalSeparator);
    if (!parsed) continue;
    const before = text.slice(Math.max(0, index - 5), index);
    const currencyText = CURRENCY_BEFORE.exec(before)?.[0] ?? CURRENCY_AFTER.exec(after)?.[0];
    found.push({
      value: parsed.value,
      index,
      end,
      raw,
      decimals: parsed.decimals,
      percent: /^\s?%/.test(after) || /%\s?$/.test(before),
      ...(currencyText ? { currency: detectCurrency(currencyText) } : {}),
    });
  }
  return found;
}

/**
 * The document's decimal separator, from unambiguous evidence such as
 * "12.345,67" / "1.234,5" (comma) versus "12,345.67" / "10.50" (dot).
 */
export function detectDecimalSeparator(text: string): DecimalSeparator | undefined {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const comma = count(/\d\.\d{3},\d{1,2}(?!\d)/g) + count(/(?<![\d.,])\d+,\d{2}(?![\d.,]*\d)/g);
  const dot = count(/\d,\d{3}\.\d{1,2}(?!\d)/g) + count(/(?<![\d.,])\d+\.\d{2}(?![\d.,]*\d)/g);
  if (comma === dot) return undefined;
  return comma > dot ? "," : ".";
}

/** The amount in a snippet: prefers money-like numbers (currency or two decimals) over counts and percentages. */
export function pickAmount(numbers: FoundNumber[], wantPercent = false): number | undefined {
  const candidates = numbers.filter((n) => n.percent === wantPercent);
  return (candidates.find((n) => n.currency || n.decimals === 2) ?? candidates[0])?.value;
}

/** First amount in a string ("12.345,67 TL" → 12345.67, "$1,234.50" → 1234.5), or null. */
export function parseAmount(text: string, decimalSeparator?: DecimalSeparator): number | null {
  return pickAmount(findNumbers(text, decimalSeparator ?? detectDecimalSeparator(text))) ?? null;
}

// ---------------------------------------------------------------------------
// IBAN

const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{0,4}/gi;

export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Checksum-valid IBANs in compact form ("TR33 0006 1005 …" → "TR330006100…"). */
export function findIbans(text: string): Found<string>[] {
  const found: Found<string>[] = [];
  for (const m of matchesOf(IBAN_CANDIDATE_RE, text)) {
    const compact = m[0].replace(/ /g, "").toUpperCase();
    // The candidate pattern may run into a following word; the checksum finds the real end.
    for (let length = Math.min(compact.length, 34); length >= 15; length--) {
      if (isValidIban(compact.slice(0, length))) {
        found.push({ value: compact.slice(0, length), index: m.index, end: m.index + m[0].length });
        break;
      }
    }
  }
  return found;
}
