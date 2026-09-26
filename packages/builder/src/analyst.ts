import {
  Archetype,
  FieldType,
  RequirementSection,
  StakeholderRole,
  type AgentDefinition,
  type AgentTemplate,
  type Catalog,
  type RequirementNode,
  type RequirementNodeInput,
  type RoundQuestion,
  type SampleAnalysis,
} from "@enterprise-brain/core";
import { findAgent, searchCatalog } from "@enterprise-brain/catalog";
import { detectLanguage } from "@enterprise-brain/documents";
import type { LlmClient } from "@enterprise-brain/llm";
import type { Synthesis } from "./generate.ts";
import { parseRoundReply, type ParsedAnswer } from "./parse.ts";
import { applyJsonPatch, type PatchOperation } from "./patch.ts";
import { displayValue } from "./render.ts";

export const ANALYST_PERSONA = [
  "You are the Enterprise Brain Agent Builder: a senior business analyst who designs AI agents together with non-technical business users (HR managers, finance clerks, sales and service teams).",
  "You interview like an experienced analyst: how the work is done today, where inputs come from, how decisions are made, what the result is and what happens next, which systems are involved, what needs human approval, what personal data is involved and how success is measured.",
  "Facts are your job, decisions are the user's: never ask for something you can find yourself (from uploaded samples or configured systems), and never decide on the user's behalf — propose a recommended answer they can simply accept.",
  "When a question is really for another team (IT access, data protection, legal), say so and offer to prepare the request for them.",
  "Plain, warm, jargon-free language. Short questions. Always write in the user's language.",
].join("\n");

export interface Discovery {
  archetype: Archetype;
  template?: AgentTemplate;
  agentName: string;
  department?: string;
  language: string;
  prefilled: { nodeId: string; value: unknown; confidence: number; quote?: string }[];
  extraQuestions: RequirementNodeInput[];
  rationale: string;
}

/** Catalog search score a template needs before offline discovery adopts it (calibrated on the catalog's own match phrases). */
const OFFLINE_MATCH_MIN_SCORE = 12;

const ARCHETYPE_KEYWORDS: [Archetype, RegExp][] = [
  ["mail-triage", /(e-?mails?|e-?posta|inbox|gelen kutusu|mailbox|reply to (customers|emails)|yanıtla|classify (the )?mails?)/i],
  ["excel-automation", /(excel|spreadsheet|xlsx|csv|tablo|reconcil|mutabakat|pivot)/i],
  ["conversational", /(chat|assistant|asistan|questions? (from|about)|answer (employee|customer)|soru.*cevap|sohbet|faq)/i],
  ["search", /(search|find documents|arama|bul(ma)?)/i],
  ["report-generation", /(report|rapor|dashboard|kpi|weekly summary|haftalık)/i],
  ["document-processing", /(cv|resume|özgeçmiş|ozgecmis|invoice|fatura|contract|sözleşme|sozlesme|document|belge|pdf|ocr|scan|tara|irsaliye|receipt|fiş)/i],
  ["process-automation", /(process|süreç|surec|workflow|onay akışı|approval flow)/i],
];

function offlineArchetype(text: string, template?: AgentTemplate): Archetype {
  if (template) return template.archetype;
  return ARCHETYPE_KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "process-automation";
}

function offlinePrefill(description: string): Discovery["prefilled"] {
  const prefilled: Discovery["prefilled"] = [];
  const channels = new Set<string>();
  if (/(e-?mail|e-?posta|mail|inbox|mailbox)/i.test(description)) channels.add("email");
  if (/(upload|yükle|yukle|drag|sürükle)/i.test(description)) channels.add("upload");
  if (/(sap|erp|crm|hr system|ik sistemi|successfactors|workday|salesforce|hubspot|ats|system)/i.test(description)) channels.add("system");
  if (/(sharepoint|onedrive|shared folder|network drive|file share|s?ftp|ortak klasör|ağ sürücüsü|klasör)/i.test(description)) channels.add("shared-folder");
  if (/(website|web site|web sitesi|kariyer sayfası|careers page|web form)/i.test(description)) channels.add("web-form");
  if (channels.size) prefilled.push({ nodeId: "inputs.channels", value: [...channels], confidence: 0.6, quote: "from your description" });
  const mailbox = description.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
  if (mailbox) prefilled.push({ nodeId: "inputs.mailbox", value: mailbox, confidence: 0.95, quote: mailbox });
  return prefilled;
}

/**
 * The outcome a description asks for, without the preamble: "I'm the HR manager. … I want an agent that
 * reads each CV and …" -> "Reads each CV and …". Falls back to the whole description.
 */
export function goalFromDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const wish = /\b(?:i|we)(?:'d| would)?\s+(?:want|need|like)\s+(?:to have\s+)?(?:an?\s+)?(?:ai\s+)?(?:agent|assistant|bot|system|tool|something|way)?\s*(?:that|which|who|to)\s+(.{12,})/i;
  for (const sentence of sentences) {
    const match = sentence.match(wish);
    if (match?.[1]) return `${match[1][0]!.toUpperCase()}${match[1].slice(1)}`.replace(/[.!?]*$/, ".");
  }
  // Turkish: "… puanlayan bir ajan istiyorum." -> "… puanlayan bir ajan."
  const turkish = sentences.find((sentence) => /\s(istiyorum|istiyoruz|isterim|isteriz|lazım|gerekiyor)[.!]?$/i.test(sentence));
  if (turkish) return turkish.replace(/\s+(istiyorum|istiyoruz|isterim|isteriz|lazım|gerekiyor)[.!]?$/i, ".");
  return text;
}

function nameFromDescription(description: string, template?: AgentTemplate): string {
  if (template) return template.name;
  const words = description.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
  return words.length ? `${words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ")} Agent` : "New Agent";
}

const BASE_NODE_IDS = [
  "purpose.goal",
  "purpose.name",
  "purpose.out_of_scope",
  "users.primary",
  "inputs.channels",
  "inputs.mailbox",
  "inputs.system",
  "inputs.form",
  "processing.reference",
  "outputs.fields",
  "outputs.destination",
  "outputs.system",
  "actions.follow_up",
  "actions.approval",
  "governance.personal_data",
  "operations.volume",
  "operations.sla",
  "operations.language",
  "docs.types",
  "docs.criteria",
  "mail.categories",
  "mail.reply_policy",
  "chat.audience",
  "chat.sources",
  "excel.transformation",
  "process.steps",
];

export class Analyst {
  constructor(
    private readonly llm: LlmClient,
    private readonly catalog: Catalog,
  ) {}

  get online(): boolean {
    return this.llm.available;
  }

  async discover(input: { description: string; formDescription?: string; requesterRole?: string; department?: string }): Promise<Discovery> {
    const text = [input.description, input.formDescription].filter(Boolean).join("\n\n");
    const ranked = searchCatalog(this.catalog, text, { kinds: ["agent"], limit: 6 });
    const candidates = ranked.map((r) => findAgent(this.catalog, r.id)).filter((a): a is AgentTemplate => a !== undefined);
    const language = detectLanguage(text) ?? "en";
    // Offline there is no model to judge the fit: take the best template when it scores well and either
    // leads clearly or its runner-up is the same kind of agent (e.g. two mail-triage templates).
    const [first, second] = ranked;
    const clearLead = !second || first!.score >= second.score * 1.25 || first!.archetype === second.archetype;
    const offlineTemplate = first && first.score >= OFFLINE_MATCH_MIN_SCORE && clearLead ? candidates[0] : undefined;

    if (!this.llm.available) {
      return {
        archetype: offlineArchetype(text, offlineTemplate),
        template: offlineTemplate,
        agentName: nameFromDescription(input.description, offlineTemplate),
        department: offlineTemplate?.department ?? input.department,
        language,
        prefilled: [
          { nodeId: "purpose.goal", value: goalFromDescription(input.description), confidence: 0.9, quote: "your description" },
          ...offlinePrefill(text),
        ],
        extraQuestions: [],
        rationale: offlineTemplate
          ? `Matched the catalog template "${offlineTemplate.name}" (${offlineTemplate.department}).`
          : "No close catalog template; starting from the archetype blueprint.",
      };
    }

    const schema = {
      type: "object",
      properties: {
        archetype: { type: "string", enum: Archetype.options },
        templateId: { type: "string", enum: [...candidates.map((c) => c.id), "none"] },
        agentName: { type: "string" },
        department: { type: "string", enum: [...this.catalog.departments.map((d) => d.id), "other"] },
        language: { type: "string", description: "ISO 639-1 code of the user's language" },
        goal: { type: "string", description: "One or two sentences: the problem and what a good result looks like, in the user's language" },
        prefilled: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nodeId: { type: "string", enum: BASE_NODE_IDS },
              values: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
              quote: { type: "string" },
            },
            required: ["nodeId", "values", "confidence", "quote"],
            additionalProperties: false,
          },
        },
        extraQuestions: {
          type: "array",
          description: "0-4 questions specific to THIS request that the standard checklist would miss",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "snake_case id" },
              section: { type: "string", enum: RequirementSection.options },
              title: { type: "string" },
              question: { type: "string" },
              why: { type: "string" },
              owner: { type: "string", enum: StakeholderRole.options },
              recommendedText: { type: "string" },
            },
            required: ["id", "section", "title", "question", "why", "owner", "recommendedText"],
            additionalProperties: false,
          },
        },
        rationale: { type: "string" },
      },
      required: ["archetype", "templateId", "agentName", "department", "language", "goal", "prefilled", "extraQuestions", "rationale"],
      additionalProperties: false,
    };
    const candidateList = candidates
      .map((c) => `- ${c.id}: ${c.name} [${c.archetype}] — ${c.summary}`)
      .join("\n");
    const { data } = await this.llm.structured<{
      archetype: Archetype;
      templateId: string;
      agentName: string;
      department: string;
      language: string;
      goal: string;
      prefilled: { nodeId: string; values: string[]; confidence: number; quote: string }[];
      extraQuestions: { id: string; section: RequirementNodeInput["section"]; title: string; question: string; why: string; owner: StakeholderRole; recommendedText: string }[];
      rationale: string;
    }>({
      purpose: "builder.discover",
      system: ANALYST_PERSONA,
      effort: "medium",
      schema,
      messages: [
        {
          role: "user",
          content: [
            "A business user described an agent they want. Analyse the request:",
            "1. Pick the archetype and the closest catalog template (or none if nothing fits well).",
            "2. Prefill checklist answers ONLY where the description states them (values: option values such as email/upload/system/shared-folder/web-form/chat for inputs.channels; free text otherwise). Quote the words you relied on.",
            "3. Propose up to 4 extra questions specific to this request.",
            "",
            `Requester role: ${input.requesterRole ?? "unknown"}; department: ${input.department ?? "unknown"}`,
            "",
            "Catalog templates:",
            candidateList || "(none)",
            "",
            "<description>",
            input.description,
            "</description>",
            input.formDescription ? `<form_description>\n${input.formDescription}\n</form_description>` : "",
          ].join("\n"),
        },
      ],
    });
    const template = candidates.find((c) => c.id === data.templateId);
    const multiNodes = new Set(["inputs.channels", "outputs.destination", "outputs.fields", "docs.criteria", "mail.categories"]);
    return {
      archetype: data.archetype,
      template,
      agentName: data.agentName || nameFromDescription(input.description, template),
      department: data.department === "other" ? input.department : data.department,
      language: data.language || language,
      prefilled: [
        { nodeId: "purpose.goal", value: data.goal || input.description.trim(), confidence: 0.9, quote: "your description" },
        ...data.prefilled
          .filter((p) => p.values.length)
          .map((p) => ({ nodeId: p.nodeId, value: multiNodes.has(p.nodeId) ? p.values : p.values.join(", "), confidence: p.confidence, quote: p.quote })),
      ],
      extraQuestions: data.extraQuestions.map((q) => ({
        id: `custom.${q.id.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`,
        section: q.section,
        title: q.title,
        question: q.question,
        why: q.why,
        owner: q.owner,
        answerType: "text" as const,
        recommended: q.recommendedText || undefined,
        prerequisites: ["purpose.goal"],
        priority: 60,
      })),
      rationale: data.rationale,
    };
  }

  /** Phrase a round of frontier questions (with recommendations) for this user. */
  async phraseRound(context: {
    agentName: string;
    goal: string;
    language: string;
    known: string;
    nodes: RequirementNode[];
    roundNumber: number;
  }): Promise<{ intro: string; questions: RoundQuestion[] }> {
    const base = context.nodes.map(
      (node, i): RoundQuestion => ({
        number: i + 1,
        nodeId: node.id,
        title: node.title,
        question: node.question,
        why: node.why,
        answerType: node.answerType,
        options: node.options,
        recommended: node.recommended,
        recommendationText:
          node.recommended !== undefined && node.recommended !== ""
            ? `Recommended: ${displayValue({ options: node.options, answerType: node.answerType }, node.recommended)}${node.recommendationReason ? ` — ${node.recommendationReason}` : ""}`
            : undefined,
        owner: node.owner,
        delegable: node.delegable ?? node.owner !== "requester",
      }),
    );
    const defaultIntro =
      context.roundNumber === 1
        ? `Let's design **${context.agentName}** together. I'll ask a few questions at a time and suggest an answer for each — agree, change it, or say "I don't know" and I'll find out or ask the right person.`
        : `Thanks! Round ${context.roundNumber}: a few more questions that build on your answers.`;
    if (!this.llm.available) return { intro: defaultIntro, questions: base };

    const schema = {
      type: "object",
      properties: {
        intro: { type: "string" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nodeId: { type: "string", enum: context.nodes.map((n) => n.id) },
              title: { type: "string" },
              question: { type: "string" },
              why: { type: "string" },
              recommendedValues: { type: "array", items: { type: "string" }, description: "option values for choice questions, list items for list questions, one string for text" },
              recommendationText: { type: "string", description: "e.g. 'Recommended: … — because …' in the user's language" },
            },
            required: ["nodeId", "title", "question", "why", "recommendedValues", "recommendationText"],
            additionalProperties: false,
          },
        },
      },
      required: ["intro", "questions"],
      additionalProperties: false,
    };
    const nodesJson = JSON.stringify(
      context.nodes.map((n) => ({
        nodeId: n.id,
        title: n.title,
        question: n.question,
        why: n.why,
        answerType: n.answerType,
        options: n.options?.map((o) => ({ value: o.value, label: o.label })),
        defaultRecommendation: n.recommended,
      })),
      null,
      1,
    );
    const { data } = await this.llm.structured<{
      intro: string;
      questions: { nodeId: string; title: string; question: string; why: string; recommendedValues: string[]; recommendationText: string }[];
    }>({
      purpose: "builder.phrase-round",
      system: ANALYST_PERSONA,
      effort: "low",
      schema,
      messages: [
        {
          role: "user",
          content: [
            `We are designing "${context.agentName}". Goal: ${context.goal}`,
            `Write round ${context.roundNumber} of the interview in language "${context.language}".`,
            "Rephrase each question so it fits this specific agent and what we already know (keep the meaning; keep option values unchanged).",
            "Give a concrete recommended answer for each, tailored to the context, with a one-line reason.",
            "Intro: one or two warm sentences that build on the previous answers (no greetings after round 1).",
            "",
            "What we know so far:",
            context.known || "(nothing yet)",
            "",
            "Questions to ask (in this order):",
            nodesJson,
          ].join("\n"),
        },
      ],
    });
    const byNode = new Map(data.questions.map((q) => [q.nodeId, q]));
    return {
      intro: data.intro || defaultIntro,
      questions: base.map((q) => {
        const phrased = byNode.get(q.nodeId);
        if (!phrased) return q;
        const recommended = toValue(q.answerType, phrased.recommendedValues, q.recommended);
        return {
          ...q,
          title: phrased.title || q.title,
          question: phrased.question || q.question,
          why: phrased.why || q.why,
          recommended,
          recommendationText: phrased.recommendationText || q.recommendationText,
        };
      }),
    };
  }

  /** Interpret a free-text reply to a round. */
  async interpretReply(context: {
    text: string;
    questions: RoundQuestion[];
    settled: { nodeId: string; title: string; value: string }[];
    language: string;
  }): Promise<{ answers: ParsedAnswer[]; changes: { nodeId: string; value: unknown }[]; note?: string }> {
    if (!this.llm.available) return { answers: parseRoundReply(context.text, context.questions), changes: [] };
    const schema = {
      type: "object",
      properties: {
        answers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nodeId: { type: "string", enum: context.questions.map((q) => q.nodeId) },
              action: { type: "string", enum: ["answer", "accept", "delegate", "skip"] },
              values: { type: "array", items: { type: "string" } },
              delegateTo: { type: ["string", "null"], enum: [...StakeholderRole.options, null] },
            },
            required: ["nodeId", "action", "values", "delegateTo"],
            additionalProperties: false,
          },
        },
        changes: {
          type: "array",
          description: "Corrections to earlier answers the user made in this message",
          items: {
            type: "object",
            properties: { nodeId: { type: "string", enum: context.settled.length ? context.settled.map((s) => s.nodeId) : ["none"] }, values: { type: "array", items: { type: "string" } } },
            required: ["nodeId", "values"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "Anything else the user said that matters for the design" },
      },
      required: ["answers", "changes", "note"],
      additionalProperties: false,
    };
    const questionsJson = JSON.stringify(
      context.questions.map((q) => ({
        number: q.number,
        nodeId: q.nodeId,
        question: q.question,
        answerType: q.answerType,
        options: q.options?.map((o) => ({ value: o.value, label: o.label })),
        recommended: q.recommended,
      })),
      null,
      1,
    );
    const { data } = await this.llm.structured<{
      answers: { nodeId: string; action: ParsedAnswer["action"]; values: string[]; delegateTo: StakeholderRole | null }[];
      changes: { nodeId: string; values: string[] }[];
      note: string;
    }>({
      purpose: "builder.interpret-reply",
      system: ANALYST_PERSONA,
      effort: "low",
      schema,
      messages: [
        {
          role: "user",
          content: [
            "Map the user's reply onto the round's questions.",
            "- action=accept when they agree with the recommendation; answer with values when they give their own; delegate when they don't know or say another team should answer (set delegateTo); skip when not applicable.",
            "- For choice questions use option values. For list questions (fields/criteria/categories) return one item per value, keeping must-have / deal-breaker markers in the text.",
            "- Only include questions the reply actually addresses.",
            "",
            "Questions:",
            questionsJson,
            "",
            "Earlier answers (for corrections):",
            context.settled.map((s) => `- ${s.nodeId} (${s.title}): ${s.value}`).join("\n") || "(none)",
            "",
            "<reply>",
            context.text,
            "</reply>",
          ].join("\n"),
        },
      ],
    });
    const byNode = new Map(context.questions.map((q) => [q.nodeId, q]));
    const answers: ParsedAnswer[] = data.answers.map((a) => {
      const question = byNode.get(a.nodeId)!;
      return {
        nodeId: a.nodeId,
        action: a.action,
        value: a.action === "accept" ? question.recommended : toValue(question.answerType, a.values, undefined),
        text: context.text,
        delegateTo: a.delegateTo ?? undefined,
      };
    });
    return {
      answers,
      changes: data.changes.filter((c) => c.nodeId !== "none").map((c) => ({ nodeId: c.nodeId, value: c.values.length > 1 ? c.values : c.values[0] })),
      note: data.note || undefined,
    };
  }

  /** Deeper sample analysis: proposes extraction fields and observations (LLM only). */
  async analyzeSamples(samples: { analysis: SampleAnalysis; text: string }[], goal: string): Promise<{ fields: string[]; observations: string } | undefined> {
    if (!this.llm.available || !samples.length) return undefined;
    const schema = {
      type: "object",
      properties: {
        fields: { type: "array", items: { type: "string" }, description: "Information the agent should extract, as short labels" },
        observations: { type: "string", description: "2-4 sentences on variety, quality issues and edge cases in the samples" },
      },
      required: ["fields", "observations"],
      additionalProperties: false,
    };
    const { data } = await this.llm.structured<{ fields: string[]; observations: string }>({
      purpose: "builder.analyze-samples",
      system: ANALYST_PERSONA,
      effort: "low",
      schema,
      messages: [
        {
          role: "user",
          content: [
            `Goal of the agent: ${goal}`,
            "Here are sample inputs the user uploaded. Propose which information the agent should extract and note anything that affects the design.",
            ...samples.map((s, i) => `<sample index="${i + 1}" name="${s.analysis.fileName}" type="${s.analysis.documentType ?? ""}">\n${s.text.slice(0, 6000)}\n</sample>`),
          ].join("\n"),
        },
      ],
    });
    return data;
  }

  /** LLM synthesis of the agent's instructions and schemas from the agreed requirements. */
  async synthesize(context: { agentName: string; goal: string; archetype: Archetype; requirements: string; template?: AgentTemplate; language: string }): Promise<Synthesis | undefined> {
    if (!this.llm.available) return undefined;
    const field = {
      type: "object",
      properties: {
        key: { type: "string", description: "snake_case" },
        label: { type: "string" },
        type: { type: "string", enum: FieldType.options.filter((t) => !["file", "files", "object"].includes(t)) },
        description: { type: "string" },
        required: { type: "boolean" },
      },
      required: ["key", "label", "type", "description", "required"],
      additionalProperties: false,
    };
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        instructions: { type: "string", description: "The agent's system prompt in Markdown (role, objectives, method, rules, output expectations, escalation)" },
        extractionFields: { type: "array", items: field },
        outputFields: { type: "array", items: field },
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              kind: { type: "string", enum: ["must", "nice", "knockout"] },
              weight: { type: "number" },
              keywords: { type: "array", items: { type: "string" } },
            },
            required: ["id", "label", "description", "kind", "weight", "keywords"],
            additionalProperties: false,
          },
        },
        categories: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string" }, label: { type: "string" }, description: { type: "string" }, keywords: { type: "array", items: { type: "string" } } },
            required: ["value", "label", "description", "keywords"],
            additionalProperties: false,
          },
        },
        passScore: { type: "number" },
      },
      required: ["name", "summary", "instructions", "extractionFields", "outputFields", "criteria", "categories", "passScore"],
      additionalProperties: false,
    };
    const { data } = await this.llm.structured<Required<Synthesis>>({
      purpose: "builder.synthesize",
      system: ANALYST_PERSONA,
      effort: "high",
      schema,
      messages: [
        {
          role: "user",
          content: [
            `Design the final agent "${context.agentName}" (${context.archetype}). Goal: ${context.goal}`,
            "Write production-quality instructions (system prompt) that encode every agreed requirement, rules for uncertainty and escalation, privacy constraints and the output format. Instructions in English unless the requirements say otherwise; results language as agreed.",
            "Define extraction/output fields, evaluation criteria (with kind and weight; keywords help offline checks) and categories where relevant (empty arrays when not applicable).",
            context.template ? `It is based on the catalog template "${context.template.name}"; keep what fits:\n${context.template.instructions}` : "",
            "",
            "Agreed requirements:",
            context.requirements,
          ].join("\n"),
        },
      ],
    });
    return {
      ...data,
      extractionFields: data.extractionFields.length ? data.extractionFields : undefined,
      outputFields: data.outputFields.length ? data.outputFields : undefined,
      criteria: data.criteria.length ? data.criteria : undefined,
      categories: data.categories.length ? data.categories : undefined,
    };
  }

  /** Apply a change request to a generated agent ("make the criteria stricter on X"). LLM only. */
  /**
   * Apply a plain-language change ("make English a must-have") as JSON Patch operations,
   * so only what the request requires changes. Throws when the change doesn't fit the definition.
   */
  async refine(definition: AgentDefinition, instruction: string): Promise<{ definition: unknown; explanation: string; changedPaths: string[] } | undefined> {
    if (!this.llm.available) return undefined;
    const schema = {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "JSON Patch (RFC 6902) operations on the definition",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove"] },
              path: { type: "string", description: "JSON Pointer, e.g. /workflow/2/criteria/1/kind or /guardrails/approvalRequiredFor/- (append)" },
              valueJson: { type: "string", description: "The new value as JSON; empty string for remove" },
            },
            required: ["op", "path", "valueJson"],
            additionalProperties: false,
          },
        },
        explanation: { type: "string", description: "One or two sentences for the user, in their language: what you changed" },
      },
      required: ["operations", "explanation"],
      additionalProperties: false,
    };
    const { data } = await this.llm.structured<{ operations: { op: PatchOperation["op"]; path: string; valueJson: string }[]; explanation: string }>({
      purpose: "builder.refine",
      system: ANALYST_PERSONA,
      effort: "high",
      schema,
      messages: [
        {
          role: "user",
          content: [
            "Change this agent definition as the user asks. Return JSON Patch operations that change only what the request requires; keep ids, the workflow structure and {{ }} templates valid.",
            "The slug is the agent's address and must not change.",
            "<definition>",
            JSON.stringify(definition, null, 1),
            "</definition>",
            "<request>",
            instruction,
            "</request>",
          ].join("\n"),
        },
      ],
    });
    if (!data.operations.length) throw new Error("I didn't find anything to change for that request");
    const operations: PatchOperation[] = data.operations.map((o) => {
      if (o.path === "/slug" || o.path.startsWith("/slug/")) throw new Error("the agent's address (slug) can't be changed here");
      if (o.op === "remove") return { op: o.op, path: o.path };
      try {
        return { op: o.op, path: o.path, value: JSON.parse(o.valueJson) };
      } catch {
        throw new Error(`the new value for ${o.path} is not valid JSON`);
      }
    });
    return { definition: applyJsonPatch(definition, operations), explanation: data.explanation, changedPaths: operations.map((o) => o.path) };
  }
}

function toValue(answerType: RoundQuestion["answerType"], values: string[], fallback: unknown): unknown {
  if (!values.length) return fallback;
  switch (answerType) {
    case "single":
    case "text":
      return values.join(", ");
    case "number":
      return Number(values[0]);
    case "boolean":
      return /^(true|yes|evet)$/i.test(values[0]!);
    default:
      return values;
  }
}
