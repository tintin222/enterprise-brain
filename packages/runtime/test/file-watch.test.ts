import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHARED_FOLDER_ROOTS_ENV } from "@enterprise-brain/connectors";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * Files as work: a new file in a watched folder (a network drive here; SFTP works the same) is
 * brought into Enterprise Brain once and handed to the AI employee whose duty watches the folder, as
 * its file to work on. AI employees also read files into Enterprise Brain and send stored ones out.
 */

const shares = realpathSync(mkdtempSync(join(tmpdir(), "eb-shares-")));
const folder = join(shares, "scanned-invoices");
let previousRoots: string | undefined;
let platform: Platform;
let companyId: string;
let connectionId: string;

beforeAll(async () => {
  previousRoots = process.env[SHARED_FOLDER_ROOTS_ENV];
  process.env[SHARED_FOLDER_ROOTS_ENV] = shares;
  mkdirSync(join(folder, "incoming"), { recursive: true });
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-file-watch-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  connectionId = (
    await platform.connectors.create(companyId, {
      type: "shared-folder",
      name: "Scanned invoices",
      values: { path: folder, watch_folder: "incoming", watch_pattern: "*.txt; *.pdf", processed_folder: "done", settle_seconds: 0, max_file_mb: 1 },
    })
  ).id;
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "scan-reader",
      name: "Scan Reader",
      summary: "Reads scanned supplier invoices.",
      archetype: "document-processing",
      instructions: "Read each scanned invoice.",
      inputs: [{ key: "invoice", label: "Invoice", type: "file" }],
      connectors: [{ ref: "scans", category: "storage" }],
      triggers: [{ type: "connector-event", connector: "scans", event: "new_file" }],
      workflow: [
        { id: "document", type: "extract", from: "{{ input.invoice }}" },
        { id: "result", type: "output", value: { file: "{{ input.event.name }}", text: "{{ steps.document.text }}", moved: "{{ input.event.moved_to }}" } },
      ],
    },
  });
});
afterAll(async () => {
  await platform?.close();
  if (previousRoots === undefined) delete process.env[SHARED_FOLDER_ROOTS_ENV];
  else process.env[SHARED_FOLDER_ROOTS_ENV] = previousRoots;
});

describe("files as work", () => {
  it("hands each new file in a watched folder to the duty that watches it, once", async () => {
    writeFileSync(join(folder, "incoming/before.txt"), "was there before the duty");
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 0, errors: [] });

    writeFileSync(join(folder, "incoming/INV-7.txt"), "Invoice INV-7 from Hansa Valves, total 1,250.00 TRY");
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 1, errors: [] });
    const task = (await platform.tasks.list(companyId)).find((t) => t.source === "connector-event");
    expect(task).toMatchObject({ title: "Scan Reader: INV-7.txt", status: "done" });
    const [run] = await platform.tasks.runsOf(task!.id);
    expect(run!.output).toMatchObject({ file: "INV-7.txt", text: expect.stringContaining("Hansa Valves"), moved: "done/INV-7.txt" });
    // Brought in as the AI employee's file, and moved out of the way.
    const stored = await platform.files.meta(companyId, String(run!.input.invoice));
    expect(stored).toMatchObject({ name: "INV-7.txt", source: "watched-folder", metadata: { path: "incoming/INV-7.txt" } });
    expect(run!.input.file).toBe(stored.id);
    expect(readdirSync(join(folder, "incoming"))).toEqual(["before.txt"]);
    expect(readFileSync(join(folder, "done/INV-7.txt"), "utf8")).toContain("INV-7");

    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 0, errors: [] });
  });

  it("names the folder it watches among its duties", async () => {
    const agent = await platform.agents.get(companyId, "scan-reader");
    const employment = await platform.employment.view(companyId, agent);
    expect(employment.duties.map((d) => d.text)).toEqual(["Picks up each new file in Scanned invoices"]);
  });

  it("tells IT about a file it leaves alone", async () => {
    writeFileSync(join(folder, "incoming/INV-8.pdf"), Buffer.alloc(Math.round(1.5 * 1024 * 1024)));
    const result = await platform.watchers.pollCompany(companyId, { wait: true });
    expect(result).toMatchObject({ events: 0, errors: ["Scan Reader (Scanned invoices): incoming/INV-8.pdf is 1.5 MB; files up to 1 MB are picked up"] });
    const watcher = (await platform.watchers.status(companyId)).find((w) => w.key.startsWith("new_file#"));
    expect(watcher?.lastError).toBe("incoming/INV-8.pdf is 1.5 MB; files up to 1 MB are picked up");
  });

  it("lets AI employees read files into Enterprise Brain and send stored files out", async () => {
    const read = (await platform.connectors.executeInstance(companyId, connectionId, "read_file", { path: "done/INV-7.txt" })) as Record<string, unknown>;
    expect(read).toMatchObject({ name: "INV-7.txt", text: expect.stringContaining("INV-7"), file_id: expect.any(String) });
    expect((await platform.files.get(companyId, String(read.file_id))).data.toString()).toContain("Hansa Valves");

    const report = await platform.files.put(companyId, { name: "AP summary.csv", data: Buffer.from("invoice,total\nINV-7,1250.00\n"), source: "generated" });
    await platform.connectors.executeInstance(companyId, connectionId, "write_file", { path: "outgoing/", file_id: report.id });
    expect(readFileSync(join(folder, "outgoing/AP summary.csv"), "utf8")).toBe("invoice,total\nINV-7,1250.00\n");
    // Another company's file is not within reach.
    const other = (await platform.ensureCompany({ slug: "other", name: "Other" })).id;
    const theirs = await platform.files.put(other, { name: "salaries.csv", data: Buffer.from("secret"), source: "upload" });
    await expect(platform.connectors.executeInstance(companyId, connectionId, "write_file", { path: "outgoing/", file_id: theirs.id })).rejects.toThrow(
      /not found/,
    );
    expect(existsSync(join(folder, "outgoing/salaries.csv"))).toBe(false);
  });
});
