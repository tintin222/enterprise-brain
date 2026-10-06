import type { BrainDataColumn, BrainMeasure } from "@enterprise-brain/core";
import { schemaBatch, tableKey, type SchemaInput, type SchemaTableInput } from "../catalog.ts";
import type { SourceEntity, SourceLink } from "../types.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * The demo company's data: the tables of its databases (SAP, the MES, the customer portal and the
 * data warehouse Power BI reads), as the databases would describe them, and what a data catalog
 * (standing in for Microsoft Purview) knows about them in business words: what each table and
 * column means, who owns it, which processes use it, and where its data comes from. A few tables
 * are only in the databases, so reading a database brings tables the catalog doesn't know yet.
 */

/** A column: its name, type, keys ("PK", "FK:VBAK.VBELN"), business name, definition and more. */
type Col = [
  name: string,
  type: string,
  keys: string,
  business?: string,
  definition?: string,
  more?: { personal?: boolean; example?: string; comment?: string },
];

type How = "Reads" | "Writes" | "Reads and writes";

interface DemoTable {
  name: string;
  type?: "Table" | "View";
  rows?: number;
  /** The database's own comment. */
  comment?: string;
  columns: Col[];
  /** What the catalog knows; a table without it is only in the database. */
  doc?: {
    business: string;
    status: "Certified" | "Documented" | "Needs definitions";
    definition: string;
    refresh?: string;
    personal?: "None" | "Some" | "Sensitive";
    usage?: string;
    issues?: string[];
    owner?: string;
    usedBy?: [process: string, how: How][];
    /** Where its rows come from: other tables, as "database/TABLE". */
    from?: [table: string, how: string][];
    experts?: [person: string, level: "Expert" | "Can do it" | "Learning"][];
  };
}

interface DemoDatabase {
  key: string;
  schema: string;
  tables: DemoTable[];
}

const NIGHTLY = "Nightly copy at 02:00 (Azure Data Factory)";

const DATABASES: DemoDatabase[] = [
  {
    key: "s4p-hana",
    schema: "SAPHANADB",
    tables: [
      {
        name: "VBAK",
        rows: 182_400,
        comment: "Sales Document: Header Data",
        columns: [
          ["VBELN", "NVARCHAR(10)", "PK", "Sales order number", "The order's number in SAP, as printed on order confirmations.", { example: "0000412345" }],
          ["ERDAT", "NVARCHAR(8)", "", "Created on", "The day the order was entered (YYYYMMDD)."],
          ["AUART", "NVARCHAR(4)", "", "Order type", "TA standard order, AG quotation, RE return."],
          ["KUNNR", "NVARCHAR(10)", "FK:KNA1.KUNNR", "Customer", "The customer who ordered (sold-to party)."],
          ["NETWR", "DECIMAL(15,2)", "", "Net value", "Order value before VAT, in the order's currency."],
          ["WAERK", "NVARCHAR(5)", "", "Currency", "TRY, EUR or USD."],
          ["VKORG", "NVARCHAR(4)", "", "Sales organisation", "1000 Türkiye, 2000 export, 3000 Acme Pumpen GmbH."],
          ["VDATU", "NVARCHAR(8)", "", "Requested delivery date", "The date the customer asked for; on-time delivery is measured against it."],
        ],
        doc: {
          business: "Sales orders",
          status: "Documented",
          definition: "One row per sales order or quotation a customer placed: who ordered, when, and for how much.",
          refresh: "As orders are entered in SAP",
          personal: "None",
          usage:
            "Standard orders have AUART 'TA', quotations 'AG'. Join the lines in VBAP on VBELN. Amounts are in WAERK: convert to TRY with the month's rate before adding them up.",
          owner: "thomas.weber",
          usedBy: [
            ["order-to-delivery", "Reads"],
            ["sales.quote-preparation", "Writes"],
            ["finance.collections", "Reads"],
          ],
        },
      },
      {
        name: "VBAP",
        rows: 640_000,
        comment: "Sales Document: Item Data",
        columns: [
          ["VBELN", "NVARCHAR(10)", "PK FK:VBAK.VBELN", "Sales order number", "The order the line belongs to."],
          ["POSNR", "NVARCHAR(6)", "PK", "Line", "Line number within the order (10, 20, 30…)."],
          ["MATNR", "NVARCHAR(40)", "FK:MARA.MATNR", "Material", "The pump or spare part ordered.", { example: "FG-20001" }],
          ["KWMENG", "DECIMAL(15,3)", "", "Quantity", "How many were ordered."],
          ["NETWR", "DECIMAL(15,2)", "", "Line value", "Net value of the line, before VAT."],
          ["WERKS", "NVARCHAR(4)", "", "Plant", "1100 Gebze."],
        ],
        doc: {
          business: "Sales order lines",
          status: "Documented",
          definition: "One row per line of a sales order: the pump or part, how many, and the line's value.",
          refresh: "As orders are entered in SAP",
          personal: "None",
          owner: "thomas.weber",
          usedBy: [["order-to-delivery", "Reads"]],
        },
      },
      {
        name: "KNA1",
        rows: 4_850,
        comment: "General Data in Customer Master",
        columns: [
          [
            "KUNNR",
            "NVARCHAR(10)",
            "PK",
            "Customer number",
            "SAP's number for the customer; the CRM keeps it as the account's SAP number.",
            { example: "CUST-10045" },
          ],
          ["NAME1", "NVARCHAR(35)", "", "Name", "The customer's legal name."],
          ["LAND1", "NVARCHAR(3)", "", "Country", "ISO country code (TR, DE, AE…)."],
          ["ORT01", "NVARCHAR(35)", "", "City", ""],
          ["STCD1", "NVARCHAR(16)", "", "Tax number", "Turkish tax number (VKN), or the EU VAT id for customers abroad."],
          ["KTOKD", "NVARCHAR(4)", "", "Account group", "Domestic, export or one-time customer."],
        ],
        doc: {
          business: "Customers",
          status: "Documented",
          definition: "One row per customer company the company sells to.",
          refresh: "When sales or finance change a customer",
          personal: "Some",
          owner: "thomas.weber",
          usedBy: [
            ["sales.quote-preparation", "Reads"],
            ["operations.quality-incidents", "Reads"],
          ],
        },
      },
      {
        name: "LFA1",
        rows: 2_140,
        comment: "Vendor Master (General Section)",
        columns: [
          ["LIFNR", "NVARCHAR(10)", "PK", "Supplier number", "SAP's number for the supplier."],
          ["NAME1", "NVARCHAR(35)", "", "Name", "The supplier's legal name."],
          ["LAND1", "NVARCHAR(3)", "", "Country", ""],
          ["STCD1", "NVARCHAR(16)", "", "Tax number", "Turkish tax number (VKN)."],
          ["TELF1", "NVARCHAR(16)", "", "Phone", "Called to confirm changed bank details before paying.", { personal: true }],
          ["ZTERM", "NVARCHAR(4)", "", "Payment terms", "Days to pay, e.g. Z030 for 30 days."],
        ],
        doc: {
          business: "Suppliers",
          status: "Documented",
          definition: "One row per supplier the company buys from.",
          refresh: "When purchasing changes a supplier",
          personal: "Some",
          owner: "ayse.kaya",
          usedBy: [
            ["finance.accounts-payable", "Reads"],
            ["procurement.purchase-requisition", "Reads"],
          ],
        },
      },
      {
        name: "MARA",
        rows: 18_300,
        comment: "General Material Data",
        columns: [
          ["MATNR", "NVARCHAR(40)", "PK", "Material number", "", { example: "FG-20001" }],
          ["MTART", "NVARCHAR(4)", "", "Material type", "FERT finished pump, HALB semi-finished, ROH raw material, ERSA spare part."],
          ["MATKL", "NVARCHAR(9)", "", "Material group", "The product line of a pump (ACP, AV, PS)."],
          ["MEINS", "NVARCHAR(3)", "", "Unit", "PC pieces, KG kilograms."],
          ["BRGEW", "DECIMAL(13,3)", "", "Gross weight (kg)", "Used on shipping documents."],
        ],
        doc: {
          business: "Materials",
          status: "Documented",
          definition: "One row per material: finished pumps, their parts and raw materials.",
          personal: "None",
          owner: "okan.tekin",
          usedBy: [
            ["procurement.purchase-requisition", "Reads"],
            ["sales.quote-preparation", "Reads"],
          ],
        },
      },
      {
        name: "EKKO",
        rows: 96_000,
        comment: "Purchasing Document Header",
        columns: [
          ["EBELN", "NVARCHAR(10)", "PK", "Purchase order number", "", { example: "4500051234" }],
          ["LIFNR", "NVARCHAR(10)", "FK:LFA1.LIFNR", "Supplier", "Who the order went to."],
          ["BEDAT", "NVARCHAR(8)", "", "Order date", ""],
          ["BSART", "NVARCHAR(4)", "", "Order type", "NB standard order, FO framework order."],
          ["EKORG", "NVARCHAR(4)", "", "Purchasing organisation", ""],
          ["ZTERM", "NVARCHAR(4)", "", "Payment terms", "As agreed in this order."],
        ],
        doc: {
          business: "Purchase orders",
          status: "Documented",
          definition: "One row per purchase order sent to a supplier.",
          refresh: "As purchasing orders",
          personal: "None",
          owner: "ayse.kaya",
          usedBy: [
            ["procurement.purchase-requisition", "Writes"],
            ["finance.accounts-payable", "Reads"],
          ],
        },
      },
      {
        name: "EKPO",
        rows: 410_000,
        comment: "Purchasing Document Item",
        columns: [
          ["EBELN", "NVARCHAR(10)", "PK FK:EKKO.EBELN", "Purchase order number", ""],
          ["EBELP", "NVARCHAR(5)", "PK", "Line", ""],
          ["MATNR", "NVARCHAR(40)", "FK:MARA.MATNR", "Material", ""],
          ["MENGE", "DECIMAL(13,3)", "", "Ordered quantity", ""],
          ["NETPR", "DECIMAL(11,2)", "", "Net price", "Price per unit agreed with the supplier."],
          ["EINDT", "NVARCHAR(8)", "", "Delivery date", "The date the supplier promised; supplier on-time delivery is measured against it."],
        ],
        doc: {
          business: "Purchase order lines",
          status: "Documented",
          definition: "One row per line of a purchase order: what, how many, at what price, by when.",
          personal: "None",
          owner: "ayse.kaya",
          usedBy: [
            ["procurement.purchase-requisition", "Writes"],
            ["finance.accounts-payable", "Reads"],
          ],
        },
      },
      {
        name: "RBKP",
        rows: 88_000,
        comment: "Document Header: Invoice Receipt",
        columns: [
          ["BELNR", "NVARCHAR(10)", "PK", "Invoice document", "SAP's number for the posted invoice."],
          ["GJAHR", "NVARCHAR(4)", "PK", "Fiscal year", ""],
          ["LIFNR", "NVARCHAR(10)", "FK:LFA1.LIFNR", "Supplier", ""],
          ["XBLNR", "NVARCHAR(16)", "", "Supplier's invoice number", "The number printed on the supplier's invoice.", { example: "INV-2026-4117" }],
          ["BLDAT", "NVARCHAR(8)", "", "Invoice date", ""],
          ["RMWWR", "DECIMAL(13,2)", "", "Gross amount", "The invoice total with VAT."],
          ["RBSTAT", "NVARCHAR(1)", "", "Status", "5 posted, A parked, B blocked for payment."],
        ],
        doc: {
          business: "Supplier invoices",
          status: "Certified",
          definition: "One row per supplier invoice posted in SAP (logistics invoice verification).",
          refresh: "As invoices are posted",
          personal: "None",
          usage:
            "RBSTAT 5 is posted, A parked, B blocked for payment. XBLNR is the supplier's own invoice number: check it with LIFNR for duplicates before posting.",
          owner: "burak.sahin",
          usedBy: [["finance.accounts-payable", "Writes"]],
          experts: [
            ["burak.sahin", "Expert"],
            ["elif.arslan", "Can do it"],
          ],
        },
      },
      {
        name: "RSEG",
        rows: 260_000,
        comment: "Document Item: Incoming Invoice",
        columns: [
          ["BELNR", "NVARCHAR(10)", "PK FK:RBKP.BELNR", "Invoice document", ""],
          ["GJAHR", "NVARCHAR(4)", "PK FK:RBKP.GJAHR", "Fiscal year", ""],
          ["BUZEI", "NVARCHAR(6)", "PK", "Line", ""],
          ["EBELN", "NVARCHAR(10)", "FK:EKPO.EBELN", "Purchase order", "The order the line is invoiced against (the 3-way match)."],
          ["EBELP", "NVARCHAR(5)", "FK:EKPO.EBELP", "Purchase order line", ""],
          ["WRBTR", "DECIMAL(13,2)", "", "Amount", "Line amount in the invoice's currency."],
          ["MENGE", "DECIMAL(13,3)", "", "Quantity invoiced", ""],
        ],
        doc: {
          business: "Supplier invoice lines",
          status: "Documented",
          definition: "One row per line of a supplier invoice, matched to a purchase order line.",
          personal: "None",
          owner: "burak.sahin",
          usedBy: [["finance.accounts-payable", "Writes"]],
        },
      },
      {
        name: "QMEL",
        rows: 12_400,
        comment: "Quality Notification",
        columns: [
          ["QMNUM", "NVARCHAR(12)", "PK", "Notification number", ""],
          ["QMART", "NVARCHAR(2)", "", "Notification type", "Q1 customer complaint, Q2 supplier complaint, Q3 internal problem."],
          ["KUNUM", "NVARCHAR(10)", "FK:KNA1.KUNNR"],
          ["MATNR", "NVARCHAR(40)", "FK:MARA.MATNR"],
          ["QMTXT", "NVARCHAR(40)", ""],
          ["ERDAT", "NVARCHAR(8)", ""],
          ["PRIOK", "NVARCHAR(1)", ""],
        ],
        doc: {
          business: "Quality notifications",
          status: "Needs definitions",
          definition: "One row per quality notification: customer complaints, supplier complaints and internal problems.",
          personal: "None",
          owner: "selin.acar",
          usedBy: [["operations.quality-incidents", "Writes"]],
        },
      },
      {
        name: "ACDOCA",
        rows: 48_000_000,
        comment: "Universal Journal Entry Line Items",
        columns: [
          ["RLDNR", "NVARCHAR(2)", "PK", "Ledger", "0L is the leading ledger (TFRS)."],
          ["RBUKRS", "NVARCHAR(4)", "PK", "Company code", "1000 Acme Endüstri, 2000 Acme Pumpen GmbH."],
          ["GJAHR", "NVARCHAR(4)", "PK", "Fiscal year", ""],
          ["BELNR", "NVARCHAR(10)", "PK", "Document number", ""],
          ["DOCLN", "NVARCHAR(6)", "PK", "Line", ""],
          ["RACCT", "NVARCHAR(10)", "", "G/L account", "An account of the chart of accounts (TDHP)."],
          ["HSL", "DECIMAL(23,2)", "", "Amount in TRY", "The amount in the company code's currency."],
          ["PRCTR", "NVARCHAR(10)", "", "Profit centre", ""],
          ["BUDAT", "NVARCHAR(8)", "", "Posting date", ""],
        ],
        doc: {
          business: "General ledger postings",
          status: "Documented",
          definition: "One row per line of every accounting document: finance's single source of truth.",
          refresh: "As documents are posted",
          personal: "None",
          usage: "Always filter RLDNR = '0L' and a fiscal year and period: the table is very large.",
          owner: "elif.yilmaz",
          usedBy: [
            ["finance.month-end-close", "Reads and writes"],
            ["consolidation-reporting", "Reads"],
          ],
        },
      },
      {
        name: "AFKO",
        rows: 54_000,
        comment: "Order header data PP orders",
        columns: [
          ["AUFNR", "NVARCHAR(12)", "PK"],
          ["PLNBEZ", "NVARCHAR(40)", "FK:MARA.MATNR"],
          ["GAMNG", "DECIMAL(13,3)", ""],
          ["GSTRP", "NVARCHAR(8)", ""],
          ["GLTRP", "NVARCHAR(8)", ""],
        ],
      },
      {
        name: "MARD",
        rows: 52_000,
        comment: "Storage Location Data for Material",
        columns: [
          ["MATNR", "NVARCHAR(40)", "PK FK:MARA.MATNR"],
          ["WERKS", "NVARCHAR(4)", "PK"],
          ["LGORT", "NVARCHAR(4)", "PK"],
          ["LABST", "DECIMAL(13,3)", ""],
        ],
      },
    ],
  },
  {
    key: "mes-db",
    schema: "dbo",
    tables: [
      {
        name: "work_orders",
        rows: 54_200,
        columns: [
          ["wo_id", "int", "PK", "Work order id", "The MES's own number."],
          ["sap_order", "varchar(12)", "", "SAP production order", "The production order in SAP (AFKO.AUFNR).", { example: "1000045213" }],
          ["material", "varchar(18)", "", "Material", "What is made, e.g. FG-20001 (ACP-80)."],
          ["quantity", "int", "", "Quantity", "Pumps to make."],
          ["status", "varchar(12)", "", "Status", "released, running or done."],
          ["line_id", "int", "FK:lines.line_id", "Assembly line", ""],
          ["planned_start", "datetime2", "", "Planned start", ""],
          ["planned_end", "datetime2", "", "Planned end", ""],
        ],
        doc: {
          business: "Work orders",
          status: "Certified",
          definition: "One row per production order on the shop floor, as released from SAP.",
          refresh: "Every 15 minutes from SAP; the status as the shop floor works",
          personal: "None",
          usage: "One work order per SAP production order (sap_order). Status goes released → running → done. Join operations on wo_id for who did what, when.",
          owner: "okan.tekin",
          usedBy: [
            ["order-to-delivery", "Reads"],
            ["pump-final-test", "Reads"],
          ],
          experts: [["deniz.celik", "Expert"]],
        },
      },
      {
        name: "operations",
        rows: 412_000,
        columns: [
          ["op_id", "int", "PK", "Operation id", ""],
          ["wo_id", "int", "FK:work_orders.wo_id", "Work order", ""],
          ["step", "varchar(40)", "", "Step", "machining, assembly, test or packing."],
          ["workstation", "varchar(20)", "", "Workstation", "Where it was done, e.g. ASM-2 or TB1."],
          ["operator", "varchar(60)", "", "Operator", "Who confirmed it.", { personal: true }],
          ["started_at", "datetime2", "", "Started", ""],
          ["finished_at", "datetime2", "", "Finished", ""],
          ["good_qty", "int", "", "Good", "Pieces that passed this step."],
          ["scrap_qty", "int", "", "Scrap", "Pieces scrapped at this step."],
        ],
        doc: {
          business: "Shop-floor operations",
          status: "Documented",
          definition: "One row per step of a work order on the shop floor: where, who, when, and how many good and scrapped.",
          refresh: "As operators confirm steps",
          personal: "Some",
          owner: "okan.tekin",
          usedBy: [["order-to-delivery", "Reads"]],
        },
      },
      {
        name: "test_results",
        rows: 61_800,
        columns: [
          ["test_id", "bigint", "PK", "Test id", ""],
          ["serial_no", "varchar(20)", "", "Serial number", "The pump's serial number.", { example: "ACP80-26-1187" }],
          ["wo_id", "int", "FK:work_orders.wo_id", "Work order", ""],
          ["bench_id", "varchar(10)", "", "Test bench", "TB1 or TB2."],
          ["flow_m3h", "decimal(8,2)", "", "Flow (m³/h)", ""],
          ["head_m", "decimal(8,2)", "", "Head (m)", ""],
          ["vibration_mm_s", "decimal(6,2)", "", "Vibration (mm/s)", "Above 4.5 fails (ISO 10816)."],
          ["attempt", "tinyint", "", "Attempt", "1 for a pump's first test, 2 for its first retest, and so on."],
          ["passed", "bit", "", "Passed", "1 when the pump passed."],
          ["tested_at", "datetime2", "", "Tested at", ""],
        ],
        doc: {
          business: "Pump test results",
          status: "Certified",
          definition: "One row per final test of a pump, from PumpTest Pro.",
          refresh: "As each pump is tested",
          personal: "None",
          usage: "A pump tested twice has two rows: take the latest by tested_at. vibration_mm_s above 4.5 fails (ISO 10816).",
          owner: "selin.acar",
          usedBy: [
            ["pump-final-test", "Writes"],
            ["operations.quality-incidents", "Reads"],
          ],
          experts: [
            ["kerem.yildiz", "Expert"],
            ["merve.aksoy", "Can do it"],
          ],
        },
      },
      {
        name: "machine_downtime",
        rows: 9_600,
        columns: [
          ["event_id", "int", "PK", "Downtime id", ""],
          ["workstation", "varchar(20)", "", "Workstation", "The machine or station that stood still."],
          ["reason_code", "varchar(8)", "FK:downtime_reasons.reason_code", "Reason", ""],
          ["started_at", "datetime2", "", "Since", ""],
          ["minutes", "int", "", "Minutes", "How long it stood still."],
          ["shift", "char(1)", "", "Shift", "A, B or C."],
        ],
        doc: {
          business: "Machine downtime",
          status: "Documented",
          definition: "One row per time a machine stood still, with why and how long.",
          refresh: "As operators log stops",
          personal: "None",
          owner: "okan.tekin",
          usedBy: [["preventive-maintenance", "Reads and writes"]],
          experts: [["hakan.erdogan", "Expert"]],
        },
      },
      {
        name: "downtime_reasons",
        rows: 42,
        columns: [
          ["reason_code", "varchar(8)", "PK", "Reason code", "", { example: "MECH-03" }],
          ["description", "nvarchar(120)", "", "Reason", ""],
          ["category", "varchar(20)", "", "Category", "Planned, breakdown, material, quality or changeover."],
        ],
        doc: {
          business: "Downtime reasons",
          status: "Documented",
          definition: "The list of reasons a machine can stand still for.",
          personal: "None",
          owner: "okan.tekin",
          usedBy: [["preventive-maintenance", "Reads"]],
        },
      },
      {
        name: "lines",
        rows: 4,
        columns: [
          ["line_id", "int", "PK", "Line id", ""],
          ["name", "varchar(40)", "", "Line", "ACP line, AV line, PS line, skid assembly."],
          ["plant", "varchar(4)", "", "Plant", "1100 Gebze."],
        ],
        doc: {
          business: "Assembly lines",
          status: "Documented",
          definition: "The assembly lines of the Gebze plant.",
          personal: "None",
          owner: "okan.tekin",
        },
      },
      {
        name: "shift_log",
        rows: 31_000,
        columns: [
          ["shift_id", "int", "PK"],
          ["line_id", "int", "FK:lines.line_id"],
          ["shift", "char(1)", ""],
          ["supervisor", "varchar(60)", ""],
          ["notes", "nvarchar(max)", ""],
        ],
      },
      {
        name: "v_oee_daily",
        type: "View",
        columns: [
          ["line_id", "int", ""],
          ["day", "date", ""],
          ["availability", "decimal(5,2)", ""],
          ["performance", "decimal(5,2)", ""],
          ["quality", "decimal(5,2)", ""],
          ["oee", "decimal(5,2)", ""],
        ],
      },
    ],
  },
  {
    key: "portal-db",
    schema: "dbo",
    tables: [
      {
        name: "customers",
        rows: 410,
        columns: [
          ["customer_id", "int", "PK", "Portal customer id", ""],
          ["sap_customer", "varchar(10)", "", "SAP customer number", "The customer in SAP (KNA1.KUNNR)."],
          ["name", "nvarchar(120)", "", "Name", ""],
          ["country", "char(2)", "", "Country", ""],
          ["created_at", "datetime2", "", "Joined the portal", ""],
        ],
        doc: {
          business: "Portal customers",
          status: "Documented",
          definition: "One row per customer company that can sign in to the customer portal.",
          personal: "None",
          owner: "zeynep.kaya",
        },
      },
      {
        name: "orders",
        rows: 21_400,
        columns: [
          ["order_number", "varchar(12)", "PK", "Order number", "The SAP sales order number (VBAK.VBELN)."],
          ["customer_id", "int", "FK:customers.customer_id", "Customer", ""],
          ["status", "varchar(20)", "", "Status", "confirmed, in production, tested, shipped."],
          ["promised_date", "date", "", "Promised date", "The delivery date promised to the customer."],
          ["tracking_no", "varchar(40)", "", "Tracking number", "The carrier's tracking number once shipped."],
          ["updated_at", "datetime2", "", "Last updated", ""],
        ],
        doc: {
          business: "Orders as customers see them",
          status: "Documented",
          definition: "One row per order a customer can follow in the portal, with its status and promised date.",
          refresh: "Every hour from SAP",
          personal: "None",
          owner: "zeynep.kaya",
          usedBy: [
            ["customer-service.email-triage", "Reads"],
            ["order-to-delivery", "Writes"],
          ],
        },
      },
      {
        name: "documents",
        rows: 64_000,
        columns: [
          ["doc_id", "int", "PK", "Document id", ""],
          ["order_number", "varchar(12)", "FK:orders.order_number", "Order", ""],
          ["type", "varchar(20)", "", "Type", "certificate, delivery note or invoice."],
          ["file_url", "nvarchar(400)", "", "File", "Where the file is kept."],
          ["shared_at", "datetime2", "", "Shared", ""],
        ],
        doc: {
          business: "Documents shared with customers",
          status: "Documented",
          definition: "One row per document shared with a customer: test certificates, delivery notes and invoices.",
          personal: "None",
          owner: "zeynep.kaya",
          usedBy: [["operations.delivery-documents", "Writes"]],
        },
      },
      {
        name: "users",
        rows: 1_180,
        columns: [
          ["user_id", "int", "PK"],
          ["customer_id", "int", "FK:customers.customer_id"],
          ["email", "nvarchar(200)", "", "", "", { personal: true }],
          ["full_name", "nvarchar(120)", "", "", "", { personal: true }],
          ["last_login", "datetime2", ""],
        ],
        doc: {
          business: "Portal users",
          status: "Needs definitions",
          definition: "One row per person at a customer who can sign in to the portal.",
          personal: "Some",
          owner: "ozan.kurt",
        },
      },
      {
        name: "support_requests",
        rows: 3_900,
        columns: [
          ["request_id", "int", "PK"],
          ["customer_id", "int", "FK:customers.customer_id"],
          ["user_id", "int", "FK:users.user_id"],
          ["subject", "nvarchar(200)", ""],
          ["status", "varchar(20)", ""],
          ["created_at", "datetime2", ""],
        ],
      },
      {
        name: "login_audit",
        rows: 210_000,
        columns: [
          ["id", "bigint", "PK"],
          ["user_id", "int", "FK:users.user_id"],
          ["ip", "varchar(45)", ""],
          ["at", "datetime2", ""],
        ],
      },
    ],
  },
  {
    key: "dwh",
    schema: "dw",
    tables: [
      {
        name: "dim_date",
        rows: 7_305,
        columns: [
          ["date_key", "int", "PK", "Date key", "The date as a number.", { example: "20261006" }],
          ["date", "date", "", "Date", ""],
          ["year", "smallint", "", "Year", ""],
          ["quarter", "tinyint", "", "Quarter", ""],
          ["month", "tinyint", "", "Month", ""],
          ["month_name", "varchar(10)", "", "Month name", ""],
          ["week", "tinyint", "", "ISO week", ""],
          ["is_workday", "bit", "", "Working day", "Turkish public holidays are not working days."],
        ],
        doc: {
          business: "Calendar",
          status: "Certified",
          definition: "One row per day from 2010 to 2029, with the calendar's levels for reports.",
          personal: "None",
          owner: "can.ozturk",
        },
      },
      {
        name: "dim_customer",
        rows: 4_850,
        columns: [
          ["customer_key", "int", "PK", "Customer key", ""],
          ["sap_customer", "varchar(10)", "", "SAP customer number", ""],
          ["name", "nvarchar(120)", "", "Customer", ""],
          ["country", "char(2)", "", "Country", ""],
          ["region", "varchar(20)", "", "Region", "Türkiye, Europe, Middle East or Africa."],
          ["segment", "varchar(20)", "", "Segment", "End user, EPC contractor, distributor or OEM."],
          ["industry", "varchar(40)", "", "Industry", ""],
        ],
        doc: {
          business: "Customers for reports",
          status: "Certified",
          definition: "One row per customer, with the region and segment reports slice by.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "can.ozturk",
          from: [["s4p-hana/KNA1", NIGHTLY]],
        },
      },
      {
        name: "dim_product",
        rows: 18_300,
        columns: [
          ["product_key", "int", "PK", "Product key", ""],
          ["material", "varchar(18)", "", "Material", ""],
          ["product_line", "varchar(10)", "", "Product line", "ACP, AV or PS."],
          ["model", "varchar(20)", "", "Model", "ACP-80, AV-50…"],
          ["family", "varchar(30)", "", "Family", "Pumps, valves, skids or spare parts."],
        ],
        doc: {
          business: "Products for reports",
          status: "Certified",
          definition: "One row per material, with the product line and model reports slice by.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "can.ozturk",
          from: [["s4p-hana/MARA", NIGHTLY]],
        },
      },
      {
        name: "dim_supplier",
        rows: 2_140,
        columns: [
          ["supplier_key", "int", "PK", "Supplier key", ""],
          ["sap_supplier", "varchar(10)", "", "SAP supplier number", ""],
          ["name", "nvarchar(120)", "", "Supplier", ""],
          ["country", "char(2)", "", "Country", ""],
          ["category", "varchar(30)", "", "Category", "Castings, motors, seals, electronics or services."],
        ],
        doc: {
          business: "Suppliers for reports",
          status: "Certified",
          definition: "One row per supplier, with the category reports slice by.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "can.ozturk",
          from: [["s4p-hana/LFA1", NIGHTLY]],
        },
      },
      {
        name: "fact_sales",
        rows: 640_000,
        columns: [
          ["sales_key", "bigint", "PK", "Sales key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Order date", ""],
          ["customer_key", "int", "FK:dim_customer.customer_key", "Customer", ""],
          ["product_key", "int", "FK:dim_product.product_key", "Product", ""],
          ["order_no", "varchar(10)", "", "Sales order number", ""],
          ["quantity", "int", "", "Quantity", ""],
          ["net_revenue_try", "decimal(18,2)", "", "Net revenue (TRY)", "The line's value before VAT, in TRY at the month's average rate."],
          ["net_revenue_eur", "decimal(18,2)", "", "Net revenue (EUR)", ""],
          ["margin_try", "decimal(18,2)", "", "Gross margin (TRY)", "Net revenue minus the standard cost."],
          ["confirmed_date", "date", "", "Confirmed delivery date", "The date confirmed to the customer; on-time delivery is measured against it."],
          ["on_time", "bit", "", "Shipped on time", "1 when the line shipped by the confirmed date, 0 when later, empty until it ships."],
        ],
        doc: {
          business: "Sales for reports",
          status: "Certified",
          definition: "One row per sales order line, in TRY and EUR, ready for reports.",
          refresh: "Nightly at 02:00",
          personal: "None",
          usage: "Use net_revenue_try for totals across currencies; it is converted at the month's average rate.",
          owner: "thomas.weber",
          from: [
            ["s4p-hana/VBAK", NIGHTLY],
            ["s4p-hana/VBAP", NIGHTLY],
          ],
        },
      },
      {
        name: "fact_purchasing",
        rows: 410_000,
        columns: [
          ["po_line_key", "bigint", "PK", "Purchase order line key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Order date", ""],
          ["supplier_key", "int", "FK:dim_supplier.supplier_key", "Supplier", ""],
          ["product_key", "int", "FK:dim_product.product_key", "Material", ""],
          ["ordered_qty", "decimal(13,3)", "", "Ordered", ""],
          ["delivered_qty", "decimal(13,3)", "", "Delivered", ""],
          ["on_time", "bit", "", "On time", "1 when delivered by the date the supplier promised (EKPO.EINDT)."],
          ["price_variance_try", "decimal(18,2)", "", "Price variance (TRY)", "The invoiced price minus the order price, times the quantity."],
        ],
        doc: {
          business: "Purchasing for reports",
          status: "Certified",
          definition: "One row per purchase order line, with what arrived when and at what price.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "ayse.kaya",
          from: [
            ["s4p-hana/EKKO", NIGHTLY],
            ["s4p-hana/EKPO", NIGHTLY],
          ],
        },
      },
      {
        name: "fact_production",
        rows: 54_200,
        columns: [
          ["prod_key", "bigint", "PK", "Production key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Day", ""],
          ["line_id", "int", "", "Assembly line", ""],
          ["product_key", "int", "FK:dim_product.product_key", "Product", ""],
          ["planned_qty", "int", "", "Planned", ""],
          ["good_qty", "int", "", "Good", ""],
          ["scrap_qty", "int", "", "Scrap", ""],
          ["downtime_min", "int", "", "Downtime (minutes)", ""],
          ["oee", "decimal(5,2)", "", "OEE (%)", "Availability × performance × quality, per work order."],
        ],
        doc: {
          business: "Production for reports",
          status: "Certified",
          definition: "One row per work order and day, with good and scrapped pieces, downtime and OEE.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "okan.tekin",
          from: [
            ["mes-db/work_orders", NIGHTLY],
            ["mes-db/operations", NIGHTLY],
            ["mes-db/machine_downtime", NIGHTLY],
          ],
        },
      },
      {
        name: "fact_quality",
        rows: 12_400,
        columns: [
          ["quality_key", "bigint", "PK", "Quality key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Day", ""],
          ["customer_key", "int", "FK:dim_customer.customer_key", "Customer", ""],
          ["product_key", "int", "FK:dim_product.product_key", "Product", ""],
          ["complaints", "int", "", "Customer complaints", ""],
          ["ppm", "int", "", "PPM", "Defective parts per million delivered."],
          ["open_8d", "int", "", "Open 8Ds", ""],
          ["days_to_close", "int", "", "Days to close", "From the complaint to its 8D's closure."],
        ],
        doc: {
          business: "Quality for reports",
          status: "Certified",
          definition: "One row per customer, product and day with complaints, PPM and 8D progress.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "selin.acar",
          from: [
            ["s4p-hana/QMEL", NIGHTLY],
            ["mes-db/test_results", NIGHTLY],
          ],
        },
      },
      {
        name: "fact_ap_invoices",
        rows: 88_000,
        columns: [
          ["invoice_key", "bigint", "PK", "Invoice key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Invoice date", ""],
          ["supplier_key", "int", "FK:dim_supplier.supplier_key", "Supplier", ""],
          ["amount_try", "decimal(18,2)", "", "Amount (TRY)", ""],
          ["due_date", "date", "", "Due date", ""],
          ["paid_date", "date", "", "Paid on", ""],
          ["days_overdue", "int", "", "Days overdue", "0 when paid on time or not yet due."],
          ["blocked", "bit", "", "Blocked for payment", ""],
          ["days_to_post", "int", "", "Days to post", "From the invoice's receipt to its posting in SAP. Empty before March 2026."],
        ],
        doc: {
          business: "Supplier invoices for reports",
          status: "Certified",
          definition: "One row per supplier invoice, with its due date, payment and days overdue.",
          refresh: "Nightly at 02:00",
          personal: "None",
          owner: "burak.sahin",
          from: [
            ["s4p-hana/RBKP", NIGHTLY],
            ["s4p-hana/RSEG", NIGHTLY],
          ],
        },
      },
      {
        name: "fact_gl",
        rows: 1_900_000,
        columns: [
          ["gl_key", "bigint", "PK", "Ledger key", ""],
          ["date_key", "int", "FK:dim_date.date_key", "Period", "The last day of the month."],
          ["company_code", "char(4)", "", "Company code", ""],
          ["account", "varchar(10)", "", "G/L account", ""],
          ["account_group", "varchar(40)", "", "Account group", "Revenue, cost of sales, operating expenses…"],
          ["profit_center", "varchar(10)", "", "Profit centre", ""],
          ["amount_try", "decimal(18,2)", "", "Amount (TRY)", ""],
        ],
        doc: {
          business: "Monthly general ledger",
          status: "Certified",
          definition: "One row per company code, account, profit centre and month: the month's balance.",
          refresh: "Monthly, after the close",
          personal: "None",
          owner: "hande.ozkan",
          from: [["s4p-hana/ACDOCA", "Monthly after the close (Azure Data Factory)"]],
          experts: [["hande.ozkan", "Expert"]],
        },
      },
    ],
  },
];

/** "PK FK:VBAK.VBELN" → primary, and the table and column it points to. */
function keysOf(keys: string): { primary: boolean; foreign?: { table: string; column: string } } {
  const foreign = /FK:([^.\s]+)\.(\S+)/.exec(keys);
  return { primary: /\bPK\b/.test(keys), foreign: foreign ? { table: foreign[1]!, column: foreign[2]! } : undefined };
}

/** A demo table as its database's catalog describes it. */
function technical(database: DemoDatabase, table: DemoTable): SchemaTableInput {
  const foreign = new Map<string, { columns: string[]; ref_columns: string[] }>();
  for (const [name, , keys] of table.columns) {
    const key = keysOf(keys).foreign;
    if (!key) continue;
    if (!foreign.has(key.table)) foreign.set(key.table, { columns: [], ref_columns: [] });
    foreign.get(key.table)!.columns.push(name);
    foreign.get(key.table)!.ref_columns.push(key.column);
  }
  return {
    schema: database.schema,
    name: table.name,
    type: table.type ?? "Table",
    rows: table.type === "View" ? null : (table.rows ?? null),
    comment: table.comment ?? "",
    columns: table.columns.map(([name, type, keys, , , more]) => ({
      name,
      type,
      nullable: !keysOf(keys).primary,
      primary: keysOf(keys).primary,
      comment: more?.comment ?? "",
    })),
    foreign_keys: [...foreign].map(([ref, key]) => ({ columns: key.columns, ref_schema: database.schema, ref_table: ref, ref_columns: key.ref_columns })),
  };
}

const SCHEMAS = new Map<string, SchemaInput>(
  DATABASES.map((database) => [database.key, { tables: database.tables.map((table) => technical(database, table)) }]),
);

/** The demo databases' catalogs, as reading them through a connection would give them. */
export function demoSchema(databaseKey: string): SchemaInput | undefined {
  return SCHEMAS.get(databaseKey);
}

/** "s4p-hana/VBAK" → the table's key in the brain. */
export function tableRef(path: string): { kind: "data_table"; key: string } {
  const [databaseKey, name] = path.split("/") as [string, string];
  const database = DATABASES.find((d) => d.key === databaseKey)!;
  return { kind: "data_table", key: tableKey(databaseKey, database.schema, name) };
}

interface DemoDataset {
  key: string;
  name: string;
  summary: string;
  type: string;
  status: "Certified" | "Documented" | "Needs definitions";
  location: string;
  refresh: string;
  rows?: number;
  personal: "None" | "Some" | "Sensitive";
  owner: string;
  columns?: [name: string, type: string, business: string, definition?: string, personal?: boolean][];
  measures?: [name: string, definition: string, formula: string, format?: string][];
  from?: [table: string, how: string][];
  usedBy?: [process: string, how: How][];
  issues?: string[];
  experts?: [person: string, level: "Expert" | "Can do it" | "Learning"][];
}

const DATASETS: DemoDataset[] = [
  {
    key: "sales-model",
    name: "Sales semantic model",
    summary: "The Power BI model sales reports are built on: orders, customers and products from the data warehouse.",
    type: "Semantic model",
    status: "Certified",
    location: "Power BI › Sales workspace",
    refresh: "Daily at 06:00 (import)",
    personal: "None",
    owner: "thomas.weber",
    measures: [
      ["Net revenue", "Sales before VAT, in TRY.", "SUM(fact_sales[net_revenue_try])", "₺ #,0"],
      ["Gross margin %", "Gross margin as a share of net revenue.", "DIVIDE(SUM(fact_sales[margin_try]), [Net revenue])", "0.0%"],
      ["Orders", "How many sales orders.", "DISTINCTCOUNT(fact_sales[order_no])", "#,0"],
      ["Average order value", "Net revenue per order.", "DIVIDE([Net revenue], [Orders])", "₺ #,0"],
      [
        "Export share %",
        "Net revenue from customers outside Türkiye.",
        'DIVIDE(CALCULATE([Net revenue], dim_customer[country] <> "TR"), [Net revenue])',
        "0.0%",
      ],
      [
        "On-time delivery %",
        "Order lines shipped by the date confirmed to the customer.",
        "DIVIDE(SUM(fact_sales[on_time]), COUNT(fact_sales[on_time]))",
        "0.0%",
      ],
    ],
    from: [
      ["dwh/fact_sales", "Import, daily"],
      ["dwh/dim_customer", "Import, daily"],
      ["dwh/dim_product", "Import, daily"],
      ["dwh/dim_date", "Import, daily"],
    ],
  },
  {
    key: "operations-model",
    name: "Operations semantic model",
    summary: "The Power BI model of production and quality: OEE, scrap, downtime, complaints and PPM.",
    type: "Semantic model",
    status: "Certified",
    location: "Power BI › Operations workspace",
    refresh: "Daily at 06:30 (import)",
    personal: "None",
    owner: "okan.tekin",
    measures: [
      [
        "OEE %",
        "Availability × performance × quality, weighted by planned time.",
        "SUMX(fact_production, fact_production[oee] * fact_production[planned_qty]) / SUM(fact_production[planned_qty])",
        "0.0%",
      ],
      [
        "Scrap rate %",
        "Scrapped pieces as a share of all made.",
        "DIVIDE(SUM(fact_production[scrap_qty]), SUM(fact_production[good_qty]) + SUM(fact_production[scrap_qty]))",
        "0.00%",
      ],
      ["Downtime hours", "Hours machines stood still.", "SUM(fact_production[downtime_min]) / 60", "#,0.0"],
      ["Complaints", "Customer complaints received.", "SUM(fact_quality[complaints])", "#,0"],
      ["PPM", "Defective parts per million delivered.", "AVERAGE(fact_quality[ppm])", "#,0"],
    ],
    from: [
      ["dwh/fact_production", "Import, daily"],
      ["dwh/fact_quality", "Import, daily"],
      ["dwh/dim_product", "Import, daily"],
      ["dwh/dim_date", "Import, daily"],
    ],
    experts: [["deniz.celik", "Can do it"]],
  },
  {
    key: "finance-model",
    name: "Finance semantic model",
    summary: "The Power BI model of the general ledger and supplier invoices, built by Hande Özkan.",
    type: "Semantic model",
    status: "Documented",
    location: "Power BI › Finance workspace",
    refresh: "Daily at 07:00 (import)",
    personal: "None",
    owner: "hande.ozkan",
    measures: [
      ["Revenue", "Revenue accounts of the month.", 'CALCULATE(-SUM(fact_gl[amount_try]), fact_gl[account_group] = "Revenue")', "₺ #,0"],
      ["EBITDA", "Earnings before interest, taxes, depreciation and amortisation.", "[Revenue] - [Cost of sales] - [Operating expenses]", "₺ #,0"],
      ["EBITDA margin %", "EBITDA as a share of revenue.", "DIVIDE([EBITDA], [Revenue])", "0.0%"],
      ["Open AP", "Supplier invoices not yet paid.", "CALCULATE(SUM(fact_ap_invoices[amount_try]), ISBLANK(fact_ap_invoices[paid_date]))", "₺ #,0"],
      ["Overdue AP", "Open supplier invoices past their due date.", "CALCULATE([Open AP], fact_ap_invoices[days_overdue] > 0)", "₺ #,0"],
      ["DPO", "Days payable outstanding: how long the company takes to pay.", "DIVIDE([Open AP], [Cost of sales]) * 365", "#,0"],
    ],
    from: [
      ["dwh/fact_gl", "Import, daily"],
      ["dwh/fact_ap_invoices", "Import, daily"],
      ["dwh/dim_supplier", "Import, daily"],
      ["dwh/dim_date", "Import, daily"],
    ],
    issues: ["Cost of sales and Operating expenses are measures only Hande knows how to change"],
    experts: [["hande.ozkan", "Expert"]],
  },
  {
    key: "purchasing-model",
    name: "Purchasing semantic model",
    summary: "The Power BI model of purchasing: spend, suppliers' on-time delivery and price variance.",
    type: "Semantic model",
    status: "Documented",
    location: "Power BI › Procurement workspace",
    refresh: "Daily at 06:00 (import)",
    personal: "None",
    owner: "ayse.kaya",
    measures: [
      ["Spend", "Value ordered from suppliers.", "SUMX(fact_purchasing, fact_purchasing[ordered_qty] * RELATED(...))", "₺ #,0"],
      ["Supplier OTD %", "Purchase order lines delivered by the promised date.", "DIVIDE(SUM(fact_purchasing[on_time]), COUNTROWS(fact_purchasing))", "0.0%"],
      ["Price variance", "What invoices cost above or below the order price.", "SUM(fact_purchasing[price_variance_try])", "₺ #,0"],
    ],
    from: [
      ["dwh/fact_purchasing", "Import, daily"],
      ["dwh/dim_supplier", "Import, daily"],
      ["dwh/dim_product", "Import, daily"],
      ["dwh/dim_date", "Import, daily"],
    ],
  },
  {
    key: "cash-flow-xlsx",
    name: "Cash flow forecast.xlsx",
    summary: "The weekly cash flow forecast finance keeps in Excel.",
    type: "Excel workbook",
    status: "Needs definitions",
    location: "SharePoint › Finance › Treasury/Cash flow forecast.xlsx",
    refresh: "Every Monday, by hand",
    personal: "None",
    owner: "elif.yilmaz",
    columns: [
      ["Week", "text", "Week", "The week starting on Monday."],
      ["Bank", "text", "Bank account"],
      ["Opening", "number", "Opening balance"],
      ["Receipts", "number", "Customer receipts", "What customers are expected to pay that week."],
      ["Payments", "number", "Supplier payments"],
      ["Payroll", "number", "Payroll"],
      ["Taxes", "number", "Taxes"],
      ["Closing", "number", "Closing balance"],
    ],
    usedBy: [["finance.collections", "Reads"]],
    issues: ["Filled in by hand from the bank portals", "Two versions travel by email: the one on SharePoint is the right one"],
  },
  {
    key: "test-bench-telemetry",
    name: "Test bench sensor data",
    summary: "Every second of every pump test: flow, head, vibration and temperature from the test benches.",
    type: "Data lake folder",
    status: "Documented",
    location: "abfss://telemetry@acmedatalake.dfs.core.windows.net/pumptest/",
    refresh: "Every second while a pump is tested",
    rows: 1_200_000_000,
    personal: "None",
    owner: "deniz.celik",
    columns: [
      ["serial_no", "string", "Serial number"],
      ["bench_id", "string", "Test bench"],
      ["ts", "timestamp", "Time"],
      ["flow_m3h", "double", "Flow (m³/h)"],
      ["head_m", "double", "Head (m)"],
      ["vibration_mm_s", "double", "Vibration (mm/s)", "Above 4.5 fails (ISO 10816)."],
      ["temperature_c", "double", "Bearing temperature (°C)"],
    ],
    usedBy: [["pump-final-test", "Writes"]],
    experts: [["deniz.celik", "Expert"]],
  },
  {
    key: "hr-headcount-export",
    name: "HR headcount export",
    summary: "The monthly headcount and leave file payroll exports from Logo Bordro.",
    type: "CSV export",
    status: "Documented",
    location: "SharePoint › HR › Reports/headcount_YYYYMM.csv",
    refresh: "Monthly, after payroll",
    personal: "Sensitive",
    owner: "gizem.polat",
    columns: [
      ["employee_id", "text", "Employee number", "", true],
      ["department", "text", "Department"],
      ["site", "text", "Site"],
      ["start_date", "date", "Start date", "", true],
      ["leave_taken", "number", "Leave days taken", "", true],
      ["leave_left", "number", "Leave days left", "", true],
      ["fte", "number", "FTE", "1.0 is full time."],
    ],
    usedBy: [["hr.leave-management", "Reads"]],
  },
  {
    key: "service-desk-tickets",
    name: "Service desk tickets",
    summary: "IT's tickets and requests, read from Jira Service Management's REST API.",
    type: "API resource",
    status: "Documented",
    location: "https://acme.atlassian.net/rest/servicedeskapi/request",
    refresh: "Every hour",
    personal: "Some",
    owner: "mehmet.oz",
    columns: [
      ["key", "string", "Ticket", "", false],
      ["created", "datetime", "Opened"],
      ["requestType", "string", "Request type"],
      ["priority", "string", "Priority"],
      ["status", "string", "Status"],
      ["assignee", "string", "Assignee", "", true],
      ["resolved", "datetime", "Resolved"],
      ["slaMet", "boolean", "SLA met"],
    ],
    usedBy: [["it.helpdesk-triage", "Reads and writes"]],
  },
  {
    key: "project-tracker",
    name: "Project tracker issues",
    summary: "Projects and their tasks, read from Jira Software's REST API.",
    type: "API resource",
    status: "Needs definitions",
    location: "https://acme.atlassian.net/rest/api/3/search",
    refresh: "Every hour",
    personal: "Some",
    owner: "ozan.kurt",
    columns: [
      ["key", "string", "Issue"],
      ["project", "string", "Project"],
      ["summary", "string", "Summary"],
      ["status", "string", "Status"],
      ["assignee", "string", "", "", true],
      ["duedate", "date", ""],
    ],
  },
];

/** The demo catalog's tables: technical columns from the database, business words from the catalog. */
function documentedColumns(database: DemoDatabase, table: DemoTable): BrainDataColumn[] {
  const keys = schemaBatch({ key: database.key }, { tables: [technical(database, table)] }).columns.get(tableKey(database.key, database.schema, table.name))!;
  return table.columns.map(([, , , business, definition, more], i) => ({
    ...keys[i]!,
    comment: keys[i]!.comment ?? "",
    nullable: keys[i]!.nullable,
    business_name: business ?? "",
    definition: definition ?? "",
    personal: more?.personal ?? false,
    example: more?.example ?? "",
  }));
}

export const dataCatalogSource: BrainSourceDefinition = {
  key: "catalog",
  name: "Data catalog (demo)",
  system: "Made-up data standing in for Microsoft Purview",
  description:
    "What the company's data means: the documented tables of SAP, the MES, the customer portal and the data warehouse in business words, column by column; data sets such as Power BI models, Excel files and exports; who owns them, which processes use them, and where their data comes from.",
  brings: ["Documented tables", "Column definitions", "Data sets and semantic models", "Data lineage", "Which processes use which data"],
  icon: "table",
  demo: true,
  priority: 55,
  async read({ domain }) {
    const person = (local: string) => ({ kind: "person" as const, email: `${local}@${domain}` });
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    for (const database of DATABASES) {
      for (const table of database.tables) {
        const doc = table.doc;
        if (!doc) continue;
        const me = { kind: "data_table" as const, key: tableKey(database.key, database.schema, table.name) };
        entities.push({
          kind: "data_table",
          key: me.key,
          name: table.name,
          aliases: [doc.business],
          summary: doc.definition,
          data: {
            business_name: doc.business,
            status: doc.status,
            definition: doc.definition,
            type: table.type ?? "Table",
            schema: database.schema,
            rows: table.type === "View" ? undefined : table.rows,
            refresh: doc.refresh,
            personal_data: doc.personal,
            columns: documentedColumns(database, table),
            usage: doc.usage,
            issues: doc.issues,
          },
        });
        links.push({ from: me, relation: "table_of", to: { kind: "database", key: database.key } });
        if (doc.owner) links.push({ from: person(doc.owner), relation: "owns", to: me });
        for (const [process, how] of doc.usedBy ?? []) links.push({ from: { kind: "process", key: process }, relation: "uses_data", to: me, detail: how });
        for (const [source, how] of doc.from ?? []) links.push({ from: me, relation: "built_on", to: tableRef(source), detail: how });
        for (const [expert, level] of doc.experts ?? []) links.push({ from: person(expert), relation: "knows", to: me, detail: level });
      }
    }
    for (const dataset of DATASETS) {
      const me = { kind: "dataset" as const, key: dataset.key };
      entities.push({
        kind: "dataset",
        key: dataset.key,
        name: dataset.name,
        summary: dataset.summary,
        data: {
          type: dataset.type,
          status: dataset.status,
          definition: dataset.summary,
          location: dataset.location,
          refresh: dataset.refresh,
          rows: dataset.rows,
          personal_data: dataset.personal,
          columns: dataset.columns?.map(([name, type, business, definition, personal]) => ({
            name,
            type,
            business_name: business,
            definition: definition ?? "",
            personal: personal ?? false,
          })),
          measures: dataset.measures?.map(([name, definition, formula, format]): BrainMeasure => ({ name, definition, formula, format: format ?? "" })),
          issues: dataset.issues,
        },
      });
      links.push({ from: person(dataset.owner), relation: "owns", to: me });
      for (const [source, how] of dataset.from ?? []) links.push({ from: me, relation: "built_on", to: tableRef(source), detail: how });
      for (const [process, how] of dataset.usedBy ?? []) links.push({ from: { kind: "process", key: process }, relation: "uses_data", to: me, detail: how });
      for (const [expert, level] of dataset.experts ?? []) links.push({ from: person(expert), relation: "knows", to: me, detail: level });
      if (dataset.type === "Semantic model") links.push({ from: me, relation: "part_of", to: { kind: "system", key: "power-bi" } });
    }
    return { entities, links };
  },
};
