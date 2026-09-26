import { describe, expect, it } from "vitest";
import type { FieldSpec } from "@enterprise-brain/core";
import {
  analyzeSample,
  detectDocumentType,
  extractDocument,
  fieldsForDocumentType,
  heuristicExtract,
  parseAmount,
  parseDateToIso,
} from "../src/index.ts";
import { CV_TEXT, TR_INVOICE_TEXT } from "./fixtures.ts";

describe("heuristicExtract: English CV", () => {
  const fields: FieldSpec[] = [
    { key: "full_name", type: "string", required: true },
    { key: "email", type: "email" },
    { key: "phone", type: "phone" },
    { key: "linkedin", type: "url" },
    { key: "job_title", type: "string" },
    { key: "summary", type: "text" },
    { key: "experience", type: "text" },
    { key: "education", type: "text" },
    { key: "skills", type: "list", itemType: "string" },
    { key: "languages", type: "list", itemType: "string" },
    { key: "certifications", type: "list", itemType: "string" },
    { key: "years_of_experience", type: "integer" },
    { key: "seniority", type: "select", options: [{ value: "junior" }, { value: "mid" }, { value: "senior" }] },
    {
      key: "spoken_languages",
      type: "multiselect",
      hints: ["languages"],
      options: [
        { value: "en", label: "English" },
        { value: "de", label: "German" },
        { value: "fr", label: "French" },
      ],
    },
    { key: "date_of_birth", type: "date" },
  ];

  it("extracts contact details, sections and lists", () => {
    const values = heuristicExtract(CV_TEXT, fields);
    expect(values).toEqual({
      full_name: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+44 20 7946 0958",
      linkedin: "https://linkedin.com/in/janedoe",
      job_title: "Senior Software Engineer",
      summary: "Experienced engineer with 8 years of experience building distributed systems and leading small teams.",
      experience: [
        "Acme Corp - Lead Engineer (2019 - Present)",
        "- Led a team of 6 engineers delivering the payments platform.",
        "Globex - Software Engineer (2015 - 2019)",
        "- Built data pipelines in Python and Go.",
      ].join("\n"),
      education: "BSc Computer Science, University of Leeds, 2014",
      skills: ["TypeScript", "Node.js", "PostgreSQL", "Kubernetes", "AWS"],
      languages: ["English (native)", "German (B2)"],
      certifications: null,
      years_of_experience: 8,
      seniority: "senior",
      spoken_languages: ["en", "de"],
      date_of_birth: null,
    });
  });

  it("reads labeled CVs, bullet lists and Turkish headings", () => {
    const text = [
      "ÖZGEÇMİŞ",
      "Ad Soyad: Ayşe Yılmaz",
      "E-posta: ayse.yilmaz@ornek.com.tr",
      "Telefon: 0532 123 45 67",
      "Doğum Tarihi: 05.03.1990",
      "",
      "YETENEKLER",
      "• Python",
      "• SQL; Power BI",
      "• Proje yönetimi",
      "",
      "SERTİFİKALAR",
      "- PMP (2021)",
      "- AWS Certified Cloud Practitioner",
    ].join("\n");
    const values = heuristicExtract(text, [
      { key: "full_name", type: "string" },
      { key: "email", type: "email" },
      { key: "phone", type: "phone" },
      { key: "date_of_birth", type: "date" },
      { key: "skills", type: "list", itemType: "string" },
      { key: "certifications", type: "list" },
    ]);
    expect(values).toEqual({
      full_name: "Ayşe Yılmaz",
      email: "ayse.yilmaz@ornek.com.tr",
      phone: "0532 123 45 67",
      date_of_birth: "1990-03-05",
      skills: ["Python", "SQL", "Power BI", "Proje yönetimi"],
      certifications: ["PMP (2021)", "AWS Certified Cloud Practitioner"],
    });
  });

  it("splits a section into objects for lists of objects, and returns [] when absent", () => {
    const text = [
      "Jane Doe",
      "Experience",
      "Company: Acme Corp",
      "Title: Lead Engineer",
      "",
      "Company: Globex",
      "Title: Software Engineer",
      "Skills",
      "Go",
    ].join("\n");
    const roles: FieldSpec = { key: "experience", type: "list", fields: [{ key: "company", type: "string" }, { key: "title", type: "string" }] };
    const projects: FieldSpec = { key: "projects", type: "list", fields: [{ key: "name", type: "string" }] };
    expect(heuristicExtract(text, [roles, projects])).toEqual({
      experience: [
        { company: "Acme Corp", title: "Lead Engineer" },
        { company: "Globex", title: "Software Engineer" },
      ],
      projects: [],
    });
  });
});

describe("heuristicExtract: invoices", () => {
  it("extracts a Turkish invoice (labels, dd.mm.yyyy dates, 1.234,56 amounts, VKN, IBAN)", () => {
    const values = heuristicExtract(TR_INVOICE_TEXT, [
      { key: "invoice_number", type: "string" },
      { key: "invoice_date", type: "date" },
      { key: "due_date", type: "date" },
      { key: "supplier", type: "string" },
      { key: "customer", type: "string" },
      { key: "tax_id", type: "string" },
      { key: "subtotal", type: "number" },
      { key: "vat", type: "number" },
      { key: "vat_rate", type: "number" },
      { key: "total", type: "number" },
      { key: "currency", type: "select", options: [{ value: "TRY" }, { value: "EUR" }, { value: "USD" }] },
      { key: "iban", type: "string" },
      { key: "po_number", type: "string" },
    ]);
    expect(values).toEqual({
      invoice_number: "FTR-2026-0042",
      invoice_date: "2026-09-12",
      due_date: "2026-10-12",
      supplier: "ACME Yazılım A.Ş.",
      customer: "Beta Ticaret Ltd. Şti.",
      tax_id: "1234567890",
      subtotal: 10288.06,
      vat: 2057.61,
      vat_rate: 20,
      total: 12345.67,
      currency: "TRY",
      iban: "TR330006100519786457841326",
      po_number: null,
    });
  });

  it("reads a field whose key ends in a known kind as that kind (supplier_tax_id is a tax id)", () => {
    const text = ["INVOICE", "Kaya Celik Sanayi A.S. · Tax ID: 5470321986 · satis@kayacelik.example", "PO Number: PO-4500012"].join("\n");
    expect(
      heuristicExtract(text, [
        { key: "supplier_tax_id", type: "string", hints: ["Tax ID"] },
        { key: "customer_po_number", type: "string", hints: ["PO Number"] },
      ]),
    ).toEqual({ supplier_tax_id: "5470321986", customer_po_number: "PO-4500012" });
  });

  it("uses hints and labels, and reads English number and date formats", () => {
    const text = [
      "Northwind Traders Ltd",
      "INVOICE",
      "Invoice Number: INV-2026-117    Order Ref: PO-5512",
      "Issue Date: March 3, 2026",
      "Payment due: 2 April 2026",
      "Bill To",
      "Contoso GmbH",
      "Subtotal: $1,029.00",
      "VAT (20%): $205.80",
      "Total Due: $1,234.80",
      "Paid: no",
    ].join("\n");
    const values = heuristicExtract(text, [
      { key: "invoice_number", type: "string" },
      { key: "po_reference", type: "string", hints: ["Order Ref"] },
      { key: "issue_date", type: "date" },
      { key: "due_date", type: "date" },
      { key: "customer", type: "string" },
      { key: "supplier", type: "string" },
      { key: "total", type: "number" },
      { key: "vat", type: "number" },
      { key: "currency", type: "string" },
      { key: "paid", type: "boolean" },
    ]);
    expect(values).toEqual({
      invoice_number: "INV-2026-117",
      po_reference: "PO-5512",
      issue_date: "2026-03-03",
      due_date: "2026-04-02",
      customer: "Contoso GmbH",
      supplier: "Northwind Traders Ltd",
      total: 1234.8,
      vat: 205.8,
      currency: "USD",
      paid: false,
    });
  });

  it("maps table header rows to the values below them", () => {
    const text = ["Invoice No | Date | Amount Due", "INV-9 | 15/01/2026 | 99,90 €"].join("\n");
    expect(
      heuristicExtract(text, [
        { key: "invoice_number", type: "string" },
        { key: "date", type: "date" },
        { key: "amount_due", type: "number" },
      ]),
    ).toEqual({ invoice_number: "INV-9", date: "2026-01-15", amount_due: 99.9 });
  });
});

describe("heuristicExtract: robustness", () => {
  it("returns null for every missing field", () => {
    expect(
      heuristicExtract("Nothing useful here.", [
        { key: "email", type: "email" },
        { key: "total", type: "number" },
        { key: "skills", type: "list", itemType: "string" },
        { key: "tags", type: "multiselect", options: [{ value: "urgent" }] },
        { key: "attachment", type: "file" },
        { key: "address", type: "object", fields: [{ key: "city", type: "string" }] },
      ]),
    ).toEqual({ email: null, total: null, skills: null, tags: null, attachment: null, address: null });
  });

  it("never throws on malformed input", () => {
    const hostile = [
      null,
      { type: "string" },
      { key: "weird", type: "not-a-type" },
      { key: "x", type: "select", options: null },
      { key: "y", type: "string", hints: [null, 42, "((("] },
    ] as unknown as FieldSpec[];
    expect(() => heuristicExtract(undefined as unknown as string, hostile)).not.toThrow();
    expect(heuristicExtract("(((", hostile)).toEqual({ weird: null, x: null, y: null });
    expect(heuristicExtract("text", null as unknown as FieldSpec[])).toEqual({});
  });

  it("stays linear on pathological input (long runs that make naive regexes backtrack)", async () => {
    const n = 200_000;
    const fields = [...fieldsForDocumentType("cv"), ...fieldsForDocumentType("invoice"), ...fieldsForDocumentType("id-document")];
    const inputs = [
      "QUJD".repeat(n / 4), // base64-like token
      "a" + " ".repeat(n) + "b",
      "1 ".repeat(n / 2),
      "-".repeat(n) + "x",
      "a" + " |".repeat(n / 2) + "b",
      "a.".repeat(n / 2) + "com",
      "\n".repeat(n) + "x",
    ];
    for (const text of inputs) {
      const started = performance.now();
      heuristicExtract(text, fields);
      detectDocumentType(text, "x.txt");
      analyzeSample(await extractDocument({ data: Buffer.from(`<table><tr><td>${text}`), fileName: "x.html" }));
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

describe("value parsers", () => {
  it("parses dates in many formats to ISO", () => {
    expect(parseDateToIso("12.09.2026")).toBe("2026-09-12");
    expect(parseDateToIso("2026-09-12T10:30:00Z")).toBe("2026-09-12");
    expect(parseDateToIso("09/13/2026")).toBe("2026-09-13");
    expect(parseDateToIso("12 Eylül 2026")).toBe("2026-09-12");
    expect(parseDateToIso("3. März 2026")).toBe("2026-03-03");
    expect(parseDateToIso("Sep 5th, 2026")).toBe("2026-09-05");
    expect(parseDateToIso("15-Oct-26")).toBe("2026-10-15");
    expect(parseDateToIso("Jan 2019 - Present")).toBe("2019-01-01");
    expect(parseDateToIso("31.02.2026")).toBeNull();
    expect(parseDateToIso("no date")).toBeNull();
  });

  it("parses amounts with either decimal convention and currency markers", () => {
    expect(parseAmount("12.345,67 TL")).toBe(12345.67);
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount("€ 1.234.567,8")).toBe(1234567.8);
    expect(parseAmount("CHF 1'250.50")).toBe(1250.5);
    expect(parseAmount("-45,5")).toBe(-45.5);
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount("1.234", ",")).toBe(1234);
    expect(parseAmount("1.234", ".")).toBe(1.234);
    expect(parseAmount("Ref INV-2026")).toBeNull();
  });
});
