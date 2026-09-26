import { CALCULATION_CONTRACT, CalculationOutput, tableKeyOf, type JsonSchema, type ResultColumn, type TableField } from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";

/**
 * The Studio's calculation writer: from a rule in plain words ("rank suppliers by complaints per 100
 * deliveries") to the code that computes it, tried on the real rows before anyone sees the result.
 * With the model it understands any rule and fixes its code from what went wrong; without it, rules of
 * the usual shapes are read from the words (how many, the total or average of something, by something,
 * per so many of another table, in a period).
 */

export interface CalculationTable {
  key: string;
  name: string;
  fields: Pick<TableField, "key" | "label" | "type" | "choices" | "currency">[];
}

export interface CalculationDraft {
  name: string;
  explanation: string;
  tables: string[];
  code: string;
  output: CalculationOutput;
}

/** What trying the code on the real rows gave. */
export interface TrialOutcome {
  ok: boolean;
  result: unknown;
  error: string | null;
}

export interface CalculationProposal {
  draft: CalculationDraft;
  /** The last try on the real rows. */
  trial: TrialOutcome;
  /** How many times the code was written. */
  attempts: number;
  drafted: "model" | "words";
  notes: string[];
}

export async function writeCalculation(
  llm: LlmClient,
  input: {
    rule: string;
    tables: CalculationTable[];
    /** A few rows of each table, so the code fits the data. */
    samples?: Record<string, Record<string, unknown>[]>;
    /** Runs code on the real rows (nothing is kept). */
    trial: (draft: CalculationDraft) => Promise<TrialOutcome>;
  },
): Promise<CalculationProposal> {
  const rule = input.rule.trim();
  if (!rule) throw new Error("Say the rule to calculate");
  if (llm.available) {
    const written = await modelCalculation(llm, rule, input).catch(() => undefined);
    if (written) return written;
  }
  const draft = wordsCalculation(rule, input.tables);
  if (!draft) {
    throw new Error(
      "This rule needs the model to write it: say it as how many, the total or the average of something, by something (per 100 of something else, in a period)",
    );
  }
  return { draft: draft.draft, trial: await input.trial(draft.draft), attempts: 1, drafted: "words", notes: draft.notes };
}

// ---------------------------------------------------------------------------
// With the model
// ---------------------------------------------------------------------------

const SYSTEM = `You write calculations for business people. They say the rule in plain words; you write the JavaScript that computes it on their tables, and explain it in plain words (they never see the code).

${CALCULATION_CONTRACT}

Write simple, readable code. Treat missing values as missing (not zero) unless the rule says otherwise. Sort a ranking best first and add a "rank" column. Name columns with keys (snake_case) and give each a label people understand. The explanation says, in one or two sentences, what is counted, over which period, and in which order, so a person can check the rule was understood.`;

async function modelCalculation(
  llm: LlmClient,
  rule: string,
  input: { tables: CalculationTable[]; samples?: Record<string, Record<string, unknown>[]>; trial: (draft: CalculationDraft) => Promise<TrialOutcome> },
): Promise<CalculationProposal | undefined> {
  const column: JsonSchema = {
    type: "object",
    properties: {
      key: { type: "string" },
      label: { type: "string" },
      type: { type: "string", enum: ["text", "number", "money", "percent", "date", "rank"] },
      currency: { type: "string", description: "For money: ISO code; else empty" },
    },
    required: ["key", "label", "type", "currency"],
    additionalProperties: false,
  };
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string", description: "Short, e.g. Supplier ranking" },
      explanation: { type: "string" },
      tables: { type: "array", items: { type: "string" }, description: "Keys of the tables the code reads" },
      code: { type: "string", description: "The body of function calculate(tables, params)" },
      kind: { type: "string", enum: ["rows", "number", "text"] },
      columns: { type: "array", items: column },
      unit: { type: "string", description: "For a number: what it counts; else empty" },
    },
    required: ["name", "explanation", "tables", "code", "kind", "columns", "unit"],
    additionalProperties: false,
  };
  const known = new Set(input.tables.map((t) => t.key));
  const context = [
    `The rule: ${rule}`,
    `The company's tables:\n${input.tables
      .map((t) => {
        const sample = input.samples?.[t.key]?.slice(0, 3);
        return `- ${t.key} (${t.name}): ${t.fields.map((f) => `${f.key} [${f.label}, ${f.type}${f.choices?.length ? `: ${f.choices.join("/")}` : ""}]`).join("; ")}${sample?.length ? `\n  e.g. ${JSON.stringify(sample)}` : ""}`;
      })
      .join("\n")}`,
  ].join("\n\n");
  const notes: string[] = [];
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data } = await llm.structured<{
      name: string;
      explanation: string;
      tables: string[];
      code: string;
      kind: "rows" | "number" | "text";
      columns: (Omit<ResultColumn, "currency"> & { currency: string })[];
      unit: string;
    }>({
      purpose: "studio.calculation",
      system: SYSTEM,
      effort: "medium",
      schema,
      messages: [{ role: "user", content: feedback ? `${context}\n\n${feedback}` : context }],
    });
    if (!data?.code?.trim()) return undefined;
    const draft: CalculationDraft = {
      name: data.name.trim() || "Calculation",
      explanation: data.explanation.trim(),
      tables: [...new Set(data.tables.filter((key) => known.has(key)))],
      code: data.code,
      output: CalculationOutput.parse({
        kind: data.kind,
        columns: data.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, ...(/^[A-Z]{3}$/.test(c.currency) ? { currency: c.currency } : {}) })),
        ...(data.unit.trim() ? { unit: data.unit.trim() } : {}),
      }),
    };
    const trial = await input.trial(draft);
    if (trial.ok) return { draft, trial, attempts: attempt, drafted: "model", notes };
    // Tried on the real rows and it didn't work: the model sees what went wrong and writes it again.
    notes.push(`Try ${attempt} didn't work (${trial.error}); written again.`);
    feedback = `The code you wrote failed on the real rows: ${trial.error}\nThe code was:\n${draft.code}\nWrite it again so that it works.`;
    if (attempt === 3) return { draft, trial, attempts: attempt, drafted: "model", notes };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// From the words alone
// ---------------------------------------------------------------------------

const PERIODS: [RegExp, string, string][] = [
  [/\blast month\b|\bgeçen ay\b/i, "lastMonth", "last month"],
  [/\bthis month\b|\bbu ay\b/i, "thisMonth", "this month"],
  [/\bthis week\b|\bbu hafta\b/i, "thisWeek", "this week"],
  [/\bthis year\b|\bbu yıl\b/i, "thisYear", "this year"],
];

/** "suppliers" → "supplier", "deliveries" → "delivery". */
function singular(word: string): string {
  const w = word.toLowerCase();
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The table a word names: "complaints" → Supplier complaints, "deliveries" → Deliveries. */
function tableNamed(word: string, tables: CalculationTable[], except?: string): CalculationTable | undefined {
  const w = singular(word);
  const candidates = tables.filter((t) => t.key !== except);
  return (
    candidates.find((t) => singular(t.name) === w || t.key === tableKeyOf(word)) ??
    candidates.find((t) => t.name.toLowerCase().split(/\s+/).map(singular).includes(w))
  );
}

/** The field a word names in a table: "supplier" → Supplier; "cost" → Cost. */
function fieldNamed(word: string, table: CalculationTable): CalculationTable["fields"][number] | undefined {
  const w = singular(word.trim());
  return (
    table.fields.find((f) => singular(f.label) === w || f.key === tableKeyOf(word)) ??
    table.fields.find((f) => f.label.toLowerCase().split(/\s+/).map(singular).includes(w))
  );
}

const js = (value: string) => JSON.stringify(value);

function wordsCalculation(rule: string, tables: CalculationTable[]): { draft: CalculationDraft; notes: string[] } | undefined {
  const text = rule.replace(/\s+/g, " ").trim();
  const notes: string[] = [];
  const period = PERIODS.find(([pattern]) => pattern.test(text));
  const plain = period ? text.replace(period[0], "").replace(/\s+/g, " ").trim() : text;
  // "rank suppliers by complaints per 100 deliveries", "count complaints by status", "total refund by customer"
  const rank =
    /^(?:rank|order|sort|list)\s+(?:the\s+)?(\S+(?:\s\S+)?)\s+by\s+(?:(?:the\s+)?(?:number|count) of\s+)?(\S+(?:\s\S+)?)(?:\s+per\s+(\d+)\s+(\S+))?$/i.exec(
      plain,
    );
  const aggregate =
    /^(?:(count|number of|how many|total|sum of|sum|average|mean)\s+(?:the\s+)?)(\S+(?:\s\S+)?)(?:\s+(?:by|per)\s+(?:the\s+)?(\S+(?:\s\S+)?))?$/i.exec(plain);
  let measureTable: CalculationTable | undefined;
  let group: string | undefined;
  let of: "count" | "sum" | "average" = "count";
  let measureField: CalculationTable["fields"][number] | undefined;
  let per: { n: number; table: CalculationTable } | undefined;
  if (rank) {
    group = rank[1]!;
    measureTable = tableNamed(rank[2]!, tables);
    if (!measureTable) {
      // "rank suppliers by cost": a number field of the table that has the group.
      const withGroup = tables.find((t) => fieldNamed(group!, t));
      measureField = withGroup ? fieldNamed(rank[2]!, withGroup) : undefined;
      if (withGroup && measureField && (measureField.type === "number" || measureField.type === "money")) {
        measureTable = withGroup;
        of = "sum";
      }
    }
    if (rank[3] && rank[4]) {
      const base = tableNamed(rank[4], tables, measureTable?.key);
      if (base) per = { n: Number(rank[3]), table: base };
    }
  } else if (aggregate) {
    const verb = aggregate[1]!.toLowerCase();
    of = /total|sum/.test(verb) ? "sum" : /average|mean/.test(verb) ? "average" : "count";
    group = aggregate[3];
    if (of === "count") measureTable = tableNamed(aggregate[2]!, tables);
    else {
      measureTable = tables.find((t) => fieldNamed(aggregate[2]!, t) && (!group || fieldNamed(group, t)));
      measureField = measureTable ? fieldNamed(aggregate[2]!, measureTable) : undefined;
      if (measureField && measureField.type !== "number" && measureField.type !== "money") return undefined;
    }
  }
  if (!measureTable || (of !== "count" && !measureField)) return undefined;
  const groupField = group ? fieldNamed(group, measureTable) : undefined;
  if (group && !groupField) return undefined;
  const baseGroup = per && groupField ? fieldNamed(groupField.label, per.table) : undefined;
  if (per && !baseGroup) {
    notes.push(`${per.table.name} has no ${groupField?.label ?? group}, so it isn't counted per ${per.n}.`);
    per = undefined;
  }

  // The period: the first date field of each table (else when the record was added).
  const dateOf = (table: CalculationTable) => table.fields.find((f) => f.type === "date")?.key ?? "created_at";
  const lines: string[] = [];
  if (period) {
    lines.push(
      `const period = params.${period[1]};`,
      `const inPeriod = (row, field) => { const day = String(row[field] ?? "").slice(0, 10); return day >= period.from && day <= period.to; };`,
    );
  }
  const keep = (table: CalculationTable) => (period ? `if (!inPeriod(row, ${js(dateOf(table))})) continue; ` : "");
  const valueKey = of === "count" ? singularKey(measureTable.name, "count") : measureField!.key;
  const measureLabel = of === "count" ? capitalized(measureTable.name) : `${of === "sum" ? "Total" : "Average"} ${measureField!.label.toLowerCase()}`;
  const round = (expr: string) => `Math.round((${expr}) * 100) / 100`;
  let output: CalculationOutput;
  if (!groupField) {
    lines.push(
      `let count = 0, total = 0;`,
      `for (const row of tables[${js(measureTable.key)}]) { ${keep(measureTable)}${of === "count" ? "count++;" : `const v = row[${js(measureField!.key)}]; if (typeof v !== "number") continue; count++; total += v;`} }`,
      `return ${of === "count" ? "count" : of === "sum" ? round("total") : `count ? ${round("total / count")} : 0`};`,
    );
    output = CalculationOutput.parse({ kind: "number", unit: of === "count" ? measureTable.name.toLowerCase() : (measureField!.currency ?? "") });
  } else {
    const g = groupField.key;
    lines.push(`const groups = {};`, `const add = (key) => (groups[key] ??= { count: 0, total: 0, base: 0 });`);
    lines.push(
      `for (const row of tables[${js(measureTable.key)}]) { ${keep(measureTable)}const group = add(row[${js(g)}] ?? "Not given"); ${of === "count" ? "group.count++;" : `const v = row[${js(measureField!.key)}]; if (typeof v !== "number") continue; group.count++; group.total += v;`} }`,
    );
    if (per && baseGroup)
      lines.push(`for (const row of tables[${js(per.table.key)}]) { ${keep(per.table)}add(row[${js(baseGroup.key)}] ?? "Not given").base++; }`);
    const value = of === "count" ? "group.count" : of === "sum" ? round("group.total") : `group.count ? ${round("group.total / group.count")} : null`;
    const ratioKey = per ? `per_${per.n}` : undefined;
    const baseKey = per ? singularKey(per.table.name, "count") : undefined;
    lines.push(
      `const rows = Object.entries(groups).map(([key, group]) => ({ ${js(g)}: key, ${js(valueKey)}: ${value}${
        per ? `, ${js(baseKey!)}: group.base, ${js(ratioKey!)}: group.base ? ${round(`${value} / group.base * ${per.n}`)} : null` : ""
      } }));`,
      `rows.sort((a, b) => (b[${js(ratioKey ?? valueKey)}] ?? -Infinity) - (a[${js(ratioKey ?? valueKey)}] ?? -Infinity));`,
      `return rows.map((row, i) => ({ rank: i + 1, ...row }));`,
    );
    const money =
      measureField?.type === "money"
        ? { type: "money" as const, ...(measureField.currency ? { currency: measureField.currency } : {}) }
        : { type: "number" as const };
    output = CalculationOutput.parse({
      kind: "rows",
      columns: [
        { key: "rank", label: "Rank", type: "rank" },
        { key: g, label: groupField.label, type: "text" },
        { key: valueKey, label: measureLabel, ...(of === "count" ? { type: "number" } : money) },
        ...(per
          ? [
              { key: baseKey!, label: capitalized(per.table.name), type: "number" },
              { key: ratioKey!, label: `${measureLabel} per ${per.n} ${per.table.name.toLowerCase()}`, type: "number" },
            ]
          : []),
      ],
    });
  }
  const what =
    of === "count"
      ? `how many ${measureTable.name.toLowerCase()}`
      : `the ${of === "sum" ? "total" : "average"} ${measureField!.label.toLowerCase()} of ${measureTable.name.toLowerCase()}`;
  const explanation = [
    groupField ? `For each ${groupField.label.toLowerCase()}: ${what}` : `${capitalized(what)}`,
    per ? `, for every ${per.n} ${per.table.name.toLowerCase()}` : "",
    period
      ? `, ${period[2]} (by ${dateOf(measureTable) === "created_at" ? "when it was added" : measureTable.fields.find((f) => f.key === dateOf(measureTable))!.label.toLowerCase()})`
      : "",
    groupField ? `; highest first.` : ".",
  ].join("");
  const name = groupField ? `${capitalized(singular(groupField.label))} ranking` : capitalized(what);
  return {
    draft: { name, explanation, tables: [...new Set([measureTable.key, ...(per ? [per.table.key] : [])])], code: lines.join("\n"), output },
    notes,
  };
}

function capitalized(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** A column key for counting a table's rows: "Supplier complaints" → "complaints". */
function singularKey(name: string, fallback: string): string {
  const last = name.toLowerCase().split(/\s+/).pop() ?? fallback;
  return tableKeyOf(last) || fallback;
}
