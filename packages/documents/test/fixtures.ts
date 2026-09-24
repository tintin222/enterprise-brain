/** Test fixtures, generated in memory so no binary files are committed. */
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { emptyUsage, type CompleteRequest, type LlmClient } from "@enterprise-brain/llm";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const CV_TEXT = `Jane Doe
Senior Software Engineer
jane.doe@example.com | +44 20 7946 0958 | linkedin.com/in/janedoe
London, United Kingdom

Summary
Experienced engineer with 8 years of experience building distributed systems and leading small teams.

Experience
Acme Corp - Lead Engineer (2019 - Present)
- Led a team of 6 engineers delivering the payments platform.
Globex - Software Engineer (2015 - 2019)
- Built data pipelines in Python and Go.

Education
BSc Computer Science, University of Leeds, 2014

Skills
TypeScript, Node.js, PostgreSQL, Kubernetes, AWS

Languages
English (native), German (B2)`;

export const TR_INVOICE_TEXT = `ACME Yazılım A.Ş.
Vergi Dairesi: Kadıköy VKN: 1234567890
FATURA
Fatura No: FTR-2026-0042
Tarih: 12.09.2026
Vade Tarihi: 12.10.2026
Sayın: Beta Ticaret Ltd. Şti.
Açıklama | Miktar | Birim Fiyat | Tutar
Danışmanlık hizmeti | 1 | 10.288,06 | 10.288,06
Ara Toplam: 10.288,06 TL
KDV (%20): 2.057,61 TL
Toplam: 12.345,67 TL
IBAN: TR33 0006 1005 1978 6457 8413 26`;

/** A two-page digital CV (Helvetica, WinAnsi characters only). */
export async function makeCvPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [CV_TEXT.split("\n").slice(0, 14), CV_TEXT.split("\n").slice(14)];
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    let y = 790;
    for (const line of lines) {
      if (line) page.drawText(line, { x: 56, y, size: 11, font: /^[A-Z][a-z]+$/.test(line) ? bold : font });
      y -= line ? 16 : 10;
    }
  }
  return Buffer.from(await pdf.save());
}

/** A digital PDF with one line of text per page. */
export async function makeTextPdf(pageTexts: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) pdf.addPage([595, 842]).drawText(text, { x: 56, y: 790, size: 11, font });
  return Buffer.from(await pdf.save());
}

/** A ZIP archive (no data, only headers) whose central directory declares one entry of `uncompressedSize` bytes. */
export function zipDeclaring(entryName: string, uncompressedSize: number): Buffer {
  const name = Buffer.from(entryName);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

/** A PDF whose pages carry no text layer, like a scan. */
export async function makeBlankPdf(pageCount = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

function cell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph(text)] });
}

/** A Turkish invoice with a line-item table. */
export async function makeInvoiceDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "ACME Yazılım A.Ş.", heading: HeadingLevel.HEADING_2 }),
          new Paragraph("Vergi Dairesi: Kadıköy VKN: 1234567890"),
          new Paragraph({ text: "FATURA", heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
          new Paragraph({ children: [new TextRun({ text: "Fatura No: ", bold: true }), new TextRun("FTR-2026-0042")] }),
          new Paragraph({ children: [new TextRun({ text: "Tarih: ", bold: true }), new TextRun("12.09.2026")] }),
          new Paragraph("Sayın: Beta Ticaret Ltd. Şti."),
          new Table({
            rows: [
              new TableRow({ children: [cell("Açıklama"), cell("Miktar"), cell("Birim Fiyat"), cell("Tutar")] }),
              new TableRow({ children: [cell("Danışmanlık hizmeti"), cell("1"), cell("10.288,06"), cell("10.288,06")] }),
            ],
          }),
          new Paragraph("Ara Toplam: 10.288,06 TL"),
          new Paragraph("KDV (%20): 2.057,61 TL"),
          new Paragraph({ children: [new TextRun({ text: "Genel Toplam: 12.345,67 TL", bold: true })] }),
          new Paragraph("Ödeme bilgileri için lütfen faturanın ekindeki banka hesabını kullanınız."),
          new Paragraph("IBAN: TR33 0006 1005 1978 6457 8413 26"),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An LlmClient double that records requests and answers `complete` with a fixed transcript. */
export function fakeLlm(reply: string | ((request: CompleteRequest) => string)) {
  const requests: CompleteRequest[] = [];
  const llm: LlmClient = {
    available: true,
    provider: "fake",
    model: "fake-model",
    async complete(request) {
      requests.push(request);
      const text = typeof reply === "function" ? reply(request) : reply;
      return { text, stopReason: "end_turn", usage: { ...emptyUsage(), calls: 1, inputTokens: 1200, outputTokens: 80 }, model: "fake-model" };
    },
    async structured() {
      throw new Error("structured() is not used by document extraction");
    },
    async runTools() {
      throw new Error("runTools() is not used by document extraction");
    },
  };
  return { llm, requests };
}
