import { afterEach, describe, expect, it } from "vitest";
import { fillDemoBrain } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The demo company's brain fills itself as the server starts: from every source the first time, and
 * later from the sources a newer version brings, so their places aren't empty. A company's own brain
 * never gets made-up data, and a source a person turned off stays off.
 */

/** The sources the version before the data catalog didn't have. */
const NEWER = ["catalog", "bi"];

describe("the demo company's brain", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("is filled from every source the first time, and only then", async () => {
    t = await createTestApp({ seed: false });
    const { platform, companyId } = t;
    expect(await fillDemoBrain(platform, companyId, { demo: true })).toEqual(platform.brainSources.definitions.map((d) => d.key));
    const counts = await platform.brain.counts(companyId);
    for (const kind of ["person", "process", "system", "database", "data_table", "dataset", "report"]) expect(counts[kind], kind).toBeGreaterThan(0);
    const sources = await platform.brainSources.list(companyId);
    expect(sources.filter((s) => s.status !== "connected" || s.syncs !== 1 || s.lastError).map((s) => s.key)).toEqual([]);
    // The next start finds nothing new and reads nothing.
    expect(await fillDemoBrain(platform, companyId)).toEqual([]);
    expect((await platform.brainSources.list(companyId)).filter((s) => s.syncs !== 1).map((s) => s.key)).toEqual([]);
  }, 120_000);

  it("reads the sources a newer version brings, and leaves off what a person turned off", async () => {
    t = await createTestApp({ seed: false });
    const { platform, companyId } = t;
    // Filled before the data catalog and Power BI came; then someone turned Slack off.
    for (const { key } of platform.brainSources.definitions) if (!NEWER.includes(key)) await platform.brainSources.sync(companyId, key);
    await platform.brainSources.disconnect(companyId, "slack");
    const before = await platform.brain.counts(companyId);
    expect([before.data_table, before.dataset, before.report]).toEqual([undefined, undefined, undefined]);

    expect(await fillDemoBrain(platform, companyId)).toEqual(NEWER);
    const after = await platform.brain.counts(companyId);
    for (const kind of ["data_table", "dataset", "report"]) expect(after[kind], kind).toBeGreaterThan(0);
    const sources = Object.fromEntries((await platform.brainSources.list(companyId)).map((s) => [s.key, s]));
    expect(sources.catalog).toMatchObject({ status: "connected", syncs: 1, lastError: null });
    expect(sources.bi).toMatchObject({ status: "connected", syncs: 1, lastError: null });
    expect(sources.slack).toMatchObject({ status: "off", syncs: 1 });
    expect(sources.hr).toMatchObject({ status: "connected", syncs: 2 });
    // Each report finds what it is built on, and each documented table its database.
    for (const report of await platform.brain.list(companyId, { kind: "report" })) {
      const view = await platform.brain.get(companyId, report.id);
      expect(
        view.links.some((l) => l.relation === "built_on"),
        report.name,
      ).toBe(true);
    }
    for (const table of await platform.brain.list(companyId, { kind: "data_table" })) {
      const view = await platform.brain.get(companyId, table.id);
      expect(
        view.links.some((l) => l.relation === "table_of"),
        table.name,
      ).toBe(true);
    }
    expect(await fillDemoBrain(platform, companyId)).toEqual([]);
  }, 120_000);

  it("gives a company's own brain no made-up data", async () => {
    t = await createTestApp({ seed: false });
    expect(await fillDemoBrain(t.platform, t.companyId)).toEqual([]);
    expect(await t.platform.brain.counts(t.companyId)).toEqual({});
    expect((await t.platform.brainSources.list(t.companyId)).filter((s) => s.status !== "new").map((s) => s.key)).toEqual([]);
  }, 60_000);
});
