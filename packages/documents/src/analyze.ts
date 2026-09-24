import type { FieldSpec } from "@enterprise-brain/core";
import { DocIndex } from "./doc-index.ts";
import { heuristicExtract } from "./heuristics.ts";
import { languageName } from "./language.ts";
import { normalizeKey } from "./lexicon.ts";
import { MIME } from "./mime.ts";
import type { DocumentType, ExtractedDocument } from "./types.ts";

export interface SampleAnalysis {
  /** Field keys (snake_case) found in the document, in a stable order. */
  detectedFields: string[];
  /** One human-readable paragraph describing the sample. */
  summary: string;
}

const list = (key: string, label: string, hints?: string[]): FieldSpec => ({ key, label, type: "list", itemType: "string", ...(hints ? { hints } : {}) });

const FIELDS_BY_TYPE: Record<DocumentType, FieldSpec[]> = {
  cv: [
    { key: "name", label: "Full name", type: "string" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "phone" },
    { key: "address", label: "Address", type: "string" },
    { key: "linkedin", label: "LinkedIn profile", type: "url" },
    { key: "summary", label: "Summary", type: "text" },
    { key: "experience", label: "Work experience", type: "text" },
    { key: "education", label: "Education", type: "text" },
    list("skills", "Skills"),
    list("languages", "Languages"),
    list("certifications", "Certifications"),
  ],
  invoice: [
    { key: "invoice_number", label: "Invoice number", type: "string" },
    { key: "invoice_date", label: "Invoice date", type: "date" },
    { key: "due_date", label: "Due date", type: "date" },
    { key: "supplier", label: "Supplier", type: "string" },
    { key: "customer", label: "Customer", type: "string" },
    { key: "tax_id", label: "Tax ID", type: "string" },
    { key: "po_number", label: "PO number", type: "string" },
    { key: "subtotal", label: "Subtotal", type: "number" },
    { key: "vat", label: "VAT", type: "number" },
    { key: "total", label: "Total", type: "number" },
    { key: "currency", label: "Currency", type: "string" },
    { key: "iban", label: "IBAN", type: "string" },
  ],
  "purchase-order": [
    { key: "po_number", label: "PO number", type: "string" },
    { key: "order_date", label: "Order date", type: "date" },
    { key: "delivery_date", label: "Delivery date", type: "date" },
    { key: "supplier", label: "Supplier", type: "string" },
    { key: "buyer", label: "Buyer", type: "string" },
    { key: "total", label: "Total", type: "number" },
    { key: "currency", label: "Currency", type: "string" },
  ],
  receipt: [
    { key: "merchant", label: "Merchant", type: "string" },
    { key: "date", label: "Date", type: "date" },
    { key: "total", label: "Total", type: "number" },
    { key: "vat", label: "VAT", type: "number" },
    { key: "payment_method", label: "Payment method", type: "string" },
    { key: "currency", label: "Currency", type: "string" },
  ],
  contract: [
    { key: "parties", label: "Parties", type: "string" },
    { key: "effective_date", label: "Effective date", type: "date" },
    { key: "end_date", label: "End date", type: "date" },
    { key: "governing_law", label: "Governing law", type: "text" },
  ],
  "delivery-note": [
    { key: "delivery_note_number", label: "Delivery note number", type: "string" },
    { key: "date", label: "Date", type: "date" },
    { key: "supplier", label: "Supplier", type: "string" },
    { key: "recipient", label: "Recipient", type: "string" },
    { key: "po_number", label: "PO number", type: "string" },
  ],
  "bank-statement": [
    { key: "account_holder", label: "Account holder", type: "string" },
    { key: "iban", label: "IBAN", type: "string" },
    { key: "account_number", label: "Account number", type: "string" },
    { key: "period", label: "Statement period", type: "string" },
    { key: "opening_balance", label: "Opening balance", type: "number" },
    { key: "closing_balance", label: "Closing balance", type: "number" },
    { key: "currency", label: "Currency", type: "string" },
  ],
  "id-document": [
    { key: "surname", label: "Surname", type: "string" },
    { key: "given_names", label: "Given names", type: "string" },
    { key: "document_number", label: "Document number", type: "string" },
    { key: "date_of_birth", label: "Date of birth", type: "date" },
    { key: "nationality", label: "Nationality", type: "string" },
    { key: "expiry_date", label: "Expiry date", type: "date" },
  ],
  letter: [
    { key: "date", label: "Date", type: "date" },
    { key: "subject", label: "Subject", type: "string" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "phone" },
  ],
  report: [
    { key: "date", label: "Date", type: "date" },
    { key: "summary", label: "Executive summary", type: "text", hints: ["executive summary", "yönetici özeti"] },
  ],
  spreadsheet: [],
  unknown: [
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "phone" },
    { key: "website", label: "Website", type: "url" },
    { key: "date", label: "Date", type: "date" },
    { key: "iban", label: "IBAN", type: "string" },
  ],
};

/** Typical extraction fields for a document type, e.g. to propose an extraction schema from a sample. */
export function fieldsForDocumentType(type: DocumentType): FieldSpec[] {
  return structuredClone(FIELDS_BY_TYPE[type] ?? FIELDS_BY_TYPE.unknown);
}

const TYPE_LABELS: Record<DocumentType, string> = {
  cv: "CV",
  invoice: "invoice",
  "purchase-order": "purchase order",
  receipt: "receipt",
  contract: "contract",
  "delivery-note": "delivery note",
  "bank-statement": "bank statement",
  "id-document": "ID document",
  letter: "letter",
  spreadsheet: "spreadsheet",
  report: "report",
  unknown: "document",
};

const FORMAT_LABELS: Record<string, string> = {
  [MIME.docx]: "Word document (DOCX)",
  [MIME.xlsx]: "Excel workbook",
  [MIME.csv]: "CSV file",
  [MIME.tsv]: "TSV file",
  [MIME.html]: "Web page (HTML)",
  [MIME.xhtml]: "Web page (XHTML)",
  [MIME.json]: "JSON file",
  [MIME.xml]: "XML file",
  [MIME.markdown]: "Markdown document",
  [MIME.text]: "Plain text file",
};

function formatLabel(doc: ExtractedDocument): string {
  const ocr = doc.method === "ocr-llm" || doc.method === "ocr-tesseract";
  if (doc.mimeType === MIME.pdf) return ocr ? "Scanned PDF (text via OCR)" : doc.needsOcr ? "Scanned PDF" : "Digital PDF";
  if (doc.mimeType.startsWith("image/")) {
    const format = doc.mimeType.slice("image/".length).toUpperCase();
    return ocr ? `Image (${format}, text via OCR)` : `Image (${format})`;
  }
  return FORMAT_LABELS[doc.mimeType] ?? `File (${doc.mimeType})`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function displayHeading(heading: string, language: string | undefined): string {
  if (heading !== heading.toUpperCase()) return heading;
  const lower = heading.toLocaleLowerCase(language === "tr" ? "tr" : "en");
  return lower.charAt(0).toLocaleUpperCase(language === "tr" ? "tr" : "en") + lower.slice(1);
}

/** Identifier-safe field key for a spreadsheet column ("Invoice No." → "invoice_no"). */
function columnKey(column: string, position: number): string {
  const key = normalizeKey(column);
  if (!key) return `column_${position + 1}`;
  return /^\d/.test(key) ? `column_${key}` : key;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/**
 * Deterministic description of an uploaded sample (e.g. a CV in the Agent
 * Builder): which typical fields are present, and a one-paragraph summary such
 * as "Digital PDF, 2 pages, English CV with sections: Experience, Education, Skills."
 */
export function analyzeSample(doc: ExtractedDocument): SampleAnalysis {
  const sheets = doc.sheets ?? [];
  let detectedFields: string[];
  if (doc.documentType === "spreadsheet" && sheets.length > 0) {
    detectedFields = [...new Set(sheets.flatMap((sheet) => sheet.columns.map(columnKey)))];
  } else {
    const fields = fieldsForDocumentType(doc.documentType);
    const values = heuristicExtract(doc.text, fields);
    detectedFields = fields.filter((field) => hasValue(values[field.key])).map((field) => field.key);
  }

  const parts = [formatLabel(doc)];
  const pageCount = doc.pageCount ?? doc.pages?.length;
  if (pageCount) parts.push(plural(pageCount, "page"));
  if (sheets.length > 0) parts.push(plural(sheets.length, "sheet"));
  let summary = parts.join(", ");

  if (!doc.text.trim()) {
    summary += doc.needsOcr ? "; no text could be extracted (the file needs OCR)." : "; no text could be extracted.";
    return { detectedFields, summary };
  }

  const described = [languageName(doc.language), TYPE_LABELS[doc.documentType]].filter(Boolean).join(" ");
  summary += `, ${described}`;
  const sections = [
    ...new Set(new DocIndex(doc.text).sections.filter((section) => section.group).map((section) => displayHeading(section.heading, doc.language))),
  ];
  if (sections.length > 0) summary += ` with sections: ${sections.slice(0, 10).join(", ")}`;
  summary += ".";
  if (doc.documentType === "spreadsheet" && sheets.length > 0) {
    const described = sheets.slice(0, 5).map((sheet) => {
      if (sheet.columns.length === 0) return `${sheet.name} (empty)`;
      const columns = sheet.columns.slice(0, 8).join(", ") + (sheet.columns.length > 8 ? ", …" : "");
      return `${sheet.name} (${plural(sheet.rows.length, "row")}; columns: ${columns})`;
    });
    summary += ` Sheets: ${described.join("; ")}${sheets.length > 5 ? "; …" : ""}.`;
  } else if (detectedFields.length > 0) {
    summary += ` Detected fields: ${detectedFields.join(", ")}.`;
  }
  return { detectedFields, summary };
}
