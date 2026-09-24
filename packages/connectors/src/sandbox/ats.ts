import { defineManifest } from "../define.ts";
import { dateTime, email, int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError } from "../types.ts";
import {
  normalizeEmail,
  optEnum,
  optNumber,
  optString,
  parseIsoDateTime,
  reqEnum,
  reqString,
  type Rec,
} from "../util.ts";
import { defineSandboxConnector, listResult, nowIso, relativeDates, type SandboxDb } from "./common.ts";

const REQUISITION_STATUSES = ["draft", "open", "on_hold", "filled", "closed"] as const;
const STAGES = ["applied", "screening", "interview", "assessment", "offer", "hired", "rejected", "withdrawn"] as const;

const STAGE_SYNONYMS: Record<string, (typeof STAGES)[number]> = {
  new: "applied",
  received: "applied",
  application: "applied",
  screen: "screening",
  phone_screen: "screening",
  shortlist: "screening",
  shortlisted: "screening",
  review: "screening",
  interviewing: "interview",
  phone_interview: "interview",
  technical_interview: "interview",
  onsite: "interview",
  test: "assessment",
  assignment: "assessment",
  case_study: "assessment",
  offered: "offer",
  offer_sent: "offer",
  hire: "hired",
  accepted: "hired",
  reject: "rejected",
  declined: "rejected",
  not_selected: "rejected",
  disqualified: "rejected",
  withdraw: "withdrawn",
  withdrew: "withdrawn",
};

type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
type Stage = (typeof STAGES)[number];

const DOMAIN = "acme.example";

interface Requisition {
  requisition_id: string;
  title: string;
  department: string;
  location: string;
  work_model: "on_site" | "hybrid" | "remote";
  employment_type: "full_time" | "part_time" | "fixed_term";
  status: RequisitionStatus;
  openings: number;
  hires: number;
  hiring_manager_id: string;
  hiring_manager: string;
  hiring_manager_email: string;
  recruiter: string;
  recruiter_email: string;
  position_id: string | null;
  salary_band: string;
  posted_at: string | null;
  target_start_date: string;
  description: string;
  requirements: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  languages: string[];
  min_years_experience: number;
  education: string;
}

interface StageChange {
  at: string;
  stage: Stage;
  note: string | null;
}

interface Candidate {
  candidate_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  requisition_id: string | null;
  requisition_title: string | null;
  stage: Stage;
  score: number | null;
  summary: string | null;
  source: string;
  location: string | null;
  current_title: string | null;
  current_company: string | null;
  years_experience: number | null;
  skills: string[];
  languages: string[];
  cv_file_id: string | null;
  applied_at: string;
  updated_at: string;
  history: StageChange[];
}

interface Interview {
  interview_id: string;
  candidate_id: string;
  candidate_name: string;
  requisition_id: string | null;
  interviewer_email: string;
  start: string;
  end: string;
  duration_minutes: number;
  format: "video" | "onsite" | "phone";
  status: "scheduled" | "completed" | "cancelled";
  meeting_link: string | null;
  feedback: string | null;
  created_at: string;
}

function seed(today: Date): Record<string, object[]> {
  const { day, at } = relativeDates(today);

  const requisitions: Requisition[] = [
    {
      requisition_id: "REQ-301",
      title: "Senior Backend Engineer (Node.js)",
      department: "IT",
      location: "Istanbul HQ (Ataşehir), hybrid: 3 office days",
      work_model: "hybrid",
      employment_type: "full_time",
      status: "open",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0007",
      hiring_manager: "Can Öztürk",
      hiring_manager_email: `can.ozturk@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-121",
      salary_band: "P4",
      posted_at: at(-21),
      target_start_date: day(60),
      description:
        "Build and run the integration layer that connects our plants' MES, SAP S/4HANA and the customer and dealer portal. You design APIs, event-driven integrations and data pipelines used by production, sales and finance, and you mentor two developers.",
      requirements: [
        "5+ years of professional backend development, at least 3 years with Node.js and TypeScript",
        "Designing, documenting (OpenAPI) and operating REST APIs; OAuth 2.0 / OpenID Connect",
        "Solid SQL with PostgreSQL: schema design, query tuning, migrations",
        "Docker and CI/CD pipelines; Kubernetes is a plus",
        "Messaging and event streaming (RabbitMQ or Kafka)",
        "Integrating ERP systems (SAP OData, BAPI or IDoc) is a strong plus",
        "English B2 or better; Turkish is a plus",
        "Bachelor's degree in computer engineering or equivalent experience",
      ].join("\n"),
      must_have_skills: ["Node.js", "TypeScript", "REST API design", "PostgreSQL", "Docker"],
      nice_to_have_skills: ["Kubernetes", "Kafka", "RabbitMQ", "SAP integration", "Azure", "GraphQL"],
      languages: ["English (B2+)", "Turkish (nice to have)"],
      min_years_experience: 5,
      education: "BSc computer engineering or equivalent experience",
    },
    {
      requisition_id: "REQ-302",
      title: "HR Business Partner",
      department: "Human Resources",
      location: "Gebze Plant (Kocaeli), on site",
      work_model: "on_site",
      employment_type: "full_time",
      status: "open",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0003",
      hiring_manager: "Zeynep Demir",
      hiring_manager_email: `zeynep.demir@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-122",
      salary_band: "P4",
      posted_at: at(-14),
      target_start_date: day(45),
      description:
        "Partner of the plant management team for 320 blue- and white-collar employees in Gebze: workforce planning, employee relations, performance and talent reviews, and the relationship with the trade union.",
      requirements: [
        "5+ years as HR generalist or HR business partner, ideally in manufacturing with a blue-collar workforce (300+ employees)",
        "Sound knowledge of Turkish Labour Law 4857, SGK procedures and collective bargaining",
        "Experience with employee relations cases, disciplinary processes and performance reviews",
        "Data-driven: HR KPIs, Excel, Power BI",
        "Fluent Turkish, good English",
        "Degree in business, psychology, labour economics or a related field",
      ].join("\n"),
      must_have_skills: ["Turkish Labour Law", "Employee relations", "HR business partnering", "Manufacturing environment"],
      nice_to_have_skills: ["Collective bargaining", "SAP SuccessFactors", "Power BI", "Change management"],
      languages: ["Turkish (native)", "English (B2)"],
      min_years_experience: 5,
      education: "Bachelor's degree in business, psychology or labour economics",
    },
    {
      requisition_id: "REQ-303",
      title: "Sales Development Representative",
      department: "Sales",
      location: "Hamburg Sales Office or remote within Germany",
      work_model: "hybrid",
      employment_type: "full_time",
      status: "open",
      openings: 2,
      hires: 0,
      hiring_manager_id: "EMP-0005",
      hiring_manager: "Thomas Weber",
      hiring_manager_email: `thomas.weber@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-123",
      salary_band: "P2",
      posted_at: at(-9),
      target_start_date: day(40),
      description:
        "Generate qualified pipeline for pumps, valves and pump skids in the DACH market: research target accounts, run outbound sequences, qualify inbound and trade-fair leads and book meetings for the account managers.",
      requirements: [
        "1-3 years in B2B sales development, inside sales or lead qualification (industrial goods preferred)",
        "Prospecting with LinkedIn Sales Navigator, cold calling and e-mail sequencing",
        "CRM discipline (Salesforce or HubSpot)",
        "German C1 and English C1; Turkish is a plus",
        "Technical curiosity about pumps, valves and fluid systems",
      ].join("\n"),
      must_have_skills: ["B2B prospecting", "Cold calling", "CRM (Salesforce or HubSpot)", "German C1", "English C1"],
      nice_to_have_skills: ["Industrial products", "LinkedIn Sales Navigator", "Turkish", "Trade fair lead follow-up"],
      languages: ["German (C1)", "English (C1)", "Turkish (nice to have)"],
      min_years_experience: 1,
      education: "Bachelor's degree (business, engineering or similar) or equivalent experience",
    },
    {
      requisition_id: "REQ-304",
      title: "Financial Analyst",
      department: "Finance",
      location: "Istanbul HQ (Ataşehir), hybrid",
      work_model: "hybrid",
      employment_type: "full_time",
      status: "open",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0002",
      hiring_manager: "Elif Yılmaz",
      hiring_manager_email: `elif.yilmaz@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-124",
      salary_band: "P3",
      posted_at: at(-30),
      target_start_date: day(30),
      description:
        "Own the monthly management reporting, budget and forecast models and variance analyses for the CFO; support the month-end close and product profitability analyses.",
      requirements: [
        "2-4 years in FP&A, controlling or audit (Big Four experience is a plus)",
        "Advanced Excel (financial modelling, pivot tables, Power Query) and Power BI",
        "Understanding of TFRS/IFRS and the Turkish uniform chart of accounts",
        "Month-end close, variance analysis, budgeting and forecasting",
        "SAP FI/CO experience preferred",
        "Fluent English",
      ].join("\n"),
      must_have_skills: ["Financial modelling", "Advanced Excel", "Variance analysis", "IFRS", "Budgeting and forecasting"],
      nice_to_have_skills: ["SAP FI/CO", "Power BI", "Big Four audit", "CMA or CFA"],
      languages: ["Turkish (native)", "English (C1)"],
      min_years_experience: 2,
      education: "Bachelor's degree in economics, finance, business or industrial engineering",
    },
    {
      requisition_id: "REQ-305",
      title: "Production Planning Engineer",
      department: "Operations",
      location: "Gebze Plant (Kocaeli), on site",
      work_model: "on_site",
      employment_type: "full_time",
      status: "open",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0004",
      hiring_manager: "Burak Şahin",
      hiring_manager_email: `burak.sahin@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-125",
      salary_band: "P3",
      posted_at: at(-6),
      target_start_date: day(50),
      description: "Plan machining and assembly for pumps and valves (MRP run, capacity levelling, sequencing) and drive on-time delivery.",
      requirements: [
        "3+ years in production planning in discrete manufacturing",
        "MRP and capacity planning; SAP PP is a plus",
        "Lean manufacturing mindset, strong Excel",
        "Degree in industrial or mechanical engineering",
      ].join("\n"),
      must_have_skills: ["Production planning (MRP)", "Capacity planning", "Lean manufacturing", "Excel"],
      nice_to_have_skills: ["SAP PP", "APS tools", "Six Sigma"],
      languages: ["Turkish (native)", "English (B1)"],
      min_years_experience: 3,
      education: "BSc industrial or mechanical engineering",
    },
    {
      requisition_id: "REQ-306",
      title: "Quality Control Technician",
      department: "Quality",
      location: "Gebze Plant (Kocaeli), shift work",
      work_model: "on_site",
      employment_type: "full_time",
      status: "on_hold",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0004",
      hiring_manager: "Burak Şahin",
      hiring_manager_email: `burak.sahin@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: "POS-126",
      salary_band: "T2",
      posted_at: null,
      target_start_date: day(90),
      description: "Incoming and final inspection of castings and machined parts (on hold: budget freeze until Q1).",
      requirements: "Vocational school degree in machining or quality; reading technical drawings; CMM measurement is a plus.",
      must_have_skills: ["Technical drawing reading", "Measuring instruments"],
      nice_to_have_skills: ["CMM", "ISO 9001"],
      languages: ["Turkish (native)"],
      min_years_experience: 2,
      education: "Vocational high school or associate degree",
    },
    {
      requisition_id: "REQ-307",
      title: "Maintenance Technician (Electrical)",
      department: "Operations",
      location: "Gebze Plant (Kocaeli), shift work",
      work_model: "on_site",
      employment_type: "full_time",
      status: "filled",
      openings: 1,
      hires: 1,
      hiring_manager_id: "EMP-0004",
      hiring_manager: "Burak Şahin",
      hiring_manager_email: `burak.sahin@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: null,
      salary_band: "T3",
      posted_at: at(-75),
      target_start_date: day(-10),
      description: "Electrical maintenance of CNC machines, test benches and plant infrastructure.",
      requirements: "Electrical technician diploma; PLC troubleshooting; high-voltage certificate.",
      must_have_skills: ["Electrical maintenance", "PLC troubleshooting"],
      nice_to_have_skills: ["CNC maintenance", "Pneumatics"],
      languages: ["Turkish (native)"],
      min_years_experience: 3,
      education: "Vocational high school (electrical)",
    },
    {
      requisition_id: "REQ-308",
      title: "Customer Service Specialist (Export, German/Turkish)",
      department: "Customer Service",
      location: "Istanbul HQ (Ataşehir), hybrid",
      work_model: "hybrid",
      employment_type: "full_time",
      status: "draft",
      openings: 1,
      hires: 0,
      hiring_manager_id: "EMP-0005",
      hiring_manager: "Thomas Weber",
      hiring_manager_email: `thomas.weber@${DOMAIN}`,
      recruiter: "Gizem Polat",
      recruiter_email: `gizem.polat@${DOMAIN}`,
      position_id: null,
      salary_band: "P2",
      posted_at: null,
      target_start_date: day(75),
      description: "First point of contact for distributors in the DACH region: order status, delivery dates, documentation (certificates, customs) and complaints, in close cooperation with logistics and quality.",
      requirements: [
        "2+ years in customer service or inside sales for industrial products",
        "German C1 and Turkish native; good English",
        "Experience with ERP order management (SAP SD is a plus) and CRM",
        "Structured, calm under pressure, solution oriented",
      ].join("\n"),
      must_have_skills: ["Customer service", "German C1", "Turkish", "ERP order management"],
      nice_to_have_skills: ["SAP SD", "Export documentation", "Salesforce"],
      languages: ["Turkish (native)", "German (C1)", "English (B2)"],
      min_years_experience: 2,
      education: "Bachelor's degree or vocational training in business",
    },
  ];

  const titleOf = (id: string | null) => requisitions.find((r) => r.requisition_id === id)?.title ?? null;

  const cand = (
    id: string,
    name: string,
    mail: string,
    phone: string | null,
    requisitionId: string | null,
    stage: Stage,
    score: number | null,
    source: string,
    location: string,
    currentTitle: string | null,
    currentCompany: string | null,
    years: number | null,
    skills: string[],
    languages: string[],
    summary: string | null,
    appliedOffset: number,
    history: Array<[number, Stage, string | null]>,
  ): Candidate => ({
    candidate_id: id,
    full_name: name,
    email: mail,
    phone,
    requisition_id: requisitionId,
    requisition_title: titleOf(requisitionId),
    stage,
    score,
    summary,
    source,
    location,
    current_title: currentTitle,
    current_company: currentCompany,
    years_experience: years,
    skills,
    languages,
    cv_file_id: null,
    applied_at: at(appliedOffset, 10),
    updated_at: at(history.length ? history[history.length - 1]![0] : appliedOffset, 15),
    history: [{ at: at(appliedOffset, 10), stage: "applied", note: `Applied via ${source}` }, ...history.map(([offset, st, note]) => ({ at: at(offset, 15), stage: st, note }))],
  });

  const candidates: Candidate[] = [
    cand("CAND-1001", "Mert Yalçın", "mert.yalcin@mail.example", "+90 532 555 20 01", "REQ-301", "interview", 86, "LinkedIn", "İstanbul", "Senior Backend Engineer", "Fintech scale-up (İstanbul)", 7,
      ["Node.js", "TypeScript", "PostgreSQL", "Kafka", "Docker", "Kubernetes", "AWS"], ["Turkish (native)", "English (C1)"],
      "7 years backend; led the migration of payment APIs to an event-driven architecture on Kafka; strong TypeScript and PostgreSQL; no ERP integration experience yet.", -18,
      [[-16, "screening", "Phone screen: strong communication, salary expectation within band"], [-10, "interview", "Invited to technical interview"]]),
    cand("CAND-1002", "Ayla Korkmaz", "ayla.korkmaz@mail.example", "+90 533 555 20 02", "REQ-301", "screening", 74, "Kariyer.net", "Kocaeli", "Backend Developer", "E-commerce marketplace", 5,
      ["Node.js", "JavaScript", "MongoDB", "REST API design", "Docker"], ["Turkish (native)", "English (B2)"],
      "5 years Node.js on e-commerce order services; REST and MongoDB, little PostgreSQL; no messaging experience.", -12,
      [[-9, "screening", null]]),
    cand("CAND-1003", "Daniel Novák", "daniel.novak@post.example", "+420 602 555 003", "REQ-301", "assessment", 81, "Careers page", "Brno (CZ), willing to relocate", "Integration Developer", "Automotive supplier (Czech Republic)", 6,
      ["Node.js", "TypeScript", "NestJS", "PostgreSQL", "RabbitMQ", "SAP integration"], ["Czech (native)", "English (C1)", "German (B1)"],
      "6 years building SAP integrations (OData, IDoc) with Node.js/NestJS for an automotive supplier; RabbitMQ; relocation to İstanbul needed.", -15,
      [[-13, "screening", null], [-6, "interview", null], [-3, "assessment", "Take-home assignment sent"]]),
    cand("CAND-1004", "Burcu Aydemir", "burcu.aydemir@mail.example", null, "REQ-301", "rejected", 48, "Kariyer.net", "İstanbul", "Web Developer", "Digital agency", 2,
      ["PHP", "Laravel", "MySQL", "JavaScript"], ["Turkish (native)", "English (B1)"],
      "2 years PHP/Laravel; little Node.js and no production PostgreSQL; below the 5-year requirement.", -17,
      [[-14, "rejected", "Does not meet must-have requirements"]]),
    cand("CAND-1005", "Kemal Sarı", "kemal.sari@mail.example", "+90 535 555 20 05", "REQ-301", "applied", null, "Careers page", "İstanbul", null, null, null, [], [], null, -1, []),
    cand("CAND-1006", "Pınar Güler", "pinar.guler@mail.example", "+90 532 555 20 06", "REQ-302", "interview", 83, "Referral: Zeynep Demir", "Bursa", "HR Business Partner", "Automotive supplier (Bursa)", 6,
      ["HR business partnering", "Employee relations", "Collective bargaining", "Turkish Labour Law", "SAP SuccessFactors"], ["Turkish (native)", "English (B2)"],
      "6 years HRBP at an automotive supplier with 1,200 blue-collar employees; led two collective bargaining rounds.", -11,
      [[-9, "screening", null], [-4, "interview", "First interview with HR Director scheduled"]]),
    cand("CAND-1007", "Onur Tan", "onur.tan@mail.example", "+90 536 555 20 07", "REQ-302", "screening", 69, "LinkedIn", "İstanbul", "HR Generalist", "Retail chain", 4,
      ["Employee relations", "Payroll", "Recruitment"], ["Turkish (native)", "English (B1)"],
      "4 years HR generalist in retail; limited union and manufacturing experience.", -8,
      [[-6, "screening", null]]),
    cand("CAND-1008", "Lena Hoffmann", "lena.hoffmann@post.example", "+49 160 5552 008", "REQ-303", "offer", 88, "LinkedIn", "Hamburg", "Sales Development Representative", "Industrial automation vendor", 3,
      ["B2B prospecting", "Cold calling", "Salesforce", "LinkedIn Sales Navigator"], ["German (native)", "English (C1)"],
      "3 years SDR at an industrial automation vendor; consistently above pipeline target; German native, English C1.", -8,
      [[-7, "screening", null], [-5, "interview", null], [-2, "offer", "Offer sent, answer expected this week"]]),
    cand("CAND-1009", "Jan Kowalczyk", "jan.kowalczyk@post.example", "+49 151 5552 009", "REQ-303", "interview", 76, "Careers page", "Berlin", "Business Development Representative", "B2B SaaS start-up", 2,
      ["B2B prospecting", "HubSpot", "Cold calling"], ["Polish (native)", "German (C1)", "English (C1)"],
      "2 years BDR in B2B SaaS; strong outbound results, no industrial background.", -7,
      [[-5, "screening", null], [-3, "interview", null]]),
    cand("CAND-1010", "Sophie Martin", "sophie.martin@post.example", null, "REQ-303", "applied", null, "Careers page", "Lyon (FR)", "Inside Sales Representative", "Laboratory equipment distributor", 1,
      [], ["French (native)", "German (B2)", "English (C1)"], null, -2, []),
    cand("CAND-1011", "Cem Erdem", "cem.erdem@mail.example", "+90 532 555 20 11", "REQ-304", "interview", 79, "LinkedIn", "İstanbul", "Senior Auditor", "Big Four audit firm", 3,
      ["Advanced Excel", "IFRS", "Variance analysis", "Financial modelling"], ["Turkish (native)", "English (C1)"],
      "3 years Big Four audit with manufacturing clients; advanced Excel and IFRS; CMA candidate; no FP&A role yet.", -25,
      [[-22, "screening", null], [-12, "interview", null]]),
    cand("CAND-1012", "İpek Tunç", "ipek.tunc@mail.example", "+90 533 555 20 12", "REQ-304", "screening", 71, "Kariyer.net", "İstanbul", "FP&A Analyst", "Consumer goods company", 2,
      ["Budgeting and forecasting", "Power BI", "SAP FI/CO", "Advanced Excel"], ["Turkish (native)", "English (B2)"],
      "2 years FP&A: budget model and monthly reporting in Power BI; basic SAP CO.", -19,
      [[-15, "screening", null]]),
    cand("CAND-1013", "Barış Ateş", "baris.ates@mail.example", null, "REQ-304", "withdrawn", 65, "LinkedIn", "Ankara", "Cost Accountant", "Defence manufacturer", 4,
      ["Cost accounting", "SAP FI/CO"], ["Turkish (native)", "English (B1)"],
      "Withdrew after accepting a counter-offer.", -28,
      [[-24, "screening", null], [-20, "withdrawn", "Accepted counter-offer"]]),
    cand("CAND-1014", "Gökhan Yurt", "gokhan.yurt@mail.example", "+90 535 555 20 14", "REQ-305", "applied", null, "Careers page", "Kocaeli", "Planning Engineer", "White goods manufacturer", 4, [], [], null, -2, []),
    cand("CAND-1015", "İsmail Şen", "ismail.sen@mail.example", "+90 536 555 20 15", "REQ-307", "hired", 80, "Referral: Hakan Erdoğan", "Kocaeli", "Electrical Technician", "Plastics manufacturer", 6,
      ["Electrical maintenance", "PLC troubleshooting", "CNC maintenance"], ["Turkish (native)"],
      "6 years electrical maintenance; hired, started 10 days ago.", -70,
      [[-65, "screening", null], [-55, "interview", null], [-40, "offer", null], [-35, "hired", "Offer accepted"]]),
    cand("CAND-1016", "Selin Acar", "selin.acar@mail.example", null, null, "applied", null, "Careers page (open application)", "İzmir", "Supply Chain Specialist", "Logistics provider", 3,
      ["Supply chain planning", "SAP MM", "Excel"], ["Turkish (native)", "English (B2)"], "Open application for supply chain roles.", -4, []),
  ];

  const interview = (
    id: string,
    candidateId: string,
    interviewer: string,
    offset: number,
    hourUtc: number,
    duration: number,
    format: Interview["format"],
    status: Interview["status"],
    feedback: string | null = null,
  ): Interview => {
    const candidate = candidates.find((c) => c.candidate_id === candidateId);
    const start = at(offset, hourUtc);
    return {
      interview_id: id,
      candidate_id: candidateId,
      candidate_name: candidate?.full_name ?? candidateId,
      requisition_id: candidate?.requisition_id ?? null,
      interviewer_email: `${interviewer}@${DOMAIN}`,
      start,
      end: new Date(Date.parse(start) + duration * 60_000).toISOString(),
      duration_minutes: duration,
      format,
      status,
      meeting_link: format === "video" ? `https://meet.${DOMAIN}/${id.toLowerCase()}` : null,
      feedback,
      created_at: at(Math.min(offset - 3, -1), 12),
    };
  };

  const interviews: Interview[] = [
    interview("INT-5001", "CAND-1001", "can.ozturk", 2, 7, 60, "video", "scheduled"),
    interview("INT-5002", "CAND-1003", "ozan.kurt", 3, 11, 90, "video", "scheduled"),
    interview("INT-5003", "CAND-1006", "zeynep.demir", 1, 8, 60, "onsite", "scheduled"),
    interview("INT-5004", "CAND-1008", "thomas.weber", -3, 9, 45, "video", "completed", "Strong hire: excellent discovery questions, realistic about industrial sales cycles."),
    interview("INT-5005", "CAND-1009", "laura.rossi", 4, 9, 45, "video", "scheduled"),
    interview("INT-5006", "CAND-1011", "elif.yilmaz", 2, 12, 60, "onsite", "scheduled"),
    interview("INT-5007", "CAND-1012", "gizem.polat", 1, 11, 30, "phone", "scheduled"),
    interview("INT-5008", "CAND-1011", "gizem.polat", -12, 10, 45, "video", "completed", "Good analytical skills and IFRS knowledge; recommend interview with CFO."),
  ];

  return { requisitions, candidates, interviews };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pipeline(requisitionId: string, candidates: Candidate[]): Record<Stage, number> {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const c of candidates) if (c.requisition_id === requisitionId) counts[c.stage]++;
  return counts;
}

function requisitionSummary(r: Requisition, candidates: Candidate[]): Rec {
  const counts = pipeline(r.requisition_id, candidates);
  return {
    requisition_id: r.requisition_id,
    title: r.title,
    department: r.department,
    location: r.location,
    work_model: r.work_model,
    status: r.status,
    openings: r.openings,
    hires: r.hires,
    hiring_manager: r.hiring_manager,
    recruiter: r.recruiter,
    posted_at: r.posted_at,
    must_have_skills: r.must_have_skills,
    nice_to_have_skills: r.nice_to_have_skills,
    candidates_total: Object.values(counts).reduce((a, b) => a + b, 0),
    active_candidates: counts.applied + counts.screening + counts.interview + counts.assessment + counts.offer,
  };
}

function validScore(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value < 0 || value > 100) throw new ConnectorError("score must be between 0 and 100", "validation");
  return Math.round(value);
}

async function findCandidate(db: SandboxDb, id: string): Promise<Candidate> {
  return db.require<Candidate>("candidates", id.toUpperCase(), "Candidate");
}

// ---------------------------------------------------------------------------
// Manifest & operations
// ---------------------------------------------------------------------------

const manifest = defineManifest({
  type: "sandbox-ats",
  name: "Sandbox ATS",
  vendor: "Enterprise Brain",
  category: "ats",
  description:
    "Built-in demo applicant tracking system of Acme Endüstri A.Ş.: job requisitions with detailed requirements and must-have / nice-to-have skills (Senior Backend Engineer, HR Business Partner, Sales Development Representative, Financial Analyst...), candidates with pipeline stages and interviews. Works without credentials; changes persist per company.",
  auth: "none",
  maturity: "sandbox",
  operations: [
    readOp("list_job_requisitions", "List job requisitions", "Job requisitions with key skills and pipeline counts.", {
      status: oneOf(REQUISITION_STATUSES, "Requisition status"),
    }),
    readOp("get_job_requisition", "Get job requisition", "Full job requisition: description, requirements, must-have and nice-to-have skills, languages, experience, hiring team and pipeline by stage.", {
      requisition_id: str("Requisition id, e.g. REQ-301"),
    }, ["requisition_id"]),
    readOp("search_candidates", "Search candidates", "Candidates, best score first, by requisition and/or stage.", {
      requisition_id: str("Requisition id, e.g. REQ-301"),
      stage: oneOf(STAGES, "Pipeline stage"),
    }),
    readOp("get_candidate", "Get candidate", "Candidate profile with stage history and interviews.", {
      candidate_id: str("Candidate id, e.g. CAND-1001"),
    }, ["candidate_id"]),
    writeOp("create_candidate", "Create candidate", "Add a candidate (e.g. from a CV received by mail or a careers-page form), optionally with a screening score and summary. A candidate who already applied to the same requisition is returned instead of duplicated.", {
      full_name: str("Candidate's full name"),
      email: email("Candidate's e-mail address"),
      requisition_id: str("Requisition applied for, e.g. REQ-301"),
      phone: str("Phone number"),
      score: int("Screening score 0-100"),
      summary: str("Screening summary / assessment"),
      cv_file_id: str("File id of the stored CV"),
      stage: str(`Initial stage (default applied): ${STAGES.join(", ")}`),
    }, ["full_name", "email"]),
    writeOp("update_candidate_stage", "Update candidate stage", "Move a candidate to another pipeline stage (e.g. screening, interview, offer, hired, rejected) with an optional note.", {
      candidate_id: str("Candidate id, e.g. CAND-1001"),
      stage: str(`New stage: ${STAGES.join(", ")}`),
      note: str("Reason / note for the history"),
    }, ["candidate_id", "stage"]),
    writeOp("schedule_interview", "Schedule interview", "Schedule an interview for a candidate. Conflicts in the interviewer's schedule are rejected; the candidate moves to the interview stage.", {
      candidate_id: str("Candidate id, e.g. CAND-1002"),
      interviewer_email: email("Interviewer's e-mail address"),
      start: dateTime("Start time, ISO 8601 with time zone, e.g. 2026-10-05T10:00:00+03:00"),
      duration_minutes: int("Duration in minutes (default 45)"),
    }, ["candidate_id", "interviewer_email", "start"]),
  ],
});

export const sandboxAtsConnector = defineSandboxConnector({
  manifest,
  keys: { requisitions: "requisition_id", candidates: "candidate_id", interviews: "interview_id" },
  seed,
  operations: {
    async list_job_requisitions(input, db) {
      const status = optEnum(input, "status", REQUISITION_STATUSES);
      const candidates = await db.list<Candidate>("candidates");
      const items = (await db.list<Requisition>("requisitions"))
        .filter((r) => !status || r.status === status)
        .map((r) => requisitionSummary(r, candidates));
      return listResult(items);
    },

    async get_job_requisition(input, db) {
      const requisition = await db.require<Requisition>("requisitions", reqString(input, "requisition_id").toUpperCase(), "Job requisition");
      const candidates = await db.list<Candidate>("candidates");
      return { ...requisition, pipeline: pipeline(requisition.requisition_id, candidates) };
    },

    async search_candidates(input, db) {
      const requisitionId = optString(input, "requisition_id")?.toUpperCase();
      const stage = optEnum(input, "stage", STAGES);
      if (requisitionId) await db.require<Requisition>("requisitions", requisitionId, "Job requisition");
      const items = (await db.list<Candidate>("candidates"))
        .filter((c) => (!requisitionId || c.requisition_id === requisitionId) && (!stage || c.stage === stage))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.candidate_id.localeCompare(b.candidate_id))
        .map(({ history: _history, ...c }) => c);
      return listResult(items);
    },

    async get_candidate(input, db) {
      const candidate = await findCandidate(db, reqString(input, "candidate_id"));
      const interviews = (await db.list<Interview>("interviews"))
        .filter((i) => i.candidate_id === candidate.candidate_id)
        .sort((a, b) => a.start.localeCompare(b.start));
      return { ...candidate, interviews };
    },

    async create_candidate(input, db) {
      const fullName = reqString(input, "full_name");
      const mail = normalizeEmail(reqString(input, "email"));
      const requisitionId = optString(input, "requisition_id")?.toUpperCase();
      const stage = optEnum(input, "stage", STAGES, STAGE_SYNONYMS) ?? "applied";
      const score = validScore(optNumber(input, "score"));
      const warnings: string[] = [];
      let requisition: Requisition | undefined;
      if (requisitionId) {
        requisition = await db.require<Requisition>("requisitions", requisitionId, "Job requisition");
        if (requisition.status === "filled" || requisition.status === "closed") {
          throw new ConnectorError(`Job requisition ${requisition.requisition_id} (${requisition.title}) is ${requisition.status} and no longer accepts candidates`, "validation");
        }
        if (requisition.status !== "open") warnings.push(`Requisition ${requisition.requisition_id} is ${requisition.status}`);
      }
      const existing = (await db.list<Candidate>("candidates")).find(
        (c) => c.email === mail && c.requisition_id === (requisition?.requisition_id ?? null),
      );
      if (existing) {
        return {
          ...existing,
          ok: true,
          duplicate: true,
          message: `${existing.full_name} already applied${requisition ? ` to ${requisition.requisition_id}` : ""} as ${existing.candidate_id}; no new record created.`,
        };
      }
      const now = nowIso();
      const candidate: Candidate = {
        candidate_id: await db.nextId("candidates", "CAND-", 4),
        full_name: fullName,
        email: mail,
        phone: optString(input, "phone") ?? null,
        requisition_id: requisition?.requisition_id ?? null,
        requisition_title: requisition?.title ?? null,
        stage,
        score: score ?? null,
        summary: optString(input, "summary") ?? null,
        source: "Enterprise Brain",
        location: null,
        current_title: null,
        current_company: null,
        years_experience: null,
        skills: [],
        languages: [],
        cv_file_id: optString(input, "cv_file_id") ?? null,
        applied_at: now,
        updated_at: now,
        history: [{ at: now, stage, note: "Created by Enterprise Brain" }],
      };
      await db.put("candidates", candidate);
      return { ...candidate, ok: true, duplicate: false, warnings };
    },

    async update_candidate_stage(input, db) {
      const candidate = await findCandidate(db, reqString(input, "candidate_id"));
      const stage = reqEnum(input, "stage", STAGES, STAGE_SYNONYMS);
      const note = optString(input, "note") ?? null;
      if (candidate.stage === "hired" && stage !== "hired") {
        throw new ConnectorError(`${candidate.full_name} (${candidate.candidate_id}) is already hired; the stage can no longer change`, "validation");
      }
      const now = nowIso();
      const previous = candidate.stage;
      candidate.stage = stage;
      candidate.updated_at = now;
      candidate.history.push({ at: now, stage, note });
      await db.put("candidates", candidate);

      let requisitionStatus: RequisitionStatus | null = null;
      if (stage === "hired" && previous !== "hired" && candidate.requisition_id) {
        const requisition = await db.get<Requisition>("requisitions", candidate.requisition_id);
        if (requisition) {
          requisition.hires += 1;
          if (requisition.hires >= requisition.openings) requisition.status = "filled";
          await db.put("requisitions", requisition);
          requisitionStatus = requisition.status;
        }
      }
      return { ...candidate, ok: true, previous_stage: previous, requisition_status: requisitionStatus };
    },

    async schedule_interview(input, db) {
      const candidate = await findCandidate(db, reqString(input, "candidate_id"));
      const interviewer = normalizeEmail(reqString(input, "interviewer_email"), "interviewer_email");
      const start = parseIsoDateTime(reqString(input, "start"), "start");
      const duration = optNumber(input, "duration_minutes") ?? 45;
      if (!Number.isInteger(duration) || duration < 15 || duration > 240) {
        throw new ConnectorError("duration_minutes must be a whole number between 15 and 240", "validation");
      }
      if (Date.parse(start) < Date.now()) throw new ConnectorError(`start ${start} is in the past`, "validation");
      if (["rejected", "withdrawn", "hired"].includes(candidate.stage)) {
        throw new ConnectorError(`${candidate.full_name} is ${candidate.stage}; no interview can be scheduled`, "validation");
      }
      const end = new Date(Date.parse(start) + duration * 60_000).toISOString();
      const interviews = await db.list<Interview>("interviews");
      const conflict = interviews.find(
        (i) => i.status === "scheduled" && i.interviewer_email === interviewer && i.start < end && i.end > start,
      );
      if (conflict) {
        throw new ConnectorError(
          `${interviewer} already has interview ${conflict.interview_id} with ${conflict.candidate_name} from ${conflict.start} to ${conflict.end}`,
          "validation",
        );
      }
      const id = await db.nextId("interviews", "INT-", 4);
      const interview: Interview = {
        interview_id: id,
        candidate_id: candidate.candidate_id,
        candidate_name: candidate.full_name,
        requisition_id: candidate.requisition_id,
        interviewer_email: interviewer,
        start,
        end,
        duration_minutes: duration,
        format: "video",
        status: "scheduled",
        meeting_link: `https://meet.${DOMAIN}/${id.toLowerCase()}`,
        feedback: null,
        created_at: nowIso(),
      };
      await db.put("interviews", interview);
      if (candidate.stage === "applied" || candidate.stage === "screening") {
        const now = nowIso();
        candidate.stage = "interview";
        candidate.updated_at = now;
        candidate.history.push({ at: now, stage: "interview", note: `Interview ${id} scheduled` });
        await db.put("candidates", candidate);
      }
      return { ...interview, ok: true, candidate_stage: candidate.stage };
    },
  },
});
