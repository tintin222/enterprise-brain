/** Parse the first JSON object/array found in model text (tolerates ```json fences and prose around it). */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through to bracket scanning
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}
