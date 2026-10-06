/**
 * Pictures of the demo company's report pages, drawn as SVG: what a screenshot of a Power BI page
 * would show (the title bar, number cards, a column chart, a bar chart, a table and the page tabs),
 * so the demo reports have screenshots without any files.
 */

export interface Format {
  prefix?: string;
  suffix?: string;
  decimals?: number;
}

export interface DashboardCard {
  label: string;
  value: string;
  /** Against the target or last year: "▲ 4.1% vs 2025". */
  note?: string;
  /** Colours the note: green when good, red when not. */
  good?: boolean;
}

export interface DashboardSeries {
  title: string;
  labels: string[];
  values: number[];
  format?: Format;
  /** A dashed line across the chart: "Target 95%". */
  target?: { value: number; label: string };
  /** Draw a line instead of columns. */
  line?: boolean;
}

export interface DashboardPage {
  report: string;
  page: string;
  /** All of the report's pages, for the tabs; the current one is highlighted. */
  pages: string[];
  tool?: string;
  /** "Data refreshed 06/10/2026 06:12". */
  refreshed?: string;
  slicers?: string[];
  cards: DashboardCard[];
  columns?: DashboardSeries;
  bars?: DashboardSeries;
  table?: { title: string; headers: string[]; rows: string[][] };
}

const W = 1280;
const H = 720;
const INK = "#252423";
const MUTED = "#605E5C";
const LINE = "#E1DFDD";
const BLUE = "#118DFF";
const NAVY = "#12239E";
const ORANGE = "#E66C37";
const GOOD = "#107C10";
const BAD = "#D13438";
const ACCENT: Record<string, string> = { "Power BI": "#F2C811", Excel: "#217346", SSRS: "#C43E1C", Tableau: "#E97627", "Qlik Sense": "#009845" };
const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function text(
  x: number,
  y: number,
  words: string,
  options: { size?: number; color?: string; weight?: number; anchor?: "start" | "middle" | "end" } = {},
): string {
  const { size = 12, color = INK, weight = 400, anchor = "start" } = options;
  return `<text x="${round(x)}" y="${round(y)}" font-size="${size}" fill="${color}"${weight === 400 ? "" : ` font-weight="${weight}"`}${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${escape(words)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatNumber(n: number, format: Format = {}): string {
  const decimals = format.decimals ?? (Math.abs(n) < 10 && !Number.isInteger(n) ? 1 : 0);
  const words = n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${format.prefix ?? ""}${words}${format.suffix ?? ""}`;
}

/** A round top for an axis: 0.95 → 1, 1234 → 1500. */
function niceTop(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (steps.find((s) => s * power >= max) ?? 10) * power;
}

/** A round step between gridlines: 1.7 → 2, 0.36 → 0.5. */
function niceStep(size: number): number {
  const power = 10 ** Math.floor(Math.log10(size));
  return ([1, 2, 2.5, 5, 10].find((s) => s * power >= size) ?? 10) * power;
}

/**
 * The axis of a chart: columns start at zero; a line zooms in on where its values are, as BI
 * tools do, and a percentage stops at 100%.
 */
function axisOf(series: DashboardSeries): { low: number; high: number } {
  const values = [...series.values, ...(series.target ? [series.target.value] : [])];
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  if (!series.line) return { low: 0, high: niceTop(highest * 1.08) };
  const step = niceStep(Math.max(highest - lowest, highest * 0.02) / 2);
  const low = Math.max(0, Math.floor((lowest - step) / step) * step);
  const high = Math.ceil((highest + step / 2) / step) * step;
  return { low, high: series.format?.suffix === "%" && highest <= 100 ? Math.min(high, 100) : high };
}

/** Shortens a long label to fit about `chars` characters. */
function fit(words: string, chars: number): string {
  return words.length > chars ? `${words.slice(0, chars - 1)}…` : words;
}

function card(x: number, y: number, w: number, h: number, item: DashboardCard): string {
  const parts = [rect(x, y, w, h, "#FFFFFF", `rx="4" stroke="${LINE}"`)];
  parts.push(text(x + w / 2, y + 48, item.value, { size: 32, weight: 600, anchor: "middle" }));
  parts.push(text(x + w / 2, y + 72, fit(item.label, 38), { size: 13, color: MUTED, anchor: "middle" }));
  if (item.note)
    parts.push(text(x + w / 2, y + 92, fit(item.note, 44), { size: 12, color: item.good === undefined ? MUTED : item.good ? GOOD : BAD, anchor: "middle" }));
  return parts.join("");
}

function columnChart(x: number, y: number, w: number, h: number, series: DashboardSeries): string {
  const parts = [rect(x, y, w, h, "#FFFFFF", `rx="4" stroke="${LINE}"`), text(x + 16, y + 26, series.title, { size: 14, weight: 600 })];
  const left = x + 64;
  const right = x + w - 20;
  const top = y + 48;
  const bottom = y + h - 34;
  const { low, high } = axisOf(series);
  const at = (value: number) => bottom - ((value - low) / (high - low)) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const value = low + ((high - low) / 4) * i;
    const level = at(value);
    parts.push(`<line x1="${left}" y1="${round(level)}" x2="${right}" y2="${round(level)}" stroke="${i ? "#F0F0F0" : LINE}"/>`);
    const decimals = Number.isInteger(Math.round(value * 1000) / 1000) ? 0 : 1;
    parts.push(text(left - 8, level + 4, formatNumber(value, { ...series.format, decimals }), { size: 11, color: MUTED, anchor: "end" }));
  }
  const slot = (right - left) / series.values.length;
  if (series.line) {
    const points = series.values.map((value, i) => `${round(left + slot * (i + 0.5))},${round(at(value))}`);
    parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${BLUE}" stroke-width="3"/>`);
    for (const point of points) {
      const [px, py] = point.split(",");
      parts.push(`<circle cx="${px}" cy="${py}" r="4" fill="${BLUE}"/>`);
    }
  } else {
    const width = Math.min(slot * 0.62, 56);
    series.values.forEach((value, i) => {
      const cx = left + slot * (i + 0.5);
      parts.push(rect(cx - width / 2, at(value), width, bottom - at(value), BLUE));
    });
  }
  const every = Math.ceil(series.labels.length / 14);
  series.labels.forEach((label, i) => {
    if (i % every === 0) parts.push(text(left + slot * (i + 0.5), bottom + 18, fit(label, 10), { size: 11, color: MUTED, anchor: "middle" }));
  });
  if (series.target) {
    // The target line, named in a legend beside the title (where it covers nothing).
    const level = at(series.target.value);
    const dash = `stroke="${ORANGE}" stroke-width="2" stroke-dasharray="6 4"`;
    parts.push(`<line x1="${left}" y1="${round(level)}" x2="${right}" y2="${round(level)}" ${dash}/>`);
    const legend = x + w - 16 - series.target.label.length * 6.6;
    parts.push(`<line x1="${round(legend - 30)}" y1="${y + 22}" x2="${round(legend - 8)}" y2="${y + 22}" ${dash}/>`);
    parts.push(text(legend, y + 26, series.target.label, { size: 12, color: MUTED }));
  }
  return parts.join("");
}

function barChart(x: number, y: number, w: number, h: number, series: DashboardSeries): string {
  const parts = [rect(x, y, w, h, "#FFFFFF", `rx="4" stroke="${LINE}"`), text(x + 16, y + 26, series.title, { size: 14, weight: 600 })];
  const rows = series.labels.slice(0, 8);
  const top = y + 44;
  const row = Math.min(36, (h - 56) / rows.length);
  const left = x + 150;
  const right = x + w - 70;
  const max = Math.max(...series.values.slice(0, rows.length), 0) || 1;
  rows.forEach((label, i) => {
    const value = series.values[i] ?? 0;
    const cy = top + row * i + row / 2;
    parts.push(text(left - 10, cy + 4, fit(label, 20), { size: 12, color: INK, anchor: "end" }));
    parts.push(rect(left, cy - row * 0.32, Math.max(2, ((right - left) * value) / max), row * 0.64, NAVY));
    parts.push(text(left + ((right - left) * value) / max + 6, cy + 4, formatNumber(value, series.format), { size: 11, color: MUTED }));
  });
  return parts.join("");
}

function tableBlock(x: number, y: number, w: number, h: number, table: NonNullable<DashboardPage["table"]>): string {
  const parts = [rect(x, y, w, h, "#FFFFFF", `rx="4" stroke="${LINE}"`), text(x + 16, y + 26, table.title, { size: 14, weight: 600 })];
  const columns = table.headers.length;
  const first = Math.max(0.28, 1 / columns);
  const rest = (1 - first) / Math.max(1, columns - 1);
  const widths = table.headers.map((_, i) => (i === 0 ? first : rest) * (w - 32));
  const starts = widths.map((_, i) => x + 16 + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const top = y + 40;
  const row = 22;
  parts.push(rect(x + 16, top, w - 32, row, "#F3F2F1"));
  table.headers.forEach((header, i) => {
    const end = i > 0;
    parts.push(text(end ? starts[i]! + widths[i]! - 8 : starts[i]! + 8, top + 15, header, { size: 12, weight: 600, anchor: end ? "end" : "start" }));
  });
  const fits = Math.floor((h - 52 - row) / row);
  table.rows.slice(0, fits).forEach((cells, r) => {
    const cy = top + row * (r + 1);
    if (r % 2 === 1) parts.push(rect(x + 16, cy, w - 32, row, "#FAFAFA"));
    cells.forEach((cell, i) => {
      const end = i > 0;
      const color = /^▲/.test(cell) ? GOOD : /^▼/.test(cell) ? BAD : INK;
      parts.push(
        text(end ? starts[i]! + widths[i]! - 8 : starts[i]! + 8, cy + 15, fit(cell, i === 0 ? 40 : 18), { size: 12, color, anchor: end ? "end" : "start" }),
      );
    });
  });
  return parts.join("");
}

/** The page as an SVG picture, 1280 × 720. */
export function dashboardSvg(page: DashboardPage): string {
  const accent = ACCENT[page.tool ?? "Power BI"] ?? "#8A8886";
  const parts: string[] = [];
  parts.push(rect(0, 0, W, H, "#EAEAEA"));
  // Title bar
  parts.push(rect(0, 0, W, 56, "#FFFFFF"), rect(0, 0, 6, 56, accent), `<line x1="0" y1="56" x2="${W}" y2="56" stroke="${LINE}"/>`);
  parts.push(text(24, 36, fit(page.report, 44), { size: 22, weight: 600 }));
  let sx = W - 24;
  for (const slicer of [...(page.slicers ?? [])].reverse()) {
    const width = Math.max(110, slicer.length * 7 + 34);
    sx -= width;
    parts.push(
      rect(sx, 14, width, 28, "#FFFFFF", `rx="3" stroke="${LINE}"`),
      text(sx + 10, 32, slicer, { size: 12, color: INK }),
      text(sx + width - 12, 32, "▾", { size: 11, color: MUTED }),
    );
    sx -= 10;
  }
  // Number cards
  const cards = page.cards.slice(0, 4);
  const gap = 16;
  const cardWidth = (W - 48 - gap * (cards.length - 1)) / Math.max(1, cards.length);
  cards.forEach((item, i) => parts.push(card(24 + i * (cardWidth + gap), 72, cardWidth, 104, item)));
  // Charts and table
  const chartsTop = 192;
  const chartsHeight = page.table ? 250 : 474;
  if (page.columns && page.bars) {
    parts.push(columnChart(24, chartsTop, 784, chartsHeight, page.columns), barChart(824, chartsTop, W - 848, chartsHeight, page.bars));
  } else if (page.columns) {
    parts.push(columnChart(24, chartsTop, W - 48, chartsHeight, page.columns));
  } else if (page.bars) {
    parts.push(barChart(24, chartsTop, W - 48, chartsHeight, page.bars));
  }
  if (page.table)
    parts.push(
      tableBlock(
        24,
        page.columns || page.bars ? chartsTop + chartsHeight + 16 : chartsTop,
        W - 48,
        page.columns || page.bars ? H - 40 - (chartsTop + chartsHeight + 16) - 8 : 474,
        page.table,
      ),
    );
  // Page tabs and refresh time
  parts.push(rect(0, H - 32, W, 32, "#F3F2F1"), `<line x1="0" y1="${H - 32}" x2="${W}" y2="${H - 32}" stroke="${LINE}"/>`);
  let tx = 16;
  for (const name of page.pages) {
    const width = name.length * 7 + 28;
    const current = name === page.page;
    if (current) parts.push(rect(tx, H - 32, width, 32, "#FFFFFF"), rect(tx, H - 3, width, 3, accent));
    parts.push(text(tx + width / 2, H - 11, name, { size: 12, color: current ? INK : MUTED, weight: current ? 600 : 400, anchor: "middle" }));
    tx += width + 4;
  }
  if (page.refreshed) parts.push(text(W - 16, H - 11, page.refreshed, { size: 11, color: MUTED, anchor: "end" }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${parts.join("")}</svg>`;
}

/** The page as a picture a brain field keeps: a data:image/svg+xml address. */
export function dashboardImage(page: DashboardPage): string {
  return `data:image/svg+xml;base64,${Buffer.from(dashboardSvg(page), "utf8").toString("base64")}`;
}

/** Numbers that wander a little around a level, the same each time for the same seed. */
export function wander(seed: string, count: number, level: number, spread: number, trend = 0): number[] {
  let state = [...seed].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 0xffffffff;
  };
  return Array.from({ length: count }, (_, i) => Math.max(0, level + trend * i + (next() - 0.5) * 2 * spread));
}
