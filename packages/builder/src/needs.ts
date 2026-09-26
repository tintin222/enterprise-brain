import { NEED_KINDS, NEED_LABELS, RepeatSchedule, type JsonSchema, type NeedKind } from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";

/**
 * The one box: "What do you need?" A request in plain words becomes one of the things the platform
 * does: an AI employee does it now or regularly, the company's knowledge answers it, it is worked out
 * on the tables, or a table, an app, an AI employee or a change is made. With Claude the model reads
 * the request; offline, the usual sentences are read from the words. Nothing is done here: the
 * person sees what was understood, and says go.
 */

export interface NeedAgent {
  slug: string;
  name: string;
  summary?: string;
  duties?: string[];
}

/** What the company has, as the person sees it: who can do the work, and what can be changed. */
export interface NeedMaterials {
  agents: NeedAgent[];
  tables: { key: string; name: string; fields?: { key: string; label: string }[] }[];
  apps: { key: string; name: string }[];
  calculations: { key: string; name: string; rule?: string }[];
}

export interface NeedTarget {
  type: "table" | "app" | "calculation" | "agent";
  key: string;
  name: string;
}

export interface UnderstoodNeed {
  kind: NeedKind;
  /** task, recurring: the AI employee whose job fits (its slug); none when no one's does. */
  agent?: string;
  /** task, recurring: the work in the person's words, without when it repeats. */
  work?: string;
  /** recurring, and a calculation worked out regularly: when. */
  schedule?: RepeatSchedule;
  /** table, app, ai-employee: what to make; calculation: the rule; answer: the question. */
  description?: string;
  /** change: what changes, and the change in plain words. */
  target?: NeedTarget;
  change?: string;
  /** unclear: one question back. */
  question?: string;
  /** Other readings the person can choose instead. */
  alternatives: NeedKind[];
  notes: string[];
  drafted: "model" | "words";
}

export async function understandNeed(llm: LlmClient, input: { text: string; as?: NeedKind; materials: NeedMaterials }): Promise<UnderstoodNeed> {
  const text = input.text.trim().replace(/\s+/g, " ");
  if (text.length < 3) throw new Error("Say what you need");
  if (llm.available) {
    const read = await modelNeed(llm, text, input.materials, input.as).catch(() => undefined);
    if (read) return read;
  }
  return wordsNeed(text, input.materials, input.as);
}

/** The readings worth offering instead of one, given what the company has. */
function otherReadings(kind: NeedKind, materials: NeedMaterials, target?: NeedTarget): NeedKind[] {
  const others: Record<NeedKind, NeedKind[]> = {
    task: ["recurring", "answer", "ai-employee"],
    recurring: ["task", "ai-employee"],
    answer: ["task", "calculation"],
    calculation: ["answer", "task"],
    table: ["app"],
    app: ["table"],
    "ai-employee": ["task", "recurring"],
    change: ["task"],
    unclear: ["task", "answer", "table", "app", "ai-employee"],
  };
  return others[kind].filter(
    (k) =>
      ((k !== "task" && k !== "recurring") || materials.agents.length > 0) &&
      (k !== "calculation" || materials.tables.length > 0) &&
      (k !== "change" || target),
  );
}

// ---------------------------------------------------------------------------
// With the model
// ---------------------------------------------------------------------------

const SYSTEM = `You are the front door of Enterprise Brain, where business people ask for what they need in plain words. Read the request and say what it is:
- task: an AI employee the company has does it now, once. Give the slug of the one whose job fits; empty when none fits.
- recurring: an AI employee the company has does it regularly ("every Monday, send me the open complaints"). Give who, the work without the when, and when.
- answer: a question the company's knowledge answers (policies, procedures, how to), or a text to draft once.
- calculation: a number, a count, a total, an average or a ranking worked out on the company's tables ("how many complaints last month", "rank suppliers by complaints"). With a schedule when it should be worked out regularly.
- table: somewhere to keep track of records, with its fields.
- app: screens to work with records (a register, a tracker, a form, a board, a dashboard). An app comes with its table.
- ai-employee: a new AI employee that works on its own (reads a mailbox, acts on each new email, order or file, or does a whole job) when none the company has does it.
- change: a change to a table, an app, a calculation or an AI employee the company has. Give its type and key.
- unclear: when you can't tell. Ask one short question back.
Prefer an AI employee the company has when its job fits. Keep the person's own words for the work, the description and the change. Use only the slugs and keys listed. Times are 24-hour HH:MM; leave the time empty when none is said.`;

async function modelNeed(llm: LlmClient, text: string, materials: NeedMaterials, as?: NeedKind): Promise<UnderstoodNeed | undefined> {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...NEED_KINDS] },
      agent: { type: "string", description: "task, recurring: the slug of the AI employee who does it; empty when none fits" },
      work: { type: "string", description: "task, recurring: the work in the person's words, without when it repeats" },
      description: { type: "string", description: "table, app, ai-employee: what to make, as said; calculation: the rule; answer: the question" },
      every: { type: "string", enum: ["", "day", "weekday", "week", "month"], description: "recurring, calculation: how often; empty when not regular" },
      weekday: { type: "integer", description: "every week: 0 = Sunday … 6 = Saturday; -1 when not said" },
      day: { type: "integer", description: "every month: the day of the month (1-28); 0 when not said" },
      time: { type: "string", description: "HH:MM when a time is said; else empty" },
      targetType: { type: "string", enum: ["", "table", "app", "calculation", "agent"] },
      target: { type: "string", description: "change: the key (or slug) of what changes" },
      change: { type: "string", description: "change: the change in plain words" },
      question: { type: "string", description: "unclear: one short question back" },
      alternatives: { type: "array", items: { type: "string", enum: [...NEED_KINDS] }, description: "Other readings that could be meant" },
    },
    required: ["kind", "agent", "work", "description", "every", "weekday", "day", "time", "targetType", "target", "change", "question", "alternatives"],
    additionalProperties: false,
  };
  const lines = [
    `AI employees:\n${materials.agents.map((a) => `- ${a.slug} (${a.name})${a.summary ? `: ${a.summary}` : ""}${a.duties?.length ? ` Duties: ${a.duties.join("; ")}` : ""}`).join("\n") || "(none yet)"}`,
    `Tables:\n${materials.tables.map((t) => `- ${t.key} (${t.name})${t.fields?.length ? `: ${t.fields.map((f) => f.label).join(", ")}` : ""}`).join("\n") || "(none yet)"}`,
    `Apps:\n${materials.apps.map((a) => `- ${a.key} (${a.name})`).join("\n") || "(none yet)"}`,
    `Calculations:\n${materials.calculations.map((c) => `- ${c.key} (${c.name})${c.rule ? `: ${c.rule}` : ""}`).join("\n") || "(none yet)"}`,
    as ? `The person says it is: ${NEED_LABELS[as]} (kind "${as}"). Read it as that.` : "",
    `The request: ${text}`,
  ].filter(Boolean);
  const { data } = await llm.structured<{
    kind: NeedKind;
    agent: string;
    work: string;
    description: string;
    every: "" | RepeatSchedule["every"];
    weekday: number;
    day: number;
    time: string;
    targetType: "" | NeedTarget["type"];
    target: string;
    change: string;
    question: string;
    alternatives: NeedKind[];
  }>({ purpose: "studio.need", system: SYSTEM, effort: "low", schema, messages: [{ role: "user", content: lines.join("\n\n") }] });
  if (!data || !NEED_KINDS.includes(data.kind)) return undefined;
  let kind: NeedKind = as ?? data.kind;
  const agent = materials.agents.find((a) => a.slug === data.agent.trim())?.slug;
  const schedule = data.every
    ? RepeatSchedule.parse({
        every: data.every,
        ...(data.every === "week" && data.weekday >= 0 && data.weekday <= 6 ? { weekday: data.weekday } : {}),
        ...(data.every === "month" && data.day >= 1 ? { day: Math.min(28, data.day) } : {}),
        ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time.trim()) ? { time: data.time.trim() } : {}),
      })
    : undefined;
  const target = data.targetType ? targetFrom(materials, data.targetType, data.target.trim()) : undefined;
  const notes: string[] = [];
  if (kind === "change" && !target) kind = "unclear";
  if (kind === "recurring" && !schedule) notes.push("When wasn't said: choose it below.");
  const need: UnderstoodNeed = {
    kind,
    alternatives: [],
    notes,
    drafted: "model",
    ...(agent && (kind === "task" || kind === "recurring") ? { agent } : {}),
    ...(kind === "task" || kind === "recurring" ? { work: data.work.trim() || text } : {}),
    ...(schedule && (kind === "recurring" || kind === "calculation") ? { schedule } : {}),
    ...(["table", "app", "ai-employee", "calculation", "answer"].includes(kind) ? { description: data.description.trim() || text } : {}),
    ...(kind === "change" && target ? { target, change: data.change.trim() || text } : {}),
    ...(kind === "unclear"
      ? { question: data.question.trim() || "What should happen: should an AI employee do it, or do you want to keep track of something?" }
      : {}),
  };
  const offered = otherReadings(kind, materials, target);
  need.alternatives = [...new Set([...data.alternatives.filter((k) => k !== kind && offered.includes(k)), ...offered])].slice(0, 4);
  return need;
}

function targetFrom(materials: NeedMaterials, type: NeedTarget["type"], key: string): NeedTarget | undefined {
  const found =
    type === "table"
      ? materials.tables.find((t) => t.key === key)
      : type === "app"
        ? materials.apps.find((a) => a.key === key)
        : type === "calculation"
          ? materials.calculations.find((c) => c.key === key)
          : materials.agents.map((a) => ({ key: a.slug, name: a.name })).find((a) => a.key === key);
  return found ? { type, key: found.key, name: found.name } : undefined;
}

// ---------------------------------------------------------------------------
// From the words alone
// ---------------------------------------------------------------------------

/** Not inside a word, and not followed by one (Turkish letters included). */
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const words = (pattern: string, flags = "iu") => new RegExp(`${B}(?:${pattern})${E}`, flags);

const POLITE =
  /^(?:(?:hi|hello|merhaba)[,!]?\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?|(?:i|we) (?:need|want|would like)(?: to)?\s+|i'd like(?: to)?\s+|please\s+|lütfen\s+)+/iu;
const ASKING = /^(?:(?:hi|hello|merhaba)[,!]?\s+)?(?:(?:can|could|would|will) you|please|lütfen)\b/iu;
const QUESTION = new RegExp(
  `^${B}(?:what|what's|whats|how|who|whom|whose|when|where|which|why|is|are|am|was|were|do|does|did|can|could|should|would|will|may|ne|neden|niye|nasıl|kim|kime|hangi|kaç|nerede|nereye)${E}`,
  "iu",
);
const CALC = new RegExp(`^${B}(?:rank|count|number of|total|sum|average|mean|sırala|toplam|ortalama)${E}`, "iu");
const HOW_MANY = new RegExp(`^${B}(?:how many|how much|kaç)${E}`, "iu");
const CALC_WORDS = words("how many|how much|number of|most|least|highest|lowest|top \\d+|total|average|rank|ranking|kaç|en çok|en az|toplam|ortalama");
const EVENT = words(
  [
    "whenever",
    "every time",
    "each time",
    "as soon as",
    "(?:every|each|any|all) (?:new |incoming )?(?:e-?mails?|mails?|messages?|orders?|invoices?|complaints?|requests?|cvs?|applications?|files?)",
    "(?:e-?mails?|mails?|messages?) (?:that|which) (?:come|comes|arrive|arrives)",
    "(?:come|comes|coming|arrive|arrives|arriving) (?:in )?by e-?mail",
    "from (?:the |our |their )?(?:e-?mails?|mails?|mailbox|inbox)",
    "(?:in|into|to) (?:the |our )?(?:inbox|mailbox)",
    "gelen (?:her )?(?:e-?postalar?|e-?postaları|mailler|mail)",
    "e-?postayla gelen",
  ].join("|"),
);
const HIRE = words(
  "an? ai employee|ai employees?|hire|an? (?:bot|agent) (?:that|who|to)|(?:someone|somebody) (?:who|to)|automatically|on its own|by itself|yapay zeka çalışanı|otomatik(?:\\s+olarak)?",
);
const APP = words("app|apps|application|register|tracker|dashboard|portal|screens?|forms?|uygulama|ekran|takip sistemi|kayıt defteri");
const TABLE = words("table|spreadsheet|database|list of|keep track|track of|log of|records? of|tablo|liste(?:si)?|kayıtları");
const CHANGE = new RegExp(
  `^(?:please\\s+)?${B}(?:change|rename|add|remove|delete|drop|take away|make|move|show|hide|include|update|put|değiştir|ekle|kaldır|sil|çıkar)${E}`,
  "iu",
);
const TASK = new RegExp(
  `^${B}(?:send|write|draft|prepare|check|find|reply|answer|book|summari[sz]e|look up|look at|collect|remind|tell|email|mail|call|file|log|record|create|translate|review|go through|list|gönder|yaz|hazırla|kontrol|bul|cevapla|yanıtla|özetle|çevir)${E}`,
  "iu",
);
const PERIOD = words("last month|this month|this week|this year|last year|geçen ay|bu ay|bu hafta|bu yıl|geçen yıl");

const WEEKDAYS: [RegExp, number][] = [
  [/sunday|pazar(?!tesi)/iu, 0],
  [/monday|pazartesi/iu, 1],
  [/tuesday|salı/iu, 2],
  [/wednesday|çarşamba/iu, 3],
  [/thursday|perşembe/iu, 4],
  [/friday|cuma(?!rtesi)/iu, 5],
  [/saturday|cumartesi/iu, 6],
];
const DAY_NAMES = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar";

/** When it repeats, as people say it, and the request without those words. */
export function scheduleFromWords(text: string): { schedule?: RepeatSchedule; rest: string; notes: string[] } {
  let rest = ` ${text} `;
  const notes: string[] = [];
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const m = pattern.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  let every: RepeatSchedule["every"] | undefined;
  let weekday: number | undefined;
  let day: number | undefined;
  let time: string | undefined;
  let hourHint: number | undefined;

  // A day of the month first: "on the 15th of every month" says both the day and the month.
  const nth = take(
    words("on the (\\d{1,2})(?:st|nd|rd|th)?( of (?:every|each) month)?|(her )?ayın (\\d{1,2})(?:'?(?:si|sı|ü|u|i|ı|nde|nda|inde|ında|ünde|unda))?"),
  );
  const start = !nth && take(words("(?:at the )?(?:start|beginning) of (?:every|each|the) month|ay başı(?:nda)?"));
  const end = !nth && !start && take(words("(?:at the )?end of (?:every|each|the) month|ay sonu(?:nda)?"));
  const named = take(
    words(
      `(?:every|each|on) (?:${DAY_NAMES})s?(?: (morning|afternoon|evening))?|(?:${DAY_NAMES})s(?: (morning|afternoon|evening))?|her (?:${DAY_NAMES})(?: (sabah|öğlen|akşam))?|(?:${DAY_NAMES})(?:ları|leri)`,
    ),
  );
  if (named) {
    every = "week";
    weekday = WEEKDAYS.find(([pattern]) => pattern.test(named[0]))?.[1];
    hourHint = partOfDay(named[1] ?? named[2] ?? named[3]);
  } else if (take(words("(?:every|each|on) (?:weekday|working day|business day|work day)s?|on weekdays|hafta ?içi(?: her gün)?"))) {
    every = "weekday";
  } else {
    const daily = take(words("(?:every|each) (day|morning|afternoon|evening|night)|daily|her (gün|sabah|öğlen|akşam)|günlük"));
    if (daily) {
      every = "day";
      hourHint = partOfDay(daily[1] ?? daily[2]);
    } else if (take(words("(?:every|each) week|weekly|once a week|her hafta|haftalık"))) {
      every = "week";
    } else if (take(words("(?:every|each) month|monthly|once a month|her ay|aylık"))) {
      every = "month";
    }
  }
  if (every === "month" || (every === undefined && (nth?.[2] || nth?.[3] || start || end))) {
    every = "month";
    if (nth) day = Number(nth[1] ?? nth[4]);
    if (end) {
      day = 28;
      notes.push("At the end of the month: on the 28th, which every month has.");
    }
    if (day !== undefined && day > 28) {
      notes.push(`On the ${day}th: on the 28th, which every month has.`);
      day = 28;
    }
  }
  const at =
    take(/(?:\s(?:at|@)\s*|\ssaat\s*)(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|'?(?:de|da|te|ta))?(?=[\s,.!?]|$)/iu) ??
    take(/\s(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)(?=[\s,.!?]|$)/iu);
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] ?? 0);
    if (/pm/i.test(at[3] ?? "") && hour < 12) hour += 12;
    if (/am/i.test(at[3] ?? "") && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  } else if (take(words("at noon|öğlen"))) {
    time = "12:00";
  }
  if (!time && hourHint !== undefined) time = `${String(hourHint).padStart(2, "0")}:00`;
  rest = rest
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "")
    .replace(/^(?:and|then)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!every) return { rest: text, notes: [] };
  return {
    schedule: RepeatSchedule.parse({ every, ...(weekday !== undefined ? { weekday } : {}), ...(day !== undefined ? { day } : {}), ...(time ? { time } : {}) }),
    rest: rest.charAt(0).toUpperCase() + rest.slice(1),
    notes,
  };
}

function partOfDay(word: string | undefined): number | undefined {
  if (!word) return undefined;
  if (/afternoon|öğlen/i.test(word)) return 13;
  if (/evening|night|akşam/i.test(word)) return 18;
  return undefined; // morning: the usual 08:00
}

function lower(text: string): string {
  return text.replace(/İ/g, "i").toLowerCase();
}

const STOP = new Set(
  "the and for with from that this these those them they their our your you yours me my mine all any every each into onto about what when where which who how why please need want send make get have has are was were will would could should can new one its also then than there here some more most just like give gives ask tell let bir ve ile için bu şu her gibi olan daha çok ama veya ne".split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return lower(text)
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** The AI employee whose job the words fit best (its name counts most), if any fits at all. */
export function bestAgent(text: string, agents: NeedAgent[]): string | undefined {
  const asked = new Set(tokens(text));
  let best: { slug: string; score: number } | undefined;
  for (const agent of agents) {
    const name = new Set(tokens(agent.name));
    const job = new Set(tokens([agent.summary ?? "", ...(agent.duties ?? [])].join(" ")));
    let score = 0;
    for (const word of asked) score += name.has(word) ? 3 : job.has(word) ? 1 : 0;
    if (score > 0 && (!best || score > best.score)) best = { slug: agent.slug, score };
  }
  return best?.slug;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Mail Triage: …", "Ask Mail Triage to …": the AI employee named first, and the work. */
function namedAgent(text: string, agents: NeedAgent[]): { agent: string; rest: string } | undefined {
  for (const agent of [...agents].sort((a, b) => b.name.length - a.name.length)) {
    const m = new RegExp(
      `^(?:please\\s+)?(?:(?:ask|tell|have|get|let)\\s+)?(?:the\\s+)?${escape(agent.name)}${E}(?:\\s*[:,–-]\\s*|\\s+(?:to|should|must|please|,)\\s+)(.+)$`,
      "iu",
    ).exec(text);
    if (m?.[1]) return { agent: agent.slug, rest: m[1].trim() };
  }
  return undefined;
}

/** What the company has that the words name, the longest name first. */
function mentioned(text: string, materials: NeedMaterials): NeedTarget | undefined {
  const things: NeedTarget[] = [
    ...materials.tables.map((t) => ({ type: "table" as const, key: t.key, name: t.name })),
    ...materials.apps.map((a) => ({ type: "app" as const, key: a.key, name: a.name })),
    ...materials.calculations.map((c) => ({ type: "calculation" as const, key: c.key, name: c.name })),
    ...materials.agents.map((a) => ({ type: "agent" as const, key: a.slug, name: a.name })),
  ].sort((a, b) => b.name.length - a.name.length);
  const said = lower(text);
  return things.find((t) => new RegExp(`${B}${escape(lower(t.name))}${E}`, "u").test(said));
}

/** The change without the name of what it changes: "add Root cause to the Complaints table" → "add Root cause". */
function withoutName(text: string, target: NeedTarget): string {
  const name = escape(target.name);
  const kind = "(?:\\s+(?:table|app|application|calculation|list|register))?";
  return text
    .replace(new RegExp(`^(?:please\\s+)?(?:change|update)\\s+(?:the\\s+)?${name}${kind}${E}\\s*[:,–-]?\\s*(?:so that|so|to)?\\s*`, "iu"), "")
    .replace(new RegExp(`^(?:the\\s+)?${name}${kind}${E}\\s*[:,–-]\\s*`, "iu"), "")
    .replace(new RegExp(`\\s*${B}(?:to|in|on|from|of|for)\\s+(?:the\\s+)?${name}${kind}${E}`, "giu"), "")
    .trim();
}

/** Read the request from the words alone (no model). */
export function wordsNeed(text: string, materials: NeedMaterials, as?: NeedKind): UnderstoodNeed {
  const core = text.replace(POLITE, "").trim();
  const asking = ASKING.test(text);
  const { schedule, rest, notes } = scheduleFromWords(core);
  const named = namedAgent(core, materials.agents);
  const target = mentioned(core, materials);
  const isQuestion = !asking && (QUESTION.test(core) || core.endsWith("?"));
  const calcLike = CALC.test(rest) || ((isQuestion || HOW_MANY.test(core)) && CALC_WORDS.test(core) && mentionsTable(core, materials));

  let kind: NeedKind = as ?? "unclear";
  if (!as) {
    if (named && target?.type !== "table" && target?.type !== "app" && target?.type !== "calculation" && !CHANGE.test(core))
      kind = schedule ? "recurring" : "task";
    else if (target && (CHANGE.test(core) || /\binstead\b/i.test(core) || new RegExp(`^(?:the\\s+)?${escape(target.name)}${E}\\s*:`, "iu").test(core)))
      kind = "change";
    else if (EVENT.test(core) || HIRE.test(core)) kind = "ai-employee";
    else if (schedule) kind = calcLike || CALC_WORDS.test(rest) ? "calculation" : "recurring";
    else if (APP.test(core)) kind = "app";
    else if (TABLE.test(core)) kind = "table";
    else if (calcLike) kind = "calculation";
    else if (isQuestion) kind = "answer";
    else if (named || TASK.test(core) || (materials.agents.length && bestAgent(core, materials.agents))) kind = "task";
  }
  if ((kind === "task" || kind === "recurring") && !materials.agents.length) kind = "ai-employee";
  if (kind === "change" && !target) kind = "unclear";

  const need: UnderstoodNeed = { kind, alternatives: otherReadings(kind, materials, target), notes: [...notes], drafted: "words" };
  switch (kind) {
    case "task":
    case "recurring": {
      const said = (named ? scheduleFromWords(named.rest).rest : rest).replace(/\?$/, "");
      const work = said.charAt(0).toUpperCase() + said.slice(1);
      const agent = named?.agent ?? bestAgent(work, materials.agents);
      Object.assign(need, { work, ...(agent ? { agent } : {}) });
      if (kind === "recurring") {
        need.schedule = schedule ?? RepeatSchedule.parse({ every: "week", weekday: 1 });
        if (!schedule) need.notes.push("When wasn't said: every Monday at 08:00 unless you choose another time.");
      }
      break;
    }
    case "calculation": {
      let rule = rest.replace(/\?$/, "");
      if (schedule?.every === "month" && !PERIOD.test(rule)) rule = `${rule} last month`;
      need.description = rule;
      if (schedule) need.schedule = schedule;
      break;
    }
    case "change":
      need.target = target!;
      need.change = target!.type === "agent" ? text : withoutName(core, target!) || core;
      break;
    case "unclear":
      need.question =
        "What should happen: should an AI employee do it, should it be answered from the company's knowledge, or do you want to keep track of something?";
      break;
    default:
      need.description = text;
  }
  return need;
}

/** Whether the words name one of the tables (by its name, or the words of its name). */
function mentionsTable(text: string, materials: NeedMaterials): boolean {
  const said = new Set(tokens(text));
  return materials.tables.some((t) => {
    const name = tokens(t.name);
    return name.length > 0 && name.some((w) => said.has(w));
  });
}
