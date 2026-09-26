/**
 * Operations of the built-in SANDBOX systems. A connector binding that a company
 * has not bound to a real system yet falls back to the sandbox of its category,
 * so every catalog template must only use these operations: that is what makes
 * templates runnable out of the box (demo mode) before any integration exists.
 *
 * Keep in sync with the sandbox connectors in @enterprise-brain/connectors.
 */

export interface SandboxOperation {
  id: string;
  kind: "read" | "write";
  /** Parameters the operation cannot run without. */
  required: readonly string[];
  optional: readonly string[];
  /**
   * Canonical values of enumerated parameters (compared case-insensitively, "-" and " " equal "_").
   * Templates must use these; some sandboxes additionally accept synonyms or store unknown
   * categories as "other", but a template should never rely on that.
   */
  enums: Readonly<Record<string, readonly string[]>>;
}

export interface SandboxSystem {
  /** Connector type of the sandbox system, e.g. "sandbox-erp". */
  system: string;
  name: string;
  operations: readonly SandboxOperation[];
}

type Enums = Record<string, readonly string[]>;

/** Parses a compact signature such as "supplier_id, status?" into required/optional parameter lists. */
function op(kind: SandboxOperation["kind"], id: string, signature = "", enums: Enums = {}): SandboxOperation {
  const params = signature
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    id,
    kind,
    required: params.filter((p) => !p.endsWith("?")),
    optional: params.filter((p) => p.endsWith("?")).map((p) => p.slice(0, -1)),
    enums,
  };
}

const read = (id: string, signature?: string, enums?: Enums) => op("read", id, signature, enums);
const write = (id: string, signature?: string, enums?: Enums) => op("write", id, signature, enums);

// Canonical values of the sandbox systems' enumerated parameters.
const PO_STATUSES = ["draft", "awaiting_approval", "open", "partially_received", "received", "closed", "cancelled"];
const INVOICE_STATUSES = ["parked", "posted", "blocked", "on_hold", "approved", "rejected", "paid"];
const LEAD_STATUSES = ["new", "working", "qualified", "disqualified", "converted"];
const OPPORTUNITY_STAGES = ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"];
const CASE_STATUSES = ["new", "open", "in_progress", "waiting_on_customer", "resolved", "closed"];
const CASE_PRIORITIES = ["low", "medium", "high", "urgent"];
const CASE_CATEGORIES = ["complaint", "quality", "delivery", "billing", "warranty", "technical_support", "information_request", "other"];
const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"];
const LEAVE_TYPES = ["annual", "sick", "excuse", "unpaid"];
const LEAVE_REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"];
const LEAVE_DECISIONS = ["approved", "rejected", "cancelled"];
const REQUISITION_STATUSES = ["draft", "open", "on_hold", "filled", "closed"];
const CANDIDATE_STAGES = ["applied", "screening", "interview", "assessment", "offer", "hired", "rejected", "withdrawn"];
const TICKET_STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
const TICKET_PRIORITIES = ["low", "medium", "high", "critical"];
const TICKET_CATEGORIES = ["hardware", "software", "network", "email", "access", "erp", "printer", "security", "other"];
const ASSIGNMENT_GROUPS = [
  "Service Desk",
  "Workplace Services",
  "Network Operations",
  "SAP Basis & ERP Support",
  "Identity & Access Management",
  "Information Security",
  "Plant IT / OT",
  "Business Applications",
];

/** Sandbox systems keyed by the system category they stand in for. */
export const SANDBOX_SYSTEMS: Readonly<Record<string, SandboxSystem>> = {
  erp: {
    system: "sandbox-erp",
    name: "Sandbox ERP",
    operations: [
      read("search_suppliers", "query?"),
      read("get_supplier", "supplier_id"),
      read("get_purchase_order", "po_number"),
      read("search_purchase_orders", "supplier_id?, status?", { status: PO_STATUSES }),
      read("get_invoice_status", "invoice_number"),
      read("check_supplier_invoice", "currency, net_amount, supplier_id?, po_number?, invoice_number?"),
      read("search_customers", "query?"),
      read("get_customer_balance", "customer_id"),
      read("list_open_items", "customer_id?, overdue_only?"),
      read("get_material_stock", "material"),
      read("get_sales_order", "order_number"),
      read("list_gl_balances", "period?"),
      write("create_supplier", "name, tax_id?, email?, country?, iban?"),
      write("create_purchase_order", "supplier_id, lines, currency?"),
      write(
        "post_supplier_invoice",
        "supplier_id, invoice_number, invoice_date, currency, net_amount, tax_amount, total_amount, po_number?, variance_approved_by?",
      ),
      write("update_supplier_invoice_status", "invoice_number, status, note?", { status: INVOICE_STATUSES }),
    ],
  },
  crm: {
    system: "sandbox-crm",
    name: "Sandbox CRM",
    operations: [
      read("search_accounts", "query?"),
      read("get_account", "account_id"),
      read("search_contacts", "query?, email?"),
      read("search_leads", "status?", { status: LEAD_STATUSES }),
      read("get_case", "case_id"),
      read("search_cases", "status?, contact_email?", { status: CASE_STATUSES }),
      read("search_opportunities", "account_id?, stage?", { stage: OPPORTUNITY_STAGES }),
      write("create_lead", "company, contact_name, email, phone?, source?, notes?, score?"),
      write("update_lead", "lead_id, fields"),
      write("create_case", "contact_email, subject, description, priority, category, account_id?", {
        priority: CASE_PRIORITIES,
        category: CASE_CATEGORIES,
      }),
      write("update_case", "case_id, status?, notes?", { status: CASE_STATUSES }),
      write("log_activity", "related_to, type, subject, notes?", { type: ACTIVITY_TYPES }),
      write("update_opportunity", "opportunity_id, fields"),
    ],
  },
  hris: {
    system: "sandbox-hris",
    name: "Sandbox HRIS",
    operations: [
      read("get_employee", "employee_id?, email?"),
      read("search_employees", "query?"),
      read("get_leave_balance", "employee_id"),
      read("list_leave_requests", "employee_id?, status?", { status: LEAVE_REQUEST_STATUSES }),
      read("list_positions"),
      write("create_leave_request", "employee_id, type, start_date, end_date, reason?", { type: LEAVE_TYPES }),
      write("update_leave_request", "request_id, status, note?", { status: LEAVE_DECISIONS }),
      write("create_employee", "first_name, last_name, email, position, department, start_date, manager_id?"),
    ],
  },
  ats: {
    system: "sandbox-ats",
    name: "Sandbox ATS",
    operations: [
      read("list_job_requisitions", "status?", { status: REQUISITION_STATUSES }),
      read("get_job_requisition", "requisition_id"),
      read("search_candidates", "requisition_id?, stage?", { stage: CANDIDATE_STAGES }),
      read("get_candidate", "candidate_id"),
      write("create_candidate", "full_name, email, requisition_id?, phone?, score?, summary?, cv_file_id?, stage?", {
        stage: CANDIDATE_STAGES,
      }),
      write("update_candidate_stage", "candidate_id, stage, note?", { stage: CANDIDATE_STAGES }),
      write("schedule_interview", "candidate_id, interviewer_email, start, duration_minutes?"),
    ],
  },
  itsm: {
    system: "sandbox-itsm",
    name: "Sandbox ITSM",
    operations: [
      read("get_ticket", "ticket_id"),
      read("search_tickets", "status?, requester_email?", { status: TICKET_STATUSES }),
      read("get_asset", "asset_tag?, user_email?"),
      write("create_ticket", "requester_email, title, description, category, priority, assignment_group?", {
        category: TICKET_CATEGORIES,
        priority: TICKET_PRIORITIES,
        assignment_group: ASSIGNMENT_GROUPS,
      }),
      write("update_ticket", "ticket_id, status?, comment?", { status: TICKET_STATUSES }),
      write("create_access_request", "requester_email, system, role, justification"),
    ],
  },
  calendar: {
    system: "sandbox-calendar",
    name: "Sandbox Calendar",
    operations: [
      read("find_free_times", "attendees, duration_minutes, from?, to?, time_zone?, working_hours_start?, working_hours_end?, max_results?"),
      read("list_events", "from?, to?"),
      write("book_meeting", "subject, start, attendees, duration_minutes?, optional_attendees?, body?, location?, online_meeting?, time_zone?"),
      write("cancel_meeting", "event_id, comment?"),
    ],
  },
};

/** System categories that have a built-in sandbox system. */
export const SANDBOX_CATEGORIES: readonly string[] = Object.keys(SANDBOX_SYSTEMS);

/** Operations offered for a category (empty when the category has no sandbox system). */
export function sandboxOperationsFor(category: string): readonly SandboxOperation[] {
  return SANDBOX_SYSTEMS[category]?.operations ?? [];
}

export function findSandboxOperation(category: string, operationId: string): SandboxOperation | undefined {
  return sandboxOperationsFor(category).find((o) => o.id === operationId);
}

/** Enum comparison as the sandbox does it: case-insensitive, spaces and hyphens equal underscores. */
export function enumKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Is `value` allowed for an enumerated parameter (true when the parameter is not enumerated)? */
export function isAllowedValue(operation: SandboxOperation, param: string, value: string): boolean {
  const allowed = operation.enums[param];
  return !allowed || allowed.some((v) => enumKey(v) === enumKey(value));
}
