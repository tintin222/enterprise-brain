import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseCsv, readWorkbook, renderSheetsAsText, writeWorkbook } from "../src/index.ts";

async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as ArrayBuffer);
  return workbook;
}

describe("writeWorkbook / readWorkbook", () => {
  it("round-trips typed values", async () => {
    const data = await writeWorkbook([
      {
        name: "Candidates",
        columns: ["Name", "Score", "Hired", "Applied", "Interview", "Skills", "Notes"],
        rows: [
          {
            Name: "Jane Doe",
            Score: 92.5,
            Hired: true,
            Applied: "2026-09-12",
            Interview: new Date(Date.UTC(2026, 8, 20, 14, 30)),
            Skills: ["TypeScript", "Go"],
            Notes: { source: "referral" },
          },
          { Name: "Ali Kaya", Score: 78, Hired: false, Applied: "2026-02-30", Interview: null, Extra: "ignored" },
        ],
      },
    ]);
    expect(Buffer.isBuffer(data)).toBe(true);

    const [sheet] = await readWorkbook(data);
    expect(sheet).toEqual({
      name: "Candidates",
      columns: ["Name", "Score", "Hired", "Applied", "Interview", "Skills", "Notes"],
      rows: [
        {
          Name: "Jane Doe",
          Score: 92.5,
          Hired: true,
          Applied: "2026-09-12",
          Interview: "2026-09-20T14:30:00.000Z",
          Skills: "TypeScript, Go",
          Notes: '{"source":"referral"}',
        },
        // "2026-02-30" is not a real date, so it stays text.
        { Name: "Ali Kaya", Score: 78, Hired: false, Applied: "2026-02-30", Interview: null, Skills: null, Notes: null },
      ],
    });
  });

  it("writes a bold, frozen, filterable header with fitted widths and date formats", async () => {
    const data = await writeWorkbook([
      { name: "Report", rows: [{ Region: "EMEA", "Signed on": "2026-09-12", Comment: "A considerably longer comment value" }] },
    ]);
    const worksheet = (await loadWorkbook(data)).getWorksheet("Report")!;
    expect(worksheet.getRow(1).font?.bold).toBe(true);
    expect(worksheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(worksheet.autoFilter).toBeDefined();
    expect(worksheet.getColumn(1).width).toBe(8);
    expect(worksheet.getColumn(3).width).toBe("A considerably longer comment value".length + 2);
    const signed = worksheet.getCell("B2");
    expect(signed.value).toBeInstanceOf(Date);
    expect(signed.numFmt).toBe("yyyy-mm-dd");
  });

  it("sanitizes sheet names and never writes an empty workbook", async () => {
    const data = await writeWorkbook([
      { name: "Sales/2026: Q3?", rows: [{ a: 1 }] },
      { name: "sales 2026  Q3", rows: [{ a: 2 }] },
      { name: "A very long sheet name that Excel would reject", rows: [] },
    ]);
    const names = (await loadWorkbook(data)).worksheets.map((worksheet) => worksheet.name);
    expect(names).toEqual(["Sales 2026  Q3", "sales 2026  Q3 (2)", "A very long sheet name that Exc"]);

    const empty = await loadWorkbook(await writeWorkbook([]));
    expect(empty.worksheets.map((worksheet) => worksheet.name)).toEqual(["Sheet1"]);
  });

  it("detects the header below title rows and normalizes formulas, rich text, links and errors", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Q3");
    worksheet.addRow(["Quarterly sales report"]);
    worksheet.addRow([]);
    worksheet.addRow(["Region", "Units", "Price", "Revenue", "Owner", "Link", "Check"]);
    worksheet.addRow([
      "EMEA",
      10,
      2.5,
      { formula: "B4*C4", result: 25 },
      { richText: [{ text: "Jane " }, { text: "Doe", font: { bold: true } }] },
      { text: "Dashboard", hyperlink: "https://example.com/d" },
      { error: "#N/A" },
    ]);
    worksheet.addRow(["APAC", 3, 1.5, { formula: "B5*C5" }]);
    worksheet.addRow(["Region", "Units"]);
    const data = Buffer.from(await workbook.xlsx.writeBuffer());

    const [sheet] = await readWorkbook(data);
    expect(sheet!.columns).toEqual(["Region", "Units", "Price", "Revenue", "Owner", "Link", "Check"]);
    expect(sheet!.rows).toEqual([
      { Region: "EMEA", Units: 10, Price: 2.5, Revenue: 25, Owner: "Jane Doe", Link: "Dashboard", Check: "#N/A" },
      { Region: "APAC", Units: 3, Price: 1.5, Revenue: null, Owner: null, Link: null, Check: null },
      { Region: "Region", Units: "Units", Price: null, Revenue: null, Owner: null, Link: null, Check: null },
    ]);
  });

  it("names columns generically when there is no header row", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Numbers");
    worksheet.addRow([1, 2]);
    worksheet.addRow([3, 4]);
    workbook.addWorksheet("Blank");
    const sheets = await readWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(sheets).toEqual([
      { name: "Numbers", columns: ["Column 1", "Column 2"], rows: [{ "Column 1": 1, "Column 2": 2 }, { "Column 1": 3, "Column 2": 4 }] },
      { name: "Blank", columns: [], rows: [] },
    ]);
  });
});

describe("renderSheetsAsText", () => {
  it("renders sheets as CSV-like text with a row limit", () => {
    const text = renderSheetsAsText(
      [
        {
          name: "People",
          columns: ["Name", "Note"],
          rows: [
            { Name: "Doe, Jane", Note: 'Says "hi"' },
            { Name: "Ali", Note: "line one\nline two" },
            { Name: "Can", Note: null },
          ],
        },
        { name: "Empty", columns: [], rows: [] },
      ],
      2,
    );
    expect(text).toBe(
      [
        "Sheet: People (3 rows)",
        "Name,Note",
        '"Doe, Jane","Says ""hi"""',
        "Ali,line one line two",
        "... 1 more row not shown",
        "",
        "Sheet: Empty (empty)",
      ].join("\n"),
    );
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes and line breaks inside quotes", () => {
    expect(parseCsv('a,b,c\n"1,5","say ""x""","multi\nline"\n')).toEqual([
      ["a", "b", "c"],
      ["1,5", 'say "x"', "multi\nline"],
    ]);
  });

  it("sniffs semicolon, tab and pipe delimiters", () => {
    expect(parseCsv("Ad;Tutar\nKalem;1.234,56\nDiğer;12,5")).toEqual([
      ["Ad", "Tutar"],
      ["Kalem", "1.234,56"],
      ["Diğer", "12,5"],
    ]);
    expect(parseCsv("name\tcity, country\nJane\tLondon, UK")).toEqual([
      ["name", "city, country"],
      ["Jane", "London, UK"],
    ]);
    expect(parseCsv("id|value\n1|a")).toEqual([
      ["id", "value"],
      ["1", "a"],
    ]);
  });

  it("is lenient with malformed input", () => {
    expect(parseCsv('a,b\n\n5" screen,x\n"unterminated,y', ",")).toEqual([
      ["a", "b"],
      ['5" screen', "x"],
      ["unterminated,y"],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("single column\nvalues")).toEqual([["single column"], ["values"]]);
  });
});
