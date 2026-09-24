import type { AgentDefinitionInput, Archetype, Category, Criterion, FieldSpec, WorkflowStep } from "@enterprise-brain/core";

/**
 * Archetype blueprints: the default agent shape used when no catalog template
 * matches the request. Generation fills in fields, criteria, categories and
 * integrations collected during the interview.
 */
export interface BlueprintParts {
  name: string;
  slug: string;
  summary: string;
  instructions: string;
  fileKey: string;
  extractionFields: FieldSpec[];
  outputFields: FieldSpec[];
  criteria: Criterion[];
  categories: Category[];
  reply: "draft" | "auto-simple" | "none";
  transformation?: string;
  knowledgeCollection?: string;
  targetBinding?: { ref: string; category: string };
  passScore?: number;
}

const DEFAULT_MAIL_CATEGORIES: Category[] = [
  { value: "request", label: "Request / question", keywords: ["question", "request", "how", "can you", "soru", "talep"] },
  { value: "complaint", label: "Complaint", keywords: ["complaint", "unhappy", "problem", "şikayet", "sorun"] },
  { value: "order", label: "Order / delivery", keywords: ["order", "delivery", "shipment", "sipariş", "teslimat", "kargo"] },
  { value: "invoice", label: "Invoice / payment", keywords: ["invoice", "payment", "fatura", "ödeme"] },
  { value: "other", label: "Other" },
];

function extractionTarget(fields: FieldSpec[]): FieldSpec[] {
  return fields.length ? fields : [{ key: "summary", label: "Summary", type: "text" }];
}

export function blueprint(archetype: Archetype, parts: BlueprintParts): AgentDefinitionInput {
  const common = {
    slug: parts.slug,
    name: parts.name,
    summary: parts.summary,
    archetype,
    instructions: parts.instructions,
    knowledge: { collections: parts.knowledgeCollection ? [parts.knowledgeCollection] : [] },
  };
  const knowledgeStep: WorkflowStep[] = parts.knowledgeCollection
    ? [{ id: "reference", type: "knowledge.search", query: "{{ steps.fields | json | truncate: 800 }}", collections: [parts.knowledgeCollection], topK: 4 }]
    : [];

  switch (archetype) {
    case "document-processing": {
      const fields = extractionTarget(parts.extractionFields);
      const steps: WorkflowStep[] = [
        { id: "extract", name: "Read document", type: "extract", from: `{{ input.${parts.fileKey} || input.email.attachments }}` },
        { id: "fields", name: "Extract information", type: "llm.extract", from: "{{ steps.extract.text }}", fields },
        ...knowledgeStep,
      ];
      if (parts.criteria.length) {
        steps.push({
          id: "evaluate",
          name: "Evaluate against criteria",
          type: "llm.evaluate",
          from: "{{ steps.fields | json }}\n\n{{ steps.extract.text | truncate: 20000 }}",
          criteria: parts.criteria,
          ...(parts.knowledgeCollection ? { context: "{{ steps.reference.context }}" } : {}),
          passScore: parts.passScore ?? 70,
        });
      }
      if (parts.targetBinding) {
        steps.push({
          id: "record",
          name: "Record the result in the target system",
          type: "agent",
          task:
            "Record this processed document in the connected system using the available tools. Extracted data:\n{{ steps.fields | json }}" +
            (parts.criteria.length ? "\nEvaluation: {{ steps.evaluate.verdict }} ({{ steps.evaluate.score }}/100)" : ""),
          tools: [`connector:${parts.targetBinding.ref}`],
          maxTurns: 6,
        });
      }
      steps.push({
        id: "summary",
        name: "Write summary",
        type: "llm.generate",
        prompt:
          "Write a short summary (4-6 sentences) of this document for the person reviewing it, highlighting what matters for the decision.\n\nData: {{ steps.fields | json }}" +
          (parts.criteria.length ? "\nEvaluation: {{ steps.evaluate | json }}" : ""),
        fallback:
          (parts.criteria.length
            ? "Assessment: {{ steps.evaluate.verdict }} ({{ steps.evaluate.score }}/100). {{ steps.evaluate.summary }}"
            : "Extracted {{ steps.fields | length }} fields from {{ steps.extract.fileName }}."),
      });
      const value: Record<string, unknown> = {};
      for (const f of parts.outputFields) {
        value[f.key] = fields.some((x) => x.key === f.key) ? `{{ steps.fields.${f.key} }}` : undefined;
      }
      for (const f of fields) value[f.key] ??= `{{ steps.fields.${f.key} }}`;
      if (parts.criteria.length) {
        Object.assign(value, {
          score: "{{ steps.evaluate.score }}",
          verdict: "{{ steps.evaluate.verdict }}",
          strengths: "{{ steps.evaluate.strengths }}",
          gaps: "{{ steps.evaluate.gaps }}",
        });
      }
      value.summary = "{{ steps.summary.text }}";
      for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
      steps.push({ id: "result", type: "output", value });
      const outputs: FieldSpec[] = [
        ...fields,
        ...(parts.criteria.length
          ? ([
              { key: "score", label: "Score", type: "number" },
              { key: "verdict", label: "Verdict", type: "select", options: [{ value: "pass" }, { value: "review" }, { value: "fail" }] },
              { key: "strengths", label: "Strengths", type: "list", itemType: "string" },
              { key: "gaps", label: "Gaps", type: "list", itemType: "string" },
            ] satisfies FieldSpec[])
          : []),
        { key: "summary", label: "Summary", type: "text" },
      ];
      return {
        ...common,
        inputs: [
          { key: parts.fileKey, label: "Document", type: "file", required: true, accept: [".pdf", ".docx", ".png", ".jpg", ".jpeg", ".txt"] },
          { key: "notes", label: "Notes", type: "text" },
        ],
        outputs: dedupeFields(outputs),
        workflow: steps,
        tools: ["knowledge.search", "documents.read"],
        triggers: [{ type: "manual" }, { type: "form" }],
        connectors: parts.targetBinding ? [{ ...parts.targetBinding, purpose: "Record processed documents" }] : [],
        ui: { layout: "form-results", highlight: outputs.slice(0, 4).map((f) => f.key) },
      };
    }
    case "mail-triage": {
      const categories = parts.categories.length ? parts.categories : DEFAULT_MAIL_CATEGORIES;
      const steps: WorkflowStep[] = [
        {
          id: "classify",
          name: "Classify email",
          type: "llm.classify",
          from: "Subject: {{ input.email.subject }}\nFrom: {{ input.email.from }}\n\n{{ input.email.body }}",
          categories,
        },
        {
          id: "fields",
          name: "Extract key facts",
          type: "llm.extract",
          from: "Subject: {{ input.email.subject }}\n\n{{ input.email.body }}",
          fields: extractionTarget(
            parts.extractionFields.length
              ? parts.extractionFields
              : [
                  { key: "sender_name", label: "Sender name", type: "string" },
                  { key: "request_summary", label: "What the sender wants", type: "text" },
                  { key: "reference_numbers", label: "Order/invoice/ticket numbers", type: "list", itemType: "string" },
                  { key: "urgency", label: "Urgency", type: "select", options: [{ value: "low" }, { value: "normal" }, { value: "high" }] },
                ],
          ),
        },
      ];
      if (parts.knowledgeCollection) {
        steps.push({ id: "reference", type: "knowledge.search", query: "{{ input.email.subject }} {{ steps.fields.request_summary }}", collections: [parts.knowledgeCollection], topK: 4 });
      }
      if (parts.reply !== "none") {
        steps.push({
          id: "draft",
          name: "Draft reply",
          type: "llm.generate",
          prompt:
            "Draft a reply to this email in the sender's language. Be accurate, friendly and brief; do not promise anything the sources do not support.\n\nEmail:\nSubject: {{ input.email.subject }}\n{{ input.email.body }}\n\nCategory: {{ steps.classify.category }}" +
            (parts.knowledgeCollection ? "\n\nRelevant knowledge:\n{{ steps.reference.context }}" : ""),
          fallback:
            "Dear {{ steps.fields.sender_name | default: 'customer' }},\n\nThank you for your message regarding \"{{ input.email.subject }}\". We have received it and our team will get back to you shortly.\n\nKind regards",
        });
        steps.push({
          id: "reply",
          name: "Send reply",
          type: "mail.send",
          to: "{{ input.email.from }}",
          subject: "Re: {{ input.email.subject }}",
          body: "{{ steps.draft.text }}",
          inReplyTo: "{{ input.email.id }}",
          ...(parts.reply === "auto-simple" ? {} : { requiresApproval: true }),
        });
      }
      steps.push({
        id: "result",
        type: "output",
        value: {
          category: "{{ steps.classify.category }}",
          confidence: "{{ steps.classify.confidence }}",
          urgency: "{{ steps.fields.urgency }}",
          summary: "{{ steps.fields.request_summary }}",
          ...(parts.reply !== "none" ? { draft_reply: "{{ steps.draft.text }}" } : {}),
        },
      });
      return {
        ...common,
        inputs: [{ key: "email", label: "Email", type: "object", required: true }],
        outputs: [
          { key: "category", type: "select", options: categories.map((c) => ({ value: c.value, label: c.label })) },
          { key: "confidence", type: "number" },
          { key: "urgency", type: "string" },
          { key: "summary", type: "text" },
          ...(parts.reply !== "none" ? ([{ key: "draft_reply", label: "Draft reply", type: "text" }] satisfies FieldSpec[]) : []),
        ],
        workflow: steps,
        tools: ["knowledge.search", "mail.draft"],
        triggers: [{ type: "manual" }],
        ui: { layout: "inbox", highlight: ["category", "urgency", "summary"] },
      };
    }
    case "conversational":
    case "search":
      return {
        ...common,
        inputs: [{ key: "question", type: "text", required: true }],
        outputs: [{ key: "answer", type: "text" }],
        workflow: [],
        tools: ["knowledge.search", ...(parts.targetBinding ? [`connector:${parts.targetBinding.ref}`] : [])],
        triggers: [{ type: "chat" }, { type: "manual" }],
        connectors: parts.targetBinding ? [{ ...parts.targetBinding, purpose: "Look up records" }] : [],
        ui: { layout: "chat" },
      };
    case "excel-automation":
      return {
        ...common,
        inputs: [
          { key: "workbook", label: "Workbook", type: "file", required: true, accept: [".xlsx", ".csv"] },
          { key: "instructions", label: "Anything special this time?", type: "text" },
        ],
        outputs: [
          { key: "summary", type: "text" },
          { key: "rows_read", label: "Rows read", type: "number" },
        ],
        workflow: [
          { id: "read", name: "Read workbook", type: "excel.read", from: "{{ input.workbook }}" },
          {
            id: "transform",
            name: "Transform",
            type: "agent",
            task:
              `Process the workbook (file id {{ input.workbook }}) as follows:\n${parts.transformation ?? "Follow the user's instructions."}\n\nUser instructions: {{ input.instructions | default: 'none' }}\n\nUse excel_read to inspect the data and excel_write to produce the result workbook. Report what you changed and any rows that need attention.`,
            tools: ["excel.read", "excel.write"],
            maxTurns: 10,
          },
          { id: "result", type: "output", value: { summary: "{{ steps.transform.text }}", rows_read: "{{ steps.read.rows | length }}" } },
        ],
        tools: ["excel.read", "excel.write"],
        triggers: [{ type: "manual" }, { type: "form" }],
        ui: { layout: "form-results", highlight: ["summary"] },
      };
    case "process-automation":
    case "report-generation":
      return {
        ...common,
        inputs: [{ key: "request", label: "Request", type: "text" }],
        outputs: [{ key: "result", type: "text" }],
        workflow: [
          {
            id: "work",
            name: archetype === "report-generation" ? "Prepare report" : "Carry out the process",
            type: "agent",
            task: `${parts.transformation ?? parts.summary}\n\nRequest: {{ input.request | default: 'scheduled run' }}`,
            tools: ["knowledge.search", ...(parts.targetBinding ? [`connector:${parts.targetBinding.ref}`] : [])],
            maxTurns: 12,
          },
          { id: "result", type: "output", value: { result: "{{ steps.work.text }}" } },
        ],
        tools: ["knowledge.search"],
        triggers: [{ type: "manual" }],
        connectors: parts.targetBinding ? [{ ...parts.targetBinding, purpose: "Business system used by the process" }] : [],
        ui: { layout: "table", highlight: ["result"] },
      };
  }
}

export function dedupeFields(fields: FieldSpec[]): FieldSpec[] {
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}
