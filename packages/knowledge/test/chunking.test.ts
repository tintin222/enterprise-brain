import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_CHUNK_MAX_CHARS, normalizeText, type Chunk } from "../src/index.ts";

const sentence = (i: number) => `Rule ${i} says that employees must follow the documented process carefully.`;
const paragraph = (count: number, from = 0) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

/** Deterministic text without spaces or punctuation (substrings of 10+ characters are unique). */
function blob(length: number): string {
  let seed = 42;
  let out = "";
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += String.fromCharCode(97 + ((seed >>> 16) % 26));
  }
  return out;
}

/** Length of the longest prefix of `next` that is also a suffix of `previous`. */
function overlapLength(previous: string, next: string): number {
  for (let length = Math.min(previous.length, next.length); length > 0; length--) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

/** False when the string contains lone surrogates (they do not survive a UTF-8 round trip). */
const isWellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;

function expectWithinLimit(chunks: Chunk[], maxChars: number) {
  expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  for (const chunk of chunks) {
    expect(chunk.content.trim()).toBe(chunk.content);
    expect(chunk.content.length).toBeGreaterThan(0);
    expect(chunk.content.length).toBeLessThanOrEqual(maxChars);
  }
}

describe("chunkText", () => {
  it("returns no chunks for empty, whitespace-only or rule-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(" \n\r\n\t \f ")).toEqual([]);
    expect(chunkText("---\n\n***")).toEqual([]);
  });

  it("keeps a short document in a single chunk", () => {
    expect(chunkText("  Employees get 20 days of annual leave.  \n")).toEqual([
      { ordinal: 0, content: "Employees get 20 days of annual leave.", metadata: {} },
    ]);
  });

  it("merges small paragraphs up to maxChars without losing any", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} is short.`);
    const chunks = chunkText(paragraphs.join("\n\n"), { maxChars: 200, overlap: 0 });
    expectWithinLimit(chunks, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(6);
    const all = chunks.map((c) => c.content).join("\n\n");
    expect(all).toBe(paragraphs.join("\n\n"));
  });

  it("splits oversized paragraphs on sentence boundaries", () => {
    const chunks = chunkText(paragraph(40), { maxChars: 300, overlap: 0 });
    expectWithinLimit(chunks, 300);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/^Rule \d+ says/);
      expect(chunk.content).toMatch(/carefully\.$/);
    }
    expect(chunks.map((c) => c.content).join(" ")).toBe(paragraph(40));
  });

  it("starts each continuation chunk with overlap from the previous chunk", () => {
    const chunks = chunkText(paragraph(40), { maxChars: 300, overlap: 100 });
    expectWithinLimit(chunks, 300);
    for (let i = 1; i < chunks.length; i++) {
      const shared = overlapLength(chunks[i - 1]!.content, chunks[i]!.content);
      expect(shared).toBeGreaterThanOrEqual(50);
      expect(shared).toBeLessThanOrEqual(100);
      // Overlap is cut at a sentence boundary here.
      expect(chunks[i]!.content).toMatch(/^Rule \d+ says/);
    }
  });

  it("carries the nearest heading into metadata and prefixes continuation chunks with it", () => {
    const text = [
      "# Employee Handbook",
      "Welcome to the handbook.",
      "## Annual leave",
      paragraph(12),
      "## Sick leave",
      paragraph(3, 100),
    ].join("\n\n");
    const chunks = chunkText(text, { maxChars: 400, overlap: 80 });
    expectWithinLimit(chunks, 400);

    expect(chunks[0]!.content.startsWith("# Employee Handbook\n\nWelcome to the handbook.")).toBe(true);
    expect(chunks[0]!.metadata).toEqual({ heading: "Employee Handbook", headingPath: ["Employee Handbook"] });

    const annual = chunks.filter((c) => c.metadata.heading === "Annual leave");
    expect(annual.length).toBeGreaterThanOrEqual(2);
    for (const chunk of annual) {
      expect(chunk.metadata.headingPath).toEqual(["Employee Handbook", "Annual leave"]);
      expect(chunk.content.startsWith("## Annual leave\n\nRule ")).toBe(true);
    }

    const sick = chunks.filter((c) => c.content.includes("Rule 100 says"));
    expect(sick).toHaveLength(1);
    expect(sick[0]!.metadata.heading).toBe("Sick leave");
    expect(sick[0]!.content.startsWith("## Sick leave\n\n")).toBe(true);
    // A chunk opening at a heading carries no overlap from the previous section.
    expect(sick[0]!.content).not.toContain("Rule 11 says");
  });

  it("never leaves a heading dangling at the end of a chunk", () => {
    const text = [paragraph(3), "## Next section", paragraph(3, 50)].join("\n\n");
    const chunks = chunkText(text, { maxChars: 300, overlap: 0 });
    for (const chunk of chunks) expect(chunk.content).not.toMatch(/## Next section$/);
    expect(chunks.some((c) => c.content.startsWith("## Next section\n\nRule 50"))).toBe(true);
  });

  it("treats CRLF and LF input identically", () => {
    const text = "# Title\n\nFirst paragraph.\nWrapped line.\n\n## Part\n\nSecond paragraph.";
    const crlf = chunkText(text.replace(/\n/g, "\r\n"));
    expect(crlf).toEqual(chunkText(text));
    expect(crlf[0]!.content).not.toContain("\r");
  });

  it("splits a very long line without spaces into overlapping pieces within the limit", () => {
    const text = blob(5000);
    const chunks = chunkText(text, { maxChars: 500, overlap: 50 });
    expectWithinLimit(chunks, 500);
    let end = 0;
    for (const [i, chunk] of chunks.entries()) {
      const start = text.indexOf(chunk.content);
      expect(start).toBeGreaterThanOrEqual(0);
      if (i === 0) expect(start).toBe(0);
      else expect(end - start).toBeLessThanOrEqual(50); // overlap only, never a gap
      expect(start).toBeLessThanOrEqual(end);
      end = start + chunk.content.length;
    }
    expect(end).toBe(text.length);
  });

  it("splits a very long line of words on word boundaries", () => {
    const words = Array.from({ length: 800 }, (_, i) => `token${i}`);
    const chunks = chunkText(words.join(" "), { maxChars: 300, overlap: 40 });
    expectWithinLimit(chunks, 300);
    for (const chunk of chunks) {
      for (const word of chunk.content.split(" ")) expect(word).toMatch(/^token\d+$/);
    }
    expect(new Set(chunks.flatMap((c) => c.content.split(" "))).size).toBe(800);
  });

  it("chunks Turkish text on sentence boundaries and keeps Turkish characters intact", () => {
    const sentences = [
      "Bir yılını dolduran çalışanlar her yıl 14 iş günü ücretli yıllık izin hakkı kazanır.",
      "Beş yıldan fazla kıdemi olan çalışanlar için bu süre 20 iş gününe çıkar.",
      "İzin talepleri en az iki hafta önceden yöneticiye iletilmelidir.",
      "Kullanılmayan izin günleri bir sonraki yıla devredilebilir.",
      "Şirket, yoğun dönemlerde izin tarihlerini değiştirme hakkını saklı tutar.",
    ];
    const chunks = chunkText(`# Yıllık İzin Politikası\r\n\r\n${sentences.join(" ")}`, { maxChars: 220, overlap: 60 });
    expectWithinLimit(chunks, 220);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.heading).toBe("Yıllık İzin Politikası");
      expect(chunk.content.startsWith("# Yıllık İzin Politikası\n\n")).toBe(true);
    }
    const all = chunks.map((c) => c.content).join("\n");
    for (const s of sentences) expect(all).toContain(s);
  });

  it("normalises decomposed characters to NFC", () => {
    const decomposed = `Is${String.fromCharCode(0x327)}ik politikas${String.fromCharCode(0x131)}`; // "Işik" with a combining cedilla
    const [chunk] = chunkText(decomposed);
    expect(chunk!.content).toBe(decomposed.normalize("NFC"));
    expect(chunk!.content).toContain("ş");
  });

  it("never splits surrogate pairs", () => {
    const chunks = chunkText("😀🇹🇷".repeat(200), { maxChars: 50, overlap: 10 });
    expectWithinLimit(chunks, 50);
    for (const chunk of chunks) expect(isWellFormed(chunk.content)).toBe(true);
  });

  it("keeps fenced code intact and does not read comments in it as headings", () => {
    const text = "## Setup\n\n```bash\n# install dependencies\nnpm install\n\n# start\nnpm start\n```\n\nDone.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(text);
    expect(chunks[0]!.metadata.heading).toBe("Setup");
  });

  it("restates the table header in every chunk a table spills into", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| ${i + 1} years | ${14 + i} days |`);
    const text = `## Entitlement\n\n| Tenure | Leave |\n|---|---|\n${rows.join("\n")}`;
    const chunks = chunkText(text, { maxChars: 200, overlap: 30 });
    expectWithinLimit(chunks, 200);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith("## Entitlement\n\n| Tenure | Leave |\n|---|---|\n| ")).toBe(true);
    }
    const all = chunks.map((c) => c.content).join("\n");
    for (const row of rows) expect(all).toContain(row);
  });

  it("recognises setext headings, keeps list items whole and drops thematic breaks", () => {
    const text = "Benefits\n========\n\n- Health insurance\n- Gym membership\n  for all staff\n\n---\n\nAsk HR for details.";
    const [chunk, ...rest] = chunkText(text);
    expect(rest).toHaveLength(0);
    expect(chunk!.content).toBe("# Benefits\n\n- Health insurance\n- Gym membership\n  for all staff\n\nAsk HR for details.");
    expect(chunk!.metadata.heading).toBe("Benefits");
  });

  it("clamps unreasonable options instead of failing", () => {
    const chunks = chunkText(paragraph(10), { maxChars: 5, overlap: 1000 });
    expectWithinLimit(chunks, 20);
    expect(chunkText(paragraph(10), { maxChars: Number.NaN, overlap: -5 })).toEqual(chunkText(paragraph(10), { overlap: 0 }));
  });

  it("stays within the default limit for a long mixed document", () => {
    const sections = Array.from({ length: 12 }, (_, s) =>
      [`## Section ${s}`, paragraph(6, s * 10), `- item a${s}\n- item b${s}`, paragraph(20, s * 100)].join("\n\n"),
    );
    const chunks = chunkText(`# Manual\n\n${sections.join("\n\n")}`);
    expectWithinLimit(chunks, DEFAULT_CHUNK_MAX_CHARS);
    const all = chunks.map((c) => c.content).join("\n");
    for (let s = 0; s < 12; s++) expect(all).toContain(sentence(s * 100 + 19));
  });
});

describe("normalizeText", () => {
  it("unifies line endings, spaces and control characters", () => {
    const nbsp = String.fromCharCode(0xa0);
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}Title\r\n\r\n\r\n\r\nLine${nbsp}one  \r\nNUL\u0000here\fnext`;
    expect(normalizeText(text)).toBe("Title\n\nLine one\nNULhere\n\nnext");
  });
});
