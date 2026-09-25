import { randomBytes } from "node:crypto";
import {
  STAKEHOLDER_LABELS,
  type RequirementNode,
  type RequirementTree,
  type StakeholderQuestion,
  type StakeholderRequestData,
  type StakeholderRole,
} from "@enterprise-brain/core";
import { describeSystem } from "./systems.ts";
import { valueOf } from "./tree.ts";

export interface StakeholderContext {
  agentName: string;
  goal: string;
  requesterName: string;
  requesterRole?: string | null;
  requesterEmail?: string | null;
  department?: string | null;
  language: string;
  answerUrl: string;
  recipientName?: string;
  /** Concrete platform requirements (from connector manifests' itRequirements). */
  technicalNotes?: string[];
}

export function newToken(): string {
  return randomBytes(18).toString("base64url");
}

/** Rephrase a requester-facing node as a precise question for the stakeholder who owns the answer. */
export function stakeholderQuestion(node: RequirementNode, tree: RequirementTree): StakeholderQuestion {
  const mailbox = String(valueOf(tree, "inputs.mailbox") ?? "the mailbox");
  // The requester describes systems in their own words; name the system and keep their words as context.
  const said = (id: string) => (typeof valueOf(tree, id) === "string" ? String(valueOf(tree, id)).trim() : "");
  const source = describeSystem(said("inputs.system")) ?? "the system the inputs come from";
  const target = describeSystem(said("outputs.system")) ?? "the system the results go to";
  const context = (id: string) => (said(id) ? ` The requester's words: "${said(id)}"` : "");
  const q = (question: string, why?: string): StakeholderQuestion => ({ nodeId: node.id, question, why: why ?? node.why });
  switch (node.id) {
    case "integration.mail":
      return q(
        `How can the AI employee get access to ${mailbox}? Our preferred option is a Microsoft 365 (Entra ID) app registration with Mail.Read and Mail.Send application permissions, restricted to this mailbox with an application access policy. A dedicated service account over IMAP/SMTP also works.`,
        "The AI employee reads incoming messages and attachments from this mailbox; replies are only sent after a person approves them.",
      );
    case "integration.source_system":
      return q(
        `How can the AI employee read data from ${source}? Is there an API (REST/OData), and can you create a read-only technical user limited to the records it needs?`,
        `Read-only access with a dedicated technical user keeps the AI employee's footprint minimal and auditable.${context("inputs.system")}`,
      );
    case "integration.target_system":
      return q(
        `Can you create a technical integration user in ${target} that may create/update only the records the AI employee writes, and tell us which API to use?`,
        `Every write is approval-gated and logged, but the account itself should still follow least privilege.${context("outputs.system")}`,
      );
    case "integration.shared_folder":
      return q("Can you grant the AI employee read access to the shared folder via Microsoft Graph (Sites.Selected), or tell us the preferred way?");
    case "integration.web_form":
      return q("Can the website form send each submission (as JSON) to a webhook URL we provide, and who can make that change?");
    case "governance.retention":
      return q("How long may the data processed by this AI employee be retained, and must it be deleted or anonymised afterwards?");
    case "governance.legal_basis":
      return q("What is the legal basis for processing this personal data (e.g. consent in the privacy notice), and does the notice need updating for automated screening?");
    default:
      return q(node.question);
  }
}

const TEXT = {
  en: {
    greeting: (name?: string) => `Hello ${name ?? "team"},`,
    intro: (ctx: StakeholderContext) =>
      `I'm ${ctx.requesterName}${ctx.requesterRole ? ` (${ctx.requesterRole})` : ""}. We are setting up "${ctx.agentName}", an AI agent on our Enterprise Brain platform. What it will do: ${ctx.goal.replace(/\s+/g, " ").trim()}`,
    need: "To take it live we need a few answers that only you can give:",
    why: "Why",
    technical: "Technical notes from the platform:",
    answer: (url: string) => `You can answer in this short form (about 5 minutes): ${url}\nOr simply reply to this email.`,
    meanwhile: "Until then we'll keep testing with manual uploads and sandbox data, so nothing is blocked.",
    thanks: "Thank you,",
    subject: (ctx: StakeholderContext, role: StakeholderRole) =>
      role === "it" ? `[Integration request] ${ctx.agentName}: system access needed` : `[Input needed] ${ctx.agentName}: questions for ${STAKEHOLDER_LABELS[role]}`,
  },
  tr: {
    greeting: (name?: string) => `Merhaba ${name ?? ""}`.trim() + ",",
    intro: (ctx: StakeholderContext) =>
      `Ben ${ctx.requesterName}${ctx.requesterRole ? ` (${ctx.requesterRole})` : ""}. Enterprise Brain platformunda "${ctx.agentName}" adlı bir yapay zekâ ajanı hazırlıyoruz. Ne yapacak: ${ctx.goal.replace(/\s+/g, " ").trim()}`,
    need: "Ajanı devreye alabilmek için yalnızca sizin yanıtlayabileceğiniz birkaç sorumuz var:",
    why: "Neden",
    technical: "Platformdan teknik notlar:",
    answer: (url: string) => `Yanıtlarınızı bu kısa formdan iletebilirsiniz (yaklaşık 5 dakika): ${url}\nYa da bu e-postayı yanıtlamanız yeterli.`,
    meanwhile: "Erişim hazır olana kadar ajanı manuel yüklemeler ve test verisiyle denemeye devam edeceğiz; hiçbir iş beklemede kalmayacak.",
    thanks: "Teşekkürler,",
    subject: (ctx: StakeholderContext, role: StakeholderRole) =>
      role === "it" ? `[Entegrasyon talebi] ${ctx.agentName}: sistem erişimi gerekiyor` : `[Görüşünüz gerekiyor] ${ctx.agentName}: ${STAKEHOLDER_LABELS[role]} için sorular`,
  },
};

export function composeStakeholderRequest(
  role: StakeholderRole,
  questions: StakeholderQuestion[],
  ctx: StakeholderContext,
): StakeholderRequestData {
  const t = ctx.language.startsWith("tr") ? TEXT.tr : TEXT.en;
  const bodyLines = [
    t.greeting(ctx.recipientName),
    "",
    t.intro(ctx),
    "",
    t.need,
    ...questions.flatMap((q, i) => [`${i + 1}. ${q.question}`, ...(q.why ? [`   ${t.why}: ${q.why}`] : [])]),
    ...(ctx.technicalNotes?.length ? ["", t.technical, ...ctx.technicalNotes.map((n) => `- ${n}`)] : []),
    "",
    t.answer(ctx.answerUrl),
    "",
    t.meanwhile,
    "",
    t.thanks,
    ctx.requesterName,
    ...(ctx.requesterRole ? [ctx.requesterRole] : []),
  ];
  return {
    role,
    recipientName: ctx.recipientName,
    subject: t.subject(ctx, role),
    body: bodyLines.join("\n"),
    questionnaire: questionnaireMarkdown(role, questions, ctx),
    questions,
  };
}

/** A discovery questionnaire the stakeholder can fill in asynchronously (to-questionnaire format). */
export function questionnaireMarkdown(role: StakeholderRole, questions: StakeholderQuestion[], ctx: StakeholderContext): string {
  return [
    `# ${ctx.agentName}: questions for ${STAKEHOLDER_LABELS[role]}`,
    "",
    `**Purpose:** ${ctx.agentName} cannot go live until these points are settled. Your answers are applied directly to the agent's design.`,
    "",
    `**From:** ${ctx.requesterName}${ctx.requesterRole ? ` (${ctx.requesterRole})` : ""}, **To:** ${ctx.recipientName ?? STAKEHOLDER_LABELS[role]}, **How your answers will be used:** they settle open requirements in the Agent Builder and configure the integration.`,
    "",
    "## Context",
    "",
    `${ctx.goal.replace(/\s+/g, " ").trim()} The AI employee works on the company's Enterprise Brain platform; a person approves its changes to other systems and its emails until it has a track record, and everything it does is logged.`,
    "",
    "## How to answer",
    "",
    `About 5 minutes. Answer online at ${ctx.answerUrl}, or reply by email. Partial answers and "I don't know" are useful — flag anything you're unsure of rather than skipping it.`,
    "",
    "## Questions",
    "",
    ...questions.flatMap((q) => [`### ${q.question}`, "", ...(q.why ? [`_Why this matters: ${q.why}_`, ""] : []), ">", ""]),
    "## Anything else?",
    "",
    "Anything we didn't ask that we should know (security requirements, timelines, alternatives)?",
    "",
    ">",
  ].join("\n");
}
