import type { FieldOption, FieldSpec } from "@enterprise-brain/core";
import { DocIndex, type LabelHit } from "./doc-index.ts";
import { groupForKey, normalizeKey, type TermGroup } from "./lexicon.ts";
import { escapeRegExp, foldText } from "./text.ts";
import {
  detectCurrency,
  findDates,
  findEmails,
  findIbans,
  findNumbers,
  findPhones,
  findUrls,
  parseDateToIso,
  pickAmount,
} from "./values.ts";

/**
 * Offline field extraction (used when no LLM is configured): best-effort values
 * for each FieldSpec from labels ("Invoice No: …", "Fatura No: …"), CV section
 * headings, typed patterns (emails, phones, dates, amounts, IBANs) and layout
 * cues. `hints` are tried first as labels/headings. Missing values are null.
 * Never throws.
 */
export function heuristicExtract(text: string, fields: FieldSpec[]): Record<string, unknown> {
  let index: DocIndex;
  try {
    index = new DocIndex(typeof text === "string" ? text : "");
  } catch {
    index = new DocIndex("");
  }
  return extractFields(index, Array.isArray(fields) ? fields : [], 0);
}

const MAX_DEPTH = 4;

interface Context {
  index: DocIndex;
  field: FieldSpec;
  group: TermGroup | undefined;
  /** Hints, label, key and lexicon synonyms. */
  terms: string[];
  /** Hints, label and key only. */
  ownTerms: string[];
  depth: number;
}

function extractFields(index: DocIndex, fields: FieldSpec[], depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field || typeof field.key !== "string") continue;
    try {
      const group = groupForKey(field.key);
      const value = extractField({ index, field, group, terms: termsFor(field, group), ownTerms: termsFor(field, undefined), depth });
      result[field.key] = value === undefined || value === "" ? null : value;
    } catch {
      result[field.key] = null;
    }
  }
  return result;
}

/** Labels that locate a field, most specific first: hints, label, key, then lexicon synonyms (EN/TR). */
function termsFor(field: FieldSpec, group: TermGroup | undefined): string[] {
  const terms = [...(field.hints ?? []), field.label ?? "", normalizeKey(field.key).replace(/_/g, " "), ...(group?.terms ?? [])];
  return [...new Set(terms.map((term) => (typeof term === "string" ? term.trim() : "")).filter((term) => term.length >= 2))];
}

function extractField(ctx: Context): unknown {
  switch (ctx.field.type) {
    case "email":
      return extractEmail(ctx);
    case "phone":
      return extractPhone(ctx);
    case "url":
      return extractUrl(ctx);
    case "date":
      return extractDate(ctx);
    case "number":
      return extractNumber(ctx);
    case "integer": {
      const value = extractNumber(ctx);
      return value === undefined ? undefined : Math.round(value);
    }
    case "boolean":
      return extractBoolean(ctx);
    case "select":
      return extractSelect(ctx);
    case "multiselect":
      return extractMultiselect(ctx);
    case "string":
      return extractString(ctx);
    case "text":
      return extractText(ctx);
    case "list":
      return extractList(ctx);
    case "object":
      return extractObject(ctx);
    default:
      return undefined;
  }
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

// ---------------------------------------------------------------------------
// Labels

const CURRENCY_CODE_START = /^(?:TL|TRY|EUR|USD|GBP|CHF)\b/;

/**
 * Parse a typed value after each label occurrence: from the rest of its line, a
 * table cell, or the line below a label that stands alone. `rest` still holds
 * qualifiers between label and separator, such as the rate in "KDV (%20): 2.057,61".
 * A label followed directly by a word ("Total VAT: 20" for "total") is a
 * different label and is skipped.
 */
function fromLabels<T>(ctx: Context, parse: (value: string, rest: string) => T | undefined): T | undefined {
  for (const hit of ctx.index.labelHits(ctx.terms)) {
    if (hit.orphanHeaderCell) continue;
    let value: string | undefined = hit.cellValue;
    let rest = value;
    if (value === undefined) {
      if (!hit.separator && /^\p{L}/u.test(hit.value) && !CURRENCY_CODE_START.test(hit.value)) continue;
      if (hit.value) [value, rest] = [hit.value, hit.rest];
      else if (hit.atLineStart) value = rest = ctx.index.nextValueLine(hit.line);
    }
    const parsed = value !== undefined && rest !== undefined ? parse(value, rest) : undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// Another "Label:" inside a value ("FTR-2026-0042 Tarih: 12.09.2026"), a table cell border or a column gap ends it.
const NEXT_LABEL = /\s{2,}|\t|\s\|\s|\s(?=[\p{Lu}][\p{L}.'-]*(?:\s[\p{L}.'-]+){0,3}\s?[:：]\s)/u;

function cutAtNextLabel(value: string): string {
  const match = NEXT_LABEL.exec(value);
  return (match ? value.slice(0, match.index) : value).trim();
}

function cleanValue(value: string): string | undefined {
  const cleaned = value
    .replace(/^[\s:：#|=–—-]+/, "")
    .replace(/[\s,;|]+$/, "")
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

/** Identifier-like fields: the value is the first token that contains a digit (plus digit groups after it). */
const ID_GROUPS = new Set(["invoice_number", "tax_id", "po_number", "account_number", "document_number", "delivery_note_number"]);

function identifierIn(value: string): string | undefined {
  return /[^\s\d]*\d\S*(?:\s\d+(?=\s|$))*/.exec(value)?.[0].replace(/[,;.]+$/, "");
}

function labeledValue(hit: LabelHit, ctx: Context, options: { cut: boolean; multiline: boolean }): string | undefined {
  if (hit.orphanHeaderCell) return undefined;
  if (hit.cellValue !== undefined) return cleanValue(hit.cellValue);
  if (!hit.value) {
    // A label on its own line ("Bill To") with the value below it.
    if (!hit.atLineStart) return undefined;
    if (!options.multiline) return cleanValue(ctx.index.nextValueLine(hit.line) ?? "");
    const lines: string[] = [];
    for (let j = hit.line + 1; j < ctx.index.lines.length && lines.length < 6; j++) {
      const text = ctx.index.lines[j]!.text.trim();
      if (!text || ctx.index.isHeadingLine(j) || (lines.length > 0 && /^[\p{L}][\p{L}\s.'/()-]{0,40}[:：]/u.test(text))) break;
      lines.push(text);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }
  const isId = ID_GROUPS.has(ctx.group?.id ?? "");
  // Without ":" etc. only identifiers count ("Invoice Number INV-2026-001" in PDF text); prose does not.
  if (!hit.separator && !(isId && hit.atLineStart && /\d/.test(hit.value.split(/\s+/)[0] ?? ""))) return undefined;
  const value = options.cut ? cutAtNextLabel(hit.value) : hit.value;
  return isId ? (identifierIn(value) ?? cleanValue(value)) : cleanValue(value);
}

function labeledString(ctx: Context, options = { cut: true, multiline: false }): string | undefined {
  for (const hit of ctx.index.labelHits(ctx.terms)) {
    const value = labeledValue(hit, ctx, options);
    if (value) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Typed fields

/** Key tokens that only restate the type ("contact_email", "website_url") and so do not narrow a search. */
const GENERIC_KEY_TOKENS = new Set([
  ...["url", "link", "links", "website", "web", "site", "profile", "page"],
  ...["address", "email", "mail", "contact", "phone", "number"],
]);
const SOCIAL_SITES = ["linkedin", "github", "gitlab", "twitter", "facebook", "instagram", "behance", "dribbble", "medium", "youtube", "xing"];

function keyTokens(field: FieldSpec): string[] {
  return normalizeKey(field.key).split("_").filter((token) => token && !GENERIC_KEY_TOKENS.has(token));
}

function extractEmail(ctx: Context): string | undefined {
  return fromLabels(ctx, (value) => findEmails(value)[0]?.value) ?? findEmails(ctx.index.text)[0]?.value;
}

function extractPhone(ctx: Context): string | undefined {
  // After a phone label, an unformatted number ("Tel: 2125551234") is accepted too.
  const labeled = fromLabels(ctx, (value) => findPhones(value)[0]?.value ?? /^(?:\+|00)?\d{7,15}\b/.exec(value)?.[0]);
  return labeled ?? findPhones(ctx.index.text)[0]?.value;
}

function extractUrl(ctx: Context): string | undefined {
  const labeled = fromLabels(ctx, (value) => {
    const url = findUrls(value)[0]?.value;
    if (url) return url;
    // After a website label, a bare domain ("janedoe.dev") counts as a URL.
    const domain = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.exec(value)?.[0];
    return domain ? `https://${domain}` : undefined;
  });
  if (labeled) return labeled;
  const urls = findUrls(ctx.index.text).map((url) => url.value);
  const sites = keyTokens(ctx.field).filter((token) => SOCIAL_SITES.includes(token));
  // "linkedin_url" must be a LinkedIn link; a generic "website" prefers a non-social link.
  if (sites.length > 0) return urls.find((url) => sites.some((site) => url.toLowerCase().includes(site)));
  const isSocial = (url: string) => SOCIAL_SITES.some((site) => url.toLowerCase().includes(`${site}.`));
  return urls.find((url) => !isSocial(url)) ?? urls[0];
}

/** Date fields that may fall back to the document's first date ("date", "invoice_date"), unlike "due_date". */
const GENERIC_DATE_TOKENS = new Set(["date", "document", "invoice", "issue", "issued", "receipt", "order", "statement", "letter", "report", "created", "tarih", "tarihi", "fatura", "belge"]);

function extractDate(ctx: Context): string | undefined {
  const labeled = fromLabels(ctx, (value) => parseDateToIso(value) ?? undefined);
  if (labeled) return labeled;
  const tokens = normalizeKey(ctx.field.key).split("_");
  if (tokens.every((token) => GENERIC_DATE_TOKENS.has(token))) {
    return findDates(ctx.index.text).find((date) => date.precision === "day")?.value;
  }
  return undefined;
}

function extractNumber(ctx: Context): number | undefined {
  const wantPercent = /(?:^|_)(?:rate|percent|percentage|pct|ratio|oran|orani|yuzde)(?:_|$)/.test(normalizeKey(ctx.field.key));
  const parse = (segment: string): number | undefined => {
    const numbers = findNumbers(segment, ctx.index.decimalSeparator);
    return pickAmount(numbers, wantPercent) ?? (wantPercent ? pickAmount(numbers) : undefined);
  };
  const labeled = fromLabels(ctx, (_value, rest) => parse(rest));
  if (labeled !== undefined) return labeled;
  // A count before the field's own label or hint: "8 years of experience", "5 yıl deneyim".
  for (const hit of ctx.index.labelHits(ctx.ownTerms)) {
    const before = ctx.index.text.slice(ctx.index.lines[hit.line]!.start, hit.index);
    const count = /(\d+(?:[.,]\d+)?)\+?\s*$/.exec(before)?.[1];
    if (count) return parse(count);
  }
  return undefined;
}

const TRUE_VALUE = /^(?:yes|y|true|evet|var|mevcut|x|✓|✔|☑|☒|ja|oui|si|sí|sim)(?![\p{L}\p{N}])/iu;
const FALSE_VALUE = /^(?:no|n|false|hayır|hayir|yok|none|nein|non|não|nao|☐|n\/a)(?![\p{L}\p{N}])/iu;

function parseBoolean(value: string): boolean | undefined {
  const text = value.trim();
  if (TRUE_VALUE.test(text)) return true;
  if (FALSE_VALUE.test(text)) return false;
  return undefined;
}

/** A labeled yes/no answer; a bare mention counts as true unless negated ("no driving licence"). */
function extractBoolean(ctx: Context): boolean | undefined {
  for (const hit of ctx.index.labelHits(ctx.terms)) {
    const value = hit.cellValue ?? (hit.value || ctx.index.nextValueLine(hit.line) || "");
    const parsed = parseBoolean(value);
    if (parsed !== undefined) return parsed;
    const before = ctx.index.folded.slice(ctx.index.lines[hit.line]!.start, hit.index);
    return !/(?:^|\s)(?:no|not|without|non|yok|degil|olmayan)\s*$/.test(before);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Options

function optionVariants(option: FieldOption): string[] {
  const variants = [option.label ?? "", option.value, option.value.replace(/[_-]+/g, " ")];
  return unique(variants.map((v) => foldText(v).trim()).filter((v) => v.length >= 2));
}

function mentionIndex(foldedText: string, foldedTerm: string): number {
  const words = foldedTerm.split(/\s+/).map(escapeRegExp).join("[\\s_-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "u").exec(foldedText)?.index ?? -1;
}

/** The option that equals the text, else the option mentioned earliest (variants shorter than `minLength` are ignored). */
function matchOption(text: string, options: FieldOption[], minLength = 2): FieldOption | undefined {
  const folded = foldText(text).trim();
  const exact = options.find((option) => optionVariants(option).includes(folded));
  if (exact) return exact;
  let best: { option: FieldOption; index: number } | undefined;
  for (const option of options) {
    for (const variant of optionVariants(option)) {
      if (variant.length < minLength) continue;
      const index = mentionIndex(folded, variant);
      if (index >= 0 && (!best || index < best.index)) best = { option, index };
    }
  }
  return best?.option;
}

function isCurrencyField(ctx: Context): boolean {
  const options = ctx.field.options ?? [];
  return ctx.group?.id === "currency" || (options.length > 0 && options.every((option) => /^[A-Z]{3}$/.test(option.value)));
}

function extractCurrency(ctx: Context): string | undefined {
  const labeled = labeledString(ctx);
  if (labeled) return detectCurrency(labeled) ?? (/^[A-Z]{3}$/i.test(labeled) ? labeled.toUpperCase() : labeled);
  return detectCurrency(ctx.index.text);
}

function extractSelect(ctx: Context): string | undefined {
  const options = ctx.field.options ?? [];
  if (options.length === 0) return extractString(ctx);
  if (isCurrencyField(ctx)) {
    const code = extractCurrency(ctx);
    const option = code ? matchOption(code, options) : undefined;
    if (option) return option.value;
  }
  const labeled = fromLabels(ctx, (value) => matchOption(value, options)?.value);
  if (labeled) return labeled;
  return matchOption(ctx.index.text, options, 3)?.value;
}

/** Options mentioned in the field's section or labeled line, else anywhere in the text. */
function extractMultiselect(ctx: Context): string[] | undefined {
  const options = ctx.field.options ?? [];
  if (options.length === 0) return extractStringList(ctx);
  const section = ctx.index.findSection(ctx.terms);
  const scope = section ? ctx.index.sectionLines(section).join("\n") : (labeledString(ctx, { cut: false, multiline: true }) ?? ctx.index.text);
  const folded = foldText(scope);
  const values = options
    .filter((option) => optionVariants(option).some((variant) => variant.length >= 3 && mentionIndex(folded, variant) >= 0))
    .map((option) => option.value);
  return nonEmpty(values);
}

// ---------------------------------------------------------------------------
// Strings, names and layout cues

const LEGAL_FORMS = ["ltd", "limited", "inc", "llc", "llp", "plc", "gmbh", "ag", "kg", "sa", "sas", "srl", "spa", "bv", "nv", "corp"];
const COMPANY_WORDS = ["corporation", "company", "co", "holding", "group", "a\\.?s", "sti", "sirketi"];
/** A legal-form suffix at the end of a (folded) name: "ACME Yazılım A.Ş.", "Beta Ltd. Şti.", "Acme GmbH". */
const COMPANY_SUFFIX = new RegExp(`(?:^|\\s)(?:${[...LEGAL_FORMS, ...COMPANY_WORDS].join("|")})\\.?,?$`);

const ROLES_EN = [
  "engineer", "developer", "manager", "director", "consultant", "analyst", "designer", "specialist", "architect", "officer",
  "assistant", "intern", "lead", "head", "scientist", "accountant", "administrator", "coordinator", "executive", "president",
  "founder", "owner", "associate", "representative", "technician", "teacher", "nurse", "lawyer", "attorney",
];
// Turkish (folded) role stems take suffixes: "mühendisi", "uzmanı", "müdürü".
const ROLES_TR = ["muhendis", "gelistirici", "uzman", "mudur", "yonetici", "danisman", "analist", "tasarimci", "sorumlu", "asistan", "stajyer", "ogretmen", "avukat"];
/** Job-title words: a headline such as "Senior Software Engineer" is not a person's name. */
const ROLE_WORDS = new RegExp(`(?:^|\\s)(?:${[...ROLES_EN, ...ROLES_TR.map((stem) => `${stem}\\w*`)].join("|")})(?=\\s|$)`);
const DOCUMENT_TITLES = /^(?:curriculum vitae|cv|resume|ozgecmis|personal information|kisisel bilgiler|contact|iletisim|profile|profil|invoice|fatura)$/;
const NAME_PARTICLES = new Set(["van", "von", "der", "den", "de", "da", "di", "del", "della", "dos", "das", "du", "la", "le", "bin", "binti", "ibn", "al", "el", "ter", "ten", "y"]);

function looksLikePersonName(text: string, labeled = false): boolean {
  const value = text.trim().replace(/,$/, "");
  if (value.length < (labeled ? 2 : 4) || value.length > 60 || /[\d@:/\\|()[\]{}]/.test(value)) return false;
  const folded = foldText(value);
  if (DOCUMENT_TITLES.test(folded) || ROLE_WORDS.test(folded) || COMPANY_SUFFIX.test(folded)) return false;
  const words = value.split(/\s+/);
  if (words.length > 5 || (!labeled && words.length < 2)) return false;
  let capitalized = 0;
  for (const word of words) {
    if (NAME_PARTICLES.has(word.toLowerCase())) continue;
    if (!/^[\p{Lu}][\p{L}'’.-]*$/u.test(word)) return false;
    capitalized++;
  }
  return capitalized >= (labeled ? 1 : 2);
}

/** Segments of a header line such as "Jane Doe | Senior Engineer | jane@x.com". */
function lineSegments(line: string): string[] {
  return line
    .split(/\s[|•·]\s|\s{2,}|\t/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function topLines(index: DocIndex, count: number): { text: string; line: number }[] {
  const result: { text: string; line: number }[] = [];
  for (let i = 0; i < index.lines.length && result.length < count; i++) {
    const text = index.lines[i]!.text.trim();
    if (text) result.push({ text, line: i });
  }
  return result;
}

/** A CV usually starts with the candidate's name: the first name-like line near the top. */
function nameAtTop(index: DocIndex): { text: string; line: number } | undefined {
  for (const { text, line } of topLines(index, 12)) {
    const first = lineSegments(text)[0];
    if (first && looksLikePersonName(first)) return { text: first, line };
  }
  return undefined;
}

function labeledPersonName(ctx: Context): string | undefined {
  for (const hit of ctx.index.labelHits(ctx.terms)) {
    // "Company Name: …" must not count as a person's name: only labels that start their line.
    if (!hit.atLineStart) continue;
    const value = labeledValue(hit, ctx, { cut: true, multiline: false });
    if (value && looksLikePersonName(value, true)) return value;
  }
  return undefined;
}

/** The headline under a CV's name ("Senior Software Engineer"). */
function headlineAfterName(index: DocIndex): string | undefined {
  const name = nameAtTop(index);
  if (!name) return undefined;
  const plausible = (text: string) =>
    text.length <= 80 && text.split(/\s+/).length <= 8 && !/[\d@]|https?:|www\./i.test(text) && !/[:：]/.test(text);
  const sameLine = lineSegments(index.lines[name.line]!.text.trim())[1];
  if (sameLine && plausible(sameLine)) return sameLine;
  for (let j = name.line + 1; j < Math.min(index.lines.length, name.line + 3); j++) {
    const text = index.lines[j]!.text.trim();
    if (!text) continue;
    const first = lineSegments(text)[0] ?? "";
    return !index.isHeadingLine(j) && plausible(first) ? first : undefined;
  }
  return undefined;
}

/** Invoices and letters usually start with the issuing company. */
function companyAtTop(index: DocIndex): string | undefined {
  for (const { text } of topLines(index, 6)) {
    const segment = lineSegments(text).find((s) => COMPANY_SUFFIX.test(foldText(s)));
    if (segment) return cleanValue(segment);
  }
  return undefined;
}

function extractIban(ctx: Context): string | undefined {
  const labeled = fromLabels(ctx, (value) => findIbans(value)[0]?.value);
  if (labeled) return labeled;
  const anywhere = findIbans(ctx.index.text)[0]?.value;
  if (anywhere) return anywhere;
  // A labeled IBAN that fails the checksum (a typo or OCR error) is still better than nothing.
  const raw = labeledString(ctx);
  return raw && /^[A-Z]{2}\d{2}[A-Z0-9 ]{11,40}$/i.test(raw) ? raw.replace(/\s+/g, "").toUpperCase() : undefined;
}

function extractString(ctx: Context): string | undefined {
  switch (ctx.group?.id) {
    case "email":
      return extractEmail(ctx);
    case "phone":
      return extractPhone(ctx);
    case "website":
    case "linkedin":
      return extractUrl(ctx);
    case "iban":
      return extractIban(ctx);
    case "currency":
      return extractCurrency(ctx);
    case "name":
      return labeledPersonName(ctx) ?? nameAtTop(ctx.index)?.text;
  }
  const labeled = labeledString(ctx);
  if (labeled) return labeled;
  switch (ctx.group?.id) {
    case "job_title":
      return headlineAfterName(ctx.index);
    case "supplier":
    case "company":
    case "merchant":
      return companyAtTop(ctx.index);
  }
  const section = ctx.index.findSection(ctx.terms);
  return section ? cleanValue(ctx.index.sectionLines(section).join(" ")) : undefined;
}

function extractText(ctx: Context): string | undefined {
  const section = ctx.index.findSection(ctx.terms);
  if (section) {
    const body = ctx.index.sectionLines(section).join("\n").trim();
    if (body) return body;
  }
  return labeledString(ctx, { cut: false, multiline: true });
}

// ---------------------------------------------------------------------------
// Lists and objects

const BULLET = /^(?:[-–—*•·▪◦‣○●■□✓✔➢➤>]+\s*|\(?\d{1,2}[.)]\s+|[a-z][.)]\s+)/u;

function splitOutsideBrackets(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of line) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && ",;•·|".includes(ch)) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** List items from bullet lines and comma/semicolon/bullet-separated lines ("Tools: Docker, Kubernetes"). */
function splitListItems(lines: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    let line = raw.trim().replace(BULLET, "");
    const labeled = /^([^:：]{1,30})[:：]\s+(.+)$/u.exec(line);
    if (labeled && !/\d/.test(labeled[1]!)) line = labeled[2]!;
    for (const part of splitOutsideBrackets(line)) {
      const item = part.trim().replace(BULLET, "").replace(/[.;,]+$/, "").trim();
      const key = foldText(item);
      if (item && !seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }
  return items.slice(0, 200);
}

function extractStringList(ctx: Context): string[] | undefined {
  const section = ctx.index.findSection(ctx.terms);
  if (section) return splitListItems(ctx.index.sectionLines(section));
  const labeled = labeledString(ctx, { cut: false, multiline: true });
  return labeled ? splitListItems(labeled.split("\n")) : undefined;
}

function extractList(ctx: Context): unknown[] | undefined {
  if (ctx.field.fields?.length) return extractObjectList(ctx);
  const itemType = ctx.field.itemType ?? "string";
  const section = ctx.index.findSection(ctx.terms);
  const scope = section ? ctx.index.sectionLines(section).join("\n") : undefined;
  const text = scope ?? ctx.index.text;
  switch (itemType) {
    case "email":
      return nonEmpty(unique(findEmails(text).map((found) => found.value)));
    case "phone":
      return nonEmpty(unique(findPhones(text).map((found) => found.value)));
    case "url":
      return nonEmpty(unique(findUrls(text).map((found) => found.value)));
    case "date":
      return nonEmpty(unique(findDates(text).map((found) => found.value)));
    case "number":
    case "integer": {
      if (scope === undefined) return undefined;
      const values = findNumbers(scope, ctx.index.decimalSeparator).map((n) => (itemType === "integer" ? Math.round(n.value) : n.value));
      return nonEmpty(values);
    }
    case "select":
    case "multiselect":
      return extractMultiselect(ctx);
    case "string":
    case "text":
      return extractStringList(ctx);
    default:
      return undefined;
  }
}

const YEAR = /\b(?:19|20)\d{2}\b/;

/** Entries of a section: blank-line separated blocks, or a new block at each non-bullet line with a date. */
function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    if (current.length > 0 && !BULLET.test(line) && YEAR.test(line) && current.some((l) => YEAR.test(l))) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function extractObjectList(ctx: Context): Record<string, unknown>[] {
  if (ctx.depth >= MAX_DEPTH) return [];
  const section = ctx.index.findSection(ctx.terms);
  if (!section) return [];
  return splitBlocks(ctx.index.sectionLines(section))
    .map((block) => extractFields(new DocIndex(block.join("\n")), ctx.field.fields ?? [], ctx.depth + 1))
    .filter((item) => Object.values(item).some(hasValue));
}

function extractObject(ctx: Context): Record<string, unknown> | undefined {
  if (ctx.depth >= MAX_DEPTH) return undefined;
  const section = ctx.index.findSection(ctx.terms);
  const scope = section ? new DocIndex(ctx.index.sectionLines(section).join("\n")) : ctx.index;
  const value = extractFields(scope, ctx.field.fields ?? [], ctx.depth + 1);
  return Object.values(value).some(hasValue) ? value : undefined;
}
