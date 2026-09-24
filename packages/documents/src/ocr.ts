import type { ContentBlockParam, LlmClient, LlmUsage } from "@enterprise-brain/llm";

export const OCR_PURPOSE = "documents.ocr";

const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

/** Image formats Claude vision accepts; others (TIFF, BMP, HEIC) must be converted first. */
export function isClaudeImageType(mimeType: string): mimeType is ClaudeImageType {
  return (CLAUDE_IMAGE_TYPES as readonly string[]).includes(mimeType);
}

export type OcrSource =
  | { kind: "pdf"; data: Buffer; pageCount: number }
  | { kind: "image"; data: Buffer; mediaType: ClaudeImageType };

export interface LlmOcrResult {
  text: string;
  /** Per-page text for PDFs (from the page markers the model is asked to emit). */
  pages?: { number: number; text: string }[];
  usage: LlmUsage;
  /** The transcript hit the output token limit. */
  truncated: boolean;
}

const PAGE_MARKER = /^=== Page (\d+) ===[ \t]*$/gm;

function ocrInstruction(source: OcrSource): string {
  const paged = source.kind === "pdf" && source.pageCount > 1;
  return [
    `Transcribe all text in this ${source.kind === "pdf" ? "document" : "image"} faithfully and completely, exactly as written:`,
    "keep the original language, spelling, numbers, dates, amounts and punctuation.",
    "Preserve the natural reading order (finish each column of a multi-column layout before the next).",
    "Render tables as Markdown tables, and keep headings, list items and form labels with their values on their own lines.",
    "Write [illegible] for text you cannot read. Do not summarize, translate, correct, or describe images or layout.",
    ...(paged ? ["Start every page with a line of the form `=== Page N ===`."] : []),
    "Output only the transcription.",
  ].join("\n");
}

function stripCodeFence(text: string): string {
  const fenced = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

function splitPages(text: string): { number: number; text: string }[] | undefined {
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (markers.length === 0) return undefined;
  return markers.map((marker, i) => ({
    number: Number(marker[1]),
    text: text.slice(marker.index + marker[0].length, markers[i + 1]?.index ?? text.length).trim(),
  }));
}

/** OCR through Claude: the PDF (document block) or image (vision block) plus a transcription instruction. */
export async function ocrWithLlm(llm: LlmClient, source: OcrSource): Promise<LlmOcrResult> {
  const data = source.data.toString("base64");
  const block: ContentBlockParam =
    source.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: source.mediaType, data } };
  const result = await llm.complete({
    purpose: OCR_PURPOSE,
    messages: [{ role: "user", content: [block, { type: "text", text: ocrInstruction(source) }] }],
    effort: "low",
    // Transcripts of long scans are long: ~2k output tokens per page, between the client's 16k default and 64k.
    ...(source.kind === "pdf" ? { maxTokens: Math.min(64_000, Math.max(16_000, source.pageCount * 2_000)) } : {}),
  });
  const text = stripCodeFence(result.text);
  const meta = { usage: result.usage, truncated: result.stopReason === "max_tokens" };
  if (source.kind === "image") return { text, ...meta };
  if (source.pageCount <= 1) return { text, pages: [{ number: 1, text }], ...meta };
  const pages = splitPages(text);
  return pages ? { text: pages.map((page) => page.text).join("\n\n"), pages, ...meta } : { text, ...meta };
}

type TesseractRecognize = (image: Buffer, languages?: string) => Promise<{ data?: { text?: string } }>;

let tesseractLoader: Promise<TesseractRecognize | undefined> | undefined;

/** tesseract.js is optional and not a dependency: it is resolved lazily and its absence just means "no local OCR". */
function loadTesseract(): Promise<TesseractRecognize | undefined> {
  tesseractLoader ??= (async () => {
    try {
      const specifier: string = "tesseract.js";
      const mod = (await import(/* @vite-ignore */ specifier)) as { recognize?: unknown; default?: { recognize?: unknown } };
      const recognize = mod.recognize ?? mod.default?.recognize;
      return typeof recognize === "function" ? (recognize as TesseractRecognize) : undefined;
    } catch {
      return undefined;
    }
  })();
  return tesseractLoader;
}

/** Local OCR of an image with tesseract.js when it is installed; undefined when it is not. */
export async function ocrWithTesseract(image: Buffer, languages = "eng"): Promise<string | undefined> {
  const recognize = await loadTesseract();
  if (!recognize) return undefined;
  const result = await recognize(image, languages);
  return result.data?.text ?? "";
}
