import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedder, ScriptedLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { Platform } from "@enterprise-brain/runtime";
import { BuilderService } from "../src/index.ts";

/**
 * Drives the builder through the Claude code paths with a scripted LLM, verifying
 * that every structured-output schema is honoured and its results are applied.
 */
const schemaEnum = (request: StructuredRequest, path: string[]): string[] => {
  let node: any = request.schema;
  for (const key of path) node = node?.[key];
  return (node?.enum ?? []) as string[];
};

/** For the round's choice questions (as listed in the interpret-reply prompt): the recommended option, else the last one. */
const optionsByNode = (request: StructuredRequest): Map<string, string[]> => {
  const content = request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  const json = content.match(/Questions:\n(\[[\s\S]*?\n\])\n/)?.[1];
  const questions = json ? (JSON.parse(json) as { nodeId: string; options?: { value: string }[]; recommended?: unknown }[]) : [];
  return new Map(
    questions.map((q) => {
      const values = (q.options ?? []).map((o) => o.value);
      return [q.nodeId, values.includes(String(q.recommended)) ? [String(q.recommended)] : values];
    }),
  );
};

const llm = new ScriptedLlm({
  "builder.discover": {
    structured: (request) => {
      const templates = schemaEnum(request, ["properties", "templateId"]);
      return {
        archetype: "document-processing",
        templateId: templates.includes("hr.cv-screener") ? "hr.cv-screener" : "none",
        agentName: "CV Screener",
        department: "hr",
        language: "en",
        goal: "Score incoming CVs against open positions and shortlist the best candidates.",
        prefilled: [
          { nodeId: "inputs.channels", values: ["email", "upload"], confidence: 0.9, quote: "by email and through our careers page" },
          { nodeId: "inputs.mailbox", values: ["careers@acme.com.tr"], confidence: 0.95, quote: "careers@acme.com.tr" },
        ],
        extraQuestions: [
          {
            id: "internal_candidates",
            section: "processing",
            title: "Internal candidates",
            question: "Should internal applicants be flagged separately?",
            why: "Internal mobility policies often give them priority.",
            owner: "requester",
            recommendedText: "Yes, flag them",
          },
        ],
        rationale: "The request is CV screening; the catalog CV screener fits.",
      };
    },
  },
  "builder.phrase-round": {
    structured: (request) => {
      const ids = schemaEnum(request, ["properties", "questions", "items", "properties", "nodeId"]);
      return {
        intro: "Great — a few questions to shape the CV Screener.",
        questions: ids.map((nodeId) => ({
          nodeId,
          title: `Phrased ${nodeId}`,
          question: `Tailored question for ${nodeId}?`,
          why: "Because it matters.",
          recommendedValues: [],
          recommendationText: "Recommended: go with the default",
        })),
      };
    },
  },
  "builder.interpret-reply": {
    structured: (request) => {
      const ids = schemaEnum(request, ["properties", "answers", "items", "properties", "nodeId"]);
      const options = optionsByNode(request);
      return {
        answers: ids.map((nodeId) =>
          nodeId.startsWith("integration.") || nodeId.startsWith("governance.retention") || nodeId.startsWith("governance.legal")
            ? { nodeId, action: "delegate", values: [], delegateTo: nodeId.startsWith("integration.") ? "it" : "dpo" }
            : nodeId === "outputs.destination"
              ? { nodeId, action: "answer", values: ["screen"], delegateTo: null }
              : options.get(nodeId)?.length
                ? { nodeId, action: "answer", values: [options.get(nodeId)!.at(-1)!], delegateTo: null }
                : { nodeId, action: "answer", values: [`Answer for ${nodeId}`], delegateTo: null },
        ),
        changes: [],
        note: "Hiring manager wants a weekly summary.",
      };
    },
  },
  "builder.analyze-samples": { structured: () => ({ fields: ["Full name", "Email", "Skills"], observations: "Mixed English and Turkish CVs." }) },
  "builder.synthesize": {
    structured: () => ({
      name: "CV Screener",
      summary: "Scores CVs against the open position.",
      instructions: "# CV Screener\nYou screen CVs fairly. Never use protected characteristics.",
      extractionFields: [
        { key: "full_name", label: "Full name", type: "string", description: "Candidate name", required: true },
        { key: "skills", label: "Skills", type: "list", description: "Skills", required: false },
      ],
      outputFields: [],
      criteria: [
        { id: "nodejs", label: "Node.js experience", description: "", kind: "must", weight: 2, keywords: ["node.js"] },
        { id: "english", label: "English B2+", description: "", kind: "nice", weight: 1, keywords: ["english"] },
      ],
      categories: [],
      passScore: 70,
    }),
  },
  "builder.refine": {
    structured: (request) => {
      const content = request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const definition = JSON.parse(content.match(/<definition>\n([\s\S]*?)\n<\/definition>/)![1]!);
      const index = definition.workflow.findIndex((s: { type: string }) => s.type === "llm.evaluate");
      if (content.includes("rename the app")) return { operations: [{ op: "replace", path: "/slug", valueJson: '"new-slug"' }], explanation: "Renamed." };
      return {
        operations: [{ op: "replace", path: `/workflow/${index}/criteria/1/kind`, valueJson: '"must"' }],
        explanation: "English is now a must-have.",
      };
    },
  },
  "runtime.extract": { structured: () => ({ full_name: "Deniz Kaya", skills: ["Node.js", "TypeScript"] }) },
  "runtime.evaluate": {
    structured: () => ({
      criteria: [
        { id: "nodejs", met: "yes", score: 100, evidence: "8 years of Node.js" },
        { id: "english", met: "yes", score: 90, evidence: "English C1" },
      ],
      summary: "Strong backend candidate.",
    }),
  },
  "runtime.": { complete: () => "Generated text", structured: () => ({}) },
  "documents.ocr": { complete: () => "OCR text" },
});

let platform: Platform;
let builder: BuilderService;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-builder-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  builder = new BuilderService(platform, { publicBaseUrl: "http://brain.test" });
});
afterAll(async () => {
  await platform?.close();
});

describe("Agent Builder with Claude (scripted)", () => {
  it("runs discovery, phrased rounds, interpretation, delegation, synthesis and tests", async () => {
    let view = await builder.start(companyId, {
      description: "We get CVs by email at careers@acme.com.tr and through our careers page; score them against the open position.",
      requesterName: "Ayşe",
      requesterRole: "HR Manager",
    });
    expect(view.session.templateId).toBe("hr.cv-screener");
    expect(view.tree.nodes.some((n) => n.id === "custom.internal_candidates")).toBe(true);
    expect(view.tree.states["inputs.mailbox"]?.status).toBe("answered");
    expect(view.currentRound?.questions[0]?.question).toMatch(/^Tailored question/);

    for (let i = 0; i < 12 && view.session.status === "interviewing"; i++) {
      view = await builder.reply(companyId, view.session.id, { text: "Here are my answers." });
    }
    expect(view.requests.map((r) => r.role).sort()).toEqual(["dpo", "it"]);
    expect(["awaiting-stakeholders", "confirming"]).toContain(view.session.status);
    if (view.session.status === "awaiting-stakeholders") view = await builder.proceedWithAssumptions(companyId, view.session.id);
    for (let i = 0; i < 6 && view.session.status === "interviewing"; i++) {
      view = await builder.reply(companyId, view.session.id, { text: "More answers." });
    }
    expect(view.session.status).toBe("confirming");

    view = await builder.confirm(companyId, view.session.id);
    expect(view.session.status).toBe("testing");
    const agent = await platform.agents.get(companyId, view.agent!.id);
    expect(agent.definition.instructions).toContain("You screen CVs fairly");
    const evaluate = agent.definition.workflow.find((s) => s.type === "llm.evaluate");
    expect(evaluate && "criteria" in evaluate ? evaluate.criteria.map((c) => c.id) : []).toEqual(["nodejs", "english"]);
    expect(llm.calls.some((c) => c.purpose === "builder.synthesize")).toBe(true);

    // After testing, plain-language changes become a new version (JSON Patch: only what was asked changes).
    view = await builder.reply(companyId, view.session.id, { text: "Make English a must-have" });
    const refined = await platform.agents.get(companyId, view.agent!.id);
    expect(refined.row.version).toBe(agent.row.version + 1);
    const refinedEvaluate = refined.definition.workflow.find((s) => s.type === "llm.evaluate");
    expect(refinedEvaluate && "criteria" in refinedEvaluate ? refinedEvaluate.criteria.map((c) => c.kind) : []).toEqual(["must", "must"]);
    expect(refined.definition.instructions).toBe(agent.definition.instructions);
    expect(view.messages.some((m) => m.content.startsWith("English is now a must-have."))).toBe(true);

    view = await builder.reply(companyId, view.session.id, { text: "Please rename the app" });
    expect(view.messages.at(-1)?.content).toMatch(/couldn't apply that change: the agent's address \(slug\) can't be changed/);
    expect((await platform.agents.get(companyId, view.agent!.id)).row.version).toBe(refined.row.version);
  });
});
