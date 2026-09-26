import { describe, expect, it } from "vitest";
import { runCalculation } from "../src/index.ts";

/** The sandbox runs a rule's code on the rows it is given, and nothing else. */

const complaints = [
  { supplier: "Akın Metal", cost: 1200 },
  { supplier: "Demir Döküm", cost: 350.5 },
  { supplier: "Akın Metal", cost: 800 },
];

describe("the calculation sandbox", () => {
  it("runs the code on the rows and returns its result as data, with what it logged", async () => {
    const result = await runCalculation(
      `const totals = {};
       for (const row of tables.complaints) totals[row.supplier] = (totals[row.supplier] ?? 0) + row.cost;
       console.log("suppliers", Object.keys(totals).length);
       return Object.entries(totals).map(([supplier, total]) => ({ supplier, total })).sort((a, b) => b.total - a.total);`,
      { tables: { complaints } },
    );
    expect(result).toMatchObject({
      ok: true,
      value: [
        { supplier: "Akın Metal", total: 2000 },
        { supplier: "Demir Döküm", total: 350.5 },
      ],
      logs: ["suppliers 2"],
    });
  });

  it("gives the code only its rows and values: nothing of the server", async () => {
    const result = await runCalculation(
      `return [typeof fetch, typeof require, typeof process, typeof XMLHttpRequest, typeof setTimeout, typeof globalThis.std, typeof globalThis.os, params.month];`,
      { tables: {}, params: { month: "2026-09" } },
    );
    expect(result).toMatchObject({ ok: true, value: ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "2026-09"] });
  });

  it("stops code that runs too long, uses too much memory or returns too much", async () => {
    expect(await runCalculation("while (true) {}", { tables: {} }, { timeoutMs: 300 })).toMatchObject({ ok: false, kind: "timeout" });
    expect(
      await runCalculation("const a = []; for (;;) a.push('x'.repeat(100000) + a.length);", { tables: {} }, { memoryBytes: 24 * 1024 * 1024, timeoutMs: 5000 }),
    ).toMatchObject({
      ok: false,
      kind: "memory",
    });
    expect(await runCalculation("return 'x'.repeat(2000);", { tables: {} }, { outputBytes: 1000 })).toMatchObject({ ok: false, kind: "output" });
  });

  it("says what went wrong, and where", async () => {
    const result = await runCalculation("const x = 1;\nreturn tables.missing.length;", { tables: {} });
    expect(result).toMatchObject({ ok: false, kind: "error" });
    expect(result.ok ? "" : result.error).toMatch(/TypeError: .*(undefined|missing).*\(line 2\)/);
    expect(await runCalculation("return (;", { tables: {} })).toMatchObject({ ok: false, kind: "error", error: expect.stringMatching(/SyntaxError/) });
  });

  it("keeps each run apart", async () => {
    await runCalculation("globalThis.leak = 42; return 1;", { tables: {} });
    expect(await runCalculation("return typeof globalThis.leak;", { tables: {} })).toMatchObject({ ok: true, value: "undefined" });
  });
});
