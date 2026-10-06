import type { BrainDataDimension, BrainImage, BrainMeasure } from "@enterprise-brain/core";
import { dashboardImage, wander, type DashboardPage } from "../demo/dashboard.ts";
import { byWave, dayOffset, released, waveMoment } from "../demo/util.ts";
import type { SourceEntity, SourceEvent, SourceLink, SourceRef } from "../types.ts";
import { tableRef } from "./data.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * The demo company's BI reports, as the Power BI service would describe them (standing in for its
 * admin API and scanner): what each report is for and who reads it, its pages, measures and
 * dimensions, the semantic models and tables behind it, how often it refreshes and how much it is
 * read, with a screenshot of its pages. A finance Excel report and a retired SSRS report are there
 * too. Each reading brings news: a failed refresh, a new page, a report going live.
 */

type Level = "Expert" | "Can do it" | "Learning";

interface DemoReport {
  key: string;
  name: string;
  summary: string;
  tool: "Power BI" | "Excel" | "SSRS";
  /** By reading (see byWave): a report can go live on a later one. */
  status: "Live" | "In development" | "Retired" | ("Live" | "In development" | "Retired")[];
  workspace: string;
  purpose: string;
  audience: string[];
  owner: string;
  pages: string[] | string[][];
  measures: [name: string, definition: string, formula: string, format?: string][];
  dimensions: [name: string, source: string, levels?: string, description?: string][];
  filters?: string[];
  refresh: string;
  /** Days since the last refresh, by reading. */
  refreshed: number | number[];
  views: number | number[];
  personal: "None" | "Some" | "Sensitive";
  url: string;
  issues?: string[];
  /** The data behind it: data sets by key, tables as "database/TABLE". */
  builtOn: [target: string, how: string][];
  reportsOn: SourceRef[];
  experts?: [person: string, level: Level][];
  screens: Omit<DashboardPage, "report" | "pages" | "tool" | "refreshed">[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
const WEEKS = ["W28", "W29", "W30", "W31", "W32", "W33", "W34", "W35", "W36", "W37", "W38", "W39", "W40"];
const MILLION_TRY = { prefix: "₺", suffix: "M" };
const PERCENT = { suffix: "%", decimals: 1 };

/** A made-up but stable id, as Power BI addresses have. */
function guid(seed: string): string {
  const hex = wander(seed, 32, 8, 8)
    .map((n) => Math.floor(n) % 16)
    .map((n) => n.toString(16))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function powerBi(workspace: string, report: string): string {
  return `https://app.powerbi.com/groups/${guid(workspace)}/reports/${guid(report)}`;
}

const goal = (key: string): SourceRef => ({ kind: "goal", key });
const process = (key: string): SourceRef => ({ kind: "process", key });
const department = (key: string): SourceRef => ({ kind: "department", key });

const REPORTS: DemoReport[] = [
  {
    key: "management-dashboard",
    name: "Management dashboard",
    summary: "The executive team's Monday page: the year's goals, revenue, delivery, quality, margin and cash.",
    tool: "Power BI",
    status: "Live",
    workspace: "Management",
    purpose:
      "Shows the executive team every Monday whether the company is on track for the year's goals: revenue against the 1.1 billion TRY plan, on-time delivery, complaints, EBITDA margin and the export share. Each number opens the report with the details. The board gets its pages as a PDF each month.",
    audience: ["Executive team", "Board of directors (monthly PDF)", "Department heads"],
    owner: "hande.ozkan",
    pages: ["Overview", "Sales", "Operations", "Finance"],
    measures: [
      ["Net revenue YTD", "Net revenue from 1 January to today.", "TOTALYTD([Net revenue], dim_date[date])", "₺ #,0,,M"],
      ["Revenue vs plan %", "Net revenue so far against the plan for the same months.", "DIVIDE([Net revenue YTD], [Plan YTD]) - 1", "+0.0%"],
      ["On-time delivery %", "Order lines shipped by the date confirmed to the customer.", "[On-time delivery %] (Sales model)", "0.0%"],
      ["Complaints YTD", "Customer complaints since 1 January.", "TOTALYTD([Complaints], dim_date[date])", "#,0"],
      ["EBITDA margin %", "EBITDA as a share of revenue.", "[EBITDA margin %] (Finance model)", "0.0%"],
    ],
    dimensions: [
      ["Date", "dim_date", "Year › Quarter › Month", "The calendar; the dashboard opens on the current year."],
      ["Company", "fact_gl.company_code", "", "1000 Acme Pompa (Türkiye), 3000 Acme Pumpen GmbH."],
      ["Product family", "dim_product.family", "Family › Product line", ""],
      ["Region", "dim_customer.region", "Region › Country", "Türkiye, Europe, Middle East, Africa."],
    ],
    filters: ["Year: current year", "Company: all"],
    refresh: "Daily at 07:30, after the three models",
    refreshed: 0,
    views: [412, 418, 431, 440],
    personal: "None",
    url: powerBi("Management", "management-dashboard"),
    builtOn: [
      ["sales-model", "Live connection"],
      ["operations-model", "Live connection"],
      ["finance-model", "Live connection"],
    ],
    reportsOn: [goal("revenue-2026"), goal("on-time-delivery"), goal("fewer-complaints"), goal("export-share"), department("management")],
    experts: [
      ["hande.ozkan", "Expert"],
      ["ozan.kurt", "Learning"],
    ],
    screens: [
      {
        page: "Overview",
        slicers: ["Year: 2026", "Company: All"],
        cards: [
          { label: "Net revenue YTD", value: "₺812.4M", note: "▲ 3.2% vs plan", good: true },
          { label: "On-time delivery", value: "91.8%", note: "Target 95%", good: false },
          { label: "Complaints YTD", value: "47", note: "▼ 22% vs 2025", good: true },
          { label: "EBITDA margin", value: "14.6%", note: "▲ 0.8 pt vs 2025", good: true },
        ],
        columns: {
          title: "Net revenue by month",
          labels: MONTHS,
          values: wander("mgmt-revenue", 9, 86, 7, 1.1),
          format: MILLION_TRY,
          target: { value: 92, label: "Plan ₺92M a month" },
        },
        bars: {
          title: "Net revenue by family (YTD)",
          labels: ["Pumps", "Skids", "Spare parts", "Valves", "Service"],
          values: [508, 131, 88, 61, 24],
          format: MILLION_TRY,
        },
        table: {
          title: "The year's goals",
          headers: ["Goal", "Target", "Now", "Trend"],
          rows: [
            ["Revenue of 1.1 billion TRY in 2026", "₺1,100M", "₺812M so far", "▲ on plan"],
            ["On-time delivery of 95%", "95%", "91.8%", "▼ 3.2 pt short"],
            ["30% fewer customer complaints", "-30%", "-22%", "▲ improving"],
            ["Export share of 45%", "45%", "41.3%", "▲ 1.9 pt"],
          ],
        },
      },
      {
        page: "Operations",
        slicers: ["Year: 2026", "Plant: Gebze"],
        cards: [
          { label: "OEE", value: "71.4%", note: "Target 75%", good: false },
          { label: "Scrap rate", value: "1.9%", note: "▼ 0.4 pt vs 2025", good: true },
          { label: "PPM", value: "620", note: "▼ 180 vs 2025", good: true },
          { label: "Open 8Ds", value: "6", note: "2 older than 30 days", good: false },
        ],
        columns: {
          title: "On-time delivery by month",
          labels: MONTHS,
          values: [88.2, 89.5, 90.1, 92.4, 91.0, 93.2, 90.4, 92.8, 93.6],
          format: PERCENT,
          target: { value: 95, label: "Target 95%" },
          line: true,
        },
        bars: {
          title: "Late lines by reason (YTD)",
          labels: ["Waiting for castings", "Test bench capacity", "Customer changes", "Transport"],
          values: [142, 96, 58, 31],
        },
      },
    ],
  },
  {
    key: "sales-margin",
    name: "Sales & margin",
    summary: "Revenue and gross margin by customer, product and country, against last year.",
    tool: "Power BI",
    status: "Live",
    workspace: "Sales",
    purpose:
      "Answers how much the company sells, to whom, and what it earns on it: revenue and gross margin by customer, product and country, against last year. Sales uses it to prepare customer visits and yearly price reviews; finance uses it to explain the month's margin.",
    audience: ["Sales team", "Sales director", "Finance"],
    owner: "thomas.weber",
    pages: [
      ["Overview", "Customers", "Products"],
      ["Overview", "Customers", "Products"],
      ["Overview", "Customers", "Products", "Export"],
    ],
    measures: [
      ["Net revenue", "Sales before VAT, in TRY.", "SUM(fact_sales[net_revenue_try])", "₺ #,0"],
      ["Net revenue LY", "The same, a year earlier.", "CALCULATE([Net revenue], SAMEPERIODLASTYEAR(dim_date[date]))", "₺ #,0"],
      ["Gross margin %", "Gross margin as a share of net revenue.", "DIVIDE(SUM(fact_sales[margin_try]), [Net revenue])", "0.0%"],
      ["Orders", "How many sales orders.", "DISTINCTCOUNT(fact_sales[order_no])", "#,0"],
      ["Average order value", "Net revenue per order.", "DIVIDE([Net revenue], [Orders])", "₺ #,0"],
      [
        "Export share %",
        "Net revenue from customers outside Türkiye.",
        'DIVIDE(CALCULATE([Net revenue], dim_customer[country] <> "TR"), [Net revenue])',
        "0.0%",
      ],
    ],
    dimensions: [
      ["Date", "dim_date", "Year › Quarter › Month", ""],
      ["Customer", "dim_customer", "Region › Country › Customer", ""],
      ["Segment", "dim_customer.segment", "", "End user, EPC contractor, distributor or OEM."],
      ["Product", "dim_product", "Family › Product line › Model", ""],
    ],
    filters: ["Year: current year", "Sales organisation: all"],
    refresh: "Daily at 06:00 (with the Sales model)",
    refreshed: 0,
    views: [268, 275, 290, 301],
    personal: "None",
    url: powerBi("Sales", "sales-margin"),
    builtOn: [["sales-model", "Live connection"]],
    reportsOn: [department("sales"), process("sales.quote-preparation"), goal("export-share"), goal("revenue-2026")],
    experts: [["laura.rossi", "Can do it"]],
    screens: [
      {
        page: "Overview",
        slicers: ["Year: 2026", "Region: All"],
        cards: [
          { label: "Net revenue YTD", value: "₺812.4M", note: "▲ 11.6% vs 2025", good: true },
          { label: "Gross margin", value: "31.2%", note: "▼ 0.9 pt vs 2025", good: false },
          { label: "Orders", value: "1,284", note: "▲ 6.1% vs 2025", good: true },
          { label: "Export share", value: "41.3%", note: "Goal 45%", good: false },
        ],
        columns: { title: "Net revenue by month, this year", labels: MONTHS, values: wander("sales-revenue", 9, 86, 8, 1.1), format: MILLION_TRY },
        bars: {
          title: "Top customers (YTD)",
          labels: ["Petrokim", "Gulf Water", "Boğaziçi Su", "Nordwind", "Hansa Pumpen", "Kuzey Gıda"],
          values: [64.2, 51.8, 38.4, 27.9, 21.3, 12.6],
          format: MILLION_TRY,
        },
        table: {
          title: "By region",
          headers: ["Region", "Net revenue", "vs 2025", "Gross margin"],
          rows: [
            ["Türkiye", "₺476.8M", "▲ 6.2%", "29.4%"],
            ["Europe", "₺182.3M", "▲ 18.9%", "34.8%"],
            ["Middle East", "₺131.6M", "▲ 21.4%", "33.1%"],
            ["Africa", "₺21.7M", "▼ 4.0%", "27.5%"],
          ],
        },
      },
      {
        page: "Customers",
        slicers: ["Year: 2026", "Segment: All"],
        cards: [
          { label: "Customers who ordered", value: "386", note: "▲ 24 vs 2025", good: true },
          { label: "Revenue per customer", value: "₺2.1M", note: "▲ 5.4% vs 2025", good: true },
          { label: "New customers", value: "41", note: "Since 1 January" },
        ],
        bars: {
          title: "Gross margin by segment",
          labels: ["OEM", "End user", "EPC contractor", "Distributor"],
          values: [36.2, 32.8, 29.5, 24.1],
          format: PERCENT,
        },
        table: {
          title: "Customers",
          headers: ["Customer", "Country", "Net revenue", "vs 2025", "Gross margin"],
          rows: [
            ["Petrokim Rafineri A.Ş.", "TR", "₺64.2M", "▲ 12.0%", "28.9%"],
            ["Gulf Water Solutions LLC", "AE", "₺51.8M", "▲ 64.1%", "33.6%"],
            ["Boğaziçi Su Teknolojileri A.Ş.", "TR", "₺38.4M", "▼ 3.5%", "26.2%"],
            ["Nordwind Energy A/S", "DK", "₺27.9M", "▲ 9.8%", "35.1%"],
            ["Hansa Pumpen Vertrieb GmbH", "DE", "₺21.3M", "▲ 2.2%", "30.4%"],
            ["Kuzey Gıda Üretim A.Ş.", "TR", "₺12.6M", "New", "31.7%"],
          ],
        },
      },
    ],
  },
  {
    key: "order-book-otd",
    name: "Order book & on-time delivery",
    summary: "Open orders, what ships when, and which order lines are late and why.",
    tool: "Power BI",
    status: "Live",
    workspace: "Operations",
    purpose:
      "Planning and sales look at it every morning: the open order book, what must ship this week, and the lines that are late or at risk, with the reason. It measures the on-time delivery goal the same way the management dashboard does.",
    audience: ["Plant manager", "Production planning", "Customer service", "Sales"],
    owner: "okan.tekin",
    pages: ["Order book", "This week", "Late lines"],
    measures: [
      ["Open order value", "Ordered but not yet shipped, before VAT.", "CALCULATE([Net revenue], ISBLANK(fact_sales[on_time]))", "₺ #,0"],
      [
        "On-time delivery %",
        "Order lines shipped by the date confirmed to the customer.",
        "DIVIDE(SUM(fact_sales[on_time]), COUNT(fact_sales[on_time]))",
        "0.0%",
      ],
      [
        "Late lines",
        "Open lines past the date confirmed to the customer.",
        "CALCULATE(COUNTROWS(fact_sales), ISBLANK(fact_sales[on_time]), fact_sales[confirmed_date] < TODAY())",
        "#,0",
      ],
    ],
    dimensions: [
      ["Week", "fact_sales.confirmed_date", "Year › Week", "The week the line is confirmed to ship."],
      ["Customer", "dim_customer", "Country › Customer", ""],
      ["Product", "dim_product", "Product line › Model", ""],
      ["Reason late", "Planner's note in SAP", "", "Castings, test bench, customer change, transport."],
    ],
    filters: ["Plant: 1100 Gebze", "Status: open"],
    refresh: "Daily at 06:00",
    refreshed: 0,
    views: [190, 196, 201, 207],
    personal: "None",
    url: powerBi("Operations", "order-book-otd"),
    issues: ["The reason for a late line is only there when the planner writes it in SAP"],
    builtOn: [
      ["sales-model", "Live connection"],
      ["dwh/fact_sales", "Late lines page reads it directly (DirectQuery)"],
    ],
    reportsOn: [process("order-to-delivery"), goal("on-time-delivery"), department("operations")],
    screens: [
      {
        page: "Late lines",
        slicers: ["Week: W40", "Plant: 1100"],
        cards: [
          { label: "Open order value", value: "₺214.6M", note: "612 lines" },
          { label: "Ships this week", value: "₺38.2M", note: "94 lines" },
          { label: "Late lines", value: "37", note: "▲ 5 since last week", good: false },
          { label: "On-time delivery (4 weeks)", value: "92.8%", note: "Target 95%", good: false },
        ],
        columns: {
          title: "On-time delivery by week",
          labels: WEEKS,
          values: [90.2, 91.5, 89.8, 92.0, 93.1, 91.4, 92.6, 94.0, 92.2, 93.5, 91.9, 92.4, 93.0],
          format: PERCENT,
          target: { value: 95, label: "Target 95%" },
          line: true,
        },
        bars: {
          title: "Late lines by reason",
          labels: ["Waiting for castings", "Test bench capacity", "Customer changes", "Transport"],
          values: [16, 11, 6, 4],
        },
      },
    ],
  },
  {
    key: "production-oee",
    name: "Production performance (OEE)",
    summary: "OEE, scrap and downtime of the Gebze assembly lines, by day, line and product.",
    tool: "Power BI",
    status: "Live",
    workspace: "Operations",
    purpose:
      "Shows how well the Gebze lines run: OEE with its availability, performance and quality, scrap and the biggest causes of downtime. Shift leaders use it in the morning meeting; maintenance uses the downtime page to plan.",
    audience: ["Plant manager", "Shift leaders", "Maintenance"],
    owner: "okan.tekin",
    pages: ["OEE", "Downtime", "Scrap"],
    measures: [
      ["OEE %", "Availability × performance × quality, weighted by planned time.", "[OEE %] (Operations model)", "0.0%"],
      ["Scrap rate %", "Scrapped pieces as a share of all made.", "[Scrap rate %] (Operations model)", "0.00%"],
      ["Downtime hours", "Hours machines stood still.", "[Downtime hours] (Operations model)", "#,0.0"],
      ["Good pieces", "Pieces made right the first time.", "SUM(fact_production[good_qty])", "#,0"],
    ],
    dimensions: [
      ["Day", "dim_date", "Year › Month › Week › Day", ""],
      ["Line", "fact_production.line_id", "", "Assembly lines 1 to 4 in Gebze."],
      ["Product", "dim_product", "Product line › Model", ""],
      ["Downtime reason", "MES downtime_reasons", "Category › Reason", "Breakdown, changeover, waiting for material, quality hold."],
    ],
    refresh: "Daily at 06:30 (with the Operations model)",
    refreshed: [0, 2, 2, 0],
    views: [154, 158, 166, 171],
    personal: "None",
    url: powerBi("Operations", "production-oee"),
    builtOn: [["operations-model", "Live connection"]],
    reportsOn: [{ kind: "site", key: "gebze-plant" }, department("operations"), process("preventive-maintenance")],
    experts: [["deniz.celik", "Can do it"]],
    screens: [
      {
        page: "OEE",
        slicers: ["Month: Sep 2026", "Line: All"],
        cards: [
          { label: "OEE", value: "71.4%", note: "Target 75%", good: false },
          { label: "Availability", value: "86.2%" },
          { label: "Performance", value: "84.9%" },
          { label: "Quality", value: "97.6%", note: "▲ 0.5 pt vs August", good: true },
        ],
        columns: { title: "OEE by week", labels: WEEKS, values: wander("oee", 13, 70, 3.5, 0.15), format: PERCENT, target: { value: 75, label: "Target 75%" } },
        bars: {
          title: "Downtime hours by reason (September)",
          labels: ["Breakdowns", "Changeovers", "Waiting for material", "Quality hold", "No operator"],
          values: [62, 48, 37, 14, 9],
        },
      },
    ],
  },
  {
    key: "quality-complaints",
    name: "Quality: complaints & PPM",
    summary: "Customer complaints, defective parts per million and how fast 8Ds are closed.",
    tool: "Power BI",
    status: "Live",
    workspace: "Operations",
    purpose:
      "Follows the goal of 30% fewer complaints: complaints by customer, product and cause, PPM delivered, and the open 8Ds with their age. The quality team reviews it every week; it goes into the management review for ISO 9001.",
    audience: ["Quality team", "Plant manager", "Executive team (monthly)"],
    owner: "selin.acar",
    pages: ["Complaints", "PPM", "8D follow-up"],
    measures: [
      ["Complaints", "Customer complaints received.", "SUM(fact_quality[complaints])", "#,0"],
      ["PPM", "Defective parts per million delivered.", "AVERAGE(fact_quality[ppm])", "#,0"],
      ["Open 8Ds", "8D reports not yet closed.", "SUM(fact_quality[open_8d])", "#,0"],
      ["Days to close", "From the complaint to its 8D's closure, on average.", "AVERAGE(fact_quality[days_to_close])", "#,0"],
    ],
    dimensions: [
      ["Month", "dim_date", "Year › Month", ""],
      ["Customer", "dim_customer", "Country › Customer", ""],
      ["Product", "dim_product", "Product line › Model", ""],
    ],
    refresh: "Daily at 06:30 (with the Operations model)",
    refreshed: [0, 2, 2, 0],
    views: [96, 99, 104, 108],
    personal: "None",
    url: powerBi("Operations", "quality-complaints"),
    builtOn: [["operations-model", "Live connection"]],
    reportsOn: [process("operations.quality-incidents"), goal("fewer-complaints")],
    experts: [["kerem.yildiz", "Can do it"]],
    screens: [
      {
        page: "Complaints",
        slicers: ["Year: 2026", "Customer: All"],
        cards: [
          { label: "Complaints YTD", value: "47", note: "▼ 22% vs 2025 (goal -30%)", good: true },
          { label: "PPM", value: "620", note: "▼ 180 vs 2025", good: true },
          { label: "Open 8Ds", value: "6", note: "2 older than 30 days", good: false },
          { label: "Days to close", value: "24", note: "Target 30", good: true },
        ],
        columns: { title: "Complaints by month: 2026", labels: MONTHS, values: [7, 6, 5, 6, 4, 5, 6, 4, 4] },
        bars: {
          title: "Complaints by cause (YTD)",
          labels: ["Vibration", "Leaking seal", "Wrong documents", "Paint damage", "Late delivery"],
          values: [14, 11, 9, 7, 6],
        },
      },
    ],
  },
  {
    key: "supplier-performance",
    name: "Supplier performance",
    summary: "Spend, on-time delivery and price variance of the company's suppliers.",
    tool: "Power BI",
    status: "Live",
    workspace: "Procurement",
    purpose:
      "Procurement prepares supplier reviews and the yearly supplier rating with it: what the company spends with each supplier, how often they deliver on time, and what invoices cost above the order price.",
    audience: ["Procurement", "Quality team (supplier rating)"],
    owner: "ayse.kaya",
    pages: ["Spend", "On-time delivery", "Price variance"],
    measures: [
      ["Spend", "Value ordered from suppliers.", "[Spend] (Purchasing model)", "₺ #,0"],
      ["Supplier OTD %", "Purchase order lines delivered by the promised date.", "[Supplier OTD %] (Purchasing model)", "0.0%"],
      ["Price variance", "What invoices cost above or below the order price.", "[Price variance] (Purchasing model)", "₺ #,0"],
    ],
    dimensions: [
      ["Supplier", "dim_supplier", "Category › Supplier", ""],
      ["Material", "dim_product", "Family › Material", ""],
      ["Month", "dim_date", "Year › Quarter › Month", ""],
    ],
    refresh: "Daily at 06:00 (with the Purchasing model)",
    refreshed: 0,
    views: 74,
    personal: "None",
    url: powerBi("Procurement", "supplier-performance"),
    builtOn: [["purchasing-model", "Live connection"]],
    reportsOn: [department("procurement"), process("procurement.purchase-requisition")],
    screens: [
      {
        page: "On-time delivery",
        slicers: ["Year: 2026", "Category: All"],
        cards: [
          { label: "Spend YTD", value: "₺402.7M", note: "▲ 9.3% vs 2025" },
          { label: "Supplier OTD", value: "87.5%", note: "Target 92%", good: false },
          { label: "Price variance", value: "₺3.1M", note: "Above order prices", good: false },
          { label: "Active suppliers", value: "214" },
        ],
        columns: {
          title: "Supplier on-time delivery by month",
          labels: MONTHS,
          values: [84.1, 85.6, 86.2, 88.0, 87.1, 88.9, 86.5, 89.2, 88.4],
          format: PERCENT,
          target: { value: 92, label: "Target 92%" },
          line: true,
        },
        bars: {
          title: "Late deliveries by supplier (YTD)",
          labels: ["Anadolu Döküm", "Nordic Bearings", "Polska Elektro", "Rheintal Hydraulik", "Lombardia Valvole"],
          values: [38, 21, 17, 12, 7],
        },
      },
    ],
  },
  {
    key: "ap-aging",
    name: "Accounts payable aging",
    summary: "Open supplier invoices by how overdue they are, and invoices blocked for payment.",
    tool: "Power BI",
    status: "Live",
    workspace: "Finance",
    purpose:
      "Accounts payable plans the week's payments with it and follows the goal of posting invoices within 3 days: open and overdue amounts by supplier and age, blocked invoices and days payable outstanding.",
    audience: ["Accounts payable", "Finance manager", "CFO"],
    owner: "burak.sahin",
    pages: ["Aging", "Blocked invoices", "DPO"],
    measures: [
      ["Open AP", "Supplier invoices not yet paid.", "[Open AP] (Finance model)", "₺ #,0"],
      ["Overdue AP", "Open supplier invoices past their due date.", "[Overdue AP] (Finance model)", "₺ #,0"],
      ["DPO", "Days payable outstanding: how long the company takes to pay.", "[DPO] (Finance model)", "#,0"],
      ["Days to post", "From an invoice's receipt to its posting in SAP, on average.", "AVERAGE(fact_ap_invoices[days_to_post])", "#,0.0"],
    ],
    dimensions: [
      ["Supplier", "dim_supplier", "Category › Supplier", ""],
      ["Age", "fact_ap_invoices.days_overdue", "Not due › 1–30 › 31–60 › 61–90 › 90+", "Days past the due date, in buckets."],
      ["Due week", "dim_date", "Year › Week", ""],
    ],
    refresh: "Daily at 07:00 (with the Finance model)",
    refreshed: 0,
    views: 58,
    personal: "None",
    url: powerBi("Finance", "ap-aging"),
    issues: ["Days to post needs the receipt date, which the warehouse only has since March"],
    builtOn: [
      ["finance-model", "Live connection"],
      ["dwh/fact_ap_invoices", "Blocked invoices page reads it directly (DirectQuery)"],
    ],
    reportsOn: [process("finance.accounts-payable"), goal("invoice-days")],
    experts: [["elif.arslan", "Can do it"]],
    screens: [
      {
        page: "Aging",
        slicers: ["Company: 1000", "Category: All"],
        cards: [
          { label: "Open AP", value: "₺96.4M" },
          { label: "Overdue AP", value: "₺11.8M", note: "12.2% of open", good: false },
          { label: "DPO", value: "58 days", note: "▲ 3 vs August" },
          { label: "Days to post", value: "4.6", note: "Goal 3 days", good: false },
        ],
        bars: {
          title: "Open AP by age",
          labels: ["Not due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"],
          values: [84.6, 7.9, 2.4, 0.9, 0.6],
          format: MILLION_TRY,
        },
        table: {
          title: "Overdue by supplier",
          headers: ["Supplier", "Overdue", "Oldest", "Blocked"],
          rows: [
            ["Anadolu Döküm Sanayi Ltd. Şti.", "₺3.4M", "47 days", "1 invoice"],
            ["Polska Elektro Sp. z o.o.", "₺2.1M", "33 days", "—"],
            ["Nordic Bearings AB", "₺1.6M", "28 days", "2 invoices"],
            ["Lombardia Valvole S.p.A.", "₺0.9M", "64 days", "—"],
            ["Rheintal Hydraulik GmbH", "₺0.7M", "12 days", "—"],
          ],
        },
      },
    ],
  },
  {
    key: "monthly-pl",
    name: "Monthly P&L",
    summary: "The month's profit and loss by company, profit centre and account group, against budget and last year.",
    tool: "Power BI",
    status: "Live",
    workspace: "Finance",
    purpose:
      "The finance team's report for the month-end close and the management pack: revenue, cost of sales, operating expenses and EBITDA for each company and profit centre, against the budget and last year. It is published on the fifth working day.",
    audience: ["CFO", "Finance team", "Executive team", "Board of directors"],
    owner: "hande.ozkan",
    pages: ["P&L", "By profit centre", "Bridge to last year"],
    measures: [
      ["Revenue", "Revenue accounts of the month.", "[Revenue] (Finance model)", "₺ #,0"],
      ["EBITDA", "Earnings before interest, taxes, depreciation and amortisation.", "[EBITDA] (Finance model)", "₺ #,0"],
      ["EBITDA margin %", "EBITDA as a share of revenue.", "[EBITDA margin %] (Finance model)", "0.0%"],
      ["Budget variance", "Actual minus budget.", "[EBITDA] - [EBITDA budget]", "₺ #,0"],
    ],
    dimensions: [
      ["Period", "dim_date", "Year › Quarter › Month", "Closed months only."],
      ["Company", "fact_gl.company_code", "", "1000 Acme Pompa, 3000 Acme Pumpen GmbH."],
      ["Account", "fact_gl.account_group", "Account group › G/L account", ""],
      ["Profit centre", "fact_gl.profit_center", "", ""],
    ],
    filters: ["Closed periods only", "Currency: TRY"],
    refresh: "Daily at 07:00; the numbers change only after a close",
    refreshed: 0,
    views: [131, 133, 138, 140],
    personal: "None",
    url: powerBi("Finance", "monthly-pl"),
    issues: ["Acme Pumpen GmbH's numbers arrive from DATEV a week after the close: the first version each month shows Türkiye only"],
    builtOn: [["finance-model", "Live connection"]],
    reportsOn: [process("finance.month-end-close"), process("consolidation-reporting"), department("finance")],
    experts: [
      ["hande.ozkan", "Expert"],
      ["selin.arslan", "Can do it"],
    ],
    screens: [
      {
        page: "P&L",
        slicers: ["Period: Sep 2026", "Company: All"],
        cards: [
          { label: "Revenue", value: "₺94.1M", note: "▲ 2.3% vs budget", good: true },
          { label: "Gross margin", value: "31.0%", note: "▼ 0.6 pt vs budget", good: false },
          { label: "EBITDA", value: "₺13.9M", note: "▲ ₺0.7M vs budget", good: true },
          { label: "EBITDA margin", value: "14.8%", note: "▲ 0.9 pt vs 2025", good: true },
        ],
        columns: { title: "EBITDA by month", labels: MONTHS, values: wander("pl-ebitda", 9, 12.5, 1.6, 0.12), format: MILLION_TRY },
        table: {
          title: "Profit and loss, September",
          headers: ["", "Actual", "Budget", "Variance", "Last year"],
          rows: [
            ["Revenue", "₺94.1M", "₺92.0M", "▲ ₺2.1M", "₺81.6M"],
            ["Cost of sales", "-₺64.9M", "-₺62.9M", "▼ -₺2.0M", "-₺56.5M"],
            ["Gross margin", "₺29.2M", "₺29.1M", "▲ ₺0.1M", "₺25.1M"],
            ["Operating expenses", "-₺15.3M", "-₺15.9M", "▲ ₺0.6M", "-₺13.8M"],
            ["EBITDA", "₺13.9M", "₺13.2M", "▲ ₺0.7M", "₺11.3M"],
          ],
        },
      },
    ],
  },
  {
    key: "cash-flow",
    name: "Cash flow forecast",
    summary: "The CFO's weekly cash forecast for the next 13 weeks, kept in Excel.",
    tool: "Excel",
    status: "Live",
    workspace: "SharePoint › Finance › Treasury",
    purpose:
      "Shows the CFO and the finance manager whether there is enough cash for the next 13 weeks: expected customer receipts, supplier payments, payroll and taxes, bank by bank. It decides when to use the credit lines.",
    audience: ["CFO", "Finance manager"],
    owner: "elif.yilmaz",
    pages: ["13 weeks", "By bank", "Input"],
    measures: [
      ["Closing balance", "Cash at the end of the week, all banks.", "=Opening + Receipts - Payments - Payroll - Taxes", "₺ #,0"],
      ["Receipts", "What customers are expected to pay that week.", "Typed in from the collections list", "₺ #,0"],
      ["Payments", "Supplier payments planned that week.", "From the AP payment proposal", "₺ #,0"],
    ],
    dimensions: [
      ["Week", "Sheet '13 weeks', column A", "", "Weeks starting on Monday."],
      ["Bank", "Sheet 'By bank'", "", "Garanti, İş Bankası, Deutsche Bank (Hamburg)."],
    ],
    refresh: "Every Monday, by hand",
    refreshed: 1,
    views: 18,
    personal: "None",
    url: "https://acme.sharepoint.com/sites/finance/Treasury/Cash%20flow%20forecast.xlsx",
    issues: [
      "Updated by hand on Mondays: check the date on the first sheet before using it",
      "Two copies travel by email; the one on SharePoint is the right one",
    ],
    builtOn: [["cash-flow-xlsx", "Sheets of the same workbook"]],
    reportsOn: [process("finance.collections"), department("finance")],
    screens: [
      {
        page: "13 weeks",
        cards: [
          { label: "Cash today", value: "₺48.2M" },
          { label: "Lowest week", value: "₺21.5M", note: "W46: payroll and VAT", good: false },
          { label: "Receipts, 13 weeks", value: "₺301.4M" },
          { label: "Payments, 13 weeks", value: "₺286.9M" },
        ],
        columns: {
          title: "Closing balance by week",
          labels: ["W41", "W42", "W43", "W44", "W45", "W46", "W47", "W48", "W49", "W50", "W51", "W52", "W1"],
          values: [48.2, 44.9, 39.1, 33.7, 28.4, 21.5, 26.8, 31.2, 35.9, 33.0, 38.6, 42.1, 44.5],
          format: MILLION_TRY,
          target: { value: 20, label: "Minimum ₺20M" },
        },
      },
    ],
  },
  {
    key: "it-service-desk",
    name: "IT service desk",
    summary: "Tickets opened and solved, SLA and the most common requests.",
    tool: "Power BI",
    status: "Live",
    workspace: "IT",
    purpose:
      "IT follows its service level with it: tickets opened and solved each week, the share solved within the SLA, the oldest open tickets, and the most common requests, to see what an AI employee or a fix could take away.",
    audience: ["IT team", "IT manager"],
    owner: "mehmet.oz",
    pages: ["Overview", "Requests", "Open tickets"],
    measures: [
      ["Tickets opened", "Tickets and requests opened.", "COUNTROWS(tickets)", "#,0"],
      ["SLA met %", "Tickets solved within their SLA.", "DIVIDE(COUNTROWS(FILTER(tickets, tickets[slaMet])), COUNTROWS(tickets))", "0.0%"],
      [
        "Median hours to solve",
        "Half of the tickets are solved faster than this.",
        "MEDIANX(tickets, DATEDIFF(tickets[created], tickets[resolved], HOUR))",
        "#,0.0",
      ],
    ],
    dimensions: [
      ["Week", "tickets.created", "Year › Week", ""],
      ["Request type", "tickets.requestType", "", "Password, access, hardware, SAP, other."],
      ["Priority", "tickets.priority", "", ""],
    ],
    refresh: "Every hour",
    refreshed: 0,
    views: 41,
    personal: "Some",
    url: powerBi("IT", "it-service-desk"),
    builtOn: [["service-desk-tickets", "Import from the Jira API, hourly"]],
    reportsOn: [process("it.helpdesk-triage"), department("it"), { kind: "system", key: "jira-service-management" }],
    screens: [
      {
        page: "Overview",
        slicers: ["Last 13 weeks", "Priority: All"],
        cards: [
          { label: "Opened this week", value: "64", note: "▼ 9 vs last week", good: true },
          { label: "SLA met", value: "93.4%", note: "Target 90%", good: true },
          { label: "Median hours to solve", value: "3.2" },
          { label: "Open now", value: "27", note: "4 older than a week", good: false },
        ],
        columns: { title: "Tickets opened by week", labels: WEEKS, values: wander("itsm", 13, 70, 9, -0.6).map(Math.round) },
        bars: {
          title: "Most common requests",
          labels: ["Password reset", "Access to a folder", "SAP authorisation", "New laptop", "Printer"],
          values: [212, 148, 96, 61, 43],
        },
      },
    ],
  },
  {
    key: "headcount-leave",
    name: "Headcount & leave",
    summary: "People by department and site, joiners and leavers, and leave taken and left.",
    tool: "Power BI",
    status: "Live",
    workspace: "HR",
    purpose:
      "HR and department heads see how many people work where, who joined and left, and how much leave people have left before the year ends. Row-level security shows each manager their own team only.",
    audience: ["HR", "Department heads (their own team)"],
    owner: "gizem.polat",
    pages: ["Headcount", "Joiners and leavers", "Leave"],
    measures: [
      ["Headcount", "People employed on the last day of the month.", "DISTINCTCOUNT(headcount[employee_id])", "#,0"],
      ["FTE", "Full-time equivalents.", "SUM(headcount[fte])", "#,0.0"],
      ["Leave days left", "Leave days people have not taken yet this year.", "SUM(headcount[leave_left])", "#,0"],
    ],
    dimensions: [
      ["Department", "headcount.department", "", ""],
      ["Site", "headcount.site", "", "Istanbul HQ, Gebze plant, Hamburg office."],
      ["Month", "headcount file name", "Year › Month", ""],
    ],
    filters: ["Row-level security: managers see their own team"],
    refresh: "Monthly, after payroll",
    refreshed: 9,
    views: 37,
    personal: "Sensitive",
    url: powerBi("HR", "headcount-leave"),
    builtOn: [["hr-headcount-export", "Import of the monthly CSV"]],
    reportsOn: [process("hr.leave-management"), department("hr")],
    screens: [
      {
        page: "Headcount",
        slicers: ["Month: Sep 2026", "Site: All"],
        cards: [
          { label: "Headcount", value: "312", note: "▲ 6 since January" },
          { label: "FTE", value: "305.5" },
          { label: "Joiners YTD", value: "29" },
          { label: "Leavers YTD", value: "23", note: "Turnover 7.4%" },
        ],
        bars: {
          title: "Headcount by department",
          labels: ["Operations", "Sales", "Customer Service", "Finance", "Procurement", "IT", "HR", "Management"],
          values: [198, 34, 22, 18, 12, 11, 9, 8],
        },
        columns: { title: "Headcount by month", labels: MONTHS, values: [306, 307, 305, 308, 309, 310, 311, 313, 312] },
      },
    ],
  },
  {
    key: "pump-test-results",
    name: "Pump test results",
    summary: "First-pass yield and vibration of every pump on the test benches, by bench and model.",
    tool: "Power BI",
    status: ["In development", "In development", "Live"],
    workspace: "Operations",
    purpose:
      "Shows how many pumps pass the final test the first time, which models and benches fail most, and the vibration trend that warns of assembly problems, so engineering can act before a customer complains (as with Petrokim's vibration).",
    audience: ["Production engineering", "Quality team", "Test bench team"],
    owner: "deniz.celik",
    pages: ["First-pass yield", "Vibration", "By serial number"],
    measures: [
      [
        "First-pass yield %",
        "Pumps that passed the final test the first time.",
        "DIVIDE(CALCULATE(COUNTROWS(test_results), test_results[attempt] = 1, test_results[passed] = 1), CALCULATE(COUNTROWS(test_results), test_results[attempt] = 1))",
        "0.0%",
      ],
      ["Average vibration", "Average vibration at the duty point, in mm/s.", "AVERAGE(telemetry[vibration_mm_s])", "0.00"],
      ["Pumps tested", "Pumps that went through the final test.", "DISTINCTCOUNT(test_results[serial_no])", "#,0"],
    ],
    dimensions: [
      ["Day", "test_results.tested_at", "Year › Month › Day", ""],
      ["Test bench", "test_results.bench_id", "", "TB1 and TB2."],
      ["Model", "MARA via the serial number", "Product line › Model", ""],
    ],
    refresh: "Every 15 minutes (DirectQuery to MES_PROD)",
    refreshed: 0,
    views: [6, 9, 52, 61],
    personal: "None",
    url: powerBi("Operations", "pump-test-results"),
    issues: ["Vibration comes from the data lake, which the gateway reads slowly: the Vibration page takes 20 seconds to open"],
    builtOn: [
      ["mes-db/test_results", "DirectQuery"],
      ["test-bench-telemetry", "Import of daily averages"],
    ],
    reportsOn: [process("pump-final-test"), { kind: "system", key: "pumptest-pro" }, { kind: "site", key: "gebze-plant" }],
    experts: [
      ["deniz.celik", "Expert"],
      ["hakan.erdogan", "Can do it"],
    ],
    screens: [
      {
        page: "First-pass yield",
        slicers: ["Last 13 weeks", "Bench: All"],
        cards: [
          { label: "First-pass yield", value: "96.1%", note: "Target 97%", good: false },
          { label: "Pumps tested", value: "1,184" },
          { label: "Average vibration", value: "2.31 mm/s", note: "Limit 4.5", good: true },
          { label: "Retests", value: "46" },
        ],
        columns: {
          title: "First-pass yield by week",
          labels: WEEKS,
          values: [95.2, 95.8, 96.4, 94.9, 95.6, 96.8, 96.2, 95.1, 96.9, 97.2, 96.5, 96.0, 96.6],
          format: PERCENT,
          target: { value: 97, label: "Target 97%" },
          line: true,
        },
        bars: { title: "Failed tests by model", labels: ["ACP-80", "ACP-65", "AV-50", "PS-100"], values: [21, 12, 8, 5] },
      },
    ],
  },
  {
    key: "weekly-sales-ssrs",
    name: "Weekly sales list (old)",
    summary: "The old SQL Server report of last week's orders, replaced by Sales & margin.",
    tool: "SSRS",
    status: "Retired",
    workspace: "Report server › Sales",
    purpose: "Listed last week's orders by customer every Monday. Sales & margin replaced it in 2025; it stays until the last two readers have moved.",
    audience: ["Two people in sales still get it by email"],
    owner: "thomas.weber",
    pages: ["Orders"],
    measures: [["Order value", "Order value before VAT.", "SUM(net_revenue_try)", "N0"]],
    dimensions: [["Customer", "dim_customer.name", "", ""]],
    refresh: "Every Monday at 07:00 (subscription)",
    refreshed: 1,
    views: 3,
    personal: "None",
    url: "http://gbz-sql01.acme.local/Reports/report/Sales/Weekly%20sales",
    issues: ["Still emailed to two people every Monday: move them to Sales & margin and switch the subscription off"],
    builtOn: [
      ["dwh/fact_sales", "SQL query"],
      ["dwh/dim_customer", "SQL query"],
    ],
    reportsOn: [department("sales")],
    screens: [
      {
        page: "Orders",
        cards: [
          { label: "Orders last week", value: "31" },
          { label: "Order value", value: "₺21.4M" },
        ],
        table: {
          title: "Orders, week 40",
          headers: ["Customer", "Order", "Date", "Value"],
          rows: [
            ["Petrokim Rafineri A.Ş.", "0000412877", "29.09.2026", "₺4,812,500"],
            ["Gulf Water Solutions LLC", "0000412881", "29.09.2026", "₺3,960,000"],
            ["Boğaziçi Su Teknolojileri A.Ş.", "0000412890", "30.09.2026", "₺2,145,300"],
            ["Kuzey Gıda Üretim A.Ş.", "0000412902", "01.10.2026", "₺1,207,800"],
            ["Nordwind Energy A/S", "0000412915", "02.10.2026", "₺986,400"],
            ["Ege Sulama Sistemleri Ltd. Şti.", "0000412921", "02.10.2026", "₺512,000"],
            ["Polimer Plastik Sanayi A.Ş.", "0000412933", "03.10.2026", "₺348,900"],
          ],
        },
      },
    ],
  },
];

interface DemoNews {
  wave?: number;
  days: number;
  title: string;
  body?: string;
  by?: string;
  about: SourceRef[];
}

const report = (key: string): SourceRef => ({ kind: "report", key });
const dataset = (key: string): SourceRef => ({ kind: "dataset", key });

const NEWS: DemoNews[] = [
  {
    days: -15,
    title: "Sales & margin: the Customers page shows margin by segment",
    by: "thomas.weber",
    about: [report("sales-margin")],
  },
  {
    days: -9,
    title: "Refresh failed: Finance semantic model",
    body: "The data gateway in Gebze was restarting at 07:00. Hande Özkan refreshed the model by hand at 09:40; Monthly P&L and Accounts payable aging were a few hours late.",
    about: [dataset("finance-model"), report("monthly-pl"), report("ap-aging")],
  },
  {
    days: -4,
    title: "Monthly P&L for September published",
    body: "Türkiye only for now: Acme Pumpen GmbH's numbers follow from DATEV next week.",
    by: "hande.ozkan",
    about: [report("monthly-pl"), process("finance.month-end-close")],
  },
  {
    wave: 1,
    days: 0,
    title: "Nightly copy from MES_PROD failed again: production data is two days behind",
    body: "Azure Data Factory could not sign in to MES_PROD at 02:00, last night and the night before. Production performance and Quality show old numbers until it runs again.",
    about: [tableRef("dwh/fact_production"), dataset("operations-model"), report("production-oee"), report("quality-complaints")],
  },
  {
    wave: 2,
    days: 0,
    title: "Sales & margin: new page Export, for the export share goal",
    by: "thomas.weber",
    about: [report("sales-margin"), goal("export-share")],
  },
  {
    wave: 2,
    days: 0,
    title: "Pump test results is live for the test bench team",
    by: "deniz.celik",
    about: [report("pump-test-results"), process("pump-final-test")],
  },
  {
    wave: 3,
    days: 0,
    title: "Production data is up to date again: the MES copy ran at 10:15",
    by: "can.ozturk",
    about: [tableRef("dwh/fact_production"), report("production-oee")],
  },
];

function screenshots(item: DemoReport, pages: string[], refreshed: string): BrainImage[] {
  return item.screens.map((screen) => ({
    src: dashboardImage({ ...screen, report: item.name, pages, tool: item.tool, refreshed: `Data refreshed ${refreshed}` }),
    caption: `${screen.page} page`,
  }));
}

/** "2026-10-06" → "06/10/2026", as the demo company writes dates. */
function written(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export const biSource: BrainSourceDefinition = {
  key: "bi",
  name: "Power BI (demo)",
  system: "Made-up data standing in for the Power BI service (admin API and scanner)",
  description:
    "The company's BI reports: what each one is for and who reads it, its pages, measures and dimensions, the semantic models and tables behind it, how often it refreshes and how much it is read, with screenshots of its pages. New on each reading: refreshes that failed, new pages, reports going live.",
  brings: ["BI reports and dashboards", "Screenshots", "Measures and dimensions", "Which data each report is built on", "Refreshes and views"],
  icon: "chart-column",
  demo: true,
  priority: 55,
  async read({ domain, now, syncs }) {
    const person = (local: string) => ({ kind: "person" as const, email: `${local}@${domain}` });
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    for (const item of REPORTS) {
      const pages = Array.isArray(item.pages[0]) ? byWave(item.pages as string[][], syncs) : (item.pages as string[]);
      const lastRefreshed = dayOffset(now, -byWave(item.refreshed, syncs));
      const me = { kind: "report" as const, key: item.key };
      entities.push({
        kind: "report",
        key: item.key,
        name: item.name,
        summary: item.summary,
        data: {
          tool: item.tool,
          status: byWave(item.status, syncs),
          purpose: item.purpose,
          audience: item.audience,
          screenshots: screenshots(item, pages, written(lastRefreshed)),
          measures: item.measures.map(([name, definition, formula, format]): BrainMeasure => ({ name, definition, formula, format: format ?? "" })),
          dimensions: item.dimensions.map(
            ([name, source, levels, description]): BrainDataDimension => ({ name, source, levels: levels ?? "", description: description ?? "" }),
          ),
          filters: item.filters,
          pages,
          url: item.url,
          workspace: item.workspace,
          refresh: item.refresh,
          last_refreshed: lastRefreshed,
          views: byWave(item.views, syncs),
          personal_data: item.personal,
          issues: item.issues,
        },
      });
      links.push({ from: person(item.owner), relation: "owns", to: me });
      for (const [target, how] of item.builtOn)
        links.push({ from: me, relation: "built_on", to: target.includes("/") ? tableRef(target) : dataset(target), detail: how });
      for (const about of item.reportsOn) links.push({ from: me, relation: "reports_on", to: about });
      for (const [expert, level] of item.experts ?? []) links.push({ from: person(expert), relation: "knows", to: me, detail: level });
      if (item.tool === "Power BI") links.push({ from: me, relation: "part_of", to: { kind: "system", key: "power-bi" } });
    }
    const events: SourceEvent[] = released(NEWS, syncs).map((news, index) => ({
      ref: `bi:${NEWS.indexOf(news)}`,
      at: waveMoment(now, news.wave ?? 0, news.days, index),
      kind: "update",
      title: news.title,
      body: news.body,
      actor: news.by ? `${news.by}@${domain}` : undefined,
      place: "Power BI",
      about: news.about,
    }));
    return { entities, links, events };
  },
};
