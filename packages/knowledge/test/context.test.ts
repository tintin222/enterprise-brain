import { describe, expect, it } from "vitest";
import {
  buildContext,
  buildPrefixTsQuery,
  extractSearchTerms,
  reciprocalRankFusion,
  RRF_K,
  type SearchHit,
} from "../src/index.ts";

function hit(n: number, content: string, title = `Doc ${n}`): SearchHit {
  return {
    chunkId: `chunk-${n}`,
    documentId: `doc-${n}`,
    collectionId: "collection",
    collectionKey: "hr",
    title,
    content,
    score: 1,
    metadata: {},
  };
}

describe("buildContext", () => {
  it("formats numbered sources as [n] Title — content", () => {
    const context = buildContext([hit(1, "  Employees get 20 days.\n"), hit(2, "Receipts are required.", "Expense\n  Policy")]);
    expect(context).toBe("[1] Doc 1 — Employees get 20 days.\n\n[2] Expense Policy — Receipts are required.");
  });

  it("returns an empty string when there are no hits", () => {
    expect(buildContext([])).toBe("");
  });

  it("stays within maxChars by truncating the last source that fits partially", () => {
    const hits = [hit(1, "a".repeat(100)), hit(2, "word ".repeat(100)), hit(3, "never included")];
    const context = buildContext(hits, 260);
    expect(context.length).toBeLessThanOrEqual(260);
    expect(context.startsWith(`[1] Doc 1 — ${"a".repeat(100)}\n\n[2] Doc 2 — word word`)).toBe(true);
    expect(context.endsWith("…")).toBe(true);
    expect(context).not.toContain("[3]");
  });

  it("leaves out a source when only a sliver of it would fit", () => {
    const context = buildContext([hit(1, "x".repeat(150)), hit(2, "y".repeat(500))], 200);
    expect(context).toBe(`[1] Doc 1 — ${"x".repeat(150)}`);
  });

  it("uses a 12000 character budget by default", () => {
    const hits = Array.from({ length: 20 }, (_, i) => hit(i + 1, "z".repeat(1000)));
    const context = buildContext(hits);
    expect(context.length).toBeLessThanOrEqual(12000);
    expect(context).toContain("[11] Doc 11 — ");
    expect(context).not.toContain("[13]");
  });
});

describe("reciprocalRankFusion", () => {
  it("sums 1 / (k + rank) over rankings", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "d"],
    ]);
    expect(fused.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused[0]!.ranks).toEqual([2, 1]);
    expect(fused[1]!.ranks).toEqual([1, undefined]);
  });

  it("counts duplicates once and breaks ties deterministically", () => {
    const fused = reciprocalRankFusion([["y", "y", "z"], ["x"]]);
    expect(fused.map((r) => [r.id, r.ranks])).toEqual([
      ["x", [undefined, 1]],
      ["y", [1, undefined]],
      ["z", [2, undefined]],
    ]);
  });
});

describe("full-text query terms", () => {
  it("drops stopwords, punctuation and excluded words", () => {
    expect(extractSearchTerms("How many days of annual leave?")).toEqual(["days", "annual", "leave"]);
    expect(extractSearchTerms('reset "VPN" password -legacy')).toEqual(["reset", "VPN", "password"]);
    expect(extractSearchTerms("a:* | b & (c) !")).toEqual([]);
  });

  it("handles Turkish casing, stopwords and apostrophe suffixes", () => {
    expect(extractSearchTerms("Yıllık izin kaç gün?")).toEqual(["Yıllık", "izin", "gün"]);
    expect(extractSearchTerms("İÇİN İzin nedir")).toEqual(["İzin"]);
    expect(extractSearchTerms("Acme'nin izin politikası")).toEqual(["Acme", "izin", "politikası"]);
    expect(extractSearchTerms("O'Reilly employee's")).toEqual(["Reilly", "employee"]);
  });

  it("keeps stopwords when nothing else is left and dedupes case-insensitively", () => {
    expect(extractSearchTerms("What is the")).toEqual(["What", "is", "the"]);
    expect(extractSearchTerms("Leave leave LEAVE policy")).toEqual(["Leave", "policy"]);
  });

  it("builds a prefix OR tsquery", () => {
    expect(buildPrefixTsQuery(["days", "hr", "izin"])).toBe("days:* | hr | izin:*");
  });
});
