import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordValueError } from "@enterprise-brain/core";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * Tables: people describe business data, the platform checks every value, numbers the records and
 * keeps every change; AI employees reach the tables through the Tables connection, with the same
 * approvals and test runs as any other system.
 */

let platform: Platform;
let companyId: string;
const zeynep = { actor: "Zeynep Kaya <zeynep.kaya@acme.com.tr>" };

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-tables-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.people.create(companyId, { email: "zeynep.kaya@acme.com.tr", name: "Zeynep Kaya" });
  await platform.people.create(companyId, { email: "deniz.aydin@acme.com.tr", name: "Deniz Aydın" });
  await platform.tables.create(companyId, { name: "Suppliers", fields: [{ key: "name", label: "Name", type: "text", required: true }] }, zeynep.actor);
  await platform.tables.add(companyId, "suppliers", { name: "Akın Metal" }, zeynep);
  await platform.tables.add(companyId, "suppliers", { name: "Demir Döküm" }, zeynep);
  await platform.tables.create(
    companyId,
    {
      name: "Supplier complaints",
      description: "Problems with what suppliers delivered",
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "supplier", label: "Supplier", type: "link", table: "suppliers", required: true },
        { key: "status", label: "Status", type: "choice", choices: ["Open", "In progress", "Closed"], required: true },
        { key: "owner", label: "Owner", type: "person" },
        { key: "cost", label: "Cost", type: "money", currency: "TRY" },
        { key: "found_on", label: "Found on", type: "date" },
        { key: "lot", label: "Lot", type: "text" },
      ],
    },
    zeynep.actor,
  );
});
afterAll(async () => {
  await platform?.close();
});

describe("tables", () => {
  it("checks values and stores them in their form: numbers, dates, choices, people and links", async () => {
    const record = await platform.tables.add(
      companyId,
      "supplier_complaints",
      { problem: "Cracked flanges in lot 7", supplier: "Akın Metal", status: "open", owner: "Deniz Aydın", cost: "1.250,50", "Found on": "02.10.2026" },
      zeynep,
    );
    expect(record).toMatchObject({
      number: 1,
      title: "Cracked flanges in lot 7",
      values: { status: "Open", owner: "deniz.aydin@acme.com.tr", cost: 1250.5, found_on: "2026-10-02" },
      display: { supplier: "#1 Akın Metal", owner: "Deniz Aydın" },
      createdBy: "Zeynep Kaya",
    });
    const error = await platform.tables
      .add(companyId, "supplier_complaints", { supplier: "Nobody Ltd", status: "Lost", owner: "someone else" }, zeynep)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordValueError);
    expect((error as RecordValueError).problems).toEqual([
      "Problem is required",
      'Supplier: no record "Nobody Ltd" in the linked table',
      'Status: one of "Open", "In progress", "Closed"',
      'Owner: "someone else" is not a person of the company',
    ]);
  });

  it("numbers records in their table and keeps every change with who made it", async () => {
    const second = await platform.tables.add(companyId, "supplier_complaints", { problem: "Late delivery", supplier: "#2", status: "In progress" }, zeynep);
    expect(second.number).toBe(2);
    const changed = await platform.tables.update(
      companyId,
      "supplier_complaints",
      "#1",
      { status: "Closed", cost: "" },
      { actor: "Deniz Aydın <deniz.aydin@acme.com.tr>" },
    );
    expect(changed.values).not.toHaveProperty("cost");
    expect(changed).toMatchObject({ values: { status: "Closed" }, updatedBy: "Deniz Aydın", createdBy: "Zeynep Kaya" });
    const history = await platform.tables.history(companyId, "supplier_complaints", "1");
    expect(history.map((h) => [h.action, h.by])).toEqual([
      ["updated", "Deniz Aydın"],
      ["created", "Zeynep Kaya"],
    ]);
    expect(history[0]!.changes).toEqual([
      { key: "status", label: "Status", from: "Open", to: "Closed" },
      { key: "cost", label: "Cost", from: 1250.5, to: null },
    ]);
    expect(history[1]!.changes).toContainEqual({ key: "supplier", label: "Supplier", from: null, to: "#1 Akın Metal" });
  });

  it("finds records by words, by field and in the order of a list", async () => {
    const found = await platform.tables.records(companyId, "supplier_complaints", { search: "flanges" });
    expect(found.records.map((r) => r.number)).toEqual([1]);
    expect((await platform.tables.records(companyId, "supplier_complaints", { search: "#2" })).records.map((r) => r.number)).toEqual([2]);
    expect((await platform.tables.records(companyId, "supplier_complaints", { where: { supplier: "Demir Döküm" } })).records.map((r) => r.number)).toEqual([2]);
    expect((await platform.tables.records(companyId, "supplier_complaints", { where: { status: "closed" } })).total).toBe(1);
    const ordered = await platform.tables.records(companyId, "supplier_complaints", { sort: "status", direction: "asc" });
    expect(ordered.records.map((r) => r.values.status)).toEqual(["In progress", "Closed"]);
    expect((await platform.tables.get(companyId, "supplier_complaints")).records).toBe(2);
  });

  it("converts values when a field's kind changes, and refuses when some don't fit", async () => {
    await platform.tables.update(companyId, "supplier_complaints", "1", { lot: "7" }, zeynep);
    const fields = (await platform.tables.get(companyId, "supplier_complaints")).fields;
    const asNumber = fields.map((f) => (f.key === "lot" ? { ...f, type: "number" as const } : f));
    const table = await platform.tables.change(companyId, "supplier_complaints", { fields: asNumber });
    expect(table.version).toBe(2);
    expect((await platform.tables.record(companyId, "supplier_complaints", "1")).values.lot).toBe(7);
    const narrower = fields.map((f) => (f.key === "status" ? { ...f, choices: ["Open", "Closed"] } : f));
    await expect(platform.tables.change(companyId, "supplier_complaints", { fields: narrower })).rejects.toThrow(/#2: Status: one of "Open", "Closed"/);
  });

  it("imports rows from a sheet by column name, with each row's problems", async () => {
    const rows = [
      { Problem: "Wrong paint", Supplier: "Akın Metal", Status: "Open", Notes: "x" },
      { Problem: "", Supplier: "Nobody", Status: "Open" },
      { Problem: "", Supplier: "", Status: "" },
    ];
    const preview = await platform.tables.importRows(companyId, "supplier_complaints", rows, zeynep, { dryRun: true });
    expect(preview).toMatchObject({ columns: { Problem: "problem", Supplier: "supplier", Status: "status" }, ignored: ["Notes"], ready: 1, added: 0 });
    expect(preview.problems).toEqual([{ row: 3, problems: ["Problem is required", 'Supplier: no record "Nobody" in the linked table'] }]);
    const done = await platform.tables.importRows(companyId, "supplier_complaints", rows, zeynep);
    expect(done.added).toBe(1);
    expect((await platform.tables.record(companyId, "supplier_complaints", "3")).title).toBe("Wrong paint");
    expect((await platform.tables.history(companyId, "supplier_complaints", "3"))[0]!.action).toBe("imported");
  });

  it("keeps the Tables connection in step: each table's actions for AI employees", async () => {
    const resolved = await platform.connectors.resolve(companyId, { ref: "tables", category: "tables" });
    expect(resolved.impl.manifest.operations.map((o) => o.id)).toEqual([
      "find_supplier_complaints",
      "get_supplier_complaints",
      "add_supplier_complaints",
      "update_supplier_complaints",
      "find_suppliers",
      "get_suppliers",
      "add_suppliers",
      "update_suppliers",
    ]);
    const add = resolved.impl.manifest.operations.find((o) => o.id === "add_supplier_complaints")!;
    expect(add).toMatchObject({ kind: "write", input: { required: ["problem", "supplier", "status"] } });
    const archived = await platform.tables.create(companyId, { name: "Old list", fields: [{ key: "item", label: "Item" }] }, zeynep.actor);
    await platform.tables.archive(companyId, archived.key);
    const after = await platform.connectors.resolve(companyId, { ref: "tables", category: "tables" });
    expect(after.impl.manifest.operations.some((o) => o.id.endsWith("_old_list"))).toBe(false);
    await expect(platform.tables.add(companyId, "old_list", { item: "x" }, zeynep)).rejects.toThrow(/archived/);
  });

  it("lets AI employees file records: alone when trusted, after approval when supervised, never in test runs", async () => {
    const definition = (slug: string) => ({
      slug,
      name: slug === "complaint-filer" ? "Complaint Filer" : "Careful Filer",
      summary: "Files supplier complaints.",
      archetype: "process-automation" as const,
      instructions: "File complaints.",
      inputs: [
        { key: "problem", type: "string" as const, required: true },
        { key: "supplier", type: "string" as const, required: true },
      ],
      connectors: [{ ref: "tables", category: "tables" }],
      workflow: [
        {
          id: "existing",
          type: "connector" as const,
          connector: "tables",
          operation: "find_supplier_complaints",
          input: { supplier: "{{ input.supplier }}", status: "Open" },
        },
        {
          id: "file",
          type: "connector" as const,
          connector: "tables",
          operation: "add_supplier_complaints",
          input: { problem: "{{ input.problem }}", supplier: "{{ input.supplier }}", status: "Open", owner: "zeynep.kaya@acme.com.tr" },
        },
      ],
      guardrails: { approvalRequiredFor: [], personalData: "none" as const },
    });
    await platform.agents.create(companyId, { status: "active", probation: "trusted", definition: definition("complaint-filer") });
    await platform.agents.create(companyId, { status: "active", probation: "supervised", definition: definition("careful-filer") });

    const run = await platform.engine.start(companyId, "complaint-filer", { problem: "Rust on bolts", supplier: "Demir Döküm" });
    expect(run.status).toBe("succeeded");
    const state = (await platform.engine.getRow(companyId, run.id)).context as { steps: Record<string, Record<string, unknown>> };
    expect(state.steps.existing).toMatchObject({ total: 0 });
    expect(state.steps.file).toMatchObject({
      number: 4,
      problem: "Rust on bolts",
      supplier: "#2 Demir Döküm",
      owner: "Zeynep Kaya <zeynep.kaya@acme.com.tr>",
      status: "Open",
    });
    const [created] = await platform.tables.history(companyId, "supplier_complaints", "4");
    expect(created).toMatchObject({ action: "created", by: "Complaint Filer", ai: true, runId: run.id });

    const test = await platform.engine.start(companyId, "complaint-filer", { problem: "Test only", supplier: "Akın Metal" }, { isTest: true });
    expect(test.status).toBe("succeeded");
    expect((await platform.tables.records(companyId, "supplier_complaints", { search: "Test only" })).total).toBe(0);

    const careful = await platform.engine.start(companyId, "careful-filer", { problem: "Bent frames", supplier: "Akın Metal" });
    expect(careful.status).toBe("waiting_approval");
    expect((await platform.tables.records(companyId, "supplier_complaints", { search: "Bent" })).total).toBe(0);
    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === careful.id);
    expect(approval).toMatchObject({ title: "Add a record to Supplier complaints in Tables" });
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "Zeynep Kaya" });
    const filed = await platform.tables.records(companyId, "supplier_complaints", { search: "Bent" });
    expect(filed.records[0]).toMatchObject({ createdBy: "Careful Filer", values: { status: "Open" } });
  });

  it("tells an AI employee what to correct when a value doesn't fit", async () => {
    const store = platform.tables.storeFor(companyId);
    await expect(store.add("supplier_complaints", { problem: "x", supplier: "Akın Metal", status: "Maybe" }, { actor: "agent:x" })).rejects.toMatchObject({
      code: "validation",
      message: 'Status: one of "Open", "In progress", "Closed"',
    });
    await expect(store.get("supplier_complaints", "99")).rejects.toMatchObject({ code: "not_found" });
  });
});
