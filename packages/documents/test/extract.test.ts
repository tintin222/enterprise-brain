import { describe, expect, it } from "vitest";
import { UnavailableLlm, type ContentBlockParam } from "@enterprise-brain/llm";
import {
  extractDocument,
  heuristicExtract,
  mimeFromFileName,
  readWorkbook,
  resolveMimeType,
  sniffMimeType,
  writeWorkbook,
} from "../src/index.ts";
import { zipUncompressedSize } from "../src/zip.ts";
import { TINY_PNG, fakeLlm, makeBlankPdf, makeCvPdf, makeInvoiceDocx, makeTextPdf, zipDeclaring } from "./fixtures.ts";

function contentBlocks(request: { messages: { content: unknown }[] }): ContentBlockParam[] {
  const content = request.messages[0]?.content;
  return Array.isArray(content) ? (content as ContentBlockParam[]) : [];
}

describe("extractDocument: PDF", () => {
  it("extracts a digital PDF page by page and classifies it", async () => {
    const data = await makeCvPdf();
    const doc = await extractDocument({ data, fileName: "jane-doe.pdf" });
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.method).toBe("pdf-text");
    expect(doc.needsOcr).toBe(false);
    expect(doc.pageCount).toBe(2);
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages?.[0]?.text).toMatch(/^Jane Doe\nSenior Software Engineer/);
    expect(doc.pages?.[1]?.text).toContain("TypeScript, Node.js, PostgreSQL");
    expect(doc.text).toContain("jane.doe@example.com");
    expect(doc.language).toBe("en");
    expect(doc.documentType).toBe("cv");
    expect(doc.documentTypeConfidence).toBeGreaterThan(0.5);
    expect(doc.warnings).toEqual([]);
  });

  it("detects a PDF by its magic bytes when the name has no extension", async () => {
    const doc = await extractDocument({ data: await makeCvPdf(), fileName: "upload", mimeType: "application/octet-stream" });
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.method).toBe("pdf-text");
  });

  it("flags a scanned (text-less) PDF for OCR and explains that OCR needs an LLM", async () => {
    const doc = await extractDocument({ data: await makeBlankPdf(), fileName: "scan.pdf" });
    expect(doc.needsOcr).toBe(true);
    expect(doc.method).toBe("none");
    expect(doc.text).toBe("");
    expect(doc.pageCount).toBe(1);
    expect(doc.documentType).toBe("unknown");
    expect(doc.warnings.join(" ")).toMatch(/OCR.*needs an LLM/);
  });

  it("does not OCR a scanned PDF when OCR is disabled", async () => {
    const { llm, requests } = fakeLlm("unused");
    const doc = await extractDocument({ data: await makeBlankPdf(), fileName: "scan.pdf" }, { llm, ocr: "never" });
    expect(requests).toHaveLength(0);
    expect(doc.needsOcr).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/OCR is disabled/);
  });

  it("treats an unavailable LLM like a missing one", async () => {
    const doc = await extractDocument({ data: await makeBlankPdf(), fileName: "scan.pdf" }, { llm: new UnavailableLlm() });
    expect(doc.needsOcr).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/needs an LLM/);
  });

  it("OCRs a scanned PDF with Claude as a document block and splits pages", async () => {
    const data = await makeBlankPdf(2);
    const { llm, requests } = fakeLlm("=== Page 1 ===\nINVOICE\nInvoice No: INV-7\n\n=== Page 2 ===\nTotal: 1,250.00 EUR");
    const doc = await extractDocument({ data, fileName: "scan.pdf" }, { llm });

    expect(doc.method).toBe("ocr-llm");
    expect(doc.needsOcr).toBe(true);
    expect(doc.pages).toEqual([
      { number: 1, text: "INVOICE\nInvoice No: INV-7" },
      { number: 2, text: "Total: 1,250.00 EUR" },
    ]);
    expect(doc.text).toBe("INVOICE\nInvoice No: INV-7\n\nTotal: 1,250.00 EUR");
    expect(doc.documentType).toBe("invoice");
    expect(doc.usage?.calls).toBe(1);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.purpose).toBe("documents.ocr");
    expect(request.effort).toBe("low");
    const [document, instruction] = contentBlocks(request);
    expect(document).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } });
    expect(instruction).toMatchObject({ type: "text" });
    expect((instruction as { text: string }).text).toMatch(/Transcribe all text/);
    expect((instruction as { text: string }).text).toMatch(/=== Page N ===/);
  });

  it("keeps the text layer and warns when LLM OCR fails", async () => {
    const llm = { ...fakeLlm("").llm, complete: async () => Promise.reject(new Error("rate limited")) };
    const doc = await extractDocument({ data: await makeBlankPdf(), fileName: "scan.pdf" }, { llm });
    expect(doc.method).toBe("none");
    expect(doc.needsOcr).toBe(true);
    expect(doc.warnings.join(" ")).toContain("rate limited");
  });

  it("OCRs a digital PDF only when asked to (ocr: always)", async () => {
    const data = await makeCvPdf();
    const auto = fakeLlm("unused");
    await extractDocument({ data, fileName: "cv.pdf" }, { llm: auto.llm });
    expect(auto.requests).toHaveLength(0);

    const always = fakeLlm("=== Page 1 ===\nJane Doe\n=== Page 2 ===\nSkills");
    const doc = await extractDocument({ data, fileName: "cv.pdf" }, { llm: always.llm, ocr: "always" });
    expect(always.requests).toHaveLength(1);
    expect(doc.method).toBe("ocr-llm");
    expect(doc.needsOcr).toBe(false);
  });

  it("stops reading pages once maxChars is reached", async () => {
    const line = "Quarterly revenue grew in every region and the board approved the budget.";
    const data = await makeTextPdf([1, 2, 3, 4, 5].map((n) => `${n}. ${line}`));
    const doc = await extractDocument({ data, fileName: "report.pdf" }, { maxChars: 100 });
    expect(doc.pageCount).toBe(5);
    expect(doc.pages?.map((page) => page.number)).toEqual([1, 2]);
    expect(doc.text).toHaveLength(100);
    expect(doc.warnings).toContain("Only the first 2 of 5 pages were read (maxChars limit).");
  });

  it("reports a corrupt PDF as a warning instead of throwing", async () => {
    const doc = await extractDocument({ data: Buffer.from("%PDF-1.7\nnot really a pdf"), fileName: "broken.pdf" });
    expect(doc.method).toBe("none");
    expect(doc.text).toBe("");
    expect(doc.warnings[0]).toMatch(/Could not read broken\.pdf/);
  });
});

describe("extractDocument: images", () => {
  it("OCRs an image through Claude vision", async () => {
    const { llm, requests } = fakeLlm("CAFE NERO\nFlat white 3.50\nTOTAL 3.50 EUR\nThank you for your visit");
    const doc = await extractDocument({ data: TINY_PNG, fileName: "receipt.png" }, { llm });

    expect(doc.mimeType).toBe("image/png");
    expect(doc.method).toBe("ocr-llm");
    expect(doc.needsOcr).toBe(true);
    expect(doc.text).toContain("Flat white 3.50");
    expect(doc.pages).toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.purpose).toBe("documents.ocr");
    const [image, instruction] = contentBlocks(requests[0]!);
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG.toString("base64") } });
    expect(instruction).toMatchObject({ type: "text" });
  });

  it("returns empty text with a warning when no LLM (or tesseract.js) is available", async () => {
    const doc = await extractDocument({ data: TINY_PNG, fileName: "scan.jpg" });
    expect(doc.mimeType).toBe("image/png");
    expect(doc.method).toBe("none");
    expect(doc.needsOcr).toBe(true);
    expect(doc.text).toBe("");
    expect(doc.warnings.join(" ")).toMatch(/OCR.*tesseract\.js/);
  });

  it("does not call the LLM when OCR is disabled", async () => {
    const { llm, requests } = fakeLlm("text");
    const doc = await extractDocument({ data: TINY_PNG, fileName: "scan.png" }, { llm, ocr: "never" });
    expect(requests).toHaveLength(0);
    expect(doc.needsOcr).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/OCR is disabled/);
  });
});

describe("extractDocument: office and text formats", () => {
  it("extracts a Turkish DOCX invoice, keeping table rows on one line", async () => {
    const doc = await extractDocument({ data: await makeInvoiceDocx(), fileName: "fatura.docx" });
    expect(doc.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(doc.method).toBe("docx");
    expect(doc.text).toContain("Fatura No: FTR-2026-0042");
    expect(doc.text).toContain("Açıklama | Miktar | Birim Fiyat | Tutar");
    expect(doc.text).toContain("Danışmanlık hizmeti | 1 | 10.288,06 | 10.288,06");
    expect(doc.language).toBe("tr");
    expect(doc.documentType).toBe("invoice");

    const values = heuristicExtract(doc.text, [
      { key: "invoice_number", type: "string" },
      { key: "invoice_date", type: "date" },
      { key: "total", type: "number" },
      { key: "iban", type: "string" },
    ]);
    expect(values).toEqual({
      invoice_number: "FTR-2026-0042",
      invoice_date: "2026-09-12",
      total: 12345.67,
      iban: "TR330006100519786457841326",
    });
  });

  it("reads every sheet of an XLSX workbook", async () => {
    const data = await writeWorkbook([
      {
        name: "Sales",
        rows: [
          { Region: "EMEA", Product: "Widget", Units: 10, Revenue: 1000.5, Date: "2026-09-12" },
          { Region: "APAC", Product: "Gadget", Units: 3, Revenue: 450, Date: "2026-09-13" },
        ],
      },
      { name: "Notes", rows: [{ Note: "Prices exclude VAT" }] },
    ]);
    const doc = await extractDocument({ data, fileName: "sales.xlsx" });
    expect(doc.method).toBe("xlsx");
    expect(doc.sheets?.map((sheet) => sheet.name)).toEqual(["Sales", "Notes"]);
    expect(doc.sheets?.[0]?.columns).toEqual(["Region", "Product", "Units", "Revenue", "Date"]);
    expect(doc.sheets?.[0]?.rows[0]).toEqual({ Region: "EMEA", Product: "Widget", Units: 10, Revenue: 1000.5, Date: "2026-09-12" });
    expect(doc.text).toContain("Sheet: Sales (2 rows)\nRegion,Product,Units,Revenue,Date\nEMEA,Widget,10,1000.5,2026-09-12");
    expect(doc.documentType).toBe("spreadsheet");
  });

  it("parses CSV with quoted commas, escaped quotes and line breaks", async () => {
    const csv = 'Name,Address,Note\r\n"Doe, Jane","1 Main St\r\nLondon","She said ""hi"""\r\nSmith,Paris,\r\n';
    const doc = await extractDocument({ data: Buffer.from(csv), fileName: "contacts.csv", mimeType: "application/vnd.ms-excel" });
    expect(doc.mimeType).toBe("text/csv");
    expect(doc.method).toBe("csv");
    expect(doc.sheets).toEqual([
      {
        name: "contacts",
        columns: ["Name", "Address", "Note"],
        rows: [
          { Name: "Doe, Jane", Address: "1 Main St\nLondon", Note: 'She said "hi"' },
          { Name: "Smith", Address: "Paris", Note: null },
        ],
      },
    ]);
    expect(doc.text).toBe('Sheet: contacts (2 rows)\nName,Address,Note\n"Doe, Jane",1 Main St London,"She said ""hi"""\nSmith,Paris,');
  });

  it("converts HTML to text without scripts, styles or markup", async () => {
    const html = `<!doctype html><html><head><title>Q3 Report</title><style>p{color:red}</style></head>
      <body><script>alert("x")</script><h1>Results &amp; Outlook</h1>
      <p>Revenue grew&nbsp;12%&hellip; see <a href="#t">table</a>.</p>
      <ul><li>EMEA</li><li>Caf&eacute; &#x15F;ube &#246;zeti</li></ul>
      <table><tr><th>Region</th><th>Revenue</th></tr><tr><td>EMEA</td><td>1,200</td></tr></table></body></html>`;
    const doc = await extractDocument({ data: Buffer.from(html), fileName: "report.html" });
    expect(doc.method).toBe("html");
    expect(doc.text).toBe(
      "Q3 Report\n\nResults & Outlook\n\nRevenue grew 12%… see table.\n\n- EMEA\n- Café şube özeti\n\nRegion | Revenue\nEMEA | 1,200",
    );
    expect(doc.text).not.toMatch(/alert|color/);
  });

  it("pretty-prints JSON and keeps plain text", async () => {
    const json = await extractDocument({ data: Buffer.from('{"invoice":{"number":"INV-1","total":12.5}}'), fileName: "data.json" });
    expect(json.method).toBe("json");
    expect(json.text).toBe('{\n  "invoice": {\n    "number": "INV-1",\n    "total": 12.5\n  }\n}');

    const markdown = await extractDocument({ data: Buffer.from("# Notes\r\n\r\n\r\n\r\nShip on Monday.  \r\n"), fileName: "notes.md" });
    expect(markdown.mimeType).toBe("text/markdown");
    expect(markdown.method).toBe("text");
    expect(markdown.text).toBe("# Notes\n\nShip on Monday.");
  });

  it("renders XML (e.g. UBL e-invoices) as name: value lines", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Invoice xmlns:cbc="urn:cbc"><cbc:ID>FTR2026000000042</cbc:ID><cbc:IssueDate>2026-09-12</cbc:IssueDate>
      <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="TRY">12345.67</cbc:PayableAmount></cac:LegalMonetaryTotal>
      <cbc:Note><![CDATA[Ödeme 30 gün içinde & havale ile]]></cbc:Note></Invoice>`;
    const doc = await extractDocument({ data: Buffer.from(xml), fileName: "efatura.xml" });
    expect(doc.mimeType).toBe("application/xml");
    expect(doc.text).toBe("ID: FTR2026000000042\nIssueDate: 2026-09-12\nPayableAmount: 12345.67\nNote: Ödeme 30 gün içinde & havale ile");
  });

  it("decodes legacy Windows-1254 text files", async () => {
    const latin = Buffer.from([0x53, 0x61, 0x79, 0xfd, 0x6e, 0x20, 0x4d, 0xfc, 0xfe, 0x74, 0x65, 0x72, 0x69]); // "Sayın Müşteri"
    const doc = await extractDocument({ data: latin, fileName: "mektup.txt" });
    expect(doc.text).toBe("Sayın Müşteri");
  });

  it("truncates text to maxChars with a warning", async () => {
    const doc = await extractDocument({ data: Buffer.from("word ".repeat(1000)), fileName: "long.txt" }, { maxChars: 100 });
    expect(doc.text).toHaveLength(100);
    expect(doc.warnings).toContain("The text was truncated to 100 of 4,999 characters.");
  });

  it("refuses Office files that would inflate beyond the safety limit (zip bombs)", async () => {
    const bomb = zipDeclaring("xl/workbook.xml", 0xfffffff0);
    await expect(readWorkbook(bomb)).rejects.toThrow(/above the 512 MB safety limit/);
    const doc = await extractDocument({ data: bomb, fileName: "report.xlsx" });
    expect(doc.method).toBe("none");
    expect(doc.warnings[0]).toMatch(/expands to 4096 MB, above the 512 MB safety limit/);
    expect(zipUncompressedSize(await makeInvoiceDocx())).toBeLessThan(100_000);
  });

  it("explains unsupported and empty files", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const legacy = await extractDocument({ data: ole, fileName: "old.doc" });
    expect(legacy.method).toBe("none");
    expect(legacy.mimeType).toBe("application/msword");
    expect(legacy.warnings[0]).toMatch(/not supported/);

    const empty = await extractDocument({ data: Buffer.alloc(0), fileName: "empty.txt" });
    expect(empty.text).toBe("");
    expect(empty.warnings).toEqual(["The file is empty."]);
  });
});

describe("mime detection", () => {
  it("maps file extensions", () => {
    expect(mimeFromFileName("CV.PDF")).toBe("application/pdf");
    expect(mimeFromFileName("uploads/report.final.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeFromFileName("photo.JPG")).toBe("image/jpeg");
    expect(mimeFromFileName("data.tsv")).toBe("text/tab-separated-values");
    expect(mimeFromFileName("README")).toBeUndefined();
  });

  it("sniffs magic bytes", async () => {
    expect(sniffMimeType(await makeBlankPdf())).toBe("application/pdf");
    expect(sniffMimeType(TINY_PNG)).toBe("image/png");
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
    expect(sniffMimeType(await makeInvoiceDocx())).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(sniffMimeType(await writeWorkbook([{ name: "A", rows: [{ a: 1 }] }]))).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(sniffMimeType(Buffer.from("<!DOCTYPE html><p>x</p>"))).toBe("text/html");
    expect(sniffMimeType(Buffer.from('  {"a": 1}\n'))).toBe("application/json");
    expect(sniffMimeType(Buffer.from("just words"))).toBeUndefined();
  });

  it("lets content signatures override misleading names and types", () => {
    expect(resolveMimeType(TINY_PNG, "scan.pdf", "application/pdf")).toBe("image/png");
    expect(resolveMimeType(Buffer.from("a,b\n1,2"), "export.csv", "application/vnd.ms-excel")).toBe("text/csv");
    expect(resolveMimeType(Buffer.from("a,b\n1,2"), "export.csv", "text/plain; charset=utf-8")).toBe("text/csv");
    expect(resolveMimeType(Buffer.from("plain words"), "file")).toBe("text/plain");
  });
});
