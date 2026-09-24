import { defineManifest } from "../define.ts";
import { arr, bool, date, email, num, obj, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError } from "../types.ts";
import {
  addDays,
  daysBetween,
  isEmail,
  matchesQuery,
  normalizeText,
  optBoolean,
  optEnum,
  optString,
  parseIsoDate,
  reqEnum,
  reqNumber,
  reqString,
  round2,
  sum,
  toIsoDate,
  type Rec,
} from "../util.ts";
import {
  defineSandboxConnector,
  formatIban,
  isValidIban,
  listResult,
  makeIban,
  nowIso,
  relativeDates,
  todayIso,
  type SandboxDb,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const PO_STATUSES = ["draft", "awaiting_approval", "open", "partially_received", "received", "closed", "cancelled"] as const;
const INVOICE_STATUSES = ["parked", "posted", "blocked", "on_hold", "approved", "rejected", "paid"] as const;

/** Values other systems commonly use for invoice decisions. */
const INVOICE_STATUS_SYNONYMS: Record<string, InvoiceStatus> = {
  approve: "approved",
  release: "approved",
  released: "approved",
  released_for_payment: "approved",
  reject: "rejected",
  declined: "rejected",
  block: "blocked",
  hold: "on_hold",
  pending: "on_hold",
  park: "parked",
  post: "posted",
  pay: "paid",
  cleared: "paid",
};

type PoStatus = (typeof PO_STATUSES)[number];
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
type MatchStatus = "matched" | "price_mismatch" | "quantity_mismatch" | "no_po";

interface Supplier {
  supplier_id: string;
  name: string;
  tax_id: string | null;
  tax_office: string | null;
  country: string;
  city: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
  currency: string;
  payment_terms: string;
  category: string;
  status: "active" | "blocked";
  block_reason: string | null;
  contact_person: string | null;
  created_at: string;
}

interface PoLine {
  line: number;
  material: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  net_amount: number;
  received_quantity: number;
  invoiced_quantity: number;
}

interface PurchaseOrder {
  po_number: string;
  supplier_id: string;
  supplier_name: string;
  company_code: string;
  plant: string;
  buyer: string;
  order_date: string;
  delivery_date: string;
  status: PoStatus;
  currency: string;
  payment_terms: string;
  lines: PoLine[];
  net_total: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  created_at: string;
}

interface InvoiceHistoryEntry {
  at: string;
  status: InvoiceStatus;
  note: string | null;
}

interface SupplierInvoice {
  invoice_number: string;
  document_number: string;
  supplier_id: string;
  supplier_name: string;
  po_number: string | null;
  invoice_date: string;
  posting_date: string;
  due_date: string;
  currency: string;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
  status: InvoiceStatus;
  match_status: MatchStatus;
  match_details: string;
  payment_block: boolean;
  paid_at: string | null;
  history: InvoiceHistoryEntry[];
  created_at: string;
}

interface Customer {
  customer_id: string;
  name: string;
  country: string;
  city: string;
  tax_id: string;
  email: string;
  phone: string;
  currency: string;
  payment_terms: string;
  credit_limit: number;
  segment: string;
  account_manager: string;
  status: "active" | "credit_hold";
}

interface OpenItem {
  item_id: string;
  customer_id: string;
  document_number: string;
  document_type: "invoice" | "credit_memo";
  document_date: string;
  due_date: string;
  currency: string;
  amount: number;
  open_amount: number;
  reference: string;
  dunning_level: number;
  note: string | null;
}

interface Material {
  material: string;
  description: string;
  type: "raw_material" | "purchased_part" | "finished_good" | "packaging" | "consumable";
  unit: string;
  material_group: string;
  plant: string;
  storage_location: string;
  unrestricted_stock: number;
  reserved: number;
  in_quality_inspection: number;
  reorder_point: number;
  safety_stock: number;
  standard_price: number;
  price_currency: string;
  last_movement_date: string;
}

interface SalesOrderLine {
  line: number;
  material: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  net_amount: number;
  delivered_quantity: number;
}

interface SalesOrder {
  order_number: string;
  customer_id: string;
  customer_name: string;
  customer_po: string;
  order_date: string;
  requested_delivery_date: string;
  status: "open" | "in_production" | "partially_delivered" | "delivered" | "invoiced" | "cancelled";
  currency: string;
  incoterms: string;
  payment_terms: string;
  sales_rep: string;
  lines: SalesOrderLine[];
  net_total: number;
  tax_amount: number;
  total: number;
}

interface GlBalance {
  key: string;
  period: string;
  account: string;
  name: string;
  name_tr: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  opening_balance: number;
  debit: number;
  credit: number;
  balance: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Demo data: Acme Endüstri A.Ş. (pumps & valves manufacturer, Gebze/Kocaeli)
// ---------------------------------------------------------------------------

const COMPANY_CODE = "1000";
const PLANT = "P100 Gebze Plant";
const TR_VAT = 0.2;

function poLines(lines: Array<[string | null, string, number, string, number, number?, number?]>): PoLine[] {
  return lines.map(([material, description, quantity, unit, unitPrice, received = 0, invoiced = 0], i) => ({
    line: (i + 1) * 10,
    material,
    description,
    quantity,
    unit,
    unit_price: unitPrice,
    net_amount: round2(quantity * unitPrice),
    received_quantity: received,
    invoiced_quantity: invoiced,
  }));
}

function soLines(lines: Array<[string | null, string, number, string, number, number]>): SalesOrderLine[] {
  return lines.map(([material, description, quantity, unit, unitPrice, delivered], i) => ({
    line: (i + 1) * 10,
    material,
    description,
    quantity,
    unit,
    unit_price: unitPrice,
    net_amount: round2(quantity * unitPrice),
    delivered_quantity: delivered,
  }));
}

function seed(today: Date): Record<string, object[]> {
  const { day, at } = relativeDates(today);

  const suppliers: Supplier[] = [
    s("SUP-1001", "Kaya Çelik Sanayi ve Ticaret A.Ş.", "5470321986", "Gebze", "TR", "Dilovası, Kocaeli", "Dilovası OSB 4. Cadde No:12, 41455 Dilovası/Kocaeli", "satis@kayacelik.example", "+90 262 555 01 10", makeIban("TR", "0006200012300006298512"), "TRY", "NET60", "Raw materials: steel sheet and coil", "Serdar Kaya", -1600),
    s("SUP-1002", "Anadolu Döküm Sanayi Ltd. Şti.", "0680451237", "Selçuk", "TR", "Konya", "Konya OSB 2. Kısım, Büyükkayacık Mah. 42300 Selçuklu/Konya", "info@anadoludokum.example", "+90 332 555 22 40", makeIban("TR", "0001000345000012876543"), "TRY", "NET45", "Castings: pump housings and impellers", "Fatma Yurt", -1400),
    s("SUP-1003", "Rheintal Hydraulik GmbH", "DE287654321", null, "DE", "Mannheim", "Industriestraße 48, 68169 Mannheim, Germany", "orders@rheintal-hydraulik.example", "+49 621 5550 3310", makeIban("DE", "670505050012345678"), "EUR", "NET30", "Hydraulic components", "Markus Vogel", -1100),
    s("SUP-1004", "Nordic Bearings AB", "SE556677889901", null, "SE", "Göteborg", "Hisingsgatan 21, 417 03 Göteborg, Sweden", "sales@nordicbearings.example", "+46 31 555 12 90", makeIban("SE", "50000000058398257466"), "EUR", "NET30", "Bearings and seals", "Elin Lindqvist", -980),
    s("SUP-1005", "Lombardia Valvole S.p.A.", "IT03918470171", null, "IT", "Brescia", "Via dell'Industria 112, 25030 Castel Mella (BS), Italy", "ordini@lombardiavalvole.example", "+39 030 555 7781", makeIban("IT", "X0542811101000000123456"), "EUR", "NET60", "Valve bodies and stainless castings", "Giulia Ferri", -1250),
    s("SUP-1006", "Polska Elektro Sp. z o.o.", "PL8971234567", null, "PL", "Wrocław", "ul. Fabryczna 16, 53-609 Wrocław, Poland", "export@polskaelektro.example", "+48 71 555 40 22", makeIban("PL", "109010140000071219812874"), "EUR", "NET45", "Electric motors", "Piotr Nowak", -760),
    s("SUP-1007", "Ege Ambalaj San. ve Tic. A.Ş.", "3250987614", "Kemalpaşa", "TR", "İzmir", "Kemalpaşa OSB, Atatürk Bulvarı No:88, 35730 Kemalpaşa/İzmir", "siparis@egeambalaj.example", "+90 232 555 67 30", makeIban("TR", "0006400000112233445566"), "TRY", "NET30", "Packaging", "Hülya Sezer", -1900),
    s("SUP-1008", "Voltek Otomasyon Sistemleri A.Ş.", "9230456781", "Ümraniye", "TR", "İstanbul", "Dudullu OSB, Nato Yolu Cad. No:265, 34775 Ümraniye/İstanbul", "teklif@voltek.example", "+90 216 555 90 12", makeIban("TR", "0004600098765432101234"), "TRY", "NET30", "Automation, PLC and commissioning services", "Kaan Ateş", -640),
    s("SUP-1009", "Delta Endüstriyel Gaz A.Ş.", "2940561238", "Gebze", "TR", "Gebze, Kocaeli", "Güzeller OSB, Aliağa Cad. No:5, 41400 Gebze/Kocaeli", "musteri@deltagaz.example", "+90 262 555 44 80", makeIban("TR", "0001200001357924680135"), "TRY", "NET30", "Industrial and welding gases", "Levent Uysal", -1300),
    s("SUP-1010", "Marmara Lojistik ve Taşımacılık A.Ş.", "6120873459", "Tuzla", "TR", "İstanbul", "Aydınlı Mah. Lojistik Cad. No:7, 34953 Tuzla/İstanbul", "operasyon@marmaralojistik.example", "+90 216 555 18 18", makeIban("TR", "0006700010002000300040"), "TRY", "NET15", "Freight and customs brokerage", "Cem Tan", -870),
    s("SUP-1011", "TechParts Europe B.V.", "NL812345678B01", null, "NL", "Eindhoven", "De Run 5410, 5504 DE Veldhoven, Netherlands", "orders@techparts-europe.example", "+31 40 555 2600", makeIban("NL", "ABNA0417164300"), "EUR", "NET30", "Sensors and spare parts", "Sanne de Vries", -420),
    s("SUP-1012", "Birlik Enerji Elektrik Perakende Satış A.Ş.", "1780345612", "Kocaeli", "TR", "Kocaeli", "Kozluk Mah. Enerji Cad. No:3, 41060 İzmit/Kocaeli", "kurumsal@birlikenerji.example", "+90 262 555 00 00", makeIban("TR", "0001500158007299887766"), "TRY", "NET15", "Utilities: electricity", "Kurumsal Müşteri Hizmetleri", -2400),
    {
      ...s("SUP-1013", "Yıldız Kırtasiye ve Ofis Malzemeleri Ltd. Şti.", "9876012345", "Kadıköy", "TR", "İstanbul", "Hasanpaşa Mah. Kurbağalıdere Sok. No:21, 34722 Kadıköy/İstanbul", "satis@yildizkirtasiye.example", "+90 216 555 73 73", makeIban("TR", "0011100000000012345678"), "TRY", "NET30", "Office supplies", "Oya Yıldız", -300),
      status: "blocked",
      block_reason: "Bank details changed by e-mail request; blocked until verified by call-back (fraud prevention).",
    },
  ];

  function s(
    id: string,
    name: string,
    taxId: string,
    taxOffice: string | null,
    country: string,
    city: string,
    address: string,
    mail: string,
    phone: string,
    iban: string,
    currency: string,
    terms: string,
    category: string,
    contact: string,
    createdOffset: number,
  ): Supplier {
    return {
      supplier_id: id,
      name,
      tax_id: taxId,
      tax_office: taxOffice,
      country,
      city,
      address,
      email: mail,
      phone,
      iban,
      currency,
      payment_terms: terms,
      category,
      status: "active",
      block_reason: null,
      contact_person: contact,
      created_at: at(createdOffset),
    };
  }

  const supplierName = (id: string) => suppliers.find((x) => x.supplier_id === id)?.name ?? id;

  const po = (
    number: string,
    supplierId: string,
    orderOffset: number,
    deliveryOffset: number,
    status: PoStatus,
    currency: string,
    buyer: string,
    lines: PoLine[],
  ): PurchaseOrder => {
    const supplier = suppliers.find((x) => x.supplier_id === supplierId);
    const net = sum(lines.map((l) => l.net_amount));
    const taxRate = supplier?.country === "TR" ? TR_VAT : 0;
    const tax = round2(net * taxRate);
    return {
      po_number: number,
      supplier_id: supplierId,
      supplier_name: supplierName(supplierId),
      company_code: COMPANY_CODE,
      plant: PLANT,
      buyer,
      order_date: day(orderOffset),
      delivery_date: day(deliveryOffset),
      status,
      currency,
      payment_terms: supplier?.payment_terms ?? "NET30",
      lines,
      net_total: net,
      tax_rate: taxRate,
      tax_amount: tax,
      total: round2(net + tax),
      created_at: at(orderOffset, 8, 30),
    };
  };

  const purchaseOrders: PurchaseOrder[] = [
    // Fully received, not yet invoiced: a correct invoice matches (718,500.00 + 20% KDV).
    po("PO-4500012", "SUP-1001", -35, -12, "received", "TRY", "Ayşe Kaya", poLines([
      ["MAT-10001", "Steel sheet S235JR 3 mm, 1500x3000", 12000, "KG", 38.5, 12000],
      ["MAT-10002", "Steel sheet S355J2 5 mm, 1500x3000", 6000, "KG", 42.75, 6000],
    ])),
    // Fully received: an invoice at a higher unit price is a price mismatch.
    po("PO-4500013", "SUP-1003", -40, -9, "received", "EUR", "Ayşe Kaya", poLines([
      ["MAT-10004", "Hydraulic cylinder 50/30-200, double acting", 40, "PC", 285, 40],
      ["MAT-10009", "Mechanical seal kit 35 mm", 40, "PC", 18.4, 40],
    ])),
    // Partially received: invoicing the full order value is a quantity mismatch.
    po("PO-4500014", "SUP-1004", -28, -6, "partially_received", "EUR", "Ayşe Kaya", poLines([
      ["MAT-10005", "Deep groove ball bearing 6205-2RS", 2000, "PC", 2.35, 1200],
      ["MAT-10006", "Deep groove ball bearing 6306-2Z", 800, "PC", 5.1, 800],
    ])),
    po("PO-4500015", "SUP-1002", -18, 10, "open", "TRY", "Ayşe Kaya", poLines([
      ["MAT-10003", "Pump housing DN80, ductile iron EN-GJS-400-15, machined", 150, "PC", 1450],
    ])),
    po("PO-4500016", "SUP-1005", -75, -48, "closed", "EUR", "Ayşe Kaya", poLines([
      ["MAT-10007", "Valve body DN50, stainless steel 1.4408", 300, "PC", 64, 300, 300],
    ])),
    po("PO-4500017", "SUP-1007", -60, -52, "closed", "TRY", "Murat Kılıç", poLines([
      ["MAT-10010", "Corrugated carton box 60x40x40, double wall", 3000, "PC", 14.2, 3000, 3000],
    ])),
    po("PO-4500018", "SUP-1008", -14, 21, "open", "TRY", "Ayşe Kaya", poLines([
      ["MAT-10012", "PLC CPU module 14DI/10DO, 24 V DC", 4, "PC", 14800],
      [null, "Commissioning and PLC programming, test bench line 2", 16, "H", 2400],
    ])),
    po("PO-4500019", "SUP-1006", -45, -15, "partially_received", "EUR", "Ayşe Kaya", poLines([
      ["MAT-10008", "Electric motor 7.5 kW IE3, 4-pole, B35", 24, "PC", 610, 12, 12],
    ])),
    po("PO-4500020", "SUP-1009", -30, -22, "received", "TRY", "Deniz Çelik", poLines([
      ["MAT-10011", "Argon 4.6 gas cylinder, 50 L", 20, "PC", 1150, 20],
    ])),
    po("PO-4500021", "SUP-1010", -26, -19, "closed", "TRY", "Murat Kılıç", poLines([
      [null, "Road freight Gebze to Hamburg (FTL), shipment for SO-7000121", 1, "LS", 96000, 1, 1],
      [null, "Export customs brokerage", 1, "LS", 8500, 1, 1],
    ])),
    po("PO-4500022", "SUP-1011", -3, 18, "awaiting_approval", "EUR", "Ayşe Kaya", poLines([
      [null, "Pressure transmitter 0-16 bar, 4-20 mA, G1/4", 25, "PC", 74],
      [null, "Vibration sensor, industrial, M12 connector", 10, "PC", 189],
    ])),
    po("PO-4500023", "SUP-1001", -2, 21, "open", "TRY", "Ayşe Kaya", poLines([
      ["MAT-10001", "Steel sheet S235JR 3 mm, 1500x3000", 8000, "KG", 39.2],
    ])),
  ];

  const invoice = (
    invoiceNumber: string,
    documentNumber: string,
    supplierId: string,
    poNumber: string | null,
    invoiceOffset: number,
    currency: string,
    net: number,
    tax: number,
    status: InvoiceStatus,
    matchStatus: MatchStatus,
    matchDetails: string,
    history: Array<[number, InvoiceStatus, string | null]>,
  ): SupplierInvoice => {
    const supplier = suppliers.find((x) => x.supplier_id === supplierId);
    const invoiceDate = day(invoiceOffset);
    const paidEntry = history.find(([, st]) => st === "paid");
    return {
      invoice_number: invoiceNumber,
      document_number: documentNumber,
      supplier_id: supplierId,
      supplier_name: supplierName(supplierId),
      po_number: poNumber,
      invoice_date: invoiceDate,
      posting_date: day(invoiceOffset + 2),
      due_date: toIsoDate(addDays(new Date(`${invoiceDate}T00:00:00Z`), termsDays(supplier?.payment_terms ?? "NET30"))),
      currency,
      net_amount: net,
      tax_amount: tax,
      total_amount: round2(net + tax),
      status,
      match_status: matchStatus,
      match_details: matchDetails,
      payment_block: status === "blocked" || status === "parked" || status === "on_hold",
      paid_at: paidEntry ? at(paidEntry[0], 10) : null,
      history: history.map(([offset, st, note]) => ({ at: at(offset, 10), status: st, note })),
      created_at: at(invoiceOffset + 2, 9),
    };
  };

  const supplierInvoices: SupplierInvoice[] = [
    invoice("LV-2231/INV", "5105600101", "SUP-1005", "PO-4500016", -50, "EUR", 19200, 0, "paid", "matched", "Invoice matches goods receipt of PO-4500016 (300 PC at 64.00 EUR).", [
      [-48, "posted", "3-way match OK"],
      [-6, "paid", "Paid with payment run F110 (SEPA)"],
    ]),
    invoice("EGA2026000000318", "5105600102", "SUP-1007", "PO-4500017", -55, "TRY", 42600, 8520, "paid", "matched", "Invoice matches goods receipt of PO-4500017.", [
      [-53, "posted", "3-way match OK"],
      [-24, "paid", "Paid by EFT"],
    ]),
    invoice("DEG2026000001142", "5105600103", "SUP-1009", "PO-4500020", -20, "TRY", 25300, 5060, "blocked", "price_mismatch", "Invoiced net 25,300.00 TRY vs. 23,000.00 TRY expected from PO-4500020 (+2,300.00 TRY, +10.0%): unit price 1,265.00 instead of 1,150.00 TRY.", [
      [-18, "blocked", "Price variance above tolerance; buyer asked for credit note"],
    ]),
    invoice("FV/0615/PE", "5105600104", "SUP-1006", "PO-4500019", -12, "EUR", 7320, 0, "posted", "matched", "Invoice matches goods receipt of PO-4500019 (12 of 24 motors delivered).", [
      [-10, "posted", "3-way match OK"],
    ]),
    invoice("MLT2026000002207", "5105600105", "SUP-1010", "PO-4500021", -17, "TRY", 104500, 20900, "approved", "matched", "Invoice matches service entry of PO-4500021.", [
      [-15, "posted", "3-way match OK"],
      [-14, "approved", "Approved for payment run"],
    ]),
    invoice("BEP2026000009876", "5105600106", "SUP-1012", null, -9, "TRY", 186400, 37280, "parked", "no_po", "No purchase order reference (utility invoice). Parked for approval by the cost-centre owner (4100 Plant maintenance).", [
      [-7, "parked", "Electricity, plant P100, previous month"],
    ]),
    invoice("INV-88390", "5105600107", "SUP-1011", null, -33, "EUR", 1240, 0, "rejected", "no_po", "No purchase order reference.", [
      [-31, "parked", null],
      [-29, "rejected", "Duplicate of INV-88377, which was already paid"],
    ]),
    invoice("RH-240871", "5105600108", "SUP-1003", null, -70, "EUR", 3860, 0, "paid", "no_po", "No purchase order reference (emergency repair of hydraulic press cylinder).", [
      [-68, "parked", null],
      [-66, "approved", "Approved by plant manager Burak Şahin"],
      [-38, "paid", "Paid with payment run F110 (SEPA)"],
    ]),
  ];

  const customers: Customer[] = [
    c("CUST-2001", "Boğaziçi Su Teknolojileri A.Ş.", "TR", "İstanbul", "1870452390", "satinalma@bogazicisu.example", "+90 212 555 31 00", "TRY", "NET30", 3_000_000, "Distributor", "Ali Yıldız"),
    c("CUST-2002", "Hansa Pumpen Vertrieb GmbH", "DE", "Hamburg", "DE312456789", "einkauf@hansa-pumpen.example", "+49 40 5550 7120", "EUR", "NET30", 250_000, "Distributor", "Thomas Weber"),
    c("CUST-2003", "Iberica Fluid Systems S.L.", "ES", "Valencia", "ESB98765432", "compras@ibericafluid.example", "+34 96 555 4410", "EUR", "NET30", 120_000, "OEM", "Laura Rossi"),
    c("CUST-2004", "Gulf Water Solutions LLC", "AE", "Dubai", "100345678900003", "procurement@gulfwater.example", "+971 4 555 8820", "USD", "NET60", 200_000, "EPC contractor", "Laura Rossi"),
    c("CUST-2005", "Anadolu Agro Sulama A.Ş.", "TR", "Konya", "0730918276", "muhasebe@anadoluagro.example", "+90 332 555 65 43", "TRY", "NET30", 750_000, "End user: agriculture", "Ali Yıldız"),
    c("CUST-2006", "Petrokim Rafineri A.Ş.", "TR", "İzmit, Kocaeli", "7231904568", "tedarik@petrokim.example", "+90 262 555 90 90", "TRY", "NET60", 4_000_000, "End user: refinery", "Ali Yıldız"),
    c("CUST-2007", "Balkan Industrial Supply d.o.o.", "RS", "Belgrade", "RS109876543", "office@balkanindustrial.example", "+381 11 555 2230", "EUR", "NET45", 60_000, "Distributor", "Laura Rossi"),
    c("CUST-2008", "Nordwind Energy A/S", "DK", "Esbjerg", "DK38291047", "purchasing@nordwind-energy.example", "+45 75 55 12 00", "EUR", "NET30", 400_000, "OEM", "Thomas Weber"),
    c("CUST-2009", "Kuzey Gıda Üretim A.Ş.", "TR", "Samsun", "5640218937", "satinalma@kuzeygida.example", "+90 362 555 20 10", "TRY", "NET30", 500_000, "End user: food & beverage", "Ali Yıldız"),
    { ...c("CUST-2010", "Atlas Mining Maroc S.A.", "MA", "Casablanca", "MA001928374", "achats@atlasmining.example", "+212 522 555 610", "EUR", "NET60", 50_000, "End user: mining", "Laura Rossi"), status: "credit_hold" },
    c("CUST-2011", "Ege Sulama Sistemleri Ltd. Şti.", "TR", "İzmir", "3310874526", "info@egesulama.example", "+90 232 555 48 48", "TRY", "NET30", 300_000, "Distributor", "Ali Yıldız"),
    c("CUST-2012", "Polimer Plastik Sanayi A.Ş.", "TR", "Bursa", "7310562984", "satinalma@polimerplastik.example", "+90 224 555 11 22", "TRY", "NET30", 400_000, "End user: plastics", "Ali Yıldız"),
  ];

  function c(
    id: string,
    name: string,
    country: string,
    city: string,
    taxId: string,
    mail: string,
    phone: string,
    currency: string,
    terms: string,
    creditLimit: number,
    segment: string,
    manager: string,
  ): Customer {
    return {
      customer_id: id,
      name,
      country,
      city,
      tax_id: taxId,
      email: mail,
      phone,
      currency,
      payment_terms: terms,
      credit_limit: creditLimit,
      segment,
      account_manager: manager,
      status: "active",
    };
  }

  const item = (
    id: string,
    customerId: string,
    document: string,
    type: OpenItem["document_type"],
    docOffset: number,
    dueOffset: number,
    currency: string,
    amount: number,
    open: number,
    reference: string,
    dunning: number,
    note: string | null = null,
  ): OpenItem => ({
    item_id: id,
    customer_id: customerId,
    document_number: document,
    document_type: type,
    document_date: day(docOffset),
    due_date: day(dueOffset),
    currency,
    amount,
    open_amount: open,
    reference,
    dunning_level: dunning,
    note,
  });

  const openItems: OpenItem[] = [
    item("AR-900101", "CUST-2001", "ACM-F-00341", "invoice", -42, -12, "TRY", 1_281_600, 1_281_600, "SO-7000124", 1),
    item("AR-900102", "CUST-2001", "ACM-F-00368", "invoice", -12, 18, "TRY", 642_000, 642_000, "SO-7000119", 0),
    item("AR-900103", "CUST-2002", "ACM-F-00352", "invoice", -33, -3, "EUR", 86_400, 86_400, "SO-7000121", 0),
    item("AR-900104", "CUST-2002", "ACM-F-00371", "invoice", -3, 27, "EUR", 43_200, 43_200, "SO-7000120", 0),
    item("AR-900105", "CUST-2002", "ACM-C-00012", "credit_memo", -20, -20, "EUR", -2_160, -2_160, "SO-7000121", 0, "Credit for damaged packaging (CASE-7006)"),
    item("AR-900106", "CUST-2003", "ACM-F-00329", "invoice", -75, -45, "EUR", 58_750, 58_750, "SO-7000109", 2),
    item("AR-900107", "CUST-2004", "ACM-F-00334", "invoice", -131, -71, "USD", 124_800, 64_800, "SO-7000127", 3, "Partial payment of 60,000.00 USD received"),
    item("AR-900108", "CUST-2005", "ACM-F-00360", "invoice", -25, 5, "TRY", 398_400, 398_400, "SO-7000128", 0),
    item("AR-900109", "CUST-2006", "ACM-F-00301", "invoice", -156, -96, "TRY", 2_449_800, 2_449_800, "SO-7000125", 0, "Disputed: pump vibration complaint CASE-7003; dunning blocked"),
    item("AR-900110", "CUST-2006", "ACM-F-00375", "invoice", -20, 40, "TRY", 815_000, 815_000, "SO-7000118", 0),
    item("AR-900111", "CUST-2007", "ACM-F-00357", "invoice", -65, -20, "EUR", 21_900, 21_900, "SO-7000122", 1),
    item("AR-900112", "CUST-2008", "ACM-F-00363", "invoice", -18, 12, "EUR", 312_000, 312_000, "SO-7000123", 0),
    item("AR-900113", "CUST-2009", "ACM-F-00340", "invoice", -38, -8, "TRY", 176_280, 176_280, "SO-7000115", 0),
    item("AR-900114", "CUST-2010", "ACM-F-00318", "invoice", -190, -130, "EUR", 47_600, 47_600, "SO-7000102", 3, "Handed over to collection agency; customer on credit hold"),
    item("AR-900115", "CUST-2012", "ACM-F-00372", "invoice", -5, 25, "TRY", 94_800, 94_800, "SO-7000117", 0),
    item("AR-900116", "CUST-2005", "ACM-F-00349", "invoice", -55, -25, "TRY", 156_000, 56_000, "SO-7000111", 1, "Partial payment of 100,000.00 TRY received"),
  ];

  const m = (
    id: string,
    description: string,
    type: Material["type"],
    unit: string,
    group: string,
    location: string,
    stock: number,
    reserved: number,
    qi: number,
    reorder: number,
    safety: number,
    price: number,
    currency: string,
    lastMovement: number,
  ): Material => ({
    material: id,
    description,
    type,
    unit,
    material_group: group,
    plant: PLANT,
    storage_location: location,
    unrestricted_stock: stock,
    reserved,
    in_quality_inspection: qi,
    reorder_point: reorder,
    safety_stock: safety,
    standard_price: price,
    price_currency: currency,
    last_movement_date: day(lastMovement),
  });

  const materials: Material[] = [
    m("MAT-10001", "Steel sheet S235JR 3 mm, 1500x3000", "raw_material", "KG", "Steel sheet", "RM01 Raw material store", 18_450, 6_000, 0, 10_000, 4_000, 38.5, "TRY", -1),
    m("MAT-10002", "Steel sheet S355J2 5 mm, 1500x3000", "raw_material", "KG", "Steel sheet", "RM01 Raw material store", 7_200, 2_500, 0, 5_000, 2_000, 42.75, "TRY", -3),
    m("MAT-10003", "Pump housing DN80, ductile iron EN-GJS-400-15, machined", "purchased_part", "PC", "Castings", "RM02 Castings", 64, 40, 6, 60, 20, 1450, "TRY", -2),
    m("MAT-10004", "Hydraulic cylinder 50/30-200, double acting", "purchased_part", "PC", "Hydraulics", "RM03 Components", 12, 8, 0, 20, 6, 285, "EUR", -9),
    m("MAT-10005", "Deep groove ball bearing 6205-2RS", "purchased_part", "PC", "Bearings", "RM03 Components", 1_850, 400, 0, 1_000, 400, 2.35, "EUR", -6),
    m("MAT-10006", "Deep groove ball bearing 6306-2Z", "purchased_part", "PC", "Bearings", "RM03 Components", 620, 150, 0, 400, 150, 5.1, "EUR", -6),
    m("MAT-10007", "Valve body DN50, stainless steel 1.4408", "purchased_part", "PC", "Castings", "RM02 Castings", 210, 120, 0, 150, 50, 64, "EUR", -4),
    m("MAT-10008", "Electric motor 7.5 kW IE3, 4-pole, B35", "purchased_part", "PC", "Motors", "RM03 Components", 9, 8, 0, 12, 4, 610, "EUR", -15),
    m("MAT-10009", "Mechanical seal kit 35 mm", "purchased_part", "PC", "Seals", "RM03 Components", 140, 60, 0, 80, 30, 18.4, "EUR", -9),
    m("MAT-10010", "Corrugated carton box 60x40x40, double wall", "packaging", "PC", "Packaging", "PK01 Packaging", 2_300, 0, 0, 1_500, 500, 14.2, "TRY", -5),
    m("MAT-10011", "Argon 4.6 gas cylinder, 50 L", "consumable", "PC", "Welding consumables", "CS01 Consumables", 18, 0, 0, 10, 4, 1150, "TRY", -22),
    m("MAT-10012", "PLC CPU module 14DI/10DO, 24 V DC", "purchased_part", "PC", "Automation", "RM03 Components", 6, 2, 0, 5, 2, 14_800, "TRY", -40),
    m("FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", "finished_good", "PC", "Pumps", "FG01 Finished goods", 38, 30, 4, 25, 10, 42_500, "TRY", -1),
    m("FG-20002", "Ball valve AV-50 PN16, stainless steel", "finished_good", "PC", "Valves", "FG01 Finished goods", 420, 250, 0, 300, 100, 3_950, "TRY", -2),
    m("FG-20003", "Pump skid package PS-200 (2x ACP-80, VFD, controls)", "finished_good", "PC", "Pump systems", "FG02 Large assemblies", 2, 2, 0, 0, 0, 7_450_000, "TRY", -18),
    m("FG-20004", "Spare part kit ACP-80 (seals, bearings, gaskets)", "finished_good", "PC", "Spare parts", "FG01 Finished goods", 160, 70, 0, 100, 40, 2_150, "TRY", -1),
  ];

  const so = (
    number: string,
    customerId: string,
    customerPo: string,
    orderOffset: number,
    deliveryOffset: number,
    status: SalesOrder["status"],
    incoterms: string,
    lines: SalesOrderLine[],
  ): SalesOrder => {
    const customer = customers.find((x) => x.customer_id === customerId);
    const net = sum(lines.map((l) => l.net_amount));
    const tax = customer?.country === "TR" ? round2(net * TR_VAT) : 0;
    return {
      order_number: number,
      customer_id: customerId,
      customer_name: customer?.name ?? customerId,
      customer_po: customerPo,
      order_date: day(orderOffset),
      requested_delivery_date: day(deliveryOffset),
      status,
      currency: customer?.currency ?? "TRY",
      incoterms,
      payment_terms: customer?.payment_terms ?? "NET30",
      sales_rep: customer?.account_manager ?? "Ali Yıldız",
      lines,
      net_total: net,
      tax_amount: tax,
      total: round2(net + tax),
    };
  };

  const salesOrders: SalesOrder[] = [
    so("SO-7000121", "CUST-2002", "HP-4711-0932", -58, -35, "invoiced", "DAP Hamburg", soLines([
      ["FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", 72, "PC", 1150, 72],
      ["FG-20004", "Spare part kit ACP-80", 60, "PC", 60, 60],
    ])),
    so("SO-7000122", "CUST-2007", "BIS-2291", -80, -66, "invoiced", "FCA Gebze", soLines([
      ["FG-20002", "Ball valve AV-50 PN16, stainless steel", 200, "PC", 109.5, 200],
    ])),
    so("SO-7000123", "CUST-2008", "NWE-PO-55012", -95, -20, "invoiced", "DAP Esbjerg", soLines([
      ["FG-20003", "Pump skid package PS-200", 1, "PC", 260_000, 1],
      [null, "Commissioning and site acceptance test", 1, "LS", 52_000, 1],
    ])),
    so("SO-7000124", "CUST-2001", "BST-2026-0418", -60, -44, "invoiced", "EXW Gebze", soLines([
      ["FG-20002", "Ball valve AV-50 PN16, stainless steel", 240, "PC", 4450, 240],
    ])),
    so("SO-7000125", "CUST-2006", "PKR-4500871", -175, -158, "invoiced", "DAP İzmit", soLines([
      ["FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", 30, "PC", 58_500, 30],
      ["FG-20004", "Spare part kit ACP-80", 120, "PC", 2387.5, 120],
    ])),
    so("SO-7000126", "CUST-2003", "IFS-PO-30177", -30, -5, "partially_delivered", "CPT Valencia", soLines([
      ["FG-20002", "Ball valve AV-50 PN16, stainless steel", 500, "PC", 96, 300],
      ["FG-20004", "Spare part kit ACP-80", 100, "PC", 62, 100],
    ])),
    so("SO-7000127", "CUST-2004", "GWS/PO/2291", -150, -133, "invoiced", "CIF Jebel Ali", soLines([
      ["FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", 80, "PC", 1560, 80],
    ])),
    so("SO-7000128", "CUST-2005", "AAS-0912", -35, -26, "invoiced", "DAP Konya", soLines([
      ["FG-20002", "Ball valve AV-50 PN16, stainless steel", 80, "PC", 4150, 80],
    ])),
    so("SO-7000129", "CUST-2009", "KG-SA-7781", -10, 14, "in_production", "DAP Samsun", soLines([
      ["FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", 4, "PC", 49_800, 0],
      ["FG-20004", "Spare part kit ACP-80", 8, "PC", 2450, 0],
    ])),
    so("SO-7000130", "CUST-2002", "HP-4711-1015", -4, 45, "open", "DAP Hamburg", soLines([
      ["FG-20001", "Centrifugal pump ACP-80, 7.5 kW, cast iron", 120, "PC", 1150, 0],
    ])),
  ];

  return {
    suppliers,
    purchase_orders: purchaseOrders,
    supplier_invoices: supplierInvoices,
    customers,
    open_items: openItems,
    materials,
    sales_orders: salesOrders,
    gl_balances: generateTrialBalances(today),
  };
}

// ---------------------------------------------------------------------------
// Trial balance: three closed periods generated from balanced journal entries
// (Turkish uniform chart of accounts), so debits always equal credits.
// ---------------------------------------------------------------------------

const GL_ACCOUNTS: Array<[string, string, string, GlBalance["type"]]> = [
  ["100", "Cash", "Kasa", "asset"],
  ["102", "Banks", "Bankalar", "asset"],
  ["120", "Trade receivables", "Alıcılar", "asset"],
  ["150", "Raw materials and supplies", "İlk Madde ve Malzeme", "asset"],
  ["152", "Finished goods", "Mamuller", "asset"],
  ["191", "Deductible VAT", "İndirilecek KDV", "asset"],
  ["253", "Plant, machinery and equipment", "Tesis, Makine ve Cihazlar", "asset"],
  ["257", "Accumulated depreciation", "Birikmiş Amortismanlar", "asset"],
  ["320", "Trade payables", "Satıcılar", "liability"],
  ["335", "Payables to employees", "Personele Borçlar", "liability"],
  ["360", "Taxes and funds payable", "Ödenecek Vergi ve Fonlar", "liability"],
  ["391", "Output VAT", "Hesaplanan KDV", "liability"],
  ["500", "Share capital", "Sermaye", "equity"],
  ["570", "Retained earnings", "Geçmiş Yıllar Kârları", "equity"],
  ["600", "Domestic sales", "Yurt İçi Satışlar", "revenue"],
  ["601", "Export sales", "Yurt Dışı Satışlar", "revenue"],
  ["620", "Cost of goods sold", "Satılan Mamuller Maliyeti", "expense"],
  ["631", "Selling and distribution expenses", "Pazarlama, Satış ve Dağıtım Giderleri", "expense"],
  ["632", "General administrative expenses", "Genel Yönetim Giderleri", "expense"],
  ["646", "Foreign exchange gains", "Kambiyo Kârları", "revenue"],
  ["660", "Short-term finance expenses", "Kısa Vadeli Borçlanma Giderleri", "expense"],
];

const OPENING_BALANCES: Record<string, number> = {
  "100": 185_000,
  "102": 18_450_000,
  "120": 42_300_000,
  "150": 23_800_000,
  "152": 16_900_000,
  "191": 3_150_000,
  "253": 96_000_000,
  "257": -31_200_000,
  "320": -28_600_000,
  "335": -6_400_000,
  "360": -2_850_000,
  "391": -4_700_000,
  "500": -75_000_000,
  "570": -52_035_000,
};

/** Journal entries of one month; each entry is [account, debit, credit][] and balances by construction. */
function monthlyEntries(factor: number): Array<Array<[string, number, number]>> {
  const r = (v: number) => Math.round(v);
  const domestic = r(31_500_000 * factor);
  const exportSales = r(18_200_000 * factor);
  const sales = domestic + exportSales;
  const outputVat = r(domestic * TR_VAT);
  const purchases = r(sales * 0.52);
  const inputVat = r(purchases * TR_VAT);
  const materialsUsed = r(sales * 0.5);
  const labour = r(sales * 0.09);
  const depreciation = 800_000;
  const cogs = r(sales * 0.66);
  const selling = r(sales * 0.045);
  const admin = r(sales * 0.05);
  const payroll = r((labour + admin) * 0.98);
  const collections = r((domestic + outputVat + exportSales) * 0.96);
  const supplierPayments = r((purchases + inputVat + selling) * 0.93);
  const taxPayments = r(2_600_000 * factor);
  const fx = r(exportSales * 0.012);
  return [
    [["120", domestic + outputVat, 0], ["600", 0, domestic], ["391", 0, outputVat]],
    [["120", exportSales, 0], ["601", 0, exportSales]],
    [["150", purchases, 0], ["191", inputVat, 0], ["320", 0, purchases + inputVat]],
    [["152", materialsUsed, 0], ["150", 0, materialsUsed]],
    [["152", labour, 0], ["335", 0, labour]],
    [["152", depreciation * 0.75, 0], ["632", depreciation * 0.25, 0], ["257", 0, depreciation]],
    [["620", cogs, 0], ["152", 0, cogs]],
    [["631", selling, 0], ["320", 0, selling]],
    [["632", admin, 0], ["335", 0, admin]],
    [["335", payroll, 0], ["102", 0, r(payroll * 0.72)], ["360", 0, payroll - r(payroll * 0.72)]],
    [["102", collections, 0], ["120", 0, collections]],
    [["320", supplierPayments, 0], ["102", 0, supplierPayments]],
    [["391", outputVat, 0], ["191", 0, inputVat], ["360", 0, outputVat - inputVat]],
    [["360", taxPayments, 0], ["102", 0, taxPayments]],
    [["660", 410_000, 0], ["102", 0, 410_000]],
    [["120", fx, 0], ["646", 0, fx]],
    [["632", 35_000, 0], ["100", 0, 35_000]],
    [["100", 40_000, 0], ["102", 0, 40_000]],
  ];
}

function generateTrialBalances(today: Date): GlBalance[] {
  const factors = [0.94, 1.03, 1.08];
  const balances = new Map<string, number>(GL_ACCOUNTS.map(([account]) => [account, OPENING_BALANCES[account] ?? 0]));
  const rows: GlBalance[] = [];
  factors.forEach((factor, index) => {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - factors.length + index, 1));
    const period = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`;
    const debit = new Map<string, number>();
    const credit = new Map<string, number>();
    for (const entry of monthlyEntries(factor)) {
      for (const [account, dr, cr] of entry) {
        debit.set(account, (debit.get(account) ?? 0) + dr);
        credit.set(account, (credit.get(account) ?? 0) + cr);
      }
    }
    for (const [account, name, nameTr, type] of GL_ACCOUNTS) {
      const opening = balances.get(account) ?? 0;
      const dr = round2(debit.get(account) ?? 0);
      const cr = round2(credit.get(account) ?? 0);
      const closing = round2(opening + dr - cr);
      balances.set(account, closing);
      rows.push({
        key: `${period}:${account}`,
        period,
        account,
        name,
        name_tr: nameTr,
        type,
        opening_balance: opening,
        debit: dr,
        credit: cr,
        balance: closing,
        currency: "TRY",
      });
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

function termsDays(terms: string): number {
  const match = /(\d+)\s*$/.exec(terms);
  return match ? Number(match[1]) : 30;
}

function supplierSummary(supplier: Supplier): Rec {
  return {
    supplier_id: supplier.supplier_id,
    name: supplier.name,
    tax_id: supplier.tax_id,
    country: supplier.country,
    city: supplier.city,
    email: supplier.email,
    currency: supplier.currency,
    payment_terms: supplier.payment_terms,
    category: supplier.category,
    status: supplier.status,
  };
}

function poValues(po: PurchaseOrder): Rec {
  const value = (qty: (l: PoLine) => number) => sum(po.lines.map((l) => qty(l) * l.unit_price));
  return {
    received_value: value((l) => l.received_quantity),
    invoiced_value: value((l) => l.invoiced_quantity),
    open_to_invoice_value: value((l) => Math.max(0, l.received_quantity - l.invoiced_quantity)),
    open_to_receive_value: value((l) => Math.max(0, l.quantity - l.received_quantity)),
  };
}

function invoiceStatusView(inv: SupplierInvoice): Rec {
  return {
    invoice_number: inv.invoice_number,
    document_number: inv.document_number,
    supplier_id: inv.supplier_id,
    supplier_name: inv.supplier_name,
    po_number: inv.po_number,
    status: inv.status,
    match_status: inv.match_status,
    match_details: inv.match_details,
    payment_block: inv.payment_block,
    invoice_date: inv.invoice_date,
    posting_date: inv.posting_date,
    due_date: inv.due_date,
    currency: inv.currency,
    net_amount: inv.net_amount,
    tax_amount: inv.tax_amount,
    total_amount: inv.total_amount,
    paid_at: inv.paid_at,
    history: inv.history,
  };
}

interface MatchResult {
  status: MatchStatus;
  details: string;
  expected_net_amount: number | null;
  ordered_open_amount: number | null;
  invoiced_net_amount: number;
  difference: number | null;
  difference_percent: number | null;
  tolerance: number | null;
  /** Line numbers of the PO the invoice is matched against (matched invoices only). */
  matched_lines: number[];
}

const fmt = (value: number, currency: string) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Finds PO lines whose open (received, not invoiced) values add up to `target` within `tolerance`. */
function findLineSubset(lines: Array<{ line: number; value: number }>, target: number, tolerance: number): number[] | undefined {
  const candidates = lines.filter((l) => l.value > 0).slice(0, 12);
  for (let mask = 1; mask < 1 << candidates.length; mask++) {
    let total = 0;
    const picked: number[] = [];
    candidates.forEach((l, i) => {
      if (mask & (1 << i)) {
        total += l.value;
        picked.push(l.line);
      }
    });
    if (Math.abs(total - target) <= tolerance) return picked;
  }
  return undefined;
}

/**
 * Header-level 3-way match (PO price x goods receipt vs. invoice): the invoiced
 * net amount is compared with the value of goods received but not yet invoiced
 * (tolerance 0.5%, at least 1.00). Above that value but within the ordered
 * value it is a quantity mismatch (billing goods not received or already
 * invoiced), beyond the ordered value a price mismatch.
 */
function threeWayMatch(po: PurchaseOrder | undefined, currency: string, net: number): MatchResult {
  const base = { invoiced_net_amount: net, matched_lines: [] as number[] };
  if (!po) {
    return {
      ...base,
      status: "no_po",
      details: "No purchase order reference: invoice parked for approval by the cost-centre owner.",
      expected_net_amount: null,
      ordered_open_amount: null,
      difference: null,
      difference_percent: null,
      tolerance: null,
    };
  }
  const receivedOpen = po.lines.map((l) => ({
    line: l.line,
    value: round2(Math.max(0, l.received_quantity - l.invoiced_quantity) * l.unit_price),
  }));
  const expected = sum(receivedOpen.map((l) => l.value));
  const orderedOpen = sum(po.lines.map((l) => Math.max(0, l.quantity - l.invoiced_quantity) * l.unit_price));
  const orderedTotal = sum(po.lines.map((l) => l.quantity * l.unit_price));
  const tolerance = round2(Math.max(1, expected * 0.005));
  const difference = round2(net - expected);
  const differencePercent = expected > 0 ? round2((difference / expected) * 100) : null;
  const common = { ...base, expected_net_amount: expected, ordered_open_amount: orderedOpen, difference, difference_percent: differencePercent, tolerance };

  if (currency !== po.currency) {
    return {
      ...common,
      status: "price_mismatch",
      details: `Invoice currency ${currency} differs from ${po.po_number} currency ${po.currency}.`,
    };
  }
  if (Math.abs(difference) <= tolerance) {
    return {
      ...common,
      status: "matched",
      details: `Invoice matches the goods received on ${po.po_number}: ${fmt(net, currency)} vs. ${fmt(expected, currency)} expected.`,
      matched_lines: receivedOpen.filter((l) => l.value > 0).map((l) => l.line),
    };
  }
  if (net < expected) {
    const subset = findLineSubset(receivedOpen, net, tolerance);
    if (subset) {
      return {
        ...common,
        status: "matched",
        details: `Partial invoice: matches received lines ${subset.join(", ")} of ${po.po_number}.`,
        matched_lines: subset,
      };
    }
    return {
      ...common,
      status: "price_mismatch",
      details: `Invoiced net ${fmt(net, currency)} is below the ${fmt(expected, currency)} of received goods on ${po.po_number} and does not correspond to whole PO lines: check unit prices.`,
    };
  }
  if (net <= orderedTotal + tolerance) {
    return {
      ...common,
      status: "quantity_mismatch",
      details: `Invoice bills quantities that were not received or were already invoiced: invoiced net ${fmt(net, currency)}, but only ${fmt(expected, currency)} of ${po.po_number} has been received and not yet invoiced (ordered and not yet invoiced: ${fmt(orderedOpen, currency)}).`,
    };
  }
  const percent = differencePercent === null ? "" : ` (${differencePercent > 0 ? "+" : ""}${differencePercent.toFixed(1)}%)`;
  return {
    ...common,
    status: "price_mismatch",
    details: `Invoiced net ${fmt(net, currency)} exceeds the value expected from ${po.po_number} (${fmt(expected, currency)}) by ${fmt(difference, currency)}${percent}: price variance above tolerance.`,
  };
}

/** Business key as stored ("PO-4500012"); bare numbers such as "4500012" get the prefix added. */
function erpId(value: string, prefix: string): string {
  const id = value.trim().toUpperCase();
  return /^\d+$/.test(id) ? `${prefix}${id}` : id;
}

async function findSupplier(db: SandboxDb, id: string): Promise<Supplier> {
  return db.require<Supplier>("suppliers", erpId(id, "SUP-"), "Supplier");
}

async function findInvoice(db: SandboxDb, invoiceNumber: string): Promise<SupplierInvoice> {
  const direct = await db.get<SupplierInvoice>("supplier_invoices", invoiceNumber);
  if (direct) return direct;
  const wanted = normalizeText(invoiceNumber);
  const invoices = await db.list<SupplierInvoice>("supplier_invoices");
  const found = invoices.find((inv) => normalizeText(inv.invoice_number) === wanted || inv.document_number === invoiceNumber);
  if (!found) throw new ConnectorError(`Supplier invoice ${invoiceNumber} not found`, "not_found");
  return found;
}

function daysOverdue(dueDate: string, today: string): number {
  return Math.max(0, daysBetween(dueDate, today));
}

function withOverdue(item: OpenItem, today: string): Rec {
  const overdue = item.open_amount > 0 ? daysOverdue(item.due_date, today) : 0;
  return { ...item, days_overdue: overdue, is_overdue: overdue > 0 };
}

// ---------------------------------------------------------------------------
// Manifest & operations
// ---------------------------------------------------------------------------

const manifest = defineManifest({
  type: "sandbox-erp",
  name: "Sandbox ERP",
  vendor: "Enterprise Brain",
  category: "erp",
  description:
    "Built-in demo ERP of Acme Endüstri A.Ş. (pumps and valves manufacturer, Gebze): suppliers, purchase orders with goods receipts, supplier invoices with 3-way match, customers and open receivables, materials and stock, sales orders and a monthly trial balance. Works without credentials; changes persist per company.",
  auth: "none",
  maturity: "sandbox",
  operations: [
    readOp("search_suppliers", "Search suppliers", "Find suppliers by name, supplier id, tax id, city, category or e-mail. Without a query all suppliers are returned.", {
      query: str("Free-text search, e.g. 'Kaya Çelik' or 'bearings'"),
    }),
    readOp("get_supplier", "Get supplier", "Supplier master data including bank details, open purchase orders and recent invoices.", {
      supplier_id: str("Supplier id, e.g. SUP-1001"),
    }, ["supplier_id"]),
    readOp("get_purchase_order", "Get purchase order", "Purchase order with lines, received and invoiced quantities and open values.", {
      po_number: str("Purchase order number, e.g. PO-4500012"),
    }, ["po_number"]),
    readOp("search_purchase_orders", "Search purchase orders", "List purchase orders, newest first, optionally filtered by supplier and status.", {
      supplier_id: str("Supplier id, e.g. SUP-1001"),
      status: oneOf(PO_STATUSES, "Purchase order status"),
    }),
    readOp("get_invoice_status", "Get supplier invoice status", "Status, 3-way match result, due date and approval history of a supplier invoice.", {
      invoice_number: str("Supplier's invoice number (or the internal document number)"),
    }, ["invoice_number"]),
    readOp("search_customers", "Search customers", "Find customers by name, customer id, tax id, city, segment or e-mail.", {
      query: str("Free-text search, e.g. 'Hansa' or 'Konya'"),
    }),
    readOp("get_customer_balance", "Get customer balance", "Open receivables of a customer with overdue amount, aging buckets and credit limit usage.", {
      customer_id: str("Customer id, e.g. CUST-2001"),
    }, ["customer_id"]),
    readOp("list_open_items", "List open items", "Open receivable items (invoices and credit memos), optionally for one customer and/or only overdue items.", {
      customer_id: str("Customer id, e.g. CUST-2001"),
      overdue_only: bool("Only items past their due date"),
    }),
    readOp("get_material_stock", "Get material stock", "Stock situation of a material: unrestricted, reserved, available, on order and reorder point.", {
      material: str("Material number (e.g. MAT-10001, FG-20001) or part of the description"),
    }, ["material"]),
    readOp("get_sales_order", "Get sales order", "Sales order with lines, delivery status and totals.", {
      order_number: str("Sales order number, e.g. SO-7000121"),
    }, ["order_number"]),
    readOp("list_gl_balances", "List G/L balances", "Trial balance of a closed fiscal period (Turkish uniform chart of accounts, TRY): opening balance, period debits/credits and closing balance per account.", {
      period: str("Fiscal period YYYY-MM; defaults to the latest closed period"),
    }),
    writeOp("create_supplier", "Create supplier", "Create a supplier master record. Duplicates (same tax id or name) are rejected; an IBAN is checked for validity.", {
      name: str("Legal name of the supplier"),
      tax_id: str("Tax number (VKN) or EU VAT id"),
      email: email("Order / accounts receivable e-mail of the supplier"),
      country: str("ISO country code, e.g. TR, DE (default TR)"),
      iban: str("Bank account IBAN"),
    }, ["name"]),
    writeOp("create_purchase_order", "Create purchase order", "Create a purchase order for a supplier. Turkish suppliers are charged 20% VAT (KDV).", {
      supplier_id: str("Supplier id, e.g. SUP-1001"),
      lines: arr(obj({
        description: str("Item or service description"),
        quantity: num("Ordered quantity"),
        unit_price: num("Net price per unit"),
        material: str("Material number, e.g. MAT-10005 (optional)"),
      }, ["description", "quantity", "unit_price"]), "Order lines"),
      currency: str("ISO currency code; defaults to the supplier's currency"),
    }, ["supplier_id", "lines"]),
    writeOp("post_supplier_invoice", "Post supplier invoice", "Register a supplier invoice. With a PO number a 3-way match (PO price x goods receipt x invoice) is performed: match status is matched, price_mismatch, quantity_mismatch or no_po; mismatches are blocked for payment.", {
      supplier_id: str("Supplier id, e.g. SUP-1001"),
      invoice_number: str("Invoice number as printed on the supplier's invoice"),
      invoice_date: date("Invoice date (YYYY-MM-DD)"),
      currency: str("ISO currency code, e.g. TRY or EUR"),
      net_amount: num("Net amount (before tax)"),
      tax_amount: num("Tax (VAT/KDV) amount"),
      total_amount: num("Gross total"),
      po_number: str("Purchase order the invoice refers to, e.g. PO-4500012"),
    }, ["supplier_id", "invoice_number", "invoice_date", "currency", "net_amount", "tax_amount", "total_amount"]),
    writeOp("update_supplier_invoice_status", "Update supplier invoice status", "Approve, reject, block, hold or mark a supplier invoice as paid, with an optional note for the audit trail.", {
      invoice_number: str("Supplier's invoice number"),
      status: str(`New status: ${INVOICE_STATUSES.join(", ")}`),
      note: str("Reason or comment"),
    }, ["invoice_number", "status"]),
  ],
});

export const sandboxErpConnector = defineSandboxConnector({
  manifest,
  keys: {
    suppliers: "supplier_id",
    purchase_orders: "po_number",
    supplier_invoices: "invoice_number",
    customers: "customer_id",
    open_items: "item_id",
    materials: "material",
    sales_orders: "order_number",
    gl_balances: "key",
  },
  seed,
  operations: {
    async search_suppliers(input, db) {
      const query = optString(input, "query");
      const suppliers = await db.list<Supplier>("suppliers");
      const items = suppliers
        .filter((x) => matchesQuery([x.supplier_id, x.name, x.tax_id, x.city, x.country, x.category, x.email, x.contact_person], query))
        .map(supplierSummary);
      return listResult(items);
    },

    async get_supplier(input, db) {
      const supplier = await findSupplier(db, reqString(input, "supplier_id"));
      const orders = (await db.list<PurchaseOrder>("purchase_orders")).filter((p) => p.supplier_id === supplier.supplier_id);
      const invoices = (await db.list<SupplierInvoice>("supplier_invoices")).filter((i) => i.supplier_id === supplier.supplier_id);
      return {
        ...supplier,
        open_purchase_orders: orders
          .filter((p) => ["open", "partially_received", "received", "awaiting_approval"].includes(p.status))
          .map((p) => ({ po_number: p.po_number, order_date: p.order_date, status: p.status, currency: p.currency, net_total: p.net_total })),
        recent_invoices: invoices
          .sort((a, b) => b.invoice_date.localeCompare(a.invoice_date))
          .slice(0, 5)
          .map((i) => ({ invoice_number: i.invoice_number, invoice_date: i.invoice_date, status: i.status, currency: i.currency, total_amount: i.total_amount })),
      };
    },

    async get_purchase_order(input, db) {
      const po = await db.require<PurchaseOrder>("purchase_orders", erpId(reqString(input, "po_number"), "PO-"), "Purchase order");
      const invoices = (await db.list<SupplierInvoice>("supplier_invoices"))
        .filter((i) => i.po_number === po.po_number)
        .map((i) => ({ invoice_number: i.invoice_number, status: i.status, match_status: i.match_status, net_amount: i.net_amount }));
      return { ...po, ...poValues(po), invoices };
    },

    async search_purchase_orders(input, db) {
      const supplierIdInput = optString(input, "supplier_id");
      const supplierId = supplierIdInput ? erpId(supplierIdInput, "SUP-") : undefined;
      const status = optEnum(input, "status", PO_STATUSES);
      const items = (await db.list<PurchaseOrder>("purchase_orders"))
        .filter((p) => (!supplierId || p.supplier_id === supplierId) && (!status || p.status === status))
        .sort((a, b) => b.order_date.localeCompare(a.order_date) || b.po_number.localeCompare(a.po_number))
        .map((p) => ({
          po_number: p.po_number,
          supplier_id: p.supplier_id,
          supplier_name: p.supplier_name,
          order_date: p.order_date,
          delivery_date: p.delivery_date,
          status: p.status,
          currency: p.currency,
          net_total: p.net_total,
          total: p.total,
          line_count: p.lines.length,
        }));
      return listResult(items);
    },

    async get_invoice_status(input, db) {
      return invoiceStatusView(await findInvoice(db, reqString(input, "invoice_number")));
    },

    async search_customers(input, db) {
      const query = optString(input, "query");
      const items = (await db.list<Customer>("customers")).filter((x) =>
        matchesQuery([x.customer_id, x.name, x.tax_id, x.city, x.country, x.segment, x.email, x.account_manager], query),
      );
      return listResult(items);
    },

    async get_customer_balance(input, db) {
      const customer = await db.require<Customer>("customers", erpId(reqString(input, "customer_id"), "CUST-"), "Customer");
      const today = todayIso();
      const items = (await db.list<OpenItem>("open_items")).filter((i) => i.customer_id === customer.customer_id);
      const aging = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
      let overdue = 0;
      let oldest = 0;
      for (const i of items) {
        const days = i.open_amount > 0 ? daysOverdue(i.due_date, today) : 0;
        if (days > 0) overdue += i.open_amount;
        oldest = Math.max(oldest, days);
        const bucket = days === 0 ? "current" : days <= 30 ? "days_1_30" : days <= 60 ? "days_31_60" : days <= 90 ? "days_61_90" : "over_90";
        aging[bucket] = round2(aging[bucket] + i.open_amount);
      }
      const totalOpen = sum(items.map((i) => i.open_amount));
      return {
        customer_id: customer.customer_id,
        name: customer.name,
        currency: customer.currency,
        status: customer.status,
        payment_terms: customer.payment_terms,
        credit_limit: customer.credit_limit,
        total_open: totalOpen,
        overdue_amount: round2(overdue),
        not_due_amount: round2(totalOpen - overdue),
        available_credit: round2(customer.credit_limit - totalOpen),
        credit_utilization_percent: customer.credit_limit > 0 ? round2((totalOpen / customer.credit_limit) * 100) : null,
        oldest_overdue_days: oldest,
        max_dunning_level: Math.max(0, ...items.map((i) => i.dunning_level)),
        open_items_count: items.length,
        aging,
        as_of: today,
      };
    },

    async list_open_items(input, db) {
      const customerIdInput = optString(input, "customer_id");
      const customerId = customerIdInput ? erpId(customerIdInput, "CUST-") : undefined;
      const overdueOnly = optBoolean(input, "overdue_only") ?? false;
      if (customerId) await db.require<Customer>("customers", customerId, "Customer");
      const today = todayIso();
      const items = (await db.list<OpenItem>("open_items"))
        .filter((i) => !customerId || i.customer_id === customerId)
        .map((i) => withOverdue(i, today))
        .filter((i) => !overdueOnly || i.is_overdue === true)
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      const byCurrency: Record<string, number> = {};
      for (const i of items) byCurrency[String(i.currency)] = round2((byCurrency[String(i.currency)] ?? 0) + Number(i.open_amount));
      return listResult(items, { open_amount_by_currency: byCurrency, as_of: today });
    },

    async get_material_stock(input, db) {
      const wanted = reqString(input, "material");
      const materials = await db.list<Material>("materials");
      let material = materials.find((x) => x.material.toLowerCase() === wanted.toLowerCase());
      if (!material) {
        const matches = materials.filter((x) => matchesQuery([x.description, x.material_group], wanted));
        if (matches.length > 1) {
          throw new ConnectorError(
            `"${wanted}" matches several materials: ${matches.map((x) => `${x.material} (${x.description})`).join("; ")}. Specify the material number.`,
            "validation",
          );
        }
        material = matches[0];
      }
      if (!material) throw new ConnectorError(`Material ${wanted} not found`, "not_found");
      const id = material.material;
      const incoming = (await db.list<PurchaseOrder>("purchase_orders"))
        .filter((p) => ["open", "partially_received", "awaiting_approval"].includes(p.status))
        .flatMap((p) =>
          p.lines
            .filter((l) => l.material === id && l.quantity > l.received_quantity)
            .map((l) => ({ po_number: p.po_number, line: l.line, open_quantity: l.quantity - l.received_quantity, delivery_date: p.delivery_date, po_status: p.status })),
        );
      const available = material.unrestricted_stock - material.reserved;
      return {
        ...material,
        available,
        on_order: incoming.reduce((acc, i) => acc + i.open_quantity, 0),
        incoming,
        below_reorder_point: available < material.reorder_point,
        stock_value: round2(material.unrestricted_stock * material.standard_price),
      };
    },

    async get_sales_order(input, db) {
      const order = await db.require<SalesOrder>("sales_orders", erpId(reqString(input, "order_number"), "SO-"), "Sales order");
      const ordered = order.lines.reduce((acc, l) => acc + l.quantity, 0);
      const delivered = order.lines.reduce((acc, l) => acc + l.delivered_quantity, 0);
      return { ...order, delivery_progress_percent: ordered > 0 ? round2((delivered / ordered) * 100) : 0 };
    },

    async list_gl_balances(input, db) {
      const rows = await db.list<GlBalance>("gl_balances");
      const periods = [...new Set(rows.map((r) => r.period))].sort();
      const period = optString(input, "period") ?? periods[periods.length - 1];
      if (!period || !periods.includes(period)) {
        throw new ConnectorError(`No balances for period ${period ?? "(none)"}. Available periods: ${periods.join(", ")}`, "not_found");
      }
      const items = rows
        .filter((r) => r.period === period)
        .sort((a, b) => a.account.localeCompare(b.account))
        .map(({ key: _key, ...row }) => row);
      return listResult(items, {
        period,
        currency: "TRY",
        company_code: COMPANY_CODE,
        totals: { debit: sum(items.map((r) => r.debit)), credit: sum(items.map((r) => r.credit)), balance: sum(items.map((r) => r.balance)) },
        available_periods: periods,
      });
    },

    async create_supplier(input, db) {
      const name = reqString(input, "name");
      const taxId = optString(input, "tax_id")?.replace(/\s+/g, "").toUpperCase();
      const mail = optString(input, "email")?.toLowerCase();
      const country = (optString(input, "country") ?? "TR").toUpperCase();
      const ibanInput = optString(input, "iban");
      if (!/^[A-Z]{2}$/.test(country)) throw new ConnectorError("country must be a 2-letter ISO code, e.g. TR or DE", "validation");
      if (mail && !isEmail(mail)) throw new ConnectorError(`email is not a valid e-mail address: "${mail}"`, "validation");
      if (ibanInput && !isValidIban(ibanInput)) throw new ConnectorError(`iban is not a valid IBAN (check digits do not match): "${ibanInput}"`, "validation");
      const suppliers = await db.list<Supplier>("suppliers");
      const duplicate = suppliers.find(
        (x) => (taxId && x.tax_id?.toUpperCase() === taxId) || normalizeText(x.name) === normalizeText(name),
      );
      if (duplicate) {
        throw new ConnectorError(`Supplier already exists: ${duplicate.supplier_id} ${duplicate.name} (tax id ${duplicate.tax_id ?? "-"})`, "validation");
      }
      const supplier: Supplier = {
        supplier_id: await db.nextId("suppliers", "SUP-", 4),
        name,
        tax_id: taxId ?? null,
        tax_office: null,
        country,
        city: null,
        address: null,
        email: mail ?? null,
        phone: null,
        iban: ibanInput ? formatIban(ibanInput) : null,
        currency: country === "TR" ? "TRY" : "EUR",
        payment_terms: "NET30",
        category: "Unclassified",
        status: "active",
        block_reason: null,
        contact_person: null,
        created_at: nowIso(),
      };
      await db.put("suppliers", supplier);
      return { ...supplier, ok: true };
    },

    async create_purchase_order(input, db) {
      const supplier = await findSupplier(db, reqString(input, "supplier_id"));
      if (supplier.status === "blocked") {
        throw new ConnectorError(`Supplier ${supplier.supplier_id} is blocked for purchasing: ${supplier.block_reason ?? "no reason given"}`, "validation");
      }
      const rawLines = input.lines;
      if (!Array.isArray(rawLines) || rawLines.length === 0) throw new ConnectorError("lines must contain at least one order line", "validation");
      const materials = await db.list<Material>("materials");
      const lines: PoLine[] = rawLines.map((raw, i) => {
        const lineInput = raw as Rec;
        const quantity = reqNumber(lineInput, "quantity");
        const unitPrice = reqNumber(lineInput, "unit_price");
        if (quantity <= 0) throw new ConnectorError(`lines[${i}].quantity must be greater than 0`, "validation");
        if (unitPrice < 0) throw new ConnectorError(`lines[${i}].unit_price must not be negative`, "validation");
        const materialId = optString(lineInput, "material");
        const material = materialId ? materials.find((x) => x.material.toLowerCase() === materialId.toLowerCase()) : undefined;
        if (materialId && !material) throw new ConnectorError(`lines[${i}].material ${materialId} not found`, "not_found");
        return {
          line: (i + 1) * 10,
          material: material?.material ?? null,
          description: reqString(lineInput, "description"),
          quantity,
          unit: material?.unit ?? "PC",
          unit_price: unitPrice,
          net_amount: round2(quantity * unitPrice),
          received_quantity: 0,
          invoiced_quantity: 0,
        };
      });
      const currency = (optString(input, "currency") ?? supplier.currency).toUpperCase();
      const net = sum(lines.map((l) => l.net_amount));
      const taxRate = supplier.country === "TR" ? TR_VAT : 0;
      const tax = round2(net * taxRate);
      const today = todayIso();
      const po: PurchaseOrder = {
        po_number: await db.nextId("purchase_orders", "PO-", 7),
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.name,
        company_code: COMPANY_CODE,
        plant: PLANT,
        buyer: "Enterprise Brain agent",
        order_date: today,
        delivery_date: toIsoDate(addDays(new Date(`${today}T00:00:00Z`), 14)),
        status: "open",
        currency,
        payment_terms: supplier.payment_terms,
        lines,
        net_total: net,
        tax_rate: taxRate,
        tax_amount: tax,
        total: round2(net + tax),
        created_at: nowIso(),
      };
      await db.put("purchase_orders", po);
      return { ...po, ok: true };
    },

    async post_supplier_invoice(input, db) {
      const supplier = await findSupplier(db, reqString(input, "supplier_id"));
      const invoiceNumber = reqString(input, "invoice_number");
      const invoiceDate = parseIsoDate(reqString(input, "invoice_date"), "invoice_date");
      const currency = reqString(input, "currency").toUpperCase();
      const net = round2(reqNumber(input, "net_amount"));
      const tax = round2(reqNumber(input, "tax_amount"));
      const total = round2(reqNumber(input, "total_amount"));
      const poNumberInput = optString(input, "po_number");
      const poNumber = poNumberInput ? erpId(poNumberInput, "PO-") : undefined;

      if (supplier.status === "blocked") {
        throw new ConnectorError(`Supplier ${supplier.supplier_id} is blocked for posting: ${supplier.block_reason ?? "no reason given"}`, "validation");
      }
      if (net <= 0) throw new ConnectorError("net_amount must be greater than 0 (post credit memos separately)", "validation");
      if (tax < 0) throw new ConnectorError("tax_amount must not be negative", "validation");
      if (Math.abs(net + tax - total) > 0.05) {
        throw new ConnectorError(
          `Amounts are inconsistent: net_amount ${net} + tax_amount ${tax} = ${round2(net + tax)}, but total_amount is ${total}`,
          "validation",
        );
      }
      const existing = (await db.list<SupplierInvoice>("supplier_invoices")).find(
        (i) => normalizeText(i.invoice_number) === normalizeText(invoiceNumber),
      );
      if (existing) {
        throw new ConnectorError(
          `Duplicate invoice: ${invoiceNumber} was already registered as document ${existing.document_number} (supplier ${existing.supplier_id}, status ${existing.status})`,
          "validation",
        );
      }

      let po: PurchaseOrder | undefined;
      if (poNumber) {
        po = await db.require<PurchaseOrder>("purchase_orders", poNumber, "Purchase order");
        if (po.supplier_id !== supplier.supplier_id) {
          throw new ConnectorError(`${po.po_number} belongs to supplier ${po.supplier_id} (${po.supplier_name}), not ${supplier.supplier_id}`, "validation");
        }
        if (po.status === "cancelled" || po.status === "draft" || po.status === "awaiting_approval") {
          throw new ConnectorError(`${po.po_number} has status ${po.status} and cannot be invoiced`, "validation");
        }
      }

      const match = threeWayMatch(po, currency, net);
      const status: InvoiceStatus = match.status === "matched" ? "posted" : match.status === "no_po" ? "parked" : "blocked";
      const now = nowIso();
      const today = todayIso();
      const invoice: SupplierInvoice = {
        invoice_number: invoiceNumber,
        document_number: await db.nextId("supplier_invoices", "51056", 5, "document_number"),
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.name,
        po_number: po?.po_number ?? null,
        invoice_date: invoiceDate,
        posting_date: today,
        due_date: toIsoDate(addDays(new Date(`${invoiceDate}T00:00:00Z`), termsDays(supplier.payment_terms))),
        currency,
        net_amount: net,
        tax_amount: tax,
        total_amount: total,
        status,
        match_status: match.status,
        match_details: match.details,
        payment_block: status !== "posted",
        paid_at: null,
        history: [{ at: now, status, note: match.details }],
        created_at: now,
      };
      await db.put("supplier_invoices", invoice);

      if (po && match.status === "matched") {
        const covered = new Set(match.matched_lines);
        for (const line of po.lines) {
          if (covered.has(line.line)) line.invoiced_quantity = Math.max(line.invoiced_quantity, line.received_quantity);
        }
        if (po.lines.every((l) => l.invoiced_quantity >= l.quantity)) po.status = "closed";
        await db.put("purchase_orders", po);
      }
      return { ...invoice, ok: true, match };
    },

    async update_supplier_invoice_status(input, db) {
      const invoice = await findInvoice(db, reqString(input, "invoice_number"));
      const status = reqEnum(input, "status", INVOICE_STATUSES, INVOICE_STATUS_SYNONYMS);
      const note = optString(input, "note") ?? null;
      if (invoice.status === "paid" && status !== "paid") {
        throw new ConnectorError(`Invoice ${invoice.invoice_number} is already paid and cannot be set to ${status}`, "validation");
      }
      if (invoice.status === "rejected" && status === "paid") {
        throw new ConnectorError(`Invoice ${invoice.invoice_number} was rejected and cannot be paid`, "validation");
      }
      const now = nowIso();
      invoice.status = status;
      invoice.payment_block = ["blocked", "parked", "on_hold", "rejected"].includes(status);
      if (status === "paid") invoice.paid_at = now;
      invoice.history.push({ at: now, status, note });
      await db.put("supplier_invoices", invoice);
      return { ...invoiceStatusView(invoice), ok: true };
    },
  },
});
