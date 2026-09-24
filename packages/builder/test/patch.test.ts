import { describe, expect, it } from "vitest";
import { applyJsonPatch } from "../src/patch.ts";

const doc = () => ({ name: "CV Screener", workflow: [{ id: "a", criteria: [{ id: "x", kind: "nice" }] }], guardrails: { approvalRequiredFor: ["mail.send"] } });

describe("applyJsonPatch", () => {
  it("replaces, adds (including appends) and removes without touching the original", () => {
    const original = doc();
    const patched = applyJsonPatch(original, [
      { op: "replace", path: "/workflow/0/criteria/0/kind", value: "must" },
      { op: "add", path: "/guardrails/approvalRequiredFor/-", value: "connector:write" },
      { op: "add", path: "/workflow/0/criteria/0", value: { id: "w", kind: "knockout" } },
      { op: "add", path: "/summary", value: "Scores CVs" },
      { op: "remove", path: "/name" },
    ]);
    expect(patched.workflow[0]!.criteria).toEqual([{ id: "w", kind: "knockout" }, { id: "x", kind: "must" }]);
    expect(patched.guardrails.approvalRequiredFor).toEqual(["mail.send", "connector:write"]);
    expect(patched).toMatchObject({ summary: "Scores CVs" });
    expect("name" in patched).toBe(false);
    expect(original.workflow[0]!.criteria[0]!.kind).toBe("nice");
  });

  it("rejects missing paths, bad indexes and prototype keys", () => {
    expect(() => applyJsonPatch(doc(), [{ op: "replace", path: "/workflow/3/id", value: "b" }])).toThrow(/does not exist/);
    expect(() => applyJsonPatch(doc(), [{ op: "replace", path: "/missing", value: 1 }])).toThrow(/does not exist/);
    expect(() => applyJsonPatch(doc(), [{ op: "remove", path: "/workflow/x" }])).toThrow(/not an array index/);
    expect(() => applyJsonPatch(doc(), [{ op: "add", path: "/__proto__/polluted", value: true }])).toThrow(/not allowed/);
    expect(() => applyJsonPatch(doc(), [{ op: "replace", path: "", value: {} }])).toThrow(/JSON Pointer/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
