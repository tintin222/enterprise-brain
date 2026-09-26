import { z } from "zod";

/**
 * Apps: screens people describe in plain words ("log a complaint, see the open ones by supplier,
 * close them"). An app is a description the platform draws from its own parts (lists, forms, boards,
 * charts, numbers, buttons that give an AI employee work), on the company's tables; nothing is
 * generated as code or deployed, so sign-in, permissions and the phone layout come with it.
 */

const KEY = /^[a-z][a-z0-9_]*$/;
const Key = z.string().regex(KEY, "Use lower-case letters, digits and _").max(48);

/** Field values records must have to be shown ({ status: "Open" }). */
export const BlockFilter = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type BlockFilter = z.infer<typeof BlockFilter>;

/**
 * A quick change from a list or a board: it sets fields ("Close" sets Status to Closed), or gives the
 * record to an AI employee as work ("Draft a reply", with {field} from the record).
 */
export const RecordAction = z
  .object({
    label: z.string().min(1).max(40),
    set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    agent: z.string().min(1).optional(),
    ask: z.string().max(2000).optional(),
    /** Ask "Are you sure?" first. */
    confirm: z.boolean().optional(),
  })
  .superRefine((action, ctx) => {
    if (Boolean(action.set && Object.keys(action.set).length) === Boolean(action.agent)) {
      ctx.addIssue({ code: "custom", message: `${action.label}: an action either sets fields or gives the record to an AI employee` });
    }
  });
export type RecordAction = z.infer<typeof RecordAction>;

/** What a chart or a number counts: the records, or the sum or average of a number field. */
export const Measure = z.object({
  of: z.enum(["count", "sum", "average"]).default("count"),
  field: z.string().optional(),
});
export type Measure = z.infer<typeof Measure>;

const Common = { title: z.string().max(80).optional() };

export const ListBlock = z.object({
  type: z.literal("list"),
  ...Common,
  table: Key,
  /** The fields shown (default: the first ones). */
  fields: z.array(z.string()).max(12).optional(),
  filter: BlockFilter.optional(),
  sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).default("asc") }).optional(),
  /** Records in groups by a field (a supplier, a status). */
  groupBy: z.string().optional(),
  /** A box to find records by words. */
  search: z.boolean().optional(),
  actions: z.array(RecordAction).max(6).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const FormBlock = z.object({
  type: z.literal("form"),
  ...Common,
  table: Key,
  /** The fields asked (default: all); required fields are always asked. */
  fields: z.array(z.string()).max(40).optional(),
  /** Values every record from this form gets ({ source: "Phone" }). */
  values: BlockFilter.optional(),
  submitLabel: z.string().max(40).optional(),
});

export const BoardBlock = z.object({
  type: z.literal("board"),
  ...Common,
  table: Key,
  /** A choice field: its values are the columns, and moving a card changes it. */
  groupBy: z.string(),
  /** The fields shown on each card. */
  fields: z.array(z.string()).max(6).optional(),
  filter: BlockFilter.optional(),
  actions: z.array(RecordAction).max(6).optional(),
});

export const ChartBlock = z.object({
  type: z.literal("chart"),
  ...Common,
  table: Key,
  /** What the bars are: a choice, a person, a linked record, yes or no, or a date by month. */
  groupBy: z.string(),
  measure: Measure.default({ of: "count" }),
  kind: z.enum(["bar", "pie"]).default("bar"),
  filter: BlockFilter.optional(),
  /** Only the largest this many (the rest are "Other"). */
  limit: z.number().int().min(2).max(50).optional(),
});

export const NumberBlock = z.object({
  type: z.literal("number"),
  title: z.string().min(1).max(80),
  table: Key,
  measure: Measure.default({ of: "count" }),
  filter: BlockFilter.optional(),
});

export const ButtonBlock = z.object({
  type: z.literal("button"),
  /** The button's words ("Ask for this month's supplier ranking"). */
  title: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  /** The AI employee given the work (its slug). */
  agent: z.string().min(1),
  /** The work, as it is given to the AI employee. */
  ask: z.string().min(1).max(2000),
});

/** The latest result of a calculation (a ranking, a figure), with when it ran. */
export const ResultBlock = z.object({
  type: z.literal("result"),
  ...Common,
  /** The calculation's key. */
  calculation: Key,
});

export const TextBlock = z.object({
  type: z.literal("text"),
  ...Common,
  text: z.string().min(1).max(4000),
});

export const AppBlock = z.discriminatedUnion("type", [ListBlock, FormBlock, BoardBlock, ChartBlock, NumberBlock, ButtonBlock, ResultBlock, TextBlock]);
export type AppBlock = z.infer<typeof AppBlock>;
export type AppBlockType = AppBlock["type"];

export const AppPage = z.object({
  key: Key,
  title: z.string().min(1).max(60),
  blocks: z.array(AppBlock).min(1).max(12),
});
export type AppPage = z.infer<typeof AppPage>;

export const AppSettings = z.object({
  /** department (default): its people use it; company: everyone does. */
  visibility: z.enum(["department", "company"]).default("department"),
});
export type AppSettings = z.infer<typeof AppSettings>;

/** An app's design: what the Studio proposes, and what people change. */
export const AppDesign = z
  .object({
    key: Key,
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    /** A lucide icon name (clipboard-list, truck…). */
    icon: z.string().max(40).optional(),
    pages: z.array(AppPage).min(1).max(8),
  })
  .superRefine((design, ctx) => {
    const keys = new Set<string>();
    for (const page of design.pages) {
      if (keys.has(page.key)) ctx.addIssue({ code: "custom", message: `Two pages are called ${page.key}` });
      keys.add(page.key);
    }
  });
export type AppDesign = z.infer<typeof AppDesign>;
export type AppDesignInput = z.input<typeof AppDesign>;

/** The tables an app's blocks show. */
export function tablesOfApp(design: Pick<AppDesign, "pages">): string[] {
  return [...new Set(design.pages.flatMap((p) => p.blocks.flatMap((b) => ("table" in b ? [b.table] : []))))];
}

/** The calculations an app shows the results of (their keys). */
export function calculationsOfApp(design: Pick<AppDesign, "pages">): string[] {
  return [...new Set(design.pages.flatMap((p) => p.blocks.flatMap((b) => (b.type === "result" ? [b.calculation] : []))))];
}

/** The AI employees an app's buttons and actions give work to (their slugs). */
export function agentsOfApp(design: Pick<AppDesign, "pages">): string[] {
  const slugs = design.pages.flatMap((p) =>
    p.blocks.flatMap((b) => [
      ...(b.type === "button" ? [b.agent] : []),
      ...("actions" in b ? (b.actions ?? []).flatMap((a) => (a.agent ? [a.agent] : [])) : []),
    ]),
  );
  return [...new Set(slugs)];
}

/** "Status is Open, Supplier is Akın Metal" */
function filterWords(filter: BlockFilter | undefined, label: (table: string, key: string) => string, table: string): string {
  const parts = Object.entries(filter ?? {}).map(([key, value]) => `${label(table, key)} is ${String(value)}`);
  return parts.length ? ` whose ${parts.join(" and ")}` : "";
}

/**
 * A block in plain words, for the person who asked for the app: "A list of Supplier complaints whose
 * Status is Open, in groups by Supplier, to Close".
 */
export function describeBlock(
  block: AppBlock,
  names: { table(key: string): string; field(table: string, key: string): string; agent(slug: string): string; calculation?(key: string): string },
): string {
  const fields = (table: string, keys: string[] | undefined) => (keys?.length ? keys.map((k) => names.field(table, k)).join(", ") : "");
  const measure = (table: string, m: Measure) =>
    m.of === "count" ? "how many" : `the ${m.of === "sum" ? "total" : "average"} ${names.field(table, m.field ?? "")}`;
  const actions = (list: RecordAction[] | undefined) => (list?.length ? `, to ${list.map((a) => a.label).join(" or ")}` : "");
  switch (block.type) {
    case "list": {
      const shown = fields(block.table, block.fields);
      return (
        `A list of ${names.table(block.table)}${filterWords(block.filter, names.field, block.table)}` +
        `${block.groupBy ? `, in groups by ${names.field(block.table, block.groupBy)}` : ""}` +
        `${block.sort ? `, by ${names.field(block.table, block.sort.field)}` : ""}` +
        `${shown ? `, showing ${shown}` : ""}${block.search ? ", with a search box" : ""}${actions(block.actions)}`
      );
    }
    case "form": {
      const asked = fields(block.table, block.fields);
      return `A form that adds to ${names.table(block.table)}${asked ? `, asking ${asked}` : ""}`;
    }
    case "board":
      return `A board of ${names.table(block.table)}${filterWords(block.filter, names.field, block.table)} in columns by ${names.field(block.table, block.groupBy)}: moving a card changes it${actions(block.actions)}`;
    case "chart":
      return `A ${block.kind === "pie" ? "pie" : "bar"} chart of ${measure(block.table, block.measure)} ${names.table(block.table)}${filterWords(block.filter, names.field, block.table)} by ${names.field(block.table, block.groupBy)}`;
    case "number":
      return `${block.title}: ${measure(block.table, block.measure)} ${names.table(block.table)}${filterWords(block.filter, names.field, block.table)}`;
    case "button":
      return `A button, "${block.title}", that asks ${names.agent(block.agent)}: ${block.ask}`;
    case "result":
      return `The latest result of ${names.calculation?.(block.calculation) ?? block.calculation}`;
    case "text":
      return "Text";
  }
}
