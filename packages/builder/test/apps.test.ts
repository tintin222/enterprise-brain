import { describe, expect, it } from "vitest";
import type { TableField } from "@enterprise-brain/core";
import { ScriptedLlm, UnavailableLlm } from "@enterprise-brain/llm";
import { proposeApp } from "../src/index.ts";

/** The Studio's app designer: pages of blocks (and the table they need) from a person's words. */

const offline = new UnavailableLlm();

const complaints = {
  key: "customer_complaints",
  name: "Customer complaints",
  titleField: "problem",
  fields: [
    { key: "customer", label: "Customer", type: "text" },
    { key: "problem", label: "Problem", type: "text", required: true },
    { key: "status", label: "Status", type: "choice", choices: ["Open", "In progress", "Closed"], default: "Open" },
    { key: "owner", label: "Owner", type: "person" },
    { key: "reported_on", label: "Reported on", type: "date" },
  ] satisfies TableField[],
};

describe("proposing an app", () => {
  it("reads what to keep and what to do from one sentence, and adds the status closing needs", async () => {
    const proposal = await proposeApp(offline, {
      description: "Supplier complaints: supplier, order number, problem, photo, log a complaint, see the open ones by supplier, close them",
    });
    expect(proposal.drafted).toBe("words");
    const [table] = proposal.tables;
    expect(table?.fields.map((f) => [f.key, f.type])).toEqual([
      ["supplier", "text"],
      ["order_number", "text"],
      ["problem", "text"],
      ["photo", "file"],
      ["status", "choice"],
    ]);
    expect(proposal.notes).toContain("Status was added (Open, In progress, Closed) so open ones can be seen and closed.");
    expect(proposal.design.name).toBe("Supplier complaints");
    expect(proposal.design.pages.map((p) => p.title)).toEqual(["Log a complaint", "Open ones by supplier"]);
    expect(proposal.design.pages[0]!.blocks).toEqual([{ type: "form", table: "supplier_complaints" }]);
    expect(proposal.design.pages[1]!.blocks[0]).toMatchObject({
      type: "list",
      table: "supplier_complaints",
      filter: { status: "Open" },
      groupBy: "supplier",
      search: true,
      actions: [{ label: "Close", set: { status: "Closed" }, confirm: true }],
    });
  });

  it("uses the company's table when the description names it, with the usual pages", async () => {
    const proposal = await proposeApp(offline, { description: "An app for our customer complaints", tables: [complaints] });
    expect(proposal.tables).toEqual([]);
    expect(proposal.notes).toContain("It works on your table Customer complaints.");
    expect(proposal.design.pages.map((p) => p.title)).toEqual(["Add", "All customer complaints", "Board", "Overview"]);
    const overview = proposal.design.pages[3]!.blocks;
    expect(overview.map((b) => b.type)).toEqual(["number", "number", "chart", "chart"]);
    expect(overview[1]).toMatchObject({ title: "Open", filter: { status: "Open" } });
    expect(overview[3]).toMatchObject({ type: "chart", groupBy: "owner" });
  });

  it("uses the model when there is one, keeping only blocks that fit their tables", async () => {
    const llm = new ScriptedLlm({
      "studio.app": {
        structured: () => ({
          name: "Complaint desk",
          description: "Customer complaints, from logging to closing.",
          newTables: [],
          pages: [
            {
              title: "Work the open ones",
              blocks: [
                {
                  type: "list",
                  title: "Open complaints",
                  table: "Customer complaints",
                  fields: ["Problem", "Customer", "Colour"],
                  filter: [{ field: "Status", value: "open" }],
                  sortField: "Reported on",
                  sortDirection: "desc",
                  groupBy: "",
                  measure: "count",
                  measureField: "",
                  chartKind: "",
                  search: true,
                  agent: "",
                  ask: "",
                  text: "",
                  actions: [
                    { label: "Close", setField: "Status", setValue: "closed", agent: "", ask: "" },
                    { label: "Draft a reply", setField: "", setValue: "", agent: "reply-writer", ask: "Draft a reply to {customer} about {problem}" },
                    { label: "Escalate", setField: "", setValue: "", agent: "nobody", ask: "x" },
                  ],
                },
                {
                  type: "button",
                  title: "Weekly summary",
                  table: "",
                  fields: [],
                  filter: [],
                  sortField: "",
                  sortDirection: "",
                  groupBy: "",
                  measure: "count",
                  measureField: "",
                  chartKind: "",
                  search: false,
                  agent: "unknown-agent",
                  ask: "Summarise the week",
                  text: "",
                  actions: [],
                },
              ],
            },
          ],
          notes: ["Closing sets Status to Closed."],
        }),
      },
    });
    const proposal = await proposeApp(llm, {
      description: "a desk for complaints",
      tables: [complaints],
      agents: [{ slug: "reply-writer", name: "Reply Writer" }],
    });
    expect(proposal.drafted).toBe("model");
    expect(proposal.design.pages).toHaveLength(1);
    expect(proposal.design.pages[0]).toMatchObject({ key: "work_the_open_ones", title: "Work the open ones" });
    expect(proposal.design.pages[0]!.blocks).toEqual([
      {
        type: "list",
        title: "Open complaints",
        table: "customer_complaints",
        fields: ["problem", "customer"],
        filter: { status: "Open" },
        sort: { field: "reported_on", direction: "desc" },
        search: true,
        actions: [
          { label: "Close", set: { status: "Closed" } },
          { label: "Draft a reply", agent: "reply-writer", ask: "Draft a reply to {customer} about {problem}" },
        ],
      },
    ]);
    expect(proposal.notes).toEqual(
      expect.arrayContaining([
        'Customer complaints has no field "Colour"; it was left out.',
        'The button "Weekly summary" was left out: it named no AI employee of the company.',
      ]),
    );
  });
});
