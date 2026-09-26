import { getPath, isRecord } from "./util.ts";

/**
 * Safe template + expression engine used by workflows.
 *
 *   "{{ steps.evaluate.score }}"            -> raw value (number)
 *   "Hello {{ input.name | default:'there' }}" -> interpolated string
 *   evaluateExpression("steps.evaluate.score >= 70 && input.role != 'intern'", ctx)
 *
 * No `eval`, no property access beyond plain data paths.
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
};

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
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
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

export function evaluateCondition(expression: string | undefined, context: unknown): boolean {
  if (!expression || !expression.trim()) return true;
  const inner = expression.match(SINGLE_EXPR)?.[1] ?? expression;
  return truthy(evaluateExpression(inner, context));
}
