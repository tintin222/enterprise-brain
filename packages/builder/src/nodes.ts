import type { AgentTemplate, Archetype, FieldSpec, RequirementNode, RequirementNodeInput } from "@enterprise-brain/core";
import { createNode } from "./tree.ts";

/**
 * The analyst's question bank. Base nodes apply to every agent; archetype
 * nodes add the domain questions an experienced analyst would ask for that
 * kind of agent; template nodes (from the catalog) add process specifics.
 */

export const CHANNEL_OPTIONS = [
  { value: "email", label: "Email to a mailbox", description: "e.g. a shared mailbox such as careers@ or invoices@" },
  { value: "upload", label: "Someone uploads files in a form", description: "a simple upload screen for your team" },
  { value: "system", label: "From a business system", description: "e.g. HR system, ERP, CRM" },
  { value: "shared-folder", label: "A shared folder or SFTP server", description: "files land on a network drive, or a partner drops them on SFTP" },
  { value: "web-form", label: "A form on our website", description: "e.g. the careers page" },
  { value: "chat", label: "People ask questions in a chat", description: "an assistant employees or customers talk to" },
];

export const DESTINATION_OPTIONS = [
  { value: "screen", label: "Shown on its page", description: "a results table your team works from" },
  { value: "email", label: "Emailed to someone" },
  { value: "system", label: "Written into a business system", description: "e.g. ATS, ERP, CRM" },
  { value: "excel", label: "An Excel report" },
  { value: "task", label: "A task for a person or another AI employee", description: "e.g. a Paperclip task" },
];

const ARCHETYPE_CHANNELS: Record<Archetype, string[]> = {
  "document-processing": ["upload", "email"],
  "mail-triage": ["email"],
  conversational: ["chat"],
  "excel-automation": ["upload"],
  search: ["chat"],
  "process-automation": ["system"],
  "report-generation": ["system"],
};

const ARCHETYPE_DESTINATIONS: Record<Archetype, string[]> = {
  "document-processing": ["screen", "system"],
  "mail-triage": ["screen", "email"],
  conversational: ["screen"],
  "excel-automation": ["excel"],
  search: ["screen"],
  "process-automation": ["system", "task"],
  "report-generation": ["excel", "email"],
};

const ARCHETYPE_UI: Record<Archetype, string> = {
  "document-processing": "form-results",
  "mail-triage": "inbox",
  conversational: "chat",
  "excel-automation": "form-results",
  search: "chat",
  "process-automation": "table",
  "report-generation": "table",
};

export interface NodeContext {
  archetype: Archetype;
  template?: AgentTemplate;
  agentName?: string;
  recommendedFields?: FieldSpec[];
  /** The company's mail domain, for recommending the template's mailbox (careers@company.com -> careers@acme.com.tr). */
  mailDomain?: string;
}

function templateMailbox(ctx: NodeContext): string | undefined {
  const trigger = ctx.template?.triggers.find((t) => t.type === "mailbox");
  if (!trigger || trigger.type !== "mailbox" || trigger.mailbox === "*") return undefined;
  return ctx.mailDomain ? trigger.mailbox.replace(/@company\.com$/i, `@${ctx.mailDomain.toLowerCase()}`) : trigger.mailbox;
}

function node(input: RequirementNodeInput, source: RequirementNode["source"] = "base"): RequirementNode {
  return createNode(input, source);
}

export function baseNodes(ctx: NodeContext): RequirementNode[] {
  const t = ctx.template;
  const outputFields = ctx.recommendedFields ?? t?.outputs ?? [];
  return [
    node({
      id: "purpose.goal",
      section: "purpose",
      title: "Goal",
      question: "In one or two sentences: what problem should this AI employee solve, and what does a good result look like?",
      why: "Everything else is designed backwards from this.",
      answerType: "text",
      priority: 10,
    }),
    node({
      id: "purpose.name",
      section: "purpose",
      title: "Name",
      question: "What should we call it?",
      answerType: "text",
      recommended: ctx.agentName ?? t?.name,
      prerequisites: ["purpose.goal"],
      priority: 20,
    }),
    node({
      id: "purpose.out_of_scope",
      section: "purpose",
      title: "Out of scope",
      question: "Is there anything it must never do or decide on its own?",
      why: "Clear boundaries keep decisions that belong to people with people.",
      answerType: "text",
      recommended: "It must not take final decisions about people or money; it prepares, a human decides.",
      prerequisites: ["purpose.goal"],
      priority: 30,
    }),
    node({
      id: "users.primary",
      section: "users",
      title: "Users",
      question: "Who will work with its results day to day, and who is accountable for its decisions?",
      why: "Determines who reviews results, who approves actions and who gets notified.",
      answerType: "text",
      prerequisites: ["purpose.goal"],
      priority: 10,
    }),
    node({
      id: "inputs.channels",
      section: "inputs",
      title: "Where inputs come from",
      question: "Where does the work it will do come from today? (pick all that apply)",
      why: "Each source is an integration: some are ready immediately, others need IT to grant access.",
      answerType: "multi",
      options: CHANNEL_OPTIONS,
      recommended: ARCHETYPE_CHANNELS[ctx.archetype],
      prerequisites: ["purpose.goal"],
      priority: 10,
    }),
    node({
      id: "inputs.samples",
      section: "inputs",
      title: "Real examples",
      question:
        "Please upload 3–5 real examples of what it will receive (anonymised if needed). I'll analyse formats, languages and content so you don't have to describe them.",
      why: "Real samples reveal edge cases (scans, photos, other languages) that descriptions miss, and become its test cases.",
      answerType: "files",
      recommended: "upload",
      prerequisites: ["inputs.channels"],
      priority: 20,
    }),
    node({
      id: "inputs.formats",
      section: "inputs",
      title: "Formats & languages",
      question: "Which file formats and languages do the inputs come in?",
      why: "Scanned documents need OCR; mixed languages change how results are written.",
      kind: "fact",
      answerType: "text",
      prerequisites: ["inputs.samples"],
      priority: 30,
    }),
    node({
      id: "inputs.mailbox",
      section: "inputs",
      title: "Mailbox",
      question: "Which mailbox address receives these emails?",
      answerType: "text",
      recommended: templateMailbox(ctx),
      when: { node: "inputs.channels", op: "includes", value: "email" },
      priority: 40,
    }),
    node({
      id: "inputs.system",
      section: "inputs",
      title: "Source system",
      question: "Which business system holds the inputs (product name if you know it), and which records does it need?",
      answerType: "text",
      when: { node: "inputs.channels", op: "includes", value: "system" },
      priority: 40,
    }),
    node({
      id: "inputs.form",
      section: "inputs",
      title: "Form fields",
      question: "What should people fill in (besides attaching the file) when they submit an item?",
      why: "This becomes its form. Keep it short: every field is work for the user.",
      answerType: "fields",
      when: { any: [{ node: "inputs.channels", op: "includes", value: "upload" }, { node: "inputs.channels", op: "includes", value: "web-form" }] },
      recommended: t?.inputs.filter((f) => f.type !== "file" && f.type !== "files" && f.key !== "email").map((f) => f.label ?? f.key) ?? [],
      priority: 50,
    }),
    node({
      id: "processing.reference",
      section: "processing",
      title: "Reference information",
      question:
        "Is there reference information it must use to decide (e.g. job descriptions, price lists, policies)? Where does it live?",
      why: "Reference documents go into its knowledge so it decides like your experts do.",
      answerType: "text",
      prerequisites: ["purpose.goal"],
      priority: 20,
    }),
    node({
      id: "outputs.fields",
      section: "outputs",
      title: "What the result contains",
      question: "What should the result for each item contain?",
      why: "These become the columns of the results screen and the data written to other systems.",
      answerType: "fields",
      recommended: outputFields.map((f) => f.label ?? f.key),
      prerequisites: ["purpose.goal", "inputs.samples"],
      priority: 10,
    }),
    node({
      id: "outputs.destination",
      section: "outputs",
      title: "Where results go",
      question: "Where should the results end up? (pick all that apply)",
      answerType: "multi",
      options: DESTINATION_OPTIONS,
      recommended: ARCHETYPE_DESTINATIONS[ctx.archetype],
      prerequisites: ["outputs.fields"],
      priority: 20,
    }),
    node({
      id: "outputs.system",
      section: "outputs",
      title: "Target system",
      question: "Which system should results be written to, and what exactly should be created or updated there?",
      answerType: "text",
      when: { node: "outputs.destination", op: "includes", value: "system" },
      priority: 30,
    }),
    node({
      id: "actions.follow_up",
      section: "actions",
      title: "Follow-up actions",
      question: "After an item is processed, what should happen next? Who is notified or contacted?",
      why: "Follow-ups are where time is saved — and where mistakes are visible to people outside, so we also decide approvals.",
      answerType: "text",
      prerequisites: ["outputs.destination"],
      priority: 10,
    }),
    node({
      id: "actions.approval",
      section: "actions",
      title: "What it does alone at first",
      question: "How much may it do alone at first? You can move it up once it has proved itself.",
      why: "New AI employees start on probation: a person checks their changes (emails, system updates, decisions about people) until they have a track record.",
      answerType: "single",
      options: [
        { value: "shadow", label: "Shadow: it prepares drafts, and a person checks every finished task" },
        { value: "supervised", label: "Supervised: it reads, sorts and drafts alone; a person approves every change", description: "recommended to start" },
        { value: "trusted", label: "Trusted: it acts alone within limits you set, and asks above them" },
      ],
      recommended: "supervised",
      prerequisites: ["actions.follow_up"],
      priority: 20,
    }),
    ...integrationNodes(),
    node({
      id: "governance.personal_data",
      section: "governance",
      title: "Personal data",
      question: "Will it see personal data?",
      why: "Personal data (KVKK/GDPR) needs a legal basis, limited retention and restricted access.",
      answerType: "single",
      options: [
        { value: "none", label: "No personal data" },
        { value: "contains", label: "Yes — names, contact details, work history" },
        { value: "sensitive", label: "Yes — sensitive data (health, religion, criminal records, IDs)" },
      ],
      recommended: t?.guardrails.personalData ?? (ctx.archetype === "document-processing" ? "contains" : "none"),
      prerequisites: ["inputs.channels"],
      priority: 10,
    }),
    node({
      id: "governance.retention",
      section: "governance",
      title: "Retention",
      question: "How long may it keep the data it processes?",
      why: "Retention must match your data protection policy; the DPO usually decides.",
      answerType: "single",
      allowOther: true,
      options: [
        { value: "30", label: "30 days" },
        { value: "180", label: "6 months" },
        { value: "365", label: "1 year" },
        { value: "policy", label: "Follow the company policy (ask the DPO)" },
      ],
      recommended: "180",
      owner: "dpo",
      delegable: true,
      when: { node: "governance.personal_data", op: "neq", value: "none" },
      priority: 20,
    }),
    node({
      id: "governance.legal_basis",
      section: "governance",
      title: "Legal basis",
      question: "What is the legal basis for processing this personal data (e.g. applicant consent / privacy notice)?",
      why: "Required under KVKK/GDPR before personal data is processed automatically.",
      answerType: "text",
      owner: "dpo",
      delegable: true,
      when: { node: "governance.personal_data", op: "neq", value: "none" },
      priority: 30,
    }),
    node({
      id: "governance.access",
      section: "governance",
      title: "Who may see results",
      question: "Who may see its results?",
      answerType: "text",
      prerequisites: ["users.primary"],
      priority: 40,
    }),
    node({
      id: "ui.layout",
      section: "ui",
      title: "How people use it",
      question: "How should your team work with it?",
      why: "Hard to decide by talking — I'll show you a live preview of the screen as we go.",
      answerType: "single",
      options: [
        { value: "form-results", label: "An upload form with a results table" },
        { value: "inbox", label: "An inbox view of processed emails" },
        { value: "chat", label: "A chat" },
        { value: "table", label: "A results table only (items arrive automatically)" },
        { value: "none", label: "No screen — it works in the background" },
      ],
      recommended: t?.ui.layout ?? ARCHETYPE_UI[ctx.archetype],
      prerequisites: ["inputs.channels", "outputs.fields"],
      priority: 10,
    }),
    node({
      id: "operations.volume",
      section: "operations",
      title: "Volume",
      question: "Roughly how many items per week, and are there peaks?",
      why: "Sizes cost and tells us whether batching or real-time processing fits.",
      answerType: "single",
      allowOther: true,
      options: [
        { value: "low", label: "Fewer than 50 per week" },
        { value: "medium", label: "50–500 per week" },
        { value: "high", label: "More than 500 per week" },
      ],
      recommended: "medium",
      prerequisites: ["inputs.channels"],
      priority: 10,
    }),
    node({
      id: "operations.sla",
      section: "operations",
      title: "Turnaround",
      question: "How quickly must a result be ready after an item arrives?",
      answerType: "single",
      allowOther: true,
      options: [
        { value: "minutes", label: "Within minutes" },
        { value: "same-day", label: "Same day" },
        { value: "next-day", label: "Next working day" },
      ],
      recommended: "minutes",
      prerequisites: ["operations.volume"],
      priority: 20,
    }),
    node({
      id: "operations.success",
      section: "operations",
      title: "Success measure",
      question: "How will you know it is doing well after a month?",
      answerType: "text",
      recommended: t?.kpis.map((k) => k.name).join("; ") || undefined,
      prerequisites: ["purpose.goal"],
      priority: 30,
    }),
    node({
      id: "operations.language",
      section: "operations",
      title: "Output language",
      question: "In which language should it write its results?",
      answerType: "single",
      allowOther: true,
      options: [
        { value: "input", label: "Same language as the input" },
        { value: "en", label: "English" },
        { value: "tr", label: "Turkish" },
      ],
      recommended: "input",
      prerequisites: ["inputs.formats"],
      priority: 40,
    }),
  ];
}

/**
 * Integration nodes are fact-first: the builder checks configured connectors.
 * When a system is not connected yet, the node becomes a question owned by IT,
 * which the requester can delegate with one click (an IT request is drafted).
 */
export function integrationNodes(): RequirementNode[] {
  const accessOptions = [
    { value: "ask-it", label: "Ask IT on my behalf", description: "I'll draft the request email for you" },
    { value: "i-will-arrange", label: "I'll arrange access myself" },
    { value: "manual-for-now", label: "Start with manual upload / sandbox until it's connected" },
  ];
  return [
    node({
      id: "integration.mail",
      section: "integrations",
      title: "Mailbox access",
      question:
        "It needs read access to the mailbox (and send/reply rights if it answers). This mailbox isn't connected yet — how should we get access?",
      why: "Mail access is granted by IT (e.g. a Microsoft 365 app registration with Mail.Read/Mail.Send, limited to this mailbox).",
      kind: "fact",
      answerType: "single",
      options: accessOptions,
      recommended: "ask-it",
      owner: "it",
      delegable: true,
      when: { node: "inputs.channels", op: "includes", value: "email" },
      prerequisites: ["inputs.mailbox"],
      priority: 10,
    }),
    node({
      id: "integration.source_system",
      section: "integrations",
      title: "Source system access",
      question: "It needs read access to the source system, which isn't connected yet. How should we get access?",
      why: "System access means an API user or integration (e.g. SAP communication arrangement, SuccessFactors OData user) that IT provides.",
      kind: "fact",
      answerType: "single",
      options: accessOptions,
      recommended: "ask-it",
      owner: "it",
      delegable: true,
      when: { node: "inputs.channels", op: "includes", value: "system" },
      prerequisites: ["inputs.system"],
      priority: 20,
    }),
    node({
      id: "integration.target_system",
      section: "integrations",
      title: "Target system access",
      question: "To write results into the target system it needs an integration user with write rights. How should we get it?",
      why: "Write access is sensitive: IT usually grants it to a dedicated technical user with minimal rights.",
      kind: "fact",
      answerType: "single",
      options: accessOptions,
      recommended: "ask-it",
      owner: "it",
      delegable: true,
      when: { node: "outputs.destination", op: "includes", value: "system" },
      prerequisites: ["outputs.system"],
      priority: 30,
    }),
    node({
      id: "integration.shared_folder",
      section: "integrations",
      title: "Folder access",
      question: "It needs access to the folder the files land in (a network drive or an SFTP server). How should we get it?",
      kind: "fact",
      answerType: "single",
      options: accessOptions,
      recommended: "ask-it",
      owner: "it",
      delegable: true,
      when: { node: "inputs.channels", op: "includes", value: "shared-folder" },
      priority: 40,
    }),
    node({
      id: "integration.web_form",
      section: "integrations",
      title: "Website form",
      question: "Submissions from the website form must be forwarded to it (a webhook). Who maintains the website?",
      kind: "fact",
      answerType: "single",
      options: accessOptions,
      recommended: "ask-it",
      owner: "it",
      delegable: true,
      when: { node: "inputs.channels", op: "includes", value: "web-form" },
      priority: 50,
    }),
  ];
}

export function archetypeNodes(archetype: Archetype, template?: AgentTemplate): RequirementNode[] {
  const evaluate = template?.workflow.find((s) => s.type === "llm.evaluate");
  const classify = template?.workflow.find((s) => s.type === "llm.classify");
  const extract = template?.workflow.find((s) => s.type === "llm.extract");
  switch (archetype) {
    case "document-processing":
      return [
        node(
          {
            id: "docs.types",
            section: "inputs",
            title: "Document types",
            question: "Which kinds of documents will it receive?",
            answerType: "text",
            prerequisites: ["purpose.goal"],
            priority: 15,
          },
          "archetype",
        ),
        node(
          {
            id: "docs.fields",
            section: "processing",
            title: "Information to extract",
            question: "Which pieces of information should be taken from each document?",
            why: "I've pre-filled this from your samples; remove what you don't need and add what's missing.",
            answerType: "fields",
            recommended: extract && "fields" in extract ? extract.fields.map((f) => f.label ?? f.key) : undefined,
            prerequisites: ["inputs.samples"],
            priority: 10,
          },
          "archetype",
        ),
        node(
          {
            id: "docs.criteria",
            section: "processing",
            title: "Decision criteria",
            question:
              "How should each document be judged? List the criteria — mark must-haves, nice-to-haves and deal-breakers.",
            why: "These become an explainable scorecard: every decision shows which criteria were met and the evidence.",
            answerType: "criteria",
            recommended: evaluate && "criteria" in evaluate ? evaluate.criteria.map((c) => `${c.label} (${c.kind})`) : undefined,
            prerequisites: ["docs.fields"],
            priority: 20,
          },
          "archetype",
        ),
      ];
    case "mail-triage":
      return [
        node(
          {
            id: "mail.categories",
            section: "processing",
            title: "Email categories",
            question: "Which categories should incoming emails be sorted into?",
            answerType: "categories",
            recommended: classify && "categories" in classify ? classify.categories.map((c) => c.label ?? c.value) : undefined,
            prerequisites: ["inputs.samples"],
            priority: 10,
          },
          "archetype",
        ),
        node(
          {
            id: "mail.reply_policy",
            section: "actions",
            title: "Replies",
            question: "Should it answer emails?",
            answerType: "single",
            options: [
              { value: "draft", label: "Draft replies for a person to approve", description: "recommended to start" },
              { value: "auto-simple", label: "Reply automatically to simple categories, draft the rest" },
              { value: "none", label: "Never reply — only classify and route" },
            ],
            recommended: "draft",
            prerequisites: ["mail.categories"],
            priority: 5,
          },
          "archetype",
        ),
        node(
          {
            id: "mail.routing",
            section: "actions",
            title: "Routing",
            question: "Who should handle each category (team or person)?",
            answerType: "text",
            prerequisites: ["mail.categories"],
            priority: 6,
          },
          "archetype",
        ),
      ];
    case "conversational":
    case "search":
      return [
        node(
          {
            id: "chat.audience",
            section: "users",
            title: "Audience",
            question: "Who will talk to the assistant?",
            answerType: "single",
            options: [
              { value: "employees", label: "Employees" },
              { value: "customers", label: "Customers" },
              { value: "partners", label: "Partners / suppliers" },
            ],
            recommended: "employees",
            prerequisites: ["purpose.goal"],
            priority: 20,
          },
          "archetype",
        ),
        node(
          {
            id: "chat.sources",
            section: "processing",
            title: "Knowledge sources",
            question: "Which documents, policies or systems should it answer from? You can upload them here.",
            answerType: "text",
            prerequisites: ["purpose.goal"],
            priority: 10,
          },
          "archetype",
        ),
        node(
          {
            id: "chat.handoff",
            section: "actions",
            title: "Hand-off",
            question: "When the assistant can't answer, who should take over and how?",
            answerType: "text",
            prerequisites: ["chat.audience"],
            priority: 10,
          },
          "archetype",
        ),
      ];
    case "excel-automation":
      return [
        node(
          {
            id: "excel.transformation",
            section: "processing",
            title: "What happens to the data",
            question: "Walk me through what you do with the spreadsheet today, step by step (filters, lookups, calculations, checks).",
            answerType: "text",
            prerequisites: ["inputs.samples"],
            priority: 10,
          },
          "archetype",
        ),
        node(
          {
            id: "excel.output",
            section: "outputs",
            title: "Resulting file",
            question: "What should the resulting file look like (sheets, columns, highlights)?",
            answerType: "text",
            prerequisites: ["excel.transformation"],
            priority: 5,
          },
          "archetype",
        ),
        node(
          {
            id: "excel.schedule",
            section: "operations",
            title: "When it runs",
            question: "When should it run?",
            answerType: "single",
            options: [
              { value: "on-demand", label: "When someone uploads a file" },
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "Every week" },
              { value: "monthly", label: "Every month (e.g. month-end)" },
            ],
            recommended: "on-demand",
            prerequisites: ["excel.transformation"],
            priority: 15,
          },
          "archetype",
        ),
      ];
    case "process-automation":
    case "report-generation":
      return [
        node(
          {
            id: "process.steps",
            section: "processing",
            title: "Process today",
            question: "Walk me through how this is done today, step by step, including who does what.",
            answerType: "text",
            prerequisites: ["purpose.goal"],
            priority: 5,
          },
          "archetype",
        ),
        node(
          {
            id: "process.exceptions",
            section: "processing",
            title: "Exceptions",
            question: "What goes wrong or needs special handling, and what do people do then?",
            answerType: "text",
            prerequisites: ["process.steps"],
            priority: 15,
          },
          "archetype",
        ),
        node(
          {
            id: "process.schedule",
            section: "operations",
            title: "When it runs",
            question: "Should this run on a schedule, when something happens, or on request?",
            answerType: "single",
            options: [
              { value: "on-demand", label: "On request" },
              { value: "event", label: "When something happens (e.g. new record)" },
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "Every week" },
              { value: "monthly", label: "Every month" },
            ],
            recommended: archetype === "report-generation" ? "weekly" : "event",
            prerequisites: ["process.steps"],
            priority: 15,
          },
          "archetype",
        ),
      ];
  }
}

export function templateNodes(template: AgentTemplate): RequirementNode[] {
  return template.builder.questions.map((q) =>
    createNode({ ...q, prerequisites: q.prerequisites?.length ? q.prerequisites : ["purpose.goal"] }, "template"),
  );
}

export function buildInitialNodes(ctx: NodeContext): RequirementNode[] {
  const fromTemplate = ctx.template ? templateNodes(ctx.template) : [];
  // A template question can replace a generic one (e.g. its own scoring criteria instead of docs.criteria).
  const replacedBy = new Map<string, string>();
  for (const node of fromTemplate) for (const id of node.replaces ?? []) replacedBy.set(id, node.id);
  const nodes = [...baseNodes(ctx), ...archetypeNodes(ctx.archetype, ctx.template)].filter((n) => !replacedBy.has(n.id));
  for (const templateNode of fromTemplate) {
    if (!nodes.some((n) => n.id === templateNode.id)) nodes.push(templateNode);
  }
  // Questions that waited for a replaced one now wait for its replacement.
  return nodes.map((n) => ({ ...n, prerequisites: n.prerequisites.map((p) => replacedBy.get(p) ?? p).filter((p) => p !== n.id) }));
}
