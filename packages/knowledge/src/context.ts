import { truncateText } from "./text.ts";
import type { SearchHit } from "./types.ts";

export const DEFAULT_CONTEXT_MAX_CHARS = 12000;
/** Below this, a truncated source would be too short to be useful. */
const MIN_TRUNCATED_CHARS = 80;

/**
 * Formats search hits as numbered sources for grounding an answer:
 *
 *     [1] Leave Policy — Employees receive 20 days of paid annual leave…
 *
 *     [2] Expense Policy — …
 *
 * Source [n] is always `hits[n - 1]`, so model citations map back to hits. The
 * result never exceeds `maxChars`; the last source that does not fit is truncated
 * (or left out when only a sliver would remain).
 */
export function buildContext(hits: SearchHit[], maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {
  const sources: string[] = [];
  let used = 0;
  for (const [index, hit] of hits.entries()) {
    const separator = sources.length > 0 ? "\n\n" : "";
    const title = hit.title.replace(/\s+/g, " ").trim() || "Untitled";
    const head = `[${index + 1}] ${title} — `;
    const room = maxChars - used - separator.length - head.length;
    const content = hit.content.trim();
    if (room <= 0) break;
    if (content.length > room && room < MIN_TRUNCATED_CHARS && sources.length > 0) break;
    const source = head + truncateText(content, room);
    sources.push(source);
    used += separator.length + source.length;
    if (content.length > room) break;
  }
  return sources.join("\n\n");
}
