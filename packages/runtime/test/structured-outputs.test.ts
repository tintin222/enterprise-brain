import { describe, expect, it } from "vitest";
import { loadCatalog } from "@enterprise-brain/catalog";
import { fieldsToJsonSchema } from "@enterprise-brain/core";
import { structuredOutputProblems, toStructuredOutputSchema } from "@enterprise-brain/llm";

/**
 * What the ready-made AI employees ask Claude to fill in (their extract steps) must be schemas Claude
 * accepts as they are sent: an optional choice used to be rejected ("Enum value 'low' does not match
 * declared type"), and a schema may use at most 16 unions.
 */
describe("the catalog's structured outputs", () => {
  it("are schemas Claude accepts, as the client sends them", async () => {
    const catalog = await loadCatalog();
    const problems: string[] = [];
    let extracts = 0;
    for (const agent of catalog.agents) {
      for (const step of agent.workflow) {
        if (step.type !== "llm.extract") continue;
        extracts++;
        const sent = toStructuredOutputSchema(fieldsToJsonSchema(step.fields, { forLlm: true }));
        for (const problem of structuredOutputProblems(sent)) problems.push(`${agent.slug} · ${step.id}: ${problem}`);
      }
    }
    expect(extracts).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });
});
