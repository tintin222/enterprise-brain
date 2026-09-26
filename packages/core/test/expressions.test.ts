import { describe, expect, it } from "vitest";
import { evaluateCondition, evaluateExpression, renderTemplate, resolveTemplate } from "../src/expressions.ts";

const ctx = {
  input: { name: "Ayşe", role: "engineer", tags: ["react", "node"] },
  steps: {
    evaluate: { score: 82, verdict: "shortlist" },
    classify: { category: "invoice", confidence: 0.91 },
    items: [{ name: "first" }, { name: "second" }],
  },
};

describe("expressions", () => {
  it("evaluates comparisons and boolean logic", () => {
    expect(evaluateCondition("steps.evaluate.score >= 70", ctx)).toBe(true);
    expect(evaluateCondition("steps.evaluate.score >= 70 && input.role == 'intern'", ctx)).toBe(false);
    expect(evaluateCondition("steps.evaluate.score > 90 || steps.classify.category == 'INVOICE'", ctx)).toBe(true);
    expect(evaluateCondition("not (steps.classify.confidence < 0.5)", ctx)).toBe(true);
    expect(evaluateCondition("'react' in input.tags", ctx)).toBe(true);
    expect(evaluateCondition("input.tags contains 'python'", ctx)).toBe(false);
    expect(evaluateCondition("steps.classify.category in ['invoice', 'receipt']", ctx)).toBe(true);
    expect(evaluateCondition(undefined, ctx)).toBe(true);
    expect(evaluateCondition("{{ steps.evaluate.score < 50 }}", ctx)).toBe(false);
  });

  it("supports arithmetic and missing paths", () => {
    expect(evaluateExpression("steps.evaluate.score / 10 + 1", ctx)).toBe(9.2);
    expect(evaluateExpression("steps.missing.value", ctx)).toBeUndefined();
    expect(evaluateCondition("steps.missing.value", ctx)).toBe(false);
  });

  it("rejects unsafe input", () => {
    expect(() => evaluateExpression("constructor.constructor('x')()", ctx)).toThrow();
    expect(() => evaluateExpression("a; b", ctx)).toThrow();
  });
});

describe("templates", () => {
  it("returns raw values for single expressions", () => {
    expect(resolveTemplate("{{ steps.evaluate.score }}", ctx)).toBe(82);
    expect(resolveTemplate("{{ steps.items }}", ctx)).toEqual(ctx.steps.items);
  });

  it("interpolates strings with filters", () => {
    expect(renderTemplate("Hi {{ input.name }}, score {{ steps.evaluate.score }}/100", ctx)).toBe("Hi Ayşe, score 82/100");
    expect(renderTemplate("{{ input.tags | join:' + ' }}", ctx)).toBe("react + node");
    expect(renderTemplate("{{ input.nickname | default:'n/a' }}", ctx)).toBe("n/a");
    expect(renderTemplate("{{ input.name | upper }}", ctx)).toBe("AYŞE");
    expect(renderTemplate("{{ steps.items | length }}", ctx)).toBe("2");
    expect(renderTemplate("{{ steps.items.1.name }}", ctx)).toBe("second");
    expect(renderTemplate("{{ steps.classify.confidence > 0.9 || steps.evaluate.score > 99 }}", ctx)).toBe("true");
    expect(resolveTemplate("{{ input.cv || input.tags }}", ctx)).toEqual(["react", "node"]);
    expect(resolveTemplate("{{ input.name && input.role }}", ctx)).toBe("engineer");
    expect(renderTemplate("{{ input.nickname | default: input.name }}", ctx)).toBe("Ayşe");
  });

  it("writes amounts as people read them", () => {
    const amounts = { invoice: { total: 965664, net: "804720.5", currency: "TRY" } };
    expect(renderTemplate("{{ invoice.total | money:invoice.currency }}", amounts)).toBe("965,664.00 TRY");
    expect(renderTemplate("{{ invoice.net | money }}", amounts)).toBe("804,720.50");
    expect(renderTemplate("{{ invoice.missing | money:'TRY' }}", amounts)).toBe("");
    // The day of a date-time: UTC, or a time zone's.
    const received = { at: "2026-09-30T22:30:00.000Z", day: "2026-09-30" };
    expect(renderTemplate("{{ at | date }}", received)).toBe("2026-09-30");
    expect(renderTemplate("{{ at | date:'Europe/Istanbul' }}", received)).toBe("2026-10-01");
    expect(renderTemplate("{{ day | date:'Europe/Istanbul' }}", received)).toBe("2026-09-30");
  });

  it("resolves nested objects", () => {
    expect(resolveTemplate({ to: "{{ input.name }}", meta: ["{{ steps.evaluate.verdict }}", 1] }, ctx)).toEqual({
      to: "Ayşe",
      meta: ["shortlist", 1],
    });
  });
});
