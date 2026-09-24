import { describe, expect, it } from "vitest";
import { InMemorySandboxStore, sandboxErpConnector } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

const erp = sandboxErpConnector;

function freshCtx() {
  return makeCtx({ sandbox: new InMemorySandboxStore() });
}

const invoiceFor = (overrides: Record<string, unknown>) => ({
  invoice_date: "2026-09-20",
  tax_amount: 0,
  ...overrides,
});

describe("sandbox-erp: demo data", () => {
  it("seeds realistic data on first use and only once", async () => {
    const ctx = freshCtx();
    expect(await ctx.sandbox.count("sandbox-erp")).toBe(0);
    const suppliers = await run(erp, "search_suppliers", {}, ctx);
    const seeded = await ctx.sandbox.count("sandbox-erp");
    expect(seeded).toBeGreaterThan(80);
    expect(suppliers.total).toBeGreaterThanOrEqual(12);
    expect(suppliers.items[0]).toMatchObject({ supplier_id: "SUP-1001", name: "Kaya Çelik Sanayi ve Ticaret A.Ş.", country: "TR" });
    for (const entity of ["suppliers", "purchase_orders", "supplier_invoices", "customers", "open_items", "materials", "sales_orders", "gl_balances"]) {
      expect((await ctx.sandbox.list("sandbox-erp", entity)).length, entity).toBeGreaterThanOrEqual(8);
    }
    await run(erp, "search_customers", {}, ctx);
    expect(await ctx.sandbox.count("sandbox-erp")).toBe(seeded);
  });

  it("searches accent- and case-insensitively (Turkish characters)", async () => {
    const ctx = freshCtx();
    expect((await run(erp, "search_suppliers", { query: "kaya celik" }, ctx)).items.map((s: any) => s.supplier_id)).toEqual(["SUP-1001"]);
    expect((await run(erp, "search_suppliers", { query: "BEARINGS" }, ctx)).items[0].supplier_id).toBe("SUP-1004");
    expect((await run(erp, "search_customers", { query: "boğaziçi" }, ctx)).items[0].customer_id).toBe("CUST-2001");
    expect((await run(erp, "search_customers", { query: "hamburg" }, ctx)).items[0].name).toBe("Hansa Pumpen Vertrieb GmbH");
  });

  it("returns supplier details with valid IBAN and open purchase orders", async () => {
    const supplier = await run(erp, "get_supplier", { supplier_id: "sup-1001" }, freshCtx());
    expect(supplier.iban).toMatch(/^TR\d{2} \d{4}/);
    expect(supplier.open_purchase_orders.map((p: any) => p.po_number)).toEqual(expect.arrayContaining(["PO-4500012", "PO-4500023"]));
    expect((await expectConnectorError(erp.execute("get_supplier", { supplier_id: "SUP-9999" }, freshCtx()))).code).toBe("not_found");
    expect((await expectConnectorError(erp.execute("get_supplier", {}, freshCtx()))).code).toBe("validation");
  });

  it("returns purchase orders with received / invoiced values and filters", async () => {
    const ctx = freshCtx();
    const po = await run(erp, "get_purchase_order", { po_number: "PO-4500012" }, ctx);
    expect(po).toMatchObject({ supplier_id: "SUP-1001", currency: "TRY", net_total: 718500, tax_amount: 143700, total: 862200, status: "received" });
    expect(po.open_to_invoice_value).toBe(718500);
    const open = await run(erp, "search_purchase_orders", { supplier_id: "SUP-1001", status: "open" }, ctx);
    expect(open.items.map((p: any) => p.po_number)).toEqual(["PO-4500023"]);
  });

  it("computes customer balances with aging and lists overdue items", async () => {
    const ctx = freshCtx();
    const balance = await run(erp, "get_customer_balance", { customer_id: "CUST-2001" }, ctx);
    expect(balance).toMatchObject({ total_open: 1_923_600, overdue_amount: 1_281_600, credit_limit: 3_000_000, currency: "TRY" });
    expect(balance.aging.days_1_30).toBe(1_281_600);
    const overdue = await run(erp, "list_open_items", { overdue_only: true }, ctx);
    expect(overdue.total).toBeGreaterThanOrEqual(8);
    expect(overdue.items.every((i: any) => i.is_overdue && i.days_overdue > 0)).toBe(true);
    const hansa = await run(erp, "list_open_items", { customer_id: "CUST-2002" }, ctx);
    expect(hansa.items.some((i: any) => i.document_type === "credit_memo")).toBe(true);
  });

  it("reports material stock incl. open purchase orders, by number or description", async () => {
    const ctx = freshCtx();
    const stock = await run(erp, "get_material_stock", { material: "MAT-10005" }, ctx);
    expect(stock).toMatchObject({ unrestricted_stock: 1850, reserved: 400, available: 1450, on_order: 800 });
    expect((await run(erp, "get_material_stock", { material: "electric motor" }, ctx)).below_reorder_point).toBe(true);
    expect((await expectConnectorError(erp.execute("get_material_stock", { material: "bearing" }, ctx))).message).toMatch(/several materials/);
  });

  it("returns sales orders and a balanced trial balance", async () => {
    const ctx = freshCtx();
    const order = await run(erp, "get_sales_order", { order_number: "SO-7000126" }, ctx);
    expect(order).toMatchObject({ customer_id: "CUST-2003", status: "partially_delivered", delivery_progress_percent: 66.67 });
    const tb = await run(erp, "list_gl_balances", {}, ctx);
    expect(tb.available_periods).toHaveLength(3);
    expect(tb.period).toBe(tb.available_periods[2]);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.balance).toBe(0);
    expect(tb.items.find((r: any) => r.account === "600")).toMatchObject({ name: "Domestic sales", name_tr: "Yurt İçi Satışlar" });
    const earlier = await run(erp, "list_gl_balances", { period: tb.available_periods[0] }, ctx);
    expect(earlier.items).toHaveLength(tb.items.length);
    expect((await expectConnectorError(erp.execute("list_gl_balances", { period: "1999-01" }, ctx))).code).toBe("not_found");
  });
});

describe("sandbox-erp: post_supplier_invoice 3-way match", () => {
  it("matches an invoice against received goods (PO-4500012) and closes the PO", async () => {
    const ctx = freshCtx();
    const result = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1001", invoice_number: "KCS2026000004187", currency: "TRY", net_amount: 718500, tax_amount: 143700, total_amount: 862200, po_number: "PO-4500012" }),
      ctx,
    );
    expect(result).toMatchObject({ ok: true, match_status: "matched", status: "posted", payment_block: false, document_number: "5105600109" });
    expect(result.match).toMatchObject({ status: "matched", expected_net_amount: 718500, difference: 0 });
    expect(result.due_date).toBe("2026-11-19");
    const po = await run(erp, "get_purchase_order", { po_number: "PO-4500012" }, ctx);
    expect(po.status).toBe("closed");
    expect(po.invoices.map((i: any) => i.invoice_number)).toEqual(["KCS2026000004187"]);
    // A second invoice for the same goods now bills more than was received and not yet invoiced.
    const again = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1001", invoice_number: "KCS2026000004199", currency: "TRY", net_amount: 718500, tax_amount: 143700, total_amount: 862200, po_number: "PO-4500012" }),
      ctx,
    );
    expect(again.match_status).not.toBe("matched");
  });

  it("accepts bare numeric ids (e.g. from OCR) for purchase orders, suppliers and customers", async () => {
    const ctx = freshCtx();
    expect((await run(erp, "get_purchase_order", { po_number: "4500012" }, ctx)).po_number).toBe("PO-4500012");
    expect((await run(erp, "get_supplier", { supplier_id: "1001" }, ctx)).supplier_id).toBe("SUP-1001");
    expect((await run(erp, "get_customer_balance", { customer_id: "2001" }, ctx)).customer_id).toBe("CUST-2001");
    expect((await run(erp, "get_sales_order", { order_number: "7000121" }, ctx)).order_number).toBe("SO-7000121");
  });

  it("flags a price mismatch (PO-4500013, unit price above the PO)", async () => {
    const result = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1003", invoice_number: "RH-241002", currency: "EUR", net_amount: 12536, total_amount: 12536, po_number: "PO-4500013" }),
      freshCtx(),
    );
    expect(result).toMatchObject({ match_status: "price_mismatch", status: "blocked", payment_block: true });
    expect(result.match).toMatchObject({ expected_net_amount: 12136, difference: 400, difference_percent: 3.3 });
    expect(result.match_details).toContain("PO-4500013");
  });

  it("flags a quantity mismatch (PO-4500014, only partially received)", async () => {
    const result = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1004", invoice_number: "NB-77812", currency: "EUR", net_amount: 8780, total_amount: 8780, po_number: "PO-4500014" }),
      freshCtx(),
    );
    expect(result).toMatchObject({ match_status: "quantity_mismatch", status: "blocked" });
    expect(result.match).toMatchObject({ expected_net_amount: 6900, ordered_open_amount: 8780 });
  });

  it("accepts a partial invoice that covers whole received lines", async () => {
    const result = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1004", invoice_number: "NB-77813", currency: "EUR", net_amount: 4080, total_amount: 4080, po_number: "PO-4500014" }),
      freshCtx(),
    );
    expect(result.match_status).toBe("matched");
    expect(result.match.matched_lines).toEqual([20]);
  });

  it("parks invoices without purchase order (no_po)", async () => {
    const result = await run(
      erp,
      "post_supplier_invoice",
      invoiceFor({ supplier_id: "SUP-1012", invoice_number: "BEP2026000010011", currency: "TRY", net_amount: 175000, tax_amount: 35000, total_amount: 210000 }),
      freshCtx(),
    );
    expect(result).toMatchObject({ match_status: "no_po", status: "parked", payment_block: true, po_number: null });
  });

  it("rejects duplicates, inconsistent totals, blocked suppliers and foreign purchase orders", async () => {
    const ctx = freshCtx();
    const duplicate = await expectConnectorError(
      erp.execute("post_supplier_invoice", invoiceFor({ supplier_id: "SUP-1009", invoice_number: "deg2026000001142", currency: "TRY", net_amount: 1, total_amount: 1 }), ctx),
    );
    expect(duplicate).toMatchObject({ code: "validation" });
    expect(duplicate.message).toMatch(/Duplicate invoice/);
    const totals = await expectConnectorError(
      erp.execute("post_supplier_invoice", invoiceFor({ supplier_id: "SUP-1001", invoice_number: "X-1", currency: "TRY", net_amount: 100, tax_amount: 20, total_amount: 150 }), ctx),
    );
    expect(totals.message).toMatch(/inconsistent/);
    const blocked = await expectConnectorError(
      erp.execute("post_supplier_invoice", invoiceFor({ supplier_id: "SUP-1013", invoice_number: "YK-1", currency: "TRY", net_amount: 100, tax_amount: 20, total_amount: 120 }), ctx),
    );
    expect(blocked.message).toMatch(/blocked/);
    const foreign = await expectConnectorError(
      erp.execute("post_supplier_invoice", invoiceFor({ supplier_id: "SUP-1002", invoice_number: "AD-1", currency: "TRY", net_amount: 100, total_amount: 100, po_number: "PO-4500012" }), ctx),
    );
    expect(foreign.message).toMatch(/belongs to supplier SUP-1001/);
    const missingPo = await expectConnectorError(
      erp.execute("post_supplier_invoice", invoiceFor({ supplier_id: "SUP-1002", invoice_number: "AD-2", currency: "TRY", net_amount: 100, total_amount: 100, po_number: "PO-4999999" }), ctx),
    );
    expect(missingPo.code).toBe("not_found");
    const invalid = await expectConnectorError(erp.execute("post_supplier_invoice", { supplier_id: "SUP-1001", invoice_number: "X" }, ctx));
    expect(invalid.code).toBe("validation");
    expect(invalid.message).toMatch(/invoice_date is required/);
  });

  it("tracks invoice status changes with an audit trail", async () => {
    const ctx = freshCtx();
    const initial = await run(erp, "get_invoice_status", { invoice_number: "DEG2026000001142" }, ctx);
    expect(initial).toMatchObject({ status: "blocked", match_status: "price_mismatch" });
    const approved = await run(erp, "update_supplier_invoice_status", { invoice_number: "DEG2026000001142", status: "Released", note: "Credit note received" }, ctx);
    expect(approved).toMatchObject({ ok: true, status: "approved", payment_block: false });
    const paid = await run(erp, "update_supplier_invoice_status", { invoice_number: "DEG2026000001142", status: "paid" }, ctx);
    expect(paid.paid_at).toBeTruthy();
    const status = await run(erp, "get_invoice_status", { invoice_number: "5105600103" }, ctx);
    expect(status.history.map((h: any) => h.status)).toEqual(["blocked", "approved", "paid"]);
    expect((await expectConnectorError(erp.execute("update_supplier_invoice_status", { invoice_number: "DEG2026000001142", status: "blocked" }, ctx))).code).toBe(
      "validation",
    );
    expect((await expectConnectorError(erp.execute("update_supplier_invoice_status", { invoice_number: "NOPE", status: "paid" }, ctx))).code).toBe("not_found");
  });
});

describe("sandbox-erp: master data and purchasing", () => {
  it("creates suppliers with sequential ids and validates IBAN, e-mail and duplicates", async () => {
    const ctx = freshCtx();
    const created = await run(erp, "create_supplier", { name: "Marmara Kalıp Sanayi A.Ş.", tax_id: "6120000001", email: "info@marmarakalip.example", iban: "TR330006100519786457841326" }, ctx);
    expect(created).toMatchObject({ ok: true, supplier_id: "SUP-1014", country: "TR", currency: "TRY", iban: "TR33 0006 1005 1978 6457 8413 26" });
    expect((await run(erp, "get_supplier", { supplier_id: "SUP-1014" }, ctx)).name).toBe("Marmara Kalıp Sanayi A.Ş.");
    expect((await run(erp, "create_supplier", { name: "Alpen Stahl GmbH", country: "de" }, ctx)).supplier_id).toBe("SUP-1015");
    expect((await expectConnectorError(erp.execute("create_supplier", { name: "Bad IBAN Ltd", iban: "TR330006100519786457841327" }, ctx))).message).toMatch(/IBAN/);
    expect((await expectConnectorError(erp.execute("create_supplier", { name: "Kaya Çelik Sanayi ve Ticaret A.Ş." }, ctx))).message).toMatch(/already exists: SUP-1001/);
    expect((await expectConnectorError(erp.execute("create_supplier", { name: "X", email: "nope" }, ctx))).code).toBe("validation");
  });

  it("creates purchase orders with VAT for Turkish suppliers", async () => {
    const ctx = freshCtx();
    const po = await run(
      erp,
      "create_purchase_order",
      { supplier_id: "SUP-1001", lines: [{ description: "Steel sheet S235JR 3 mm", quantity: 5000, unit_price: 39.1, material: "MAT-10001" }, { description: "Cutting service", quantity: 1, unit_price: 2500 }] },
      ctx,
    );
    expect(po).toMatchObject({ ok: true, po_number: "PO-4500024", status: "open", currency: "TRY", net_total: 198000, tax_amount: 39600, total: 237600 });
    expect(po.lines[0]).toMatchObject({ line: 10, material: "MAT-10001", unit: "KG" });
    const eu = await run(erp, "create_purchase_order", { supplier_id: "SUP-1004", lines: [{ description: "Bearing 6205-2RS", quantity: 1000, unit_price: 2.3 }] }, ctx);
    expect(eu).toMatchObject({ po_number: "PO-4500025", currency: "EUR", tax_amount: 0 });
    expect((await run(erp, "get_material_stock", { material: "MAT-10001" }, ctx)).on_order).toBe(13000);
    expect((await expectConnectorError(erp.execute("create_purchase_order", { supplier_id: "SUP-1013", lines: [{ description: "Paper", quantity: 1, unit_price: 1 }] }, ctx))).message).toMatch(/blocked/);
    expect((await expectConnectorError(erp.execute("create_purchase_order", { supplier_id: "SUP-1001", lines: [{ description: "x", quantity: 0, unit_price: 1 }] }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(erp.execute("create_purchase_order", { supplier_id: "SUP-1001", lines: [{ description: "x", quantity: "3", unit_price: 1 }] }, ctx))).message).toMatch(
      /lines\[0\]\.quantity must be number/,
    );
  });

  it("keeps data per sandbox store (company)", async () => {
    const a = freshCtx();
    const b = freshCtx();
    await run(erp, "create_supplier", { name: "Only In Store A" }, a);
    expect((await run(erp, "search_suppliers", { query: "Only In Store A" }, a)).total).toBe(1);
    expect((await run(erp, "search_suppliers", { query: "Only In Store A" }, b)).total).toBe(0);
  });
});
