/**
 * Helpers for the full-text side of hybrid search. The chunk tsvector uses the
 * `simple` configuration (no stemming, no stopwords), which works for any
 * language but means the loose fallback query has to drop function words itself.
 * Case folding is left to Postgres (to_tsquery applies the same lowercasing as
 * to_tsvector), so terms keep their original case here.
 */

const STOPWORDS = new Set(
  [
    // English
    "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "before",
    "being", "but", "by", "can", "could", "did", "do", "does", "doing", "for", "from", "get", "got", "had", "has",
    "have", "how", "i", "if", "in", "into", "is", "it", "its", "me", "many", "may", "much", "my", "no", "not", "of",
    "on", "or", "our", "should", "so", "than", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "those", "to", "us", "was", "we", "were", "what", "when", "where", "which", "who", "whom", "why",
    "will", "with", "would", "you", "your",
    // Turkish
    "acaba", "ama", "bir", "bu", "da", "daha", "de", "en", "fakat", "gibi", "göre", "hangi", "hangisi", "her",
    "için", "ile", "kaç", "kadar", "ki", "mi", "mı", "mu", "mü", "midir", "mıdır", "nasıl", "ne", "neden",
    "nedir", "nerede", "niçin", "olan", "olarak", "şu", "ve", "veya", "ya",
  ],
);

function isStopword(term: string): boolean {
  // Both foldings: "IS" -> "is" (English) and "İÇİN" -> "için" (Turkish dotted/dotless i).
  return STOPWORDS.has(term.toLowerCase()) || STOPWORDS.has(term.toLocaleLowerCase("tr"));
}

const MAX_TERM_CHARS = 100;

/**
 * Distinct search terms of a free-text query: letters/digits only (so they are
 * safe inside a tsquery), 2-100 characters, stopwords removed unless nothing
 * else is left, excluded (`-term`) words dropped.
 */
export function extractSearchTerms(query: string, maxTerms = 16): string[] {
  const terms: string[] = [];
  const stopwords: string[] = [];
  const seen = new Set<string>();
  for (const token of query.normalize("NFC").split(/\s+/)) {
    if (token.length > 1 && token.startsWith("-")) continue;
    // Apostrophes: keep the stem of "Acme'nin" / "employee's", the name in "O'Reilly" / "l'entreprise".
    const [head = "", ...rest] = token.split(/['’]/);
    const stem = [...head].length >= 2 ? head : rest.join("");
    for (const part of stem.split(/[^\p{L}\p{M}\p{N}]+/u)) {
      const length = [...part].length;
      if (length < 2 || length > MAX_TERM_CHARS || !/[\p{L}\p{N}]/u.test(part)) continue;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      (isStopword(part) ? stopwords : terms).push(part);
    }
  }
  return (terms.length > 0 ? terms : stopwords).slice(0, Math.max(1, maxTerms));
}

/** One tsquery operand per term; terms of 3+ characters match as prefixes (inflections, compounds). */
export function termQueries(terms: string[]): string[] {
  return terms.map((term) => ([...term].length >= 3 ? `${term}:*` : term));
}

/** `a:* | b:* | c` — the loose query used when the strict websearch query finds nothing. */
export function buildPrefixTsQuery(terms: string[]): string {
  return termQueries(terms).join(" | ");
}
