import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { lastScheduled, Platform } from "../src/index.ts";

/** Calculations: code run in the sandbox on the tables' rows, when asked or on a schedule; every run kept. */

let platform: Platform;
let companyId: string;
const by = "Selin Çelik <selin.celik@acme.com.tr>";

const ranking = `const counts = {};
for (const row of tables.supplier_complaints) counts[row.supplier] = (counts[row.supplier] ?? 0) + 1;
return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([supplier, complaints], i) => ({ rank: i + 1, supplier, complaints }));`;

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-calc-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.tables.create(
    companyId,
    {
      name: "Supplier complaints",
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "supplier", label: "Supplier", type: "text" },
      ],
    },
    by,
  );
  for (const [problem, supplier] of [
    ["Cracked flange", "Akın Metal"],
    ["Wrong paint", "Demir Döküm"],
    ["Bent frame", "Akın Metal"],
  ]) {
    await platform.tables.add(companyId, "supplier_complaints", { problem, supplier }, { actor: by });
  }
});
afterAll(async () => {
  await platform?.close();
});

describe("calculations", () => {
  it("runs on the rows of its tables and keeps each run", async () => {
    const calculation = await platform.calculations.create(
      companyId,
      {
        name: "Supplier ranking",
        rule: "Rank suppliers by complaints",
        tables: ["supplier_complaints"],
        code: ranking,
        output: { kind: "rows", columns: [{ key: "rank", label: "Rank", type: "rank" }] },
      },
      by,
    );
    expect(calculation).toMatchObject({ key: "supplier_ranking", version: 1, last: null, createdBy: "Selin Çelik" });
    const run = await platform.calculations.run(companyId, "supplier_ranking", { by });
    expect(run).toMatchObject({
      status: "succeeded",
      rows: 3,
      by: "Selin Çelik",
      result: [
        { rank: 1, supplier: "Akın Metal", complaints: 2 },
        { rank: 2, supplier: "Demir Döküm", complaints: 1 },
      ],
    });
    expect((await platform.calculations.get(companyId, "supplier_ranking")).last?.id).toBe(run.id);
  });

  it("keeps a failed run with what went wrong in plain words, and a result that isn't what it promised", async () => {
    const broken = await platform.calculations.create(
      companyId,
      { name: "Broken", rule: "Something", tables: ["supplier_complaints"], code: "return tables.deliveries.length;", output: { kind: "number" } },
      by,
    );
    expect(await platform.calculations.run(companyId, broken.key, { by })).toMatchObject({ status: "failed", error: expect.stringMatching(/TypeError/) });
    const wrongKind = await platform.calculations.change(companyId, broken.key, { code: "return 'three';" });
    expect(wrongKind.version).toBe(2);
    expect(await platform.calculations.run(companyId, broken.key, { by })).toMatchObject({
      status: "failed",
      error: "The result should be a number",
      version: 2,
    });
    expect((await platform.calculations.runs(companyId, broken.key)).map((r) => r.version)).toEqual([2, 1]);
  });

  it("runs by itself once a month, on the first at 07:00 in the company's time zone", async () => {
    expect(lastScheduled("monthly", new Date("2026-10-01T04:05:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(lastScheduled("monthly", new Date("2026-10-01T03:59:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(lastScheduled("weekly", new Date("2026-09-26T10:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-09-21T04:00:00.000Z");
    expect(lastScheduled("daily", new Date("2026-09-26T02:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-09-25T04:00:00.000Z");

    await platform.calculations.change(companyId, "supplier_ranking", { schedule: "monthly" });
    // Made (and run) today: the month's run already happened before it existed, so nothing now.
    expect(await platform.calculations.runDue(new Date())).toEqual([]);
    const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 4, 5));
    const ran = await platform.calculations.runDue(next);
    expect(ran.map((r) => [r.trigger, r.by, r.status])).toEqual([["schedule", "On its schedule", "succeeded"]]);
    expect(await platform.calculations.runDue(new Date(next.getTime() + 60_000))).toEqual([]);
    await platform.calculations.archive(companyId, "supplier_ranking");
    expect(await platform.calculations.runDue(new Date(next.getTime() + 40 * 86_400_000))).toEqual([]);
    await platform.calculations.archive(companyId, "supplier_ranking", false);
  });

  it("shows its latest result in an app, and an app naming no calculation is refused", async () => {
    const app = await platform.apps.create(
      companyId,
      { name: "Quality", pages: [{ key: "ranking", title: "Ranking", blocks: [{ type: "result", calculation: "supplier_ranking" }] }] },
      by,
    );
    expect(app.calculations).toEqual(["supplier_ranking"]);
    await expect(
      platform.apps.create(companyId, { name: "Other", pages: [{ key: "p", title: "P", blocks: [{ type: "result", calculation: "nothing_here" }] }] }, by),
    ).rejects.toThrow(/There is no calculation "nothing_here"/);
  });
});
