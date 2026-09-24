import type { Category, Criterion } from "@enterprise-brain/core";

export type Met = "yes" | "partial" | "no" | "unknown";

export interface CriterionAssessment {
  id: string;
  label: string;
  kind: "must" | "nice" | "knockout";
  weight: number;
  met: Met;
  /** 0-100 */
  score: number;
  evidence: string;
}

export interface EvaluationResult {
  score: number;
  verdict: "pass" | "review" | "fail";
  knockout: boolean;
  criteria: CriterionAssessment[];
  strengths: string[];
  gaps: string[];
  summary: string;
}

const MET_SCORE: Record<Met, number> = { yes: 100, partial: 50, no: 0, unknown: 0 };

/**
 * Aggregate per-criterion judgements into a score and verdict. Deliberately
 * deterministic (not left to the model) so every decision is explainable:
 * - a failed knockout criterion fails the candidate/document outright;
 * - a missing or unverifiable must-have caps the verdict at "review";
 * - otherwise the weighted score decides: >= passScore pass, >= passScore-20 review.
 */
export function aggregateEvaluation(
  assessments: CriterionAssessment[],
  passScore = 70,
  summary = "",
): EvaluationResult {
  const scored = assessments.filter((a) => a.kind !== "knockout");
  const totalWeight = scored.reduce((s, a) => s + a.weight, 0);
  const score = totalWeight > 0 ? Math.round(scored.reduce((s, a) => s + a.weight * clamp(a.score), 0) / totalWeight) : 0;
  const knockout = assessments.some((a) => a.kind === "knockout" && a.met === "no");
  const mustMissing = assessments.some((a) => a.kind === "must" && a.met === "no");
  const uncertain = assessments.some((a) => (a.kind === "must" || a.kind === "knockout") && a.met === "unknown");
  let verdict: EvaluationResult["verdict"];
  if (knockout) verdict = "fail";
  else if (mustMissing || uncertain) verdict = score >= passScore - 20 ? "review" : "fail";
  else if (score >= passScore) verdict = "pass";
  else if (score >= passScore - 20) verdict = "review";
  else verdict = "fail";
  const strengths = assessments.filter((a) => a.met === "yes").map((a) => a.label);
  const gaps = assessments.filter((a) => a.met !== "yes").map((a) => `${a.label}${a.met === "unknown" ? " (not evidenced)" : a.met === "partial" ? " (partially)" : ""}`);
  return {
    score,
    verdict,
    knockout,
    criteria: assessments,
    strengths,
    gaps,
    summary: summary || defaultSummary(score, verdict, strengths, gaps),
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

function defaultSummary(score: number, verdict: string, strengths: string[], gaps: string[]): string {
  const parts = [`Score ${score}/100 — ${verdict}.`];
  if (strengths.length) parts.push(`Meets: ${strengths.join(", ")}.`);
  if (gaps.length) parts.push(`Gaps: ${gaps.join(", ")}.`);
  return parts.join(" ");
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "years", "year", "experience", "of", "in", "a", "an", "to", "or", "at", "least", "on",
  "ve", "ile", "icin", "en", "az", "yil", "bir", "veya", "deneyim",
]);

function keywordsFor(label: string, keywords?: string[]): string[] {
  if (keywords?.length) return keywords;
  return normalizeText(label)
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Offline evaluator: keyword evidence per criterion. */
export function offlineEvaluate(subject: string, criteria: Criterion[], passScore = 70): EvaluationResult {
  const normalized = normalizeText(subject);
  const assessments = criteria.map((criterion): CriterionAssessment => {
    // A blocker ("requires visa sponsorship") settles the criterion even when its keywords ("citizen") also appear.
    const blocker = (criterion.blockers ?? [])
      .map(normalizeText)
      .map((k) => ({ k, i: k ? normalized.indexOf(k) : -1 }))
      .find((h) => h.i >= 0);
    if (blocker) {
      return {
        id: criterion.id,
        label: criterion.label,
        kind: criterion.kind,
        weight: criterion.weight,
        met: "no",
        score: 0,
        evidence: snippet(subject.replace(/\s+/g, " "), blocker.i, blocker.k.length),
      };
    }
    const keywords = keywordsFor(criterion.label, criterion.keywords).map(normalizeText);
    const hits = keywords
      .map((k) => ({ k, i: normalized.indexOf(k) }))
      .filter((h) => h.k.length > 0 && h.i >= 0);
    const fraction = keywords.length ? hits.length / keywords.length : 0;
    // With explicit keyword lists, any hit is evidence the criterion is addressed.
    const anyMode = Boolean(criterion.keywords?.length);
    let met: Met;
    if (hits.length === 0) met = criterion.kind === "nice" ? "no" : "unknown";
    else if (anyMode || fraction >= 0.75) met = "yes";
    else met = "partial";
    const score = met === "yes" ? 100 : met === "partial" ? Math.round(40 + 40 * fraction) : 0;
    const first = hits[0];
    return {
      id: criterion.id,
      label: criterion.label,
      kind: criterion.kind,
      weight: criterion.weight,
      met,
      score,
      evidence: first ? snippet(subject.replace(/\s+/g, " "), first.i, first.k.length) : "No evidence found (offline keyword check).",
    };
  });
  return aggregateEvaluation(assessments, passScore);
}

export interface ClassificationResult {
  category: string;
  categories?: string[];
  confidence: number;
  reason: string;
}

/** Offline classifier: keyword scoring (category keywords, label and value words). */
export function offlineClassify(text: string, categories: Category[], multi = false): ClassificationResult {
  const normalized = normalizeText(text);
  const scores = categories.map((category) => {
    const terms = [...(category.keywords ?? []), ...keywordsFor(category.label ?? category.value), category.value.replace(/[-_]/g, " ")]
      .map(normalizeText)
      .filter((t) => t.length > 2);
    const matched = [...new Set(terms.filter((t) => normalized.includes(t)))];
    return { category, score: matched.length, matched };
  });
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const fallback = categories.find((c) => ["other", "general", "unknown", "diger"].includes(c.value)) ?? categories[0]!;
  if (!best || best.score === 0) {
    return { category: fallback.value, ...(multi ? { categories: [fallback.value] } : {}), confidence: 0.2, reason: "No category keywords matched (offline classifier)." };
  }
  const total = scores.reduce((s, x) => s + x.score, 0);
  return {
    category: best.category.value,
    ...(multi ? { categories: scores.filter((s) => s.score > 0).map((s) => s.category.value) } : {}),
    confidence: Math.round((0.4 + 0.6 * (best.score / total)) * 100) / 100,
    reason: `Matched keywords: ${best.matched.join(", ")} (offline classifier).`,
  };
}
