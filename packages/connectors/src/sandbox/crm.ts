import { defineManifest } from "../define.ts";
import { anyObject, email, int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError } from "../types.ts";
import {
  matchesQuery,
  normalizeEmail,
  optEnum,
  optNumber,
  optString,
  parseIsoDate,
  reqEnum,
  reqRecord,
  reqString,
  toEnum,
  type Rec,
} from "../util.ts";
import { defineSandboxConnector, listResult, nowIso, relativeDates, type SandboxDb } from "./common.ts";

const LEAD_STATUSES = ["new", "working", "qualified", "disqualified", "converted"] as const;
const STAGES = ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
const CASE_STATUSES = ["new", "open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const CASE_CATEGORIES = [
  "complaint",
  "quality",
  "delivery",
  "billing",
  "warranty",
  "technical_support",
  "information_request",
  "other",
] as const;
const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"] as const;

const PRIORITY_SYNONYMS: Record<string, (typeof PRIORITIES)[number]> = {
  normal: "medium",
  moderate: "medium",
  critical: "urgent",
  highest: "urgent",
  lowest: "low",
  p1: "urgent",
  p2: "high",
  p3: "medium",
  p4: "low",
};

const CATEGORY_SYNONYMS: Record<string, (typeof CASE_CATEGORIES)[number]> = {
  technical: "technical_support",
  support: "technical_support",
  technical_question: "technical_support",
  question: "information_request",
  inquiry: "information_request",
  enquiry: "information_request",
  information: "information_request",
  info: "information_request",
  product_question: "information_request",
  quote_request: "information_request",
  invoice: "billing",
  invoice_question: "billing",
  payment: "billing",
  shipping: "delivery",
  order_status: "delivery",
  late_delivery: "delivery",
  logistics: "delivery",
  defect: "quality",
  quality_issue: "quality",
  return: "warranty",
  rma: "warranty",
  claim: "warranty",
  general: "other",
};

const CASE_STATUS_SYNONYMS: Record<string, (typeof CASE_STATUSES)[number]> = {
  pending: "waiting_on_customer",
  waiting: "waiting_on_customer",
  on_hold: "waiting_on_customer",
  working: "in_progress",
  reopened: "open",
  solved: "resolved",
  done: "resolved",
  fixed: "resolved",
};

const LEAD_STATUS_SYNONYMS: Record<string, (typeof LEAD_STATUSES)[number]> = {
  open: "new",
  contacted: "working",
  in_progress: "working",
  nurturing: "working",
  unqualified: "disqualified",
  junk: "disqualified",
  won: "converted",
};

const STAGE_SYNONYMS: Record<string, (typeof STAGES)[number]> = {
  won: "closed_won",
  lost: "closed_lost",
  closedwon: "closed_won",
  closedlost: "closed_lost",
  discovery: "qualification",
  quote: "proposal",
  quotation: "proposal",
  proposal_sent: "proposal",
  negotiating: "negotiation",
};

type LeadStatus = (typeof LEAD_STATUSES)[number];
type Stage = (typeof STAGES)[number];
type CaseStatus = (typeof CASE_STATUSES)[number];
type Priority = (typeof PRIORITIES)[number];
type CaseCategory = (typeof CASE_CATEGORIES)[number];
type ActivityType = (typeof ACTIVITY_TYPES)[number];

const STAGE_PROBABILITY: Record<Stage, number> = {
  prospecting: 10,
  qualification: 25,
  proposal: 50,
  negotiation: 75,
  closed_won: 100,
  closed_lost: 0,
};

/** First-response targets per case priority (hours). */
const CASE_SLA_HOURS: Record<Priority, number> = { urgent: 4, high: 8, medium: 24, low: 72 };

interface Account {
  account_id: string;
  name: string;
  industry: string;
  segment: string;
  country: string;
  city: string;
  website: string;
  phone: string;
  status: "customer" | "prospect" | "partner" | "former_customer";
  owner: string;
  erp_customer_id: string | null;
  annual_revenue_eur: number | null;
  employees: number | null;
  created_at: string;
}

interface Contact {
  contact_id: string;
  account_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  title: string;
  email: string;
  phone: string;
  language: string;
  is_primary: boolean;
}

interface Lead {
  lead_id: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string | null;
  source: string;
  status: LeadStatus;
  score: number | null;
  notes: string | null;
  owner: string;
  country: string | null;
  interest: string | null;
  created_at: string;
  updated_at: string;
}

interface Opportunity {
  opportunity_id: string;
  account_id: string;
  account_name: string;
  name: string;
  stage: Stage;
  amount: number;
  currency: string;
  probability: number;
  close_date: string;
  owner: string;
  next_step: string | null;
  products: string[];
  loss_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CaseNote {
  at: string;
  author: string;
  text: string;
}

interface Case {
  case_id: string;
  account_id: string | null;
  account_name: string | null;
  contact_email: string;
  contact_name: string | null;
  subject: string;
  description: string;
  priority: Priority;
  category: CaseCategory;
  /** The category as given, when it is not one of the standard categories. */
  category_detail: string | null;
  status: CaseStatus;
  owner: string;
  related_order: string | null;
  sla_due_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  notes: CaseNote[];
}

interface Activity {
  activity_id: string;
  related_to: string;
  related_type: string;
  type: ActivityType;
  subject: string;
  notes: string | null;
  owner: string;
  created_at: string;
}

/** Entities an activity can relate to, by id prefix. */
const RELATED: Array<{ prefix: string; entity: string; label: string }> = [
  { prefix: "ACC-", entity: "accounts", label: "account" },
  { prefix: "CON-", entity: "contacts", label: "contact" },
  { prefix: "LEAD-", entity: "leads", label: "lead" },
  { prefix: "OPP-", entity: "opportunities", label: "opportunity" },
  { prefix: "CASE-", entity: "cases", label: "case" },
];

const AGENT = "Enterprise Brain agent";

function seed(today: Date): Record<string, object[]> {
  const { day, at } = relativeDates(today);

  const account = (
    id: string,
    name: string,
    industry: string,
    segment: string,
    country: string,
    city: string,
    domain: string,
    phone: string,
    status: Account["status"],
    owner: string,
    erpId: string | null,
    revenue: number | null,
    employees: number | null,
    createdOffset: number,
  ): Account => ({
    account_id: id,
    name,
    industry,
    segment,
    country,
    city,
    website: `https://www.${domain}`,
    phone,
    status,
    owner,
    erp_customer_id: erpId,
    annual_revenue_eur: revenue,
    employees,
    created_at: at(createdOffset),
  });

  const accounts: Account[] = [
    account("ACC-3001", "Boğaziçi Su Teknolojileri A.Ş.", "Water & wastewater", "Distributor", "TR", "İstanbul", "bogazicisu.example", "+90 212 555 31 00", "customer", "Ali Yıldız", "CUST-2001", 38_000_000, 140, -2100),
    account("ACC-3002", "Hansa Pumpen Vertrieb GmbH", "Industrial distribution", "Distributor", "DE", "Hamburg", "hansa-pumpen.example", "+49 40 5550 7120", "customer", "Thomas Weber", "CUST-2002", 52_000_000, 85, -1800),
    account("ACC-3003", "Iberica Fluid Systems S.L.", "Machinery OEM", "OEM", "ES", "Valencia", "ibericafluid.example", "+34 96 555 4410", "customer", "Laura Rossi", "CUST-2003", 21_000_000, 110, -1200),
    account("ACC-3004", "Gulf Water Solutions LLC", "Desalination EPC", "EPC contractor", "AE", "Dubai", "gulfwater.example", "+971 4 555 8820", "customer", "Laura Rossi", "CUST-2004", 140_000_000, 600, -900),
    account("ACC-3005", "Anadolu Agro Sulama A.Ş.", "Agriculture & irrigation", "End user", "TR", "Konya", "anadoluagro.example", "+90 332 555 65 43", "customer", "Ali Yıldız", "CUST-2005", 9_500_000, 60, -1500),
    account("ACC-3006", "Petrokim Rafineri A.Ş.", "Oil & gas refining", "End user", "TR", "İzmit, Kocaeli", "petrokim.example", "+90 262 555 90 90", "customer", "Ali Yıldız", "CUST-2006", 1_900_000_000, 2400, -2500),
    account("ACC-3007", "Balkan Industrial Supply d.o.o.", "Industrial distribution", "Distributor", "RS", "Belgrade", "balkanindustrial.example", "+381 11 555 2230", "customer", "Laura Rossi", "CUST-2007", 6_800_000, 35, -700),
    account("ACC-3008", "Nordwind Energy A/S", "Renewable energy", "OEM", "DK", "Esbjerg", "nordwind-energy.example", "+45 75 55 12 00", "customer", "Thomas Weber", "CUST-2008", 310_000_000, 900, -600),
    account("ACC-3009", "Kuzey Gıda Üretim A.Ş.", "Food & beverage", "End user", "TR", "Samsun", "kuzeygida.example", "+90 362 555 20 10", "customer", "Ali Yıldız", "CUST-2009", 48_000_000, 420, -1100),
    account("ACC-3010", "Atlas Mining Maroc S.A.", "Mining", "End user", "MA", "Casablanca", "atlasmining.example", "+212 522 555 610", "customer", "Laura Rossi", "CUST-2010", 75_000_000, 1300, -800),
    account("ACC-3011", "Rhône Aqua Services SAS", "Municipal water services", "End user", "FR", "Lyon", "rhone-aqua.example", "+33 4 55 50 12 34", "prospect", "Laura Rossi", null, 64_000_000, 520, -60),
    account("ACC-3012", "Trakya OSB Yönetimi", "Industrial zone utilities", "End user", "TR", "Çorlu, Tekirdağ", "trakyaosb.example", "+90 282 555 70 70", "prospect", "Ali Yıldız", null, null, 80, -40),
    account("ACC-3013", "Vistula Water Engineering Sp. z o.o.", "Water engineering", "EPC contractor", "PL", "Gdańsk", "vistula-we.example", "+48 58 555 33 10", "prospect", "Thomas Weber", null, 18_000_000, 150, -90),
  ];

  const contact = (
    id: string,
    accountId: string,
    first: string,
    last: string,
    title: string,
    mail: string,
    phone: string,
    language: string,
    primary = false,
  ): Contact => ({
    contact_id: id,
    account_id: accountId,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    title,
    email: mail,
    phone,
    language,
    is_primary: primary,
  });

  const contacts: Contact[] = [
    contact("CON-4001", "ACC-3001", "Kerem", "Aslan", "Satın Alma Müdürü (Purchasing Manager)", "kerem.aslan@bogazicisu.example", "+90 532 555 10 01", "tr", true),
    contact("CON-4002", "ACC-3001", "Nazlı", "Er", "Teknik Müdür (Technical Manager)", "nazli.er@bogazicisu.example", "+90 533 555 10 02", "tr"),
    contact("CON-4003", "ACC-3002", "Jonas", "Becker", "Einkaufsleiter (Head of Purchasing)", "j.becker@hansa-pumpen.example", "+49 171 5550 301", "de", true),
    contact("CON-4004", "ACC-3002", "Petra", "Schmitt", "Service Coordinator", "p.schmitt@hansa-pumpen.example", "+49 171 5550 302", "de"),
    contact("CON-4005", "ACC-3003", "Javier", "Morales", "Director Técnico", "jmorales@ibericafluid.example", "+34 655 550 401", "es", true),
    contact("CON-4006", "ACC-3004", "Omar", "Al-Mansouri", "Procurement Lead", "omar.almansouri@gulfwater.example", "+971 50 555 0501", "en", true),
    contact("CON-4007", "ACC-3005", "Hüseyin", "Tekin", "Genel Müdür (General Manager)", "huseyin.tekin@anadoluagro.example", "+90 535 555 10 07", "tr", true),
    contact("CON-4008", "ACC-3006", "Sevgi", "Karaca", "Bakım Planlama Mühendisi (Maintenance Planning Engineer)", "sevgi.karaca@petrokim.example", "+90 532 555 10 08", "tr", true),
    contact("CON-4009", "ACC-3007", "Milan", "Jovanović", "Sales Manager", "milan.jovanovic@balkanindustrial.example", "+381 64 555 0901", "en", true),
    contact("CON-4010", "ACC-3008", "Freja", "Nielsen", "Project Engineer", "fn@nordwind-energy.example", "+45 20 55 51 00", "en", true),
    contact("CON-4011", "ACC-3009", "Oğuz", "Bayram", "Üretim Müdürü (Production Manager)", "oguz.bayram@kuzeygida.example", "+90 536 555 10 11", "tr", true),
    contact("CON-4012", "ACC-3010", "Youssef", "Benali", "Head of Maintenance", "y.benali@atlasmining.example", "+212 661 555 012", "fr", true),
    contact("CON-4013", "ACC-3011", "Camille", "Laurent", "Responsable Achats (Purchasing)", "c.laurent@rhone-aqua.example", "+33 6 55 50 13 13", "fr", true),
    contact("CON-4014", "ACC-3012", "Tolga", "Uçar", "Teknik İşler Müdürü (Technical Director)", "tolga.ucar@trakyaosb.example", "+90 532 555 10 14", "tr", true),
    contact("CON-4015", "ACC-3013", "Anna", "Kowalska", "Procurement Specialist", "anna.kowalska@vistula-we.example", "+48 601 555 015", "pl", true),
    contact("CON-4016", "ACC-3002", "Stefan", "Wolf", "Technical Buyer", "s.wolf@hansa-pumpen.example", "+49 171 5550 316", "de"),
  ];

  const lead = (
    id: string,
    company: string,
    name: string,
    mail: string,
    phone: string | null,
    source: string,
    status: LeadStatus,
    score: number | null,
    owner: string,
    country: string,
    interest: string,
    notes: string | null,
    createdOffset: number,
  ): Lead => ({
    lead_id: id,
    company,
    contact_name: name,
    email: mail,
    phone,
    source,
    status,
    score,
    notes,
    owner,
    country,
    interest,
    created_at: at(createdOffset, 10),
    updated_at: at(Math.min(0, createdOffset + 2), 15),
  });

  const leads: Lead[] = [
    lead("LEAD-5001", "Doğu Marmara Arıtma A.Ş.", "Yasemin Koç", "yasemin.koc@dogumarmara-aritma.example", "+90 262 555 51 01", "Web form", "new", 72, "Ali Yıldız", "TR", "ACP-80 centrifugal pumps", "Requests a quotation for 6x ACP-80 for a new wastewater pumping station; start of construction in Q1.", -1),
    lead("LEAD-5002", "Alpen Brauerei Kessler GmbH", "Martin Kessler", "m.kessler@alpenbrauerei.example", "+43 662 555 5102", "Trade fair: Hannover Messe", "working", 64, "Thomas Weber", "AT", "AV-50 stainless ball valves", "Brewery expansion 2027; needs hygienic design documentation (EHEDG).", -21),
    lead("LEAD-5003", "Karadeniz Tekstil Boya A.Ş.", "Hakan Oral", "hakan.oral@karadeniztekstil.example", "+90 462 555 51 03", "Referral: Kuzey Gıda", "qualified", 81, "Ali Yıldız", "TR", "Pump replacement in dye house", "Budget approved for Q4; 14 pumps to be replaced, decision maker is the plant director.", -30),
    lead("LEAD-5004", "Oasis Agritech FZE", "Rashid Hamdan", "rashid.hamdan@oasisagritech.example", null, "LinkedIn", "new", 55, "Laura Rossi", "AE", "Irrigation pump skids", null, -3),
    lead("LEAD-5005", "Nova Chem Italia S.r.l.", "Luca Bianchi", "l.bianchi@novachem.example", "+39 02 555 5105", "Web form", "disqualified", 20, "Laura Rossi", "IT", "ATEX pumps", "Requires ATEX Zone 1 certified pumps, which are not in our portfolio.", -44),
    lead("LEAD-5006", "Ankara Hastane Yapım Konsorsiyumu", "Selma Aydoğan", "selma.aydogan@ahyk.example", "+90 312 555 51 06", "Inbound call", "working", 68, "Ali Yıldız", "TR", "HVAC and fire water pumps", "Hospital campus project; public tender expected in about two months.", -12),
    lead("LEAD-5007", "Baltic Aquaculture UAB", "Tomas Petraitis", "tomas@balticaqua.example", "+370 5 555 5107", "Trade fair: WIN EURASIA", "new", 47, "Thomas Weber", "LT", "Low-head circulation pumps", null, -6),
    lead("LEAD-5008", "Çukurova Sulama Kooperatifi", "Ahmet Doğru", "ahmet.dogru@cukurovasulama.example", "+90 322 555 51 08", "Dealer referral: Anadolu Agro", "converted", 77, "Ali Yıldız", "TR", "Irrigation pumps", "Converted: order placed via dealer Anadolu Agro.", -70),
    lead("LEAD-5009", "Helvetia Pharma Services AG", "Nina Brunner", "nina.brunner@helvetia-pharma.example", "+41 61 555 5109", "Web form", "new", 59, "Thomas Weber", "CH", "Clean-in-place pump skid", "Needs 316L wetted parts and EN 10204 3.1 certificates.", -2),
    lead("LEAD-5010", "Rhône Aqua Services SAS", "Camille Laurent", "c.laurent@rhone-aqua.example", "+33 6 55 50 13 13", "Trade fair: Pollutec Lyon", "converted", 74, "Laura Rossi", "FR", "Municipal pumping stations", "Converted to account ACC-3011 and opportunity OPP-6005.", -62),
  ];

  const accountName = (id: string) => accounts.find((a) => a.account_id === id)?.name ?? id;

  const opp = (
    id: string,
    accountId: string,
    name: string,
    stage: Stage,
    amount: number,
    currency: string,
    probability: number,
    closeOffset: number,
    owner: string,
    nextStep: string | null,
    products: string[],
    lossReason: string | null = null,
  ): Opportunity => ({
    opportunity_id: id,
    account_id: accountId,
    account_name: accountName(accountId),
    name,
    stage,
    amount,
    currency,
    probability,
    close_date: day(closeOffset),
    owner,
    next_step: nextStep,
    products,
    loss_reason: lossReason,
    created_at: at(closeOffset - 120),
    updated_at: at(Math.min(-1, closeOffset), 16),
  });

  const opportunities: Opportunity[] = [
    opp("OPP-6001", "ACC-3002", "Hansa Pumpen: 2027 frame agreement ACP-80", "negotiation", 1_380_000, "EUR", 75, 35, "Thomas Weber", "Send revised price sheet with 3% volume rebate", ["ACP-80", "Spare part kit ACP-80"]),
    opp("OPP-6002", "ACC-3004", "Gulf Water: Jebel Ali desalination booster pumps", "proposal", 2_450_000, "USD", 50, 70, "Laura Rossi", "Technical clarification call with the EPC engineering team", ["ACP-80", "PS-200"]),
    opp("OPP-6003", "ACC-3008", "Nordwind: PS-200 skids for Esbjerg service hub (2 units)", "qualification", 520_000, "EUR", 25, 95, "Thomas Weber", "Site visit with project engineering", ["PS-200"]),
    opp("OPP-6004", "ACC-3006", "Petrokim: cooling water pump retrofit", "proposal", 18_600_000, "TRY", 40, 60, "Ali Yıldız", "Resolve vibration complaint CASE-7003 before the commercial meeting", ["ACP-80"]),
    opp("OPP-6005", "ACC-3011", "Rhône Aqua: municipal pumping stations lot 2", "prospecting", 860_000, "EUR", 10, 150, "Laura Rossi", "Prequalification documents for the tender", ["ACP-80", "AV-50"]),
    opp("OPP-6006", "ACC-3001", "Boğaziçi Su: AV-50 annual stock order", "closed_won", 5_340_000, "TRY", 100, -20, "Ali Yıldız", null, ["AV-50"]),
    opp("OPP-6007", "ACC-3003", "Iberica: OEM valve supply 2026", "closed_lost", 410_000, "EUR", 0, -45, "Laura Rossi", null, ["AV-50"], "Price: competitor offer about 12% lower"),
    opp("OPP-6008", "ACC-3013", "Vistula: Gdańsk WWTP pump package", "qualification", 1_120_000, "EUR", 20, 120, "Thomas Weber", "Clarify EU-funded tender requirements", ["ACP-80", "PS-200"]),
    opp("OPP-6009", "ACC-3009", "Kuzey Gıda: new bottling line pumps", "negotiation", 1_650_000, "TRY", 70, 20, "Ali Yıldız", "Final price approval by customer CFO", ["ACP-80", "Spare part kit ACP-80"]),
    opp("OPP-6010", "ACC-3012", "Trakya OSB: fire water pump station", "prospecting", 7_800_000, "TRY", 10, 180, "Ali Yıldız", "Introductory meeting with technical director", ["PS-200"]),
  ];

  const contactByEmail = (mail: string) => contacts.find((x) => x.email === mail);

  const kase = (
    id: string,
    mail: string,
    subject: string,
    description: string,
    priority: Priority,
    category: CaseCategory,
    status: CaseStatus,
    createdOffset: number,
    owner: string,
    relatedOrder: string | null,
    notes: Array<[number, string, string]>,
  ): Case => {
    const c = contactByEmail(mail);
    const created = at(createdOffset, 8, 40);
    return {
      case_id: id,
      account_id: c?.account_id ?? null,
      account_name: c ? accountName(c.account_id) : null,
      contact_email: mail,
      contact_name: c?.full_name ?? null,
      subject,
      description,
      priority,
      category,
      category_detail: null,
      status,
      owner,
      related_order: relatedOrder,
      sla_due_at: new Date(Date.parse(created) + CASE_SLA_HOURS[priority] * 3_600_000).toISOString(),
      created_at: created,
      updated_at: notes.length ? at(notes[notes.length - 1]![0], 14) : created,
      resolved_at: status === "resolved" || status === "closed" ? at(notes[notes.length - 1]?.[0] ?? createdOffset, 14) : null,
      notes: notes.map(([offset, author, text]) => ({ at: at(offset, 14), author, text })),
    };
  };

  const cases: Case[] = [
    kase("CASE-7001", "p.schmitt@hansa-pumpen.example", "Lead times for ACP-80 spare part kits", "Could you confirm current lead times for 50 spare part kits for ACP-80? We have several service jobs in November.", "low", "information_request", "resolved", -16, "Ece Doğan", null, [
      [-15, "Ece Doğan", "Confirmed 2 weeks ex works; 70 kits currently reserved, 90 available."],
    ]),
    kase("CASE-7002", "jmorales@ibericafluid.example", "Late delivery of SO-7000126: 200 valves outstanding", "Only 300 of 500 AV-50 valves arrived. Our assembly line needs the remaining 200 by the end of next week. Please confirm a date.", "high", "delivery", "in_progress", -4, "Ece Doğan", "SO-7000126", [
      [-3, "Ece Doğan", "Production confirms remaining 200 valves ready for shipment in 6 working days; asked logistics for express truck."],
    ]),
    kase("CASE-7003", "sevgi.karaca@petrokim.example", "ACP-80 pumps: excessive vibration after 200 operating hours", "Three of the 30 ACP-80 pumps delivered under PO PKR-4500871 show vibration of 7.1 mm/s (limit 4.5 mm/s) after about 200 operating hours. We request an urgent site inspection. Payment of invoice ACM-F-00301 is on hold until resolved.", "urgent", "quality", "in_progress", -9, "Merve Aksoy", "SO-7000125", [
      [-8, "Merve Aksoy", "8D report opened. Suspect misalignment at coupling or impeller imbalance."],
      [-5, "Hakan Erdoğan", "Site visit: alignment corrected on 2 pumps, vibration 3.2 mm/s. Third pump: impeller imbalance, replacement impeller shipped."],
    ]),
    kase("CASE-7004", "oguz.bayram@kuzeygida.example", "Mechanical seal leakage on ACP-80 (serial ACP80-24-1187)", "Seal leakage on the CIP return pump after 5 months in service. Is this covered by warranty?", "high", "warranty", "open", -2, "Ece Doğan", null, []),
    kase("CASE-7005", "kerem.aslan@bogazicisu.example", "Invoice ACM-F-00341: unit price differs from quotation", "Invoice ACM-F-00341 shows 4,450 TRY per AV-50 valve, our quotation QT-2291 says 4,380 TRY. Please issue a correction.", "medium", "billing", "waiting_on_customer", -7, "Ece Doğan", "SO-7000124", [
      [-6, "Selin Arslan", "Quotation QT-2291 expired before the order date; price list 2026/2 applied. Sent explanation, waiting for customer feedback."],
    ]),
    kase("CASE-7006", "s.wolf@hansa-pumpen.example", "Damaged packaging on delivery for SO-7000121", "Four cartons were crushed on arrival; two spare part kits are unusable. Photos attached.", "medium", "delivery", "closed", -22, "Ece Doğan", "SO-7000121", [
      [-21, "Ece Doğan", "Claim filed with carrier Marmara Lojistik."],
      [-20, "Selin Arslan", "Credit memo ACM-C-00012 (2,160.00 EUR) issued."],
    ]),
    kase("CASE-7007", "omar.almansouri@gulfwater.example", "Request for EN 10204 3.1 material certificates", "Please provide 3.1 certificates for the pump casings and shafts delivered under SO-7000127 for our client's documentation package.", "medium", "information_request", "new", -1, "Ece Doğan", "SO-7000127", []),
    kase("CASE-7008", "fn@nordwind-energy.example", "PS-200 commissioning report missing", "We have not received the signed commissioning report and FAT protocol for the PS-200 skid.", "low", "technical_support", "open", -3, "Deniz Çelik", "SO-7000123", []),
    kase("CASE-7009", "y.benali@atlasmining.example", "Impeller wear: hardened impeller option?", "Impellers in slurry service wear out after 3 months. Do you offer hardened or rubber-lined impellers for ACP-80?", "medium", "technical_support", "new", 0, "Deniz Çelik", null, []),
  ];

  const activity = (
    id: string,
    relatedTo: string,
    type: ActivityType,
    subject: string,
    notes: string | null,
    owner: string,
    offset: number,
  ): Activity => ({
    activity_id: id,
    related_to: relatedTo,
    related_type: RELATED.find((r) => relatedTo.startsWith(r.prefix))?.label ?? "other",
    type,
    subject,
    notes,
    owner,
    created_at: at(offset, 11),
  });

  const activities: Activity[] = [
    activity("ACT-8001", "OPP-6001", "meeting", "Frame agreement negotiation in Hamburg", "Customer asks for 5% rebate at 1,200 pumps/year; we offered 3%. Decision expected within 4 weeks.", "Thomas Weber", -6),
    activity("ACT-8002", "OPP-6002", "call", "Technical Q&A with Gulf Water engineering", "Open points: duplex stainless option, NPSH at 45°C seawater.", "Laura Rossi", -9),
    activity("ACT-8003", "CASE-7003", "call", "Escalation call with Petrokim maintenance", "Customer satisfied with the fast site visit; waiting for impeller replacement on pump 3.", "Ali Yıldız", -5),
    activity("ACT-8004", "LEAD-5003", "meeting", "Plant visit at Karadeniz Tekstil", "14 pumps, mostly competitor products from 2009; strong interest in energy savings (IE3 motors).", "Ali Yıldız", -25),
    activity("ACT-8005", "ACC-3008", "email", "Sent PS-200 references and datasheets", null, "Thomas Weber", -14),
    activity("ACT-8006", "OPP-6009", "call", "Price discussion with Kuzey Gıda purchasing", "Customer asks for delivery before the bottling line start-up; price accepted in principle.", "Ali Yıldız", -2),
    activity("ACT-8007", "LEAD-5002", "email", "Follow-up after Hannover Messe", "Sent AV-50 hygienic variant datasheet and EHEDG roadmap.", "Thomas Weber", -19),
    activity("ACT-8008", "CASE-7002", "note", "Logistics update", "Express truck booked for the remaining 200 valves.", "Ece Doğan", -2),
    activity("ACT-8009", "OPP-6004", "task", "Prepare retrofit offer after CASE-7003 closure", null, "Ali Yıldız", -4),
    activity("ACT-8010", "ACC-3011", "meeting", "Kick-off with Rhône Aqua purchasing", "Tender for lot 2 expected in Q1; prequalification requires ISO 9001/14001 and references in the EU.", "Laura Rossi", -55),
  ];

  return { accounts, contacts, leads, opportunities, cases, activities };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findContactByEmail(db: SandboxDb, mail: string): Promise<Contact | undefined> {
  return (await db.list<Contact>("contacts")).find((c) => c.email.toLowerCase() === mail.toLowerCase());
}

function assertKnownFields(fields: Rec, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new ConnectorError(`Cannot update ${unknown.join(", ")} on a ${what}. Updatable fields: ${allowed.join(", ")}`, "validation");
  }
  if (Object.keys(fields).length === 0) throw new ConnectorError("fields must contain at least one field to update", "validation");
}

function validScore(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value < 0 || value > 100) throw new ConnectorError("score must be between 0 and 100", "validation");
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Manifest & operations
// ---------------------------------------------------------------------------

const LEAD_FIELDS = ["company", "contact_name", "email", "phone", "source", "status", "score", "notes", "owner", "country", "interest"] as const;
const OPPORTUNITY_FIELDS = ["name", "stage", "amount", "currency", "probability", "close_date", "next_step", "owner", "products", "loss_reason"] as const;

const manifest = defineManifest({
  type: "sandbox-crm",
  name: "Sandbox CRM",
  vendor: "Enterprise Brain",
  category: "crm",
  description:
    "Built-in demo CRM of Acme Endüstri A.Ş.: customer and prospect accounts across Türkiye, Europe and the Gulf, contacts, leads, opportunities, service cases and activities. Works without credentials; changes persist per company.",
  auth: "none",
  maturity: "sandbox",
  operations: [
    readOp("search_accounts", "Search accounts", "Find accounts by name, id, industry, city, country or owner.", {
      query: str("Free-text search, e.g. 'Hansa' or 'refinery'"),
    }),
    readOp("get_account", "Get account", "Account with contacts, open opportunities, open cases and recent activities.", {
      account_id: str("Account id, e.g. ACC-3002"),
    }, ["account_id"]),
    readOp("search_contacts", "Search contacts", "Find contacts by name, title, company or e-mail address.", {
      query: str("Free-text search"),
      email: email("Exact e-mail address"),
    }),
    readOp("search_leads", "Search leads", "List leads, highest score first, optionally by status.", {
      status: oneOf(LEAD_STATUSES, "Lead status"),
    }),
    readOp("get_case", "Get case", "Service case with description, SLA and notes history.", {
      case_id: str("Case id, e.g. CASE-7003"),
    }, ["case_id"]),
    readOp("search_cases", "Search cases", "List service cases, newest first, by status and/or contact e-mail.", {
      status: oneOf(CASE_STATUSES, "Case status"),
      contact_email: email("E-mail address of the customer contact"),
    }),
    readOp("search_opportunities", "Search opportunities", "List opportunities by account and/or stage.", {
      account_id: str("Account id, e.g. ACC-3002"),
      stage: oneOf(STAGES, "Sales stage"),
    }),
    writeOp("create_lead", "Create lead", "Create a sales lead (e.g. from a web form, e-mail or trade fair). Possible duplicates (same e-mail) are reported.", {
      company: str("Company name"),
      contact_name: str("Full name of the contact person"),
      email: email("Contact e-mail address"),
      phone: str("Phone number"),
      source: str("Lead source, e.g. 'Web form', 'Trade fair: WIN EURASIA'"),
      notes: str("Qualification notes, request details"),
      score: int("Lead score 0-100"),
    }, ["company", "contact_name", "email"]),
    writeOp("update_lead", "Update lead", "Update fields of a lead (status, score, notes, owner...).", {
      lead_id: str("Lead id, e.g. LEAD-5001"),
      fields: anyObject(`Fields to change. Allowed: ${LEAD_FIELDS.join(", ")}. status is one of ${LEAD_STATUSES.join(", ")}.`),
    }, ["lead_id", "fields"]),
    writeOp("create_case", "Create case", "Open a customer service case. The contact and account are linked automatically from the e-mail address.", {
      contact_email: email("E-mail address of the customer contact"),
      subject: str("Short subject"),
      description: str("Full description of the request or complaint"),
      priority: str(`Priority: ${PRIORITIES.join(", ")}`),
      category: str(`Category: ${CASE_CATEGORIES.join(", ")} (other values are stored as 'other' with the original label)`),
      account_id: str("Account id, if known (e.g. ACC-3006)"),
    }, ["contact_email", "subject", "description", "priority", "category"]),
    writeOp("update_case", "Update case", "Change the status of a case and/or add a note.", {
      case_id: str("Case id, e.g. CASE-7003"),
      status: str(`New status: ${CASE_STATUSES.join(", ")}`),
      notes: str("Note to append to the case history"),
    }, ["case_id"]),
    writeOp("log_activity", "Log activity", "Record a call, e-mail, meeting, note or task on an account, contact, lead, opportunity or case.", {
      related_to: str("Id of the related record, e.g. OPP-6001, LEAD-5003, CASE-7002"),
      type: oneOf(ACTIVITY_TYPES, "Activity type"),
      subject: str("Subject"),
      notes: str("Details"),
    }, ["related_to", "type", "subject"]),
    writeOp("update_opportunity", "Update opportunity", "Update an opportunity (stage, amount, close date, next step...). Changing the stage sets the default probability unless one is given.", {
      opportunity_id: str("Opportunity id, e.g. OPP-6001"),
      fields: anyObject(`Fields to change. Allowed: ${OPPORTUNITY_FIELDS.join(", ")}. stage is one of ${STAGES.join(", ")}; close_date is YYYY-MM-DD.`),
    }, ["opportunity_id", "fields"]),
  ],
});

export const sandboxCrmConnector = defineSandboxConnector({
  manifest,
  keys: {
    accounts: "account_id",
    contacts: "contact_id",
    leads: "lead_id",
    opportunities: "opportunity_id",
    cases: "case_id",
    activities: "activity_id",
  },
  seed,
  operations: {
    async search_accounts(input, db) {
      const query = optString(input, "query");
      const items = (await db.list<Account>("accounts")).filter((a) =>
        matchesQuery([a.account_id, a.name, a.industry, a.segment, a.city, a.country, a.owner, a.status, a.erp_customer_id], query),
      );
      return listResult(items);
    },

    async get_account(input, db) {
      const account = await db.require<Account>("accounts", reqString(input, "account_id").toUpperCase(), "Account");
      const id = account.account_id;
      const contacts = (await db.list<Contact>("contacts")).filter((c) => c.account_id === id);
      const contactIds = new Set(contacts.map((c) => c.contact_id));
      const opportunities = (await db.list<Opportunity>("opportunities")).filter((o) => o.account_id === id);
      const cases = (await db.list<Case>("cases")).filter((c) => c.account_id === id);
      const related = new Set([id, ...contactIds, ...opportunities.map((o) => o.opportunity_id), ...cases.map((c) => c.case_id)]);
      const activities = (await db.list<Activity>("activities"))
        .filter((a) => related.has(a.related_to))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5);
      return {
        ...account,
        contacts,
        open_opportunities: opportunities.filter((o) => !o.stage.startsWith("closed")),
        pipeline_value: opportunities.filter((o) => !o.stage.startsWith("closed")).map((o) => ({ opportunity_id: o.opportunity_id, amount: o.amount, currency: o.currency })),
        open_cases: cases
          .filter((c) => c.status !== "resolved" && c.status !== "closed")
          .map((c) => ({ case_id: c.case_id, subject: c.subject, priority: c.priority, status: c.status })),
        recent_activities: activities,
      };
    },

    async search_contacts(input, db) {
      const query = optString(input, "query");
      const mail = optString(input, "email")?.toLowerCase();
      const accounts = new Map((await db.list<Account>("accounts")).map((a) => [a.account_id, a.name]));
      const items = (await db.list<Contact>("contacts"))
        .map((c) => ({ ...c, account_name: accounts.get(c.account_id) ?? null }))
        .filter((c) => (!mail || c.email.toLowerCase() === mail) && matchesQuery([c.full_name, c.title, c.email, c.account_name, c.contact_id], query));
      return listResult(items);
    },

    async search_leads(input, db) {
      const status = optEnum(input, "status", LEAD_STATUSES);
      const items = (await db.list<Lead>("leads"))
        .filter((l) => !status || l.status === status)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.created_at.localeCompare(a.created_at));
      return listResult(items);
    },

    async get_case(input, db) {
      return db.require<Case>("cases", reqString(input, "case_id").toUpperCase(), "Case");
    },

    async search_cases(input, db) {
      const status = optEnum(input, "status", CASE_STATUSES);
      const mail = optString(input, "contact_email")?.toLowerCase();
      const items = (await db.list<Case>("cases"))
        .filter((c) => (!status || c.status === status) && (!mail || c.contact_email.toLowerCase() === mail))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return listResult(items);
    },

    async search_opportunities(input, db) {
      const accountId = optString(input, "account_id")?.toUpperCase();
      const stage = optEnum(input, "stage", STAGES);
      const items = (await db.list<Opportunity>("opportunities")).filter(
        (o) => (!accountId || o.account_id === accountId) && (!stage || o.stage === stage),
      );
      return listResult(items);
    },

    async create_lead(input, db) {
      const mail = normalizeEmail(reqString(input, "email"));
      const now = nowIso();
      const leads = await db.list<Lead>("leads");
      const possibleDuplicates = [
        ...leads.filter((l) => l.email.toLowerCase() === mail).map((l) => l.lead_id),
        ...(await db.list<Contact>("contacts")).filter((c) => c.email.toLowerCase() === mail).map((c) => c.contact_id),
      ];
      const lead: Lead = {
        lead_id: await db.nextId("leads", "LEAD-", 4),
        company: reqString(input, "company"),
        contact_name: reqString(input, "contact_name"),
        email: mail,
        phone: optString(input, "phone") ?? null,
        source: optString(input, "source") ?? "Other",
        status: "new",
        score: validScore(optNumber(input, "score")) ?? null,
        notes: optString(input, "notes") ?? null,
        owner: "Ali Yıldız",
        country: null,
        interest: null,
        created_at: now,
        updated_at: now,
      };
      await db.put("leads", lead);
      return { ...lead, ok: true, possible_duplicates: possibleDuplicates };
    },

    async update_lead(input, db) {
      const lead = await db.require<Lead>("leads", reqString(input, "lead_id").toUpperCase(), "Lead");
      const fields = reqRecord(input, "fields");
      assertKnownFields(fields, LEAD_FIELDS, "lead");
      const updated: Lead = { ...lead };
      for (const key of Object.keys(fields)) {
        switch (key) {
          case "status":
            updated.status = reqEnum(fields, "status", LEAD_STATUSES, LEAD_STATUS_SYNONYMS);
            break;
          case "score":
            updated.score = validScore(optNumber(fields, "score")) ?? null;
            break;
          case "email":
            updated.email = normalizeEmail(reqString(fields, "email"));
            break;
          case "company":
          case "contact_name":
          case "source":
          case "owner":
            updated[key] = reqString(fields, key);
            break;
          case "phone":
          case "notes":
          case "country":
          case "interest":
            updated[key] = optString(fields, key) ?? null;
            break;
        }
      }
      updated.updated_at = nowIso();
      await db.put("leads", updated);
      return { ...updated, ok: true, changed_fields: Object.keys(fields) };
    },

    async create_case(input, db) {
      const mail = normalizeEmail(reqString(input, "contact_email"), "contact_email");
      const priority = reqEnum(input, "priority", PRIORITIES, PRIORITY_SYNONYMS);
      const categoryInput = reqString(input, "category");
      let category: CaseCategory = "other";
      let categoryDetail: string | null = null;
      try {
        category = toEnum(categoryInput, "category", CASE_CATEGORIES, CATEGORY_SYNONYMS);
      } catch {
        categoryDetail = categoryInput;
      }
      const contact = await findContactByEmail(db, mail);
      const accountId = optString(input, "account_id")?.toUpperCase() ?? contact?.account_id ?? null;
      const account = accountId ? await db.require<Account>("accounts", accountId, "Account") : undefined;
      const createdAt = Date.now();
      const now = new Date(createdAt).toISOString();
      const kase: Case = {
        case_id: await db.nextId("cases", "CASE-", 4),
        account_id: account?.account_id ?? null,
        account_name: account?.name ?? null,
        contact_email: mail,
        contact_name: contact?.full_name ?? null,
        subject: reqString(input, "subject"),
        description: reqString(input, "description"),
        priority,
        category,
        category_detail: categoryDetail,
        status: "new",
        owner: category === "technical_support" ? "Deniz Çelik" : category === "quality" ? "Merve Aksoy" : "Ece Doğan",
        related_order: /SO-\d{7}/.exec(`${optString(input, "subject")} ${optString(input, "description")}`)?.[0] ?? null,
        sla_due_at: new Date(createdAt + CASE_SLA_HOURS[priority] * 3_600_000).toISOString(),
        created_at: now,
        updated_at: now,
        resolved_at: null,
        notes: [],
      };
      await db.put("cases", kase);
      return { ...kase, ok: true, contact_known: Boolean(contact) };
    },

    async update_case(input, db) {
      const kase = await db.require<Case>("cases", reqString(input, "case_id").toUpperCase(), "Case");
      const status = optEnum(input, "status", CASE_STATUSES, CASE_STATUS_SYNONYMS);
      const note = optString(input, "notes");
      if (!status && !note) throw new ConnectorError("Provide a new status and/or notes", "validation");
      const now = nowIso();
      if (status) {
        kase.status = status;
        kase.resolved_at = status === "resolved" || status === "closed" ? (kase.resolved_at ?? now) : null;
      }
      if (note) kase.notes.push({ at: now, author: AGENT, text: note });
      kase.updated_at = now;
      await db.put("cases", kase);
      return { ...kase, ok: true };
    },

    async log_activity(input, db) {
      const relatedTo = reqString(input, "related_to").toUpperCase();
      const target = RELATED.find((r) => relatedTo.startsWith(r.prefix));
      if (!target) {
        throw new ConnectorError(`related_to must be an account, contact, lead, opportunity or case id (ACC-, CON-, LEAD-, OPP-, CASE-); got "${relatedTo}"`, "validation");
      }
      await db.require(target.entity, relatedTo, target.label.charAt(0).toUpperCase() + target.label.slice(1));
      const activity: Activity = {
        activity_id: await db.nextId("activities", "ACT-", 4),
        related_to: relatedTo,
        related_type: target.label,
        type: reqEnum(input, "type", ACTIVITY_TYPES),
        subject: reqString(input, "subject"),
        notes: optString(input, "notes") ?? null,
        owner: AGENT,
        created_at: nowIso(),
      };
      await db.put("activities", activity);
      return { ...activity, ok: true };
    },

    async update_opportunity(input, db) {
      const opportunity = await db.require<Opportunity>("opportunities", reqString(input, "opportunity_id").toUpperCase(), "Opportunity");
      const fields = reqRecord(input, "fields");
      assertKnownFields(fields, OPPORTUNITY_FIELDS, "opportunity");
      const updated: Opportunity = { ...opportunity };
      for (const key of Object.keys(fields)) {
        switch (key) {
          case "stage":
            updated.stage = reqEnum(fields, "stage", STAGES, STAGE_SYNONYMS);
            if (fields.probability === undefined) updated.probability = STAGE_PROBABILITY[updated.stage];
            break;
          case "amount": {
            const amount = optNumber(fields, "amount");
            if (amount === undefined || amount < 0) throw new ConnectorError("amount must be a non-negative number", "validation");
            updated.amount = amount;
            break;
          }
          case "probability": {
            const probability = optNumber(fields, "probability");
            if (probability === undefined || probability < 0 || probability > 100) {
              throw new ConnectorError("probability must be between 0 and 100", "validation");
            }
            updated.probability = Math.round(probability);
            break;
          }
          case "close_date":
            updated.close_date = parseIsoDate(reqString(fields, "close_date"), "close_date");
            break;
          case "currency":
            updated.currency = reqString(fields, "currency").toUpperCase();
            break;
          case "products": {
            const products = fields.products;
            if (!Array.isArray(products) || !products.every((p) => typeof p === "string")) {
              throw new ConnectorError("products must be a list of strings", "validation");
            }
            updated.products = products;
            break;
          }
          case "name":
          case "owner":
            updated[key] = reqString(fields, key);
            break;
          case "next_step":
          case "loss_reason":
            updated[key] = optString(fields, key) ?? null;
            break;
        }
      }
      if (updated.stage === "closed_lost" && !updated.loss_reason && "stage" in fields) {
        updated.loss_reason = "Not specified";
      }
      updated.updated_at = nowIso();
      await db.put("opportunities", updated);
      return { ...updated, ok: true, changed_fields: Object.keys(fields) };
    },
  },
});

