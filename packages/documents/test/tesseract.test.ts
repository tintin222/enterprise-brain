import { describe, expect, it, vi } from "vitest";
import { extractDocument } from "../src/index.ts";
import { TINY_PNG } from "./fixtures.ts";

// tesseract.js is not a dependency; the extractor imports it lazily when it happens to be installed.
const { recognize } = vi.hoisted(() => ({
  recognize: vi.fn(async (_image: Buffer, languages?: string) => ({ data: { text: `TOTAL 3.50 (${languages})` } })),
}));
vi.mock("tesseract.js", () => ({ recognize }));

describe("tesseract.js fallback", () => {
  it("OCRs images locally when tesseract.js is installed and no LLM is configured", async () => {
    const doc = await extractDocument({ data: TINY_PNG, fileName: "receipt.png" }, { tesseractLanguages: "eng+tur" });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(doc.method).toBe("ocr-tesseract");
    expect(doc.needsOcr).toBe(true);
    expect(doc.text).toBe("TOTAL 3.50 (eng+tur)");
    expect(doc.warnings).toEqual([]);
  });
});
