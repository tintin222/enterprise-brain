import type { BrainApi } from "@enterprise-brain/core";
import type { SourceEntity, SourceLink } from "../types.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * A made-up IT inventory (standing in for a CMDB) of the demo company: its systems with what they
 * do, who owns and looks after them, their APIs, their databases, where documents are kept, where
 * everything runs, and which data flows between them. The databases' tables come from the databases
 * themselves and the data catalog (data.ts).
 */

interface System {
  key: string;
  name: string;
  aliases?: string[];
  summary: string;
  category: string;
  vendor: string;
  hosting: string;
  location: string;
  url?: string;
  users?: number;
  criticality: string;
  signIn?: string;
  version?: string;
  status?: string;
  features: string[];
  data?: string[];
  apis?: BrainApi[];
  /** The platform connection category that reaches it, when there is one. */
  connects?: string;
  owner?: string;
  itContact?: string[];
  usedBy?: [string, string][];
  runsOn?: string;
  partOf?: string;
  database?: string;
}

const SYSTEMS: System[] = [
  {
    key: "sap-s4hana",
    name: "SAP S/4HANA",
    aliases: ["SAP", "S/4HANA", "S4"],
    summary: "The ERP: accounting, purchasing, sales orders, production planning, quality and the warehouse.",
    category: "ERP",
    vendor: "SAP S/4HANA 2023, on premise",
    hosting: "On premises",
    location: "Gebze server room (VMware cluster)",
    url: "https://sapfiori.acme.local",
    users: 85,
    criticality: "Critical",
    signIn: "SAP GUI and Fiori, with Microsoft Entra ID single sign-on",
    version: "2023 FPS02",
    features: [
      "Finance and controlling (FI/CO)",
      "Purchasing (MM)",
      "Sales and delivery (SD)",
      "Production planning (PP)",
      "Quality management (QM)",
      "Warehouse (WM)",
    ],
    data: ["Suppliers", "Customers", "Materials and prices", "Purchase orders", "Sales orders", "Supplier invoices", "Stock", "Production orders"],
    apis: [
      {
        name: "OData services (SAP Gateway)",
        style: "OData v2",
        url: "https://sapgw.acme.local:44300/sap/opu/odata/sap/",
        auth: "Technical user EB_ODATA (basic auth), over the company network or VPN",
        docs: "https://api.sap.com/products/SAPS4HANA/apis/ODATA",
        endpoints: [
          "GET API_SALES_ORDER_SRV/A_SalesOrder — sales orders",
          "GET API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder — purchase orders",
          "POST API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice — post a supplier invoice",
          "GET API_BUSINESS_PARTNER/A_BusinessPartner — suppliers and customers",
          "GET API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod — stock by material",
        ],
      },
      {
        name: "RFC / BAPI",
        style: "RFC",
        url: "sapapp01.acme.local, system S4P, client 100",
        auth: "Technical user RFC_EB",
        docs: "",
        endpoints: ["BAPI_INCOMINGINVOICE_CREATE — post a supplier invoice", "BAPI_PO_GETDETAIL — read a purchase order"],
      },
    ],
    connects: "erp",
    owner: "elif.yilmaz",
    itContact: ["mehmet.oz", "can.ozturk"],
    usedBy: [
      ["finance", "Accounting, invoices and payments"],
      ["procurement", "Purchase orders"],
      ["operations", "Production orders, quality and stock"],
      ["sales", "Sales orders and prices"],
      ["customer-service", "Order status and returns"],
    ],
    runsOn: "gebze-vmware",
    database: "s4p-hana",
  },
  {
    key: "salesforce",
    name: "Salesforce",
    aliases: ["Salesforce CRM", "SFDC"],
    summary: "The CRM: clients, contacts, deals, quotes and customer cases.",
    category: "CRM",
    vendor: "Salesforce Sales Cloud and Service Cloud, Enterprise edition",
    hosting: "SaaS",
    location: "Salesforce EU (Frankfurt)",
    url: "https://acme.my.salesforce.com",
    users: 22,
    criticality: "High",
    signIn: "Microsoft Entra ID single sign-on",
    features: ["Clients and contacts", "Deals and quotes", "Customer cases", "Calls, meetings and emails with clients"],
    data: ["Clients", "Contacts", "Deals", "Customer cases", "Activities"],
    apis: [
      {
        name: "REST API",
        style: "REST",
        url: "https://acme.my.salesforce.com/services/data/v61.0",
        auth: 'OAuth 2.0, connected app "Enterprise Brain"',
        docs: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
        endpoints: [
          "GET /sobjects/Account/{id} — a client",
          "GET /query?q={SOQL} — any query",
          "POST /sobjects/Case — open a customer case",
          "PATCH /sobjects/Opportunity/{id} — update a deal",
        ],
      },
    ],
    connects: "crm",
    owner: "thomas.weber",
    itContact: ["ozan.kurt"],
    usedBy: [
      ["sales", "Clients, deals and quotes"],
      ["customer-service", "Customer cases"],
    ],
  },
  {
    key: "microsoft-365",
    name: "Microsoft 365",
    aliases: ["M365", "Office 365"],
    summary: "Email, Teams, SharePoint, OneDrive and the Office apps for everyone.",
    category: "Collaboration",
    vendor: "Microsoft 365 E3",
    hosting: "SaaS",
    location: "Microsoft cloud, EU Data Boundary",
    users: 180,
    criticality: "Critical",
    signIn: "Microsoft Entra ID with multi-factor sign-in",
    features: ["Exchange Online mail", "Teams chat and meetings", "SharePoint and OneDrive", "Office apps"],
    apis: [
      {
        name: "Microsoft Graph",
        style: "REST",
        url: "https://graph.microsoft.com/v1.0",
        auth: 'Entra ID app registration "Enterprise Brain" (application permissions)',
        docs: "https://learn.microsoft.com/graph/overview",
        endpoints: [
          "GET /users/{id}/messages — a mailbox's emails",
          "POST /users/{id}/sendMail — send an email",
          "GET /teams/{id}/channels/{id}/messages — Teams channel messages",
          "GET /sites/{id}/drive/root/children — SharePoint files",
        ],
      },
    ],
    owner: "mehmet.oz",
    itContact: ["emre.koc"],
  },
  {
    key: "exchange-online",
    name: "Exchange Online",
    aliases: ["Outlook", "Exchange"],
    summary: "The company's mail system: everyone's mailbox and the shared mailboxes.",
    category: "Mail",
    vendor: "Microsoft 365 Exchange Online",
    hosting: "SaaS",
    location: "Microsoft cloud, EU Data Boundary",
    users: 180,
    criticality: "Critical",
    features: ["A mailbox for everyone", "Shared mailboxes: invoices@, support@, careers@, it-helpdesk@, quality@, sales@", "Spam filtering and archiving"],
    data: ["Emails with clients and suppliers"],
    connects: "mail",
    itContact: ["emre.koc"],
    usedBy: [
      ["finance", "invoices@"],
      ["customer-service", "support@"],
      ["hr", "careers@"],
      ["it", "it-helpdesk@"],
    ],
    partOf: "microsoft-365",
  },
  {
    key: "ms-teams",
    name: "Microsoft Teams",
    aliases: ["MS Teams"],
    summary: "Chat, channels and meetings at the Istanbul HQ and the Gebze plant.",
    category: "Collaboration",
    vendor: "Microsoft 365",
    hosting: "SaaS",
    location: "Microsoft cloud",
    users: 150,
    criticality: "High",
    features: ["Department and project channels", "Meetings", "Chat with the app's AI employees"],
    data: ["Messages and decisions in channels"],
    itContact: ["emre.koc"],
    partOf: "microsoft-365",
  },
  {
    key: "slack",
    name: "Slack",
    summary: "Chat of the Hamburg sales office (since the 2022 acquisition), until it moves to Teams.",
    category: "Collaboration",
    vendor: "Slack Pro",
    hosting: "SaaS",
    location: "Slack cloud (EU)",
    users: 9,
    criticality: "Medium",
    status: "Being replaced",
    features: ["Channels of the Hamburg office: #export-emea, #nordwind-npi, #hamburg-office"],
    owner: "thomas.weber",
    itContact: ["emre.koc"],
    usedBy: [["sales", "Hamburg office chat"]],
  },
  {
    key: "sharepoint-online",
    name: "SharePoint Online",
    aliases: ["SharePoint"],
    summary: "Department sites for documents, procedures and project folders.",
    category: "Documents",
    vendor: "Microsoft 365",
    hosting: "SaaS",
    location: "Microsoft cloud, EU Data Boundary",
    criticality: "High",
    features: ["Department sites", "Document versions and approvals", "Sharing with customers (projects)"],
    itContact: ["emre.koc"],
    partOf: "microsoft-365",
  },
  {
    key: "entra-id",
    name: "Microsoft Entra ID",
    aliases: ["Azure AD", "Entra"],
    summary: "Everyone's company account: sign-in, single sign-on to other systems and multi-factor sign-in.",
    category: "Identity & security",
    vendor: "Microsoft Entra ID P1",
    hosting: "SaaS",
    location: "Microsoft cloud",
    criticality: "Critical",
    features: ["User accounts and groups", "Single sign-on to SAP, Salesforce, SuccessFactors and Jira", "Multi-factor sign-in"],
    owner: "mehmet.oz",
    itContact: ["emre.koc"],
    partOf: "microsoft-365",
  },
  {
    key: "successfactors",
    name: "SAP SuccessFactors",
    aliases: ["SuccessFactors", "SF"],
    summary: "The HR system: employees and the org chart, recruiting, onboarding and time off.",
    category: "HR",
    vendor: "SAP SuccessFactors Employee Central and Recruiting",
    hosting: "SaaS",
    location: "SAP data center, Frankfurt",
    users: 180,
    criticality: "High",
    signIn: "Microsoft Entra ID single sign-on",
    features: ["Employee records and the org chart", "Recruiting and job postings", "Onboarding", "Time off"],
    data: ["Employees", "Positions", "Open positions", "Candidates", "Leave"],
    apis: [
      {
        name: "OData API",
        style: "OData v2",
        url: "https://api12preview.sapsf.eu/odata/v2",
        auth: "OAuth 2.0 (SAML bearer)",
        docs: "https://help.sap.com/docs/SAP_SUCCESSFACTORS_PLATFORM",
        endpoints: ["GET /User — employees", "GET /EmpJob — jobs and managers", "GET /JobRequisition — open positions", "GET /Candidate — candidates"],
      },
    ],
    connects: "hris",
    owner: "zeynep.demir",
    itContact: ["mehmet.oz"],
    usedBy: [["hr", "People, recruiting and leave"]],
  },
  {
    key: "logo-bordro",
    name: "Logo Bordro Plus",
    aliases: ["Logo Bordro", "payroll system"],
    summary: "Payroll: monthly salaries, payslips and SGK filings.",
    category: "HR",
    vendor: "Logo Bordro Plus 3",
    hosting: "On premises",
    location: "Gebze server room (VMware cluster)",
    users: 3,
    criticality: "High",
    features: ["Monthly payroll", "Payslips", "SGK filings"],
    data: ["Salaries", "Employees' bank accounts"],
    owner: "zeynep.demir",
    itContact: ["can.ozturk"],
    usedBy: [["hr", "Payroll"]],
    runsOn: "gebze-vmware",
    database: "payroll-db",
  },
  {
    key: "jira-software",
    name: "Jira",
    aliases: ["Jira Software"],
    summary: "Projects and their tasks: customer projects, product development and IT projects.",
    category: "Development",
    vendor: "Atlassian Jira Software Cloud",
    hosting: "SaaS",
    location: "Atlassian cloud (EU)",
    users: 45,
    criticality: "Medium",
    features: ["Projects, tasks and boards", "Roadmaps", "Who works on what"],
    data: ["Projects", "Tasks"],
    apis: [
      {
        name: "Jira REST API",
        style: "REST",
        url: "https://acme.atlassian.net/rest/api/3",
        auth: "API token of eb-bot@acme.com.tr",
        docs: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
        endpoints: [
          "GET /search?jql={JQL} — find tasks",
          "GET /issue/{key} — a task",
          "POST /issue — create a task",
          "POST /issue/{key}/transitions — move a task",
        ],
      },
    ],
    owner: "mehmet.oz",
    usedBy: [
      ["operations", "Customer projects"],
      ["it", "IT projects"],
    ],
  },
  {
    key: "jira-service-management",
    name: "Jira Service Management",
    aliases: ["JSM", "service desk"],
    summary: "The IT service desk: tickets, access requests and IT how-tos.",
    category: "Service desk",
    vendor: "Atlassian Jira Service Management Cloud",
    hosting: "SaaS",
    location: "Atlassian cloud (EU)",
    criticality: "Medium",
    features: ["IT tickets", "Access requests", "IT knowledge base"],
    data: ["IT tickets", "Access requests"],
    connects: "itsm",
    owner: "mehmet.oz",
    itContact: ["emre.koc"],
    usedBy: [["it", "Tickets"]],
  },
  {
    key: "opcenter-mes",
    name: "Opcenter MES",
    aliases: ["MES", "Opcenter"],
    summary: "Runs the shop floor in Gebze: work orders, operator confirmations, downtime and the pumps' test results.",
    category: "Manufacturing",
    vendor: "Siemens Opcenter Execution Discrete 2304",
    hosting: "On premises",
    location: "Gebze server room (VMware cluster)",
    url: "https://mes.acme.local",
    users: 40,
    criticality: "Critical",
    features: ["Work orders on the shop floor", "Operator confirmations", "Machine downtime", "Test results per pump serial number"],
    data: ["Work orders", "Serial numbers", "Test results", "Downtime"],
    apis: [
      {
        name: "MES REST API",
        style: "REST",
        url: "https://mes.acme.local/api/v2",
        auth: "API key, from the plant network only",
        docs: "https://mes.acme.local/api/docs",
        endpoints: [
          "GET /workorders?status=released — work orders",
          "GET /serials/{serial}/tests — test results of a pump",
          "POST /confirmations — confirm an operation",
        ],
      },
    ],
    owner: "okan.tekin",
    itContact: ["can.ozturk"],
    usedBy: [["operations", "Production and test results"]],
    runsOn: "gebze-vmware",
    database: "mes-db",
  },
  {
    key: "pumptest-pro",
    name: "PumpTest Pro",
    aliases: ["test bench software"],
    summary: "Software of the two pump test benches: measures every pump and prints its test certificate.",
    category: "Quality",
    vendor: "Hidrotest Mühendislik (custom software)",
    hosting: "On premises",
    location: "Test bench PCs TB1 and TB2, Gebze",
    users: 6,
    criticality: "High",
    features: ["Measures flow, head, power and vibration", "Prints the test certificate", "Sends results to MES"],
    data: ["Test curves", "Test certificates"],
    owner: "deniz.celik",
    usedBy: [["operations", "Final test"]],
  },
  {
    key: "power-bi",
    name: "Power BI",
    summary: "Dashboards and the monthly management report.",
    category: "BI & reporting",
    vendor: "Microsoft Power BI Pro",
    hosting: "SaaS",
    location: "Microsoft cloud, with a data gateway in Gebze",
    users: 25,
    criticality: "Medium",
    features: ["Management dashboard", "Sales and margin", "On-time delivery and quality dashboards"],
    owner: "hande.ozkan",
    usedBy: [
      ["management", "Management dashboard"],
      ["finance", "Monthly report"],
    ],
  },
  {
    key: "data-warehouse",
    name: "Data warehouse",
    aliases: ["DWH", "ACME_DWH"],
    summary: "Copies of SAP and MES data, cleaned and joined each night, that the Power BI reports read.",
    category: "BI & reporting",
    vendor: "Azure SQL Database, loaded by Azure Data Factory",
    hosting: "Public cloud",
    location: "Azure West Europe",
    users: 5,
    criticality: "High",
    features: ["Nightly copies of SAP and MES tables", "Facts and dimensions for reports", "One version of revenue, OEE and on-time delivery"],
    data: ["Sales", "Purchasing", "Production", "Quality", "General ledger"],
    owner: "hande.ozkan",
    itContact: ["can.ozturk"],
    usedBy: [["finance", "Reports and the monthly close"]],
    runsOn: "azure-acme-prod",
    database: "dwh",
  },
  {
    key: "uyumsoft-e-fatura",
    name: "Uyumsoft e-Fatura",
    aliases: ["Uyumsoft", "e-Fatura portal"],
    summary: "Sends and receives e-invoices (e-Fatura, e-Arşiv) through the tax authority (GİB).",
    category: "Finance",
    vendor: "Uyumsoft (GİB-licensed integrator)",
    hosting: "SaaS",
    location: "Uyumsoft data center, Türkiye",
    users: 5,
    criticality: "High",
    features: ["Sends e-invoices and e-archive invoices", "Receives suppliers' e-invoices", "Keeps them 10 years"],
    data: ["E-invoices sent and received"],
    apis: [
      {
        name: "Integration web service",
        style: "SOAP",
        url: "https://efatura.uyumsoft.com.tr/Services/Integration",
        auth: "Username and password from the integrator contract",
        docs: "",
        endpoints: ["GetInboxInvoices — new incoming e-invoices", "SendInvoice — send an e-invoice"],
      },
    ],
    owner: "burak.sahin",
    usedBy: [["finance", "E-invoices"]],
  },
  {
    key: "customer-portal",
    name: "Customer portal",
    aliases: ["portal"],
    summary: "Where customers follow their orders and download test certificates and delivery documents.",
    category: "Website & portal",
    vendor: "Built in-house (.NET 8 on Azure App Service)",
    hosting: "Public cloud",
    location: "Azure West Europe",
    url: "https://portal.acme.com.tr",
    users: 310,
    criticality: "Medium",
    features: ["Order status for customers", "Test certificates and delivery notes to download", "Spare parts catalog and quotes"],
    data: ["Customers' orders", "Documents shared with customers"],
    apis: [
      {
        name: "Portal API",
        style: "REST",
        url: "https://portal.acme.com.tr/api",
        auth: "API key for internal systems; Azure AD B2C sign-in for customers",
        docs: "https://portal.acme.com.tr/api/swagger",
        endpoints: [
          "GET /orders/{number} — order status",
          "GET /orders/{number}/documents — certificates and delivery notes",
          "POST /spare-parts/quotes — ask for a spare parts quote",
        ],
      },
    ],
    owner: "zeynep.kaya",
    itContact: ["ozan.kurt"],
    usedBy: [["customer-service", "Order status for customers"]],
    runsOn: "azure-acme-prod",
    database: "portal-db",
  },
  {
    key: "price-calculator",
    name: "Price calculator (Excel)",
    aliases: ["price calculator"],
    summary: "An Excel workbook with macros that prices pumps from material costs, margins and customer discounts.",
    category: "Other",
    vendor: "Excel workbook, built by the sales team",
    hosting: "SaaS",
    location: "SharePoint › Sales",
    users: 4,
    criticality: "High",
    features: ["Pump prices from material costs and margins", "Discounts by customer group"],
    owner: "thomas.weber",
    usedBy: [["sales", "Quotations"]],
  },
];

const DATABASES: {
  key: string;
  name: string;
  system: string;
  summary: string;
  data: Record<string, unknown>;
  runsOn: string;
  contact: string;
}[] = [
  {
    key: "s4p-hana",
    name: "S4P (SAP HANA)",
    system: "sap-s4hana",
    summary: "The SAP S/4HANA production database.",
    runsOn: "gebze-vmware",
    contact: "can.ozturk",
    data: {
      engine: "SAP HANA 2.0 SPS07",
      connectable: "No",
      host: "saphana01.acme.local",
      port: 30015,
      database: "S4P",
      access: "No direct access: SAP's licence allows reading through the OData services only.",
      personal_data: "Some",
      size: "1.2 TB",
    },
  },
  {
    key: "mes-db",
    name: "MES_PROD (SQL Server)",
    system: "opcenter-mes",
    summary: "The MES database: work orders, operations, test results and downtime. A good source for questions about production and quality.",
    runsOn: "gebze-vmware",
    contact: "can.ozturk",
    data: {
      engine: "Microsoft SQL Server 2019",
      connectable: "Read-only",
      host: "gbz-sql01.acme.local",
      port: 1433,
      database: "MES_PROD",
      access: "Read-only login eb_reader, from the plant network or the Azure VPN. Ask Can Öztürk for the password.",
      personal_data: "Some",
      size: "180 GB",
    },
  },
  {
    key: "portal-db",
    name: "PORTAL (Azure SQL)",
    system: "customer-portal",
    summary: "The customer portal's database: customers, their orders' status and shared documents.",
    runsOn: "azure-acme-prod",
    contact: "ozan.kurt",
    data: {
      engine: "Azure SQL Database",
      connectable: "Read-only",
      host: "acme-portal.database.windows.net",
      port: 1433,
      database: "PORTAL",
      access: "Entra ID managed identity; Ozan Kurt can give the read-only role eb_reader.",
      personal_data: "Some",
      size: "6 GB",
    },
  },
  {
    key: "dwh",
    name: "ACME_DWH (Azure SQL)",
    system: "data-warehouse",
    summary: "The data warehouse Power BI reads: facts and dimensions copied each night from SAP and the MES. The best place for questions about numbers.",
    runsOn: "azure-acme-prod",
    contact: "can.ozturk",
    data: {
      engine: "Azure SQL Database (General Purpose, 8 vCores)",
      connectable: "Read-only",
      host: "acme-dwh.database.windows.net",
      port: 1433,
      database: "ACME_DWH",
      access: "Entra ID; Can Öztürk gives the read-only role eb_reader.",
      personal_data: "Some",
      size: "240 GB",
    },
  },
  {
    key: "payroll-db",
    name: "BORDRO (SQL Server)",
    system: "logo-bordro",
    summary: "Logo Bordro's database. Salaries and personal data: no one connects to it but the payroll team.",
    runsOn: "gebze-vmware",
    contact: "can.ozturk",
    data: {
      engine: "Microsoft SQL Server 2017",
      connectable: "No",
      host: "gbz-sql02.acme.local",
      port: 1433,
      database: "BORDRO",
      access: "Never for AI employees: salaries and personal data. Payroll questions go to Gizem Polat.",
      personal_data: "Sensitive",
    },
  },
];

const STORES: {
  key: string;
  name: string;
  summary: string;
  type: string;
  location: string;
  contents: string[];
  access: string;
  retention?: string;
  owner: string;
  partOf: string;
  usedBy?: string;
}[] = [
  {
    key: "sharepoint-quality",
    name: "SharePoint › Quality",
    summary: "Quality's documents.",
    type: "SharePoint site",
    location: "https://acme.sharepoint.com/sites/Quality",
    contents: ["8D reports", "Control plans", "Audit reports", "Calibration certificates", "Quality procedures"],
    access: "Operations and Quality; Customer Service can read",
    retention: "10 years",
    owner: "selin.acar",
    partOf: "sharepoint-online",
    usedBy: "operations",
  },
  {
    key: "sharepoint-finance",
    name: "SharePoint › Finance",
    summary: "Finance's procedures, checklists and audit files.",
    type: "SharePoint site",
    location: "https://acme.sharepoint.com/sites/Finance",
    contents: ["Procedures and the approval matrix", "Month-end close checklists", "Hande's consolidation notes", "Audit files"],
    access: "Finance only",
    retention: "10 years (VUK)",
    owner: "burak.sahin",
    partOf: "sharepoint-online",
    usedBy: "finance",
  },
  {
    key: "sharepoint-hr",
    name: "SharePoint › HR",
    summary: "HR policies and forms.",
    type: "SharePoint site",
    location: "https://acme.sharepoint.com/sites/HR",
    contents: ["HR policies and the employee handbook", "Onboarding checklists", "Org charts"],
    access: "HR; policies readable by everyone",
    owner: "ayse.yilmaz",
    partOf: "sharepoint-online",
    usedBy: "hr",
  },
  {
    key: "sharepoint-sales",
    name: "SharePoint › Sales",
    summary: "Price lists, the price calculator and offer templates.",
    type: "SharePoint site",
    location: "https://acme.sharepoint.com/sites/Sales",
    contents: ["Price lists", "Price calculator (Excel)", "Offer templates", "Delivery note templates in German"],
    access: "Sales and Customer Service",
    owner: "thomas.weber",
    partOf: "sharepoint-online",
    usedBy: "sales",
  },
  {
    key: "sharepoint-projects",
    name: "SharePoint › Projects",
    summary: "A folder per customer project: offers, drawings, FAT reports.",
    type: "SharePoint site",
    location: "https://acme.sharepoint.com/sites/Projects",
    contents: ["Customer project folders: offers, drawings, FAT reports", "Internal project plans"],
    access: "Project teams",
    owner: "okan.tekin",
    partOf: "sharepoint-online",
    usedBy: "operations",
  },
  {
    key: "engineering-share",
    name: "Engineering file share",
    summary: "Drawings and old test reports on the Gebze file server.",
    type: "File share",
    location: "\\\\gbz-fs01\\Engineering",
    contents: ["Pump drawings (PDF)", "Test reports before 2024 (not in MES)", "Work instructions"],
    access: "Operations and Quality, from the plant network",
    owner: "deniz.celik",
    partOf: "",
    usedBy: "operations",
  },
  {
    key: "e-archive",
    name: "e-Archive (Uyumsoft)",
    summary: "Every e-invoice sent and received, kept by the integrator.",
    type: "Archive",
    location: "Uyumsoft portal",
    contents: ["Issued and received e-invoices"],
    access: "Finance",
    retention: "10 years (VUK)",
    owner: "burak.sahin",
    partOf: "uyumsoft-e-fatura",
  },
];

const INFRASTRUCTURE: {
  key: string;
  name: string;
  summary: string;
  type: string;
  provider: string;
  region: string;
  details: string[];
  contacts: string[];
  site?: string;
}[] = [
  {
    key: "gebze-vmware",
    name: "Gebze server room (VMware cluster)",
    summary: "The company's own servers, in the Gebze plant.",
    type: "Server room",
    provider: "Own hardware: 3 Dell PowerEdge hosts, VMware vSphere 8",
    region: "Gebze plant",
    details: ["Runs SAP, MES, SQL Server, Logo Bordro and the file servers", "UPS for 30 minutes, generator backup", "Site-to-site VPN to Azure"],
    contacts: ["can.ozturk"],
    site: "gebze-plant",
  },
  {
    key: "azure-acme-prod",
    name: "Azure subscription Acme-Prod",
    summary: "The company's Azure cloud.",
    type: "Cloud subscription",
    provider: "Microsoft Azure",
    region: "West Europe (Netherlands)",
    details: [
      "Customer portal (App Service and Azure SQL)",
      "Data warehouse (Azure SQL and Data Factory)",
      "Backup copies (Blob storage)",
      "VPN gateway to Gebze",
    ],
    contacts: ["ozan.kurt", "mehmet.oz"],
  },
  {
    key: "company-network",
    name: "Company network (FortiGate SD-WAN)",
    summary: "Connects the Istanbul HQ, the Gebze plant, the Hamburg office and Azure.",
    type: "Network",
    provider: "Fortinet FortiGate",
    region: "Istanbul HQ, Gebze plant, Hamburg office",
    details: ["A firewall at each site", "Site-to-site VPN to Azure", "Guest Wi-Fi kept apart"],
    contacts: ["can.ozturk"],
  },
  {
    key: "backups",
    name: "Backups (Veeam)",
    summary: "Nightly backups of every server, with copies in Azure.",
    type: "Backup",
    provider: "Veeam Backup & Replication, Azure Blob storage",
    region: "Gebze plant and Azure West Europe",
    details: ["Nightly backups of all servers", "Copies kept in Azure for 30 days", "A restore test every quarter"],
    contacts: ["can.ozturk"],
    site: "gebze-plant",
  },
];

/** Data that flows between systems: [from, to, what]. */
const FLOWS: [string, string, string][] = [
  ["sap-s4hana", "uyumsoft-e-fatura", "Outgoing invoices (UBL-TR), as they are posted"],
  ["uyumsoft-e-fatura", "sap-s4hana", "Suppliers' e-invoices, by hand after a check"],
  ["sap-s4hana", "opcenter-mes", "Production orders, every 15 minutes"],
  ["opcenter-mes", "sap-s4hana", "Confirmations and goods receipts of finished pumps"],
  ["pumptest-pro", "opcenter-mes", "Test results per serial number"],
  ["sap-s4hana", "data-warehouse", "Sales, purchasing, quality and ledger tables, nightly at 02:00"],
  ["opcenter-mes", "data-warehouse", "Work orders, downtime and test results, nightly at 02:00"],
  ["data-warehouse", "power-bi", "Facts and dimensions for the reports, each morning"],
  ["sap-s4hana", "customer-portal", "Order status, every hour"],
  ["salesforce", "sap-s4hana", "Won deals, keyed into SAP by hand (no interface yet)"],
  ["successfactors", "logo-bordro", "Employee changes, monthly, by file"],
  ["entra-id", "salesforce", "Sign-in"],
];

const SANDBOX_NAMES: Record<string, string> = { erp: "demo ERP", crm: "demo CRM", hris: "demo HR system", itsm: "demo service desk" };

export const inventorySource: BrainSourceDefinition = {
  key: "inventory",
  name: "IT inventory (demo)",
  system: "ServiceNow CMDB",
  description:
    "Every system: what it does, who uses and owns it, where it runs, its APIs, its databases, where documents are kept, and the data flowing between systems.",
  brings: ["Systems and their APIs", "Databases", "Document stores", "Servers and cloud", "Data flows"],
  icon: "server",
  demo: true,
  priority: 50,
  async read({ companyId, deps, domain }) {
    const email = (local: string) => ({ kind: "person" as const, email: `${local}@${domain}` });
    const connections = await deps.connections(companyId).catch(() => []);
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    for (const system of SYSTEMS) {
      const connection = system.connects ? connections.find((c) => c.category === system.connects) : undefined;
      const access = !system.connects
        ? "Not connected for AI employees"
        : connection
          ? `Connected for AI employees as "${connection.name}"`
          : SANDBOX_NAMES[system.connects]
            ? `AI employees use the ${SANDBOX_NAMES[system.connects]} until IT connects ${system.name}`
            : "AI employees read it through the shared mailboxes";
      entities.push({
        kind: "system",
        ref: system.key,
        key: system.key,
        name: system.name,
        aliases: system.aliases,
        summary: system.summary,
        data: {
          category: system.category,
          vendor: system.vendor,
          hosting: system.hosting,
          location: system.location,
          url: system.url,
          status: system.status ?? "Live",
          features: system.features,
          data: system.data ?? [],
          users: system.users,
          criticality: system.criticality,
          sign_in: system.signIn,
          version: system.version,
          apis: system.apis ?? [],
          connection: access,
        },
      });
      const me = { kind: "system" as const, key: system.key };
      if (system.owner) links.push({ from: email(system.owner), relation: "owns", to: me });
      for (const contact of system.itContact ?? []) links.push({ from: email(contact), relation: "looks_after", to: me });
      for (const [department, why] of system.usedBy ?? []) links.push({ from: { kind: "department", key: department }, relation: "uses", to: me, detail: why });
      if (system.runsOn) links.push({ from: me, relation: "runs_on", to: { kind: "infrastructure", key: system.runsOn } });
      if (system.partOf) links.push({ from: me, relation: "part_of", to: { kind: "system", key: system.partOf } });
      if (system.database) links.push({ from: me, relation: "has_database", to: { kind: "database", key: system.database } });
    }
    for (const database of DATABASES) {
      entities.push({
        kind: "database",
        ref: database.key,
        key: database.key,
        name: database.name,
        summary: database.summary,
        // The tables are things of their own now (read from the database, described in the catalog):
        // an empty value takes back the table notes this source wrote before.
        data: { ...database.data, tables: null },
      });
      links.push({ from: { kind: "database", key: database.key }, relation: "runs_on", to: { kind: "infrastructure", key: database.runsOn } });
      links.push({ from: email(database.contact), relation: "looks_after", to: { kind: "database", key: database.key } });
    }
    for (const store of STORES) {
      entities.push({
        kind: "data_store",
        ref: store.key,
        key: store.key,
        name: store.name,
        summary: store.summary,
        data: { type: store.type, location: store.location, contents: store.contents, access: store.access, retention: store.retention },
      });
      const me = { kind: "data_store" as const, key: store.key };
      links.push({ from: email(store.owner), relation: "owns", to: me });
      if (store.partOf) links.push({ from: me, relation: "part_of", to: { kind: "system", key: store.partOf } });
      if (store.usedBy) links.push({ from: { kind: "department", key: store.usedBy }, relation: "uses", to: me });
      if (store.key === "engineering-share") {
        links.push({ from: me, relation: "runs_on", to: { kind: "infrastructure", key: "gebze-vmware" } });
        links.push({ from: me, relation: "located_at", to: { kind: "site", key: "gebze-plant" } });
      }
    }
    for (const item of INFRASTRUCTURE) {
      entities.push({
        kind: "infrastructure",
        ref: item.key,
        key: item.key,
        name: item.name,
        summary: item.summary,
        data: { type: item.type, provider: item.provider, region: item.region, details: item.details },
      });
      const me = { kind: "infrastructure" as const, key: item.key };
      for (const contact of item.contacts) links.push({ from: email(contact), relation: "looks_after", to: me });
      if (item.site) links.push({ from: me, relation: "located_at", to: { kind: "site", key: item.site } });
    }
    for (const [from, to, what] of FLOWS)
      links.push({ from: { kind: "system", key: from }, relation: "sends_to", to: { kind: "system", key: to }, detail: what });
    return { entities, links };
  },
};
