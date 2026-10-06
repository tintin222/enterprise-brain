import { z } from "zod";

/**
 * The company brain: what the company knows about itself, as things (people, processes, systems,
 * clients, projects…) and the links between them, plus a stream of what happens. Kinds and links
 * are described here, once; the server, the web app and the AI employees all read them from here.
 */

export const BRAIN_DIMENSIONS = [
  { key: "organization", name: "Organization", icon: "users", description: "Departments, people, their roles and what each of them knows" },
  { key: "processes", name: "Processes", icon: "workflow", description: "How work is done: the steps, who does them, systems, rules and documents" },
  { key: "systems", name: "IT & systems", icon: "server", description: "Software and what it is for, APIs, databases, where documents live, hosting" },
  {
    key: "market",
    name: "Clients & partners",
    icon: "handshake",
    description: "Clients, deals, customer issues, suppliers and the products the company sells",
  },
  { key: "work", name: "Projects & work", icon: "kanban", description: "Ongoing and past projects, their tasks, and who is working on what now" },
  {
    key: "knowhow",
    name: "Strategy & know-how",
    icon: "lightbulb",
    description: "Goals, decisions and why they were taken, practical know-how, the company's words",
  },
] as const;
export type BrainDimensionKey = (typeof BRAIN_DIMENSIONS)[number]["key"];

export const BRAIN_FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "money",
  "percent",
  "date",
  "choice",
  "url",
  "email",
  "phone",
  "list",
  "steps",
  "apis",
  "tables",
  "contacts",
  "milestones",
] as const;
export type BrainFieldType = (typeof BRAIN_FIELD_TYPES)[number];

export interface BrainField {
  key: string;
  label: string;
  type: BrainFieldType;
  choices?: readonly string[];
  hint?: string;
  /** Shown next to the name in lists. */
  brief?: boolean;
  /** A change of its value is news: it goes on the timeline. */
  tracked?: boolean;
  /** Kept for the system, not shown in forms. */
  hidden?: boolean;
}

export interface BrainKind {
  key: string;
  dimension: BrainDimensionKey;
  name: string;
  plural: string;
  /** A lucide icon name. */
  icon: string;
  description: string;
  fields: readonly BrainField[];
}

const STEP_HINT = "Each step: what is done, who does it, and in which system.";

export const BRAIN_KINDS = [
  // Organization
  {
    key: "company",
    dimension: "organization",
    name: "Company",
    plural: "Company",
    icon: "building-2",
    description: "The company itself: what it does, where, how big",
    fields: [
      { key: "industry", label: "Industry", type: "text", brief: true },
      { key: "founded", label: "Founded", type: "text" },
      { key: "employees", label: "Employees", type: "number" },
      { key: "revenue", label: "Revenue", type: "text" },
      { key: "headquarters", label: "Headquarters", type: "text" },
      { key: "website", label: "Website", type: "url" },
      { key: "markets", label: "Markets", type: "list" },
      { key: "mission", label: "Mission", type: "long_text" },
      { key: "values", label: "Values", type: "list" },
    ],
  },
  {
    key: "department",
    dimension: "organization",
    name: "Department",
    plural: "Departments",
    icon: "network",
    description: "A department or team",
    fields: [
      { key: "headcount", label: "People", type: "number", brief: true },
      { key: "mission", label: "What it is for", type: "long_text" },
      { key: "email", label: "Team mailbox", type: "email" },
      { key: "cost_center", label: "Cost center", type: "text" },
      { key: "kpis", label: "What it is measured on", type: "list" },
    ],
  },
  {
    key: "person",
    dimension: "organization",
    name: "Person",
    plural: "People",
    icon: "user",
    description: "Someone who works at the company",
    fields: [
      { key: "title", label: "Title", type: "text", brief: true },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone", type: "phone" },
      { key: "status", label: "Status", type: "choice", choices: ["Active", "On leave", "Left"], brief: true, tracked: true },
      { key: "started", label: "Started", type: "date" },
      { key: "skills", label: "Skills", type: "list" },
      { key: "languages", label: "Languages", type: "list" },
    ],
  },
  {
    key: "role",
    dimension: "organization",
    name: "Role",
    plural: "Roles",
    icon: "id-card",
    description: "A job and what it is responsible for",
    fields: [
      { key: "responsibilities", label: "Responsible for", type: "list" },
      { key: "skills_needed", label: "Skills it needs", type: "list" },
      { key: "grade", label: "Grade", type: "text" },
    ],
  },
  {
    key: "ai_employee",
    dimension: "organization",
    name: "AI employee",
    plural: "AI employees",
    icon: "bot",
    description: "An AI employee working in Enterprise Brain",
    fields: [
      { key: "status", label: "Status", type: "choice", choices: ["Draft", "Active", "Paused", "Archived"], brief: true, tracked: true },
      { key: "level", label: "Level", type: "choice", choices: ["Shadow", "Supervised", "Trusted"] },
      { key: "job", label: "Its job", type: "long_text" },
      { key: "starts", label: "Starts when", type: "list" },
      { key: "abilities", label: "Can", type: "list" },
      { key: "slug", label: "Address", type: "text", hidden: true },
    ],
  },
  {
    key: "site",
    dimension: "organization",
    name: "Site",
    plural: "Sites",
    icon: "map-pin",
    description: "An office, plant, warehouse or data center",
    fields: [
      { key: "type", label: "Type", type: "choice", choices: ["Headquarters", "Plant", "Office", "Warehouse", "Data center", "Other"], brief: true },
      { key: "city", label: "City", type: "text", brief: true },
      { key: "country", label: "Country", type: "text" },
      { key: "address", label: "Address", type: "text" },
    ],
  },
  // Processes
  {
    key: "process",
    dimension: "processes",
    name: "Process",
    plural: "Processes",
    icon: "workflow",
    description: "How a piece of work is done, from what starts it to what comes out",
    fields: [
      { key: "status", label: "Documentation", type: "choice", choices: ["Documented", "Draft", "Needs review"], brief: true },
      { key: "frequency", label: "How often", type: "text", brief: true },
      { key: "trigger", label: "What starts it", type: "text" },
      { key: "steps", label: "Steps", type: "steps", hint: STEP_HINT },
      { key: "rules", label: "Rules", type: "list" },
      { key: "inputs", label: "Inputs", type: "list" },
      { key: "outputs", label: "Outputs", type: "list" },
      { key: "kpis", label: "Measured on", type: "list" },
      { key: "problems", label: "Known problems", type: "list" },
    ],
  },
  {
    key: "policy",
    dimension: "processes",
    name: "Policy",
    plural: "Policies & rules",
    icon: "scale",
    description: "A company rule that work must follow",
    fields: [
      { key: "category", label: "Area", type: "text", brief: true },
      { key: "rules", label: "Rules", type: "list" },
      { key: "applies_to", label: "Applies to", type: "text" },
      { key: "effective", label: "In force since", type: "date" },
      { key: "version", label: "Version", type: "text" },
    ],
  },
  {
    key: "document",
    dimension: "processes",
    name: "Document",
    plural: "Documents & forms",
    icon: "file-text",
    description: "A procedure, form, template or contract the work uses",
    fields: [
      {
        key: "type",
        label: "Type",
        type: "choice",
        choices: ["Procedure", "Form", "Template", "Policy", "Manual", "Contract", "Report", "Other"],
        brief: true,
      },
      { key: "location", label: "Where it is kept", type: "text", brief: true },
      { key: "url", label: "Link", type: "url" },
      { key: "format", label: "Format", type: "text" },
      { key: "version", label: "Version", type: "text" },
      { key: "updated", label: "Last updated", type: "date" },
      { key: "knowledge", label: "Knowledge document", type: "text", hidden: true },
    ],
  },
  // IT & systems
  {
    key: "system",
    dimension: "systems",
    name: "System",
    plural: "Systems",
    icon: "app-window",
    description: "A piece of software the company uses",
    fields: [
      {
        key: "category",
        label: "Category",
        type: "choice",
        choices: [
          "ERP",
          "CRM",
          "HR",
          "Mail",
          "Collaboration",
          "Documents",
          "Manufacturing",
          "Quality",
          "Finance",
          "BI & reporting",
          "Website & portal",
          "Identity & security",
          "Service desk",
          "Development",
          "Cloud platform",
          "Other",
        ],
        brief: true,
      },
      { key: "vendor", label: "Vendor and product", type: "text" },
      { key: "hosting", label: "Hosting", type: "choice", choices: ["On premises", "Private cloud", "Public cloud", "SaaS", "Hybrid"], brief: true },
      { key: "location", label: "Where it runs", type: "text" },
      { key: "url", label: "Address", type: "url" },
      { key: "status", label: "Status", type: "choice", choices: ["Live", "Planned", "Being replaced", "Retired"], tracked: true },
      { key: "features", label: "What it does", type: "list" },
      { key: "data", label: "Business data kept here", type: "list" },
      { key: "users", label: "Users", type: "number" },
      { key: "criticality", label: "How critical", type: "choice", choices: ["Low", "Medium", "High", "Critical"] },
      { key: "sign_in", label: "How people sign in", type: "text" },
      { key: "version", label: "Version", type: "text" },
      { key: "apis", label: "APIs", type: "apis", hint: "Each API: its style (REST, OData, SOAP…), address, how it signs in, and its main endpoints." },
      { key: "connection", label: "Access for AI employees", type: "text" },
    ],
  },
  {
    key: "database",
    dimension: "systems",
    name: "Database",
    plural: "Databases",
    icon: "database",
    description: "A database: where it is, how to connect, and its tables",
    fields: [
      { key: "engine", label: "Engine", type: "text", brief: true },
      { key: "connectable", label: "AI employees may connect", type: "choice", choices: ["Yes", "Read-only", "No"], brief: true },
      { key: "host", label: "Host", type: "text" },
      { key: "port", label: "Port", type: "text" },
      { key: "database", label: "Database name", type: "text" },
      { key: "access", label: "How to connect", type: "text" },
      { key: "personal_data", label: "Personal data", type: "choice", choices: ["None", "Some", "Sensitive"] },
      { key: "size", label: "Size", type: "text" },
      { key: "tables", label: "Tables", type: "tables", hint: "Each table with its columns: name, type, key and what it holds." },
    ],
  },
  {
    key: "data_store",
    dimension: "systems",
    name: "Document store",
    plural: "Document stores",
    icon: "folder-open",
    description: "Where files and documents are kept: SharePoint sites, file shares, archives",
    fields: [
      {
        key: "type",
        label: "Type",
        type: "choice",
        choices: ["SharePoint site", "File share", "OneDrive", "Cloud storage", "Document system", "Archive", "Other"],
        brief: true,
      },
      { key: "location", label: "Where", type: "text" },
      { key: "contents", label: "What is kept here", type: "list" },
      { key: "access", label: "Who can open it", type: "text" },
      { key: "retention", label: "Kept for", type: "text" },
    ],
  },
  {
    key: "infrastructure",
    dimension: "systems",
    name: "Infrastructure",
    plural: "Hosting & infrastructure",
    icon: "server",
    description: "Server rooms, servers, cloud subscriptions, networks and backups",
    fields: [
      {
        key: "type",
        label: "Type",
        type: "choice",
        choices: ["Server room", "Server", "Cluster", "Cloud subscription", "Network", "Backup", "Other"],
        brief: true,
      },
      { key: "provider", label: "Provider", type: "text", brief: true },
      { key: "region", label: "Where", type: "text" },
      { key: "details", label: "Details", type: "list" },
    ],
  },
  // Clients & partners
  {
    key: "client",
    dimension: "market",
    name: "Client",
    plural: "Clients",
    icon: "handshake",
    description: "A customer or prospect",
    fields: [
      { key: "status", label: "Status", type: "choice", choices: ["Customer", "Prospect", "Former customer", "Partner"], brief: true, tracked: true },
      { key: "industry", label: "Industry", type: "text", brief: true },
      { key: "segment", label: "Segment", type: "text" },
      { key: "country", label: "Country", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "website", label: "Website", type: "url" },
      { key: "since", label: "Customer since", type: "date" },
      { key: "size", label: "Size", type: "text" },
      { key: "open_invoices", label: "Open invoices", type: "text", tracked: true },
      { key: "contacts", label: "Contacts", type: "contacts" },
    ],
  },
  {
    key: "deal",
    dimension: "market",
    name: "Deal",
    plural: "Deals",
    icon: "badge-dollar-sign",
    description: "A sales opportunity",
    fields: [
      {
        key: "stage",
        label: "Stage",
        type: "choice",
        choices: ["Prospecting", "Qualification", "Proposal", "Negotiation", "Won", "Lost"],
        brief: true,
        tracked: true,
      },
      { key: "amount", label: "Amount", type: "money", brief: true },
      { key: "currency", label: "Currency", type: "text" },
      { key: "probability", label: "Probability", type: "percent" },
      { key: "close_date", label: "Expected close", type: "date" },
      { key: "products", label: "Products", type: "list" },
      { key: "next_step", label: "Next step", type: "text", tracked: true },
    ],
  },
  {
    key: "case",
    dimension: "market",
    name: "Customer issue",
    plural: "Customer issues",
    icon: "message-square-warning",
    description: "A complaint, question or problem a client raised",
    fields: [
      {
        key: "status",
        label: "Status",
        type: "choice",
        choices: ["New", "Open", "In progress", "Waiting on customer", "Resolved", "Closed"],
        brief: true,
        tracked: true,
      },
      { key: "priority", label: "Priority", type: "choice", choices: ["Low", "Medium", "High", "Urgent"], brief: true, tracked: true },
      { key: "category", label: "Category", type: "text" },
      { key: "opened", label: "Opened", type: "date" },
      { key: "contact", label: "Raised by", type: "text" },
    ],
  },
  {
    key: "supplier",
    dimension: "market",
    name: "Supplier",
    plural: "Suppliers",
    icon: "truck",
    description: "A company the company buys from",
    fields: [
      { key: "category", label: "Supplies", type: "text", brief: true },
      { key: "status", label: "Status", type: "choice", choices: ["Approved", "Blocked", "Under review"], brief: true, tracked: true },
      { key: "country", label: "Country", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "payment_terms", label: "Payment terms", type: "text" },
      { key: "email", label: "Email", type: "email" },
      { key: "contacts", label: "Contacts", type: "contacts" },
    ],
  },
  {
    key: "product",
    dimension: "market",
    name: "Product",
    plural: "Products & services",
    icon: "package",
    description: "Something the company sells",
    fields: [
      { key: "code", label: "Code", type: "text", brief: true },
      { key: "category", label: "Category", type: "text", brief: true },
      { key: "price", label: "List price", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "status", label: "Status", type: "choice", choices: ["Active", "New", "Phasing out"], tracked: true },
      { key: "features", label: "Key facts", type: "list" },
    ],
  },
  // Projects & work
  {
    key: "project",
    dimension: "work",
    name: "Project",
    plural: "Projects",
    icon: "kanban",
    description: "A project, ongoing or past",
    fields: [
      { key: "status", label: "Status", type: "choice", choices: ["Planned", "Active", "On hold", "Done", "Cancelled"], brief: true, tracked: true },
      { key: "health", label: "Health", type: "choice", choices: ["On track", "At risk", "Off track"], brief: true, tracked: true },
      { key: "type", label: "Type", type: "choice", choices: ["Customer project", "Product development", "IT project", "Improvement", "Internal"] },
      { key: "start", label: "Started", type: "date" },
      { key: "end", label: "Due", type: "date" },
      { key: "progress", label: "Progress", type: "percent", tracked: true },
      { key: "budget", label: "Budget", type: "text" },
      { key: "now", label: "Where it stands now", type: "long_text" },
      { key: "next_steps", label: "Next steps", type: "list" },
      { key: "milestones", label: "Milestones", type: "milestones" },
      { key: "risks", label: "Risks", type: "list" },
      { key: "lessons", label: "Lessons learned", type: "list" },
    ],
  },
  {
    key: "task",
    dimension: "work",
    name: "Task",
    plural: "Tasks",
    icon: "list-checks",
    description: "A piece of work someone is doing or has to do",
    fields: [
      { key: "status", label: "Status", type: "choice", choices: ["To do", "In progress", "Waiting", "Blocked", "Done"], brief: true, tracked: true },
      { key: "due", label: "Due", type: "date", brief: true },
      { key: "priority", label: "Priority", type: "choice", choices: ["Low", "Medium", "High"] },
      { key: "source", label: "Kept in", type: "text" },
    ],
  },
  // Strategy & know-how
  {
    key: "goal",
    dimension: "knowhow",
    name: "Goal",
    plural: "Goals",
    icon: "target",
    description: "Something the company wants to reach, and how far it is",
    fields: [
      { key: "status", label: "Status", type: "choice", choices: ["On track", "At risk", "Off track", "Achieved"], brief: true, tracked: true },
      { key: "target", label: "Target", type: "text", brief: true },
      { key: "current", label: "Now", type: "text", tracked: true },
      { key: "period", label: "By", type: "text" },
      { key: "measure", label: "How it is measured", type: "text" },
    ],
  },
  {
    key: "decision",
    dimension: "knowhow",
    name: "Decision",
    plural: "Decisions",
    icon: "gavel",
    description: "Something decided, and why",
    fields: [
      { key: "decided", label: "Decided on", type: "date", brief: true },
      { key: "status", label: "Status", type: "choice", choices: ["In force", "Replaced", "Under review"] },
      { key: "why", label: "Why", type: "long_text" },
      { key: "alternatives", label: "Options considered", type: "list" },
    ],
  },
  {
    key: "knowhow",
    dimension: "knowhow",
    name: "Know-how",
    plural: "Know-how",
    icon: "lightbulb",
    description: "Practical knowledge from experience: how to get something done, what to watch for",
    fields: [
      { key: "when", label: "When it applies", type: "text" },
      { key: "details", label: "Details", type: "long_text" },
    ],
  },
  {
    key: "term",
    dimension: "knowhow",
    name: "Term",
    plural: "Company words",
    icon: "book-a",
    description: "A word, abbreviation or name the company uses, and what it means",
    fields: [{ key: "example", label: "Example", type: "text" }],
  },
] as const satisfies readonly BrainKind[];

export type BrainKindKey = (typeof BRAIN_KINDS)[number]["key"];
export const BRAIN_KIND_KEYS = BRAIN_KINDS.map((k) => k.key) as [BrainKindKey, ...BrainKindKey[]];

export interface BrainRelation {
  key: string;
  /** Read from the first thing: "Kerem Yıldız — knows → 8D complaint handling". */
  label: string;
  /** Read from the second: "8D complaint handling — known by → Kerem Yıldız". */
  inverse: string;
  from: readonly BrainKindKey[] | "any";
  to: readonly BrainKindKey[] | "any";
  /** A word or two a link may carry: how well someone knows a thing, their role in a project. */
  detail?: { label: string; choices?: readonly string[] };
}

const PEOPLE = ["person", "role", "department"] as const;
const OWNED = [
  "process",
  "policy",
  "document",
  "system",
  "database",
  "data_store",
  "infrastructure",
  "client",
  "deal",
  "case",
  "supplier",
  "product",
  "goal",
  "site",
  "project",
] as const;
const IT = ["system", "database", "data_store", "infrastructure"] as const;

export const BRAIN_RELATIONS = [
  { key: "works_in", label: "Works in", inverse: "Who works here", from: ["person", "ai_employee", "role"], to: ["department"] },
  { key: "heads", label: "Heads", inverse: "Headed by", from: ["person"], to: ["department", "company"] },
  { key: "reports_to", label: "Reports to", inverse: "Team", from: ["person"], to: ["person"] },
  { key: "holds", label: "Has the role", inverse: "People in this role", from: ["person"], to: ["role"] },
  { key: "manages", label: "Manages", inverse: "Manager", from: ["person"], to: ["ai_employee"] },
  {
    key: "knows",
    label: "Knows",
    inverse: "Who knows it",
    from: ["person"],
    to: "any",
    detail: { label: "How well", choices: ["Expert", "Can do it", "Learning"] },
  },
  { key: "owns", label: "Responsible for", inverse: "Owner", from: PEOPLE, to: OWNED },
  { key: "looks_after", label: "Looks after", inverse: "IT contact", from: ["person", "department"], to: IT },
  { key: "does", label: "Does", inverse: "Who does it", from: ["person", "role", "ai_employee", "department"], to: ["process"], detail: { label: "Part" } },
  { key: "leads", label: "Leads", inverse: "Led by", from: ["person"], to: ["project", "goal"] },
  {
    key: "works_on",
    label: "Works on",
    inverse: "Who works on it",
    from: ["person", "ai_employee", "department"],
    to: ["project", "client", "deal", "case"],
    detail: { label: "Role" },
  },
  { key: "assigned_to", label: "Assigned to", inverse: "Tasks", from: ["task"], to: ["person", "ai_employee"] },
  { key: "part_of", label: "Part of", inverse: "Includes", from: "any", to: "any" },
  {
    key: "uses",
    label: "Uses",
    inverse: "Used by",
    from: ["process", "department", "person", "role", "ai_employee", "project", "system"],
    to: ["system", "database", "data_store", "document"],
    detail: { label: "For" },
  },
  { key: "located_at", label: "Is at", inverse: "Here", from: ["person", "department", "system", "database", "data_store", "infrastructure"], to: ["site"] },
  { key: "for_client", label: "For", inverse: "Work for this client", from: ["project", "deal", "case", "task"], to: ["client"] },
  { key: "buys", label: "Buys", inverse: "Bought by", from: ["client"], to: ["product"] },
  { key: "supplies", label: "Supplies", inverse: "Supplied by", from: ["supplier"], to: ["product", "project", "site"] },
  { key: "has_database", label: "Keeps its data in", inverse: "Database of", from: ["system"], to: ["database"] },
  { key: "sends_to", label: "Sends data to", inverse: "Gets data from", from: ["system"], to: ["system"], detail: { label: "What" } },
  { key: "runs_on", label: "Runs on", inverse: "Hosts", from: ["system", "database", "data_store"], to: ["infrastructure"] },
  { key: "stored_in", label: "Kept in", inverse: "Keeps", from: ["document"], to: ["data_store", "system"] },
  { key: "described_in", label: "Described in", inverse: "Describes", from: "any", to: ["document"] },
  { key: "follows", label: "Follows", inverse: "Applies to", from: ["process", "system", "department", "project", "ai_employee"], to: ["policy"] },
  { key: "hands_over_to", label: "Hands over to", inverse: "Comes from", from: ["process"], to: ["process"], detail: { label: "What" } },
  { key: "about", label: "About", inverse: "Notes, decisions and know-how", from: ["decision", "knowhow", "term", "goal", "document"], to: "any" },
  { key: "decided_by", label: "Decided by", inverse: "Decisions", from: ["decision"], to: ["person", "department"] },
  { key: "shared_by", label: "From", inverse: "Know-how shared", from: ["knowhow"], to: ["person"] },
] as const satisfies readonly BrainRelation[];

export type BrainRelationKey = (typeof BRAIN_RELATIONS)[number]["key"];
export const BRAIN_RELATION_KEYS = BRAIN_RELATIONS.map((r) => r.key) as [BrainRelationKey, ...BrainRelationKey[]];

const KIND_BY_KEY = new Map<string, BrainKind>(BRAIN_KINDS.map((k) => [k.key, k as BrainKind]));
const RELATION_BY_KEY = new Map<string, BrainRelation>(BRAIN_RELATIONS.map((r) => [r.key, r as BrainRelation]));

export function brainKind(key: string): BrainKind | undefined {
  return KIND_BY_KEY.get(key);
}

export function brainRelation(key: string): BrainRelation | undefined {
  return RELATION_BY_KEY.get(key);
}

export function isBrainKind(key: string): key is BrainKindKey {
  return KIND_BY_KEY.has(key);
}

/** May a link of this relation go from a thing of one kind to a thing of another? */
export function relationFits(relation: BrainRelation, from: string, to: string): boolean {
  const fits = (allowed: BrainRelation["from"], kind: string) => allowed === "any" || allowed.includes(kind as BrainKindKey);
  return fits(relation.from, from) && fits(relation.to, to);
}

/** The relations that fit two kinds, in the order they are listed. */
export function relationsBetween(from: string, to: string): BrainRelation[] {
  return BRAIN_RELATIONS.filter((r) => relationFits(r as BrainRelation, from, to)) as BrainRelation[];
}

// ---------------------------------------------------------------------------
// Values

export const BrainStep = z.object({
  name: z.string().trim().min(1).max(300),
  does: z.string().trim().max(2000).default(""),
  who: z.string().trim().max(300).default(""),
  system: z.string().trim().max(300).default(""),
});
export type BrainStep = z.infer<typeof BrainStep>;

export const BrainApi = z.object({
  name: z.string().trim().min(1).max(200),
  style: z.string().trim().max(60).default("REST"),
  url: z.string().trim().max(500).default(""),
  auth: z.string().trim().max(300).default(""),
  docs: z.string().trim().max(500).default(""),
  /** "GET /sales-orders — list sales orders", one per line. */
  endpoints: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
});
export type BrainApi = z.infer<typeof BrainApi>;

export const BrainColumn = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().max(100).default(""),
  /** "PK", or "FK → customers.id". */
  key: z.string().trim().max(200).default(""),
  description: z.string().trim().max(1000).default(""),
});
export type BrainColumn = z.infer<typeof BrainColumn>;

export const BrainTable = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  columns: z.array(BrainColumn).max(500).default([]),
});
export type BrainTable = z.infer<typeof BrainTable>;

export const BrainContact = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).default(""),
  email: z.string().trim().max(200).default(""),
  phone: z.string().trim().max(100).default(""),
});
export type BrainContact = z.infer<typeof BrainContact>;

export const BrainMilestone = z.object({
  name: z.string().trim().min(1).max(300),
  due: z.string().trim().max(40).default(""),
  status: z.string().trim().max(60).default(""),
});
export type BrainMilestone = z.infer<typeof BrainMilestone>;

const STRUCTURED: Partial<Record<BrainFieldType, z.ZodType>> = {
  steps: z.array(BrainStep).max(200),
  apis: z.array(BrainApi).max(100),
  tables: z.array(BrainTable).max(1000),
  contacts: z.array(BrainContact).max(200),
  milestones: z.array(BrainMilestone).max(200),
};

/** Is a stored value empty (nothing to show, nothing to keep)? */
export function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * A field's value in the shape it is kept: numbers as numbers, lists as lists of words, steps, APIs,
 * tables, contacts and milestones as their objects. Throws a plain-words message when it can't be.
 */
export function brainValue(field: BrainField, raw: unknown): unknown {
  if (isBlankValue(raw)) return null;
  const structured = STRUCTURED[field.type];
  if (structured) {
    const parsed = structured.safeParse(raw);
    if (!parsed.success) throw new Error(`${field.label}: ${parsed.error.issues[0]?.message ?? "not in the right shape"}`);
    return (parsed.data as unknown[]).length ? parsed.data : null;
  }
  switch (field.type) {
    case "number":
    case "money":
    case "percent": {
      const number = typeof raw === "number" ? raw : Number(String(raw).replace(/[\s,]/g, "").replace(/%$/, ""));
      if (!Number.isFinite(number)) throw new Error(`${field.label}: "${String(raw)}" is not a number`);
      return number;
    }
    case "list": {
      const items = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
      const words = items.map((item) => String(item).trim()).filter(Boolean);
      return words.length ? [...new Set(words)].slice(0, 300) : null;
    }
    case "choice": {
      const text = String(raw).trim();
      const choice = field.choices?.find((c) => c.toLowerCase() === text.toLowerCase());
      if (field.choices && !choice) throw new Error(`${field.label}: "${text}" is not one of ${field.choices.join(", ")}`);
      return choice ?? text;
    }
    case "date": {
      const text = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(Date.parse(text.slice(0, 10))))
        throw new Error(`${field.label}: "${text}" is not a date (YYYY-MM-DD)`);
      return text.slice(0, 10);
    }
    default: {
      if (typeof raw === "object") throw new Error(`${field.label}: expected words`);
      return (
        String(raw)
          .trim()
          .slice(0, field.type === "long_text" ? 20_000 : 1000) || null
      );
    }
  }
}

/** Every field of a kind in its kept shape; unknown fields are dropped, problems collected. */
export function brainData(kind: BrainKind, data: Record<string, unknown>): { data: Record<string, unknown>; problems: string[] } {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const field of kind.fields) {
    if (!(field.key in data)) continue;
    try {
      out[field.key] = brainValue(field, data[field.key]);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { data: out, problems };
}

/** Lower case, without accents, Turkish dotless i as i: how names are compared and searched. */
export function foldText(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/İ/g, "i").toLowerCase();
}

/** The words of a value, for search: lists, steps, APIs and tables flattened. */
export function valueWords(value: unknown): string[] {
  if (isBlankValue(value)) return [];
  if (Array.isArray(value)) return value.flatMap(valueWords);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(valueWords);
  return [String(value)];
}

/** Where a thing lives in the web app. */
export function brainPath(id: string): string {
  return `/brain/e/${id}`;
}

// ---------------------------------------------------------------------------
// Input

export const BrainEntityInput = z.object({
  kind: z.enum(BRAIN_KIND_KEYS),
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(4000).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type BrainEntityInput = z.infer<typeof BrainEntityInput>;

export const BrainEntityPatch = BrainEntityInput.omit({ kind: true }).partial();
export type BrainEntityPatch = z.infer<typeof BrainEntityPatch>;

export const BrainLinkInput = z.object({
  from: z.string().min(1),
  relation: z.enum(BRAIN_RELATION_KEYS),
  to: z.string().min(1),
  detail: z.string().trim().max(200).optional(),
});
export type BrainLinkInput = z.infer<typeof BrainLinkInput>;

export const BRAIN_EVENT_KINDS = ["message", "email", "meeting", "call", "update", "change", "note", "ticket", "order"] as const;
export type BrainEventKind = (typeof BRAIN_EVENT_KINDS)[number];

export const BrainEventInput = z.object({
  kind: z.enum(BRAIN_EVENT_KINDS).default("note"),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(20_000).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  about: z.array(z.string()).max(50).optional(),
});
export type BrainEventInput = z.infer<typeof BrainEventInput>;
