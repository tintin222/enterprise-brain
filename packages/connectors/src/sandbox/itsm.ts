import { defineManifest } from "../define.ts";
import { email, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError } from "../types.ts";
import { normalizeEmail, optEnum, optString, reqEnum, reqString, toEnum } from "../util.ts";
import { defineSandboxConnector, listResult, nowIso, relativeDates, type SandboxDb } from "./common.ts";

const DOMAIN = "acme.example";
const STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const CATEGORIES = ["hardware", "software", "network", "email", "access", "erp", "printer", "security", "other"] as const;
const GROUPS = [
  "Service Desk",
  "Workplace Services",
  "Network Operations",
  "SAP Basis & ERP Support",
  "Identity & Access Management",
  "Information Security",
  "Plant IT / OT",
  "Business Applications",
] as const;

const PRIORITY_SYNONYMS: Record<string, (typeof PRIORITIES)[number]> = {
  urgent: "critical",
  highest: "critical",
  p1: "critical",
  major: "high",
  p2: "high",
  normal: "medium",
  moderate: "medium",
  p3: "medium",
  minor: "low",
  lowest: "low",
  p4: "low",
};

const CATEGORY_SYNONYMS: Record<string, (typeof CATEGORIES)[number]> = {
  laptop: "hardware",
  pc: "hardware",
  computer: "hardware",
  device: "hardware",
  phone: "hardware",
  monitor: "hardware",
  application: "software",
  app: "software",
  license: "software",
  licence: "software",
  vpn: "network",
  wifi: "network",
  internet: "network",
  mail: "email",
  outlook: "email",
  mailbox: "email",
  password: "access",
  password_reset: "access",
  account: "access",
  permissions: "access",
  login: "access",
  sap: "erp",
  printing: "printer",
  phishing: "security",
  malware: "security",
  virus: "security",
  general: "other",
  request: "other",
  incident: "other",
};

const STATUS_SYNONYMS: Record<string, (typeof STATUSES)[number]> = {
  open: "assigned",
  reopen: "in_progress",
  reopened: "in_progress",
  working: "in_progress",
  pending: "on_hold",
  waiting: "on_hold",
  done: "resolved",
  fixed: "resolved",
  solved: "resolved",
  canceled: "cancelled",
  cancel: "cancelled",
};

type Status = (typeof STATUSES)[number];
type Priority = (typeof PRIORITIES)[number];
type Category = (typeof CATEGORIES)[number];

const ROUTING: Record<Category, (typeof GROUPS)[number]> = {
  hardware: "Workplace Services",
  printer: "Workplace Services",
  software: "Service Desk",
  email: "Service Desk",
  network: "Network Operations",
  access: "Identity & Access Management",
  erp: "SAP Basis & ERP Support",
  security: "Information Security",
  other: "Service Desk",
};

/** Resolution targets per priority (hours). */
const SLA_HOURS: Record<Priority, number> = { critical: 4, high: 8, medium: 24, low: 72 };

/** Approvers for access requests (system owners). */
const SYSTEM_OWNERS: Array<[RegExp, string]> = [
  [/sap|s\/4|erp/i, `selin.arslan@${DOMAIN}`],
  [/successfactors|hr|payroll/i, `zeynep.demir@${DOMAIN}`],
  [/salesforce|crm|hubspot/i, `thomas.weber@${DOMAIN}`],
  [/mes|plant|scada/i, `burak.sahin@${DOMAIN}`],
];
const DEFAULT_APPROVER = `can.ozturk@${DOMAIN}`;

interface Comment {
  at: string;
  author: string;
  text: string;
}

interface Ticket {
  ticket_id: string;
  requester_email: string;
  title: string;
  description: string;
  category: Category;
  /** The category as given, when it is not one of the standard categories. */
  category_detail: string | null;
  priority: Priority;
  status: Status;
  assignment_group: string;
  assignee: string | null;
  asset_tag: string | null;
  related_request: string | null;
  sla_due_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  comments: Comment[];
}

interface AccessRequest {
  request_id: string;
  requester_email: string;
  system: string;
  role: string;
  justification: string;
  status: "pending_approval" | "approved" | "rejected" | "provisioned";
  approver_email: string;
  ticket_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface Asset {
  asset_tag: string;
  type: "laptop" | "monitor" | "phone" | "tablet" | "printer" | "scanner";
  model: string;
  serial_number: string;
  assigned_to: string | null;
  status: "in_use" | "in_stock" | "in_repair" | "retired";
  location: string;
  purchase_date: string;
  warranty_until: string;
  operating_system: string | null;
  notes: string | null;
}

function seed(today: Date): Record<string, object[]> {
  const { day, at } = relativeDates(today);
  const user = (name: string) => `${name}@${DOMAIN}`;

  const asset = (
    tag: string,
    type: Asset["type"],
    model: string,
    serial: string,
    owner: string | null,
    status: Asset["status"],
    location: string,
    purchasedOffset: number,
    warrantyYears: number,
    os: string | null,
    notes: string | null = null,
  ): Asset => ({
    asset_tag: tag,
    type,
    model,
    serial_number: serial,
    assigned_to: owner ? user(owner) : null,
    status,
    location,
    purchase_date: day(purchasedOffset),
    warranty_until: day(purchasedOffset + Math.round(warrantyYears * 365)),
    operating_system: os,
    notes,
  });

  const assets: Asset[] = [
    asset("ACM-LT-0101", "laptop", "Lenovo ThinkPad X1 Carbon Gen 11", "PF4K2B7Q", "mehmet.aydin", "in_use", "Istanbul HQ", -410, 3, "Windows 11 Enterprise"),
    asset("ACM-LT-0114", "laptop", "Dell Latitude 5440", "7HQ2LS3", "emre.koc", "in_use", "Istanbul HQ", -620, 3, "Windows 11 Enterprise"),
    asset("ACM-LT-0127", "laptop", "Lenovo ThinkPad T14 Gen 4", "PF4M9X21", "ozan.kurt", "in_use", "Istanbul HQ", -245, 3, "Windows 11 Enterprise", "Developer image with WSL2 and Docker"),
    asset("ACM-LT-0133", "laptop", "Apple MacBook Pro 14 (M3)", "C02ZK1ABMD6T", "thomas.weber", "in_use", "Hamburg Sales Office", -380, 3, "macOS 15"),
    asset("ACM-LT-0141", "laptop", "Dell Latitude 5440", "9JX4LS3", "gizem.polat", "in_use", "Istanbul HQ", -540, 3, "Windows 11 Enterprise"),
    asset("ACM-LT-0148", "laptop", "HP EliteBook 840 G10", "5CG3218KQX", null, "in_stock", "Istanbul HQ IT storage", -90, 3, "Windows 11 Enterprise", "Spare, imaged and ready for onboarding"),
    asset("ACM-LT-0152", "laptop", "Lenovo ThinkPad T14 Gen 3", "PF3Z8Q44", null, "in_repair", "Vendor repair centre", -900, 3, "Windows 11 Enterprise", "Battery swelling (TCK-1002); previously used by ece.dogan"),
    asset("ACM-LT-0160", "laptop", "Lenovo ThinkPad X1 Carbon Gen 11", "PF4K2C01", "elif.yilmaz", "in_use", "Istanbul HQ", -400, 3, "Windows 11 Enterprise"),
    asset("ACM-LT-0165", "laptop", "Dell Latitude 5440", "2KD7LS3", "selin.arslan", "in_use", "Istanbul HQ", -600, 3, "Windows 11 Enterprise"),
    asset("ACM-LT-0170", "laptop", "Lenovo ThinkPad T14 Gen 4", "PF4N1Y88", "ece.dogan", "in_use", "Istanbul HQ", -30, 3, "Windows 11 Enterprise", "Replacement for ACM-LT-0152"),
    asset("ACM-PH-0207", "phone", "Apple iPhone 15", "F2LZK9Q1P0", "ali.yildiz", "in_use", "Istanbul HQ", -300, 1, "iOS 18"),
    asset("ACM-PH-0212", "phone", "Samsung Galaxy S23", "R5CW21ABC9D", "laura.rossi", "in_use", "Hamburg Sales Office", -500, 2, "Android 15"),
    asset("ACM-MN-0305", "monitor", "Dell P2723DE 27\" USB-C hub monitor", "CN0H9K2X", "emre.koc", "in_use", "Istanbul HQ", -620, 3, null),
    asset("ACM-TB-0402", "tablet", "Zebra ET45 rugged tablet", "22145520501234", "serkan.gunes", "in_use", "Gebze Plant warehouse", -700, 3, "Android 13"),
    asset("ACM-PR-0501", "printer", "HP LaserJet Enterprise M611dn", "PHBBL12345", null, "in_use", "Gebze Plant shipping office", -1500, 5, null),
    asset("ACM-SC-0601", "scanner", "Zebra DS2208 barcode scanner", "21180523001122", "murat.kilic", "in_use", "Gebze Plant warehouse", -420, 5, null),
  ];

  const ticket = (
    id: string,
    requester: string,
    title: string,
    description: string,
    category: Category,
    priority: Priority,
    status: Status,
    createdOffset: number,
    assignee: string | null,
    assetTag: string | null,
    comments: Array<[number, string, string]>,
    group: string = ROUTING[category],
  ): Ticket => {
    const created = at(createdOffset, 7, 45);
    const last = comments[comments.length - 1];
    return {
      ticket_id: id,
      requester_email: user(requester),
      title,
      description,
      category,
      category_detail: null,
      priority,
      status,
      assignment_group: group,
      assignee: assignee ? user(assignee) : null,
      asset_tag: assetTag,
      related_request: null,
      sla_due_at: new Date(Date.parse(created) + SLA_HOURS[priority] * 3_600_000).toISOString(),
      created_at: created,
      updated_at: last ? at(last[0], 13) : created,
      resolved_at: status === "resolved" || status === "closed" ? at(last?.[0] ?? createdOffset, 13) : null,
      comments: comments.map(([offset, author, text]) => ({ at: at(offset, 13), author, text })),
    };
  };

  const tickets: Ticket[] = [
    ticket("TCK-1001", "emre.koc", "SAP invoice posting (MIRO) fails with 'Balance not zero'", "Posting invoice DEG2026000001142 in MIRO fails with message 'Balance not zero: 460.00 TRY'. Tax code V2 was proposed automatically.", "erp", "high", "in_progress", -3, "can.ozturk", null, [
      [-2, "SAP Basis & ERP Support", "Tax code determination for supplier SUP-1009 points to V2 (10%) instead of V1 (20%); correcting condition record."],
    ]),
    ticket("TCK-1002", "ece.dogan", "Laptop battery swelling (ACM-LT-0152)", "Laptop case is bulging near the touchpad, device gets hot.", "hardware", "high", "resolved", -32, "hakan.erdogan", "ACM-LT-0152", [
      [-31, "Workplace Services", "Device taken out of service immediately; loaner ACM-LT-0170 issued; sent to vendor under warranty."],
    ]),
    ticket("TCK-1003", "laura.rossi", "VPN disconnects every 10 minutes from Hamburg office", "Since Monday the GlobalProtect VPN drops every ~10 minutes on the office Wi-Fi; on mobile hotspot it is stable.", "network", "medium", "on_hold", -6, "can.ozturk", "ACM-PH-0212", [
      [-5, "Network Operations", "MTU mismatch suspected on the Hamburg ISP line; ticket opened with ISP, waiting for their change window."],
    ]),
    ticket("TCK-1004", "gizem.polat", "Cannot open CVs from careers mailbox (attachments blocked)", "PDF attachments sent to careers@ are shown as 'blocked by policy' since yesterday.", "email", "medium", "new", -1, null, null, []),
    ticket("TCK-1005", "serkan.gunes", "Warehouse scanner not pairing with rugged tablet", "Scanner ACM-SC-0601 no longer pairs with the ET45 tablet after the Android update.", "hardware", "low", "assigned", -4, "hakan.erdogan", "ACM-SC-0601", []),
    ticket("TCK-1006", "murat.kilic", "Shipping office printer jams (ACM-PR-0501)", "Printer jams on every second delivery note.", "printer", "low", "closed", -20, "hakan.erdogan", "ACM-PR-0501", [
      [-19, "Workplace Services", "Replaced pickup roller kit; test prints OK."],
    ]),
    ticket("TCK-1007", "ozan.kurt", "Request: Docker Desktop license", "Need a Docker Desktop business license for the MES integration project.", "software", "low", "assigned", -7, "can.ozturk", "ACM-LT-0127", []),
    ticket("TCK-1008", "ali.yildiz", "Shared mailbox satis@ not visible in Outlook", "The shared sales mailbox disappeared from Outlook after a password change.", "email", "medium", "resolved", -12, "can.ozturk", null, [
      [-11, "Service Desk", "Re-added full access permission with automapping; mailbox visible again."],
    ]),
    ticket("TCK-1009", "selin.arslan", "Power BI finance workspace refresh failing", "The daily refresh of the 'Finance KPIs' dataset fails since last night: gateway credentials expired.", "software", "high", "new", 0, null, null, [], "Business Applications"),
    ticket("TCK-1010", "deniz.celik", "MES terminal line 3 frozen: production impact", "The MES terminal at assembly line 3 froze; operators cannot book production orders. Line running with paper backup.", "other", "critical", "in_progress", 0, "can.ozturk", null, [
      [0, "Plant IT / OT", "Remote session failed; technician on the way to line 3."],
    ], "Plant IT / OT"),
    ticket("TCK-1011", "thomas.weber", "Salesforce access for new SDR starting next month", "Please prepare Salesforce and HubSpot access for the new Sales Development Representative (start in ~5 weeks).", "access", "medium", "new", -1, null, null, []),
    ticket("TCK-1012", "merve.aksoy", "Phishing e-mail reported: 'Invoice overdue, urgent payment'", "Received an e-mail pretending to be from Kaya Çelik asking to pay an overdue invoice to a new IBAN.", "security", "high", "resolved", -9, "can.ozturk", null, [
      [-9, "Information Security", "Confirmed phishing; sender domain blocked, message purged from 14 mailboxes; AP team warned (see supplier SUP-1013 block)."],
    ]),
  ];

  const accessRequests: AccessRequest[] = [
    { request_id: "ACR-6001", requester_email: user("emre.koc"), system: "SAP S/4HANA", role: "AP Clerk (FI-AP display and post)", justification: "Posting of supplier invoices as Accounts Payable Specialist.", status: "provisioned", approver_email: user("selin.arslan"), ticket_id: null, created_at: at(-400), decided_at: at(-399) },
    { request_id: "ACR-6002", requester_email: user("ozan.kurt"), system: "Azure DevOps", role: "Contributor: MES integration project", justification: "Development of the MES to SAP integration services.", status: "approved", approver_email: user("can.ozturk"), ticket_id: null, created_at: at(-230), decided_at: at(-229) },
    { request_id: "ACR-6003", requester_email: user("gizem.polat"), system: "SAP SuccessFactors", role: "Recruiter", justification: "Managing requisitions and candidates for open positions.", status: "pending_approval", approver_email: user("zeynep.demir"), ticket_id: null, created_at: at(-2), decided_at: null },
    { request_id: "ACR-6004", requester_email: user("laura.rossi"), system: "Salesforce", role: "Sales User EMEA", justification: "Managing EMEA opportunities and accounts.", status: "provisioned", approver_email: user("thomas.weber"), ticket_id: null, created_at: at(-600), decided_at: at(-598) },
    { request_id: "ACR-6005", requester_email: user("hande.ozkan"), system: "Power BI", role: "Finance workspace viewer", justification: "Access during leave to follow the monthly close.", status: "rejected", approver_email: user("can.ozturk"), ticket_id: null, created_at: at(-40), decided_at: at(-39) },
    { request_id: "ACR-6006", requester_email: user("ali.yildiz"), system: "SharePoint Sales", role: "Member", justification: "Maintaining quotations and customer presentations.", status: "provisioned", approver_email: user("thomas.weber"), ticket_id: null, created_at: at(-380), decided_at: at(-379) },
    { request_id: "ACR-6007", requester_email: user("deniz.celik"), system: "MES (Gebze)", role: "Production planner", justification: "Releasing production orders for assembly line 3 while the planner position is vacant.", status: "pending_approval", approver_email: user("burak.sahin"), ticket_id: null, created_at: at(-1), decided_at: null },
    { request_id: "ACR-6008", requester_email: user("serkan.gunes"), system: "SAP S/4HANA", role: "WM Warehouse Clerk (MIGO, LT01)", justification: "Posting goods receipts and transfer orders in the Gebze warehouse.", status: "provisioned", approver_email: user("selin.arslan"), ticket_id: null, created_at: at(-700), decided_at: at(-699) },
  ];

  return { tickets, access_requests: accessRequests, assets };
}

function approverFor(system: string): string {
  return SYSTEM_OWNERS.find(([pattern]) => pattern.test(system))?.[1] ?? DEFAULT_APPROVER;
}

async function newTicket(
  db: SandboxDb,
  fields: {
    requester: string;
    title: string;
    description: string;
    category: Category;
    categoryDetail?: string | null;
    priority: Priority;
    group?: string;
    relatedRequest?: string;
  },
): Promise<Ticket> {
  const createdAt = Date.now();
  const now = new Date(createdAt).toISOString();
  const ticket: Ticket = {
    ticket_id: await db.nextId("tickets", "TCK-", 4),
    requester_email: fields.requester,
    title: fields.title,
    description: fields.description,
    category: fields.category,
    category_detail: fields.categoryDetail ?? null,
    priority: fields.priority,
    status: "new",
    assignment_group: fields.group ?? ROUTING[fields.category],
    assignee: null,
    asset_tag: /ACM-[A-Z]{2}-\d{4}/.exec(`${fields.title} ${fields.description}`)?.[0] ?? null,
    related_request: fields.relatedRequest ?? null,
    sla_due_at: new Date(createdAt + SLA_HOURS[fields.priority] * 3_600_000).toISOString(),
    created_at: now,
    updated_at: now,
    resolved_at: null,
    comments: [],
  };
  await db.put("tickets", ticket);
  return ticket;
}

const manifest = defineManifest({
  type: "sandbox-itsm",
  name: "Sandbox ITSM",
  vendor: "Enterprise Brain",
  category: "itsm",
  description:
    "Built-in demo IT service management system of Acme Endüstri A.Ş.: incidents and service requests with SLA and routing to assignment groups, access requests with system-owner approval, and the IT asset inventory. Works without credentials; changes persist per company.",
  auth: "none",
  maturity: "sandbox",
  operations: [
    readOp("get_ticket", "Get ticket", "Ticket with status, SLA, assignment and comment history.", {
      ticket_id: str("Ticket id, e.g. TCK-1001"),
    }, ["ticket_id"]),
    readOp("search_tickets", "Search tickets", "Tickets, newest first, by status and/or requester.", {
      status: oneOf(STATUSES, "Ticket status"),
      requester_email: email("Requester's e-mail address"),
    }),
    readOp("get_asset", "Get asset", "An IT asset by asset tag, or all assets assigned to a user ({ items, total }).", {
      asset_tag: str("Asset tag, e.g. ACM-LT-0114"),
      user_email: email("E-mail address of the user"),
    }),
    writeOp("create_ticket", "Create ticket", "Open an incident or service request. Without an assignment group the ticket is routed by category; the SLA follows the priority (critical 4h, high 8h, medium 24h, low 72h).", {
      requester_email: email("Requester's e-mail address"),
      title: str("Short title"),
      description: str("Full description"),
      category: str(`Category: ${CATEGORIES.join(", ")} (other values are routed to the Service Desk)`),
      priority: str(`Priority: ${PRIORITIES.join(", ")}`),
      assignment_group: oneOf(GROUPS, "Assignment group (default: routed by category)"),
    }, ["requester_email", "title", "description", "category", "priority"]),
    writeOp("update_ticket", "Update ticket", "Change a ticket's status and/or add a comment.", {
      ticket_id: str("Ticket id, e.g. TCK-1004"),
      status: str(`New status: ${STATUSES.join(", ")}`),
      comment: str("Comment to add"),
    }, ["ticket_id"]),
    writeOp("create_access_request", "Create access request", "Request access to a system/role. The request is routed to the system owner for approval and a linked ticket is opened for Identity & Access Management.", {
      requester_email: email("E-mail of the person who needs access"),
      system: str("System, e.g. 'SAP S/4HANA', 'Salesforce', 'SharePoint Finance'"),
      role: str("Role or permission set requested"),
      justification: str("Business justification (at least 10 characters)"),
    }, ["requester_email", "system", "role", "justification"]),
  ],
});

export const sandboxItsmConnector = defineSandboxConnector({
  manifest,
  keys: { tickets: "ticket_id", access_requests: "request_id", assets: "asset_tag" },
  seed,
  operations: {
    async get_ticket(input, db) {
      return db.require<Ticket>("tickets", reqString(input, "ticket_id").toUpperCase(), "Ticket");
    },

    async search_tickets(input, db) {
      const status = optEnum(input, "status", STATUSES);
      const requester = optString(input, "requester_email")?.toLowerCase();
      const items = (await db.list<Ticket>("tickets"))
        .filter((t) => (!status || t.status === status) && (!requester || t.requester_email === requester))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return listResult(items);
    },

    async get_asset(input, db) {
      const tag = optString(input, "asset_tag")?.toUpperCase();
      const userEmail = optString(input, "user_email")?.toLowerCase();
      if (tag) return db.require<Asset>("assets", tag, "Asset");
      if (userEmail) {
        const items = (await db.list<Asset>("assets")).filter((a) => a.assigned_to === userEmail);
        return listResult(items, { user_email: userEmail });
      }
      throw new ConnectorError("Provide asset_tag or user_email", "validation");
    },

    async create_ticket(input, db) {
      const categoryInput = reqString(input, "category");
      let category: Category = "other";
      let categoryDetail: string | null = null;
      try {
        category = toEnum(categoryInput, "category", CATEGORIES, CATEGORY_SYNONYMS);
      } catch {
        categoryDetail = categoryInput;
      }
      const ticket = await newTicket(db, {
        requester: normalizeEmail(reqString(input, "requester_email"), "requester_email"),
        title: reqString(input, "title"),
        description: reqString(input, "description"),
        category,
        categoryDetail,
        priority: reqEnum(input, "priority", PRIORITIES, PRIORITY_SYNONYMS),
        group: optEnum(input, "assignment_group", GROUPS),
      });
      return { ...ticket, ok: true };
    },

    async update_ticket(input, db) {
      const ticket = await db.require<Ticket>("tickets", reqString(input, "ticket_id").toUpperCase(), "Ticket");
      const status = optEnum(input, "status", STATUSES, STATUS_SYNONYMS);
      const comment = optString(input, "comment");
      if (!status && !comment) throw new ConnectorError("Provide a new status and/or a comment", "validation");
      if ((ticket.status === "closed" || ticket.status === "cancelled") && status && status !== ticket.status) {
        throw new ConnectorError(`Ticket ${ticket.ticket_id} is ${ticket.status}; open a new ticket instead of reopening it`, "validation");
      }
      const now = nowIso();
      if (status) {
        ticket.status = status;
        ticket.resolved_at = status === "resolved" || status === "closed" ? (ticket.resolved_at ?? now) : null;
      }
      if (comment) ticket.comments.push({ at: now, author: "Enterprise Brain agent", text: comment });
      ticket.updated_at = now;
      await db.put("tickets", ticket);
      return { ...ticket, ok: true };
    },

    async create_access_request(input, db) {
      const requester = normalizeEmail(reqString(input, "requester_email"), "requester_email");
      const system = reqString(input, "system");
      const role = reqString(input, "role");
      const justification = reqString(input, "justification");
      if (justification.length < 10) {
        throw new ConnectorError("justification must explain the business need (at least 10 characters)", "validation");
      }
      const open = (await db.list<AccessRequest>("access_requests")).find(
        (r) =>
          r.requester_email === requester &&
          r.system.toLowerCase() === system.toLowerCase() &&
          r.role.toLowerCase() === role.toLowerCase() &&
          (r.status === "pending_approval" || r.status === "approved" || r.status === "provisioned"),
      );
      if (open) {
        throw new ConnectorError(`${requester} already has access request ${open.request_id} for ${open.system} / ${open.role} (${open.status})`, "validation");
      }
      const id = await db.nextId("access_requests", "ACR-", 4);
      const approver = approverFor(system);
      const ticket = await newTicket(db, {
        requester,
        title: `Access request ${id}: ${system} / ${role}`,
        description: `${requester} requests the role "${role}" in ${system}.\nJustification: ${justification}\nApprover: ${approver}`,
        category: "access",
        priority: "medium",
        relatedRequest: id,
      });
      const request: AccessRequest = {
        request_id: id,
        requester_email: requester,
        system,
        role,
        justification,
        status: "pending_approval",
        approver_email: approver,
        ticket_id: ticket.ticket_id,
        created_at: nowIso(),
        decided_at: null,
      };
      await db.put("access_requests", request);
      return { ...request, ok: true };
    },
  },
});
