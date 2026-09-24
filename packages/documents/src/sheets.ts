import ExcelJS from "exceljs";
import type { SheetData } from "./types.ts";
import { assertSafeZip } from "./zip.ts";

const HEADER_SEARCH_ROWS = 10;
const EXCEL_MAX_CELL_CHARS = 32_767;

export interface WorkbookSheetInput {
  name: string;
  rows: Record<string, unknown>[];
  /** Column order; defaults to the keys of `rows` in first-seen order. */
  columns?: string[];
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

const NUMERIC_TEXT = /^[-+(]?\s*[\p{Sc}]?\s*\d[\d.,'’\s]*%?\)?$/u;
const DATE_TEXT = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[T ]\d{1,2}:\d{2}.*)?$/;

/** A cell that reads as a label: non-empty text that is not a number or a date. */
function isLabelCell(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && !NUMERIC_TEXT.test(text) && !DATE_TEXT.test(text);
}

function isHeaderRow(row: unknown[], width: number): boolean {
  const cells = row.filter((cell) => !isBlank(cell));
  if (cells.length === 0 || cells.length < Math.ceil(width / 2)) return false;
  if (cells.some((cell) => typeof cell !== "string" && typeof cell !== "number")) return false;
  if (!cells.some(isLabelCell)) return false;
  const names = cells.map((cell) => String(cell).trim().toLowerCase());
  return new Set(names).size === names.length;
}

function headerNames(header: unknown[] | undefined, width: number): string[] {
  const used = new Map<string, number>();
  const columns: string[] = [];
  for (let i = 0; i < width; i++) {
    const raw = header?.[i];
    let name = isBlank(raw) ? `Column ${i + 1}` : String(raw).replace(/\s+/g, " ").trim();
    const seen = used.get(name.toLowerCase()) ?? 0;
    used.set(name.toLowerCase(), seen + 1);
    if (seen > 0) name = `${name} (${seen + 1})`;
    columns.push(name);
  }
  return columns;
}

/**
 * Turn a cell matrix into SheetData. The header is the first of the leading rows
 * that fills at least half the table width with unique cells, at least one of
 * them text (not a number or date); title/preamble rows above it are dropped.
 * Without a header, columns are named "Column 1", "Column 2", ... Empty cells
 * become null and blank rows are skipped.
 */
export function tableToSheet(name: string, matrix: unknown[][]): SheetData {
  const rows = matrix
    .map((row) => {
      const cells = row.map((cell) => (typeof cell === "string" ? cell.trim() : cell));
      let end = cells.length;
      while (end > 0 && isBlank(cells[end - 1])) end--;
      return cells.slice(0, end);
    })
    .filter((row) => row.length > 0);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return { name, columns: [], rows: [] };

  const headerIndex = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((row) => isHeaderRow(row, width));
  const columns = headerNames(headerIndex >= 0 ? rows[headerIndex] : undefined, width);
  const body = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  return {
    name,
    columns,
    rows: body.map((row) => Object.fromEntries(columns.map((column, i) => [column, isBlank(row[i]) ? null : row[i]]))),
  };
}

/** ISO date for midnight-UTC values (how Excel dates without a time arrive), full ISO timestamp otherwise. */
function dateToIso(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/** Plain JSON-friendly value of an exceljs cell: formulas → results, rich text → text, dates → ISO strings. */
function normalizeCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateToIso(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if ("richText" in value) return value.richText.map((run) => run.text).join("");
  if ("formula" in value || "sharedFormula" in value) return normalizeCellValue(value.result ?? null);
  if ("hyperlink" in value) {
    const text = normalizeCellValue(value.text as ExcelJS.CellValue);
    return isBlank(text) ? value.hyperlink : text;
  }
  if ("error" in value) return value.error;
  return null;
}

/** Read every worksheet of an .xlsx file into SheetData (see `tableToSheet` for header detection). */
export async function readWorkbook(data: Buffer): Promise<SheetData[]> {
  assertSafeZip(data, "XLSX");
  const workbook = new ExcelJS.Workbook();
  // exceljs types its input as an ArrayBuffer-like "Buffer"; it accepts Node buffers at runtime.
  await workbook.xlsx.load(data as unknown as ArrayBuffer);
  const sheets: SheetData[] = [];
  workbook.eachSheet((worksheet) => {
    const matrix: unknown[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        cells[columnNumber - 1] = normalizeCellValue(cell.value);
      });
      matrix[rowNumber - 1] = Array.from(cells, (cell) => cell ?? null);
    });
    sheets.push(tableToSheet(worksheet.name, Array.from(matrix, (row) => row ?? [])));
  });
  return sheets;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** ISO date strings become real Excel dates; a round-trip check rejects overflowing dates like 2026-02-30. */
function isoStringToDate(value: string): Date | undefined {
  if (ISO_DATE.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? date : undefined;
  }
  if (ISO_DATE_TIME.test(value)) {
    // Excel dates carry no zone: a zone-less timestamp is taken as UTC, like exceljs does.
    const date = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return dateToIso(value) ?? "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toCellValue(value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "string") return isoStringToDate(value) ?? value.slice(0, EXCEL_MAX_CELL_CHARS);
  const text = Array.isArray(value) ? value.map(formatScalar).join(", ") : formatScalar(value);
  return text.slice(0, EXCEL_MAX_CELL_CHARS);
}

function uniqueSheetName(name: string, used: Set<string>): string {
  // Excel: at most 31 characters, none of : \ / ? * [ ], no leading/trailing apostrophe, unique ignoring case.
  const base = name.replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function columnWidth(column: string, rows: Record<string, unknown>[]): number {
  let longest = column.length;
  for (const row of rows.slice(0, 1000)) {
    for (const line of formatScalar(row[column]).split("\n")) longest = Math.max(longest, line.length);
  }
  return Math.min(60, Math.max(8, longest + 2));
}

/** Write sheets to an .xlsx buffer with a bold, frozen, filterable header row and fitted column widths. */
export async function writeWorkbook(sheets: WorkbookSheetInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Enterprise Brain";
  workbook.created = new Date();
  const usedNames = new Set<string>();
  // A workbook without sheets cannot be opened by Excel.
  for (const sheet of sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }]) {
    const worksheet = workbook.addWorksheet(uniqueSheetName(sheet.name, usedNames), {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    const columns = sheet.columns ?? [...new Set(sheet.rows.flatMap((row) => Object.keys(row)))];
    if (columns.length === 0) continue;
    worksheet.columns = columns.map((column) => ({ header: column, key: column, width: columnWidth(column, sheet.rows) }));
    for (const row of sheet.rows) {
      const added = worksheet.addRow(columns.map((column) => toCellValue(row[column])));
      added.eachCell((cell) => {
        if (cell.value instanceof Date) {
          cell.numFmt = dateToIso(cell.value)?.length === 10 ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm";
        }
      });
    }
    worksheet.getRow(1).font = { bold: true };
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function csvCell(value: unknown): string {
  const text = formatScalar(value).replace(/\s*\n\s*/g, " ");
  return /[",]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Readable CSV-like rendering of sheets (for prompts, previews and full-text
 * search): a "Sheet: name" line, the header row, then up to `maxRowsPerSheet` rows.
 */
export function renderSheetsAsText(sheets: SheetData[], maxRowsPerSheet = 200): string {
  return sheets
    .map((sheet) => {
      const count = sheet.rows.length;
      if (sheet.columns.length === 0) return `Sheet: ${sheet.name} (empty)`;
      const lines = [
        `Sheet: ${sheet.name} (${count} ${count === 1 ? "row" : "rows"})`,
        sheet.columns.map(csvCell).join(","),
      ];
      for (const row of sheet.rows.slice(0, Math.max(0, maxRowsPerSheet))) {
        lines.push(sheet.columns.map((column) => csvCell(row[column])).join(","));
      }
      const hidden = count - Math.max(0, maxRowsPerSheet);
      if (hidden > 0) lines.push(`... ${hidden} more ${hidden === 1 ? "row" : "rows"} not shown`);
      return lines.join("\n");
    })
    .join("\n\n");
}
