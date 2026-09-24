import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/** Standard PDF fonts are WinAnsi: keep Latin-1 letters, transliterate the Turkish ones it lacks. */
function winAnsi(text: string): string {
  return text.replace(/ş/g, "s").replace(/Ş/g, "S").replace(/ğ/g, "g").replace(/Ğ/g, "G").replace(/ı/g, "i").replace(/İ/g, "I").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/•/g, "-");
}

export type Block = { kind: "title" | "subtitle" | "heading" | "text" | "bullet"; text: string };

class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([595, 842]);
    this.y = 790;
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > width && line) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      lines.push(line);
    }
    return lines;
  }

  write(block: Block) {
    const styles = {
      title: { font: this.bold, size: 20, gap: 8, indent: 0, color: rgb(0.1, 0.1, 0.3) },
      subtitle: { font: this.font, size: 11, gap: 10, indent: 0, color: rgb(0.35, 0.35, 0.4) },
      heading: { font: this.bold, size: 12.5, gap: 6, indent: 0, color: rgb(0.15, 0.2, 0.5) },
      text: { font: this.font, size: 10.5, gap: 4, indent: 0, color: rgb(0.1, 0.1, 0.1) },
      bullet: { font: this.font, size: 10.5, gap: 2, indent: 12, color: rgb(0.1, 0.1, 0.1) },
    }[block.kind];
    if (block.kind === "heading") this.y -= 8;
    const text = winAnsi(block.kind === "bullet" ? `- ${block.text}` : block.text);
    for (const line of this.wrap(text, styles.font, styles.size, 595 - 100 - styles.indent)) {
      if (this.y < 60) this.newPage();
      this.page.drawText(line, { x: 50 + styles.indent, y: this.y, size: styles.size, font: styles.font, color: styles.color });
      this.y -= styles.size + 4;
    }
    this.y -= styles.gap;
  }
}

export async function pdfFromBlocks(blocks: Block[], title: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(title));
  doc.setProducer("Enterprise Brain demo data");
  const writer = new PdfWriter(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  for (const block of blocks) writer.write(block);
  return Buffer.from(await doc.save());
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A minimal but valid .docx (enough for Word, LibreOffice and mammoth). */
export async function docxFromBlocks(blocks: Block[]): Promise<Buffer> {
  const paragraph = (b: Block) => {
    const size = { title: 36, subtitle: 22, heading: 26, text: 21, bullet: 21 }[b.kind];
    const bold = b.kind === "title" || b.kind === "heading";
    const text = b.kind === "bullet" ? `• ${b.text}` : b.text;
    return `<w:p><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  };
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map(paragraph).join("")}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Demo CVs
// ---------------------------------------------------------------------------

export interface DemoCv {
  fileName: string;
  format: "pdf" | "docx";
  from: string;
  fromName: string;
  subject: string;
  body: string;
  blocks: Block[];
}

export const DEMO_CVS: DemoCv[] = [
  {
    fileName: "Deniz_Kaya_CV.pdf",
    format: "pdf",
    from: "deniz.kaya@example.com",
    fromName: "Deniz Kaya",
    subject: "Application: Senior Backend Engineer (Node.js)",
    body: "Hello,\n\nPlease find my CV attached for the Senior Backend Engineer position. I have 8 years of backend experience with Node.js and TypeScript.\n\nBest regards,\nDeniz Kaya",
    blocks: [
      { kind: "title", text: "Deniz Kaya" },
      { kind: "subtitle", text: "Senior Backend Engineer · Istanbul, Turkey · deniz.kaya@example.com · +90 532 111 22 33 · linkedin.com/in/denizkaya" },
      { kind: "heading", text: "Summary" },
      { kind: "text", text: "Backend engineer with 8 years of experience building high-traffic services in Node.js and TypeScript. Led the migration of a monolith to microservices on Kubernetes; comfortable owning services end to end, from design to on-call." },
      { kind: "heading", text: "Experience" },
      { kind: "text", text: "Lead Backend Engineer, Trendyol-like marketplace, Istanbul — 2021 to present" },
      { kind: "bullet", text: "Designed order and payment services in Node.js/TypeScript handling 3,000 requests per second." },
      { kind: "bullet", text: "Introduced PostgreSQL partitioning and Redis caching; cut p95 latency by 45%." },
      { kind: "bullet", text: "Mentored 5 engineers; ran architecture reviews." },
      { kind: "text", text: "Backend Engineer, FinTech startup, Istanbul — 2018 to 2021" },
      { kind: "bullet", text: "Built REST and GraphQL APIs with Node.js, Express and PostgreSQL; event streaming with Kafka." },
      { kind: "bullet", text: "Deployed on AWS (ECS, RDS, S3) with Terraform and GitHub Actions CI/CD." },
      { kind: "heading", text: "Education" },
      { kind: "text", text: "BSc Computer Engineering, Middle East Technical University (METU), 2018" },
      { kind: "heading", text: "Skills" },
      { kind: "text", text: "Node.js, TypeScript, PostgreSQL, Redis, Kafka, Docker, Kubernetes, AWS, Terraform, GraphQL, REST API design, microservices" },
      { kind: "heading", text: "Languages" },
      { kind: "text", text: "Turkish (native), English (C1, professional working proficiency)" },
      { kind: "heading", text: "Work authorisation" },
      { kind: "text", text: "Turkish citizen, no work permit required." },
    ],
  },
  {
    fileName: "Emily_Carter_Resume.pdf",
    format: "pdf",
    from: "emily.carter@example.co.uk",
    fromName: "Emily Carter",
    subject: "Backend Engineer application",
    body: "Hi,\n\nI'd love to be considered for your backend role. Resume attached. Note that I would need visa sponsorship to relocate to Istanbul.\n\nThanks,\nEmily",
    blocks: [
      { kind: "title", text: "Emily Carter" },
      { kind: "subtitle", text: "Frontend Developer · London, United Kingdom · emily.carter@example.co.uk · +44 7700 900123" },
      { kind: "heading", text: "Profile" },
      { kind: "text", text: "Frontend developer with 2 years of experience in React and CSS, keen to move into backend development." },
      { kind: "heading", text: "Experience" },
      { kind: "text", text: "Junior Frontend Developer, Digital agency, London — 2024 to present" },
      { kind: "bullet", text: "Built marketing websites and dashboards in React and Next.js." },
      { kind: "bullet", text: "Wrote small Node.js scripts for build automation." },
      { kind: "heading", text: "Education" },
      { kind: "text", text: "BA Graphic Design, University of the Arts London, 2023; Coding bootcamp (JavaScript), 2023" },
      { kind: "heading", text: "Skills" },
      { kind: "text", text: "React, JavaScript, HTML, CSS, Figma, basic Node.js" },
      { kind: "heading", text: "Languages" },
      { kind: "text", text: "English (native), French (B1)" },
      { kind: "heading", text: "Work authorisation" },
      { kind: "text", text: "UK citizen; requires visa sponsorship for Turkey." },
    ],
  },
  {
    fileName: "Mehmet_Ozturk_Ozgecmis.docx",
    format: "docx",
    from: "mehmet.ozturk@example.com.tr",
    fromName: "Mehmet Öztürk",
    subject: "Kıdemli Backend Mühendisi pozisyonu başvurusu",
    body: "Merhaba,\n\nKıdemli Backend Mühendisi pozisyonu için özgeçmişimi ekte bulabilirsiniz.\n\nSaygılarımla,\nMehmet Öztürk",
    blocks: [
      { kind: "title", text: "Mehmet Öztürk" },
      { kind: "subtitle", text: "Yazılım Mühendisi · Ankara · mehmet.ozturk@example.com.tr · +90 555 444 33 22" },
      { kind: "heading", text: "Özet" },
      { kind: "text", text: "5 yıllık deneyime sahip yazılım mühendisi. Java/Spring ile kurumsal sistemler geliştirdim, son 2 yıldır Node.js ve TypeScript ile mikroservisler geliştiriyorum." },
      { kind: "heading", text: "İş Deneyimi" },
      { kind: "text", text: "Yazılım Mühendisi, Savunma sanayi şirketi, Ankara — 2023 - günümüz" },
      { kind: "bullet", text: "Node.js ve TypeScript ile veri toplama servisleri geliştirdim." },
      { kind: "bullet", text: "PostgreSQL ve Docker ile servislerin performansını iyileştirdim." },
      { kind: "text", text: "Java Geliştirici, Bankacılık yazılımı firması, İstanbul — 2021 - 2023" },
      { kind: "bullet", text: "Java/Spring Boot ile ödeme sistemleri geliştirdim; Oracle veritabanı." },
      { kind: "heading", text: "Eğitim" },
      { kind: "text", text: "Bilgisayar Mühendisliği Lisans, Hacettepe Üniversitesi, 2021" },
      { kind: "heading", text: "Yetenekler" },
      { kind: "text", text: "Node.js, TypeScript, Java, Spring Boot, PostgreSQL, Docker, Git, REST API" },
      { kind: "heading", text: "Diller" },
      { kind: "text", text: "Türkçe (ana dil), İngilizce (B2)" },
    ],
  },
];

export async function renderCv(cv: DemoCv): Promise<{ data: Buffer; mimeType: string }> {
  if (cv.format === "docx") {
    return { data: await docxFromBlocks(cv.blocks), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  return { data: await pdfFromBlocks(cv.blocks, `${cv.fromName} CV`), mimeType: "application/pdf" };
}

// ---------------------------------------------------------------------------
// Demo invoices
// ---------------------------------------------------------------------------

export interface DemoInvoice {
  fileName: string;
  supplierName: string;
  supplierTaxId: string;
  supplierEmail: string;
  invoiceNumber: string;
  invoiceDate: string;
  poNumber?: string;
  currency: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  vatRate: number;
  iban: string;
}

export function invoiceTotals(invoice: DemoInvoice) {
  const net = Math.round(invoice.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
  const tax = Math.round(net * invoice.vatRate) / 100;
  return { net, tax, total: Math.round((net + tax) * 100) / 100 };
}

export async function renderInvoice(invoice: DemoInvoice): Promise<Buffer> {
  const money = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${invoice.currency}`;
  const { net, tax, total } = invoiceTotals(invoice);
  return pdfFromBlocks(
    [
      { kind: "title", text: "INVOICE" },
      { kind: "subtitle", text: `${invoice.supplierName} · Tax ID: ${invoice.supplierTaxId} · ${invoice.supplierEmail}` },
      { kind: "heading", text: "Invoice details" },
      { kind: "text", text: `Invoice Number: ${invoice.invoiceNumber}` },
      { kind: "text", text: `Invoice Date: ${invoice.invoiceDate}` },
      ...(invoice.poNumber ? [{ kind: "text" as const, text: `PO Number: ${invoice.poNumber}` }] : []),
      { kind: "text", text: "Bill to: Acme Endustri A.S., Organize Sanayi Bolgesi 12. Cadde No:4, Kocaeli, Turkey" },
      { kind: "heading", text: "Items" },
      ...invoice.lines.map((l) => ({ kind: "bullet" as const, text: `${l.description} — ${l.quantity} x ${money(l.unitPrice)} = ${money(l.quantity * l.unitPrice)}` })),
      { kind: "heading", text: "Totals" },
      { kind: "text", text: `Net Amount: ${money(net)}` },
      { kind: "text", text: `VAT (${invoice.vatRate}%): ${money(tax)}` },
      { kind: "text", text: `Total Amount: ${money(total)}` },
      { kind: "heading", text: "Payment" },
      { kind: "text", text: `Payment terms: 60 days end of month. IBAN: ${invoice.iban}` },
    ],
    `Invoice ${invoice.invoiceNumber}`,
  );
}
