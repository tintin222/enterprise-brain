import { getPath, isRecord } from "./util.ts";

/**
 * Safe template + expression engine used by workflows.
 *
 *   "{{ steps.evaluate.score }}"            -> raw value (number)
 *   "Hello {{ input.name | default:'there' }}" -> interpolated string
 *   evaluateExpression("steps.evaluate.score >= 70 && input.role != 'intern'", ctx)
 *   "{{ formatDate(addDays(run.date, 3), 'DD.MM.YYYY') }}"   -> functions from a fixed list
 *
 * No `eval`, no property access beyond plain data paths, and only the functions listed here.
 */

const SINGLE_EXPR = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
const ANY_EXPR = /\{\{([\s\S]+?)\}\}/g;

type Filter = (value: unknown, arg?: unknown) => unknown;

const FILTERS: Record<string, Filter> = {
  json: (v) => JSON.stringify(v, null, 2),
  join: (v, arg) => (Array.isArray(v) ? v.map((x) => stringify(x)).join(arg === undefined ? ", " : String(arg)) : v),
  default: (v, arg) => (v === undefined || v === null || v === "" ? arg : v),
  upper: (v) => (typeof v === "string" ? v.toUpperCase() : v),
  lower: (v) => (typeof v === "string" ? v.toLowerCase() : v),
  truncate: (v, arg) => {
    const s = stringify(v);
    const n = Number(arg ?? 2000);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  },
  length: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : isRecord(v) ? Object.keys(v).length : 0),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  /** A field of every item of a list: `slots | pluck:'label'`. */
  pluck: (v, arg) => (Array.isArray(v) ? v.map((x) => getPath(x, String(arg ?? ""))) : v),
  round: (v, arg) => {
    const n = Number(v);
    if (Number.isNaN(n)) return v;
    const d = Number(arg ?? 0);
    return Math.round(n * 10 ** d) / 10 ** d;
  },
  bullets: (v) => (Array.isArray(v) ? v.map((x) => `- ${stringify(x)}`).join("\n") : stringify(v)),
  /** The day of a date-time, `receivedAt | date` (UTC) or `receivedAt | date:'Europe/Istanbul'` (that time zone's day): "2026-09-26". */
  date: (v, arg) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
    const instant = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : undefined;
    if (!instant || Number.isNaN(instant.getTime())) return v;
    const zone = arg === undefined || arg === null ? "" : stringify(arg).trim();
    if (!zone) return instant.toISOString().slice(0, 10);
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
    } catch {
      return instant.toISOString().slice(0, 10);
    }
  },
  /** An amount as people read it: `total | money:'TRY'` → "965,664.00 TRY". */
  money: (v, arg) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isNaN(n)) return v;
    const amount = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const currency = arg === undefined || arg === null ? "" : stringify(arg).trim();
    return currency ? `${amount} ${currency}` : amount;
  },
  trim: (v) => (typeof v === "string" ? v.trim() : v),
  /** A text cut into a list: `tags | split:','` (a comma by default; each part trimmed, empty ones dropped). */
  split: (v, arg) =>
    typeof v === "string"
      ? v
          .split(arg === undefined || arg === null ? "," : stringify(arg))
          .map((x) => x.trim())
          .filter(Boolean)
      : v,
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  /** A list without repeats; with a field, the first item of each value: `orders | unique:'customer'`. */
  unique: (v, arg) => (Array.isArray(v) ? uniqueBy(v, arg === undefined || arg === null ? "" : stringify(arg)) : v),
  /** The sum of a list of numbers, or of a field of each item: `lines | sum:'amount'`. */
  sum: (v, arg) => (Array.isArray(v) ? numbersOf(v, arg).reduce((a, b) => a + b, 0) : v),
  keys: (v) => (isRecord(v) ? Object.keys(v) : []),
  number: (v) => toNumber(v),
};

/** The values a list sums or compares: its numbers, or a field of each item. */
function numbersOf(list: unknown[], path?: unknown): number[] {
  const field = path === undefined || path === null ? "" : stringify(path);
  return list.map((x) => toNumber(field ? getPath(x, field) : x)).filter((n): n is number => n !== null);
}

/**
 * A number from a number or a numeric text; null when it isn't one. Texts with both separators take the
 * last one as the decimal point ("1,250.50", "1.250,50"); a single comma not followed by exactly three
 * digits is a decimal comma ("12,5"); otherwise commas separate thousands ("1,250").
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s/g, "");
  if (!text || !/^[-+]?[\d.,]+$/.test(text)) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (comma >= 0) text = (text.match(/,/g) ?? []).length === 1 && !/,\d{3}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function uniqueBy(list: unknown[], path: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of list) {
    const key = JSON.stringify(path ? (getPath(item, path) ?? null) : item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** A date or date-time as an instant; a bare day ("2026-10-13") is that day at midnight UTC. */
function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "") return undefined;
  const date = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The parts of an instant in a time zone (UTC when none, or when the zone is unknown). */
function partsOf(date: Date, zone?: string): Record<"YYYY" | "MM" | "DD" | "HH" | "mm" | "ss", string> {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { YYYY: get("year"), MM: get("month"), DD: get("day"), HH: get("hour"), mm: get("minute"), ss: get("second") };
  } catch {
    return partsOf(date);
  }
}

/** A date in a pattern of YYYY, MM, DD, HH, mm and ss: `formatDate(run.date, 'DD.MM.YYYY')`. */
function formatDate(value: unknown, pattern?: unknown, zone?: unknown): unknown {
  const date = toDate(value);
  if (!date) return value ?? null;
  const parts = partsOf(date, zone === undefined || zone === null ? undefined : stringify(zone));
  const shape = pattern === undefined || pattern === null || stringify(pattern) === "" ? "YYYY-MM-DD" : stringify(pattern);
  return shape.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token as keyof typeof parts]);
}

/** A date moved by whole days; a bare day stays a bare day, an instant stays an instant. */
function addDays(value: unknown, days: unknown): unknown {
  const date = toDate(value);
  const n = toNumber(days);
  if (!date || n === null) return value ?? null;
  const moved = new Date(date.getTime() + n * 86_400_000);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? moved.toISOString().slice(0, 10) : moved.toISOString();
}

type Fn = (...args: unknown[]) => unknown;

/**
 * Functions a template or condition may call. Every filter can be called too, with its value first:
 * `round(steps.total, 2)` is `steps.total | round:2`.
 */
const FUNCTIONS: Record<string, Fn> = {
  ...Object.fromEntries(Object.entries(FILTERS).map(([name, filter]) => [name, (value: unknown, arg?: unknown) => filter(value, arg)])),
  /** Now, as an ISO date-time. */
  now: () => new Date().toISOString(),
  /** Today's day ("2026-10-13"), in a time zone when given. */
  today: (zone) => formatDate(new Date(), "YYYY-MM-DD", zone),
  addDays,
  formatDate,
  /** Whole and part days from the second date to the first: `diffDays(input.due, run.date)`. */
  diffDays: (a, b) => {
    const first = toDate(a);
    const second = toDate(b);
    if (!first || !second) return null;
    return Math.round(((first.getTime() - second.getTime()) / 86_400_000) * 100) / 100;
  },
  replace: (value, from, to) => (typeof value === "string" ? value.split(stringify(from)).join(stringify(to)) : value),
  startsWith: (value, prefix) => typeof value === "string" && value.toLowerCase().startsWith(stringify(prefix).toLowerCase()),
  endsWith: (value, suffix) => typeof value === "string" && value.toLowerCase().endsWith(stringify(suffix).toLowerCase()),
  /** A list ordered by a field: `sortBy(steps.orders.items, 'amount', 'desc')`. */
  sortBy: (list, path, order) => (Array.isArray(list) ? sortList(list, stringify(path ?? ""), stringify(order ?? "asc") === "desc" ? -1 : 1) : list),
  /** The items whose field equals a value: `where(input.lines, 'status', 'open')`. */
  where: (list, path, value) => (Array.isArray(list) ? list.filter((item) => looseEquals(getPath(item, stringify(path ?? "")), value)) : []),
  /** The first value that isn't empty. */
  coalesce: (...values) => values.find((v) => v !== undefined && v !== null && v !== "") ?? null,
  min: (...values) => {
    const numbers = (values.length === 1 && Array.isArray(values[0]) ? numbersOf(values[0]) : numbersOf(values)) as number[];
    return numbers.length ? Math.min(...numbers) : null;
  },
  max: (...values) => {
    const numbers = (values.length === 1 && Array.isArray(values[0]) ? numbersOf(values[0]) : numbersOf(values)) as number[];
    return numbers.length ? Math.max(...numbers) : null;
  },
  /** One value or another: `if(steps.check.approved, 'yes', 'no')`. */
  if: (condition, yes, no) => (truthy(condition) ? yes : (no ?? null)),
  /** Texts and lists joined: `concat(input.first, ' ', input.last)`. */
  concat: (...values) => (values.every(Array.isArray) ? (values as unknown[][]).flat() : values.map((v) => stringify(v)).join("")),
};

/** The names a template may call as functions, and use as filters. */
export const TEMPLATE_FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);
export const TEMPLATE_FILTER_NAMES: readonly string[] = Object.keys(FILTERS);

function sortList(list: unknown[], path: string, direction: 1 | -1): unknown[] {
  return [...list].sort((a, b) => direction * compareValues(path ? getPath(a, path) : a, path ? getPath(b, path) : b));
}

/** Numbers by value, other texts (and ISO dates) in order, empty values last. */
export function compareValues(a: unknown, b: unknown): number {
  const emptyA = a === undefined || a === null || a === "";
  const emptyB = b === undefined || b === null || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return stringify(a).localeCompare(stringify(b));
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function splitFilters(expr: string): { path: string; filters: { name: string; rawArg?: string }[] } {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "|" && depth === 0) {
      if (expr[i + 1] === "|") {
        // logical "or", not a filter pipe
        current += "||";
        i++;
        continue;
      }
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const path = (parts.shift() ?? "").trim();
  const filters = parts.map((p) => {
    const [name, ...rest] = p.split(":");
    const rawArg = rest.join(":").trim();
    return { name: (name ?? "").trim(), rawArg: rawArg || undefined };
  });
  return { path, filters };
}

function evaluateTemplateExpression(expr: string, context: unknown): unknown {
  const { path, filters } = splitFilters(expr);
  let value = evaluateExpression(path, context);
  for (const filter of filters) {
    const fn = FILTERS[filter.name];
    if (!fn) throw new Error(`Unknown template filter "${filter.name}"`);
    let arg: unknown;
    if (filter.rawArg !== undefined) {
      try {
        arg = evaluateExpression(filter.rawArg, context);
      } catch {
        arg = filter.rawArg;
      }
    }
    value = fn(value, arg);
  }
  return value;
}

/** Resolve templates in a string, array or object (recursively). */
export function resolveTemplate(template: unknown, context: unknown): unknown {
  if (typeof template === "string") {
    const single = template.match(SINGLE_EXPR);
    if (single?.[1] !== undefined && !single[1].includes("}}")) {
      return evaluateTemplateExpression(single[1], context);
    }
    return template.replace(ANY_EXPR, (_, expr: string) => stringify(evaluateTemplateExpression(expr, context)));
  }
  if (Array.isArray(template)) return template.map((item) => resolveTemplate(item, context));
  if (isRecord(template)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) out[key] = resolveTemplate(value, context);
    return out;
  }
  return template;
}

export function renderTemplate(template: string, context: unknown): string {
  return stringify(resolveTemplate(template, context));
}

// ---------------------------------------------------------------------------
// Expression parser (recursive descent)
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "punc"; v: string };

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "+", "-", "*", "/"];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== ch) {
        if (input[j] === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 2;
          continue;
        }
        value += input[j];
        j++;
      }
      if (j >= input.length) throw new Error(`Unterminated string in expression: ${input}`);
      tokens.push({ t: "str", v: value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j++;
      tokens.push({ t: "num", v: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_$.]/.test(input[j]!)) j++;
      tokens.push({ t: "id", v: input.slice(i, j).replace(/\.$/, "") });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    if ("()[],".includes(ch)) {
      tokens.push({ t: "punc", v: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression: ${input}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly context: unknown,
    private readonly source: string,
  ) {}

  parse(): unknown {
    const value = this.or();
    if (this.pos < this.tokens.length) throw new Error(`Unexpected token in expression: ${this.source}`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private matchOp(...ops: string[]): string | undefined {
    const tok = this.peek();
    if (tok && tok.t === "op" && ops.includes(tok.v)) {
      this.pos++;
      return tok.v;
    }
    if (tok && tok.t === "id" && ops.includes(tok.v.toLowerCase())) {
      this.pos++;
      return tok.v.toLowerCase();
    }
    return undefined;
  }

  private or(): unknown {
    let left = this.and();
    while (this.matchOp("||", "or")) {
      const right = this.and();
      // JS-like: returns the first truthy operand (useful as a fallback in templates)
      left = truthy(left) ? left : right;
    }
    return left;
  }

  private and(): unknown {
    let left = this.not();
    while (this.matchOp("&&", "and")) {
      const right = this.not();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  private not(): unknown {
    if (this.matchOp("!", "not")) return !truthy(this.not());
    return this.comparison();
  }

  private comparison(): unknown {
    const left = this.additive();
    const op = this.matchOp("==", "!=", ">=", "<=", ">", "<", "in", "contains");
    if (!op) return left;
    const right = this.additive();
    switch (op) {
      case "==":
        return looseEquals(left, right);
      case "!=":
        return !looseEquals(left, right);
      case ">":
        return ordered(left, right) > 0;
      case ">=":
        return ordered(left, right) >= 0;
      case "<":
        return ordered(left, right) < 0;
      case "<=":
        return ordered(left, right) <= 0;
      case "in":
        return contains(right, left);
      case "contains":
        return contains(left, right);
      default:
        throw new Error(`Unknown operator ${op}`);
    }
  }

  private additive(): unknown {
    let left = this.multiplicative();
    for (;;) {
      const op = this.matchOp("+", "-");
      if (!op) return left;
      const right = this.multiplicative();
      if (op === "+") {
        left = typeof left === "string" || typeof right === "string" ? `${stringify(left)}${stringify(right)}` : Number(left) + Number(right);
      } else {
        left = Number(left) - Number(right);
      }
    }
  }

  private multiplicative(): unknown {
    let left = this.unary();
    for (;;) {
      const op = this.matchOp("*", "/");
      if (!op) return left;
      const right = this.unary();
      left = op === "*" ? Number(left) * Number(right) : Number(left) / Number(right);
    }
  }

  private unary(): unknown {
    if (this.matchOp("-")) return -Number(this.unary());
    return this.primary();
  }

  private primary(): unknown {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new Error(`Unexpected end of expression: ${this.source}`);
    switch (tok.t) {
      case "num":
        return tok.v;
      case "str":
        return tok.v;
      case "id": {
        const next = this.peek();
        if (next?.t === "punc" && next.v === "(" && !tok.v.includes(".")) {
          const fn = FUNCTIONS[tok.v];
          if (!fn) throw new Error(`Unknown function "${tok.v}" in expression: ${this.source}`);
          this.pos++;
          const args: unknown[] = [];
          if (this.peek()?.t === "punc" && (this.peek() as { v: string }).v === ")") {
            this.pos++;
            return fn();
          }
          for (;;) {
            args.push(this.or());
            const sep = this.tokens[this.pos++];
            if (sep?.t === "punc" && sep.v === ")") break;
            if (!(sep?.t === "punc" && sep.v === ",")) throw new Error(`Expected , or ) in ${this.source}`);
          }
          return fn(...args);
        }
        const lower = tok.v.toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
        if (lower === "null" || lower === "undefined") return null;
        return getPath(this.context, tok.v);
      }
      case "punc": {
        if (tok.v === "(") {
          const value = this.or();
          this.expectPunc(")");
          return value;
        }
        if (tok.v === "[") {
          const items: unknown[] = [];
          if (this.peek()?.t === "punc" && (this.peek() as { v: string }).v === "]") {
            this.pos++;
            return items;
          }
          for (;;) {
            items.push(this.or());
            const next = this.tokens[this.pos++];
            if (next?.t === "punc" && next.v === "]") break;
            if (!(next?.t === "punc" && next.v === ",")) throw new Error(`Expected , or ] in ${this.source}`);
          }
          return items;
        }
        throw new Error(`Unexpected "${tok.v}" in expression: ${this.source}`);
      }
      default:
        throw new Error(`Unexpected operator "${tok.v}" in expression: ${this.source}`);
    }
  }

  private expectPunc(v: string): void {
    const tok = this.tokens[this.pos++];
    if (!tok || tok.t !== "punc" || tok.v !== v) throw new Error(`Expected "${v}" in expression: ${this.source}`);
  }
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * How two values compare for < and >: as numbers when both are numbers (or numeric texts), else texts in
 * order (so ISO dates compare as dates); NaN when either is missing, so every comparison with it is false.
 */
function ordered(a: unknown, b: unknown): number {
  if (a === undefined || a === null || b === undefined || b === null) return Number.NaN;
  const na = typeof a === "number" ? a : toNumber(a);
  const nb = typeof b === "number" ? b : toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return Number(a) - Number(b);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}

function contains(container: unknown, item: unknown): boolean {
  if (Array.isArray(container)) return container.some((x) => looseEquals(x, item));
  if (typeof container === "string") return container.toLowerCase().includes(stringify(item).toLowerCase());
  if (isRecord(container)) return typeof item === "string" && item in container;
  return false;
}

export function evaluateExpression(expression: string, context: unknown): unknown {
  const tokens = tokenize(expression);
  if (tokens.length === 0) return undefined;
  return new Parser(tokens, context, expression).parse();
}

/** A `when` condition: an expression (with filters and functions), bare or inside `{{ }}`. */
export function evaluateCondition(expression: string | undefined, context: unknown): boolean {
  if (!expression || !expression.trim()) return true;
  const inner = expression.match(SINGLE_EXPR)?.[1] ?? expression;
  return truthy(evaluateTemplateExpression(inner, context));
}
