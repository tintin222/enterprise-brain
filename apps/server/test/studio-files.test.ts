import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHARED_FOLDER_ROOTS_ENV } from "@enterprise-brain/connectors";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * The Studio beyond email: a finance manager's supplier invoices are scanned into a shared folder.
 * The Studio (scripted here) sees the folder can be watched for new files, makes the register and an
 * AI employee that picks up each new file, tries it on the sample the manager added, and once it is at
 * work a file dropped into the folder becomes a record, after the manager's approval.
 */

const base = "/api/companies/acme";
const shares = realpathSync(mkdtempSync(join(tmpdir(), "eb-studio-shares-")));
const folder = join(shares, "invoices");
const seen: string[] = [];
let sampleId = "";

/** The Studio: looks, reads the sample, makes the register and the AI employee, tries it. */
function studioScript(_request: ToolLoopRequest, turn: number, results: string[]) {
  seen.push(...results.slice(seen.length));
  switch (turn) {
    case 1:
      return {
        calls: [
          { name: "look_around", input: {} },
          { name: "read_file", input: { id: sampleId } },
        ],
      };
    case 2:
      return {
        calls: [
          {
            name: "save_table",
            input: {
              name: "Supplier invoices",
              department: "finance",
              fields: [
                { label: "Supplier", type: "text", required: true },
                { label: "Invoice number", type: "text" },
                { label: "Amount", type: "number" },
                { label: "Over the limit", type: "yes_no" },
              ],
              title_field: "Supplier",
            },
          },
        ],
      };
    case 3:
      return {
        calls: [
          {
            name: "save_ai_employee",
            input: {
              name: "Invoice Clerk",
              role: "Logs each supplier invoice scanned into the invoice folder",
              department: "finance",
              job: "For each new file in the invoice folder: read the invoice, log the supplier, invoice number and amount in Supplier invoices, and mark it over the limit above 10,000 TRY.",
              starts: [{ when: "system", system: "invoice-folder", event: "new_file" }],
              can: { documents: true, excel: true, tables: [{ table: "supplier_invoices", can: ["add"] }] },
            },
          },
        ],
      };
    case 4:
      return { calls: [{ name: "try_ai_employee", input: { key: "invoice-clerk", file_id: sampleId } }] };
    default:
      return {
        text: "The Invoice Clerk picks up each new invoice in the invoice folder and logs it; it logged your sample correctly. Put it to work when you're happy.",
      };
  }
}

/** The AI employee: reads the file it was handed, then logs it. */
function clerkScript(request: ToolLoopRequest, turn: number, results: string[]) {
  const prompt = String(request.messages[0]?.content ?? "");
  const input = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { file: string };
  if (turn === 1) return { calls: [{ name: "documents_read", input: { file_id: input.file } }] };
  if (turn === 2) {
    const text = results[0] ?? "";
    const amount = Number(/total ([\d,]+)/i.exec(text)?.[1]?.replace(/,/g, "") ?? 0);
    const add = request.tools.find((t) => t.name === "tables__add_supplier_invoices")!;
    const values: Record<string, unknown> = {};
    for (const key of Object.keys((add.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) {
      if (/supplier/.test(key)) values[key] = /from ([^,]+),/.exec(text)?.[1] ?? "";
      else if (/invoice/.test(key)) values[key] = /Invoice (\S+)/.exec(text)?.[1] ?? "";
      else if (/amount/.test(key)) values[key] = amount;
      else if (/limit/.test(key)) values[key] = amount > 10_000;
    }
    return { calls: [{ name: add.name, input: values }] };
  }
  return { text: "Logged the invoice." };
}

const llm = new ScriptedLlm({
  "studio.agent": { tools: studioScript },
  "runtime.agent:invoice-clerk": { tools: clerkScript },
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

describe("the Studio, for work that comes as files", () => {
  let t: TestApp;
  let companyId = "";
  let burak = "";
  let previousRoots: string | undefined;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: burak },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    previousRoots = process.env[SHARED_FOLDER_ROOTS_ENV];
    process.env[SHARED_FOLDER_ROOTS_ENV] = shares;
    mkdirSync(join(folder, "incoming"), { recursive: true });
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    burak = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "burak.sahin@acme.com.tr" } }));
    // IT connected the folder the scanner writes to.
    await t.platform.connectors.create(companyId, {
      type: "shared-folder",
      name: "Invoice folder",
      values: { path: folder, watch_folder: "incoming", watch_pattern: "*.txt", processed_folder: "done", settle_seconds: 0, max_file_mb: 1 },
    });
    const sample = multipart({}, [
      { field: "file", name: "sample-invoice.txt", data: Buffer.from("Invoice INV-2026-0042 from Hansa Valves, total 12,400 TRY"), type: "text/plain" },
    ]);
    const uploaded = await t.app.inject({ method: "POST", url: `${base}/files`, headers: { cookie: burak, ...sample.headers }, payload: sample.payload });
    sampleId = (uploaded.json() as { id: string }[])[0]!.id;
  });
  afterAll(async () => {
    await t?.close();
    if (previousRoots === undefined) delete process.env[SHARED_FOLDER_ROOTS_ENV];
    else process.env[SHARED_FOLDER_ROOTS_ENV] = previousRoots;
  });

  it("builds an AI employee that picks up each new file in a folder, and files it once at work", async () => {
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    const started = await call("POST", "/studio/threads", {
      text: "Our supplier invoices are scanned into the invoice folder. Log each one and flag the ones over 10,000 TRY.",
      departmentId: finance.id,
      fileIds: [sampleId],
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as { id: string }).id;
    const view = await until(
      async () =>
        (await call("GET", `/studio/threads/${id}`)).json() as {
          status: string;
          solution: { employees: { duties: string[]; abilities: string[]; lastTry: { status: string } | null; notes: string[] }[] };
        },
      (v) => v.status === "idle",
      "the Studio to build",
    );

    // It saw that the folder can be watched for new files, and read the sample.
    const overview = JSON.parse(seen[0]!) as { systems: { key: string; watch_for?: { id: string }[] }[] };
    expect(overview.systems.find((s) => s.key === "invoice-folder")?.watch_for).toEqual([{ id: "new_file", name: "New file" }]);
    expect(seen[1]).toContain("Hansa Valves");

    const [clerk] = view.solution.employees;
    expect(clerk).toMatchObject({
      duties: ["Picks up each new file in Invoice folder"],
      abilities: ["Reads attachments and files", "Reads Excel and CSV files, and writes Excel workbooks", "Adds records in Supplier invoices"],
      lastTry: { status: "succeeded" },
    });
    expect(clerk!.notes).toContain("It picks up what is new in Invoice folder from the moment it is put to work; what is there before stays as it is.");
    // The try logged nothing.
    expect((await t.platform.tables.get(companyId, "supplier_invoices")).records).toBe(0);

    expect((await call("POST", `/studio/threads/${id}/put-to-work`)).statusCode).toBe(200);
    // The first look at the folder only notes where it starts; the next new file is work.
    await t.platform.watchers.pollCompany(companyId, { wait: true });
    writeFileSync(join(folder, "incoming/INV-2026-0057.txt"), "Invoice INV-2026-0057 from Demir Döküm, total 8,150 TRY");
    expect(await t.platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 1, errors: [] });
    expect(readdirSync(join(folder, "incoming"))).toEqual([]);

    const approvals = await until(
      async () => (await call("GET", "/approvals?status=pending")).json() as { id: string; agentName: string }[],
      (list) => list.length === 1,
      "the approval to log the invoice",
    );
    expect(approvals[0]!.agentName).toBe("Invoice Clerk");
    expect((await call("POST", `/approvals/${approvals[0]!.id}/decide`, { approved: true })).statusCode).toBe(200);
    const { records } = await until(
      () => t.platform.tables.records(companyId, "supplier_invoices"),
      (r) => r.records.length === 1,
      "the record",
    );
    expect(Object.values(records[0]!.values)).toEqual(expect.arrayContaining(["Demir Döküm", "INV-2026-0057", 8150, false]));
  });
});
