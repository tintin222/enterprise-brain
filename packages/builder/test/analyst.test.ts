import { beforeAll, describe, expect, it } from "vitest";
import type { Catalog } from "@enterprise-brain/core";
import { loadCatalog } from "@enterprise-brain/catalog";
import { UnavailableLlm } from "@enterprise-brain/llm";
import { Analyst, goalFromDescription } from "../src/analyst.ts";

let analyst: Analyst;

beforeAll(async () => {
  const catalog: Catalog = await loadCatalog();
  analyst = new Analyst(new UnavailableLlm(), catalog);
});

describe("offline discovery", () => {
  it("matches the catalog template for an English description", async () => {
    const discovery = await analyst.discover({
      description: "I'm the HR manager. We receive dozens of CVs every week. I want an agent that reads each CV and scores the candidate against the open position.",
    });
    expect(discovery.template?.id).toBe("hr.cv-screener");
    expect(discovery.language).toBe("en");
    expect(discovery.prefilled.find((p) => p.nodeId === "purpose.goal")?.value).toBe("Reads each CV and scores the candidate against the open position.");
  });

  it("matches Turkish descriptions, preferring the best of two templates of the same kind", async () => {
    const discovery = await analyst.discover({ description: "Müşteri e-postalarını sınıflandırıp yanıt taslağı hazırlayan bir ajan istiyorum." });
    expect(discovery.template?.id).toBe("customer-service.mail-triage");
    expect(discovery.language).toBe("tr");
    expect(discovery.prefilled.find((p) => p.nodeId === "purpose.goal")?.value).toBe("Müşteri e-postalarını sınıflandırıp yanıt taslağı hazırlayan bir ajan.");
  });

  it("starts from the archetype blueprint when nothing in the catalog fits", async () => {
    const discovery = await analyst.discover({ description: "An agent that plans our company picnic and books a venue." });
    expect(discovery.template).toBeUndefined();
  });
});

describe("goalFromDescription", () => {
  it("keeps the outcome and drops the preamble", () => {
    expect(goalFromDescription("We are the AP team. We need a tool to match invoices against purchase orders.")).toBe("Match invoices against purchase orders.");
    expect(goalFromDescription("Invoices pile up every month")).toBe("Invoices pile up every month");
  });
});
