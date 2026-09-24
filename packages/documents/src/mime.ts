import { looksLikeText } from "./text.ts";

export const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  cfb: "application/x-cfb",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  text: "text/plain",
  markdown: "text/markdown",
  html: "text/html",
  xhtml: "application/xhtml+xml",
  json: "application/json",
  xml: "application/xml",
  rtf: "application/rtf",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  bmp: "image/bmp",
  heic: "image/heic",
  zip: "application/zip",
  octet: "application/octet-stream",
} as const;

const EXTENSION_MIME: Record<string, string> = {
  pdf: MIME.pdf,
  docx: MIME.docx,
  docm: MIME.docx,
  dotx: MIME.docx,
  xlsx: MIME.xlsx,
  xlsm: MIME.xlsx,
  xltx: MIME.xlsx,
  pptx: MIME.pptx,
  odt: MIME.odt,
  ods: MIME.ods,
  doc: MIME.doc,
  xls: MIME.xls,
  ppt: MIME.ppt,
  csv: MIME.csv,
  tsv: MIME.tsv,
  tab: MIME.tsv,
  txt: MIME.text,
  text: MIME.text,
  log: MIME.text,
  md: MIME.markdown,
  markdown: MIME.markdown,
  html: MIME.html,
  htm: MIME.html,
  xhtml: MIME.xhtml,
  json: MIME.json,
  xml: MIME.xml,
  rtf: MIME.rtf,
  png: MIME.png,
  jpg: MIME.jpeg,
  jpeg: MIME.jpeg,
  jpe: MIME.jpeg,
  jfif: MIME.jpeg,
  gif: MIME.gif,
  webp: MIME.webp,
  tif: MIME.tiff,
  tiff: MIME.tiff,
  bmp: MIME.bmp,
  heic: MIME.heic,
  zip: MIME.zip,
};

/** Non-standard or legacy spellings seen in uploads, mapped to the canonical type. */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": MIME.jpeg,
  "image/pjpeg": MIME.jpeg,
  "application/x-pdf": MIME.pdf,
  "text/x-markdown": MIME.markdown,
  "text/comma-separated-values": MIME.csv,
  "application/csv": MIME.csv,
  "text/x-csv": MIME.csv,
  "text/tsv": MIME.tsv,
  "text/json": MIME.json,
  "text/xml": MIME.xml,
  "application/vnd.ms-excel.sheet.macroenabled.12": MIME.xlsx,
  "application/vnd.ms-word.document.macroenabled.12": MIME.docx,
};

export function normalizeMimeType(mimeType: string | undefined): string | undefined {
  const base = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (!base || base === MIME.octet || base === "binary/octet-stream" || base === "application/unknown") return undefined;
  return MIME_ALIASES[base] ?? base;
}

/** Mime type from a file name's extension (paths and query strings are tolerated). */
export function mimeFromFileName(fileName: string): string | undefined {
  const base = fileName.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_MIME[base.slice(dot + 1).toLowerCase()];
}

function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => data[offset + i] === byte);
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1", start, end);
}

function isBmp(data: Uint8Array): boolean {
  if (!startsWith(data, [0x42, 0x4d]) || data.length < 18) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Reserved header bytes are zero and the DIB header has one of the known sizes.
  return view.getUint32(6, true) === 0 && [12, 40, 52, 56, 64, 108, 124].includes(view.getUint32(14, true));
}

function sniffZip(data: Uint8Array): string {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.includes("word/document") || buffer.includes("word/_rels")) return MIME.docx;
  if (buffer.includes("xl/workbook") || buffer.includes("xl/worksheets")) return MIME.xlsx;
  if (buffer.includes("ppt/presentation") || buffer.includes("ppt/slides")) return MIME.pptx;
  if (buffer.includes(MIME.odt)) return MIME.odt;
  if (buffer.includes(MIME.ods)) return MIME.ods;
  return MIME.zip;
}

function sniffText(data: Uint8Array): string | undefined {
  if (!looksLikeText(data)) return undefined;
  const head = ascii(data, 0, Math.min(data.length, 1024)).replace(/^\xef\xbb\xbf/, "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return MIME.html;
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return /<html[\s>]/.test(head) ? MIME.xhtml : MIME.xml;
  if (head.startsWith("{\\rtf")) return MIME.rtf;
  if (head.startsWith("{") || head.startsWith("[")) {
    const tail = ascii(data, Math.max(0, data.length - 64), data.length).trimEnd();
    if (tail.endsWith("}") || tail.endsWith("]")) return MIME.json;
  }
  return undefined;
}

/**
 * Mime type from content signatures ("magic bytes"): PDF, images, Office Open
 * XML (DOCX/XLSX/PPTX), legacy OLE2 Office files, and HTML/XML/JSON/RTF text.
 * Returns undefined when the content has no recognizable signature.
 */
export function sniffMimeType(data: Uint8Array): string | undefined {
  if (data.length === 0) return undefined;
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return MIME.pdf;
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME.png;
  if (startsWith(data, [0xff, 0xd8, 0xff])) return MIME.jpeg;
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return MIME.gif;
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return MIME.webp;
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return MIME.tiff;
  if (startsWith(data, [0x66, 0x74, 0x79, 0x70], 4) && /^(heic|heix|mif1|msf1)$/.test(ascii(data, 8, 12))) return MIME.heic;
  if (isBmp(data)) return MIME.bmp;
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) return sniffZip(data);
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return MIME.cfb;
  // Some producers prepend junk before the PDF header; readers accept it within the first 1 KB.
  if (ascii(data, 0, Math.min(data.length, 1024)).includes("%PDF-")) return MIME.pdf;
  return sniffText(data);
}

export function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === MIME.json ||
    mimeType === MIME.xml ||
    mimeType === MIME.xhtml ||
    mimeType.endsWith("+xml") ||
    mimeType.endsWith("+json")
  );
}

/** Signatures that identify the format regardless of the declared type or extension. */
const AUTHORITATIVE_SIGNATURES: ReadonlySet<string> = new Set([
  MIME.pdf,
  MIME.png,
  MIME.jpeg,
  MIME.gif,
  MIME.webp,
  MIME.tiff,
  MIME.bmp,
  MIME.heic,
  MIME.docx,
  MIME.xlsx,
  MIME.pptx,
  MIME.odt,
  MIME.ods,
  MIME.zip,
  MIME.cfb,
  MIME.rtf,
]);

const LEGACY_OFFICE: ReadonlySet<string> = new Set([MIME.doc, MIME.xls, MIME.ppt]);

/**
 * Decide the effective mime type. Content signatures win for binary formats (a
 * JPEG named ".pdf" is still a JPEG); for text content the declared type or the
 * extension decide, preferring the more specific one (text/csv over text/plain).
 * Browsers often mislabel files (e.g. CSV as application/vnd.ms-excel), so a
 * declared binary type is ignored when the bytes are plain text.
 */
export function resolveMimeType(data: Uint8Array, fileName: string, declared?: string): string {
  const sniffed = sniffMimeType(data);
  const fromDeclared = normalizeMimeType(declared);
  const fromName = mimeFromFileName(fileName);
  if (data.length === 0) return fromDeclared ?? fromName ?? MIME.octet;
  if (sniffed && AUTHORITATIVE_SIGNATURES.has(sniffed)) {
    if (sniffed === MIME.zip) return [fromDeclared, fromName].find((m) => m && m !== MIME.zip && !isTextMime(m)) ?? sniffed;
    if (sniffed === MIME.cfb) return [fromDeclared, fromName].find((m) => m && LEGACY_OFFICE.has(m)) ?? sniffed;
    return sniffed;
  }
  if (!looksLikeText(data)) return fromDeclared ?? fromName ?? MIME.octet;
  const candidates = [fromDeclared, fromName, sniffed].filter((m): m is string => Boolean(m && isTextMime(m)));
  return candidates.find((m) => m !== MIME.text) ?? candidates[0] ?? MIME.text;
}
