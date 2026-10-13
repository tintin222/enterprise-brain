import { describe, expect, it } from "vitest";
import type { BrainEntityView } from "@enterprise-brain/brain";
import type { RecordView, TableView } from "@enterprise-brain/runtime";
import {
  compileEmployee,
  renderAgentSpec,
  renderClaudeMd,
  renderConnection,
  renderMcpJson,
  renderPlan,
  renderTable,
  renderTests,
  renderThing,
  renderTranscript,
  toCsv,
  uniquePath,
  type CompileContext,
  type PackageAgent,
  type PackageProject,
} from "../src/index.ts";

/** The development package's pages: pure, deterministic, and never carrying a secret or an unapproved personal value. */

const ctx: CompileContext = {
  departments: [{ id: "d-ops", key: "operations", name: "Operations" }],
  tables: [
    {
      key: "supplier_complaints",
      name: "Supplier complaints",
      fields: [
        { key: "supplier", label: "Supplier", type: "text", required: true },
        { key: "contact", label: "Contact", type: "email", personal: true },
        { key: "status", label: "Status", type: "choice", choices: ["Open", "Closed"], default: "Open" },
      ],
    },
  ],
  tablesConnectionId: "conn-tables",
  systems: [
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
  mailboxes: ["quality@acme.com.tr"],
  timeZone: "Europe/Istanbul",
};

const project: PackageProject = {
  slug: "petrokim-complaints",
  name: "Petrokim complaints",
  summary: "AI employees for the supplier complaint process.",
  status: "active",
  client: "Petrokim",
  owner: "Selin Acar",
  company: "Acme Endüstri A.Ş.",
  createdAt: "2026-10-01T09:00:00.000Z",
  exportedAt: "2026-10-13T10:00:00.000Z",
};

function agent(): PackageAgent {
  const compiled = compileEmployee(
    {
      name: "Complaint Handler",
      role: "Handles the supplier complaints that come to quality@",
      department: "operations",
      job: "For each complaint email: log it in Supplier complaints with the supplier and the problem, ask the quality engineer to confirm the root cause, and never promise a refund.",
      starts: [{ when: "email", mailbox: "quality@acme.com.tr" }],
      form: [],
      can: {
        documents: true,
        tables: [{ table: "supplier_complaints", can: ["find", "add"] }],
        emails: "draft",
        actions: [{ system: "sap-s-4hana", actions: ["find_order"] }],
      },
      approval: ["emails", "changes"],
      level: "supervised",
    },
    ctx,
  );
  expect(compiled.problems).toEqual([]);
  return {
    slug: "complaint-handler",
    definition: compiled.definition,
    probation: "supervised",
    source: "studio",
    department: "Operations",
    status: "draft",
    notes: ["quality@acme.com.tr has no mail yet"],
    tries: [
      {
        example: "an email from Akın Metal",
        status: "succeeded",
        outcome: "Filed the complaint and asked Kerem for the root cause.",
        at: "2026-10-12T08:00:00.000Z",
      },
    ],
    names: { tables: { supplier_complaints: "Supplier complaints" }, systems: { sap_s_4hana: "SAP S/4HANA", tables: "Tables" } },
  };
}

describe("the development package's pages", () => {
  it("writes an AI employee's spec with its job, duties, systems, rules and tests", () => {
    const spec = renderAgentSpec(agent());
    expect(spec).toContain("# Complaint Handler");
    expect(spec).toContain("## The job, in full");
    expect(spec).toContain("never promise a refund");
    expect(spec).toContain("Reads every email sent to quality@acme.com.tr");
    expect(spec).toContain("Designed: with the Studio agent (see conversation.md)");
    expect(spec).toContain("Level at first: Supervised");
    expect(spec).toContain("SAP S/4HANA (erp");
    expect(spec).toContain("Supplier complaints");
    expect(spec).toContain("A person approves before: sending an email; a change in another system");
    expect(spec).toContain("Note from the Studio: quality@acme.com.tr has no mail yet");
    const tests = renderTests(agent());
    expect(tests).toContain("### an email from Akın Metal");
    expect(tests).toContain("Then (succeeded, tried 2026-10-12): Filed the complaint");
    expect(tests).toContain("Before sending an email, it stops and asks a person");
    // The same input gives the same page: nothing of the moment inside.
    expect(renderAgentSpec(agent())).toBe(spec);
  });

  it("tells Claude Code what to build, the rules, and how to reach the live brain without the key", () => {
    const folders = [
      { folder: "agents/", what: "the AI employees", files: 4 },
      { folder: "brain/", what: "the brain", files: 3 },
    ];
    const claude = renderClaudeMd({ project, agents: [agent()], folders, mcp: { url: "https://brain.acme.com.tr/mcp/acme", keyName: "EB_API_KEY" } });
    expect(claude).toContain("# Petrokim complaints");
    expect(claude).toContain("One AI employee, each specified in its own folder");
    expect(claude).toContain("**Complaint Handler** (`agents/complaint-handler/SPEC.md`)");
    expect(claude).toContain("a person approves sending an email and a change in another system");
    expect(claude).toContain("https://brain.acme.com.tr/mcp/acme");
    expect(claude).toContain("`EB_API_KEY`");
    expect(claude).toContain("never commit it");
    expect(claude).toContain("- `agents/`: the AI employees");
    const mcp = JSON.parse(renderMcpJson("https://brain.acme.com.tr/mcp/acme")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(mcp.mcpServers["enterprise-brain"]).toEqual({
      type: "http",
      url: "https://brain.acme.com.tr/mcp/acme",
      headers: { Authorization: "Bearer ${EB_API_KEY}" },
    });
    const offline = renderClaudeMd({ project, agents: [], folders, mcp: null });
    expect(offline).toContain("no AI employee saved yet");
    expect(offline).toContain("without a public address");
  });

  it("writes tables with their schema and a sample that masks personal fields the DPO has not approved", () => {
    const table: TableView = {
      id: "t1",
      key: "supplier_complaints",
      name: "Supplier complaints",
      description: "One supplier complaint",
      departmentId: "d-ops",
      fields: ctx.tables[0]!.fields,
      titleField: "supplier",
      settings: { visibility: "department", editors: "members" },
      version: 1,
      personal: { approved: [], waiting: ["contact"] },
      records: 2,
      createdBy: "test",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      archivedAt: null,
    };
    const record = (n: number, supplier: string, contact: string, status: string): RecordView => ({
      id: `r${n}`,
      number: n,
      title: supplier,
      values: { supplier, contact, status },
      display: {},
      createdBy: "test",
      updatedBy: "test",
      createdAt: new Date("2026-10-02T00:00:00Z"),
      updatedAt: new Date("2026-10-02T00:00:00Z"),
      archivedAt: null,
    });
    const rendered = renderTable(table, [
      record(1, 'Akın Metal, "the" flange people', "ayse@akin.example", "Open"),
      record(2, "Demir Çelik\nIzmir", "mehmet@demir.example", "Closed"),
    ]);
    expect(rendered.csv).toBe('supplier,contact,status\r\n"Akın Metal, ""the"" flange people",[personal],Open\r\n"Demir Çelik\nIzmir",[personal],Closed\r\n');
    expect(rendered.csv).not.toContain("ayse@akin.example");
    expect(rendered.readme).toContain("Personal fields (`contact`) are masked");
    expect(rendered.readme).toContain("| `status` | Status | choice |  |  | choices: Open, Closed · default: Open |");
    expect(JSON.parse(rendered.schema)).toMatchObject({
      key: "supplier_complaints",
      titleField: "supplier",
      fields: [{ key: "supplier" }, { key: "contact", personal: true }, { key: "status" }],
    });
    // Approved by the data protection officer: the values go in.
    const approved = renderTable({ ...table, personal: { approved: ["contact"], waiting: [] } }, [record(1, "Akın Metal", "ayse@akin.example", "Open")]);
    expect(approved.csv).toContain("ayse@akin.example");
    expect(toCsv([])).toBe("");
  });

  it("writes a thing of the brain with its address, and the plan with the agents first and the open items after", () => {
    const view: BrainEntityView = {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "client",
      key: "petrokim",
      name: "Petrokim",
      summary: "Petrochemical group in İzmir",
      brief: [],
      updatedAt: "2026-10-10T00:00:00.000Z",
      aliases: ["PKM"],
      data: {},
      origins: { name: "manual" },
      refs: {},
      createdBy: "test",
      updatedBy: "test",
      createdAt: "2026-10-01T00:00:00.000Z",
      links: [
        {
          id: "l1",
          relation: "for_client",
          direction: "in",
          label: "Work for this client",
          detail: "",
          origin: "manual",
          other: {
            id: "p1",
            kind: "project",
            key: "petrokim-complaints",
            name: "Petrokim complaints",
            summary: "",
            brief: [],
            updatedAt: "2026-10-10T00:00:00.000Z",
          },
        },
      ],
      events: [],
    };
    const thing = renderThing(view);
    expect(thing).toContain("kind: client");
    expect(thing).toContain("# Petrokim — Client");
    expect(thing).toContain("Also called: PKM");
    expect(thing).toContain("Work for this client");
    const plan = renderPlan({
      project,
      agents: [agent()],
      todos: [{ title: "Get the API credentials from Petrokim", details: "Their IT contact has them.", dueAt: "2026-11-15T14:00:00.000Z", who: "Selin Acar" }],
      questions: [{ about: "Asked IT about SAP", text: "Read access to purchase orders", status: "waiting for IT" }],
    });
    expect(plan.indexOf("### 1. Build Complaint Handler")).toBeLessThan(
      plan.indexOf("- [ ] Get the API credentials from Petrokim — Selin Acar, due 2026-11-15: Their IT contact has them."),
    );
    expect(plan).toContain("- Asked IT about SAP: Read access to purchase orders (waiting for IT)");
    expect(plan).toContain("Trigger: Reads every email sent to quality@acme.com.tr");
  });

  it("writes a conversation as a transcript, and keeps file names apart", () => {
    const transcript = renderTranscript("Handle complaints", [
      { kind: "user", data: { text: "Handle the complaints.", files: [{ name: "spec.pdf" }] }, at: "2026-10-12T08:00:00.000Z" },
      { kind: "step", data: { tool: "look_around", text: "Looked at the company", ok: true }, at: "2026-10-12T08:00:01.000Z" },
      { kind: "question", data: { questions: [{ question: "Who confirms the root cause?", recommended: "Kerem" }] }, at: "2026-10-12T08:00:02.000Z" },
      { kind: "answer", data: { text: "Kerem does." }, at: "2026-10-12T08:01:00.000Z" },
      { kind: "part", data: { part: "ai_employee", name: "Complaint Handler" }, at: "2026-10-12T08:02:00.000Z" },
      { kind: "part", data: { part: "asset", name: "Petrokim" }, at: "2026-10-12T08:02:01.000Z" },
      { kind: "said", data: { text: "Done." }, at: "2026-10-12T08:03:00.000Z" },
    ]);
    expect(transcript).toContain("**Person:** Handle the complaints. _(files: spec.pdf)_");
    expect(transcript).toContain("- Who confirms the root cause? _(recommended: Kerem)_");
    expect(transcript).toContain("- Saved ai employee Complaint Handler");
    expect(transcript).toContain("- Added Petrokim to the project");
    expect(transcript).toContain("**Studio:** Done.");
    const taken = new Set<string>();
    expect(uniquePath("files/spec.pdf", taken)).toBe("files/spec.pdf");
    expect(uniquePath("files/spec.pdf", taken)).toBe("files/spec-2.pdf");
    expect(uniquePath("files/spec.pdf", taken)).toBe("files/spec-3.pdf");
  });
});

describe("a connection's page", () => {
  const operations = [
    {
      id: "get_purchase_order",
      name: "Get purchase order",
      description: "Purchase order with lines.",
      kind: "read" as const,
      input: { type: "object", properties: { po_number: { type: "string", description: "PO number" } }, required: ["po_number"] },
    },
    { id: "post_invoice", name: "Post invoice", kind: "write" as const },
  ];

  it("names a real connection's settings and the names of its secrets, never their values", () => {
    const page = renderConnection(
      {
        name: "Petrokim ERP",
        type: "rest-api",
        category: "erp",
        status: "connected",
        config: { base_url: "https://erp.petrokim.test/api", auth_type: "api_key" },
        secretFields: ["api_key"],
        sandbox: false,
      },
      operations,
    );
    expect(page).toContain("# Petrokim ERP");
    expect(page).toContain("## Settings");
    expect(page).toContain("`base_url`: https://erp.petrokim.test/api");
    expect(page).toContain("Secrets (names only, never their values; set them in the environment of what you build): `api_key`");
    expect(page).toContain("`get_purchase_order` — Get purchase order (read): Purchase order with lines. Takes `po_number`* (PO number)");
    expect(page).toContain("`post_invoice` — Post invoice (write)");
    expect(page).not.toContain("demo system");
  });

  it("says what a demo system stands in for, with its actions and no settings", () => {
    const page = renderConnection(
      { name: "Sandbox ERP", type: "sandbox-erp", category: "erp", status: "demo", config: {}, secretFields: [], sandbox: true },
      operations,
    );
    expect(page).toContain("Status on the platform: demo (a demo system standing in for the real one)");
    expect(page).toContain("stands in for the company's real ERP until IT connects one");
    expect(page).not.toContain("## Settings");
    expect(page).toContain("No secrets.");
    expect(page).toContain("`get_purchase_order`");
  });
});
