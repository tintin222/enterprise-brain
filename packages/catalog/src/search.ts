import type { Archetype, Catalog } from "@enterprise-brain/core";

/**
 * Lightweight, dependency-free ranking of catalog templates against a free-text
 * description (English or Turkish). The Agent Builder uses it to propose the
 * template closest to what a user describes ("an agent that screens CVs",
 * "özgeçmişleri değerlendiren bir ajan"). Scoring:
 *
 * - text is folded (case, diacritics, Turkish dotless i) and tokenised;
 * - each query word scores its best match across weighted fields (name, title,
 *   summary, tags, match phrases…), weighted by how rare the word is in the
 *   catalog (IDF), so "cv" or "fatura" count more than "process";
 * - words match by prefix/inflection ("CVs" ~ "cv", "özgeçmişleri" ~
 *   "özgeçmiş", "screens" ~ "screening"), which covers English plurals and
 *   Turkish suffixes without a stemmer;
 * - template match phrases found as a whole (in order) earn a bonus;
 * - agents rank slightly above processes, use cases and departments.
 */

export type CatalogEntityKind = "agent" | "process" | "use-case" | "department";

export interface CatalogSearchResult {
  kind: CatalogEntityKind;
  id: string;
  name: string;
  summary: string;
  department?: string;
  archetype?: Archetype;
  score: number;
  /** Catalog words and phrases that matched, for explanations ("matched: cv screening, özgeçmiş"). */
  matched: string[];
}

export interface SearchCatalogOptions {
  /** Restrict to these kinds (default: all). */
  kinds?: CatalogEntityKind[];
  /** Restrict to one department. */
  department?: string;
  /** Maximum number of results (default 10). */
  limit?: number;
  /** Drop results scoring below this (default: anything above 0 is kept). */
  minScore?: number;
}

const STOPWORDS = new Set(
  [
    // English
    "a an the and or of to for in on at by with from into onto that this these those which who whom whose what when where why how",
    "is are be been being was were am do does did can could should would will shall may might must",
    "i me my mine we us our ours you your yours they them their he him his she her its as so than then there here",
    "want wants wanted need needs needed like please help helps make makes build builds create creates set get gets",
    "some any all each every also just only very more most such other about after before via per etc using use uses",
    "agent agents bot bots ai something someone thing things automatically",
    // Turkish (folded)
    "bir ve veya ile icin bu su o da de ki mi mu gibi olan olarak cok daha en her ne nasil ben biz sen siz bana bize",
    "beni bizi benim bizim senin sizin istiyorum istiyoruz isterim isteriz lazim gerek gerekiyor gerekli yapan yapacak",
    "eden edecek olsun tane sey ajan ajani ajanlar ajanlari yapay zeka kadar sonra once icinde uzere sekilde birlikte hem ya",
  ]
    .join(" ")
    .split(/\s+/),
);

const KIND_BOOST: Record<CatalogEntityKind, number> = { agent: 1, process: 0.8, "use-case": 0.75, department: 0.6 };
const KIND_ORDER: CatalogEntityKind[] = ["agent", "process", "use-case", "department"];

/** Fold case and diacritics: "Özgeçmiş İşleme" -> "ozgecmis isleme". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i");
}

/** Normalised, stopword-free search tokens of a text (order preserved). */
export function searchTokens(text: string): string[] {
  return normalizeSearchText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** 1 for identical words, less for inflections/prefixes, 0 for unrelated words. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.startsWith(short)) {
    const extra = long.length - short.length;
    if (short.length >= 4 && extra <= 6) return 0.85;
    if (short.length <= 3 && extra <= 1) return 0.8;
    if (short.length >= 5) return 0.6;
    return 0;
  }
  let common = 0;
  while (common < short.length && short[common] === long[common]) common++;
  return common >= 5 && common >= 0.75 * short.length ? 0.6 : 0;
}

interface WeightedField {
  tokens: string[];
  weight: number;
}

interface Phrase {
  text: string;
  tokens: string[];
  weight: number;
}

interface Entry {
  kind: CatalogEntityKind;
  id: string;
  name: string;
  summary: string;
  department?: string;
  archetype?: Archetype;
  fields: WeightedField[];
  phrases: Phrase[];
}

function field(weight: number, ...texts: (string | undefined)[]): WeightedField {
  return { weight, tokens: texts.flatMap((t) => (t ? searchTokens(t) : [])) };
}

function phrases(weight: number, texts: readonly string[]): Phrase[] {
  return texts.map((text) => ({ text, tokens: searchTokens(text), weight })).filter((p) => p.tokens.length > 0);
}

function buildEntries(catalog: Catalog): Entry[] {
  const processNames = new Map(catalog.processes.map((p) => [p.id, p.name]));
  const entries: Entry[] = [];
  for (const agent of catalog.agents) {
    entries.push({
      kind: "agent",
      id: agent.id,
      name: agent.name,
      summary: agent.summary,
      department: agent.department,
      archetype: agent.archetype,
      fields: [
        field(3, agent.name),
        field(2, agent.title),
        field(1.5, agent.summary),
        field(2, ...agent.tags),
        field(2.5, ...agent.builder.matchPhrases),
        field(1, agent.process ? processNames.get(agent.process) : undefined),
      ],
      phrases: [...phrases(3, agent.builder.matchPhrases), ...phrases(2, [agent.name])],
    });
  }
  for (const process of catalog.processes) {
    entries.push({
      kind: "process",
      id: process.id,
      name: process.name,
      summary: process.summary,
      department: process.department,
      fields: [
        field(3, process.name),
        field(1.5, process.summary),
        field(0.75, process.description),
        field(1, ...process.steps.map((s) => s.name)),
        field(0.5, process.trigger.description),
      ],
      phrases: phrases(2, [process.name]),
    });
  }
  for (const useCase of catalog.useCases) {
    entries.push({
      kind: "use-case",
      id: useCase.id,
      name: useCase.name,
      summary: useCase.summary,
      archetype: useCase.archetype,
      fields: [field(3, useCase.name), field(1.5, useCase.summary), field(0.75, useCase.description), field(1, ...useCase.examples)],
      phrases: phrases(2, [useCase.name]),
    });
  }
  for (const department of catalog.departments) {
    entries.push({
      kind: "department",
      id: department.id,
      name: department.name,
      summary: department.summary,
      department: department.id,
      fields: [field(3, department.name), field(1, department.summary), field(0.5, department.mission), field(2, ...department.tags)],
      phrases: phrases(2, [department.name, ...department.tags]),
    });
  }
  return entries;
}

/** Best average similarity of the phrase found as consecutive query tokens (0 when absent). */
function phraseMatch(query: readonly string[], phrase: readonly string[]): number {
  let best = 0;
  for (let i = 0; i + phrase.length <= query.length; i++) {
    let total = 0;
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      const s = similarity(query[i + j]!, phrase[j]!);
      if (s < 0.6) {
        ok = false;
        break;
      }
      total += s;
    }
    if (ok) best = Math.max(best, total / phrase.length);
  }
  return best;
}

/** Rank catalog templates (agents, processes, use cases, departments) by relevance to a free-text description. */
export function searchCatalog(catalog: Catalog, text: string, options: SearchCatalogOptions = {}): CatalogSearchResult[] {
  const query = searchTokens(text);
  if (!query.length) return [];
  const entries = buildEntries(catalog);

  const documentFrequency = new Map<string, number>();
  for (const entry of entries) {
    const unique = new Set(entry.fields.flatMap((f) => f.tokens));
    for (const token of unique) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const idf = (token: string) => Math.log(1 + entries.length / (1 + (documentFrequency.get(token) ?? 0)));

  const uniqueQuery = [...new Set(query)];
  const results: CatalogSearchResult[] = [];
  for (const entry of entries) {
    if (options.kinds && !options.kinds.includes(entry.kind)) continue;
    if (options.department && entry.department !== options.department) continue;
    let score = 0;
    const matched = new Set<string>();
    for (const q of uniqueQuery) {
      let best = 0;
      let bestToken = "";
      for (const f of entry.fields) {
        for (const token of f.tokens) {
          const s = similarity(q, token);
          if (s === 0) continue;
          const value = f.weight * s * idf(token);
          if (value > best) {
            best = value;
            bestToken = token;
          }
        }
      }
      if (best > 0) {
        score += best;
        matched.add(bestToken);
      }
    }
    for (const phrase of entry.phrases) {
      const m = phraseMatch(query, phrase.tokens);
      if (m === 0) continue;
      score += phrase.weight * phrase.tokens.length * m * (phrase.tokens.length > 1 ? 1.5 : 1);
      matched.add(phrase.text);
    }
    score = Math.round(score * KIND_BOOST[entry.kind] * 100) / 100;
    if (score <= (options.minScore ?? 0)) continue;
    results.push({
      kind: entry.kind,
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      ...(entry.department ? { department: entry.department } : {}),
      ...(entry.archetype ? { archetype: entry.archetype } : {}),
      score,
      matched: [...matched],
    });
  }
  results.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));
  return results.slice(0, options.limit ?? 10);
}
