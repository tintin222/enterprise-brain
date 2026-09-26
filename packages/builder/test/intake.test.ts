import { describe, expect, it } from "vitest";
import type { TableField } from "@enterprise-brain/core";
import { intakeAgent } from "../src/index.ts";

/** An AI employee that fills a table from email: its job from the table's fields, with one answer (the mailbox). */

const fields: TableField[] = [
  { key: "supplier", label: "Supplier", type: "text", required: true },
  { key: "order_number", label: "Order number", type: "text" },
  { key: "problem", label: "Problem", type: "long_text", required: true },
  { key: "status", label: "Status", type: "choice", choices: ["Open", "Closed"], default: "Open" },
  { key: "severity", label: "Severity", type: "choice", choices: ["Low", "High"] },
  { key: "received_on", label: "Received on", type: "date" },
  { key: "owner", label: "Owner", type: "person" },
  { key: "contact_email", label: "Contact email", type: "email", personal: true },
];

describe("filling a table from email", () => {
  it("reads the mailbox, picks out the table's fields and adds the record through the Tables connection", () => {
    const { definition, job } = intakeAgent(
      { key: "supplier_complaints", name: "Supplier complaints", fields, titleField: "problem", department: "operations" },
      { mailbox: "Quality@acme.com.tr" },
    );
    expect(definition).toMatchObject({
      slug: "supplier-complaints-clerk",
      name: "Supplier Complaints Clerk",
      department: "operations",
      triggers: [{ type: "mailbox", mailbox: "quality@acme.com.tr" }, { type: "manual" }],
      connectors: [{ ref: "tables", category: "tables", operations: ["add_supplier_complaints"] }],
      guardrails: { approvalRequiredFor: ["connector:write"], personalData: "contains" },
    });
    const [extract, add, output] = definition.workflow;
    expect(extract).toMatchObject({ type: "llm.extract", id: "fields" });
    expect(extract!.type === "llm.extract" && extract!.fields.map((f) => [f.key, f.type])).toEqual([
      ["supplier", "string"],
      ["order_number", "string"],
      ["problem", "text"],
      ["severity", "select"],
      ["contact_email", "email"],
    ]);
    expect(add).toMatchObject({
      type: "connector",
      connector: "tables",
      operation: "add_supplier_complaints",
      input: {
        supplier: "{{ steps.fields.supplier }}",
        problem: "{{ steps.fields.problem }}",
        received_on: "{{ input.email.receivedAt | date }}",
        contact_email: "{{ steps.fields.contact_email || input.email.from }}",
      },
    });
    expect(add!.type === "connector" && Object.keys(add!.input)).not.toContain("status");
    expect(output).toMatchObject({ type: "output", value: { record: "#{{ steps.record.number }}", title: "{{ steps.record.problem }}" } });
    expect(job).toMatchObject({
      duty: "Reads every email sent to quality@acme.com.tr, and adds each one to Supplier complaints",
      picks: ["Supplier", "Order number", "Problem", "Severity", "Contact email"],
      takes: ["Received on: the day the email came", "Contact email: the sender, unless the email names another"],
      startsAs: ["Status starts as Open"],
      leaves: ["Owner"],
      level: "supervised",
    });
  });
});
