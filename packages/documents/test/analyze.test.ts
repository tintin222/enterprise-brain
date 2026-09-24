import { describe, expect, it } from "vitest";
import { FieldSpecSchema } from "@enterprise-brain/core";
import { analyzeSample, extractDocument, fieldsForDocumentType, writeWorkbook } from "../src/index.ts";
import { makeBlankPdf, makeCvPdf, makeInvoiceDocx } from "./fixtures.ts";

describe("analyzeSample", () => {
  it("describes a digital PDF CV", async () => {
    const doc = await extractDocument({ data: await makeCvPdf(), fileName: "jane-doe.pdf" });
    const analysis = analyzeSample(doc);
    expect(analysis.detectedFields).toEqual(["name", "email", "phone", "linkedin", "summary", "experience", "education", "skills", "languages"]);
    expect(analysis.summary).toBe(
      "Digital PDF, 2 pages, English CV with sections: Summary, Experience, Education, Skills, Languages. " +
        "Detected fields: name, email, phone, linkedin, summary, experience, education, skills, languages.",
    );
  });

  it("describes a Turkish DOCX invoice", async () => {
    const doc = await extractDocument({ data: await makeInvoiceDocx(), fileName: "fatura.docx" });
    const analysis = analyzeSample(doc);
    expect(analysis.detectedFields).toEqual([
      "invoice_number",
      "invoice_date",
      "supplier",
      "customer",
      "tax_id",
      "subtotal",
      "vat",
      "total",
      "currency",
      "iban",
    ]);
    expect(analysis.summary).toMatch(/^Word document \(DOCX\), Turkish invoice\. Detected fields: invoice_number, /);
  });

  it("lists sheets and column keys for spreadsheets", async () => {
    const data = await writeWorkbook([
      { name: "Leads", rows: [{ "Company Name": "Acme", "E-mail": "a@acme.com", "2026 Budget": 1000 }] },
      { name: "Notes", rows: [] },
    ]);
    const analysis = analyzeSample(await extractDocument({ data, fileName: "leads.xlsx" }));
    expect(analysis.detectedFields).toEqual(["company_name", "e_mail", "column_2026_budget"]);
    expect(analysis.summary).toContain("Excel workbook, 2 sheets");
    expect(analysis.summary).toContain("Sheets: Leads (1 row; columns: Company Name, E-mail, 2026 Budget); Notes (empty).");
  });

  it("explains when a scan has no text", async () => {
    const analysis = analyzeSample(await extractDocument({ data: await makeBlankPdf(), fileName: "scan.pdf" }));
    expect(analysis).toEqual({ detectedFields: [], summary: "Scanned PDF, 1 page; no text could be extracted (the file needs OCR)." });
  });
});

describe("fieldsForDocumentType", () => {
  it("returns valid FieldSpecs for every document type", () => {
    const types = ["cv", "invoice", "purchase-order", "receipt", "contract", "delivery-note", "bank-statement", "id-document", "letter", "report", "spreadsheet", "unknown"] as const;
    for (const type of types) {
      for (const field of fieldsForDocumentType(type)) expect(FieldSpecSchema.safeParse(field).success).toBe(true);
    }
    expect(fieldsForDocumentType("cv").map((field) => field.key)).toContain("skills");
  });
});
