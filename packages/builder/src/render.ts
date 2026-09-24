import {
  ARCHETYPE_LABELS,
  SECTION_LABELS,
  STAKEHOLDER_LABELS,
  type AgentDefinition,
  type BuilderRound,
  type RequirementTree,
  type RoundQuestion,
  type WorkflowStep,
} from "@enterprise-brain/core";
import { delegatedNodes, isSettled, nodesInSectionOrder, stateOf } from "./tree.ts";

/** Value of integration questions another team answered (their words are kept as the answer text). */
export const ARRANGED_BY_STAKEHOLDER = "arranged-by-stakeholder";

export function displayValue(question: Pick<RoundQuestion, "options" | "answerType">, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (value === ARRANGED_BY_STAKEHOLDER) return "Arranged by the responsible team";
  const label = (v: unknown) => question.options?.find((o) => o.value === v)?.label ?? String(v);
  if (Array.isArray(value)) return value.length ? value.map(label).join(", ") : "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return label(value);
}

export function renderRound(round: BuilderRound, language = "en"): string {
  const tr = language.startsWith("tr");
  const lines: string[] = [];
  if (round.intro) lines.push(round.intro, "");
  round.questions.forEach((q, i) => {
    if (i > 0) lines.push("", "---", "");
    lines.push(`❓ **Q${q.number} — ${q.title}**: ${q.question}`);
    if (q.options?.length && (q.answerType === "single" || q.answerType === "multi")) {
      q.options.forEach((o, j) => lines.push(`   ${String.fromCharCode(97 + j)}) ${o.label}${o.description ? ` — ${o.description}` : ""}`));
    }
    if (q.why) lines.push(`_${tr ? "Neden önemli" : "Why this matters"}: ${q.why}_`);
    if (q.answerType === "files") lines.push("", `➡️ ${tr ? "Dosyaları buraya yükleyin" : "Upload the files here (drag & drop)"}`);
    else if (q.recommendationText) lines.push("", `➡️ ${q.recommendationText}`);
  });
  lines.push(
    "",
    tr
      ? "_Numarayla yanıtlayabilirsiniz (ör. `1 evet, 2 b, 3 bilmiyorum — BT'ye sor`) ya da butonları kullanın. Başka bir ekibin bilmesi gereken bir şeyse \"bilmiyorum\" deyin; talebi onlar için ben hazırlarım._"
      : "_Answer by number (e.g. `1 yes, 2 b, 3 don't know — ask IT`) or use the buttons. For anything another team should answer, just say \"I don't know\" — I'll prepare the request for them._",
  );
  return lines.join("\n");
}

/**
 * The analyst's short follow-up when a reply leaves part of a round open: which
 * answers didn't fit the options, and which questions are still waiting.
 */
export function renderFollowUp(options: {
  stillOpen: RoundQuestion[];
  unmatched: { question?: RoundQuestion; node: { title: string; options?: RoundQuestion["options"] }; said: string }[];
  language?: string;
}): string {
  const tr = (options.language ?? "en").startsWith("tr");
  const lines: string[] = [];
  const label = (q: RoundQuestion | undefined, title: string) => (q ? `**Q${q.number} — ${q.title}**` : `**${title}**`);
  const unmatchedIds = new Set(options.unmatched.map((u) => u.question?.nodeId));
  for (const u of options.unmatched) {
    const choices = (u.node.options ?? []).map((o, j) => `${String.fromCharCode(97 + j)}) ${o.label}`).join(" · ");
    lines.push(
      tr
        ? `${label(u.question, u.node.title)} için "${truncateText(u.said, 80)}" yanıtını seçeneklerle eşleştiremedim. Lütfen birini seçin: ${choices} — ya da "bilmiyorum" deyin.`
        : `I couldn't match "${truncateText(u.said, 80)}" to one of the options for ${label(u.question, u.node.title)}. Please pick one: ${choices} — or say "I don't know".`,
    );
  }
  const waiting = options.stillOpen.filter((q) => !unmatchedIds.has(q.nodeId));
  if (waiting.length) {
    if (lines.length) lines.push("");
    const list = waiting.map((q) => label(q, q.title)).join(", ");
    lines.push(
      tr
        ? `${lines.length ? "Hâlâ açık" : "Teşekkürler, not aldım. Hâlâ açık"}: ${list}. Numarayla yanıtlayabilir ya da "önerilerinle devam et" diyebilirsiniz.`
        : `${lines.length ? "Still open" : "Thanks, noted. Still open"}: ${list}. Answer by number, or say "go with your recommendations".`,
    );
  }
  return lines.join("\n");
}

function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Operation ids that only read ("get_purchase_order", "search_candidates"). */
const READ_OPERATION = /^(get|search|list|find|read|query|describe|download|lookup|check)_/;

function pathLabel(path: string): string {
  const parts = path.trim().split(".");
  const meaningful = parts[0] === "steps" || parts[0] === "input" ? parts.slice(parts[0] === "steps" ? 2 : 1) : parts;
  return plainWords((meaningful.length ? meaningful : parts).join(" "));
}

/** "Shortlist {{ steps.profile.full_name | default:'candidate' }}?" -> "Shortlist ‹full name›?" */
export function humanizeTemplate(text: string): string {
  return text.replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (_, path: string) => `‹${pathLabel(path)}›`);
}

/** "steps.evaluation.verdict != 'fail'" -> "verdict is not fail"; "input.requisition_id" -> "requisition id is given". */
export function humanizeCondition(expression: string): string {
  const bare = expression.trim().match(/^(!)?\s*([a-zA-Z_][\w.]*)$/);
  if (bare) {
    const label = pathLabel(bare[2]!);
    const given = bare[2]!.startsWith("input.");
    return bare[1] ? (given ? `${label} is not given` : `not ${label}`) : given ? `${label} is given` : label;
  }
  return expression
    .replace(/[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)+/g, (path) => pathLabel(path))
    .replace(/\s*!==?\s*/g, " is not ")
    .replace(/\s*===?\s*/g, " is ")
    .replace(/\s*>=\s*/g, " ≥ ")
    .replace(/\s*<=\s*/g, " ≤ ")
    .replace(/\s*&&\s*/g, " and ")
    .replace(/\s*\|\|\s*/g, " or ")
    .replace(/['"]/g, "");
}

function plainWords(key: string): string {
  return key.replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const APPROVAL_LABELS: Record<string, string> = {
  "mail.send": "sending emails",
  "connector:write": "changes in other systems",
  "connector:*": "any use of other systems",
};

function triggerLabel(trigger: AgentDefinition["triggers"][number]): string {
  switch (trigger.type) {
    case "manual":
      return "on demand";
    case "form":
      return "its form";
    case "mailbox":
      return `emails to ${trigger.mailbox}${trigger.filter?.hasAttachment ? " (with attachments)" : ""}`;
    case "schedule":
      return `a schedule (${trigger.cron})`;
    case "webhook":
      return trigger.description ?? "a webhook";
    case "chat":
      return "chat";
    case "paperclip":
      return "Paperclip tasks";
    case "connector-event":
      return `${trigger.connector} ${plainWords(trigger.event)}`;
  }
}

function describeStep(step: WorkflowStep): string {
  switch (step.type) {
    case "extract":
      return "Read the document (OCR for scans and photos)";
    case "llm.extract":
      return `Extract ${step.fields.length} fields (${step.fields.slice(0, 6).map((f) => f.label ?? f.key).join(", ")}${step.fields.length > 6 ? ", …" : ""})`;
    case "llm.classify":
      return `Classify into ${step.categories.map((c) => c.label ?? c.value).join(" / ")}`;
    case "llm.evaluate": {
      const must = step.criteria.filter((c) => c.kind === "must").length;
      const knockout = step.criteria.filter((c) => c.kind === "knockout").length;
      return `Score against ${step.criteria.length} criteria (${must} must-have, ${knockout} deal-breaker) with evidence for each`;
    }
    case "llm.generate":
      return step.name ?? "Write a summary / draft";
    case "knowledge.search":
      return "Look up reference information in the knowledge base";
    case "connector":
      return `${step.name ?? `${plainWords(step.operation)} in ${step.connector.toUpperCase()}`}${step.requiresApproval !== false && !READ_OPERATION.test(step.operation) ? " (after approval)" : ""}`;
    case "approval":
      return `Ask a person to approve: ${humanizeTemplate(step.title)}`;
    case "mail.send":
      return "Send an email (after approval)";
    case "excel.read":
      return "Read the spreadsheet";
    case "excel.write":
      return "Produce an Excel file";
    case "agent":
      return step.name ?? "Work autonomously with its tools";
    case "output":
      return "Show the result";
  }
}

export function describeDefinition(definition: AgentDefinition): string {
  const lines: string[] = [];
  lines.push(`- **Type:** ${ARCHETYPE_LABELS[definition.archetype]}`);
  if (definition.inputs.length) lines.push(`- **Inputs:** ${definition.inputs.map((f) => `${f.label ?? f.key}${f.required ? "*" : ""}`).join(", ")}`);
  const steps = definition.workflow.filter((s) => s.type !== "output");
  if (steps.length) {
    lines.push("- **Steps:**");
    steps.forEach((s, i) => lines.push(`  ${i + 1}. ${describeStep(s)}${s.when ? ` — only when ${humanizeCondition(s.when)}` : ""}`));
  } else {
    lines.push(`- **Works as:** a conversational assistant with tools: ${definition.tools.join(", ") || "none"}`);
  }
  if (definition.outputs.length) lines.push(`- **Result:** ${definition.outputs.map((f) => f.label ?? f.key).join(", ")}`);
  lines.push(`- **Starts from:** ${[...new Set(definition.triggers.map(triggerLabel))].join(", ")}`);
  if (definition.connectors.length) {
    lines.push(
      `- **Systems:** ${definition.connectors.map((c) => `${c.category.toUpperCase()}${c.purpose ? ` (${c.purpose.replace(/[.\s]+$/, "")})` : ""}${c.instanceId ? "" : ", sandbox until connected"}`).join("; ")}`,
    );
  }
  const approvals = definition.guardrails.approvalRequiredFor.map((p) => APPROVAL_LABELS[p] ?? p);
  lines.push(`- **Human approval for:** ${approvals.length ? approvals.join(", ") : "nothing (fully automatic)"}`);
  lines.push(
    `- **Privacy:** ${definition.guardrails.personalData === "none" ? "no personal data" : `${definition.guardrails.personalData} personal data`}${definition.guardrails.retentionDays ? `, kept ${definition.guardrails.retentionDays} days` : ""}`,
  );
  return lines.join("\n");
}

export function renderSummary(options: {
  tree: RequirementTree;
  agentName: string;
  goal: string;
  draft?: AgentDefinition;
  language?: string;
  requestStatus?: Map<string, string>;
}): string {
  const { tree } = options;
  const tr = options.language?.startsWith("tr");
  const lines: string[] = [];
  lines.push(tr ? `## Üzerinde anlaştıklarımız: ${options.agentName}` : `## Here's what we agreed: ${options.agentName}`, "", options.goal, "");
  let section = "";
  const assumptions: string[] = [];
  for (const node of nodesInSectionOrder(tree)) {
    const state = stateOf(tree, node.id);
    if (!isSettled(state) || state.status === "skipped" || node.answerType === "files") continue;
    if (node.section !== section) {
      section = node.section;
      lines.push(`**${SECTION_LABELS[node.section]}**`);
    }
    // Another team's answer is shown in their words, with who answered.
    const value =
      state.answeredBy === "stakeholder" && state.evidence ? state.evidence : displayValue({ options: node.options, answerType: node.answerType }, state.value);
    const who = state.answeredBy === "stakeholder" ? "" : state.answeredBy === "system" ? ` _(${state.evidence ?? "found by the analyst"})_` : "";
    lines.push(`- ${node.title}: ${value}${who}`);
    if (state.status === "assumed" && state.answeredBy !== "system") assumptions.push(`${node.title}: ${value}`);
  }
  const delegated = delegatedNodes(tree);
  if (delegated.length) {
    lines.push("", tr ? "**Başkalarından beklenenler**" : "**Waiting on others**");
    for (const node of delegated) {
      const status = options.requestStatus?.get(stateOf(tree, node.id).delegationId ?? "") ?? "draft";
      lines.push(`- ${node.title} — ${STAKEHOLDER_LABELS[node.owner]} (${status})`);
    }
  }
  if (assumptions.length) {
    lines.push("", tr ? "**Varsayımlar (değiştirebilirsiniz)**" : "**Assumptions (you can change these)**", ...assumptions.map((a) => `- ${a}`));
  }
  if (options.draft) {
    lines.push("", tr ? "### Oluşturacağım ajan" : "### What I'll build", describeDefinition(options.draft));
  }
  lines.push(
    "",
    tr
      ? "Hazırsanız **\"onayla\"** yazın; ajanı oluşturup örneklerinizle test edeyim. Değiştirmek istediğiniz bir şey varsa söyleyin."
      : "Reply **\"confirm\"** and I'll build the agent and test it on your samples — or tell me what to change.",
  );
  return lines.join("\n");
}
