import type { BrainStep } from "@enterprise-brain/core";
import type { SourceEntity, SourceLink, SourceRef } from "../types.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * A made-up intranet (standing in for SharePoint pages) of the demo company: the process handbook
 * (how work is done, step by step, with its rules, inputs, outputs, people, systems and documents),
 * policies, documents, the company profile, goals, decisions and the know-how people wrote down.
 */

type Who = [kind: "person" | "ai_employee" | "role", nameOrLocal: string, part: string];

interface Process {
  key: string;
  name: string;
  summary: string;
  department: string;
  owner: string;
  status: "Documented" | "Draft" | "Needs review";
  frequency: string;
  trigger: string;
  steps: [name: string, who: string, system: string, does: string][];
  rules: string[];
  inputs: string[];
  outputs: string[];
  kpis?: string[];
  problems?: string[];
  does: Who[];
  uses: string[];
  documents?: string[];
  follows?: string[];
  handsOver?: [process: string, what: string][];
  partOf?: string;
}

const PROCESSES: Process[] = [
  {
    key: "finance.accounts-payable",
    name: "Supplier invoice processing",
    summary: "Supplier invoices are checked against the purchase order and the goods receipt, approved, posted in SAP and paid in the weekly payment run.",
    department: "finance",
    owner: "burak.sahin",
    status: "Documented",
    frequency: "About 600 invoices a month",
    trigger: "A supplier invoice arrives at invoices@ (PDF) or as an e-invoice in Uyumsoft",
    steps: [
      ["Receive", "Invoice Processor (AI)", "Exchange Online", "PDF invoices come to invoices@; e-invoices come through Uyumsoft."],
      [
        "Read and check",
        "Invoice Processor (AI)",
        "SAP S/4HANA",
        "Reads the invoice, finds the supplier and the purchase order, checks prices and quantities against the goods receipt, looks for duplicates and changed bank details.",
      ],
      ["Review", "Elif Arslan", "SAP S/4HANA", "Checks what the AI employee found and fixes small differences."],
      ["Approve exceptions", "Burak Şahin", "Enterprise Brain", "Invoices above 250,000 TRY, or outside the tolerance."],
      ["Post", "Elif Arslan", "SAP S/4HANA", "Posts the invoice; differences stay blocked for payment."],
      ["Pay", "Burak Şahin", "SAP S/4HANA", "Weekly payment run on Thursdays."],
    ],
    rules: [
      "No PO, no pay: an invoice without a purchase order needs the cost center owner's approval",
      "3-way match tolerance: ±2% or 500 TRY per invoice, whichever is lower",
      "Invoices above 250,000 TRY need the Finance Manager's approval; above 1,000,000 TRY also the CFO's",
      "Changed bank details: call the supplier on the phone number in SAP before paying",
      "E-invoices must be accepted or rejected in Uyumsoft within 8 days",
    ],
    inputs: ["Supplier invoice (PDF or e-invoice)", "Purchase order in SAP", "Goods receipt in SAP"],
    outputs: ["Posted invoice in SAP", "Payment proposal", "Rejection email to the supplier"],
    kpis: ["Receipt to posting in under 3 days", "70% posted without keying by hand"],
    problems: ["Goods receipts are often posted late at the Gebze warehouse, so invoices wait", "Some suppliers still send paper invoices to Gebze"],
    does: [
      ["person", "elif.arslan", "Checks and posts"],
      ["person", "burak.sahin", "Approves exceptions and pays"],
      ["ai_employee", "Invoice Processor", "Reads and checks each invoice"],
    ],
    uses: ["exchange-online", "uyumsoft-e-fatura", "sap-s4hana"],
    documents: ["ap-procedure"],
    follows: ["approval-matrix"],
  },
  {
    key: "finance.month-end-close",
    name: "Month-end close",
    summary:
      "The books of the month are closed in five working days: cut-off, reconciliations, accruals, consolidation, the management report and the statutory books.",
    department: "finance",
    owner: "selin.arslan",
    status: "Documented",
    frequency: "Monthly, in the first 5 working days",
    trigger: "The last working day of the month",
    steps: [
      ["Cut-off", "Burak Şahin", "SAP S/4HANA", "Stop posting to the old month; accrue goods received but not invoiced."],
      ["Reconcile", "Selin Arslan", "SAP S/4HANA", "Bank, receivables, payables and intercompany reconciliations."],
      ["Depreciation and accruals", "Selin Arslan", "SAP S/4HANA", "Run depreciation; book accruals."],
      ["Consolidation", "Hande Özkan", "Power BI", "Combine Acme Endüstri and Acme Pumpen GmbH (Hamburg)."],
      ["Management report", "Hande Özkan", "Power BI", "Monthly report to the CEO by working day 5."],
      ["Statutory books", "Selin Arslan", "SAP S/4HANA", "VUK books and the VAT return by the 26th."],
    ],
    rules: ["Close in 5 working days", "No postings to a closed month without the Chief Accountant's approval", "VAT return by the 26th of the next month"],
    inputs: ["The month's postings", "Bank statements", "Hamburg's DATEV export"],
    outputs: ["Monthly management report", "VAT return", "Closed period in SAP"],
    kpis: ["Closed in 5 working days"],
    problems: ["Consolidation is done in an Excel workbook only Hande Özkan knows, and she is on leave"],
    does: [
      ["person", "selin.arslan", "Runs the checklist"],
      ["person", "hande.ozkan", "Consolidation and the report"],
      ["person", "burak.sahin", "Payables and receivables cut-off"],
    ],
    uses: ["sap-s4hana", "power-bi"],
    documents: ["close-checklist"],
  },
  {
    key: "consolidation-reporting",
    name: "Monthly consolidation and management report",
    summary: "Hamburg's books are mapped to the group's accounts, intercompany is eliminated, and the management report is published.",
    department: "finance",
    owner: "elif.yilmaz",
    status: "Needs review",
    frequency: "Monthly",
    trigger: "Reconciliations of the month are done (working day 3)",
    steps: [
      ["Export trial balances", "Hande Özkan", "SAP S/4HANA", "Trial balances of both companies."],
      [
        "Map Hamburg's accounts",
        "Hande Özkan",
        "Excel",
        "Acme Pumpen GmbH keeps its books in DATEV; map them to the group's accounts with the mapping workbook.",
      ],
      ["Eliminate intercompany", "Hande Özkan", "Excel", "Sales between the two companies cancel out."],
      ["Publish the report", "Hande Özkan", "Power BI", "Update the management dashboard and send the PDF to the CEO."],
    ],
    rules: ["Group accounts follow IFRS", "The report reaches the CEO by working day 5"],
    inputs: ["Trial balances", "Hamburg's DATEV export"],
    outputs: ["Consolidated figures", "Management report"],
    problems: ["Only Hande Özkan knows the mapping workbook", "The workbook has macros no one else has opened"],
    does: [["person", "hande.ozkan", "Does it every month"]],
    uses: ["sap-s4hana", "power-bi"],
    partOf: "finance.month-end-close",
  },
  {
    key: "finance.collections",
    name: "Collections",
    summary: "Customers who pay late are reminded, called and, when needed, put on credit hold.",
    department: "finance",
    owner: "burak.sahin",
    status: "Documented",
    frequency: "Weekly",
    trigger: "An invoice is overdue",
    steps: [
      ["List overdue invoices", "Collections Agent (AI)", "SAP S/4HANA", "Every Monday."],
      ["Send reminders", "Collections Agent (AI)", "Exchange Online", "First reminder at 7 days, second at 21 days."],
      ["Call the customer", "Ali Yıldız", "Salesforce", "The account manager calls when 30 days late."],
      ["Payment plan or credit hold", "Burak Şahin", "SAP S/4HANA", "Credit hold when more than 60 days late."],
    ],
    rules: [
      "Disputed invoices are not reminded: the customer issue is solved first",
      "Credit hold for customers more than 60 days late",
      "Payment plans need the Finance Manager's approval",
    ],
    inputs: ["Open invoices in SAP"],
    outputs: ["Reminders", "Payment plans", "Credit holds"],
    does: [
      ["person", "burak.sahin", "Decides plans and holds"],
      ["ai_employee", "Collections Agent", "Reminds customers"],
      ["person", "ali.yildiz", "Calls Turkish customers"],
      ["person", "laura.rossi", "Calls export customers"],
    ],
    uses: ["sap-s4hana", "exchange-online", "salesforce"],
    follows: ["approval-matrix"],
  },
  {
    key: "hr.recruitment",
    name: "Recruitment",
    summary: "From an approved position to a signed offer: posting, CV screening, interviews and the offer.",
    department: "hr",
    owner: "ayse.yilmaz",
    status: "Documented",
    frequency: "About 4 open positions at a time",
    trigger: "A manager's approved position in SuccessFactors",
    steps: [
      ["Open the position", "Hiring manager", "SAP SuccessFactors", "Approved headcount needed."],
      ["Post the job", "Can Demir", "SAP SuccessFactors", "On Kariyer.net and LinkedIn."],
      ["Screen CVs", "CV Screener (AI)", "Exchange Online", "CVs sent to careers@ are read and ranked against the requirements."],
      ["Interviews", "Can Demir", "Microsoft Teams", "With the hiring manager; a technical task for engineers."],
      ["Offer", "Ayşe Yılmaz", "SAP SuccessFactors", "From the offer template, within the salary band."],
      ["Hand over to onboarding", "Can Demir", "SAP SuccessFactors", "The new hire's details."],
    ],
    rules: [
      "Candidates agree to us keeping their CV (KVKK); CVs are deleted after 6 months",
      "Offers above the salary band need the HR Director's approval",
      "Every candidate hears back within 10 working days",
    ],
    inputs: ["Approved position", "CVs"],
    outputs: ["Signed offer", "New hire's details"],
    does: [
      ["person", "can.demir", "Postings, screening and interviews"],
      ["person", "ayse.yilmaz", "Offers"],
      ["ai_employee", "CV Screener", "Reads and ranks CVs"],
    ],
    uses: ["successfactors", "exchange-online"],
    follows: ["kvkk"],
    handsOver: [["hr.onboarding", "The new hire's details"]],
  },
  {
    key: "hr.onboarding",
    name: "Onboarding",
    summary: "Everything a new colleague needs, ready before their first day.",
    department: "hr",
    owner: "ayse.yilmaz",
    status: "Documented",
    frequency: "About 3 new people a month",
    trigger: "A signed offer",
    steps: [
      ["Prepare", "Ayşe Yılmaz", "SAP SuccessFactors", "Contract and SGK registration."],
      ["Accounts and laptop", "Emre Koç", "Jira Service Management", "A ticket opened 5 days before day one; accounts in Entra ID."],
      ["First day", "Manager", "", "Welcome, the team, safety training at the plant."],
      ["First weeks", "Onboarding Coordinator (AI)", "Microsoft Teams", "Checklists and reminders for the first 30 days."],
    ],
    rules: ["Accounts ready the day before the start", "Safety training before entering the plant"],
    inputs: ["New hire's details"],
    outputs: ["Accounts and laptop", "Completed onboarding checklist"],
    does: [
      ["person", "ayse.yilmaz", "Prepares"],
      ["person", "emre.koc", "Laptop and accounts"],
      ["ai_employee", "Onboarding Coordinator", "Checklists and reminders"],
    ],
    uses: ["successfactors", "entra-id", "jira-service-management"],
    documents: ["onboarding-checklist"],
  },
  {
    key: "hr.leave-management",
    name: "Leave requests",
    summary: "People ask for leave, their manager approves, and payroll keeps the balance.",
    department: "hr",
    owner: "ayse.yilmaz",
    status: "Documented",
    frequency: "Every day",
    trigger: "Someone asks for time off",
    steps: [
      ["Ask", "Employee", "SAP SuccessFactors", "Or ask the Leave Assistant in Teams."],
      ["Approve", "Manager", "SAP SuccessFactors", ""],
      ["Update the balance", "Gizem Polat", "Logo Bordro Plus", "Monthly, for payroll."],
    ],
    rules: ["14 days of annual leave a year for 1 to 5 years of service (Labour Law 4857)", "Plant staff plan leave around production peaks"],
    inputs: ["Leave request"],
    outputs: ["Approved leave", "Updated balance"],
    does: [
      ["person", "gizem.polat", "Keeps balances"],
      ["ai_employee", "Leave Assistant", "Answers leave questions"],
    ],
    uses: ["successfactors", "logo-bordro"],
  },
  {
    key: "customer-service.email-triage",
    name: "Customer emails",
    summary: "Emails to support@ are sorted, answered and, when needed, turned into a case.",
    department: "customer-service",
    owner: "zeynep.kaya",
    status: "Documented",
    frequency: "About 70 emails a day",
    trigger: "An email to support@",
    steps: [
      ["Receive", "Mail Triage (AI)", "Exchange Online", "support@ is followed."],
      ["Sort", "Mail Triage (AI)", "Salesforce", "Order status, spare parts, complaint, invoice question."],
      ["Log a case", "Deniz Aydın", "Salesforce", "For complaints and anything that takes more than a day."],
      ["Answer", "Deniz Aydın", "Exchange Online", "Order status from SAP or the portal; spare parts quotes."],
    ],
    rules: ["First answer within 4 working hours", "Quality complaints go to Quality as an 8D", "Order status from SAP or the portal, never from memory"],
    inputs: ["Customer email"],
    outputs: ["Answer", "Case in Salesforce"],
    does: [
      ["person", "deniz.aydin", "Answers"],
      ["person", "ece.dogan", "Deliveries and spare parts"],
      ["ai_employee", "Mail Triage", "Sorts and drafts answers"],
    ],
    uses: ["exchange-online", "salesforce", "sap-s4hana", "customer-portal"],
    handsOver: [["operations.quality-incidents", "Quality complaints"]],
  },
  {
    key: "customer-service.returns-complaints",
    name: "Returns and complaints (RMA)",
    summary: "A customer return gets an RMA number, the part is inspected, and the customer gets a credit or a replacement.",
    department: "customer-service",
    owner: "zeynep.kaya",
    status: "Documented",
    frequency: "About 15 a month",
    trigger: "A customer wants to return something",
    steps: [
      ["Register the return", "Ece Doğan", "Salesforce", "RMA number for the customer."],
      ["Check warranty", "Ece Doğan", "SAP S/4HANA", "24 months from delivery."],
      ["Inspect the part", "Merve Aksoy", "SAP S/4HANA", "In quality inspection."],
      ["Credit or replace", "Burak Şahin", "SAP S/4HANA", "Credits above 10,000 TRY need the Finance Manager."],
    ],
    rules: ["Warranty is 24 months from delivery", "Credits above 10,000 TRY need the Finance Manager's approval"],
    inputs: ["Return request", "Delivered part"],
    outputs: ["Credit note or replacement"],
    does: [
      ["person", "ece.dogan", "Registers and checks"],
      ["person", "merve.aksoy", "Inspects"],
      ["ai_employee", "Returns Agent", "Prepares the RMA"],
    ],
    uses: ["salesforce", "sap-s4hana"],
    follows: ["approval-matrix"],
  },
  {
    key: "operations.quality-incidents",
    name: "Customer complaints and 8D",
    summary: "Every quality complaint gets an 8D: contain it in 24 hours, find the root cause, fix it, keep it from happening again, and tell the customer.",
    department: "operations",
    owner: "selin.acar",
    status: "Documented",
    frequency: "About 6 a month",
    trigger: "A quality complaint from a customer (through Customer Service), or a failed final test",
    steps: [
      ["D1 Team", "Selin Acar", "", "Picks the team for the complaint."],
      ["D2 Describe the problem", "Kerem Yıldız", "Salesforce", "From the customer case: what, where, how many."],
      ["D3 Contain", "Merve Aksoy", "SAP S/4HANA", "Block suspect stock within 24 hours; check the pumps at the customer."],
      ["D4 Find the root cause", "Kerem Yıldız", "Opcenter MES", "Test results and work orders of the serial numbers."],
      ["D5–D6 Fix and check", "Deniz Çelik", "Opcenter MES", "Correct the cause, check the fix on new pumps."],
      ["D7 Prevent", "Selin Acar", "SharePoint", "Update the control plan and work instructions."],
      ["D8 Close and tell the customer", "Kerem Yıldız", "Exchange Online", "The 8D report goes to the customer."],
    ],
    rules: [
      "Containment within 24 hours",
      "The 8D report reaches the customer within 10 working days",
      "Repeat failures go to the Plant Manager",
      "Vibration above 4.5 mm/s (ISO 10816) is a failed pump",
    ],
    inputs: ["Customer case in Salesforce", "Serial numbers", "Test results from MES"],
    outputs: ["8D report", "Updated control plan", "Credit or replacement decision"],
    kpis: ["Containment in 24 hours", "8D closed in 10 working days", "30% fewer complaints than 2025"],
    problems: ["Test reports before 2024 are only on the engineering file share, not in MES"],
    does: [
      ["person", "kerem.yildiz", "Writes the 8D"],
      ["person", "merve.aksoy", "Containment and inspection"],
      ["person", "selin.acar", "Leads"],
    ],
    uses: ["salesforce", "sap-s4hana", "opcenter-mes", "sharepoint-quality"],
    documents: ["8d-template", "complaint-procedure"],
    follows: ["quality-policy"],
  },
  {
    key: "operations.delivery-documents",
    name: "Delivery documents",
    summary: "Every shipment leaves with its delivery note, test certificates and, for exports, customs documents.",
    department: "operations",
    owner: "serkan.gunes",
    status: "Documented",
    frequency: "About 25 shipments a week",
    trigger: "Pumps are packed for shipping",
    steps: [
      ["Pick and pack", "Serkan Güneş", "SAP S/4HANA", ""],
      ["Delivery note", "Serkan Güneş", "SAP S/4HANA", "German customers get it in German."],
      ["Test certificates", "Deniz Çelik", "PumpTest Pro", "One per pump, attached to the delivery."],
      ["Export documents", "Murat Kılıç", "SAP S/4HANA", "Commercial invoice, packing list, certificate of origin."],
    ],
    rules: ["Every pump ships with its test certificate", "German customers get delivery notes in German"],
    inputs: ["Packed pumps", "Delivery in SAP"],
    outputs: ["Delivery note", "Test certificates", "Export documents"],
    does: [
      ["person", "serkan.gunes", "Packs and ships"],
      ["person", "murat.kilic", "Export documents"],
    ],
    uses: ["sap-s4hana", "pumptest-pro"],
    documents: ["delivery-note-de"],
  },
  {
    key: "order-to-delivery",
    name: "Order to delivery",
    summary: "From a customer's purchase order to pumps delivered: order entry, date, production, final test, shipping and the invoice.",
    department: "operations",
    owner: "okan.tekin",
    status: "Documented",
    frequency: "About 120 sales orders a month",
    trigger: "A customer's purchase order",
    steps: [
      [
        "Order entry",
        "Ali Yıldız",
        "SAP S/4HANA",
        "The won deal is keyed into SAP as a sales order (by hand from Salesforce). Laura Rossi does it for export orders.",
      ],
      ["Date", "Okan Tekin", "SAP S/4HANA", "Confirm the delivery date within 2 working days."],
      ["Production", "Deniz Çelik", "Opcenter MES", "Work orders released from SAP."],
      ["Final test", "Deniz Çelik", "PumpTest Pro", "Every pump on the test bench."],
      ["Pack and ship", "Serkan Güneş", "SAP S/4HANA", "With delivery documents."],
      ["Invoice", "Selin Arslan", "Uyumsoft e-Fatura", "E-invoice sent when the goods leave."],
    ],
    rules: [
      "Delivery date confirmed within 2 working days",
      "No shipment without a passed final test",
      "Customers on credit hold need the Finance Manager's release",
    ],
    inputs: ["Customer purchase order"],
    outputs: ["Delivered pumps", "Invoice"],
    kpis: ["On-time delivery 95%", "4 weeks for standard pumps"],
    problems: [
      "Won deals are keyed into SAP by hand from Salesforce: price mistakes happen",
      "Customers call about order status because the portal shows only shipped orders",
    ],
    does: [
      ["person", "ali.yildiz", "Order entry (Türkiye)"],
      ["person", "laura.rossi", "Order entry (export)"],
      ["person", "okan.tekin", "Dates"],
      ["person", "deniz.celik", "Production and test"],
      ["person", "serkan.gunes", "Shipping"],
    ],
    uses: ["salesforce", "sap-s4hana", "opcenter-mes", "pumptest-pro", "customer-portal"],
    handsOver: [["finance.collections", "Invoices to collect"]],
  },
  {
    key: "pump-final-test",
    name: "Pump final test",
    summary: "Every pump is run on a test bench before it ships; its certificate goes with it.",
    department: "operations",
    owner: "deniz.celik",
    status: "Documented",
    frequency: "About 900 pumps a month",
    trigger: "A pump is assembled",
    steps: [
      ["Mount the pump", "Operator", "", "On bench TB1 or TB2."],
      ["Run the test curve", "Operator", "PumpTest Pro", "Flow, head and power at 5 points."],
      ["Vibration check", "Operator", "PumpTest Pro", "Limit 4.5 mm/s."],
      ["Certificate", "Operator", "Opcenter MES", "Printed, and saved to MES by serial number."],
    ],
    rules: ["Every pump is tested (since 2023)", "Benches are calibrated every 2,000 hours", "A failed pump goes back to assembly, never to the warehouse"],
    inputs: ["Assembled pump"],
    outputs: ["Test certificate", "Test result in MES"],
    does: [
      ["person", "deniz.celik", "Runs the test area"],
      ["person", "hakan.erdogan", "Calibrates the benches"],
    ],
    uses: ["pumptest-pro", "opcenter-mes"],
    documents: ["test-procedure"],
    follows: ["quality-policy"],
    partOf: "order-to-delivery",
  },
  {
    key: "preventive-maintenance",
    name: "Preventive maintenance",
    summary: "Machines and test benches are checked and serviced on a plan, so they don't break down.",
    department: "operations",
    owner: "okan.tekin",
    status: "Draft",
    frequency: "Weekly checks, monthly services",
    trigger: "The maintenance plan",
    steps: [
      ["Weekly checks", "Hakan Erdoğan", "", "Paper checklists per machine."],
      ["Calibrate test benches", "Hakan Erdoğan", "PumpTest Pro", "Every 2,000 hours, against the reference flow meter."],
      ["Service machines", "Hakan Erdoğan", "", "With the machine makers' service teams."],
    ],
    rules: ["Test benches calibrated every 2,000 hours"],
    inputs: ["Maintenance plan"],
    outputs: ["Checked machines", "Calibration records"],
    problems: ["The maintenance plan is on paper in Hakan's office", "No one else can calibrate the test benches"],
    does: [["person", "hakan.erdogan", "All of it"]],
    uses: ["pumptest-pro"],
    documents: ["maintenance-checklists"],
  },
  {
    key: "procurement.purchase-requisition",
    name: "Purchasing",
    summary: "From a request to a purchase order with an approved supplier, and the goods received.",
    department: "procurement",
    owner: "ayse.kaya",
    status: "Documented",
    frequency: "About 300 purchase orders a month",
    trigger: "A purchase requisition in SAP",
    steps: [
      ["Request", "Anyone", "SAP S/4HANA", "A purchase requisition."],
      ["Quotes", "Ayşe Kaya", "Exchange Online", "3 quotes above 100,000 TRY."],
      ["Order", "Ayşe Kaya", "SAP S/4HANA", "Purchase order to an approved supplier."],
      ["Follow up", "Ayşe Kaya", "Exchange Online", "Order confirmation and delivery date."],
      ["Goods receipt", "Serkan Güneş", "SAP S/4HANA", "What arrived, posted the same day."],
    ],
    rules: [
      "3 quotes for orders above 100,000 TRY",
      "Only approved suppliers; a new supplier needs a supplier audit",
      "Purchase orders above 500,000 TRY need the Plant Manager's approval",
    ],
    inputs: ["Purchase requisition"],
    outputs: ["Purchase order", "Goods receipt"],
    does: [
      ["person", "ayse.kaya", "Quotes and orders"],
      ["person", "serkan.gunes", "Goods receipt"],
    ],
    uses: ["sap-s4hana", "exchange-online"],
    follows: ["approval-matrix"],
    handsOver: [["finance.accounts-payable", "Purchase order and goods receipt"]],
  },
  {
    key: "it.helpdesk-triage",
    name: "IT help desk",
    summary: "Employees' IT problems and questions are sorted, solved or passed to the right specialist.",
    department: "it",
    owner: "mehmet.oz",
    status: "Documented",
    frequency: "About 25 tickets a day",
    trigger: "A ticket in Jira Service Management or an email to it-helpdesk@",
    steps: [
      ["Ticket", "Employee", "Jira Service Management", "Or an email to it-helpdesk@."],
      ["Sort", "Helpdesk Agent (AI)", "Jira Service Management", "Priority, category and an answer for how-to questions."],
      ["Solve", "Emre Koç", "Jira Service Management", ""],
      ["Escalate", "Can Öztürk", "", "Servers, network and SAP; Ozan Kurt for the portal."],
    ],
    rules: ["Priority 1 (production stopped) answered within 30 minutes", "Password resets only after an identity check"],
    inputs: ["Ticket"],
    outputs: ["Solved ticket"],
    does: [
      ["person", "emre.koc", "Solves"],
      ["person", "can.ozturk", "Servers and network"],
      ["ai_employee", "Helpdesk Agent", "Sorts and answers how-tos"],
    ],
    uses: ["jira-service-management", "exchange-online", "entra-id"],
    follows: ["it-security"],
  },
  {
    key: "it.access-requests",
    name: "Access requests",
    summary: "Who may use which system: asked, approved by the manager and the process owner, then set up.",
    department: "it",
    owner: "mehmet.oz",
    status: "Documented",
    frequency: "About 40 a month",
    trigger: "A request in Jira Service Management",
    steps: [
      ["Ask", "Employee", "Jira Service Management", ""],
      ["Manager approves", "Manager", "Jira Service Management", ""],
      ["Process owner approves", "Process owner", "Jira Service Management", "For SAP roles."],
      ["Set up", "Emre Koç", "Microsoft Entra ID", "Or in SAP for SAP roles."],
    ],
    rules: ["SAP roles need the process owner's approval", "Access is reviewed every 6 months", "No shared accounts"],
    inputs: ["Access request"],
    outputs: ["Access set up"],
    does: [
      ["person", "emre.koc", "Sets up"],
      ["ai_employee", "Access Request Agent", "Checks requests and approvals"],
    ],
    uses: ["jira-service-management", "entra-id", "sap-s4hana"],
    follows: ["it-security"],
  },
  {
    key: "sales.quote-preparation",
    name: "Quotations",
    summary: "From a customer's need to an offer: pump selection, price from the price calculator, discount approval and the offer.",
    department: "sales",
    owner: "thomas.weber",
    status: "Documented",
    frequency: "About 60 offers a month",
    trigger: "A customer's request for a quote",
    steps: [
      ["Understand the need", "Ali Yıldız", "Salesforce", "Flow, head, liquid, standards. Laura Rossi for export customers."],
      ["Price", "Laura Rossi", "Price calculator (Excel)", "Material costs plus margin by customer group."],
      ["Approve the discount", "Thomas Weber", "Exchange Online", "Above 15%."],
      ["Send the offer", "Ali Yıldız", "Salesforce", "Offer template from SharePoint › Sales."],
    ],
    rules: ["Discounts above 15% need the Sales Director's approval", "Offers are valid for 30 days", "Use price list 2026/2"],
    inputs: ["Request for quote"],
    outputs: ["Offer", "Deal in Salesforce"],
    problems: ["Only Laura Rossi knows the macros of the price calculator"],
    does: [
      ["person", "ali.yildiz", "Turkish customers"],
      ["person", "laura.rossi", "Export customers and pricing"],
      ["person", "thomas.weber", "Discount approval"],
    ],
    uses: ["salesforce", "price-calculator", "sharepoint-sales"],
    documents: ["offer-template", "price-list"],
    follows: ["approval-matrix"],
    handsOver: [["order-to-delivery", "Won deals"]],
  },
];

const POLICIES: {
  key: string;
  name: string;
  summary: string;
  category: string;
  rules: string[];
  appliesTo: string;
  effective: string;
  version: string;
  owner: string;
  document?: string;
}[] = [
  {
    key: "approval-matrix",
    name: "Approval matrix",
    summary: "Who approves what, and above which amount.",
    category: "Finance",
    rules: [
      "Supplier invoices: Finance Manager above 250,000 TRY; CFO above 1,000,000 TRY",
      "Purchase orders: Procurement Manager up to 500,000 TRY; Plant Manager above; CEO above 2,000,000 TRY",
      "Discounts: Sales Director above 15%; CEO above 25%",
      "Credits to customers: Finance Manager above 10,000 TRY",
      "Payment plans: Finance Manager",
    ],
    appliesTo: "Everyone who approves spending, prices or credits",
    effective: "2026-01-01",
    version: "4.0",
    owner: "elif.yilmaz",
    document: "approval-matrix-doc",
  },
  {
    key: "kvkk",
    name: "Personal data protection (KVKK)",
    summary: "How the company keeps people's personal data, under Turkey's data protection law.",
    category: "Legal",
    rules: [
      "Only collect the personal data the work needs",
      "CVs are kept 6 months unless the candidate agrees to longer",
      "Payroll data stays in Logo Bordro and with the payroll team",
      "AI employees read personal data only where their job needs it, and never payroll data",
    ],
    appliesTo: "Everyone, and every AI employee",
    effective: "2024-05-01",
    version: "2.1",
    owner: "zeynep.demir",
  },
  {
    key: "quality-policy",
    name: "Quality policy (ISO 9001)",
    summary: "The company's promises on quality.",
    category: "Quality",
    rules: ["Every pump is tested before it ships", "Every customer complaint gets an 8D", "Casting suppliers are audited every 2 years"],
    appliesTo: "Operations, Procurement and Customer Service",
    effective: "2023-06-01",
    version: "5.0",
    owner: "selin.acar",
  },
  {
    key: "it-security",
    name: "IT security and acceptable use",
    summary: "How people use the company's systems and keep them safe.",
    category: "IT",
    rules: [
      "Multi-factor sign-in for everyone",
      "No company files on personal drives or USB sticks",
      "New software only through IT",
      "Access is reviewed every 6 months",
    ],
    appliesTo: "Everyone",
    effective: "2025-01-15",
    version: "3.2",
    owner: "mehmet.oz",
  },
  {
    key: "travel-expenses",
    name: "Travel and expenses",
    summary: "What the company pays for when people travel.",
    category: "Finance",
    rules: ["Hotels up to 4,000 TRY a night in Türkiye, 180 EUR abroad", "Economy class for flights under 6 hours", "Receipts uploaded within 30 days"],
    appliesTo: "Everyone who travels for work",
    effective: "2026-01-01",
    version: "2.0",
    owner: "burak.sahin",
  },
];

const DOCUMENTS: {
  key: string;
  name: string;
  type: string;
  location: string;
  store?: string;
  owner: string;
  version?: string;
  updated?: string;
  format?: string;
}[] = [
  {
    key: "ap-procedure",
    name: "AP procedure (FIN-PRC-003)",
    type: "Procedure",
    location: "SharePoint › Finance › Procedures",
    store: "sharepoint-finance",
    owner: "burak.sahin",
    version: "2.1",
    updated: "2026-03-10",
    format: "Word",
  },
  {
    key: "approval-matrix-doc",
    name: "Approval matrix (FIN-POL-001)",
    type: "Policy",
    location: "SharePoint › Finance › Policies",
    store: "sharepoint-finance",
    owner: "elif.yilmaz",
    version: "4.0",
    updated: "2026-01-02",
    format: "PDF",
  },
  {
    key: "close-checklist",
    name: "Month-end close checklist",
    type: "Form",
    location: "SharePoint › Finance › Close",
    store: "sharepoint-finance",
    owner: "selin.arslan",
    format: "Excel",
  },
  {
    key: "8d-template",
    name: "8D report template (QM-FRM-012)",
    type: "Template",
    location: "SharePoint › Quality › Forms",
    store: "sharepoint-quality",
    owner: "selin.acar",
    version: "3",
    format: "Word",
  },
  {
    key: "complaint-procedure",
    name: "Complaint handling procedure (QM-PRC-004)",
    type: "Procedure",
    location: "SharePoint › Quality › Procedures",
    store: "sharepoint-quality",
    owner: "selin.acar",
    version: "6",
    updated: "2025-11-20",
    format: "PDF",
  },
  {
    key: "test-procedure",
    name: "Pump final test procedure (QM-PRC-007)",
    type: "Procedure",
    location: "SharePoint › Quality › Procedures",
    store: "sharepoint-quality",
    owner: "deniz.celik",
    version: "4",
    format: "PDF",
  },
  {
    key: "maintenance-checklists",
    name: "Maintenance checklists",
    type: "Form",
    location: "Paper binders in the maintenance office, Gebze",
    owner: "hakan.erdogan",
    format: "Paper",
  },
  {
    key: "onboarding-checklist",
    name: "Onboarding checklist",
    type: "Form",
    location: "SharePoint › HR › Onboarding",
    store: "sharepoint-hr",
    owner: "ayse.yilmaz",
    format: "Word",
  },
  {
    key: "offer-template",
    name: "Offer template",
    type: "Template",
    location: "SharePoint › Sales › Templates",
    store: "sharepoint-sales",
    owner: "thomas.weber",
    format: "Word",
  },
  {
    key: "price-list",
    name: "Price list 2026/2",
    type: "Other",
    location: "SharePoint › Sales › Price lists",
    store: "sharepoint-sales",
    owner: "thomas.weber",
    updated: "2026-07-01",
    format: "Excel",
  },
  {
    key: "delivery-note-de",
    name: "German delivery note template",
    type: "Template",
    location: "SharePoint › Sales › Templates",
    store: "sharepoint-sales",
    owner: "laura.rossi",
    format: "Word",
  },
  {
    key: "employee-handbook",
    name: "Employee handbook",
    type: "Manual",
    location: "SharePoint › HR › Policies",
    store: "sharepoint-hr",
    owner: "zeynep.demir",
    version: "2026",
    format: "PDF",
  },
];

const GOALS: {
  key: string;
  name: string;
  target: string;
  current: string;
  status: string;
  period: string;
  measure: string;
  owner: string;
  about?: SourceRef;
}[] = [
  {
    key: "revenue-2026",
    name: "Revenue of 1.1 billion TRY in 2026",
    target: "1.1 billion TRY",
    current: "0.82 billion TRY (end of September)",
    status: "On track",
    period: "2026",
    measure: "Invoiced sales in SAP",
    owner: "mehmet.aydin",
  },
  {
    key: "on-time-delivery",
    name: "On-time delivery of 95%",
    target: "95%",
    current: "91% (September)",
    status: "At risk",
    period: "2026",
    measure: "Order lines shipped by the confirmed date, from SAP",
    owner: "okan.tekin",
    about: { kind: "process", key: "order-to-delivery" },
  },
  {
    key: "fewer-complaints",
    name: "30% fewer customer complaints than in 2025",
    target: "-30%",
    current: "-18% so far",
    status: "At risk",
    period: "2026",
    measure: "Quality cases in Salesforce",
    owner: "selin.acar",
    about: { kind: "process", key: "operations.quality-incidents" },
  },
  {
    key: "invoice-days",
    name: "Supplier invoices posted within 3 days",
    target: "3 days",
    current: "2.4 days",
    status: "On track",
    period: "2026",
    measure: "Receipt to posting, from SAP",
    owner: "burak.sahin",
    about: { kind: "process", key: "finance.accounts-payable" },
  },
  {
    key: "export-share",
    name: "Export share of 45%",
    target: "45% of sales",
    current: "41%",
    status: "On track",
    period: "2026",
    measure: "Export sales over all sales",
    owner: "thomas.weber",
  },
  {
    key: "ai-employees",
    name: "10 AI employees at work by the end of the year",
    target: "10",
    current: "8 at work",
    status: "On track",
    period: "2026",
    measure: "AI employees at work in Enterprise Brain",
    owner: "mehmet.oz",
  },
];

const DECISIONS: { key: string; name: string; summary: string; decided: string; why: string; alternatives: string[]; by: string[]; about?: SourceRef[] }[] = [
  {
    key: "test-every-pump",
    name: "Test every pump before it ships",
    summary: "All pumps run on a test bench, not one in ten.",
    decided: "2023-05-15",
    why: "In 2023, 14 pumps failed at Petrokim because of a casting defect that sampling (1 pump in 10) missed. Testing every pump takes about 25 minutes each and stops repeat failures at key customers.",
    alternatives: ["Keep testing 1 pump in 10", "Test every pump only for oil and gas customers"],
    by: ["mehmet.aydin", "okan.tekin"],
    about: [{ kind: "process", key: "pump-final-test" }],
  },
  {
    key: "sap-on-premises",
    name: "Keep SAP on premises until 2027",
    summary: "SAP stays in the Gebze server room for now.",
    decided: "2025-02-01",
    why: "MES and the test benches talk to SAP over the plant network; moving SAP to the cloud first needs a new MES interface. The SAP licence runs until 2027.",
    alternatives: ["RISE with SAP in 2025", "SAP Business ByDesign"],
    by: ["mehmet.oz", "elif.yilmaz"],
    about: [{ kind: "system", key: "sap-s4hana" }],
  },
  {
    key: "salesforce-crm",
    name: "Move sales from Excel to Salesforce",
    summary: "One CRM for Istanbul and Hamburg.",
    decided: "2024-01-10",
    why: "Sales in Hamburg and Istanbul kept customers in their own Excel files; deals and contacts were lost when people left.",
    alternatives: ["Microsoft Dynamics 365", "Keep Excel with shared folders"],
    by: ["thomas.weber"],
    about: [{ kind: "system", key: "salesforce" }],
  },
  {
    key: "ai-supervised",
    name: "New AI employees start supervised",
    summary: "People approve what a new AI employee sends and changes for its first month.",
    decided: "2026-06-01",
    why: "So each department sees how its AI employees work before letting them act alone; the manager then decides their level.",
    alternatives: ["Trust ready-made AI employees from day one"],
    by: ["mehmet.aydin"],
  },
  {
    key: "slack-hamburg",
    name: "Hamburg keeps Slack until the Teams move",
    summary: "The Hamburg office moves to Teams in 2027.",
    decided: "2025-09-01",
    why: "The Hamburg team came with the 2022 acquisition and works in Slack; the move to Teams is planned with the Microsoft 365 renewal in 2027.",
    alternatives: ["Move Hamburg to Teams in 2025"],
    by: ["mehmet.oz", "thomas.weber"],
    about: [
      { kind: "system", key: "slack" },
      { kind: "system", key: "ms-teams" },
    ],
  },
];

const KNOWHOW: { key: string; name: string; when: string; details: string; from: string; about: SourceRef[] }[] = [
  {
    key: "bench-drift",
    name: "Test bench TB1 reads flow too high after about 2,000 hours: recalibrate its flow meter",
    when: "When TB1's results look better than usual",
    details: "The magnetic flow meter on TB1 drifts by about +3%. Check it against the reference meter; until it is recalibrated, use TB2.",
    from: "hakan.erdogan",
    about: [
      { kind: "system", key: "pumptest-pro" },
      { kind: "process", key: "pump-final-test" },
    ],
  },
  {
    key: "petrokim-certificate",
    name: "Petrokim pays only when the test certificates are attached to the invoice",
    when: "Invoicing Petrokim",
    details: "Their accounts payable rejects invoices without the certificate PDFs. Download them from MES or the portal and attach them.",
    from: "ali.yildiz",
    about: [
      { kind: "client", name: "Petrokim Rafineri A.Ş." },
      { kind: "process", key: "finance.collections" },
    ],
  },
  {
    key: "sap-m8087",
    name: "SAP error M8 087 when posting an invoice means the goods receipt is missing",
    when: "Posting a supplier invoice fails with M8 087",
    details: "Ask the Gebze warehouse (Serkan Güneş) to post the goods receipt first, then post the invoice again.",
    from: "elif.arslan",
    about: [
      { kind: "system", key: "sap-s4hana" },
      { kind: "process", key: "finance.accounts-payable" },
    ],
  },
  {
    key: "german-delivery-notes",
    name: "Customers in Germany want delivery notes in German",
    when: "Shipping to Hansa Pumpen, Nordwind or other German-speaking customers",
    details: "Use the German template on SharePoint › Sales; Hansa Pumpen sends English ones back.",
    from: "laura.rossi",
    about: [
      { kind: "process", key: "operations.delivery-documents" },
      { kind: "client", name: "Hansa Pumpen Vertrieb GmbH" },
    ],
  },
  {
    key: "gulf-fat",
    name: "Gulf Water's inspector witnesses every FAT: book him two weeks ahead",
    when: "Planning a factory acceptance test for Gulf Water",
    details: "Mr. Rahman travels from Dubai; he needs the test plan a week before.",
    from: "laura.rossi",
    about: [{ kind: "client", name: "Gulf Water Solutions LLC" }],
  },
  {
    key: "efatura-month-end",
    name: "Uyumsoft is slow in the last two days of the month: send e-invoices before the 28th",
    when: "Invoicing at month end",
    details: "At month end the integrator queues invoices for hours.",
    from: "selin.arslan",
    about: [{ kind: "system", key: "uyumsoft-e-fatura" }],
  },
  {
    key: "consolidation-datev",
    name: "The consolidation workbook needs Hamburg's DATEV export first",
    when: "Doing the monthly consolidation",
    details: "Ask Hamburg's accountants (Steuerbüro Krüger) for the DATEV export on working day 2; the workbook's macros fail without it.",
    from: "hande.ozkan",
    about: [{ kind: "process", key: "consolidation-reporting" }],
  },
  {
    key: "casting-porosity",
    name: "Castings from Anadolu Döküm: check porosity on the first 5 of each batch",
    when: "Incoming inspection of pump housings",
    details: "Two batches in 2025 had porosity in the volute; checking the first 5 catches a bad batch.",
    from: "kerem.yildiz",
    about: [{ kind: "supplier", name: "Anadolu Döküm Sanayi Ltd. Şti." }],
  },
];

const TERMS: { name: string; aliases?: string[]; meaning: string; example?: string }[] = [
  {
    name: "8D",
    aliases: ["8D report"],
    meaning: "Eight disciplines: the step-by-step way Quality solves a customer complaint and keeps it from happening again.",
    example: "Kerem writes the 8D for the Petrokim vibration complaint.",
  },
  {
    name: "FAT",
    aliases: ["Factory acceptance test"],
    meaning: "Factory acceptance test: the customer, or their inspector, watches their pumps tested in Gebze before they ship.",
  },
  { name: "3-way match", meaning: "Checking a supplier invoice against its purchase order and its goods receipt." },
  { name: "GR", aliases: ["Goods receipt"], meaning: "Goods receipt: the warehouse records in SAP what arrived." },
  { name: "ACP", aliases: ["ACP series"], meaning: "Acme centrifugal pump: the main product line, from ACP-50 to ACP-150." },
  { name: "OTD", aliases: ["On-time delivery"], meaning: "On-time delivery: the share of order lines shipped by the confirmed date." },
  { name: "e-Fatura", aliases: ["e-invoice"], meaning: "Turkey's electronic invoice, sent and received through the tax authority (GİB) via Uyumsoft." },
  { name: "VUK", meaning: "Vergi Usul Kanunu, the Turkish Tax Procedure Law: rules for the books, and keeping documents 10 years." },
  { name: "KVKK", meaning: "Turkey's personal data protection law." },
  { name: "RMA", meaning: "Return merchandise authorization: the number a customer's return gets." },
  { name: "NPI", aliases: ["New product introduction"], meaning: "New product introduction: bringing a new pump from prototype to series production." },
  { name: "TB1 / TB2", aliases: ["TB1", "TB2"], meaning: "The two pump test benches in Gebze." },
];

function step([name, who, system, does]: Process["steps"][number]): BrainStep {
  return { name, who, system, does };
}

export const intranetSource: BrainSourceDefinition = {
  key: "intranet",
  name: "Intranet (demo)",
  system: "SharePoint pages",
  description:
    "The process handbook (steps, rules, inputs and outputs, who does what, systems and documents), policies, documents, the company profile, goals, decisions, know-how and company words.",
  brings: ["Processes, step by step", "Policies and rules", "Documents", "Goals and decisions", "Know-how and company words"],
  icon: "book-open",
  demo: true,
  priority: 50,
  async read({ domain, companyName }) {
    const person = (local: string): SourceRef => ({ kind: "person", email: `${local}@${domain}` });
    const entities: SourceEntity[] = [
      {
        kind: "company",
        key: "company",
        name: companyName,
        summary:
          "Makes centrifugal pumps, valves and pump skids for water, industry and energy in its plant in Gebze, and sells them in Türkiye, Europe, the Middle East and Africa. Its sales office in Hamburg is Acme Pumpen GmbH.",
        data: {
          industry: "Industrial pumps and valves",
          founded: "1994",
          revenue: "About 1 billion TRY (2025)",
          website: "https://www.acme.com.tr",
          markets: ["Türkiye", "Germany and Northern Europe", "Middle East", "North Africa"],
          mission: "Reliable pumps, each one tested, delivered when promised.",
          values: ["Every pump tested", "Keep our promises to customers", "Safety first", "Learn from every complaint"],
        },
      },
    ];
    const links: SourceLink[] = [];

    for (const process of PROCESSES) {
      entities.push({
        kind: "process",
        ref: process.key,
        key: process.key,
        name: process.name,
        summary: process.summary,
        data: {
          status: process.status,
          frequency: process.frequency,
          trigger: process.trigger,
          steps: process.steps.map(step),
          rules: process.rules,
          inputs: process.inputs,
          outputs: process.outputs,
          kpis: process.kpis ?? [],
          problems: process.problems ?? [],
        },
      });
      const me: SourceRef = { kind: "process", key: process.key };
      links.push({ from: person(process.owner), relation: "owns", to: me });
      links.push({ from: { kind: "department", key: process.department }, relation: "owns", to: me });
      for (const [kind, who, part] of process.does) {
        const from: SourceRef = kind === "person" ? person(who) : { kind, name: who };
        links.push({ from, relation: "does", to: me, detail: part });
      }
      for (const key of process.uses) links.push({ from: me, relation: "uses", to: { kind: key.startsWith("sharepoint-") ? "data_store" : "system", key } });
      for (const key of process.documents ?? []) links.push({ from: me, relation: "described_in", to: { kind: "document", key } });
      for (const key of process.follows ?? []) links.push({ from: me, relation: "follows", to: { kind: "policy", key } });
      for (const [key, what] of process.handsOver ?? []) links.push({ from: me, relation: "hands_over_to", to: { kind: "process", key }, detail: what });
      if (process.partOf) links.push({ from: me, relation: "part_of", to: { kind: "process", key: process.partOf } });
    }
    for (const policy of POLICIES) {
      entities.push({
        kind: "policy",
        ref: policy.key,
        key: policy.key,
        name: policy.name,
        summary: policy.summary,
        data: { category: policy.category, rules: policy.rules, applies_to: policy.appliesTo, effective: policy.effective, version: policy.version },
      });
      links.push({ from: person(policy.owner), relation: "owns", to: { kind: "policy", key: policy.key } });
      if (policy.document) links.push({ from: { kind: "policy", key: policy.key }, relation: "described_in", to: { kind: "document", key: policy.document } });
    }
    for (const document of DOCUMENTS) {
      entities.push({
        kind: "document",
        ref: document.key,
        key: document.key,
        name: document.name,
        data: { type: document.type, location: document.location, version: document.version, updated: document.updated, format: document.format },
      });
      links.push({ from: person(document.owner), relation: "owns", to: { kind: "document", key: document.key } });
      if (document.store) links.push({ from: { kind: "document", key: document.key }, relation: "stored_in", to: { kind: "data_store", key: document.store } });
    }
    for (const goal of GOALS) {
      entities.push({
        kind: "goal",
        ref: goal.key,
        key: goal.key,
        name: goal.name,
        data: { target: goal.target, current: goal.current, status: goal.status, period: goal.period, measure: goal.measure },
      });
      links.push({ from: person(goal.owner), relation: "leads", to: { kind: "goal", key: goal.key } });
      if (goal.about) links.push({ from: { kind: "goal", key: goal.key }, relation: "about", to: goal.about });
    }
    for (const decision of DECISIONS) {
      entities.push({
        kind: "decision",
        ref: decision.key,
        key: decision.key,
        name: decision.name,
        summary: decision.summary,
        data: { decided: decision.decided, status: "In force", why: decision.why, alternatives: decision.alternatives },
      });
      for (const by of decision.by) links.push({ from: { kind: "decision", key: decision.key }, relation: "decided_by", to: person(by) });
      for (const about of decision.about ?? []) links.push({ from: { kind: "decision", key: decision.key }, relation: "about", to: about });
    }
    for (const item of KNOWHOW) {
      entities.push({ kind: "knowhow", ref: item.key, key: item.key, name: item.name, data: { when: item.when, details: item.details } });
      links.push({ from: { kind: "knowhow", key: item.key }, relation: "shared_by", to: person(item.from) });
      for (const about of item.about) links.push({ from: { kind: "knowhow", key: item.key }, relation: "about", to: about });
    }
    for (const term of TERMS)
      entities.push({ kind: "term", ref: term.name, name: term.name, aliases: term.aliases, summary: term.meaning, data: { example: term.example } });
    return { entities, links };
  },
};
