import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The development package of a project over HTTP: a thing of the brain, a table with personal data, a
 * document, a connection with a secret, a file, a Studio conversation that wrote an AI employee and an
 * interview come out as one folder Claude Code builds from; secrets and unapproved personal values never
 * do; the project remembers the export; the MCP server answers from the company brain.
 */

const base = "/api/companies/acme";

/** The Studio writes one AI employee and leaves a task, then says so. */
function script(request: ToolLoopRequest, turn: number) {
  if (!request.tools.some((t) => t.name === "project_add_asset")) return { text: "Nothing to do." };
  switch (turn) {
    case 1:
      return {
        calls: [
          {
            name: "save_ai_employee",
            input: {
              name: "Complaint Handler",
              role: "Handles Petrokim's supplier complaints",
              department: "operations",
              job: "For each complaint email about a delivery: log it in Supplier complaints with the supplier and the problem, ask the quality engineer to confirm the root cause, and never promise a refund.",
              starts: [{ when: "email", mailbox: "quality@acme.com.tr" }],
              can: { documents: true, tables: [{ table: "supplier_complaints", can: ["find", "add"] }] },
            },
          },
          { name: "project_add_task", input: { title: "Confirm the escalation rule with Kerem", due: "2026-11-20" } },
        ],
      };
    default:
      return { text: "The Complaint Handler is written; confirm the escalation rule with Kerem." };
  }
}

const llm = new ScriptedLlm({
  "studio.agent": { tools: script },
  // The guided interview's analyst reads the description with Claude: a plain answer so the interview starts.
  "builder.discover": {
    structured: () => ({
      archetype: "document-processing",
      templateId: "none",
      agentName: "Invoice Helper",
      department: "operations",
      language: "en",
      goal: "Answer suppliers' questions about their invoices.",
      prefilled: [],
      extraQuestions: [],
      rationale: "A request about supplier invoices; nothing in the catalog fits closely.",
    }),
  },
  "builder.phrase-round": {
    structured: (request) => {
      const schema = request.schema as { properties: { questions: { items: { properties: { nodeId: { enum: string[] } } } } } };
      return {
        intro: "A few questions to shape the Invoice Helper.",
        questions: schema.properties.questions.items.properties.nodeId.enum.map((nodeId) => ({
          nodeId,
          title: nodeId,
          question: `What about ${nodeId}?`,
          why: "It shapes the job.",
          recommendedValues: [],
          recommendationText: "Go with the default",
        })),
      };
    },
  },
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Preview {
  summary: { folders: { folder: string; files: number }[]; files: number; agents: { slug: string; source: string }[]; warnings: string[]; mcpUrl: string };
  files: { path: string; bytes: number; text?: string }[];
}

describe("the development package", () => {
  let t: TestApp;
  let companyId = "";
  const as: Record<string, string> = {};
  let project: { id: string; slug: string; thingId: string };
  let petrokimId = "";
  let fileBytes = Buffer.alloc(0);
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] }, apiKey: "machine-key" } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    for (const local of ["selin.acar", "kerem.yildiz", "can.demir"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
    // The brain: a client with a link and an event.
    const petrokim = await t.platform.brain.create(
      companyId,
      { kind: "client", name: "Petrokim", summary: "Petrochemical group in İzmir", aliases: ["PKM"] },
      "test",
    );
    petrokimId = petrokim.id;
    const portal = await t.platform.brain.create(companyId, { kind: "system", name: "Supplier portal", summary: "Where suppliers upload invoices" }, "test");
    await t.platform.brain.link(companyId, { from: portal.id, relation: "uses", to: petrokim.id }, "test").catch(() => undefined);
    await t.platform.brain.addEvent(
      companyId,
      { kind: "meeting", title: "Kick-off with Petrokim", about: [petrokim.id] },
      "Selin Acar <selin.acar@acme.com.tr>",
    );
    // A table with a personal field and three records.
    const operations = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "operations")!;
    const table = await call("selin.acar", "POST", "/tables", {
      name: "Supplier complaints",
      fields: [
        { key: "supplier", label: "Supplier", type: "text", required: true },
        { key: "contact", label: "Contact", type: "email", personal: true },
        { key: "problem", label: "Problem", type: "long_text" },
      ],
      titleField: "supplier",
      departmentId: operations.id,
    });
    expect(table.statusCode, table.body).toBe(200);
    for (const [supplier, problem] of [
      ["Akın Metal", "Cracked flanges, lot 7"],
      ["Demir Çelik", "Late delivery"],
      ["Ege Plastik", "Wrong colour"],
    ]) {
      const added = await call("selin.acar", "POST", "/tables/supplier_complaints/records", { values: { supplier, problem } });
      expect(added.statusCode, added.body).toBe(200);
    }
    // A document, a file, a connection with a secret.
    await t.platform.knowledge.ensureCollection(companyId, { key: "portal-docs", name: "Portal documents" });
    const document = await t.platform.knowledge.ingestText(companyId, "portal-docs", {
      title: "Supplier portal manual",
      text: "Suppliers sign in with their vendor number and see their open orders. Invoices are uploaded as PDF.",
    });
    fileBytes = Buffer.from("The portal spec, as the client sent it.\n");
    const file = await t.platform.files.put(companyId, { name: "portal spec.txt", data: fileBytes, mimeType: "text/plain", source: "test" });
    const connection = await t.platform.connectors.create(companyId, {
      type: "rest-api",
      name: "Petrokim ERP",
      values: { base_url: "https://erp.petrokim.test/api", auth_type: "api_key", api_key: "s3cret-key-value" },
    });
    // The project, with everything in it.
    const made = await call("selin.acar", "POST", "/projects", {
      name: "Petrokim complaints",
      client: "Petrokim",
      summary: "AI employees for the supplier complaint process.",
    });
    expect(made.statusCode, made.body).toBe(200);
    project = made.json() as typeof project;
    for (const asset of [
      { kind: "thing", ref: petrokim.id },
      { kind: "thing", ref: portal.id },
      { kind: "table", ref: "supplier_complaints" },
      { kind: "document", ref: document.id },
      { kind: "file", ref: file.id },
      { kind: "connection", ref: connection.id },
      { kind: "connection", ref: "sandbox-erp" },
    ]) {
      const added = await call("selin.acar", "POST", `/projects/${project.id}/assets`, asset);
      expect(added.statusCode, added.body).toBe(200);
    }
    // A Studio conversation that writes an AI employee, and an interview.
    const started = await call("selin.acar", "POST", "/studio/threads", { text: "Handle Petrokim's supplier complaints.", projectId: project.id });
    expect(started.statusCode, started.body).toBe(200);
    const threadId = (started.json() as { id: string }).id;
    await until(
      async () => (await call("selin.acar", "GET", `/studio/threads/${threadId}`)).json() as { status: string },
      (v) => v.status === "idle" || v.status === "failed",
      "the Studio",
    );
    const interview = await call("selin.acar", "POST", "/builder/sessions", {
      description: "An AI employee that answers suppliers' questions about their invoices",
      projectId: project.id,
    });
    expect(interview.statusCode, interview.body).toBe(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("holds the agent, the brain, the data, the document, the file and the connection; never a secret or an unapproved personal value", async () => {
    const res = await call("selin.acar", "GET", `/projects/${project.slug}/package?text=1`);
    expect(res.statusCode, res.body).toBe(200);
    const preview = res.json() as Preview;
    const paths = preview.files.map((f) => f.path);
    const text = (path: string) => preview.files.find((f) => f.path === path)?.text ?? "";
    expect(paths).toEqual(
      expect.arrayContaining([
        "README.md",
        "CLAUDE.md",
        ".mcp.json",
        "project.json",
        "agents/complaint-handler/SPEC.md",
        "agents/complaint-handler/definition.json",
        "agents/complaint-handler/design.json",
        "agents/complaint-handler/tests.md",
        "agents/complaint-handler/conversation.md",
        "brain/client/petrokim.md",
        "brain/system/supplier-portal.md",
        "brain/things.json",
        "brain/README.md",
        "data/tables/supplier_complaints/README.md",
        "data/tables/supplier_complaints/schema.json",
        "data/tables/supplier_complaints/sample.csv",
        "knowledge/portal-docs/supplier-portal-manual.md",
        "files/portal spec.txt",
        "connections/petrokim-erp.md",
        "connections/sandbox-erp.md",
        "tasks/PLAN.md",
      ]),
    );
    // The interview has no AI employee saved yet: its page goes in on its own.
    expect(paths.some((p) => /^agents\/.*\/interview\.md$/.test(p))).toBe(true);
    expect(preview.summary.agents).toEqual([{ slug: "complaint-handler", name: "Complaint Handler", source: "studio" }]);
    expect(preview.summary.folders.find((f) => f.folder === "brain/")!.files).toBe(4);
    expect(preview.summary.mcpUrl).toBe("http://brain.test/mcp/acme");
    expect(preview.summary.warnings).toEqual([]);

    expect(text("CLAUDE.md")).toContain("**Complaint Handler** (`agents/complaint-handler/SPEC.md`)");
    expect(text("CLAUDE.md")).toContain("http://brain.test/mcp/acme");
    expect(text("CLAUDE.md")).toContain("`EB_API_KEY`");
    expect(text(".mcp.json")).toContain("Bearer ${EB_API_KEY}");
    expect(text("agents/complaint-handler/SPEC.md")).toContain("never promise a refund");
    expect(text("agents/complaint-handler/SPEC.md")).toContain("Reads every email sent to quality@acme.com.tr");
    expect(text("agents/complaint-handler/conversation.md")).toContain("**Person:** Handle Petrokim's supplier complaints.");
    expect(text("agents/complaint-handler/conversation.md")).toContain("Task for the person: Confirm the escalation rule with Kerem");
    expect(text("brain/client/petrokim.md")).toContain("# Petrokim — Client");
    expect(text("brain/client/petrokim.md")).toContain("Kick-off with Petrokim");
    expect(text("brain/client/petrokim.md")).toContain("Work for this client");
    expect(text("data/tables/supplier_complaints/sample.csv").split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(text("data/tables/supplier_complaints/sample.csv")).toContain("Akın Metal");
    expect(text("data/tables/supplier_complaints/README.md")).toContain("Personal fields (`contact`) are masked");
    expect(text("knowledge/portal-docs/supplier-portal-manual.md")).toContain("vendor number");
    expect(text("connections/petrokim-erp.md")).toContain("`base_url`: https://erp.petrokim.test/api");
    expect(text("connections/petrokim-erp.md")).toContain("`api_key`");
    // The demo ERP: its actions from its manifest, no settings, no secrets, and what it stands in for.
    expect(text("connections/sandbox-erp.md")).toContain("a demo system standing in for the real one");
    expect(text("connections/sandbox-erp.md")).toContain("stands in for the company's real ERP until IT connects one");
    expect(text("connections/sandbox-erp.md")).toContain("`get_purchase_order`");
    expect(text("connections/sandbox-erp.md")).toContain("No secrets.");
    expect(text("connections/sandbox-erp.md")).not.toContain("## Settings");
    expect(text("tasks/PLAN.md")).toContain("### 1. Build Complaint Handler");
    expect(text("tasks/PLAN.md")).toContain("- [ ] Confirm the escalation rule with Kerem — Selin Acar, due 2026-11-20");
    // Nowhere does the secret appear.
    for (const file of preview.files) expect(file.text ?? "").not.toContain("s3cret-key-value");
  });

  it("downloads as a zip under the project's folder, with the file's bytes, and the project remembers the export", async () => {
    const res = await call("selin.acar", "GET", `/projects/${project.slug}/package.zip`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="petrokim-complaints-dev-package.zip"');
    const zip = await JSZip.loadAsync(res.rawPayload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    expect(names).toEqual(
      expect.arrayContaining([
        "petrokim-complaints/CLAUDE.md",
        "petrokim-complaints/files/portal spec.txt",
        "petrokim-complaints/data/tables/supplier_complaints/sample.csv",
      ]),
    );
    expect(Buffer.from(await zip.file("petrokim-complaints/files/portal spec.txt")!.async("nodebuffer")).equals(fileBytes)).toBe(true);
    for (const name of names) {
      const content = await zip.file(name)!.async("string");
      expect(content, name).not.toContain("s3cret-key-value");
    }
    const view = (await call("selin.acar", "GET", `/projects/${project.slug}`)).json() as { lastExportedAt: string | null; exports: number };
    expect(view.lastExportedAt).toBeTruthy();
    expect(view.exports).toBe(1);
    const events = (await call("selin.acar", "GET", `/brain/events?about=${project.thingId}`)).json() as { title: string }[];
    expect(events.some((e) => e.title === "Development package exported")).toBe(true);
  });

  it("gives another reader the package without the owner's conversation and the tables they may not see; a stranger gets nothing", async () => {
    const res = await call("can.demir", "GET", `/projects/${project.slug}/package`);
    expect(res.statusCode, res.body).toBe(200);
    const preview = res.json() as Preview;
    const paths = preview.files.map((f) => f.path);
    expect(paths).toContain("agents/complaint-handler/SPEC.md");
    expect(paths).not.toContain("agents/complaint-handler/conversation.md");
    expect(paths.some((p) => p.startsWith("data/tables/"))).toBe(false);
    expect(preview.summary.warnings).toEqual(expect.arrayContaining([expect.stringContaining("left out"), expect.stringContaining("is Selin Acar's")]));
    expect((await t.app.inject({ method: "GET", url: `${base}/projects/${project.slug}/package` })).statusCode).toBe(401);
  });

  it("answers Claude Code from the company brain over MCP", async () => {
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer machine-key" };
    const list = await t.app.inject({ method: "POST", url: "/mcp/acme", headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain("company_search");
    expect(list.body).toContain("company_open");
    const open = await t.app.inject({
      method: "POST",
      url: "/mcp/acme",
      headers,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "company_open", arguments: { id_or_name: petrokimId } } },
    });
    expect(open.statusCode, open.body).toBe(200);
    expect(open.body).toContain("Petrokim");
    expect(open.body).toContain("Petrochemical group");
    const missing = await t.app.inject({
      method: "POST",
      url: "/mcp/acme",
      headers,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "company_open", arguments: { id_or_name: "Nothing of that name" } } },
    });
    expect(missing.body).toContain("isError");
  });
});
