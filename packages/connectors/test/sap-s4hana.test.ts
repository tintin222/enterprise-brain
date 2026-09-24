import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, sapS4hanaConnector } from "../src/index.ts";
import { basicHeader, expectConnectorError, FakeFetch, json, makeCtx, run, text } from "./helpers.ts";

const BASE = "https://my400123-api.s4hana.cloud.sap";
const ROOT = `${BASE}/sap/opu/odata/sap`;
const BP = `${ROOT}/API_BUSINESS_PARTNER/A_BusinessPartner`;
const SI_ROOT = `${ROOT}/API_SUPPLIERINVOICE_PROCESS_SRV`;

function basicCtx(fake: FakeFetch) {
  return makeCtx({
    fetch: fake.fetch,
    config: { base_url: `${BASE}/`, auth_type: "basic", username: "EB_COMM_USER", sap_client: "100", company_code: "1010" },
    secrets: { password: "Very$ecret1" },
  });
}

describe("sap-s4hana", () => {
  beforeEach(() => clearTokenCache());

  it("searches business partners with OData V2 filters, basic auth, sap-client and server-side paging", async () => {
    const fake = new FakeFetch()
      .once("GET", BP, json({
        d: {
          results: [
            { __metadata: { uri: "x" }, BusinessPartner: "17300001", BusinessPartnerFullName: "Kaya Celik San. A.S.", Supplier: "17300001", CreationDate: `/Date(${Date.UTC(2021, 2, 1)})/` },
            { BusinessPartner: "17300002", BusinessPartnerFullName: "Kaya Lojistik", Supplier: "17300002" },
          ],
          __next: `${BP}?$skiptoken=2&sap-client=100`,
        },
      }))
      .on("GET", BP, json({ d: { results: [{ BusinessPartner: "17300003" }, { BusinessPartner: "17300004" }] } }));
    const result = await run(sapS4hanaConnector, "search_business_partners", { query: "Kaya", role: "supplier", top: 3 }, basicCtx(fake));

    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({ BusinessPartner: "17300001", BusinessPartnerFullName: "Kaya Celik San. A.S.", Supplier: "17300001", CreationDate: "2021-03-01" });
    expect(result.has_more).toBe(true);
    const [first, second] = fake.calls;
    expect(first!.headers.get("authorization")).toBe(basicHeader("EB_COMM_USER", "Very$ecret1"));
    expect(first!.headers.get("accept")).toBe("application/json");
    expect(first!.url.searchParams.get("sap-client")).toBe("100");
    expect(first!.url.searchParams.get("$top")).toBe("3");
    expect(first!.url.searchParams.get("$filter")).toBe(
      "(substringof('Kaya',BusinessPartnerFullName) or substringof('KAYA',SearchTerm1) or BusinessPartner eq 'Kaya') and Supplier ne ''",
    );
    expect(second!.url.searchParams.get("$skiptoken")).toBe("2");
    expect(second!.headers.get("authorization")).toBe(basicHeader("EB_COMM_USER", "Very$ecret1"));
  });

  it("reads a purchase order with its items", async () => {
    const fake = new FakeFetch().on("GET", `${ROOT}/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder('4500000123')`, json({
      d: {
        __metadata: {},
        PurchaseOrder: "4500000123",
        Supplier: "17300001",
        PurchaseOrderDate: `/Date(${Date.UTC(2026, 8, 1)})/`,
        to_PurchaseOrderItem: { results: [{ __metadata: {}, PurchaseOrderItem: "10", Material: "TG11", OrderQuantity: "12000", NetPriceAmount: "38.50" }] },
      },
    }));
    const po = await run(sapS4hanaConnector, "get_purchase_order", { po_number: "4500000123" }, basicCtx(fake));
    expect(po).toEqual({
      PurchaseOrder: "4500000123",
      Supplier: "17300001",
      PurchaseOrderDate: "2026-09-01",
      to_PurchaseOrderItem: [{ PurchaseOrderItem: "10", Material: "TG11", OrderQuantity: "12000", NetPriceAmount: "38.50" }],
    });
    expect(fake.calls[0]!.url.searchParams.get("$expand")).toBe("to_PurchaseOrderItem");
  });

  it("creates a supplier invoice with CSRF token + session cookies and PO reference items", async () => {
    const fake = new FakeFetch()
      .on("GET", `${SI_ROOT}/`, () =>
        json({ d: { EntitySets: ["A_SupplierInvoice"] } }, 200, [
          ["x-csrf-token", "csrf-abc=="],
          ["set-cookie", "SAP_SESSIONID_ABC_100=s3ss10n; path=/; secure; HttpOnly"],
          ["set-cookie", "sap-usercontext=sap-client=100; path=/"],
        ]),
      )
      .on("POST", `${SI_ROOT}/A_SupplierInvoice`, (req) =>
        json({ d: { __metadata: {}, SupplierInvoice: "5105600123", FiscalYear: "2026", CompanyCode: "1010", SupplierInvoiceStatus: "5", echo: req.json } }, 201),
      );
    const result = await run(
      sapS4hanaConnector,
      "create_supplier_invoice",
      {
        supplier_id: "17300001",
        invoice_reference: "KCS2026000004187",
        document_date: "2026-09-20",
        posting_date: "2026-09-24",
        currency: "try",
        gross_amount: 862200,
        tax_code: "V1",
        tax_amount: 143700,
        po_items: [{ po_number: "4500000123", po_item: "10", amount: 462000, quantity: 12000, unit: "KG" }],
      },
      basicCtx(fake),
    );
    expect(result).toMatchObject({ ok: true, supplier_invoice: "5105600123", fiscal_year: "2026", company_code: "1010" });

    const csrf = fake.calls[0]!;
    expect(csrf.method).toBe("GET");
    expect(csrf.headers.get("x-csrf-token")).toBe("fetch");
    const post = fake.calls[1]!;
    expect(post.headers.get("x-csrf-token")).toBe("csrf-abc==");
    expect(post.headers.get("cookie")).toBe("SAP_SESSIONID_ABC_100=s3ss10n; sap-usercontext=sap-client=100");
    expect(post.url.searchParams.get("sap-client")).toBe("100");
    expect(post.json).toEqual({
      CompanyCode: "1010",
      DocumentDate: `/Date(${Date.UTC(2026, 8, 20)})/`,
      PostingDate: `/Date(${Date.UTC(2026, 8, 24)})/`,
      SupplierInvoiceIDByInvcgParty: "KCS2026000004187",
      InvoicingParty: "17300001",
      DocumentCurrency: "TRY",
      InvoiceGrossAmount: "862200.00",
      TaxIsCalculatedAutomatically: false,
      to_SuplrInvcItemPurOrdRef: {
        results: [
          {
            SupplierInvoiceItem: "1",
            PurchaseOrder: "4500000123",
            PurchaseOrderItem: "10",
            DocumentCurrency: "TRY",
            SupplierInvoiceItemAmount: "462000.00",
            QuantityInPurchaseOrderUnit: "12000",
            PurchaseOrderQuantityUnit: "KG",
            TaxCode: "V1",
          },
        ],
      },
      to_SupplierInvoiceTax: { results: [{ TaxCode: "V1", DocumentCurrency: "TRY", TaxAmount: "143700.00" }] },
    });
  });

  it("refetches the CSRF token once when SAP rejects it", async () => {
    let tokens = 0;
    const fake = new FakeFetch()
      .on("GET", `${SI_ROOT}/`, () => json({ d: {} }, 200, { "x-csrf-token": `token-${++tokens}` }))
      .once("POST", `${SI_ROOT}/A_SupplierInvoice`, text("CSRF token validation failed", 403, { "x-csrf-token": "Required" }))
      .on("POST", `${SI_ROOT}/A_SupplierInvoice`, json({ d: { SupplierInvoice: "5105600124", FiscalYear: "2026" } }, 201));
    const result = await run(
      sapS4hanaConnector,
      "create_supplier_invoice",
      { supplier_id: "17300001", invoice_reference: "R-1", document_date: "2026-09-20", currency: "EUR", gross_amount: 100 },
      basicCtx(fake),
    );
    expect(result.supplier_invoice).toBe("5105600124");
    expect(fake.callsTo("POST", `${SI_ROOT}/A_SupplierInvoice`).map((c) => c.headers.get("x-csrf-token"))).toEqual(["token-1", "token-2"]);
  });

  it("uses OAuth 2.0 client credentials with HTTP Basic client authentication", async () => {
    const tokenUrl = "https://acme.authentication.eu10.hana.ondemand.com/oauth/token";
    const fake = new FakeFetch()
      .on("POST", tokenUrl, json({ access_token: "sap-token", token_type: "bearer", expires_in: 43199 }))
      .on("GET", `${ROOT}/API_SALES_ORDER_SRV/A_SalesOrder('1234')`, json({ d: { SalesOrder: "1234", to_Item: { results: [] } } }));
    const ctx = makeCtx({
      fetch: fake.fetch,
      config: { base_url: BASE, auth_type: "oauth2", token_url: tokenUrl, client_id: "sb-eb" },
      secrets: { client_secret: "xsuaa-secret" },
    });
    const order = await run(sapS4hanaConnector, "get_sales_order", { order_number: "1234" }, ctx);
    expect(order).toEqual({ SalesOrder: "1234", to_Item: [] });
    const tokenCall = fake.calls[0]!;
    expect(tokenCall.headers.get("authorization")).toBe(basicHeader("sb-eb", "xsuaa-secret"));
    expect(tokenCall.form!.get("grant_type")).toBe("client_credentials");
    expect(fake.calls[1]!.headers.get("authorization")).toBe("Bearer sap-token");
    expect(fake.calls[1]!.url.searchParams.has("sap-client")).toBe(false);
  });

  it("maps SAP errors (404 not found, 401 auth) and validates configuration", async () => {
    const fake = new FakeFetch()
      .on("GET", `${ROOT}/API_SALES_ORDER_SRV/A_SalesOrder('999')`, json({ error: { code: "SY/530", message: { lang: "en", value: "Resource not found for segment 'A_SalesOrderType'" } } }, 404))
      .on("GET", BP, text("Unauthorized", 401));
    const notFound = await expectConnectorError(sapS4hanaConnector.execute("get_sales_order", { order_number: "999" }, basicCtx(fake)));
    expect(notFound).toMatchObject({ code: "not_found", message: "SAP S/4HANA returned HTTP 404: SY/530: Resource not found for segment 'A_SalesOrderType'" });
    const test = await sapS4hanaConnector.test(basicCtx(fake));
    expect(test).toMatchObject({ ok: false, details: { code: "auth" } });
    const missing = await sapS4hanaConnector.test(makeCtx({ config: { base_url: BASE } }));
    expect(missing).toMatchObject({ ok: false, message: "Missing configuration: Username" });
  });

  it("looks up supplier invoices by key or by the supplier's reference", async () => {
    const fake = new FakeFetch()
      .on("GET", `${SI_ROOT}/A_SupplierInvoice(SupplierInvoice='5105600123',FiscalYear='2026')`, json({ d: { SupplierInvoice: "5105600123", FiscalYear: "2026" } }))
      .on("GET", `${SI_ROOT}/A_SupplierInvoice`, json({ d: { results: [{ SupplierInvoice: "5105600125", FiscalYear: "2026", InvoicingParty: "17300001" }] } }));
    const ctx = basicCtx(fake);
    expect(await run(sapS4hanaConnector, "get_supplier_invoice", { invoice_id: "5105600123", fiscal_year: "2026" }, ctx)).toMatchObject({ SupplierInvoice: "5105600123" });
    expect(await run(sapS4hanaConnector, "get_supplier_invoice", { supplier_invoice_reference: "KCS-1", supplier_id: "17300001" }, ctx)).toMatchObject({
      SupplierInvoice: "5105600125",
    });
    expect(fake.calls[1]!.url.searchParams.get("$filter")).toBe("SupplierInvoiceIDByInvcgParty eq 'KCS-1' and InvoicingParty eq '17300001'");
    expect((await expectConnectorError(sapS4hanaConnector.execute("get_supplier_invoice", {}, ctx))).code).toBe("validation");
  });
});
