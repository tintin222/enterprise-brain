import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { AppError, Platform } from "../src/index.ts";

/** Apps on tables: every block is checked against its table, and charts and numbers come from the records. */

let platform: Platform;
let companyId: string;
const by = { actor: "Selin Çelik <selin.celik@acme.com.tr>" };

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-apps-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.people.create(companyId, { email: "selin.celik@acme.com.tr", name: "Selin Çelik" });
  await platform.tables.create(
    companyId,
    {
      name: "Supplier complaints",
      fields: [
        { key: "problem", label: "Problem", type: "text", required: true },
        { key: "supplier", label: "Supplier", type: "text" },
        { key: "status", label: "Status", type: "choice", choices: ["Open", "In progress", "Closed"], default: "Open" },
        { key: "cost", label: "Cost", type: "money", currency: "TRY" },
        { key: "found_on", label: "Found on", type: "date" },
        { key: "owner", label: "Owner", type: "person" },
      ],
    },
    by.actor,
  );
  const rows: [string, string, string, number, string][] = [
    ["Cracked flange", "Akın Metal", "Open", 1200, "2026-08-14"],
    ["Late delivery", "Akın Metal", "Closed", 0, "2026-08-30"],
    ["Wrong paint", "Demir Döküm", "Open", 350.5, "2026-09-02"],
    ["Missing certificate", "Yıldız Plastik", "In progress", 0, "2026-09-10"],
    ["Bent frame", "Akın Metal", "Open", 800, "2026-09-21"],
  ];
  for (const [problem, supplier, status, cost, found_on] of rows) {
    await platform.tables.add(companyId, "supplier_complaints", { problem, supplier, status, cost, found_on, owner: "Selin Çelik" }, by);
  }
});
afterAll(async () => {
  await platform?.close();
});

describe("summaries for charts and numbers", () => {
  it("counts by a choice in the order of its list, adds up money, and groups dates by month", async () => {
    const byStatus = await platform.tables.summarize(companyId, "supplier_complaints", { groupBy: "status" });
    expect(byStatus).toEqual({
      total: 5,
      groups: [
        { key: "Open", label: "Open", value: 3 },
        { key: "In progress", label: "In progress", value: 1 },
        { key: "Closed", label: "Closed", value: 1 },
      ],
    });
    const cost = await platform.tables.summarize(companyId, "supplier_complaints", {
      groupBy: "supplier",
      measure: { of: "sum", field: "cost" },
      where: { status: "open" },
    });
    expect(cost.groups).toEqual([
      { key: "Akın Metal", label: "Akın Metal", value: 2000 },
      { key: "Demir Döküm", label: "Demir Döküm", value: 350.5 },
    ]);
    expect(cost.total).toBe(2350.5);
    const months = await platform.tables.summarize(companyId, "supplier_complaints", { groupBy: "found_on" });
    expect(months.groups.map((g) => [g.key, g.value])).toEqual([
      ["2026-08", 2],
      ["2026-09", 3],
    ]);
    const people = await platform.tables.summarize(companyId, "supplier_complaints", { groupBy: "owner" });
    expect(people.groups).toEqual([{ key: "selin.celik@acme.com.tr", label: "Selin Çelik", value: 5 }]);
    const top = await platform.tables.summarize(companyId, "supplier_complaints", { groupBy: "supplier", limit: 2 });
    expect(top.groups).toEqual([
      { key: "Akın Metal", label: "Akın Metal", value: 3 },
      { key: "__other__", label: "Other", value: 2 },
    ]);
    await expect(platform.tables.summarize(companyId, "supplier_complaints", { measure: { of: "sum", field: "problem" } })).rejects.toThrow(
      /name a number field/,
    );
  });
});

describe("apps", () => {
  const pages = [
    { key: "log", title: "Log a complaint", blocks: [{ type: "form" as const, table: "supplier_complaints", fields: ["problem", "supplier", "cost"] }] },
    {
      key: "open",
      title: "Open ones by supplier",
      blocks: [
        {
          type: "list" as const,
          table: "supplier_complaints",
          filter: { status: "open" },
          groupBy: "supplier",
          search: true,
          actions: [{ label: "Close", set: { status: "Closed" }, confirm: true }],
        },
      ],
    },
    {
      key: "overview",
      title: "Overview",
      blocks: [
        { type: "number" as const, title: "Open", table: "supplier_complaints", measure: { of: "count" as const }, filter: { status: "Open" } },
        { type: "chart" as const, table: "supplier_complaints", groupBy: "supplier", measure: { of: "sum" as const, field: "cost" }, kind: "bar" as const },
      ],
    },
  ];

  it("makes an app whose blocks fit their tables", async () => {
    const app = await platform.apps.create(companyId, { name: "Supplier complaints", pages }, by.actor);
    expect(app).toMatchObject({ key: "supplier_complaints", version: 1, tables: ["supplier_complaints"], agents: [], createdBy: "Selin Çelik" });
    const changed = await platform.apps.change(companyId, app.key, { pages: pages.slice(0, 2) });
    expect(changed.version).toBe(2);
    expect((await platform.apps.change(companyId, app.key, { name: "Complaints" })).version).toBe(2);
    expect((await platform.apps.list(companyId)).map((a) => a.name)).toEqual(["Complaints"]);
    await platform.apps.archive(companyId, app.key);
    expect(await platform.apps.list(companyId)).toEqual([]);
  });

  it("refuses an app that wouldn't work, saying what doesn't fit", async () => {
    const broken = [
      {
        key: "p",
        title: "Work",
        blocks: [
          { type: "board" as const, title: "Board", table: "supplier_complaints", groupBy: "supplier" },
          { type: "list" as const, title: "List", table: "supplier_complaints", fields: ["colour"], filter: { status: "Lost" } },
          { type: "number" as const, title: "Total", table: "supplier_complaints", measure: { of: "sum" as const, field: "problem" } },
          { type: "chart" as const, title: "Chart", table: "visitors", groupBy: "host", measure: { of: "count" as const }, kind: "bar" as const },
          { type: "button" as const, title: "Rank suppliers", agent: "supplier-ranker", ask: "Rank the suppliers" },
        ],
      },
    ];
    const error = await platform.apps.create(companyId, { name: "Broken", pages: broken }, by.actor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).problems).toEqual([
      'There is no AI employee "supplier-ranker" to give work to',
      "Work, Board: a board's columns are one of a list; Supplier is not",
      'Work, List: Supplier complaints has no field "colour" (shown)',
      'Work, List: filter: Status: one of "Open", "In progress", "Closed"',
      "Work, Total: Problem is not a number to add up",
      'Work, Chart: there is no table "visitors"',
    ]);
  });
});
