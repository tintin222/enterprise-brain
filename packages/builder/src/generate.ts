import {
  AgentDefinition,
  SECTION_LABELS,
  slugify,
  type AgentDefinitionInput,
  type AgentTemplate,
  type Archetype,
  type Category,
  type Criterion,
  type FieldSpec,
  type FieldType,
  type Probation,
  type RequirementTree,
  type SampleAnalysis,
  type TriggerSpec,
  type WorkflowStep,
} from "@enterprise-brain/core";
import { localizeMailDomain, templateToDefinition } from "@enterprise-brain/runtime";
import { blueprint, dedupeFields, type BlueprintParts } from "./blueprints.ts";
import { guessSystemCategory } from "./systems.ts";
import { displayValue } from "./render.ts";
import { getNode, isSettled, nodesInSectionOrder, stateOf, valueOf } from "./tree.ts";

export { guessSystemCategory };

/** Optional LLM synthesis merged over the deterministic assembly. */
export interface Synthesis {
  name?: string;
  summary?: string;
  instructions?: string;
  extractionFields?: FieldSpec[];
  outputFields?: FieldSpec[];
  criteria?: Criterion[];
  categories?: Category[];
  passScore?: number;
}

export interface GenerationInput {
  description: string;
  archetype: Archetype;
  template?: AgentTemplate;
  department?: string | null;
  requesterName?: string | null;
  requesterRole?: string | null;
  tree: RequirementTree;
  samples: SampleAnalysis[];
  synthesis?: Synthesis;
  /** Knowledge collection created for reference material, if any. */
  knowledgeCollection?: string;
  /** The company's mail domain, replacing the catalog's placeholder addresses. */
  mailDomain?: string;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : typeof v === "object" && v && "label" in v ? String((v as { label: unknown }).label) : String(v))).filter(Boolean);
  if (typeof value === "string") return value.split(/\n|;|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function keyFor(label: string): string {
  const key = slugify(label, 40).replace(/-/g, "_");
  return /^[a-z_]/.test(key) ? key : `f_${key}`;
}

const TYPE_HINTS: [RegExp, FieldType][] = [
  [/e-?mail|e-?posta/i, "email"],
  [/phone|telefon|gsm|mobile/i, "phone"],
  [/url|link|website|linkedin/i, "url"],
  [/date|tarih|deadline|birth/i, "date"],
  [/score|puan|amount|total|toplam|price|fiyat|tutar|years|yıl|count|adet|quantity|miktar|salary|maaş|vat|kdv/i, "number"],
  [/skills|yetenek|languages|diller|certifications|sertifika|list|tags|items|kalemler/i, "list"],
  [/summary|özet|notes|not|description|açıklama|experience|deneyim|education|eğitim|reason|gerekçe|comment/i, "text"],
];

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** "180" -> 180, "6 months" -> 180, "2 years" / "2 yıl" -> 730; undefined when there is no duration ("policy"). */
/**
 * The probation level agreed in the interview: how much the new AI employee does alone at first.
 * Interviews from before probation levels answered "which actions need approval" instead.
 */
export function probationOf(tree: RequirementTree): Probation {
  const value = text(valueOf(tree, "actions.approval"));
  if (value === "shadow" || value === "supervised" || value === "trusted") return value;
  return value === "none" || value === "emails" ? "trusted" : "supervised";
}

export function durationInDays(answer: string): number | undefined {
  const match = answer.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(days?|gün|gun|weeks?|hafta|months?|ay|years?|yıl|yil)?/);
  if (!match) return undefined;
  const amount = Number(match[1]!.replace(",", "."));
  const unit = match[2] ?? "days";
  const factor = /^(week|hafta)/.test(unit) ? 7 : /^(month|ay)/.test(unit) ? 30 : /^(year|yıl|yil)/.test(unit) ? 365 : 1;
  const days = Math.round(amount * factor);
  return days > 0 ? days : undefined;
}

export function labelToField(label: string, known: FieldSpec[] = []): FieldSpec {
  const cleaned = label.replace(/\s*\((optional|required|zorunlu|opsiyonel)\)\s*$/i, "").trim();
  const key = keyFor(cleaned);
  const match = known.find(
    (f) => f.key === key || (f.label ?? "").toLowerCase() === cleaned.toLowerCase() || f.key.replace(/_/g, " ") === cleaned.toLowerCase(),
  );
  if (match) return match;
  const type = TYPE_HINTS.find(([pattern]) => pattern.test(cleaned))?.[1] ?? "string";
  return {
    key,
    label: cleaned,
    type,
    ...(type === "list" ? { itemType: "string" as const } : {}),
    ...(/required|zorunlu/i.test(label) ? { required: true } : {}),
  };
}

export function parseCriteria(items: unknown): Criterion[] {
  const out: Criterion[] = [];
  for (const raw of Array.isArray(items) ? items : asList(items)) {
    if (raw && typeof raw === "object" && "label" in raw) {
      out.push(raw as Criterion);
      continue;
    }
    const itemText = String(raw).trim();
    if (!itemText) continue;
    const lower = itemText.toLowerCase();
    let kind: Criterion["kind"] = "nice";
    if (/knock-?out|deal-?breaker|disqualif|eleme|elenir|reject if/.test(lower)) kind = "knockout";
    else if (/\bmust\b|required|mandatory|zorunlu|olmazsa olmaz|şart|sart|gerekli/.test(lower)) kind = "must";
    const label = itemText.replace(/\s*\((must|nice|knockout|must-have|nice-to-have|deal-breaker)\)\s*$/i, "").replace(/^(must|nice)[:\s-]+/i, "").trim();
    const keywords = label
      .toLowerCase()
      .replace(/\b(\d+)\+?\s*(years?|yıl)\b/g, "")
      .split(/[^\p{L}\p{N}+#.]+/u)
      .filter((w) => w.length > 2 && !["and", "the", "with", "experience", "years", "ile", "veya", "deneyim", "knowledge", "bilgisi"].includes(w));
    out.push({ id: keyFor(label).slice(0, 40), label, kind, weight: kind === "must" ? 2 : 1, keywords: keywords.length ? keywords : undefined });
  }
  return out;
}

export function parseCategories(items: unknown): Category[] {
  const list = Array.isArray(items) ? items : asList(items);
  return list
    .map((raw) => {
      if (raw && typeof raw === "object" && "value" in raw) return raw as Category;
      const label = String(raw).trim();
      return { value: keyFor(label), label, keywords: label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3) };
    })
    .filter((c) => c.value);
}

/** Guess the system category from how the requester described a system. */
function isAccepted(tree: RequirementTree, id: string): boolean {
  const node = getNode(tree, id);
  const value = valueOf(tree, id);
  if (!node || node.recommended === undefined) return false;
  return JSON.stringify(asList(value).map((s) => s.toLowerCase())) === JSON.stringify(asList(node.recommended).map((s) => s.toLowerCase()));
}

function mapSteps(workflow: WorkflowStep[], fn: (step: WorkflowStep) => WorkflowStep): WorkflowStep[] {
  return workflow.map(fn);
}

function cronFor(schedule: string): string | undefined {
  switch (schedule) {
    case "daily":
      return "0 7 * * 1-5";
    case "weekly":
      return "0 7 * * 1";
    case "monthly":
      return "0 7 1 * *";
    default:
      return undefined;
  }
}

/** Human-readable record of the interview, appended to the instructions for traceability. */
export function requirementsDigest(tree: RequirementTree): string {
  const lines: string[] = [];
  let section = "";
  for (const node of nodesInSectionOrder(tree)) {
    const state = stateOf(tree, node.id);
    if (!isSettled(state) || state.status === "skipped") continue;
    const value = state.answeredBy === "stakeholder" && state.answerText ? state.answerText : state.value === undefined ? "" : displayValue(node, state.value);
    if (!value || node.answerType === "files") continue;
    if (node.section !== section) {
      section = node.section;
      lines.push(`\n### ${SECTION_LABELS[node.section]}`);
    }
    lines.push(`- **${node.title}:** ${value}${state.status === "assumed" ? " _(assumed)_" : ""}`);
  }
  return lines.join("\n").trim();
}

export function generateDefinition(input: GenerationInput): AgentDefinition {
  const { tree, template, synthesis } = input;
  const name = synthesis?.name || text(valueOf(tree, "purpose.name")) || template?.name || "New Agent";
  const goal = text(valueOf(tree, "purpose.goal")) || input.description;
  const summary = synthesis?.summary || goal.slice(0, 280);
  const channels = asList(valueOf(tree, "inputs.channels"));
  const destinations = asList(valueOf(tree, "outputs.destination"));
  const templateExtract = template?.workflow.find((s) => s.type === "llm.extract");
  const templateEvaluate = template?.workflow.find((s) => s.type === "llm.evaluate");
  const templateClassify = template?.workflow.find((s) => s.type === "llm.classify");
  const knownFields = [
    ...(templateExtract && "fields" in templateExtract ? templateExtract.fields : []),
    ...(template?.outputs ?? []),
  ];

  const extractionFields =
    synthesis?.extractionFields ??
    (valueOf(tree, "docs.fields") !== undefined && !isAccepted(tree, "docs.fields")
      ? asList(valueOf(tree, "docs.fields")).map((l) => labelToField(l, knownFields))
      : templateExtract && "fields" in templateExtract
        ? templateExtract.fields
        : asList(valueOf(tree, "docs.fields") ?? valueOf(tree, "outputs.fields")).map((l) => labelToField(l, knownFields)));
  const outputFields =
    synthesis?.outputFields ??
    (valueOf(tree, "outputs.fields") !== undefined && !isAccepted(tree, "outputs.fields")
      ? asList(valueOf(tree, "outputs.fields")).map((l) => labelToField(l, knownFields))
      : template?.outputs ?? extractionFields);
  const criteria =
    synthesis?.criteria ??
    (valueOf(tree, "docs.criteria") !== undefined && !isAccepted(tree, "docs.criteria")
      ? parseCriteria(valueOf(tree, "docs.criteria"))
      : templateEvaluate && "criteria" in templateEvaluate
        ? templateEvaluate.criteria
        : parseCriteria(valueOf(tree, "docs.criteria")));
  const categories =
    synthesis?.categories ??
    (valueOf(tree, "mail.categories") !== undefined && !isAccepted(tree, "mail.categories")
      ? parseCategories(valueOf(tree, "mail.categories"))
      : templateClassify && "categories" in templateClassify
        ? templateClassify.categories
        : parseCategories(valueOf(tree, "mail.categories")));

  const targetDescription = `${text(valueOf(tree, "outputs.system"))} ${text(valueOf(tree, "inputs.system"))}`;
  const targetCategory = guessSystemCategory(targetDescription);
  const targetBinding = destinations.includes("system") && targetCategory ? { ref: targetCategory, category: targetCategory } : undefined;
  const replyPolicy = (text(valueOf(tree, "mail.reply_policy")) || "draft") as BlueprintParts["reply"];
  const transformation = text(valueOf(tree, "excel.transformation")) || text(valueOf(tree, "process.steps")) || undefined;

  let definition: AgentDefinitionInput;
  if (template) {
    const base = localizeMailDomain(templateToDefinition(template), input.mailDomain);
    const workflow = mapSteps(base.workflow, (step) => {
      if (step.type === "llm.extract" && step.id === templateExtract?.id && extractionFields.length) return { ...step, fields: extractionFields };
      if (step.type === "llm.evaluate" && step.id === templateEvaluate?.id && criteria.length) {
        return { ...step, criteria, ...(synthesis?.passScore ? { passScore: synthesis.passScore } : {}) };
      }
      if (step.type === "llm.classify" && step.id === templateClassify?.id && categories.length) return { ...step, categories };
      return step;
    });
    definition = {
      ...base,
      workflow,
      outputs: dedupeFields(outputFields.length ? outputFields : base.outputs),
      knowledge: {
        collections: [...new Set([...base.knowledge.collections, ...(input.knowledgeCollection ? [input.knowledgeCollection] : [])])],
      },
    };
  } else {
    const fileKey = "document";
    definition = blueprint(input.archetype, {
      name,
      slug: slugify(name),
      summary,
      instructions: "",
      fileKey,
      extractionFields,
      outputFields: dedupeFields(outputFields),
      criteria,
      categories,
      reply: replyPolicy,
      transformation,
      knowledgeCollection: input.knowledgeCollection,
      targetBinding,
    });
  }

  // Triggers from the channels the requester described.
  const triggers: TriggerSpec[] = [{ type: "manual" }];
  const mailbox = text(valueOf(tree, "inputs.mailbox")).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
  if (channels.includes("upload") || channels.includes("web-form")) triggers.push({ type: "form" });
  if (channels.includes("email") && mailbox) {
    triggers.push({
      type: "mailbox",
      mailbox,
      ...(input.archetype === "document-processing" ? { filter: { hasAttachment: true } } : {}),
    });
  }
  // Files that land in a folder: each new one is picked up from the folder connection IT sets up.
  const fileDrop = channels.includes("shared-folder");
  if (fileDrop) triggers.push({ type: "connector-event", connector: "files", event: "new_file" });
  if (channels.includes("web-form")) triggers.push({ type: "webhook", description: "Website form submissions" });
  if (channels.includes("chat") || input.archetype === "conversational") triggers.push({ type: "chat" });
  const cron = cronFor(text(valueOf(tree, "excel.schedule")) || text(valueOf(tree, "process.schedule")));
  if (cron) triggers.push({ type: "schedule", cron, timezone: "Europe/Istanbul" });

  // Inputs: keep the file input and email object; add requested form fields.
  const formFields = asList(valueOf(tree, "inputs.form")).map((l) => labelToField(l, definition.inputs ?? []));
  const inputs = dedupeFields([
    ...(definition.inputs ?? []).map((f) => (f.key === "email" && channels.includes("email") ? { ...f, required: false } : f)),
    ...formFields.filter((f) => f.type !== "file"),
    ...(channels.includes("email") && input.archetype === "document-processing" && !(definition.inputs ?? []).some((f) => f.key === "email")
      ? [{ key: "email", label: "Source email", type: "object" as const }]
      : []),
  ]).map((f) => (channels.includes("email") && f.type === "file" && input.archetype === "document-processing" ? { ...f, required: false } : f));

  // Choice answers are validated when given; these guards keep a stray value from breaking generation.
  const level = probationOf(tree);
  const personalData = oneOf(text(valueOf(tree, "governance.personal_data")), ["none", "contains", "sensitive"], definition.guardrails?.personalData ?? "none");
  // Labels carry the durations ("Talent pool for 1 year, …"); a stakeholder's answer is in their words.
  const retentionState = stateOf(tree, "governance.retention");
  const retentionNode = getNode(tree, "governance.retention");
  const retention = durationInDays(
    retentionState.answeredBy === "stakeholder" && retentionState.answerText
      ? retentionState.answerText
      : retentionNode && valueOf(tree, "governance.retention") !== undefined
        ? displayValue(retentionNode, valueOf(tree, "governance.retention"))
        : "",
  );
  const notes = [
    ...(definition.guardrails?.notes ?? []),
    ...(text(valueOf(tree, "purpose.out_of_scope")) ? [`Out of scope: ${text(valueOf(tree, "purpose.out_of_scope"))}`] : []),
    ...(text(valueOf(tree, "governance.legal_basis")) ? [`Legal basis: ${text(valueOf(tree, "governance.legal_basis"))}`] : []),
    ...(text(valueOf(tree, "governance.access")) ? [`Access: ${text(valueOf(tree, "governance.access"))}`] : []),
  ];

  const layout = oneOf(text(valueOf(tree, "ui.layout")), ["form-results", "chat", "inbox", "table", "none"], definition.ui?.layout ?? "form-results");
  const instructions =
    synthesis?.instructions ??
    [
      (definition.instructions || `You are ${name}. ${goal}`).trim(),
      "",
      "## Requirements agreed with the business",
      `Captured by the Enterprise Brain Agent Builder with ${input.requesterName ?? "the requester"}${input.requesterRole ? ` (${input.requesterRole})` : ""}.`,
      requirementsDigest(tree),
      "",
      text(valueOf(tree, "operations.language")) === "tr"
        ? "Write all results in Turkish."
        : text(valueOf(tree, "operations.language")) === "en"
          ? "Write all results in English."
          : "Write results in the language of the input.",
    ].join("\n");

  const fileInputKey = inputs.find((f) => f.type === "file")?.key;
  const tests = fileInputKey
    ? input.samples.map((s) => ({ name: s.fileName, input: { [fileInputKey]: s.fileId } }))
    : [];

  return AgentDefinition.parse({
    ...definition,
    slug: slugify(name),
    name,
    title: definition.title ?? template?.title,
    summary,
    department: input.department ?? definition.department ?? template?.department,
    archetype: input.archetype,
    instructions,
    inputs,
    connectors:
      fileDrop && !(definition.connectors ?? []).some((c) => c.ref === "files")
        ? [...(definition.connectors ?? []), { ref: "files", category: "storage" as const, purpose: "The folder new files arrive in" }]
        : definition.connectors,
    // The requester's mailbox replaces the template's placeholder one.
    triggers: dedupeTriggers([
      ...triggers,
      ...(definition.triggers ?? []).filter((t) => t.type !== "manual" && !(t.type === "mailbox" && triggers.some((n) => n.type === "mailbox"))),
    ]),
    guardrails: {
      // The level decides what goes to a person; these keep a Trusted hire's job consistent with it.
      approvalRequiredFor: level === "trusted" ? (text(valueOf(tree, "actions.approval")) === "emails" ? ["mail.send"] : []) : ["mail.send", "connector:write"],
      personalData,
      ...(retention ? { retentionDays: retention } : {}),
      notes: notes.length ? notes : undefined,
    },
    ui: {
      ...(definition.ui ?? {}),
      layout,
      title: name,
      description: summary,
    },
    kpis: text(valueOf(tree, "operations.success"))
      ? asList(valueOf(tree, "operations.success")).map((k) => ({ id: keyFor(k), name: k }))
      : definition.kpis,
    tests,
  });
}

function dedupeTriggers(triggers: TriggerSpec[]): TriggerSpec[] {
  const seen = new Set<string>();
  return triggers.filter((t) => {
    const key =
      t.type === "mailbox" ? `mailbox:${t.mailbox}` : t.type === "schedule" ? `schedule:${t.cron}` : t.type === "connector-event" ? `event:${t.connector}:${t.event}` : t.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
