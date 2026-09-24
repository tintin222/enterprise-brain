import type { LlmClient, LlmUsage } from "@enterprise-brain/llm";

export type ExtractionMethod =
  | "pdf-text"
  | "docx"
  | "xlsx"
  | "csv"
  | "text"
  | "html"
  | "json"
  | "ocr-llm"
  | "ocr-tesseract"
  | "none";

export interface SheetData {
  name: string;
  columns: string[];
  /** Rows as objects keyed by column header. */
  rows: Record<string, unknown>[];
}

export type DocumentType =
  | "cv"
  | "invoice"
  | "purchase-order"
  | "receipt"
  | "contract"
  | "delivery-note"
  | "bank-statement"
  | "id-document"
  | "letter"
  | "spreadsheet"
  | "report"
  | "unknown";

export interface ExtractedDocument {
  fileName: string;
  mimeType: string;
  /** Full plain text (for spreadsheets: a readable CSV-like rendering of all sheets). */
  text: string;
  pages?: { number: number; text: string }[];
  sheets?: SheetData[];
  method: ExtractionMethod;
  /** True when the file had no usable text layer (scanned PDF / image) and OCR was needed. */
  needsOcr: boolean;
  /** ISO 639-1 code, best effort ("en", "tr", "de", ...). */
  language?: string;
  documentType: DocumentType;
  documentTypeConfidence: number;
  warnings: string[];
  /** Number of pages of a PDF (`pages` may hold fewer after truncation or OCR). */
  pageCount?: number;
  /** LLM usage of the extraction (OCR calls), for cost attribution. */
  usage?: LlmUsage;
}

export interface ExtractOptions {
  /** Used for OCR of scanned PDFs/images (Claude vision) when available. */
  llm?: LlmClient;
  /**
   * "auto" (default) OCRs images and PDFs without a usable text layer;
   * "always" also OCRs PDFs that have one; "never" disables OCR.
   */
  ocr?: "auto" | "always" | "never";
  /** Maximum characters of text to keep (default 200k). */
  maxChars?: number;
  /** Languages for the optional tesseract.js fallback, e.g. "eng+tur" (default "eng"). */
  tesseractLanguages?: string;
}

export interface DocumentInput {
  data: Buffer;
  fileName: string;
  mimeType?: string;
}
