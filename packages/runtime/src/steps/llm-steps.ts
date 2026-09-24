import {
  fieldsToJsonSchema,
  renderTemplate,
  resolveTemplate,
  stringify,
  type WorkflowStep,
} from "@enterprise-brain/core";
import { heuristicExtract } from "@enterprise-brain/documents";
import type { LlmUsage } from "@enterprise-brain/llm";
import {
  aggregateEvaluation,
  offlineClassify,
  offlineEvaluate,
  type CriterionAssessment,
  type Met,
} from "../evaluation.ts";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";
import type { ToolDeps } from "../tools.ts";

type Step<T extends WorkflowStep["type"]> = Extract<WorkflowStep, { type: T }>;

const MAX_SOURCE_CHARS = 120_000;

function sourceText(value: unknown): string {
  const text = typeof value === "string" ? value : stringify(value);
  return text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}\n…(truncated)` : text;
}

function systemPrompt(scope: ExecutionScope): string {
  return scope.definition.instructions;
}

export async function runLlmExtract(step: Step<"llm.extract">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const text = sourceText(resolveTemplate(step.from, scope.context));
  if (!deps.llm.available) {
    return { kind: "done", result: heuristicExtract(text, step.fields), message: "Extracted with offline heuristics (no LLM configured)" };
  }
  const instructions = step.instructions ? renderTemplate(step.instructions, scope.context) : "";
  const { data, usage } = await deps.llm.structured<Record<string, unknown>>({
    purpose: `runtime.extract:${scope.definition.slug}.${step.id}`,
    system: systemPrompt(scope),
    schema: fieldsToJsonSchema(step.fields, { forLlm: true }),
    effort: "low",
    messages: [
      {
        role: "user",
        content: [
          "Extract the requested fields from the source below.",
          "Use null when a value is not present in the source. Never invent values; copy names, numbers and dates exactly. Dates as YYYY-MM-DD.",
          instructions,
          "<source>",
          text,
          "</source>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return { kind: "done", result: data, usage };
}

export async function runLlmClassify(step: Step<"llm.classify">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const text = sourceText(resolveTemplate(step.from, scope.context));
  if (!deps.llm.available) {
    return { kind: "done", result: offlineClassify(text, step.categories, step.multi), message: "Classified with offline keyword rules" };
  }
  const values = step.categories.map((c) => c.value);
  const schema = {
    type: "object",
    properties: {
      category: { type: "string", enum: values },
      ...(step.multi ? { categories: { type: "array", items: { type: "string", enum: values } } } : {}),
      confidence: { type: "number", description: "0 to 1" },
      reason: { type: "string" },
    },
    required: ["category", ...(step.multi ? ["categories"] : []), "confidence", "reason"],
    additionalProperties: false,
  };
  const categoryList = step.categories
    .map((c) => `- ${c.value}${c.label ? ` (${c.label})` : ""}${c.description ? `: ${c.description}` : ""}`)
    .join("\n");
  const { data, usage } = await deps.llm.structured<Record<string, unknown>>({
    purpose: `runtime.classify:${scope.definition.slug}.${step.id}`,
    system: systemPrompt(scope),
    schema,
    effort: "low",
    messages: [
      {
        role: "user",
        content: [
          `Classify the item below into ${step.multi ? "all applicable categories (and name the primary one as `category`)" : "exactly one category"}.`,
          "Categories:",
          categoryList,
          step.instructions ? renderTemplate(step.instructions, scope.context) : "",
          "<item>",
          text,
          "</item>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return { kind: "done", result: data, usage };
}

interface LlmEvaluation {
  criteria: { id: string; met: Met; score: number; evidence: string }[];
  summary: string;
}

export async function runLlmEvaluate(step: Step<"llm.evaluate">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const subject = sourceText(resolveTemplate(step.from, scope.context));
  const context = step.context ? sourceText(resolveTemplate(step.context, scope.context)) : "";
  const passScore = step.passScore ?? 70;
  if (!deps.llm.available) {
    return {
      kind: "done",
      result: offlineEvaluate(`${subject}`, step.criteria, passScore),
      message: "Evaluated with offline keyword evidence (no LLM configured) — review recommended",
    };
  }
  const schema = {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: step.criteria.map((c) => c.id) },
            met: { type: "string", enum: ["yes", "partial", "no", "unknown"] },
            score: { type: "number", description: "0-100 degree to which the criterion is met" },
            evidence: { type: "string", description: "Short quote or fact from the subject supporting the judgement" },
          },
          required: ["id", "met", "score", "evidence"],
          additionalProperties: false,
        },
      },
      summary: { type: "string", description: "2-4 sentence overall assessment for a human reviewer" },
    },
    required: ["criteria", "summary"],
    additionalProperties: false,
  };
  const criteriaList = step.criteria
    .map((c) => `- ${c.id} [${c.kind}, weight ${c.weight}]: ${c.label}${c.description ? ` — ${c.description}` : ""}${c.blockers?.length ? ` (not met if the subject says e.g.: ${c.blockers.join("; ")})` : ""}`)
    .join("\n");
  const { data, usage } = await deps.llm.structured<LlmEvaluation>({
    purpose: `runtime.evaluate:${scope.definition.slug}.${step.id}`,
    system: systemPrompt(scope),
    schema,
    effort: "medium",
    messages: [
      {
        role: "user",
        content: [
          "Assess the subject against every criterion. Judge only on evidence in the subject; use met=\"unknown\" when the subject does not say.",
          "Ignore protected characteristics (age, gender, ethnicity, religion, marital status, photo) — they must not influence any judgement.",
          step.instructions ? renderTemplate(step.instructions, scope.context) : "",
          "Criteria:",
          criteriaList,
          context ? `<context>\n${context}\n</context>` : "",
          "<subject>",
          subject,
          "</subject>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  const byId = new Map(data.criteria.map((c) => [c.id, c]));
  const assessments: CriterionAssessment[] = step.criteria.map((criterion) => {
    const judged = byId.get(criterion.id);
    return {
      id: criterion.id,
      label: criterion.label,
      kind: criterion.kind,
      weight: criterion.weight,
      met: judged?.met ?? "unknown",
      score: judged?.score ?? 0,
      evidence: judged?.evidence ?? "Not assessed",
    };
  });
  return { kind: "done", result: aggregateEvaluation(assessments, passScore, data.summary), usage };
}

export async function runLlmGenerate(step: Step<"llm.generate">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  if (!deps.llm.available) {
    const text = step.fallback ? renderTemplate(step.fallback, scope.context) : "";
    return { kind: "done", result: { text, offline: true }, message: "Generated from the offline template (no LLM configured)" };
  }
  const prompt = renderTemplate(step.prompt, scope.context);
  const format =
    step.format === "html" ? "Respond with HTML only." : step.format === "markdown" ? "Respond in Markdown." : "Respond in plain text.";
  const { text, usage } = await deps.llm.complete({
    purpose: `runtime.generate:${scope.definition.slug}.${step.id}`,
    system: systemPrompt(scope),
    effort: "medium",
    onText: scope.onText,
    messages: [{ role: "user", content: `${prompt}\n\n${format}` }],
  });
  return { kind: "done", result: { text: text.trim() }, usage };
}

export function mergeUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}
