/**
 * YAML emitter restricted to what Paperclip's hand-rolled parser accepts
 * (server/src/services/company-portability.ts): 2-space indentation, list
 * items indented under their key, every string double-quoted (JSON escaping),
 * no block scalars, no flow collections except `{}` / `[]`, no comments.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue | undefined };

function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isScalar(value: YamlValue): value is string | number | boolean | null {
  return value === null || typeof value !== "object";
}

function emit(value: YamlValue, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalar(item)}`);
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        emit(item, indent + 2, lines);
      } else {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined) as [string, YamlValue][];
        if (!entries.length) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstValue] = entries[0]!;
        const nested: string[] = [];
        emitEntry(firstKey, firstValue, indent + 2, nested);
        lines.push(`${pad}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
        for (const [k, v] of entries.slice(1)) emitEntry(k, v, indent + 2, lines);
      }
    }
    return;
  }
  if (isScalar(value)) {
    lines.push(`${pad}${scalar(value)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    emitEntry(key, child, indent, lines);
  }
}

function emitEntry(key: string, value: YamlValue, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  const safeKey = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
  if (isScalar(value)) {
    lines.push(`${pad}${safeKey}: ${scalar(value)}`);
  } else if (Array.isArray(value)) {
    if (!value.length) lines.push(`${pad}${safeKey}: []`);
    else {
      lines.push(`${pad}${safeKey}:`);
      emit(value, indent + 2, lines);
    }
  } else {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) lines.push(`${pad}${safeKey}: {}`);
    else {
      lines.push(`${pad}${safeKey}:`);
      emit(value, indent + 2, lines);
    }
  }
}

export function toYaml(value: { [key: string]: YamlValue | undefined }): string {
  const lines: string[] = [];
  emit(value, 0, lines);
  return `${lines.join("\n")}\n`;
}

/** Markdown file with YAML frontmatter (`---\n...\n---\n` exactly, as Paperclip expects). */
export function markdownWithFrontmatter(frontmatter: { [key: string]: YamlValue | undefined }, body: string): string {
  return `---\n${toYaml(frontmatter)}---\n\n${body.trim()}\n`;
}
