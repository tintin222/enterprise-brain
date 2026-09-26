import { describe, expect, it } from "vitest";
import { ScriptedLlm, UnavailableLlm } from "@enterprise-brain/llm";
import { proposeTable } from "../src/index.ts";

/** The Studio's table designer: a table's fields and their kinds from a person's words. */

const offline = new UnavailableLlm();
const suppliers = [{ key: "suppliers", name: "Suppliers" }];

describe("proposing a table", () => {
  it("reads a list of details after a colon: kinds from the labels, choices in parentheses, links to existing tables", async () => {
    const proposal = await proposeTable(offline, {
      description: "Supplier complaints: supplier, order number, problem, status (open, in progress, closed), owner, cost in TRY, date found, photo",
      existing: suppliers,
    });
    expect(proposal.drafted).toBe("words");
    expect(proposal.design).toMatchObject({ key: "supplier_complaints", name: "Supplier complaints", titleField: "problem" });
    expect(proposal.design.fields.map((f) => [f.key, f.type])).toEqual([
      ["supplier", "link"],
      ["order_number", "text"],
      ["problem", "text"],
      ["status", "choice"],
      ["owner", "person"],
      ["cost", "money"],
      ["date_found", "date"],
      ["photo", "file"],
    ]);
    expect(proposal.design.fields.find((f) => f.key === "status")).toMatchObject({ choices: ["Open", "In progress", "Closed"], default: "Open" });
    expect(proposal.design.fields.find((f) => f.key === "cost")).toMatchObject({ label: "Cost", currency: "TRY" });
    expect(proposal.design.fields.find((f) => f.key === "supplier")).toMatchObject({ table: "suppliers" });
    expect(proposal.design.fields.find((f) => f.key === "problem")).toMatchObject({ required: true });
    expect(proposal.notes).toContain("Supplier points at a record of Suppliers.");
  });

  it("reads Turkish, and a list after 'with'", async () => {
    const turkish = await proposeTable(offline, { description: "Eğitim kayıtları: çalışan adı, eğitim, tarih, süre (saat), sorumlu ve durum" });
    expect(turkish.design.name).toBe("Eğitim kayıtları");
    expect(turkish.design.fields.map((f) => f.type)).toEqual(["text", "text", "date", "text", "person", "choice"]);
    expect(turkish.design.fields.at(-1)).toMatchObject({ choices: ["Açık", "İşlemde", "Kapalı"], default: "Açık" });

    const english = await proposeTable(offline, { description: "I need a register of visitors with name, company, email, arrival date and is escorted?" });
    expect(english.design.name).toBe("Visitors");
    expect(english.design.fields.map((f) => [f.label, f.type])).toEqual([
      ["Name", "text"],
      ["Company", "text"],
      ["Email", "email"],
      ["Arrival date", "date"],
      ["Is escorted?", "yes_no"],
    ]);
  });

  it("starts with common fields when no details are named", async () => {
    const proposal = await proposeTable(offline, { description: "A tracker for maintenance requests" });
    expect(proposal.design.name).toBe("Maintenance requests");
    expect(proposal.design.fields.map((f) => f.key)).toEqual(["title", "details", "status", "owner", "date"]);
    expect(proposal.notes[0]).toMatch(/didn't say which details/);
  });

  it("uses the model when there is one, and makes what it proposes valid", async () => {
    const llm = new ScriptedLlm({
      "studio.table": {
        structured: () => ({
          name: "Supplier complaints",
          description: "Complaints about what suppliers delivered.",
          fields: [
            { label: "Problem", type: "text", description: "", required: true, choices: [], startsAs: "", currency: "", linksTo: "", personal: false },
            {
              label: "Supplier",
              type: "link",
              description: "",
              required: true,
              choices: [],
              startsAs: "",
              currency: "",
              linksTo: "suppliers",
              personal: false,
            },
            {
              label: "Status",
              type: "choice",
              description: "",
              required: false,
              choices: ["Open", "Closed"],
              startsAs: "Open",
              currency: "",
              linksTo: "",
              personal: false,
            },
            { label: "Carrier", type: "link", description: "", required: false, choices: [], startsAs: "", currency: "", linksTo: "carriers", personal: false },
            { label: "Number", type: "text", description: "", required: false, choices: [], startsAs: "", currency: "", linksTo: "", personal: false },
            { label: "Cost", type: "money", description: "", required: false, choices: [], startsAs: "", currency: "try", linksTo: "", personal: false },
          ],
          titleField: "Problem",
          notes: ["Status starts as Open."],
        }),
      },
    });
    const proposal = await proposeTable(llm, { description: "a register for supplier complaints", existing: suppliers });
    expect(proposal.drafted).toBe("model");
    expect(proposal.design.fields.map((f) => [f.key, f.type])).toEqual([
      ["problem", "text"],
      ["supplier", "link"],
      ["status", "choice"],
      ["carrier", "text"],
      ["number_value", "text"],
      ["cost", "money"],
    ]);
    expect(proposal.design.fields.find((f) => f.key === "cost")).toMatchObject({ currency: "TRY" });
    expect(proposal.design.fields.find((f) => f.key === "status")).toMatchObject({ default: "Open" });
    expect(proposal.design.titleField).toBe("problem");
  });
});
