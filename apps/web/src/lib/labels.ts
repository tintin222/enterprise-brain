import type { Archetype, FieldSpec, RequirementSection, StakeholderRole, TriggerSpec, WorkflowStep } from "../types.ts";
import { humanize } from "./format.ts";

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  "document-processing": "Document & OCR processing",
  "mail-triage": "Mail triage & replies",
  conversational: "Conversational assistant",
  "excel-automation": "Excel automation",
  search: "Enterprise search",
  "process-automation": "Process automation",
  "report-generation": "Report generation",
};

export function archetypeLabel(archetype: string | null | undefined): string {
  if (!archetype) return "—";
  return ARCHETYPE_LABELS[archetype as Archetype] ?? humanize(archetype);
}

export const SECTION_LABELS: Record<RequirementSection, string> = {
  purpose: "Purpose & scope",
  users: "Users & stakeholders",
  inputs: "Inputs & data sources",
  processing: "Rules & decision logic",
  outputs: "Outputs",
  actions: "Actions & follow-ups",
  integrations: "System integrations",
  governance: "Governance, privacy & approvals",
  ui: "User interface",
  operations: "Volume, SLAs & success",
};

export const SECTION_ORDER: RequirementSection[] = [
  "purpose",
  "users",
  "inputs",
  "processing",
  "outputs",
  "actions",
  "integrations",
  "governance",
  "ui",
  "operations",
];

export const STAKEHOLDER_LABELS: Record<StakeholderRole, string> = {
  requester: "Requester",
  it: "IT / Integration team",
  security: "Information security",
  legal: "Legal",
  dpo: "Data protection officer",
  finance: "Finance",
  "process-owner": "Process owner",
  "data-owner": "Data owner",
  management: "Management",
};

export function stakeholderLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return STAKEHOLDER_LABELS[role as StakeholderRole] ?? humanize(role);
}

/** Roles offered by the "I don't know — ask someone" picker. */
export const DELEGATE_ROLES: { value: StakeholderRole; label: string }[] = [
  { value: "it", label: "IT" },
  { value: "dpo", label: "Data protection (DPO)" },
  { value: "legal", label: "Legal" },
  { value: "finance", label: "Finance" },
  { value: "process-owner", label: "Process owner" },
  { value: "security", label: "Security" },
  { value: "management", label: "Management" },
];

export const CONNECTOR_CATEGORY_LABELS: Record<string, string> = {
  erp: "ERP",
  crm: "CRM",
  hris: "HRIS",
  ats: "ATS",
  itsm: "ITSM",
  mail: "Mail",
  calendar: "Calendar",
  dms: "DMS",
  storage: "Storage",
  accounting: "Accounting",
  bi: "BI",
  ecommerce: "E-commerce",
  scm: "Supply chain",
  messaging: "Messaging",
  database: "Database",
  web: "Web",
  esign: "E-signature",
  other: "Other",
};

export const CONNECTOR_CATEGORY_ORDER = ["erp", "crm", "hris", "ats", "itsm", "mail", "calendar", "messaging", "dms", "database", "web", "other"];

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Other";
  return CONNECTOR_CATEGORY_LABELS[category] ?? humanize(category);
}

export function describeTrigger(trigger: TriggerSpec): string {
  switch (trigger.type) {
    case "manual":
      return "Started by a person";
    case "form":
      return trigger.description ? `Form: ${trigger.description}` : "Form submission";
    case "mailbox": {
      const bits: string[] = [];
      if (trigger.filter?.hasAttachment) bits.push("with attachments");
      if (trigger.filter?.subjectContains?.length) bits.push(`subject contains ${trigger.filter.subjectContains.join(" / ")}`);
      if (trigger.filter?.fromDomains?.length) bits.push(`from ${trigger.filter.fromDomains.join(", ")}`);
      return `Email to ${trigger.mailbox}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    }
    case "schedule":
      return `${describeCron(trigger.cron)}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
    case "webhook":
      return trigger.description ? `Webhook: ${trigger.description}` : "Webhook";
    case "chat":
      return "Chat conversation";
    case "paperclip":
      return trigger.description ? `Paperclip task: ${trigger.description}` : "Paperclip task";
    case "connector-event":
      return `${trigger.connector}: ${trigger.event}`;
  }
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** Common cron patterns in words ("0 8 * * 1" → "Mondays at 08:00"); anything else stays as cron. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `Schedule ${cron}`;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min)) {
    if (min.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every ${min.slice(2)} minutes`;
    return `Schedule ${cron}`;
  }
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") return `Every ${hour.slice(2)} hours`;
  if (!/^\d+$/.test(hour)) return `Schedule ${cron}`;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (month !== "*") return `Schedule ${cron}`;
  if (dom === "*" && dow === "*") return `Every day at ${time}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${time}`;
  if (dom === "*" && /^[0-6]$/.test(dow)) return `${DAYS[Number(dow)]} at ${time}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on day ${dom} at ${time}`;
  return `Schedule ${cron}`;
}

export function triggerShort(trigger: TriggerSpec): string {
  switch (trigger.type) {
    case "mailbox":
      return trigger.mailbox;
    case "schedule":
      return "Schedule";
    case "connector-event":
      return trigger.event;
    default:
      return humanize(trigger.type);
  }
}

export const RUN_TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  form: "Form",
  mailbox: "Email",
  schedule: "Schedule",
  webhook: "Webhook",
  paperclip: "Paperclip",
  test: "Test",
  chat: "Chat",
  "connector-event": "System event",
};

export function runTriggerLabel(trigger: string): string {
  return RUN_TRIGGER_LABELS[trigger] ?? humanize(trigger);
}

function fieldNames(fields: FieldSpec[], max = 6): string {
  const names = fields.slice(0, max).map((f) => f.label ?? humanize(f.key));
  return `${names.join(", ")}${fields.length > max ? ", …" : ""}`;
}

/**
 * Replace template expressions with readable placeholders:
 * "Shortlist {{ steps.profile.full_name | default:'candidate' }}?" → "Shortlist ‹full name›?"
 */
export function plainTemplate(text: string): string {
  return text.replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (_m, expr: string) => {
    const path = expr.trim().split(/\s*(\|\||&&|\?\?)\s*/)[0] ?? expr;
    const last = path.split(".").filter(Boolean).pop() ?? path;
    return `‹${humanize(last).toLowerCase()}›`;
  });
}

/** Plain-language description of a workflow step (mirrors the builder's wording). */
export function describeStep(step: WorkflowStep): string {
  switch (step.type) {
    case "extract":
      return "Read the document (OCR for scans and photos)";
    case "llm.extract":
      return `Extract ${step.fields.length} field${step.fields.length === 1 ? "" : "s"}: ${fieldNames(step.fields)}`;
    case "llm.classify":
      return `Classify into ${step.categories.map((c) => c.label ?? c.value).join(" / ")}`;
    case "llm.evaluate": {
      const must = step.criteria.filter((c) => c.kind === "must").length;
      const knockout = step.criteria.filter((c) => c.kind === "knockout").length;
      return `Score against ${step.criteria.length} criteria (${must} must-have, ${knockout} deal-breaker)`;
    }
    case "llm.generate":
      return "Write a summary or draft";
    case "knowledge.search":
      return "Look up reference information in the knowledge base";
    case "connector":
      return `${humanize(step.operation)} in ${step.connector.toUpperCase()}${step.requiresApproval ? " (after approval)" : ""}`;
    case "approval":
      return `Ask a person to approve: ${plainTemplate(step.title)}`;
    case "mail.send":
      return "Send an email (after approval)";
    case "excel.read":
      return "Read the spreadsheet";
    case "excel.write":
      return "Produce an Excel file";
    case "agent":
      return "Work autonomously with its tools";
    case "wait":
      if (step.for === "reply") return `Wait for a reply${step.days ? ` (at most ${step.days} day${step.days === 1 ? "" : "s"})` : ""}`;
      return step.days ? `Wait ${step.days} day${step.days === 1 ? "" : "s"}` : "Wait until the set date";
    case "output":
      return "Show the result";
  }
}

export const STEP_TYPE_LABELS: Record<WorkflowStep["type"], string> = {
  extract: "Read document",
  "llm.extract": "Extract data",
  "llm.classify": "Classify",
  "llm.evaluate": "Evaluate",
  "llm.generate": "Generate",
  "knowledge.search": "Knowledge search",
  connector: "System action",
  approval: "Human approval",
  "mail.send": "Send email",
  "excel.read": "Read Excel",
  "excel.write": "Write Excel",
  agent: "Autonomous agent",
  wait: "Wait",
  output: "Result",
};

export const PERSONAL_DATA_LABELS: Record<string, string> = {
  none: "No personal data",
  contains: "Contains personal data",
  sensitive: "Sensitive personal data",
};

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "tr", label: "Türkçe" },
];

export function approvalRuleLabel(rule: string): string {
  const map: Record<string, string> = {
    "mail.send": "Sending email",
    "connector:write": "Changing data in business systems",
    decision: "Decisions",
  };
  return map[rule] ?? humanize(rule.replace(/[:.]/g, " "));
}
