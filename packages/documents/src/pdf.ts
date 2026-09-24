import { getDocumentProxy } from "unpdf";
import { normalizeText } from "./text.ts";

export interface PdfTextLayer {
  pageCount: number;
  /** Pages read, in order: all of them unless `maxChars` stopped the reading early. */
  pages: { number: number; text: string }[];
}

/**
 * The embedded text layer of a PDF, page by page (pdf.js via unpdf). Pages are
 * read in order until `maxChars` characters are collected, so a 2,000-page
 * manual is not parsed completely only to be truncated.
 */
export async function readPdfTextLayer(data: Uint8Array, maxChars = Infinity): Promise<PdfTextLayer> {
  // pdf.js may transfer (detach) the buffer it is given, so it gets its own copy.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  try {
    const pages: PdfTextLayer["pages"] = [];
    let total = 0;
    for (let number = 1; number <= pdf.numPages && total < maxChars; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      // Joined like unpdf's extractText: items in content order, line breaks where pdf.js detected them.
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      page.cleanup();
      pages.push({ number, text: normalizeText(text) });
      total += text.length;
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
