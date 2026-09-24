import { defineConnector, defineManifest } from "../define.ts";
import {
  basicAuth,
  getClientCredentialsToken,
  httpRequest,
  odataKey,
  odataString,
  odataV2Collection,
  odataV2DateTimeLiteral,
  odataV2Entity,
  sameOrigin,
  toODataV2Date,
  type HttpRequestOptions,
  type HttpResponse,
  type Query,
} from "../http.ts";
import { arr, bool, date, int, num, obj, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import {
  configString,
  isRecord,
  normalizeBaseUrl,
  optBoolean,
  optEnum,
  optLimit,
  optNumber,
  optString,
  parseIsoDate,
  reqNumber,
  reqString,
  requireConfig,
  requireSecret,
  toIsoDate,
  type Rec,
} from "../util.ts";

const SERVICE = "SAP S/4HANA";
const BUSINESS_PARTNER = "API_BUSINESS_PARTNER";
const PURCHASE_ORDER = "API_PURCHASEORDER_PROCESS_SRV";
const SUPPLIER_INVOICE = "API_SUPPLIERINVOICE_PROCESS_SRV";
const SALES_ORDER = "API_SALES_ORDER_SRV";

const BP_SELECT =
  "BusinessPartner,BusinessPartnerFullName,BusinessPartnerCategory,BusinessPartnerGrouping,SearchTerm1,Customer,Supplier,CreationDate,BusinessPartnerIsBlocked";
const PO_SELECT =
  "PurchaseOrder,CompanyCode,PurchaseOrderType,Supplier,PurchasingOrganization,PurchasingGroup,PurchaseOrderDate,DocumentCurrency,PaymentTerms,PurchasingProcessingStatus,CreationDate";

interface Auth {
  header: string;
  /** A cached OAuth token that may be refreshed after a 401. */
  refreshable: boolean;
}

function serviceRoot(ctx: ConnectorContext, service: string): string {
  const base = normalizeBaseUrl(requireConfig(ctx, "base_url", "API base URL"), "API base URL");
  const path = (configString(ctx, "odata_path", "/sap/opu/odata/sap") ?? "").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") || path === "" ? path : `/${path}`}/${service}`;
}

function clientQuery(ctx: ConnectorContext, query: Query = {}): Query {
  const client = configString(ctx, "sap_client");
  return client ? { ...query, "sap-client": client } : query;
}

async function authenticate(ctx: ConnectorContext, forceRefresh: boolean): Promise<Auth> {
  if (configString(ctx, "auth_type", "basic") === "oauth2") {
    const token = await getClientCredentialsToken(
      ctx.fetch,
      {
        tokenUrl: requireConfig(ctx, "token_url", "OAuth token URL"),
        clientId: requireConfig(ctx, "client_id", "OAuth client ID"),
        clientSecret: requireSecret(ctx, "client_secret", "OAuth client secret"),
        scope: configString(ctx, "oauth_scope"),
        // SAP (XSUAA / S/4HANA OAuth server) expects client authentication via HTTP Basic.
        clientAuth: "basic",
        service: `${SERVICE} OAuth`,
      },
      forceRefresh,
    );
    return { header: `Bearer ${token.accessToken}`, refreshable: token.fromCache };
  }
  return {
    header: basicAuth(requireConfig(ctx, "username", "Username"), requireSecret(ctx, "password", "Password")),
    refreshable: false,
  };
}

/** GET against an OData V2 service (path relative to the service root or an absolute __next link). */
async function sapGet(ctx: ConnectorContext, service: string, pathOrUrl: string, query: Query = {}): Promise<HttpResponse> {
  const root = serviceRoot(ctx, service);
  const absolute = /^https?:\/\//.test(pathOrUrl);
  const url = absolute ? pathOrUrl : `${root}/${pathOrUrl}`;
  if (!sameOrigin(url, root)) throw new ConnectorError(`Refusing to follow a link to ${new URL(url).host}`, "remote");
  // Paging links normally carry sap-client already; add it when they do not.
  const hasClient = absolute && new URL(url).searchParams.has("sap-client");
  const options: HttpRequestOptions = { service: SERVICE, query: hasClient ? {} : clientQuery(ctx, absolute ? {} : query) };
  let auth = await authenticate(ctx, false);
  try {
    return await httpRequest(ctx.fetch, url, { ...options, headers: { authorization: auth.header, accept: "application/json" } });
  } catch (error) {
    if (!(auth.refreshable && error instanceof ConnectorError && error.status === 401)) throw error;
    auth = await authenticate(ctx, true);
    return httpRequest(ctx.fetch, url, { ...options, headers: { authorization: auth.header, accept: "application/json" } });
  }
}

/** Reads a collection following server-side paging (__next) until `max` entries. */
async function sapCollect(ctx: ConnectorContext, service: string, entitySet: string, query: Query, max: number): Promise<{ items: Rec[]; hasMore: boolean }> {
  const items: Rec[] = [];
  let response = await sapGet(ctx, service, entitySet, query);
  for (;;) {
    const page = odataV2Collection(response.data);
    items.push(...page.items);
    if (!page.next || items.length >= max) return { items: items.slice(0, max), hasMore: Boolean(page.next) || items.length > max };
    response = await sapGet(ctx, service, new URL(page.next, `${serviceRoot(ctx, service)}/`).toString());
  }
}

/** Fetches a CSRF token (and the session cookies it is bound to) for modifying requests. */
async function fetchCsrfToken(ctx: ConnectorContext, service: string, auth: Auth): Promise<{ token: string; cookie: string }> {
  const response = await httpRequest(ctx.fetch, `${serviceRoot(ctx, service)}/`, {
    service: SERVICE,
    query: clientQuery(ctx),
    responseType: "text",
    headers: { authorization: auth.header, "x-csrf-token": "fetch", accept: "application/json" },
  });
  const token = response.headers.get("x-csrf-token");
  if (!token || token.toLowerCase() === "required") throw new ConnectorError(`${SERVICE} did not issue a CSRF token`, "remote");
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
  return { token, cookie };
}

/** POST with CSRF protection; retries once with a fresh token/session when SAP rejects the token. */
async function sapPost(ctx: ConnectorContext, service: string, path: string, body: unknown): Promise<HttpResponse> {
  let refreshToken = false;
  for (let attempt = 0; ; attempt++) {
    const auth = await authenticate(ctx, refreshToken);
    const csrf = await fetchCsrfToken(ctx, service, auth);
    try {
      return await httpRequest(ctx.fetch, `${serviceRoot(ctx, service)}/${path}`, {
        method: "POST",
        service: SERVICE,
        query: clientQuery(ctx),
        json: body,
        headers: {
          authorization: auth.header,
          accept: "application/json",
          "x-csrf-token": csrf.token,
          ...(csrf.cookie ? { cookie: csrf.cookie } : {}),
        },
      });
    } catch (error) {
      const csrfRejected = error instanceof ConnectorError && error.status === 403 && /csrf/i.test(error.message);
      const tokenRejected = error instanceof ConnectorError && error.status === 401 && auth.refreshable;
      if (attempt > 0 || !(csrfRejected || tokenRejected)) throw error;
      ctx.logger.warn(`${SERVICE} rejected the ${csrfRejected ? "CSRF token" : "access token"}; retrying once`, { service });
      refreshToken = tokenRejected;
    }
  }
}

const amount = (value: number) => value.toFixed(2);

const manifest = defineManifest({
  type: "sap-s4hana",
  name: "SAP S/4HANA",
  vendor: "SAP",
  category: "erp",
  description:
    "Reads business partners (suppliers/customers), purchase orders, supplier invoices and sales orders from SAP S/4HANA (Cloud or on-premise) via the released OData APIs and creates supplier invoices with purchase order reference.",
  auth: "custom",
  docsUrl: "https://api.sap.com/package/SAPS4HANACloud/odata",
  maturity: "preview",
  config: [
    {
      key: "base_url",
      label: "API base URL",
      type: "url",
      required: true,
      placeholder: "https://my123456-api.s4hana.cloud.sap",
      help: "S/4HANA Cloud API host or the on-premise SAP Gateway URL (e.g. https://s4.acme.local:44300).",
    },
    { key: "sap_client", label: "SAP client", type: "string", placeholder: "100", help: "Sent as sap-client; leave empty for S/4HANA Cloud." },
    {
      key: "auth_type",
      label: "Authentication",
      type: "select",
      required: true,
      default: "basic",
      options: [
        { value: "basic", label: "Basic authentication (communication / technical user)" },
        { value: "oauth2", label: "OAuth 2.0 client credentials" },
      ],
    },
    { key: "username", label: "Username", type: "string", help: "Communication user (Cloud) or technical user (on-premise)." },
    { key: "password", label: "Password", type: "password", secret: true },
    { key: "token_url", label: "OAuth token URL", type: "url", placeholder: "https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token" },
    { key: "client_id", label: "OAuth client ID", type: "string" },
    { key: "client_secret", label: "OAuth client secret", type: "password", secret: true },
    { key: "oauth_scope", label: "OAuth scope", type: "string", help: "Optional scope requested with the token." },
    { key: "company_code", label: "Default company code", type: "string", placeholder: "1010" },
    { key: "odata_path", label: "OData path prefix", type: "string", default: "/sap/opu/odata/sap", help: "Change only when APIs are exposed through an API gateway." },
  ],
  operations: [
    readOp("search_business_partners", "Search business partners", "Find business partners (suppliers, customers) by name, search term or number.", {
      query: str("Name, search term or business partner number"),
      role: oneOf(["supplier", "customer"], "Only partners with a supplier or customer role"),
      top: int("Maximum number of results (default 20, max 500)"),
    }),
    readOp("get_business_partner", "Get business partner", "Business partner with addresses and roles (optionally bank details).", {
      business_partner_id: str("Business partner number, e.g. 17300001"),
      include_bank_details: bool("Also return bank accounts"),
    }, ["business_partner_id"]),
    readOp("get_purchase_order", "Get purchase order", "Purchase order header and items (API_PURCHASEORDER_PROCESS_SRV).", {
      po_number: str("Purchase order number, e.g. 4500000123"),
    }, ["po_number"]),
    readOp("search_purchase_orders", "Search purchase orders", "Purchase orders, newest first, by supplier, company code and date.", {
      supplier_id: str("Supplier number"),
      company_code: str("Company code"),
      from_date: date("Purchase order date from (YYYY-MM-DD)"),
      to_date: date("Purchase order date to (YYYY-MM-DD)"),
      top: int("Maximum number of results (default 20, max 500)"),
    }),
    readOp("get_supplier_invoice", "Get supplier invoice", "Supplier invoice with PO reference items (API_SUPPLIERINVOICE_PROCESS_SRV), by document number + fiscal year or by the supplier's invoice reference.", {
      invoice_id: str("Supplier invoice document number, e.g. 5105600123"),
      fiscal_year: str("Fiscal year of the document, e.g. 2026"),
      supplier_invoice_reference: str("Invoice number printed by the supplier (SupplierInvoiceIDByInvcgParty)"),
      supplier_id: str("Invoicing party, narrows a reference search"),
    }),
    writeOp("create_supplier_invoice", "Create supplier invoice", "Create (post) a supplier invoice in logistics invoice verification, optionally referencing purchase order items.", {
      supplier_id: str("Invoicing party (supplier number)"),
      invoice_reference: str("Supplier's invoice number"),
      document_date: date("Invoice date (YYYY-MM-DD)"),
      posting_date: date("Posting date (default today)"),
      currency: str("Document currency, e.g. EUR"),
      gross_amount: num("Invoice gross amount"),
      company_code: str("Company code (default from configuration)"),
      tax_code: str("Tax code, e.g. V1"),
      tax_amount: num("Tax amount; when omitted tax is calculated automatically"),
      payment_terms: str("Payment terms key, e.g. 0001"),
      header_text: str("Document header text"),
      po_items: arr(obj({
        po_number: str("Purchase order"),
        po_item: str("Purchase order item, e.g. 10"),
        amount: num("Net amount of the item"),
        quantity: num("Quantity in purchase order unit"),
        unit: str("Purchase order unit, e.g. PC"),
        tax_code: str("Tax code of the item"),
      }, ["po_number", "po_item", "amount", "quantity"]), "Items referencing purchase order items"),
    }, ["supplier_id", "invoice_reference", "document_date", "currency", "gross_amount"]),
    readOp("get_sales_order", "Get sales order", "Sales order header and items (API_SALES_ORDER_SRV).", {
      order_number: str("Sales order number"),
    }, ["order_number"]),
  ],
  itRequirements: [
    "S/4HANA Cloud: a communication system and communication user with communication arrangements SAP_COM_0008 (Business Partner), SAP_COM_0053 (Purchase Order), SAP_COM_0057 (Supplier Invoice) and SAP_COM_0109 (Sales Order) as needed",
    "S/4HANA on-premise: OData services API_BUSINESS_PARTNER, API_PURCHASEORDER_PROCESS_SRV, API_SUPPLIERINVOICE_PROCESS_SRV and API_SALES_ORDER_SRV activated in /IWFND/MAINT_SERVICE, and a technical user with a role restricted to these services and the relevant company codes",
    "Either basic credentials of that user or an OAuth 2.0 client (token URL, client ID, client secret) for the client credentials flow",
    "The API host URL (and SAP client for on-premise), reachable over HTTPS from Enterprise Brain (e.g. via SAP Cloud Connector / reverse proxy for on-premise systems)",
  ],
});

export const sapS4hanaConnector = defineConnector({
  manifest,

  async test(ctx) {
    await sapGet(ctx, BUSINESS_PARTNER, "A_BusinessPartner", { $top: 1, $select: "BusinessPartner" });
    return { ok: true, message: `Connected to ${SERVICE}: ${BUSINESS_PARTNER} is reachable with the configured credentials.` };
  },

  operations: {
    async search_business_partners(input, ctx) {
      const top = optLimit(input, "top", 20, 500);
      const query = optString(input, "query");
      const role = optEnum(input, "role", ["supplier", "customer"] as const);
      const filters: string[] = [];
      if (query) {
        filters.push(
          `(substringof(${odataString(query)},BusinessPartnerFullName) or substringof(${odataString(query.toUpperCase())},SearchTerm1) or BusinessPartner eq ${odataString(query)})`,
        );
      }
      if (role === "supplier") filters.push("Supplier ne ''");
      if (role === "customer") filters.push("Customer ne ''");
      const { items, hasMore } = await sapCollect(ctx, BUSINESS_PARTNER, "A_BusinessPartner", {
        $select: BP_SELECT,
        $filter: filters.length ? filters.join(" and ") : undefined,
        $top: top,
      }, top);
      return { items, total: items.length, has_more: hasMore };
    },

    async get_business_partner(input, ctx) {
      const expand = ["to_BusinessPartnerAddress", "to_BusinessPartnerRole"];
      if (optBoolean(input, "include_bank_details")) expand.push("to_BusinessPartnerBank");
      const response = await sapGet(ctx, BUSINESS_PARTNER, odataKey("A_BusinessPartner", reqString(input, "business_partner_id")), {
        $expand: expand.join(","),
      });
      return odataV2Entity(response.data);
    },

    async get_purchase_order(input, ctx) {
      const response = await sapGet(ctx, PURCHASE_ORDER, odataKey("A_PurchaseOrder", reqString(input, "po_number")), {
        $expand: "to_PurchaseOrderItem",
      });
      return odataV2Entity(response.data);
    },

    async search_purchase_orders(input, ctx) {
      const top = optLimit(input, "top", 20, 500);
      const filters: string[] = [];
      const supplier = optString(input, "supplier_id");
      const companyCode = optString(input, "company_code");
      const from = optString(input, "from_date");
      const to = optString(input, "to_date");
      if (supplier) filters.push(`Supplier eq ${odataString(supplier)}`);
      if (companyCode) filters.push(`CompanyCode eq ${odataString(companyCode)}`);
      if (from) filters.push(`PurchaseOrderDate ge ${odataV2DateTimeLiteral(parseIsoDate(from, "from_date"))}`);
      if (to) filters.push(`PurchaseOrderDate le ${odataV2DateTimeLiteral(parseIsoDate(to, "to_date"))}`);
      const { items, hasMore } = await sapCollect(ctx, PURCHASE_ORDER, "A_PurchaseOrder", {
        $select: PO_SELECT,
        $filter: filters.length ? filters.join(" and ") : undefined,
        $orderby: "PurchaseOrderDate desc",
        $top: top,
      }, top);
      return { items, total: items.length, has_more: hasMore };
    },

    async get_supplier_invoice(input, ctx) {
      const invoiceId = optString(input, "invoice_id");
      const fiscalYear = optString(input, "fiscal_year");
      const expand = "to_SuplrInvcItemPurOrdRef";
      if (invoiceId && fiscalYear) {
        const response = await sapGet(ctx, SUPPLIER_INVOICE, odataKey("A_SupplierInvoice", { SupplierInvoice: invoiceId, FiscalYear: fiscalYear }), {
          $expand: expand,
        });
        return odataV2Entity(response.data);
      }
      const reference = optString(input, "supplier_invoice_reference");
      if (!reference) {
        throw new ConnectorError("Provide invoice_id and fiscal_year, or supplier_invoice_reference", "validation");
      }
      const supplier = optString(input, "supplier_id");
      const filters = [`SupplierInvoiceIDByInvcgParty eq ${odataString(reference)}`];
      if (supplier) filters.push(`InvoicingParty eq ${odataString(supplier)}`);
      const { items } = await sapCollect(ctx, SUPPLIER_INVOICE, "A_SupplierInvoice", { $filter: filters.join(" and "), $expand: expand, $top: 5 }, 5);
      if (items.length === 0) throw new ConnectorError(`No supplier invoice with reference ${reference} found`, "not_found");
      if (items.length > 1) {
        const found = items.map((i) => `${String(i.SupplierInvoice)}/${String(i.FiscalYear)} (supplier ${String(i.InvoicingParty)})`).join(", ");
        throw new ConnectorError(`Several supplier invoices have reference ${reference}: ${found}. Specify supplier_id or invoice_id + fiscal_year.`, "validation");
      }
      return items[0];
    },

    async create_supplier_invoice(input, ctx) {
      const companyCode = optString(input, "company_code") ?? configString(ctx, "company_code");
      if (!companyCode) throw new ConnectorError("company_code is required (no default company code configured)", "validation");
      const currency = reqString(input, "currency").toUpperCase();
      const taxCode = optString(input, "tax_code");
      const taxAmount = optNumber(input, "tax_amount");
      if (taxAmount !== undefined && !taxCode) throw new ConnectorError("tax_code is required when tax_amount is given", "validation");
      const poItems = Array.isArray(input.po_items) ? input.po_items.filter(isRecord) : [];
      const body: Rec = {
        CompanyCode: companyCode,
        DocumentDate: toODataV2Date(parseIsoDate(reqString(input, "document_date"), "document_date")),
        PostingDate: toODataV2Date(parseIsoDate(optString(input, "posting_date") ?? toIsoDate(new Date()), "posting_date")),
        SupplierInvoiceIDByInvcgParty: reqString(input, "invoice_reference"),
        InvoicingParty: reqString(input, "supplier_id"),
        DocumentCurrency: currency,
        InvoiceGrossAmount: amount(reqNumber(input, "gross_amount")),
        TaxIsCalculatedAutomatically: taxAmount === undefined,
      };
      const paymentTerms = optString(input, "payment_terms");
      const headerText = optString(input, "header_text");
      if (paymentTerms) body.PaymentTerms = paymentTerms;
      if (headerText) body.DocumentHeaderText = headerText;
      if (poItems.length) {
        body.to_SuplrInvcItemPurOrdRef = {
          results: poItems.map((item, i) => ({
            SupplierInvoiceItem: String(i + 1),
            PurchaseOrder: reqString(item, "po_number"),
            PurchaseOrderItem: reqString(item, "po_item"),
            DocumentCurrency: currency,
            SupplierInvoiceItemAmount: amount(reqNumber(item, "amount")),
            QuantityInPurchaseOrderUnit: String(reqNumber(item, "quantity")),
            ...(optString(item, "unit") ? { PurchaseOrderQuantityUnit: optString(item, "unit") } : {}),
            ...(optString(item, "tax_code") ?? taxCode ? { TaxCode: optString(item, "tax_code") ?? taxCode } : {}),
          })),
        };
      }
      if (taxAmount !== undefined && taxCode) {
        body.to_SupplierInvoiceTax = { results: [{ TaxCode: taxCode, DocumentCurrency: currency, TaxAmount: amount(taxAmount) }] };
      }
      const response = await sapPost(ctx, SUPPLIER_INVOICE, "A_SupplierInvoice", body);
      const created = odataV2Entity(response.data);
      return {
        ok: true,
        supplier_invoice: created.SupplierInvoice ?? null,
        fiscal_year: created.FiscalYear ?? null,
        company_code: created.CompanyCode ?? companyCode,
        status: created.SupplierInvoiceStatus ?? null,
        record: created,
      };
    },

    async get_sales_order(input, ctx) {
      const response = await sapGet(ctx, SALES_ORDER, odataKey("A_SalesOrder", reqString(input, "order_number")), { $expand: "to_Item" });
      return odataV2Entity(response.data);
    },
  },
});
