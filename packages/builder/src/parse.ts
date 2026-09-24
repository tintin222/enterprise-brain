import type { RequirementNode, RequirementOption, RoundQuestion, StakeholderRole } from "@enterprise-brain/core";

export type ParsedAction = "answer" | "accept" | "delegate" | "skip";

export interface ParsedAnswer {
  nodeId: string;
  action: ParsedAction;
  value?: unknown;
  text: string;
  delegateTo?: StakeholderRole;
}

const ACCEPT = /^(ok|okay|yes|yep|yeah|sure|agree|agreed|fine|correct|right|sounds good|looks good|recommended|go with (it|that|the recommendation)|as recommended|evet|tamam|olur|uygun|kabul|aynen|doğru|dogru|önerilen|onerilen|önerildiği gibi|onay|👍|✅)\b/i;
const ACCEPT_ALL = /^(ok|okay|yes|all good|agree(d)?( with)? (all|everything)|all fine|go with (all|your) recommendations?|accept all|hepsi (tamam|uygun|olur)|hepsine evet|önerilenler(le)? (tamam|uygun|olur)|(ö|o)nerilerinle devam( et| edelim)?|(ö|o)nerilerle devam( et| edelim)?|tümü tamam)[\s.!]*$/i;
const UNKNOWN = /(don'?t know|do not know|not sure|no idea|unsure|ask (it|the it|legal|dpo|hr|finance|security|someone)|check with|need to ask|bilmiyorum|emin değilim|emin degilim|bilgim yok|fikrim yok|sormam lazım|it'?ye sor|bt'?ye sor|bilgi işlem|bilgi islem|hukuka sor|kvkk sorumlusu)/i;
const SKIP = /^(skip|n\/a|na|not applicable|none|nothing|pass|no samples|i don'?t have (any )?(samples|examples)|geç|gec|atla|yok|örnek yok|ornek yok|gerek yok)\b/i;
const NO = /^(no|nope|hayır|hayir|yok)\b/i;

const ROLE_HINTS: [RegExp, StakeholderRole][] = [
  [/\b(it|bt|bilgi işlem|bilgi islem|integration|entegrasyon|sysadmin|system admin)\b/i, "it"],
  [/\b(dpo|kvkk|gdpr|data protection|veri koruma)\b/i, "dpo"],
  [/\b(legal|hukuk|lawyer|avukat)\b/i, "legal"],
  [/\b(security|güvenlik|guvenlik|ciso)\b/i, "security"],
  [/\b(finance|finans|muhasebe|accounting|cfo)\b/i, "finance"],
  [/\b(manager|management|yönetim|yonetim|director|direktör|müdür|mudur)\b/i, "management"],
];

const ORDINALS: Record<string, number> = {
  first: 0, "1st": 0, a: 0, birinci: 0, ilk: 0,
  second: 1, "2nd": 1, b: 1, ikinci: 1,
  third: 2, "3rd": 2, c: 2, üçüncü: 2, ucuncu: 2,
  fourth: 3, "4th": 3, d: 3, dördüncü: 3, dorduncu: 3,
  fifth: 4, "5th": 4, e: 4, beşinci: 4, besinci: 4,
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/** Split "1 yes, 2 the second option\n3) ask IT" into numbered segments. */
export function splitNumbered(text: string, count: number): Map<number, string> | undefined {
  const marker = /(^|[\n,;]|\s{2,})\s*(?:q|s|soru|question)?\s*#?(\d{1,2})\s*(?:[).:\-–—]|\s(?=\S))\s*/gi;
  const hits: { n: number; start: number; end: number }[] = [];
  for (const match of text.matchAll(marker)) {
    const n = Number(match[2]);
    if (n < 1 || n > count) continue;
    const start = match.index! + match[1]!.length;
    hits.push({ n, start, end: match.index! + match[0].length });
  }
  // Must be increasing to be read as numbering (avoids "within 30 days" style numbers).
  const ordered = hits.filter((h, i) => i === 0 || h.n > hits[i - 1]!.n);
  if (!ordered.length) return undefined;
  const segments = new Map<number, string>();
  ordered.forEach((hit, i) => {
    const next = ordered[i + 1];
    const body = text.slice(hit.end, next ? next.start : undefined).replace(/^[\s,;]+|[\s,;]+$/g, "");
    segments.set(hit.n, body);
  });
  return segments;
}

function splitList(text: string): string[] {
  return text
    .split(/\n|;|,|\s+(?:and|ve|ile)\s+|•|·|(?:^|\s)-\s/)
    .map((s) => s.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((s) => s.length > 0);
}

function containsWords(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

function matchOptions(options: readonly RequirementOption[], text: string): string[] {
  const norm = normalize(text);
  const matched = new Set<string>();
  // "b", "(b)" or "b)" on its own picks an option by letter; "a few" does not.
  const letter = norm.match(/^\(?([a-e])(?:\)|\.|$)/)?.[1];
  for (const [word, index] of Object.entries(ORDINALS)) {
    const hit = word.length === 1 ? letter === word : containsWords(norm, word);
    if (hit && options[index]) matched.add(options[index]!.value);
  }
  const textNumbers = new Set(norm.match(/\d+/g) ?? []);
  for (const option of options) {
    const label = normalize(option.label);
    const value = normalize(option.value).replace(/-/g, " ");
    // Numbers are what distinguish "30 days" from "1 year": they must agree.
    if (!(label.match(/\d+/g) ?? []).every((n) => textNumbers.has(n))) continue;
    const labelWords = label.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const wordHits = labelWords.filter((w) => containsWords(norm, w) || norm.split(/[^a-z0-9]+/).some((t) => t.length > 3 && (t.startsWith(w) || w.startsWith(t)))).length;
    if (containsWords(norm, value) || containsWords(norm, label) || (labelWords.length && wordHits / labelWords.length >= 0.5)) {
      matched.add(option.value);
    }
  }
  return [...matched];
}

function detectRole(text: string): StakeholderRole | undefined {
  return ROLE_HINTS.find(([pattern]) => pattern.test(text))?.[1];
}

export function interpret(question: RoundQuestion, raw: string): ParsedAnswer {
  const text = raw.trim();
  const base = { nodeId: question.nodeId, text };
  if (!text) return { ...base, action: "skip" };
  if (UNKNOWN.test(text)) {
    return { ...base, action: "delegate", delegateTo: detectRole(text) };
  }
  if (question.answerType === "boolean") {
    if (NO.test(text)) return { ...base, action: "answer", value: false };
    if (ACCEPT.test(text)) return { ...base, action: "answer", value: true };
  }
  if (question.answerType === "files" && SKIP.test(text)) return { ...base, action: "skip" };
  if (question.answerType === "single") {
    // "Ask IT on my behalf"-style options are delegations when chosen.
    const [first] = matchOptions(question.options ?? [], text);
    if (first) return { ...base, action: first === "ask-it" ? "delegate" : "answer", value: first, delegateTo: first === "ask-it" ? "it" : undefined };
    if (ACCEPT.test(text) && question.recommended !== undefined) return { ...base, action: "accept", value: question.recommended };
    if (SKIP.test(text)) return { ...base, action: "skip" };
    return { ...base, action: "answer", value: text };
  }
  if (question.answerType === "multi") {
    const matched = matchOptions(question.options ?? [], text);
    if (matched.length) return { ...base, action: "answer", value: matched };
    if (ACCEPT.test(text) && question.recommended !== undefined) return { ...base, action: "accept", value: question.recommended };
    if (SKIP.test(text)) return { ...base, action: "answer", value: [] };
    return { ...base, action: "answer", value: splitList(text) };
  }
  if (question.answerType === "number") {
    const n = text.match(/-?\d+(?:[.,]\d+)?/);
    if (n) return { ...base, action: "answer", value: Number(n[0].replace(",", ".")) };
  }
  if (["fields", "criteria", "categories"].includes(question.answerType)) {
    const recommended = Array.isArray(question.recommended) ? (question.recommended as string[]) : [];
    if (ACCEPT.test(text)) {
      const extra = text.replace(ACCEPT, "").replace(/^[\s,.:;-]*(but |plus |and also |also |ayrıca |ayrica |artı |arti |\+ ?)?/i, "");
      return { ...base, action: "accept", value: [...recommended, ...splitList(extra)] };
    }
    if (SKIP.test(text)) return { ...base, action: "skip" };
    return { ...base, action: "answer", value: splitList(text) };
  }
  if (ACCEPT.test(text) && question.recommended !== undefined && text.split(/\s+/).length <= 4) {
    return { ...base, action: "accept", value: question.recommended };
  }
  if (SKIP.test(text) && text.split(/\s+/).length <= 3) return { ...base, action: "skip" };
  return { ...base, action: "answer", value: text };
}

/**
 * Offline interpretation of a reply to a whole round. Returns answers for the
 * questions it could attribute; the rest stay open for the next round.
 */
export function parseRoundReply(text: string, questions: RoundQuestion[]): ParsedAnswer[] {
  const trimmed = text.trim();
  if (!trimmed || !questions.length) return [];
  if (ACCEPT_ALL.test(trimmed)) {
    return questions
      .filter((q) => q.recommended !== undefined && q.answerType !== "files")
      .map((q) => ({ nodeId: q.nodeId, action: "accept" as const, value: q.recommended, text: trimmed }));
  }
  // Numbers refer to the round's question numbers, which have gaps once some questions are settled.
  const numbered = splitNumbered(trimmed, Math.max(...questions.map((q) => q.number)));
  if (numbered) {
    const answers: ParsedAnswer[] = [];
    for (const [n, segment] of numbered) {
      const question = questions.find((q) => q.number === n);
      if (question) answers.push(interpret(question, segment));
    }
    return answers;
  }
  const [first] = questions;
  return first ? [interpret(first, trimmed)] : [];
}

export type CoercedAnswer = { ok: true; value: unknown } | { ok: false };

function optionFor(options: readonly RequirementOption[], text: string): string | undefined {
  const norm = normalize(text);
  const exact = options.find((o) => o.value === text) ?? options.find((o) => normalize(o.value) === norm || normalize(o.label) === norm);
  if (exact) return exact.value;
  const matched = matchOptions(options, text);
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * Fit an answer (from the user, the offline parser or Claude) to a node's answer
 * type. A choice answer must name one of the options unless the node allows
 * other answers; numbers and yes/no must parse. `ok: false` leaves the question
 * open so the analyst asks again instead of building on a value it can't use.
 */
export function coerceAnswer(node: Pick<RequirementNode, "answerType" | "options" | "allowOther">, value: unknown): CoercedAnswer {
  const options = node.options ?? [];
  const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
  switch (node.answerType) {
    case "single": {
      const raw = Array.isArray(value) ? value.find((v) => !blank(v)) : value;
      if (blank(raw)) return { ok: false };
      const text = String(raw).trim();
      if (!options.length) return { ok: true, value: text };
      const option = optionFor(options, text);
      if (option !== undefined) return { ok: true, value: option };
      return node.allowOther ? { ok: true, value: text } : { ok: false };
    }
    case "multi": {
      const items = (Array.isArray(value) ? value : typeof value === "string" ? splitList(value) : [value]).filter((v) => !blank(v)).map((v) => String(v).trim());
      if (!options.length) return { ok: true, value: items };
      // Unmatched items are kept: "WhatsApp" as an input channel is still worth knowing.
      return { ok: true, value: [...new Set(items.map((item) => optionFor(options, item) ?? item))] };
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value ?? "").match(/-?\d+(?:[.,]\d+)?/)?.[0]?.replace(",", "."));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      const text = String(value ?? "").trim();
      if (NO.test(text) || /^(false|off)$/i.test(text)) return { ok: true, value: false };
      if (ACCEPT.test(text) || /^(true|on)$/i.test(text)) return { ok: true, value: true };
      return { ok: false };
    }
    default:
      return { ok: true, value };
  }
}
