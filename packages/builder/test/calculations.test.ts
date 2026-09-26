import { describe, expect, it } from "vitest";
import { calculationParams } from "@enterprise-brain/core";
import { ScriptedLlm, UnavailableLlm } from "@enterprise-brain/llm";
import { runCalculation } from "@enterprise-brain/sandbox";
import { writeCalculation, type CalculationDraft, type CalculationTable } from "../src/index.ts";

/** The Studio's calculation writer: code for a rule, tried on the real rows before anyone sees it. */

const tables: CalculationTable[] = [
  {
    key: "supplier_complaints",
    name: "Supplier complaints",
    fields: [
      { key: "problem", label: "Problem", type: "text" },
      { key: "supplier", label: "Supplier", type: "text" },
      { key: "cost", label: "Cost", type: "money", currency: "TRY" },
      { key: "found_on", label: "Found on", type: "date" },
      { key: "status", label: "Status", type: "choice", choices: ["Open", "Closed"] },
    ],
  },
  {
    key: "deliveries",
    name: "Deliveries",
    fields: [
      { key: "supplier", label: "Supplier", type: "text" },
      { key: "delivered_on", label: "Delivered on", type: "date" },
    ],
  },
];

const rows: Record<string, Record<string, unknown>[]> = {
  supplier_complaints: [
    { problem: "Cracked flange", supplier: "Akın Metal", cost: 1200, found_on: "2026-08-04", status: "Open" },
    { problem: "Late", supplier: "Akın Metal", cost: 0, found_on: "2026-08-12", status: "Closed" },
    { problem: "Bent frame", supplier: "Akın Metal", cost: 800, found_on: "2026-08-30", status: "Open" },
    { problem: "Wrong paint", supplier: "Demir Döküm", cost: 350.5, found_on: "2026-08-20", status: "Open" },
    { problem: "Missing certificate", supplier: "Akın Metal", cost: 0, found_on: "2026-09-02", status: "Open" },
  ],
  deliveries: [
    ...Array.from({ length: 60 }, (_, i) => ({ supplier: "Akın Metal", delivered_on: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ supplier: "Demir Döküm", delivered_on: `2026-08-${String(i + 1).padStart(2, "0")}` })),
    { supplier: "Yıldız Plastik", delivered_on: "2026-08-15" },
  ],
};

/** Runs the draft in the sandbox on the rows above, on 26 September 2026. */
async function trial(draft: CalculationDraft) {
  const outcome = await runCalculation(draft.code, {
    tables: Object.fromEntries(draft.tables.map((k) => [k, rows[k] ?? []])),
    params: calculationParams("2026-09-26"),
  });
  return outcome.ok ? { ok: true, result: outcome.value, error: null } : { ok: false, result: null, error: outcome.error };
}

describe("writing a calculation", () => {
  it("reads a ranking per so many of another table, in a period, from the words", async () => {
    const proposal = await writeCalculation(new UnavailableLlm(), { rule: "Rank suppliers by complaints per 100 deliveries last month", tables, trial });
    expect(proposal.drafted).toBe("words");
    expect(proposal.draft).toMatchObject({
      name: "Supplier ranking",
      tables: ["supplier_complaints", "deliveries"],
      explanation: "For each supplier: how many supplier complaints, for every 100 deliveries, last month (by found on); highest first.",
    });
    expect(proposal.draft.output.columns.map((c) => c.label)).toEqual([
      "Rank",
      "Supplier",
      "Supplier complaints",
      "Deliveries",
      "Supplier complaints per 100 deliveries",
    ]);
    expect(proposal.trial).toEqual({
      ok: true,
      error: null,
      result: [
        { rank: 1, supplier: "Demir Döküm", complaints: 1, deliveries: 10, per_100: 10 },
        { rank: 2, supplier: "Akın Metal", complaints: 3, deliveries: 60, per_100: 5 },
        { rank: 3, supplier: "Yıldız Plastik", complaints: 0, deliveries: 1, per_100: 0 },
      ],
    });
  });

  it("reads totals and counts, by something or as one number", async () => {
    const totals = await writeCalculation(new UnavailableLlm(), { rule: "Total cost by supplier", tables, trial });
    expect(totals.trial.result).toEqual([
      { rank: 1, supplier: "Akın Metal", cost: 2000 },
      { rank: 2, supplier: "Demir Döküm", cost: 350.5 },
    ]);
    expect(totals.draft.output.columns[2]).toEqual({ key: "cost", label: "Total cost", type: "money", currency: "TRY" });
    const count = await writeCalculation(new UnavailableLlm(), { rule: "How many complaints this month", tables, trial });
    expect(count.draft.output.kind).toBe("number");
    expect(count.trial.result).toBe(1);
    await expect(writeCalculation(new UnavailableLlm(), { rule: "Forecast next quarter's complaints with a trend line", tables, trial })).rejects.toThrow(
      /needs the model/,
    );
  });

  it("with the model, writes the code again when it fails on the real rows", async () => {
    let calls = 0;
    const llm = new ScriptedLlm({
      "studio.calculation": {
        structured: (request) => {
          calls++;
          const content = String(request.messages[0]?.content);
          const fixed = content.includes("failed on the real rows");
          return {
            name: "Open complaints",
            explanation: "How many complaints are open now.",
            tables: ["supplier_complaints", "unknown_table"],
            code: fixed
              ? `return tables.supplier_complaints.filter((row) => row.status === "Open").length;`
              : `return tables.complaints.filter((row) => row.status === "Open").length;`,
            kind: "number",
            columns: [],
            unit: "complaints",
          };
        },
      },
    });
    const proposal = await writeCalculation(llm, {
      rule: "How many complaints are open",
      tables,
      samples: { supplier_complaints: rows.supplier_complaints!.slice(0, 2) },
      trial,
    });
    expect(calls).toBe(2);
    expect(proposal).toMatchObject({ drafted: "model", attempts: 2, trial: { ok: true, result: 4 } });
    expect(proposal.draft.tables).toEqual(["supplier_complaints"]);
    expect(proposal.notes[0]).toMatch(/^Try 1 didn't work \(TypeError/);
  });
});
