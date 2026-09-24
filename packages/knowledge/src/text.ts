import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Canonical form of document text: Unicode NFC, LF line endings, typographic
 * ligatures expanded, unified spaces, no control/zero-width characters (Postgres
 * rejects NUL), no trailing whitespace and at most one blank line in a row.
 * Chunking and content hashing both work on this form, so e.g. CRLF and LF copies
 * of a document are recognised as identical.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?|\u2028/g, "\n")
    .replace(/[\f\u2029]/g, "\n\n")
    .replace(/\v/g, "\n")
    .replace(/[\uFB00-\uFB06]/g, (ligature) => ligature.normalize("NFKC"))
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F\u00AD\u200B\u2060\uFEFF]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 (hex) of a text, as stored in `knowledge_documents.content_hash`. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Largest index <= `index` that does not split a surrogate pair or detach a
 * combining mark from its base character (never below `min + 1`, so a cut always
 * makes progress).
 */
export function safeCutIndex(text: string, index: number, min = 0): number {
  let cut = Math.min(Math.max(index, min + 1), text.length);
  if (cut >= text.length) return text.length;
  while (cut > min + 1 && isContinuation(text, cut)) cut--;
  if (!isContinuation(text, cut)) return cut;
  // Only continuation characters behind the cut: move forward instead of producing an empty piece.
  while (cut < text.length && isContinuation(text, cut)) cut++;
  return cut;
}

/** Smallest index >= `index` at which text can start without a dangling surrogate or combining mark. */
export function safeStartIndex(text: string, index: number): number {
  let start = Math.max(0, index);
  while (start < text.length && isContinuation(text, start)) start++;
  return start;
}

/** True when the character at `index` cannot begin a piece of text (low surrogate or combining mark). */
function isContinuation(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) return true;
  return COMBINING_MARK.test(text.charAt(index));
}

const COMBINING_MARK = /\p{M}/u;

/** Shortens text to at most `max` characters, ending with "…", preferring a word boundary. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return max === 1 ? "…" : "";
  let cut = Math.min(safeCutIndex(text, max - 1), max - 1);
  const space = text.lastIndexOf(" ", cut);
  if (space > (max - 1) * 0.8) cut = space;
  return `${text.slice(0, cut).trimEnd()}…`;
}
