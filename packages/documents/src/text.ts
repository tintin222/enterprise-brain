/** Text decoding, normalization and markup stripping shared by the extractors and heuristics. */

/**
 * Decode bytes to a string: BOM-aware UTF-8/UTF-16, then strict UTF-8, then
 * Windows-1254 for legacy 8-bit files. Windows-1254 differs from Windows-1252
 * only in a handful of rare letters (Ð Ý Þ ð ý þ Ž ž), so Western European text
 * decodes identically while legacy Turkish exports (ğ ı ş İ) stay readable.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try {
    // The UTF-8 decoder strips a leading BOM by default.
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder("windows-1254").decode(data);
    } catch {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
    }
  }
}

/** Heuristic binary check on the first 8 KB: NUL bytes or many control characters mean "not text". */
export function looksLikeText(data: Uint8Array): boolean {
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return true;
  const sample = data.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control <= sample.length * 0.05;
}

/**
 * Canonical whitespace: LF line endings, no control/zero-width characters, NBSPs
 * as spaces, no trailing spaces, at most one blank line in a row.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f\u200b\ufeff]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Letters and digits: a rough measure of how much real text a string holds. */
export function countMeaningfulChars(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const foldCache = new Map<string, string>();

function foldChar(ch: string): string {
  let folded = foldCache.get(ch);
  if (folded === undefined) {
    const base = ch === "ı" ? "i" : ch.normalize("NFD").replace(/\p{M}+/gu, "");
    folded = base.length === 1 ? base.toLowerCase() : ch.toLowerCase();
    if (folded.length !== 1) folded = ch;
    foldCache.set(ch, folded);
  }
  return folded;
}

/**
 * Lowercase and strip diacritics ("Özgeçmiş" → "ozgecmis", "İ"/"ı" → "i") while
 * keeping the string length unchanged, so match offsets in the folded text map
 * straight back to the original. Used for accent-insensitive keyword matching.
 */
export function foldText(text: string): string {
  return text.replace(/[^\x00-\x7f]/g, foldChar).toLowerCase();
}

const COMBINING_BY_ENTITY_SUFFIX: Record<string, string> = {
  grave: "\u0300",
  acute: "\u0301",
  circ: "\u0302",
  tilde: "\u0303",
  uml: "\u0308",
  ring: "\u030a",
  cedil: "\u0327",
  caron: "\u030c",
  breve: "\u0306",
  dot: "\u0307",
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  micro: "µ",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  szlig: "ß",
  aelig: "æ",
  AElig: "Æ",
  oelig: "œ",
  OElig: "Œ",
  oslash: "ø",
  Oslash: "Ø",
  eth: "ð",
  ETH: "Ð",
  thorn: "þ",
  THORN: "Þ",
  imath: "ı",
  inodot: "ı",
  iexcl: "¡",
  iquest: "¿",
};

function namedEntity(name: string): string | undefined {
  const direct = NAMED_ENTITIES[name];
  if (direct !== undefined) return direct;
  // Accented letters (&eacute; &ccedil; &scedil; &gbreve; &Idot; ...) are composed from base + combining mark.
  const match = /^([a-zA-Z])(grave|acute|circ|tilde|uml|ring|cedil|caron|breve|dot)$/.exec(name);
  if (!match) return undefined;
  return `${match[1]}${COMBINING_BY_ENTITY_SUFFIX[match[2]!]}`.normalize("NFC");
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (entity, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : entity;
    }
    return namedEntity(body) ?? entity;
  });
}

// Paragraph-level blocks are separated by a blank line; rows and list items start a new line.
const PARAGRAPH_TAGS = "p|h[1-6]|ul|ol|dl|table|blockquote|pre|figure|section|article|header|footer|nav|aside|main|form|fieldset|address|details|hr";
const LINE_TAGS = "div|tr|dt|dd|caption|figcaption|legend|summary";

/** Trim spaces and table-cell pipes from both ends (a loop, not a regex, to stay linear on long runs). */
function trimCellBorders(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === " " || line[start] === "|")) start++;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "|")) end--;
  return line.slice(start, end);
}

/** Collapse whitespace per line and drop empty cell separators left behind by tables. */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => trimCellBorders(line.replace(/[ \t\u00a0]+/g, " ")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain text from HTML: drops scripts/styles/comments, keeps block structure as
 * line breaks, renders list items as "- item" and table rows as "a | b | c".
 */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Keep each table row on one line: block tags inside a cell become spaces. The cell body stops at
  // the next cell or row tag, so omitted </td> tags (valid HTML) cannot make the scan quadratic.
  const blockInCell = new RegExp(`<\\/?(?:${PARAGRAPH_TAGS}|${LINE_TAGS}|br|li)\\b[^>]*>`, "gi");
  const cell = /<(td|th)\b[^>]*>((?:(?!<\/?t[dhr]\b)[\s\S]){0,20000}?)<\/\1\s*>/gi;
  s = s.replace(cell, (_cell, _tag: string, inner: string) => ` ${inner.replace(blockInCell, " ")} |`).replace(/<t[dh]\b[^>]*>/gi, " | ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(new RegExp(`<\\/?(?:${PARAGRAPH_TAGS})\\b[^>]*>`, "gi"), "\n\n")
    .replace(new RegExp(`<(?:${LINE_TAGS})\\b[^>]*>|<\\/div\\s*>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");
  let text = tidyLines(decodeHtmlEntities(s));
  const cleanTitle = title ? tidyLines(decodeHtmlEntities(title.replace(/<[^>]*>/g, ""))) : "";
  if (cleanTitle && !text.startsWith(cleanTitle)) text = text ? `${cleanTitle}\n\n${text}` : cleanTitle;
  return text;
}

/**
 * Plain text from XML: leaf elements become "Name: value" lines (namespace
 * prefixes dropped), which keeps e-invoice (UBL) and export files readable.
 */
export function xmlToText(xml: string): string {
  const s = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, content: string) => content.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/[\w.:-]+>/g, (_m, name: string, value: string) =>
      value.trim() ? `\n${name}: ${value.trim()}\n` : "\n",
    )
    .replace(/<[^>]*>/g, "\n");
  // XML has no paragraphs: one element per line.
  return tidyLines(decodeHtmlEntities(s)).replace(/\n{2,}/g, "\n");
}
