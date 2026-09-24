import { beforeAll, describe, expect, it } from "vitest";
import type { Catalog } from "@enterprise-brain/core";
import { loadCatalog, normalizeSearchText, searchCatalog, searchTokens } from "../src/index.ts";

let catalog: Catalog;

beforeAll(async () => {
  catalog = await loadCatalog();
});

const top = (text: string) => searchCatalog(catalog, text)[0]?.id;

describe("searchCatalog", () => {
  it("matches an English description to the CV Screener", () => {
    const results = searchCatalog(catalog, "I want an agent that screens CVs for open positions");
    expect(results[0]?.id).toBe("hr.cv-screener");
    expect(results[0]?.kind).toBe("agent");
    expect(results[0]?.matched.length).toBeGreaterThan(0);
  });

  it("matches a Turkish description to the CV Screener", () => {
    expect(top("özgeçmişleri değerlendiren bir ajan")).toBe("hr.cv-screener");
    expect(top("ÖZGEÇMİŞLERİ DEĞERLENDİREN BİR AJAN")).toBe("hr.cv-screener");
  });

  it("matches invoice processing in Turkish and English", () => {
    expect(top("fatura işleme")).toBe("finance.invoice-processor");
    expect(top("automate supplier invoice processing with a 3-way match")).toBe("finance.invoice-processor");
  });

  it("finds the other flagship agents from plain descriptions", () => {
    expect(top("classify customer emails and draft replies")).toBe("customer-service.mail-triage");
    expect(top("sözleşmeleri risk açısından inceleyen bir asistan")).toBe("legal.contract-reviewer");
    expect(top("qualify inbound leads from our website form")).toBe("sales.lead-qualifier");
    expect(top("irsaliye kontrolü")).toBe("operations.delivery-note-processor");
  });

  it("filters by kind and department and respects the limit", () => {
    const processes = searchCatalog(catalog, "invoice", { kinds: ["process"] });
    expect(processes.length).toBeGreaterThan(0);
    expect(processes.every((r) => r.kind === "process")).toBe(true);
    expect(processes[0]?.id).toBe("finance.accounts-payable");
    const hrOnly = searchCatalog(catalog, "questions about policies", { department: "hr", limit: 3 });
    expect(hrOnly.length).toBeLessThanOrEqual(3);
    expect(hrOnly.every((r) => r.department === "hr")).toBe(true);
  });

  it("returns nothing for empty or meaningless text", () => {
    expect(searchCatalog(catalog, "")).toEqual([]);
    expect(searchCatalog(catalog, "I want an agent that")).toEqual([]);
  });

  it("folds Turkish characters and removes stopwords", () => {
    expect(normalizeSearchText("İşe Alım ÖZGEÇMİŞ ılık")).toBe("ise alim ozgecmis ilik");
    expect(searchTokens("Bir ajan istiyorum: fatura işleme için")).toEqual(["fatura", "isleme"]);
  });
});
