import { describe, expect, it } from "vitest";
import { AppDesign, type TableField } from "@enterprise-brain/core";
import { STUDIO_TOOLS, abilitiesOf, compileEmployee, employeeCard, plainApp, studioSystemPrompt, type CompileContext } from "../src/index.ts";

/** The Studio agent: an AI employee written in plain words becomes a job the runtime runs as an agent. */

const fields: TableField[] = [
  { key: "supplier", label: "Supplier", type: "text", required: true },
  { key: "order_number", label: "Order number", type: "text" },
  { key: "status", label: "Status", type: "choice", choices: ["Open", "Closed"], default: "Open" },
  { key: "contact", label: "Contact", type: "email", personal: true },
];

const ctx: CompileContext = {
  departments: [{ id: "d-ops", key: "operations", name: "Operations" }],
  tables: [{ key: "supplier_complaints", name: "Supplier complaints", fields }],
  tablesConnectionId: "conn-tables",
  systems: [
    {
      key: "demo-erp",
      name: "Demo ERP",
      category: "erp",
      demo: true,
      actions: [
        { id: "get_purchase_order", name: "Get a purchase order", kind: "read" },
        { id: "post_invoice", name: "Post an invoice", kind: "write" },
      ],
    },
    {
      key: "sap-s-4hana",
      name: "SAP S/4HANA",
      category: "erp",
      instanceId: "conn-sap",
      demo: false,
      actions: [{ id: "find_order", name: "Find an order", kind: "read" }],
    },
  ],
  collections: ["quality-procedures"],
  mailboxes: ["support@acme.com.tr"],
  timeZone: "Europe/Istanbul",
};

describe("an AI employee from plain words", () => {
  it("works as an agent with only the abilities it was given, when its duties say", () => {
    const { definition, problems, notes } = compileEmployee(
      {
        name: "Complaint Handler",
        role: "Handles supplier complaints that come to quality@",
        department: "operations",
        job: "For each complaint email: log it, look up the order, ask the quality engineer for the root cause.",
        starts: [
          { when: "email", mailbox: "Quality@Acme.com.tr" },
          { when: "schedule", every: "week", weekday: 1, time: "09:00" },
        ],
        form: [],
        can: {
          documents: true,
          knowledge: ["quality-procedures"],
          emails: "send",
          tables: [{ table: "supplier_complaints", can: ["add", "update"] }],
          actions: [
            { system: "demo-erp", actions: ["get_purchase_order"] },
            { system: "SAP S/4HANA", actions: ["find_order"] },
          ],
        },
        approval: ["emails", "changes"],
        level: "supervised",
      },
      ctx,
    );
    expect(problems).toEqual([]);
    expect(definition).toMatchObject({
      slug: "complaint-handler",
      department: "operations",
      archetype: "mail-triage",
      workflow: [],
      model: { effort: "medium" },
      triggers: [{ type: "mailbox", mailbox: "quality@acme.com.tr" }, { type: "schedule", cron: "0 9 * * 1", timezone: "Europe/Istanbul" }, { type: "manual" }],
      knowledge: { collections: ["quality-procedures"] },
      guardrails: { approvalRequiredFor: ["mail.send", "connector:write"], personalData: "contains" },
      ui: { layout: "inbox" },
    });
    expect(definition.instructions).toBe(
      "For each complaint email: log it, look up the order, ask the quality engineer for the root cause.\n\nYou work in Operations.",
    );
    // Changing a record needs finding it; the demo ERP is bound by its kind, SAP by its connection.
    expect(definition.connectors).toEqual([
      {
        ref: "tables",
        category: "tables",
        instanceId: "conn-tables",
        purpose: "Keeps the company's tables",
        operations: ["find_supplier_complaints", "get_supplier_complaints", "add_supplier_complaints", "update_supplier_complaints"],
      },
      { ref: "erp", category: "erp", purpose: "Demo ERP", operations: ["get_purchase_order"] },
      { ref: "sap_s_4hana", category: "erp", instanceId: "conn-sap", purpose: "SAP S/4HANA", operations: ["find_order"] },
    ]);
    expect(definition.tools).toEqual([
      "documents.read",
      "knowledge.search",
      "mail.draft",
      "mail.send",
      "connector:tables.find_supplier_complaints",
      "connector:tables.get_supplier_complaints",
      "connector:tables.add_supplier_complaints",
      "connector:tables.update_supplier_complaints",
      "connector:erp.get_purchase_order",
      "connector:sap_s_4hana.find_order",
    ]);
    expect(definition.inputs.map((f) => f.key)).toEqual(["email"]);
    expect(notes).toEqual([
      "Demo ERP is the demo system: it stands in until IT connects the real one.",
      "No email has come to quality@acme.com.tr yet. It reads that mailbox once IT connects it; test emails can be sent to it from Mail.",
    ]);
    expect(abilitiesOf(definition, { tables: { supplier_complaints: "Supplier complaints" } })).toEqual([
      "Reads attachments and files",
      "Searches quality-procedures",
      "Sends emails",
      "Finds, adds and changes records in Supplier complaints",
      "Uses Demo ERP: get_purchase_order",
      "Uses SAP S/4HANA: find_order",
    ]);
    expect(employeeCard(definition, "supervised").approvals).toEqual(["Sending emails", "Changes to records and systems"]);
  });

  it("starts from its form, and says what is missing instead of guessing", () => {
    const formed = compileEmployee(
      {
        name: "Visit Planner",
        role: "Plans supplier visits",
        department: "operations",
        job: "Plan a supplier visit from the request: pick a date, book the meeting, tell the host.",
        starts: [],
        form: [
          { label: "Supplier", type: "text", required: true },
          { label: "Reason", type: "choice", choices: ["Audit", "Complaint"] },
        ],
        can: {},
        approval: [],
        level: "trusted",
      },
      ctx,
    );
    expect(formed.problems).toEqual([]);
    expect(formed.definition.triggers).toEqual([{ type: "form", description: "Plans supplier visits" }, { type: "manual" }]);
    expect(formed.definition.inputs).toEqual([
      { key: "supplier", label: "Supplier", type: "string", required: true },
      { key: "reason", label: "Reason", type: "select", options: [{ value: "Audit" }, { value: "Complaint" }] },
    ]);
    expect(formed.definition.ui.layout).toBe("form-results");

    const missing = compileEmployee(
      {
        name: "Invoice Clerk",
        role: "Posts invoices",
        department: "finance",
        job: "Post each invoice that comes in, after checking it against its order.",
        starts: [],
        form: [{ label: "Kind", type: "choice" }],
        can: {
          tables: [{ table: "invoices", can: ["add"] }],
          actions: [
            { system: "demo-erp", actions: ["post_invoice", "pay_invoice"] },
            { system: "workday", actions: ["x"] },
          ],
          knowledge: ["hr"],
        },
        approval: ["changes"],
        level: "supervised",
      },
      ctx,
    );
    expect(missing.problems).toEqual([
      'There is no department "finance"; use a key from look_around.',
      'There is no knowledge collection "hr".',
      'There is no table "invoices": make it with save_table first.',
      'Demo ERP has no action "pay_invoice". Its actions: get_purchase_order, post_invoice.',
      'There is no connected system "workday"; use a key from look_around, or ask IT with ask_it.',
      "Kind: give the values to pick from.",
    ]);
  });
});

describe("the Studio's own parts", () => {
  it("plans an app on the tables it was given", () => {
    const design = AppDesign.parse(
      plainApp({
        key: "complaint_desk",
        name: "Complaint desk",
        description: "Open complaints by supplier",
        tables: [{ key: "supplier_complaints", name: "Supplier complaints", fields }],
      }),
    );
    expect(design.pages.map((p) => [p.title, p.blocks.map((b) => b.type)])).toEqual([
      ["Supplier complaints", ["list"]],
      ["Supplier complaints by status", ["board"]],
      ["Add to Supplier complaints", ["form"]],
    ]);
  });

  it("keeps its instructions and tools the same all through a conversation", () => {
    const prompt = studioSystemPrompt({
      company: "Acme",
      person: { name: "Selin Acar", title: "Quality Manager", admin: false, departments: [{ name: "Operations", role: "manager" }] },
      department: { key: "operations", name: "Operations" },
    });
    expect(prompt).toContain("You are working with Selin Acar, Quality Manager (manager in Operations). They are building for Operations (key operations).");
    // Nothing that changes from day to day: the date comes from look_around.
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(STUDIO_TOOLS.map((t) => t.name)).toEqual([
      "look_around",
      "read_mailbox",
      "read_email",
      "read_file",
      "look_at",
      "search_knowledge",
      "ask_person",
      "ask_it",
      "save_table",
      "save_ai_employee",
      "save_app",
      "try_ai_employee",
      "remove",
    ]);
  });
});
