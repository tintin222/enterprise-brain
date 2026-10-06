import { slugify } from "@enterprise-brain/core";
import type { SourceEntity, SourceLink } from "../types.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * A made-up HR system (standing in for SAP SuccessFactors) for the demo company, Acme Endüstri: its
 * departments, sites, roles and the 29 people who work there, including the people who use the app,
 * with their managers, skills and what each of them knows best.
 */

type Site = "istanbul-hq" | "gebze-plant" | "hamburg-office";

interface Person {
  local: string;
  name: string;
  title: string;
  department: string;
  manager?: string;
  site: Site;
  started: string;
  status?: "Active" | "On leave";
  skills: string[];
  languages: string[];
}

const SITES: { key: Site; name: string; type: string; city: string; country: string; address: string; summary: string }[] = [
  {
    key: "istanbul-hq",
    name: "Istanbul HQ (Ataşehir)",
    type: "Headquarters",
    city: "İstanbul",
    country: "Türkiye",
    address: "Barbaros Mah. Begonya Sok. No:3, 34746 Ataşehir/İstanbul",
    summary: "Management, finance, HR, IT, sales Türkiye and customer service.",
  },
  {
    key: "gebze-plant",
    name: "Gebze Plant",
    type: "Plant",
    city: "Gebze, Kocaeli",
    country: "Türkiye",
    address: "Gebze Organize Sanayi Bölgesi, 1600. Sok. No:1601, 41400 Gebze/Kocaeli",
    summary: "Machining, assembly, two pump test benches, quality, maintenance, warehouse and the server room.",
  },
  {
    key: "hamburg-office",
    name: "Hamburg Sales Office",
    type: "Office",
    city: "Hamburg",
    country: "Germany",
    address: "Am Sandtorkai 41, 20457 Hamburg",
    summary: "Acme Pumpen GmbH: export sales for Europe, the Middle East and Africa.",
  },
];

const DEPARTMENTS: { key: string; name: string; head: string; site: Site; mission: string; email?: string; costCenter: string }[] = [
  {
    key: "management",
    name: "Management",
    head: "mehmet.aydin",
    site: "istanbul-hq",
    costCenter: "CC-1000",
    mission: "Runs the company: strategy, the biggest customers, and how the departments work together.",
  },
  {
    key: "finance",
    name: "Finance & Accounting",
    head: "elif.yilmaz",
    site: "istanbul-hq",
    costCenter: "CC-2000",
    email: "invoices",
    mission: "Pays suppliers correctly and on time, collects from customers, closes the books every month and reports the numbers.",
  },
  {
    key: "hr",
    name: "Human Resources",
    head: "zeynep.demir",
    site: "istanbul-hq",
    costCenter: "CC-3000",
    email: "careers",
    mission: "Finds, hires, pays and looks after the company's people.",
  },
  {
    key: "it",
    name: "Information Technology",
    head: "mehmet.oz",
    site: "istanbul-hq",
    costCenter: "CC-2500",
    email: "it-helpdesk",
    mission: "Keeps the systems, the network and the data running and safe, and helps people use them.",
  },
  {
    key: "customer-service",
    name: "Customer Service",
    head: "zeynep.kaya",
    site: "istanbul-hq",
    costCenter: "CC-5300",
    email: "support",
    mission: "Answers customers' questions about orders, deliveries and spare parts, and handles their complaints and returns.",
  },
  {
    key: "operations",
    name: "Operations",
    head: "okan.tekin",
    site: "gebze-plant",
    costCenter: "CC-4000",
    email: "quality",
    mission: "Makes, tests and ships the pumps at the Gebze plant: production, quality, maintenance, warehouse and logistics.",
  },
  {
    key: "procurement",
    name: "Procurement",
    head: "ayse.kaya",
    site: "gebze-plant",
    costCenter: "CC-4200",
    mission: "Buys materials and services at the right price and quality, from approved suppliers.",
  },
  {
    key: "sales",
    name: "Sales",
    head: "thomas.weber",
    site: "hamburg-office",
    costCenter: "CC-5000",
    email: "sales",
    mission: "Wins and keeps customers in Türkiye and abroad, and prices the offers.",
  },
];

const PEOPLE: Person[] = [
  {
    local: "mehmet.aydin",
    name: "Mehmet Aydın",
    title: "Chief Executive Officer",
    department: "management",
    site: "istanbul-hq",
    started: "2008-01-15",
    skills: ["Strategy", "Key customer relationships", "Pump industry"],
    languages: ["Turkish", "English"],
  },
  {
    local: "elif.yilmaz",
    name: "Elif Yılmaz",
    title: "Chief Financial Officer",
    department: "finance",
    manager: "mehmet.aydin",
    site: "istanbul-hq",
    started: "2017-04-03",
    skills: ["Financial planning", "Treasury", "IFRS"],
    languages: ["Turkish", "English"],
  },
  {
    local: "burak.sahin",
    name: "Burak Şahin",
    title: "Finance Manager",
    department: "finance",
    manager: "elif.yilmaz",
    site: "istanbul-hq",
    started: "2019-09-02",
    skills: ["Accounts payable", "Collections", "SAP FI", "Approvals"],
    languages: ["Turkish", "English"],
  },
  {
    local: "elif.arslan",
    name: "Elif Arslan",
    title: "Accounts Payable Specialist",
    department: "finance",
    manager: "burak.sahin",
    site: "istanbul-hq",
    started: "2022-02-14",
    skills: ["Invoice processing", "3-way match", "e-Fatura", "SAP FI"],
    languages: ["Turkish", "English"],
  },
  {
    local: "selin.arslan",
    name: "Selin Arslan",
    title: "Chief Accountant",
    department: "finance",
    manager: "elif.yilmaz",
    site: "istanbul-hq",
    started: "2015-06-01",
    skills: ["Month-end close", "Statutory accounts (VUK)", "Tax returns"],
    languages: ["Turkish"],
  },
  {
    local: "hande.ozkan",
    name: "Hande Özkan",
    title: "Financial Controller",
    department: "finance",
    manager: "elif.yilmaz",
    site: "istanbul-hq",
    started: "2021-03-01",
    status: "On leave",
    skills: ["Consolidation", "Power BI", "Budgeting"],
    languages: ["Turkish", "English", "German"],
  },
  {
    local: "zeynep.demir",
    name: "Zeynep Demir",
    title: "HR Director",
    department: "hr",
    manager: "mehmet.aydin",
    site: "istanbul-hq",
    started: "2018-02-12",
    skills: ["Labour law", "Compensation", "Organization design"],
    languages: ["Turkish", "English"],
  },
  {
    local: "ayse.yilmaz",
    name: "Ayşe Yılmaz",
    title: "HR Manager",
    department: "hr",
    manager: "zeynep.demir",
    site: "istanbul-hq",
    started: "2020-05-18",
    skills: ["Recruitment", "Onboarding", "Leave management", "SuccessFactors"],
    languages: ["Turkish", "English"],
  },
  {
    local: "can.demir",
    name: "Can Demir",
    title: "Recruitment Specialist",
    department: "hr",
    manager: "ayse.yilmaz",
    site: "istanbul-hq",
    started: "2023-01-09",
    skills: ["Recruitment", "Interviewing", "Kariyer.net", "LinkedIn Recruiter"],
    languages: ["Turkish", "English"],
  },
  {
    local: "gizem.polat",
    name: "Gizem Polat",
    title: "HR Specialist (Payroll and Leave)",
    department: "hr",
    manager: "ayse.yilmaz",
    site: "istanbul-hq",
    started: "2024-04-01",
    skills: ["Payroll", "Logo Bordro", "Leave balances", "SGK filings"],
    languages: ["Turkish"],
  },
  {
    local: "mehmet.oz",
    name: "Mehmet Öz",
    title: "IT Manager",
    department: "it",
    manager: "elif.yilmaz",
    site: "istanbul-hq",
    started: "2019-11-04",
    skills: ["IT strategy", "SAP Basis", "Microsoft 365", "Network and security"],
    languages: ["Turkish", "English"],
  },
  {
    local: "emre.koc",
    name: "Emre Koç",
    title: "IT Support Specialist",
    department: "it",
    manager: "mehmet.oz",
    site: "istanbul-hq",
    started: "2023-06-12",
    skills: ["Service desk", "Microsoft 365 administration", "Laptops and printers", "Jira Service Management"],
    languages: ["Turkish", "English"],
  },
  {
    local: "can.ozturk",
    name: "Can Öztürk",
    title: "Systems Engineer",
    department: "it",
    manager: "mehmet.oz",
    site: "gebze-plant",
    started: "2016-08-22",
    skills: ["VMware", "SQL Server", "Veeam backups", "MES servers", "Networking"],
    languages: ["Turkish", "English"],
  },
  {
    local: "ozan.kurt",
    name: "Ozan Kurt",
    title: "Software Developer",
    department: "it",
    manager: "mehmet.oz",
    site: "istanbul-hq",
    started: "2025-02-03",
    skills: [".NET", "Azure", "SQL", "Integrations"],
    languages: ["Turkish", "English"],
  },
  {
    local: "zeynep.kaya",
    name: "Zeynep Kaya",
    title: "Customer Service Lead",
    department: "customer-service",
    manager: "thomas.weber",
    site: "istanbul-hq",
    started: "2018-10-01",
    skills: ["Complaint handling", "Salesforce Service Cloud", "Returns (RMA)"],
    languages: ["Turkish", "English", "German"],
  },
  {
    local: "deniz.aydin",
    name: "Deniz Aydın",
    title: "Customer Service Agent",
    department: "customer-service",
    manager: "zeynep.kaya",
    site: "istanbul-hq",
    started: "2024-09-16",
    skills: ["Order status questions", "Salesforce", "Spare parts quotes"],
    languages: ["Turkish", "English"],
  },
  {
    local: "ece.dogan",
    name: "Ece Doğan",
    title: "Customer Service Specialist",
    department: "customer-service",
    manager: "zeynep.kaya",
    site: "istanbul-hq",
    started: "2022-03-07",
    skills: ["Deliveries", "Returns", "SAP SD"],
    languages: ["Turkish", "English"],
  },
  {
    local: "okan.tekin",
    name: "Okan Tekin",
    title: "Plant Manager",
    department: "operations",
    manager: "mehmet.aydin",
    site: "gebze-plant",
    started: "2012-07-02",
    skills: ["Lean manufacturing", "Production planning", "Plant safety"],
    languages: ["Turkish", "English"],
  },
  {
    local: "selin.acar",
    name: "Selin Acar",
    title: "Quality Manager",
    department: "operations",
    manager: "okan.tekin",
    site: "gebze-plant",
    started: "2017-01-16",
    skills: ["ISO 9001", "8D problem solving", "Supplier quality", "Audits"],
    languages: ["Turkish", "English"],
  },
  {
    local: "kerem.yildiz",
    name: "Kerem Yıldız",
    title: "Quality Engineer",
    department: "operations",
    manager: "selin.acar",
    site: "gebze-plant",
    started: "2021-09-01",
    skills: ["8D reports", "Root cause analysis", "Vibration analysis", "SAP QM"],
    languages: ["Turkish", "English"],
  },
  {
    local: "merve.aksoy",
    name: "Merve Aksoy",
    title: "Quality Engineer",
    department: "operations",
    manager: "selin.acar",
    site: "gebze-plant",
    started: "2023-04-10",
    skills: ["Incoming inspection", "Customer complaints", "Measurement"],
    languages: ["Turkish", "English"],
  },
  {
    local: "deniz.celik",
    name: "Deniz Çelik",
    title: "Production Engineer",
    department: "operations",
    manager: "okan.tekin",
    site: "gebze-plant",
    started: "2021-11-15",
    skills: ["Pump assembly", "Test benches", "Opcenter MES", "Work instructions"],
    languages: ["Turkish", "English"],
  },
  {
    local: "hakan.erdogan",
    name: "Hakan Erdoğan",
    title: "Maintenance Technician",
    department: "operations",
    manager: "okan.tekin",
    site: "gebze-plant",
    started: "2009-03-02",
    skills: ["Test bench calibration", "Preventive maintenance", "Machining centers", "Hydraulics"],
    languages: ["Turkish"],
  },
  {
    local: "serkan.gunes",
    name: "Serkan Güneş",
    title: "Warehouse Supervisor",
    department: "operations",
    manager: "okan.tekin",
    site: "gebze-plant",
    started: "2018-06-04",
    skills: ["Goods receipt", "Shipping", "SAP WM", "Packaging"],
    languages: ["Turkish"],
  },
  {
    local: "murat.kilic",
    name: "Murat Kılıç",
    title: "Logistics Specialist",
    department: "operations",
    manager: "serkan.gunes",
    site: "gebze-plant",
    started: "2025-01-13",
    skills: ["Export documents", "Freight booking", "Customs"],
    languages: ["Turkish", "English"],
  },
  {
    local: "ayse.kaya",
    name: "Ayşe Kaya",
    title: "Procurement Manager",
    department: "procurement",
    manager: "okan.tekin",
    site: "gebze-plant",
    started: "2017-03-20",
    skills: ["Supplier negotiation", "SAP MM", "Castings sourcing", "Supplier audits"],
    languages: ["Turkish", "English", "Italian"],
  },
  {
    local: "thomas.weber",
    name: "Thomas Weber",
    title: "Sales Director",
    department: "sales",
    manager: "mehmet.aydin",
    site: "hamburg-office",
    started: "2019-10-01",
    skills: ["Export sales", "OEM accounts", "Pricing"],
    languages: ["German", "English"],
  },
  {
    local: "ali.yildiz",
    name: "Ali Yıldız",
    title: "Key Account Manager Türkiye",
    department: "sales",
    manager: "thomas.weber",
    site: "istanbul-hq",
    started: "2019-01-07",
    skills: ["Oil and gas accounts", "Tenders", "Pump selection"],
    languages: ["Turkish", "English"],
  },
  {
    local: "laura.rossi",
    name: "Laura Rossi",
    title: "Export Sales Manager EMEA",
    department: "sales",
    manager: "thomas.weber",
    site: "hamburg-office",
    started: "2022-04-04",
    skills: ["EPC projects", "Middle East", "Price calculator", "FAT coordination"],
    languages: ["Italian", "English", "German", "Spanish"],
  },
];

/** What each role is responsible for. */
const ROLES: Record<string, { responsibilities: string[]; skills?: string[]; grade: string }> = {
  "Chief Executive Officer": {
    grade: "E1",
    responsibilities: ["Company strategy and the yearly plan", "The biggest customers and partners", "Approves spending above 2,000,000 TRY"],
  },
  "Chief Financial Officer": {
    grade: "M3",
    responsibilities: [
      "Financial control and reporting",
      "Approves payments above 1,000,000 TRY",
      "Banks, treasury and financing",
      "IT, through the IT Manager",
    ],
  },
  "Finance Manager": {
    grade: "M2",
    responsibilities: [
      "Accounts payable and receivable",
      "Approves invoices above 250,000 TRY and match exceptions",
      "Collections and payment plans",
      "The weekly payment run",
    ],
  },
  "Accounts Payable Specialist": {
    grade: "P2",
    responsibilities: [
      "Checks and posts supplier invoices",
      "Resolves differences between invoice, order and goods receipt",
      "Answers suppliers' payment questions",
    ],
    skills: ["SAP FI", "e-Fatura"],
  },
  "Chief Accountant": { grade: "M1", responsibilities: ["Month-end close", "Statutory books (VUK) and tax returns", "Reconciliations"] },
  "Financial Controller": {
    grade: "P3",
    responsibilities: ["Monthly consolidation and management report", "Budget and forecast", "Cost center reports"],
    skills: ["Power BI", "Excel"],
  },
  "HR Director": { grade: "M3", responsibilities: ["People strategy", "Pay and benefits", "Labour law and employee relations"] },
  "HR Manager": { grade: "M2", responsibilities: ["Recruitment, onboarding and leave", "HR policies", "HR systems (SuccessFactors)"] },
  "Recruitment Specialist": { grade: "P2", responsibilities: ["Job postings and CV screening", "Interviews and offers", "Candidate experience"] },
  "HR Specialist (Payroll and Leave)": { grade: "P2", responsibilities: ["Monthly payroll in Logo Bordro", "Leave balances", "SGK filings"] },
  "IT Manager": { grade: "M2", responsibilities: ["IT systems, security and budget", "SAP and Microsoft 365", "IT suppliers and projects"] },
  "IT Support Specialist": { grade: "P1", responsibilities: ["Service desk tickets", "Laptops, accounts and access", "Microsoft 365 administration"] },
  "Systems Engineer": { grade: "P3", responsibilities: ["Servers, VMware and backups", "SQL Server databases", "Plant network and MES servers"] },
  "Software Developer": { grade: "P2", responsibilities: ["The customer portal", "Integrations between systems", "Reports"] },
  "Customer Service Lead": { grade: "M1", responsibilities: ["Customer questions and complaints", "Returns (RMA)", "The team's answer times"] },
  "Customer Service Agent": { grade: "P1", responsibilities: ["Answers customer emails and calls", "Order status", "Logs cases in Salesforce"] },
  "Customer Service Specialist": { grade: "P2", responsibilities: ["Delivery and spare part questions", "Spare parts orders", "Returns"] },
  "Plant Manager": {
    grade: "M3",
    responsibilities: [
      "The Gebze plant: production, quality, maintenance and warehouse",
      "On-time delivery",
      "Plant safety",
      "Approves purchase orders above 500,000 TRY",
    ],
  },
  "Quality Manager": { grade: "M2", responsibilities: ["The quality system (ISO 9001)", "Customer complaints and 8D", "Supplier quality and audits"] },
  "Quality Engineer": { grade: "P2", responsibilities: ["8D reports and root cause analysis", "Incoming and final inspection", "Measurement"] },
  "Production Engineer": { grade: "P3", responsibilities: ["Assembly and test processes", "Work instructions", "Production problems"] },
  "Maintenance Technician": { grade: "P2", responsibilities: ["Preventive maintenance", "Test bench calibration", "Breakdowns"] },
  "Warehouse Supervisor": { grade: "P3", responsibilities: ["Goods receipt and shipping", "Stock accuracy", "Packaging"] },
  "Logistics Specialist": { grade: "P1", responsibilities: ["Freight booking", "Export and customs documents"] },
  "Procurement Manager": { grade: "M2", responsibilities: ["Suppliers and prices", "Purchase orders up to 500,000 TRY", "Supplier audits and second sources"] },
  "Sales Director": { grade: "M3", responsibilities: ["Sales targets and pricing", "Export markets", "Approves discounts above 15%"] },
  "Key Account Manager Türkiye": { grade: "P3", responsibilities: ["Turkish key accounts", "Tenders and quotations", "Customer visits"] },
  "Export Sales Manager EMEA": {
    grade: "P3",
    responsibilities: ["Customers and EPC projects in EMEA", "Quotations with the price calculator", "FAT dates with customers"],
  },
};

/** Who knows what best, from the skills matrix: [person, kind, key, how well]. */
const KNOWS: [string, "process" | "system", string, string][] = [
  ["elif.arslan", "process", "finance.accounts-payable", "Expert"],
  ["burak.sahin", "process", "finance.accounts-payable", "Can do it"],
  ["elif.arslan", "system", "uyumsoft-e-fatura", "Expert"],
  ["selin.arslan", "process", "finance.month-end-close", "Expert"],
  ["burak.sahin", "process", "finance.month-end-close", "Can do it"],
  ["hande.ozkan", "process", "consolidation-reporting", "Expert"],
  ["hande.ozkan", "system", "power-bi", "Expert"],
  ["ozan.kurt", "system", "power-bi", "Learning"],
  ["burak.sahin", "process", "finance.collections", "Expert"],
  ["selin.acar", "process", "operations.quality-incidents", "Expert"],
  ["kerem.yildiz", "process", "operations.quality-incidents", "Expert"],
  ["merve.aksoy", "process", "operations.quality-incidents", "Can do it"],
  ["deniz.celik", "process", "pump-final-test", "Expert"],
  ["hakan.erdogan", "process", "pump-final-test", "Expert"],
  ["hakan.erdogan", "process", "preventive-maintenance", "Expert"],
  ["hakan.erdogan", "system", "pumptest-pro", "Expert"],
  ["deniz.celik", "system", "pumptest-pro", "Can do it"],
  ["deniz.celik", "system", "opcenter-mes", "Expert"],
  ["can.ozturk", "system", "opcenter-mes", "Expert"],
  ["kerem.yildiz", "system", "opcenter-mes", "Can do it"],
  ["mehmet.oz", "system", "sap-s4hana", "Expert"],
  ["can.ozturk", "system", "sap-s4hana", "Can do it"],
  ["elif.arslan", "system", "sap-s4hana", "Can do it"],
  ["ayse.kaya", "system", "sap-s4hana", "Can do it"],
  ["gizem.polat", "system", "logo-bordro", "Expert"],
  ["ayse.yilmaz", "system", "successfactors", "Expert"],
  ["can.demir", "system", "successfactors", "Can do it"],
  ["laura.rossi", "system", "price-calculator", "Expert"],
  ["thomas.weber", "system", "salesforce", "Expert"],
  ["zeynep.kaya", "system", "salesforce", "Expert"],
  ["ozan.kurt", "system", "customer-portal", "Expert"],
  ["emre.koc", "system", "microsoft-365", "Expert"],
  ["mehmet.oz", "system", "microsoft-365", "Can do it"],
  ["ayse.kaya", "process", "procurement.purchase-requisition", "Expert"],
  ["okan.tekin", "process", "order-to-delivery", "Expert"],
  ["ali.yildiz", "process", "sales.quote-preparation", "Expert"],
  ["laura.rossi", "process", "sales.quote-preparation", "Expert"],
  ["can.demir", "process", "hr.recruitment", "Expert"],
  ["ayse.yilmaz", "process", "hr.recruitment", "Expert"],
  ["emre.koc", "process", "it.helpdesk-triage", "Expert"],
];

export const hrSource: BrainSourceDefinition = {
  key: "hr",
  name: "HR system (demo)",
  system: "SAP SuccessFactors",
  description: "The org chart: departments, sites, roles, every employee with their manager, skills and languages, and who knows which process or system best.",
  brings: ["People and managers", "Departments and sites", "Roles and responsibilities", "Skills: who knows what"],
  icon: "users",
  demo: true,
  priority: 60,
  async read({ domain, companyName }) {
    const email = (local: string) => `${local}@${domain}`;
    const entities: SourceEntity[] = [
      {
        kind: "company",
        key: "company",
        name: companyName,
        data: { employees: 180, headquarters: "Istanbul (Ataşehir)" },
      },
    ];
    const links: SourceLink[] = [];
    for (const site of SITES)
      entities.push({
        kind: "site",
        ref: site.key,
        key: site.key,
        name: site.name,
        summary: site.summary,
        data: { type: site.type, city: site.city, country: site.country, address: site.address },
      });
    for (const department of DEPARTMENTS) {
      const people = PEOPLE.filter((p) => p.department === department.key).length;
      entities.push({
        kind: "department",
        ref: department.key,
        key: department.key,
        name: department.name,
        data: {
          mission: department.mission,
          headcount: people,
          cost_center: department.costCenter,
          email: department.email ? `${department.email}@${domain}` : undefined,
        },
      });
      links.push({ from: { kind: "department", key: department.key }, relation: "part_of", to: { kind: "company", key: "company" } });
      links.push({ from: { kind: "person", email: email(department.head) }, relation: "heads", to: { kind: "department", key: department.key } });
      links.push({ from: { kind: "department", key: department.key }, relation: "located_at", to: { kind: "site", key: department.site } });
    }
    links.push({ from: { kind: "person", email: email("mehmet.aydin") }, relation: "heads", to: { kind: "company", key: "company" } });
    for (const [title, role] of Object.entries(ROLES)) {
      const holders = PEOPLE.filter((p) => p.title === title);
      entities.push({
        kind: "role",
        ref: slugify(title, 80),
        key: slugify(title, 80),
        name: title,
        data: { responsibilities: role.responsibilities, skills_needed: role.skills ?? [], grade: role.grade },
      });
      const department = holders[0]?.department;
      if (department) links.push({ from: { kind: "role", key: slugify(title, 80) }, relation: "works_in", to: { kind: "department", key: department } });
    }
    for (const person of PEOPLE) {
      entities.push({
        kind: "person",
        ref: person.local,
        name: person.name,
        data: {
          title: person.title,
          email: email(person.local),
          status: person.status ?? "Active",
          started: person.started,
          skills: person.skills,
          languages: person.languages,
        },
      });
      const me = { kind: "person" as const, email: email(person.local) };
      links.push({ from: me, relation: "works_in", to: { kind: "department", key: person.department } });
      links.push({ from: me, relation: "located_at", to: { kind: "site", key: person.site } });
      links.push({ from: me, relation: "holds", to: { kind: "role", key: slugify(person.title, 80) } });
      if (person.manager) links.push({ from: me, relation: "reports_to", to: { kind: "person", email: email(person.manager) } });
    }
    for (const [local, kind, key, level] of KNOWS)
      links.push({ from: { kind: "person", email: email(local) }, relation: "knows", to: { kind, key }, detail: level });
    // Hande Özkan's leave, as the HR system has it.
    const hande = entities.find((e) => e.ref === "hande.ozkan");
    if (hande) hande.summary = "On parental leave until the end of next month.";
    return { entities, links };
  },
};
