import { describe, expect, it } from "vitest";
import { calculationParams, type AppDesign, type TableDesign } from "@enterprise-brain/core";
import { ScriptedLlm, UnavailableLlm } from "@enterprise-brain/llm";
import { runCalculation } from "@enterprise-brain/sandbox";
import { changeApp, changeCalculation, changedRule, changeTable, type AppTable, type CalculationDraft } from "../src/index.ts";

/** Changes in plain words: the changed design, and what changes said back in plain words. */

const offline = new UnavailableLlm();

const complaints: TableDesign = {
  key: "supplier_complaints",
  name: "Supplier complaints",
  description: "",
  titleField: "problem",
  fields: [
    { key: "problem", label: "Problem", type: "text", required: true },
    { key: "supplier", label: "Supplier", type: "text" },
    { key: "status", label: "Status", type: "choice", choices: ["Open", "Done"], default: "Open" },
    { key: "owner", label: "Owner", type: "person" },
    { key: "cost", label: "Cost", type: "text" },
    { key: "found_on", label: "Found on", type: "date" },
  ],
};

describe("changing a table in plain words", () => {
  it("adds, takes away, renames, makes needed and changes kinds, saying each back", async () => {
    const change = await changeTable(offline, {
      design: complaints,
      request:
        "frobnicate; add Root cause and Photo; make Owner required; rename Done to Closed; make Cost a number; add In progress to Status; remove Supplier and Colour",
    });
    expect(change.drafted).toBe("words");
    expect(change.design.fields.map((f) => [f.key, f.type])).toEqual([
      ["problem", "text"],
      ["status", "choice"],
      ["owner", "person"],
      ["cost", "number"],
      ["found_on", "date"],
      ["root_cause", "long_text"],
      ["photo", "file"],
    ]);
    expect(change.design.fields.find((f) => f.key === "status")).toMatchObject({ choices: ["Open", "Closed", "In progress"], default: "Open" });
    expect(change.renames).toEqual({ status: { Done: "Closed" } });
    expect(change.summary).toEqual([
      "Status: “Done” becomes “Closed” in every record",
      "Status can also be “In progress”",
      "Owner is needed now",
      "Cost becomes number",
      "Adds Root cause (longer text)",
      "Adds Photo (file)",
      "Takes away Supplier (its values stay out of sight)",
    ]);
    expect(change.notes).toEqual([expect.stringMatching(/^Not understood: “frobnicate”/), "There is no Colour to take away."]);
  });

  it("with the model, keeps the fields' keys and says what changed from the designs themselves", async () => {
    const llm = new ScriptedLlm({
      "studio.table-change": {
        structured: () => ({
          name: "Supplier complaints",
          fields: [
            { key: "problem", label: "Problem", type: "text", required: true, choices: [], startsAs: "", currency: "", linksTo: "", personal: false },
            { key: "supplier", label: "Vendor", type: "text", required: false, choices: [], startsAs: "", currency: "", linksTo: "", personal: false },
            {
              key: "status",
              label: "Status",
              type: "choice",
              required: false,
              choices: ["Open", "Closed"],
              startsAs: "Open",
              currency: "",
              linksTo: "",
              personal: false,
            },
            {
              key: "",
              label: "Severity",
              type: "choice",
              required: false,
              choices: ["Low", "High"],
              startsAs: "Low",
              currency: "",
              linksTo: "",
              personal: false,
            },
          ],
          renames: [{ field: "status", from: "Done", to: "Closed" }],
          notes: [],
        }),
      },
    });
    const change = await changeTable(llm, { design: complaints, request: "call suppliers vendors, Done is Closed now, add a severity, drop the rest" });
    expect(change.drafted).toBe("model");
    expect(change.design.fields.map((f) => f.key)).toEqual(["problem", "supplier", "status", "severity"]);
    expect(change.summary).toEqual(
      expect.arrayContaining([
        "Renames Supplier to Vendor",
        "Status: “Done” becomes “Closed” in every record",
        "Adds Severity (one of a list: Low, High)",
        "Takes away Owner (its values stay out of sight)",
      ]),
    );
  });
});

describe("changing an app in plain words", () => {
  const tables: AppTable[] = [{ key: complaints.key, name: complaints.name, fields: complaints.fields, titleField: "problem" }];
  const design: AppDesign = {
    key: "complaints",
    name: "Complaints",
    description: "",
    pages: [
      { key: "add", title: "Add", blocks: [{ type: "form", table: "supplier_complaints" }] },
      { key: "board", title: "Board", blocks: [{ type: "board", table: "supplier_complaints", groupBy: "status" }] },
    ],
  };

  it("adds charts and lists, takes pages away and renames them, keeping the pages that stay", async () => {
    const change = await changeApp(offline, {
      design,
      tables,
      calculations: [{ key: "supplier_ranking", name: "Supplier ranking" }],
      request:
        "add a chart of complaints by month, add a list of open complaints by supplier, show the supplier ranking, remove the board, rename Add to Log a complaint",
    });
    expect(change.pages.map((p) => [p.key, p.title])).toEqual([
      ["add", "Log a complaint"],
      ["overview", "Overview"],
      ["open_supplier_complaints_by_supplier", "Open supplier complaints by supplier"],
    ]);
    expect(change.pages[1]!.blocks).toEqual([
      { type: "chart", title: "Supplier complaints by month", table: "supplier_complaints", groupBy: "found_on", measure: { of: "count" }, kind: "bar" },
      { type: "result", calculation: "supplier_ranking" },
    ]);
    expect(change.pages[2]!.blocks[0]).toMatchObject({ type: "list", filter: { status: "Open" }, groupBy: "supplier" });
    expect(change.summary).toEqual([
      "Renames the page “Add” to “Log a complaint”",
      "Adds the page “Overview”: A bar chart of how many Supplier complaints by Found on; The latest result of Supplier ranking",
      "Adds the page “Open supplier complaints by supplier”: A list of Supplier complaints whose Status is Open, in groups by Supplier, with a search box",
      "Takes away the page “Board”",
    ]);
  });
});

describe("changing a calculation in plain words", () => {
  it("changes the period or the 'per' of a rule, or takes a whole new rule", () => {
    expect(changedRule("Rank suppliers by complaints per 100 deliveries last month", "make it this year")).toBe(
      "Rank suppliers by complaints per 100 deliveries this year",
    );
    expect(changedRule("Rank suppliers by complaints per 100 deliveries last month", "per 1000 instead")).toBe(
      "Rank suppliers by complaints per 1000 deliveries last month",
    );
    expect(changedRule("Rank suppliers by complaints", "Count complaints by status")).toBe("Count complaints by status");
    expect(changedRule("Rank suppliers by complaints", "make it prettier")).toBeUndefined();
  });

  it("works the changed rule out on the rows", async () => {
    const rows = {
      supplier_complaints: [
        { problem: "A", supplier: "Akın Metal", found_on: "2026-01-10" },
        { problem: "B", supplier: "Akın Metal", found_on: "2026-08-10" },
        { problem: "C", supplier: "Demir Döküm", found_on: "2026-09-10" },
      ],
    };
    const trial = async (draft: CalculationDraft) => {
      const outcome = await runCalculation(draft.code, { tables: rows, params: calculationParams("2026-09-26") });
      return outcome.ok ? { ok: true, result: outcome.value, error: null } : { ok: false, result: null, error: outcome.error };
    };
    const change = await changeCalculation(offline, {
      calculation: { rule: "Count complaints by supplier last month", code: "return 0;" },
      request: "this year instead",
      tables: [{ key: "supplier_complaints", name: "Supplier complaints", fields: complaints.fields }],
      trial,
    });
    expect(change.rule).toBe("Count complaints by supplier this year");
    expect(change.trial.result).toEqual([
      { rank: 1, supplier: "Akın Metal", complaints: 2 },
      { rank: 2, supplier: "Demir Döküm", complaints: 1 },
    ]);
  });

  it("with the model, rewrites the code it has and says the whole rule again as it now reads", async () => {
    const llm = new ScriptedLlm({
      "studio.calculation": {
        structured: () => ({
          name: "Complaint count",
          explanation: "How many complaints came in this year.",
          tables: ["supplier_complaints"],
          code: "return tables.supplier_complaints.length;",
          kind: "number",
          columns: [],
          unit: "complaints",
          rule: "Count the complaints that came in this year",
        }),
      },
    });
    const change = await changeCalculation(llm, {
      calculation: { rule: "Count complaints last month", code: "return 0;" },
      request: "make it the whole year",
      tables: [{ key: "supplier_complaints", name: "Supplier complaints", fields: complaints.fields }],
      trial: async () => ({ ok: true, result: 3, error: null }),
    });
    expect(change).toMatchObject({ drafted: "model", rule: "Count the complaints that came in this year", trial: { result: 3 } });
    const asked = llm.calls.find((c) => c.purpose === "studio.calculation")!.request as { messages: { content: string }[] };
    expect(asked.messages[0]!.content).toContain("Its code:\nreturn 0;");
    expect(asked.messages[0]!.content).toContain("The change asked for: make it the whole year");
  });
});
