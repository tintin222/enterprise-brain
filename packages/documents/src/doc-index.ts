import { SECTION_HEADINGS, type TermGroup } from "./lexicon.ts";
import { escapeRegExp, foldText } from "./text.ts";
import { detectDecimalSeparator, type DecimalSeparator } from "./values.ts";

export interface IndexedLine {
  text: string;
  /** `foldText(text)`: same length, so offsets are shared with `text`. */
  folded: string;
  /** Offsets of the line in the document text (end excludes the line break). */
  start: number;
  end: number;
}

export interface Section {
  heading: string;
  group?: TermGroup;
  /** Line index of the heading; the body is lines [bodyStart, bodyEnd). */
  line: number;
  bodyStart: number;
  bodyEnd: number;
}

/** An occurrence of a label ("Invoice No", "Toplam") with what follows it. */
export interface LabelHit {
  term: string;
  /** Offset of the label in the document text. */
  index: number;
  line: number;
  /** Only bullets, numbering or whitespace precede the label on its line. */
  atLineStart: boolean;
  /** An explicit separator (":", "#", "|", " - ", tab or 2+ spaces) follows the label. */
  separator: boolean;
  /** The rest of the line after the label and separator. */
  value: string;
  /** The rest of the line right after the label, including a parenthetical such as "(%20)". */
  rest: string;
  /** Value found through a table layout: the next cell, or the same column of the next row under a header row. */
  cellValue?: string;
  /** The label is a table header cell without a value row below it. */
  orphanHeaderCell?: boolean;
}

// Optional "." (abbreviations), an optional parenthetical ("KDV (%20)"), then a separator.
const SEPARATOR_RE = /^\.?(?:\s*\([^)]{0,40}\))?(?:\s*([:：=#|]+|[-–—](?=\s))|(\t| {2,}))?\s*/;
const LINE_START_PREFIX = /^[\s\-–—*•·▪◦>#|]*(?:\d{1,2}[.)]\s*)?$/;
const HEADING_QUALIFIER = /^(?:&|and|ve|und|et|y|\/|\(|-|–|—)/;
const MAX_VALUE_CHARS = 2000;

/** Folded heading text when a line looks like a heading (short, no sentence punctuation or inline value). */
export function headingText(line: string): string | undefined {
  if (line.length > 200) return undefined;
  const t = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:\d{1,2}|[IVX]{1,4})[.)]\s+/, "")
    .replace(/[\s:：=_*|–—-]+$/, "")
    .replace(/^[*_=]+/, "")
    .trim();
  if (t.length < 2 || t.length > 50) return undefined;
  if (/[.!?;,]$/.test(t) || /@|https?:|www\./i.test(t) || /\d{3,}/.test(t) || /[:：]\s*\S/.test(t)) return undefined;
  if (t.split(/\s+/).length > 6) return undefined;
  return foldText(t).replace(/\s+/g, " ");
}

/** "skills" matches the headings "Skills", "SKILLS:", "Skills & Tools" and "Skills (technical)". */
function headingMatches(heading: string, term: string): boolean {
  if (heading === term) return true;
  return heading.startsWith(`${term} `) && HEADING_QUALIFIER.test(heading.slice(term.length + 1));
}

function splitCells(text: string, start: number): { start: number; end: number; text: string }[] {
  const cells: { start: number; end: number; text: string }[] = [];
  let position = start;
  for (const part of text.split("|")) {
    cells.push({ start: position, end: position + part.length, text: part.trim() });
    position += part.length + 1;
  }
  if (cells.length > 1 && cells[0]!.text === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.text === "") cells.pop();
  return cells;
}

function isLabelLike(text: string): boolean {
  return /\p{L}/u.test(text) && !/\d/.test(text) && text.split(/\s+/).length <= 4;
}

/** Lines "Label: value" (a short label before a colon) are not values of a preceding label. */
const LABEL_LINE = /^[\p{L}][\p{L}\s.'/()-]{0,40}[:：]\s*\S/u;

/** A document prepared for heuristic lookups: lines, folded text, sections and labels. */
export class DocIndex {
  readonly text: string;
  readonly folded: string;
  readonly lines: IndexedLine[];
  readonly decimalSeparator: DecimalSeparator | undefined;
  /** Lines that look like headings, with their folded text. */
  readonly #headingLines: { line: number; heading: string }[] = [];
  readonly #hitsByTerm = new Map<string, LabelHit[]>();
  #sections: Section[] | undefined;

  constructor(text: string) {
    this.text = text.replace(/\r\n?/g, "\n");
    this.folded = foldText(this.text);
    let offset = 0;
    this.lines = this.text.split("\n").map((line) => {
      const entry = { text: line, folded: this.folded.slice(offset, offset + line.length), start: offset, end: offset + line.length };
      offset += line.length + 1;
      return entry;
    });
    this.lines.forEach((line, i) => {
      const heading = headingText(line.text);
      if (heading) this.#headingLines.push({ line: i, heading });
    });
    this.decimalSeparator = detectDecimalSeparator(this.text);
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lines[mid]!.start <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** Known section headings (CV sections and markdown headings) in document order, with body ranges. */
  get sections(): Section[] {
    if (!this.#sections) {
      const found: { line: number; group?: TermGroup }[] = [];
      for (const { line, heading } of this.#headingLines) {
        let group = SECTION_HEADINGS.get(heading);
        if (!group) {
          for (const [term, candidate] of SECTION_HEADINGS) {
            if (headingMatches(heading, term)) {
              group = candidate;
              break;
            }
          }
        }
        if (group || /^#{1,6}\s/.test(this.lines[line]!.text.trim())) found.push({ line, ...(group ? { group } : {}) });
      }
      this.#sections = found.map(({ line, group }, i) => ({
        heading: this.lines[line]!.text.trim().replace(/^#{1,6}\s+/, "").replace(/[\s:：]+$/, ""),
        ...(group ? { group } : {}),
        line,
        bodyStart: line + 1,
        bodyEnd: found[i + 1]?.line ?? this.lines.length,
      }));
    }
    return this.#sections;
  }

  /** The first heading matching one of the terms (in term priority order); its body runs to the next known heading. */
  findSection(terms: string[]): Section | undefined {
    for (const term of terms.map((t) => foldText(t).trim()).filter(Boolean)) {
      const line = this.#headingLines.find(({ heading }) => headingMatches(heading, term))?.line;
      if (line === undefined) continue;
      const known = this.sections.find((section) => section.line === line);
      if (known) return known;
      const next = this.sections.find((section) => section.line > line);
      return { heading: this.lines[line]!.text.trim(), line, bodyStart: line + 1, bodyEnd: next?.line ?? this.lines.length };
    }
    return undefined;
  }

  sectionLines(section: Section): string[] {
    const lines = this.lines.slice(section.bodyStart, section.bodyEnd).map((line) => line.text.trim());
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    while (lines.length > 0 && lines[0] === "") lines.shift();
    return lines;
  }

  isHeadingLine(line: number): boolean {
    return this.sections.some((section) => section.line === line);
  }

  /**
   * Label occurrences for the terms: grouped by term priority, then labels at
   * the start of a line before labels mid-line, then document order.
   */
  labelHits(terms: string[]): LabelHit[] {
    const folded = [...new Set(terms.map((t) => foldText(t).trim()).filter(Boolean))];
    return folded.flatMap((term) => this.#termHits(term));
  }

  #termHits(term: string): LabelHit[] {
    let termHits = this.#hitsByTerm.get(term);
    if (!termHits) {
      termHits = [];
      const words = term.split(/\s+/).map(escapeRegExp);
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]*")}(?![\\p{L}\\p{N}])`, "gu");
      for (const match of this.folded.matchAll(re)) {
        const line = this.lineAt(match.index);
        const { start, end } = this.lines[line]!;
        const matchEnd = match.index + match[0].length;
        // Values sit right after their label: a bounded window keeps huge single-line texts linear.
        const rest = this.text.slice(matchEnd, Math.min(end, matchEnd + MAX_VALUE_CHARS));
        const separator = SEPARATOR_RE.exec(rest)!;
        const hit: LabelHit = {
          term,
          index: match.index,
          line,
          atLineStart: match.index - start <= 40 && LINE_START_PREFIX.test(this.folded.slice(start, match.index)),
          separator: Boolean(separator[1] ?? separator[2]),
          value: rest.slice(separator[0].length).trim(),
          rest,
        };
        this.#applyTableLayout(hit, match.index, matchEnd);
        termHits.push(hit);
      }
      termHits.sort((a, b) => Number(b.atLineStart) - Number(a.atLineStart) || a.line - b.line);
      this.#hitsByTerm.set(term, termHits);
    }
    return termHits;
  }

  /** Tables rendered as "a | b | c" rows: a label cell's value is the next cell, or the cell below a header row. */
  #applyTableLayout(hit: LabelHit, matchStart: number, matchEnd: number): void {
    const line = this.lines[hit.line]!;
    if (!line.text.includes("|")) return;
    const cells = splitCells(line.text, line.start);
    const column = cells.findIndex((cell) => matchStart >= cell.start && matchEnd <= cell.end);
    if (cells.length < 2 || column < 0) return;
    const label = foldText(cells[column]!.text).replace(/[\s:：.#]+$/, "");
    if (label !== this.folded.slice(matchStart, matchEnd)) return;

    const others = cells.filter((_, i) => i !== column);
    const headerRow = cells.length >= 3 && others.every((cell) => cell.text === "" || isLabelLike(cell.text));
    if (!headerRow) {
      const next = cells[column + 1]?.text;
      if (next) hit.cellValue = next;
      else hit.orphanHeaderCell = true;
      return;
    }
    for (let j = hit.line + 1; j < Math.min(this.lines.length, hit.line + 4); j++) {
      const next = this.lines[j]!;
      if (!next.text.trim()) continue;
      const row = splitCells(next.text, next.start);
      if (row.length === cells.length && row[column]!.text) hit.cellValue = row[column]!.text;
      break;
    }
    if (hit.cellValue === undefined) hit.orphanHeaderCell = true;
  }

  /** The next non-empty line after a label-only line, unless it is itself a label or a heading. */
  nextValueLine(line: number): string | undefined {
    for (let j = line + 1; j < Math.min(this.lines.length, line + 3); j++) {
      const text = this.lines[j]!.text.trim();
      if (!text) continue;
      if (LABEL_LINE.test(text) || this.isHeadingLine(j)) return undefined;
      return text;
    }
    return undefined;
  }
}
