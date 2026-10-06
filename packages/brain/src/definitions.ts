import type { BrainDataColumn, JsonSchema } from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";
import { describeEntity } from "./describe.ts";
import { BrainError, type BrainService } from "./service.ts";

/**
 * Business definitions for a table's or data set's columns, for a person to review: written by
 * Claude from the columns and what the brain knows around them (the database, the processes and
 * reports that use them, the definitions people already wrote), or, with no AI model, read from the
 * column names (common abbreviations, units, and SAP's field names). Nothing is kept until the person
 * keeps it.
 */

export interface ColumnSuggestion {
  name: string;
  business_name: string;
  definition: string;
  personal: boolean;
}

export interface DefinitionSuggestions {
  /** For the table itself, when it has no business name or definition yet. */
  table: { business_name: string; definition: string } | null;
  columns: ColumnSuggestion[];
  /** "ai": Claude wrote them; "names": read from the column names (no AI model connected). */
  by: "ai" | "names";
}

/** At most this many columns in one go. */
const MAX_COLUMNS = 150;

/** SAP's field names, which mean the same in every SAP system. */
const SAP_FIELDS: Record<string, [business: string, definition: string]> = {
  MANDT: ["Client", "The SAP client the row belongs to; the same in every row of one system."],
  VBELN: ["Sales document number", "The number of the sales order, delivery or billing document."],
  POSNR: ["Item", "The line number within the document (10, 20, 30…)."],
  KUNNR: ["Customer number", "SAP's number for the customer."],
  KUNUM: ["Customer number", "The customer the notification is about."],
  LIFNR: ["Supplier number", "SAP's number for the supplier."],
  MATNR: ["Material number", "SAP's number for the material: a product, a part or a raw material."],
  MAKTX: ["Material description", "The material's short text."],
  MTART: ["Material type", "Finished product, semi-finished product, raw material, trading good…"],
  MATKL: ["Material group", "The group the material is classified in."],
  WERKS: ["Plant", "The plant the row is about."],
  LGORT: ["Storage location", "Where in the plant the stock is kept."],
  LABST: ["Unrestricted stock", "Quantity in stock that is free to use."],
  INSME: ["Stock in quality inspection", "Quantity in stock waiting for a quality decision."],
  SPEME: ["Blocked stock", "Quantity in stock that may not be used."],
  AUFNR: ["Order number", "The number of the production or maintenance order."],
  PLNBEZ: ["Material to make", "The material the production order makes."],
  GAMNG: ["Order quantity", "How many the production order should make in total."],
  GSTRP: ["Planned start", "The day the order is planned to start (YYYYMMDD)."],
  GLTRP: ["Planned finish", "The day the order is planned to finish (YYYYMMDD)."],
  GMEIN: ["Unit of measure", "The unit the order quantity is in."],
  ARBPL: ["Work centre", "The machine, line or group of people where the work is done."],
  VORNR: ["Operation", "The step of the order (0010, 0020…)."],
  LMNGA: ["Yield", "Good quantity confirmed."],
  XMNGA: ["Scrap", "Scrapped quantity confirmed."],
  ERDAT: ["Created on", "The day the record was entered (YYYYMMDD)."],
  ERNAM: ["Created by", "The SAP user who entered the record."],
  AEDAT: ["Changed on", "The day the record was last changed (YYYYMMDD)."],
  BUKRS: ["Company code", "The legal company in SAP the row belongs to."],
  GJAHR: ["Fiscal year", "The year of the financial document."],
  BELNR: ["Document number", "The number of the accounting or invoice document."],
  BUDAT: ["Posting date", "The day the document was posted (YYYYMMDD)."],
  BLDAT: ["Document date", "The date on the original document, such as the invoice date (YYYYMMDD)."],
  WAERS: ["Currency", "The currency of the amounts (TRY, EUR, USD…)."],
  WAERK: ["Currency", "The currency of the document's amounts."],
  NETWR: ["Net value", "The value before tax, in the document's currency."],
  MENGE: ["Quantity", "How many, in the unit of measure."],
  MEINS: ["Unit of measure", "The unit the quantity is in (PC, KG, M…)."],
  EBELN: ["Purchase order number", "The number of the purchase order."],
  EBELP: ["Purchase order item", "The line number within the purchase order."],
  EINDT: ["Delivery date", "The day the supplier is to deliver (YYYYMMDD)."],
  BSART: ["Document type", "The type of the purchasing document."],
  AUART: ["Order type", "The type of the sales order (standard order, quotation, return…)."],
  VKORG: ["Sales organisation", "The selling unit of the company."],
  VTWEG: ["Distribution channel", "How the goods reach the customer (direct, dealers…)."],
  SPART: ["Division", "The product division."],
  LAND1: ["Country", "The country's ISO code."],
  ORT01: ["City", "The city."],
  NAME1: ["Name", "The name."],
  STCD1: ["Tax number", "The tax number."],
  KTOKD: ["Customer account group", "Which kind of customer account it is (domestic, export, one-time…)."],
  QMNUM: ["Notification number", "The number of the quality notification."],
  QMART: ["Notification type", "The type of the quality notification (customer complaint, internal…)."],
  QMTXT: ["Short text", "What the notification is about, in a few words."],
  PRIOK: ["Priority", "How urgent it is."],
  XBLNR: ["Reference", "The partner's own number for the document, such as the supplier's invoice number."],
  RMWWR: ["Gross amount", "The invoice amount with tax, in the document's currency."],
  ZTERM: ["Payment terms", "The terms the amount is due on."],
  ZFBDT: ["Baseline date", "The day the payment terms count from (YYYYMMDD)."],
  RACCT: ["G/L account", "The general ledger account."],
  PRCTR: ["Profit centre", "The part of the company the amount belongs to, for profit and loss."],
  KOSTL: ["Cost centre", "The department or area the cost belongs to."],
  RLDNR: ["Ledger", "The ledger the amount is in."],
  HSL: ["Amount in company currency", "The amount in the company code's currency."],
};

/** Short words in column names and what they stand for. */
const WORDS: Record<string, string> = {
  id: "id",
  no: "number",
  nr: "number",
  num: "number",
  qty: "quantity",
  amt: "amount",
  dt: "date",
  ts: "time",
  desc: "description",
  cust: "customer",
  supp: "supplier",
  vend: "vendor",
  mat: "material",
  prod: "product",
  wo: "work order",
  po: "purchase order",
  so: "sales order",
  inv: "invoice",
  addr: "address",
  tel: "phone",
  ccy: "currency",
  curr: "currency",
  avg: "average",
  cnt: "count",
  ref: "reference",
  sap: "SAP",
  erp: "ERP",
  mes: "MES",
  url: "address",
  ip: "IP address",
  oee: "OEE",
  ppm: "PPM",
  fte: "FTE",
  vat: "VAT",
  kpi: "KPI",
};

/** Units at the end of column names. */
const UNITS: Record<string, string> = {
  try: "TRY",
  eur: "EUR",
  usd: "USD",
  pct: "%",
  percent: "%",
  min: "minutes",
  mins: "minutes",
  minutes: "minutes",
  h: "hours",
  hrs: "hours",
  hours: "hours",
  kg: "kg",
  m3h: "m³/h",
  kw: "kW",
  c: "°C",
};

const PERSONAL =
  /(^|_)(e?mail|phone|mobile|gsm|birth|dob|tckn|national_id|ssn|iban|salary|wage|username|user_name|login|first_name|last_name|full_name|surname|address|ip|supervisor|assignee|created_by|ernam)($|_)/i;

/** "PurchaseOrderNo" and "purchase_order_no" → ["purchase", "order", "no"]. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function capitalise(words: string): string {
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/** A column's business name and what can be told about it from its name and type alone. */
export function fromName(column: Pick<BrainDataColumn, "name" | "type">): ColumnSuggestion {
  const sap = SAP_FIELDS[column.name.toUpperCase()];
  const personal = PERSONAL.test(column.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  if (sap) return { name: column.name, business_name: sap[0], definition: sap[1], personal };
  const parts = tokens(column.name);
  let flag = false;
  if (parts.length > 1 && (parts[0] === "is" || parts[0] === "has")) {
    flag = true;
    parts.shift();
  }
  let unit = "";
  if (parts.length > 1 && UNITS[parts[parts.length - 1]!]) unit = UNITS[parts.pop()!]!;
  // "mm_s" (vibration in mm/s)
  if (parts.length > 2 && parts[parts.length - 2] === "mm" && parts[parts.length - 1] === "s") {
    parts.splice(-2);
    unit = "mm/s";
  }
  const words = parts.map((t) => WORDS[t] ?? t).join(" ");
  const type = column.type.toLowerCase();
  const definition = flag || /^(bit|bool|boolean)$/.test(type) ? `Yes or no: ${words}.` : "";
  // A one-word name that only repeats the column's ("KUNUM" → "Kunum", "notes") tells nothing: no suggestion.
  const same = !unit && !definition && parts.length === 1 && words === column.name.toLowerCase();
  return { name: column.name, business_name: same ? "" : capitalise(words) + (unit ? ` (${unit})` : ""), definition, personal };
}

const SYSTEM = `You write business definitions for a company's data catalog, for business people and for AI employees who query the data.
For each column you are given, write:
- business_name: what the business calls it, in 1 to 4 words ("Customer number", "Requested delivery date", "Net value").
- definition: one or two plain sentences: what the value means, with its unit, codes or format when you can tell ("The day the customer asked for the goods (YYYYMMDD)."). Empty when you can't tell; never guess.
- personal: true when the column holds data about a person (a name, an email, a phone number, a birth date, a salary, an identity number, an IP address, a user who did something).
Use the evidence only: the names, types, keys and comments, the table's description and links, the definitions people already wrote, and the well-known conventions of the system it comes from (for example SAP's field names: VBELN is the sales document number).
Also give the table itself a business_name and a definition ("One row per … : …") when it has none; otherwise give empty strings.
Write in the language of the definitions already there; in English when there are none.`;

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    table: {
      type: "object",
      properties: { business_name: { type: "string" }, definition: { type: "string" } },
      required: ["business_name", "definition"],
      additionalProperties: false,
    },
    columns: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, business_name: { type: "string" }, definition: { type: "string" }, personal: { type: "boolean" } },
        required: ["name", "business_name", "definition", "personal"],
        additionalProperties: false,
      },
    },
  },
  required: ["table", "columns"],
  additionalProperties: false,
};

/**
 * Suggests business names and definitions for the columns that have none (or for all, with `all`),
 * and for the table itself when it has none. Nothing is changed: the person keeps what they choose.
 */
export async function suggestDefinitions(
  brain: BrainService,
  llm: LlmClient,
  companyId: string,
  id: string,
  options: { all?: boolean } = {},
): Promise<DefinitionSuggestions> {
  const view = await brain.get(companyId, id);
  if (view.kind !== "data_table" && view.kind !== "dataset") throw new BrainError("Definitions are suggested for tables and data sets", 400);
  const columns = Array.isArray(view.data.columns) ? (view.data.columns as BrainDataColumn[]) : [];
  const wanted = columns.filter((c) => options.all || !c.business_name || !c.definition).slice(0, MAX_COLUMNS);
  const tableMissing = !view.data.definition || (view.kind === "data_table" && !view.data.business_name);
  if (!wanted.length && !tableMissing) return { table: null, columns: [], by: llm.available ? "ai" : "names" };
  if (!llm.available) {
    return { table: null, columns: wanted.map((c) => keepWritten(c, fromName(c))), by: "names" };
  }
  const { data } = await llm.structured<{ table: { business_name: string; definition: string }; columns: ColumnSuggestion[] }>({
    purpose: "brain.definitions",
    system: SYSTEM,
    effort: "medium",
    schema: SCHEMA,
    messages: [
      {
        role: "user",
        content: `${describeEntity(view, { events: 0 })}\n\nColumns to define: ${wanted.map((c) => c.name).join(", ") || "none (only the table)"}`,
      },
    ],
  });
  const byName = new Map((data.columns ?? []).map((c) => [c.name.toLowerCase(), c]));
  const suggested = wanted.flatMap((column) => {
    const found = byName.get(column.name.toLowerCase());
    if (!found) return [];
    return [
      keepWritten(column, {
        name: column.name,
        business_name: String(found.business_name ?? "")
          .trim()
          .slice(0, 200),
        definition: String(found.definition ?? "")
          .trim()
          .slice(0, 2000),
        personal: Boolean(found.personal),
      }),
    ];
  });
  const table =
    tableMissing && (data.table?.business_name || data.table?.definition)
      ? {
          business_name: String(data.table.business_name ?? "")
            .trim()
            .slice(0, 200),
          definition: String(data.table.definition ?? "")
            .trim()
            .slice(0, 4000),
        }
      : null;
  return { table, columns: suggested, by: "ai" };
}

/** What a person already wrote stays: a suggestion only fills what is empty (unless all were asked for). */
function keepWritten(column: BrainDataColumn, suggestion: ColumnSuggestion): ColumnSuggestion {
  return {
    name: column.name,
    business_name: suggestion.business_name || column.business_name,
    definition: suggestion.definition || column.definition,
    personal: column.personal || suggestion.personal,
  };
}
