import type { LlmClient, LlmUsage } from "@enterprise-brain/llm";
import mammoth from "mammoth";
import { detectDocumentType } from "./classify.ts";
import { parseCsv } from "./csv.ts";
import { detectLanguage } from "./language.ts";
import { MIME, resolveMimeType } from "./mime.ts";
import { isClaudeImageType, ocrWithLlm, ocrWithTesseract } from "./ocr.ts";
import { readPdfTextLayer, type PdfTextLayer } from "./pdf.ts";
import { readWorkbook, renderSheetsAsText, tableToSheet } from "./sheets.ts";
import { countMeaningfulChars, decodeText, htmlToText, normalizeText, xmlToText } from "./text.ts";
import type { DocumentInput, ExtractedDocument, ExtractionMethod, ExtractOptions, SheetData } from "./types.ts";
import { assertSafeZip } from "./zip.ts";

export const DEFAULT_MAX_CHARS = 200_000;
/** Pages with fewer letters/digits than this have no usable text layer (scans, image-only pages). */
const MIN_CHARS_PER_PAGE = 20;
/** Rows per sheet rendered into `text`; `sheets` always keeps every row. */
const TEXT_ROWS_PER_SHEET = 5_000;

const NO_LLM_FOR_PDF_OCR =
  "The PDF has no usable text layer (it looks scanned). OCR of scanned PDFs needs an LLM: " +
  "configure Claude (ANTHROPIC_API_KEY) and pass `llm` to extractDocument.";
const NO_LLM_FOR_IMAGE_OCR =
  "Images need OCR to extract text: configure Claude (ANTHROPIC_API_KEY) and pass `llm` to extractDocument, " +
  "or install tesseract.js for local OCR.";
const OCR_TRUNCATED = "The OCR transcript hit the output token limit; the end of the document may be missing.";

interface Extraction {
  text: string;
  method: ExtractionMethod;
  needsOcr: boolean;
  pages?: { number: number; text: string }[];
  pageCount?: number;
  sheets?: SheetData[];
  usage?: LlmUsage;
}

const NOTHING: Extraction = { text: "", method: "none", needsOcr: false };

type Kind = "pdf" | "image" | "docx" | "xlsx" | "csv" | "html" | "xml" | "json" | "text" | "legacy-office" | "unsupported";

function kindOf(mimeType: string): Kind {
  if (mimeType === MIME.pdf) return "pdf";
  if (mimeType === MIME.docx) return "docx";
  if (mimeType === MIME.xlsx) return "xlsx";
  if (mimeType === MIME.csv || mimeType === MIME.tsv) return "csv";
  if (mimeType === MIME.html || mimeType === MIME.xhtml) return "html";
  if (mimeType === MIME.json || mimeType.endsWith("+json")) return "json";
  if (mimeType === MIME.xml || mimeType.endsWith("+xml")) return "xml";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === MIME.doc || mimeType === MIME.xls || mimeType === MIME.ppt || mimeType === MIME.cfb) return "legacy-office";
  if (mimeType.startsWith("text/")) return "text";
  return "unsupported";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError("extractDocument: `data` must be a Buffer");
}

function baseName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  return name.replace(/\.[^.]+$/, "") || name;
}

/**
 * Extract text (and pages/sheets) from a document, OCR it when needed and
 * possible, and detect its language and type. Unreadable, corrupt or
 * unsupported files do not throw: they come back with `method: "none"`, empty
 * text and an explanation in `warnings`.
 */
export async function extractDocument(input: DocumentInput, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const data = toBuffer(input.data);
  const fileName = input.fileName?.trim() || "document";
  const mimeType = resolveMimeType(data, fileName, input.mimeType);
  const requested = options.maxChars;
  const maxChars = requested !== undefined && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_CHARS;
  const warnings: string[] = [];

  let extraction = NOTHING;
  if (data.length === 0) {
    warnings.push("The file is empty.");
  } else {
    try {
      extraction = await extractContent(data, fileName, mimeType, { ...options, maxChars }, warnings);
    } catch (error) {
      warnings.push(`Could not read ${fileName} as ${mimeType}: ${describeError(error)}`);
    }
  }

  let text = normalizeText(extraction.text);
  if (text.length > maxChars) {
    warnings.push(`The text was truncated to ${maxChars.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.`);
    text = text.slice(0, maxChars);
  }
  const language = detectLanguage(text);
  const type = detectDocumentType(text, fileName, { hasSheets: Boolean(extraction.sheets?.length) });

  return {
    fileName,
    mimeType,
    text,
    ...(extraction.pages ? { pages: limitPages(extraction.pages, maxChars) } : {}),
    ...(extraction.sheets ? { sheets: extraction.sheets } : {}),
    method: extraction.method,
    needsOcr: extraction.needsOcr,
    ...(language ? { language } : {}),
    documentType: type.type,
    documentTypeConfidence: type.confidence,
    warnings,
    ...(extraction.pageCount !== undefined ? { pageCount: extraction.pageCount } : {}),
    ...(extraction.usage ? { usage: extraction.usage } : {}),
  };
}

/** Per-page text within the same character budget as the full text (later pages are dropped). */
function limitPages(pages: { number: number; text: string }[], maxChars: number): { number: number; text: string }[] {
  const limited: { number: number; text: string }[] = [];
  let used = 0;
  for (const page of pages) {
    if (used >= maxChars) break;
    const text = normalizeText(page.text).slice(0, maxChars - used);
    limited.push({ number: page.number, text });
    used += text.length;
  }
  return limited;
}

async function extractContent(
  data: Buffer,
  fileName: string,
  mimeType: string,
  options: ExtractOptions & { maxChars: number },
  warnings: string[],
): Promise<Extraction> {
  switch (kindOf(mimeType)) {
    case "pdf":
      return extractPdf(data, options, warnings);
    case "image":
      return extractImage(data, mimeType, options, warnings);
    case "docx":
      return extractDocx(data, warnings);
    case "xlsx":
      return spreadsheet(await readWorkbook(data), "xlsx", warnings);
    case "csv": {
      const rows = parseCsv(decodeText(data), mimeType === MIME.tsv ? "\t" : undefined);
      return spreadsheet([tableToSheet(baseName(fileName), rows)], "csv", warnings);
    }
    case "html":
      return { text: htmlToText(decodeText(data)), method: "html", needsOcr: false };
    case "xml":
      return { text: xmlToText(decodeText(data)), method: "text", needsOcr: false };
    case "json":
      return extractJson(data, warnings);
    case "text":
      return { text: decodeText(data), method: "text", needsOcr: false };
    case "legacy-office":
      warnings.push(`Legacy or encrypted Office files (${mimeType}) are not supported; save the file as DOCX, XLSX or PDF.`);
      return NOTHING;
    default:
      warnings.push(`Unsupported file type (${mimeType}).`);
      return NOTHING;
  }
}

function spreadsheet(sheets: SheetData[], method: ExtractionMethod, warnings: string[]): Extraction {
  for (const sheet of sheets) {
    if (sheet.rows.length > TEXT_ROWS_PER_SHEET) {
      const note = `the text includes the first ${TEXT_ROWS_PER_SHEET} of ${sheet.rows.length} rows; \`sheets\` has them all`;
      warnings.push(`Sheet "${sheet.name}": ${note}.`);
    }
  }
  return { text: renderSheetsAsText(sheets, TEXT_ROWS_PER_SHEET), sheets, method, needsOcr: false };
}

function extractJson(data: Buffer, warnings: string[]): Extraction {
  const raw = decodeText(data);
  try {
    return { text: JSON.stringify(JSON.parse(raw), null, 2), method: "json", needsOcr: false };
  } catch {
    warnings.push("The file is not valid JSON; its raw text was kept.");
    return { text: raw, method: "text", needsOcr: false };
  }
}

async function extractDocx(data: Buffer, warnings: string[]): Promise<Extraction> {
  assertSafeZip(data, "DOCX");
  // HTML conversion keeps table rows ("a | b | c") and list items on their own lines;
  // images are dropped instead of being inlined as base64.
  const html = await mammoth.convertToHtml({ buffer: data }, { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) });
  for (const message of html.messages) if (message.type === "error") warnings.push(`DOCX: ${message.message}`);
  const text = htmlToText(html.value) || (await mammoth.extractRawText({ buffer: data })).value;
  if (!text.trim() && /<img\b/i.test(html.value)) {
    warnings.push("The document contains images but no text (a scan pasted into Word?); export it as PDF to OCR it.");
    return { text: "", method: "docx", needsOcr: true };
  }
  return { text, method: "docx", needsOcr: false };
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && (error.name === "PasswordException" || /password/i.test(error.message));
}

async function extractPdf(data: Buffer, options: ExtractOptions & { maxChars: number }, warnings: string[]): Promise<Extraction> {
  let layer: PdfTextLayer;
  try {
    layer = await readPdfTextLayer(data, options.maxChars);
  } catch (error) {
    if (!isPasswordError(error)) throw error;
    warnings.push("The PDF is password-protected; its text cannot be extracted.");
    return NOTHING;
  }
  if (layer.pages.length < layer.pageCount) {
    warnings.push(`Only the first ${layer.pages.length} of ${layer.pageCount} pages were read (maxChars limit).`);
  }
  const sparse = layer.pages.filter((page) => countMeaningfulChars(page.text) < MIN_CHARS_PER_PAGE);
  // Scanned when most pages read carry (almost) no text; a few empty pages (covers, blanks) are normal.
  const needsOcr = sparse.length * 2 > layer.pages.length;
  const text = layer.pages
    .map((page) => page.text)
    .filter(Boolean)
    .join("\n\n");
  const fromTextLayer: Extraction = { text, pages: layer.pages, pageCount: layer.pageCount, method: text ? "pdf-text" : "none", needsOcr };

  const mode = options.ocr ?? "auto";
  if (!needsOcr && sparse.length > 0 && mode === "auto") {
    const numbers = sparse.map((page) => page.number).slice(0, 10).join(", ");
    warnings.push(`Pages without extractable text (scanned images?): ${numbers}. Use ocr: "always" to OCR the whole PDF.`);
  }
  if (mode === "never" || (mode === "auto" && !needsOcr)) {
    if (needsOcr) warnings.push("The PDF has no usable text layer (it looks scanned) and OCR is disabled.");
    return fromTextLayer;
  }
  const llm: LlmClient | undefined = options.llm?.available ? options.llm : undefined;
  if (!llm) {
    warnings.push(needsOcr ? NO_LLM_FOR_PDF_OCR : "OCR was requested but no LLM is available; the PDF's text layer was used.");
    return fromTextLayer;
  }
  try {
    const ocr = await ocrWithLlm(llm, { kind: "pdf", data, pageCount: layer.pageCount });
    if (ocr.truncated) warnings.push(OCR_TRUNCATED);
    if (!ocr.text) {
      warnings.push("OCR found no text in the PDF.");
      return { ...fromTextLayer, usage: ocr.usage };
    }
    return {
      text: ocr.text,
      ...(ocr.pages ? { pages: ocr.pages } : {}),
      pageCount: layer.pageCount,
      method: "ocr-llm",
      needsOcr,
      usage: ocr.usage,
    };
  } catch (error) {
    warnings.push(`OCR with the LLM failed: ${describeError(error)}`);
    return fromTextLayer;
  }
}

async function extractImage(data: Buffer, mimeType: string, options: ExtractOptions, warnings: string[]): Promise<Extraction> {
  const noText: Extraction = { text: "", method: "none", needsOcr: true };
  if (options.ocr === "never") {
    warnings.push("Images need OCR to extract text, and OCR is disabled.");
    return noText;
  }
  const llm = options.llm?.available ? options.llm : undefined;
  if (llm && isClaudeImageType(mimeType)) {
    try {
      const ocr = await ocrWithLlm(llm, { kind: "image", data, mediaType: mimeType });
      if (ocr.truncated) warnings.push(OCR_TRUNCATED);
      if (!ocr.text) warnings.push("OCR found no text in the image.");
      return { text: ocr.text, method: "ocr-llm", needsOcr: true, usage: ocr.usage };
    } catch (error) {
      warnings.push(`OCR with the LLM failed: ${describeError(error)}`);
    }
  } else if (llm) {
    warnings.push(`Claude cannot read ${mimeType} images; convert the image to PNG or JPEG for OCR.`);
  }
  try {
    const text = await ocrWithTesseract(data, options.tesseractLanguages);
    if (text !== undefined) {
      if (!text.trim()) warnings.push("OCR found no text in the image.");
      return { text, method: "ocr-tesseract", needsOcr: true };
    }
  } catch (error) {
    warnings.push(`Local OCR with tesseract.js failed: ${describeError(error)}`);
    return noText;
  }
  if (!llm) warnings.push(NO_LLM_FOR_IMAGE_OCR);
  return noText;
}
