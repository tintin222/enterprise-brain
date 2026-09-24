import { describe, expect, it } from "vitest";
import { fieldsToJsonSchema, type FieldSpec } from "../src/fields.ts";
import { AgentDefinition } from "../src/agent.ts";
import { slugify } from "../src/util.ts";

const fields: FieldSpec[] = [
  { key: "full_name", type: "string", required: true },
  { key: "email", type: "email" },
  { key: "years_experience", type: "number" },
  { key: "seniority", type: "select", options: [{ value: "junior" }, { value: "senior" }] },
  { key: "skills", type: "list", itemType: "string" },
  { key: "roles", type: "list", fields: [{ key: "company", type: "string", required: true }, { key: "title", type: "string" }] },
];

describe("fieldsToJsonSchema", () => {
  it("produces validation schemas", () => {
    const schema = fieldsToJsonSchema(fields);
    expect(schema.required).toEqual(["full_name"]);
    expect(schema.properties?.email).toMatchObject({ type: "string", format: "email" });
    expect(schema.properties?.roles?.items?.required).toEqual(["company"]);
  });

  it("produces structured-output schemas where optional fields are nullable", () => {
    const schema = fieldsToJsonSchema(fields, { forLlm: true });
    expect(schema.required).toEqual(fields.map((f) => f.key));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.email).toMatchObject({ type: ["string", "null"] });
    expect(schema.properties?.email?.format).toBeUndefined();
    expect(schema.properties?.seniority?.enum).toEqual(["junior", "senior", null]);
    expect(schema.properties?.full_name?.type).toBe("string");
  });
});

describe("AgentDefinition", () => {
  it("applies defaults", () => {
    const def = AgentDefinition.parse({
      slug: "cv-screener",
      name: "CV Screener",
      summary: "Screens CVs",
      archetype: "document-processing",
      instructions: "Screen CVs.",
    });
    expect(def.triggers).toEqual([{ type: "manual" }]);
    expect(def.guardrails.approvalRequiredFor).toContain("mail.send");
    expect(def.workflow).toEqual([]);
  });
});

describe("slugify", () => {
  it("handles Turkish characters", () => {
    expect(slugify("Özgeçmiş Analiz Ajanı")).toBe("ozgecmis-analiz-ajani");
    expect(slugify("  CV Screener (HR) ")).toBe("cv-screener-hr");
  });
});
