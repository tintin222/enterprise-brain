import { normalizeText, safeCutIndex, safeStartIndex } from "./text.ts";
import type { Chunk, ChunkOptions } from "./types.ts";

export const DEFAULT_CHUNK_MAX_CHARS = 1200;
export const DEFAULT_CHUNK_OVERLAP = 150;
const MIN_CHUNK_CHARS = 20;
/** Longer "headings" are treated as ordinary text. */
const MAX_HEADING_CHARS = 200;
const BLOCK_SEP = "\n\n";

type BlockKind = "heading" | "prose" | "list" | "table" | "code";

interface Heading {
  level: number;
  text: string;
}

interface Block {
  kind: BlockKind;
  text: string;
  /** Headings in effect, outermost first (a heading block includes itself). */
  path: Heading[];
}

/** Smallest piece of text the packer places into a chunk. */
interface Unit {
  text: string;
  path: Heading[];
  isHeading: boolean;
  /** Separator between this unit and the previous one when both land in the same chunk. */
  sep: string;
  /** Restated when the unit opens a chunk: the header rows of a table split across chunks. */
  lead?: string;
}

type Range = [start: number, end: number];

interface Config {
  maxChars: number;
  overlap: number;
  /** Longest heading line used as a chunk prefix. */
  prefixCap: number;
  /** Units never exceed this, so any unit fits a chunk after prefix and overlap. */
  unitLimit: number;
  /** A heading starts a new chunk once the current one is at least this long. */
  sectionBreak: number;
}

/**
 * Structure-aware chunking.
 *
 * 1. Text is normalised (NFC, LF line endings, no control characters) and split
 *    into blocks: markdown headings (ATX and setext), fenced code, tables, lists
 *    and blank-line separated paragraphs.
 * 2. Oversized blocks are broken into units: paragraphs on sentence boundaries
 *    (Intl.Segmenter, so Turkish and other scripts work), lists per item, code
 *    and tables per line, then on words, and finally hard cuts that never split
 *    a surrogate pair.
 * 3. Units are packed greedily up to `maxChars`. A heading starts a new chunk once
 *    the current one is half full, and is never left dangling at a chunk's end.
 * 4. A chunk that continues a section starts with the section heading and with
 *    `overlap` characters from the end of the previous chunk (cut at a sentence
 *    or word boundary). Chunks opening at a heading carry no overlap; chunks that
 *    continue a table restate its header rows instead.
 *
 * Every chunk (heading prefix and overlap included) is at most `maxChars` long
 * and non-empty. `metadata.heading` / `metadata.headingPath` describe the section
 * the chunk's content belongs to.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const config = resolveConfig(options);
  const units = parseBlocks(normalized).flatMap((block) => blockUnits(block, config.unitLimit));
  return pack(units, config);
}

function resolveConfig(options: ChunkOptions): Config {
  const maxChars = Math.max(MIN_CHUNK_CHARS, Math.floor(finiteOr(options.maxChars, DEFAULT_CHUNK_MAX_CHARS)));
  const overlap = Math.min(Math.max(0, Math.floor(finiteOr(options.overlap, DEFAULT_CHUNK_OVERLAP))), Math.floor(maxChars / 3));
  const prefixCap = Math.floor(maxChars / 5);
  return {
    maxChars,
    overlap,
    prefixCap,
    unitLimit: Math.max(1, maxChars - prefixCap - overlap - 2 * BLOCK_SEP.length),
    sectionBreak: Math.floor(maxChars / 2),
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Blocks

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_ITEM = /^[ \t]*(?:[-*+•‣◦▪]|\d{1,3}[.)])[ \t]+\S/;
const TABLE_ROW = /^[ \t]*\|/;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let path: Heading[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: classify(paragraph), text: paragraph.join("\n"), path });
    paragraph = [];
  };
  const addHeading = (level: number, title: string) => {
    flushParagraph();
    path = [...path.filter((h) => h.level < level), { level, text: title }];
    blocks.push({ kind: "heading", text: headingLine({ level, text: title }), path });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const end = fenceEnd(lines, i, fence[1]!);
      blocks.push({ kind: "code", text: lines.slice(i, end + 1).join("\n"), path });
      i = end;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    const atxTitle = atx ? cleanHeading(atx[2]!) : "";
    if (atx && atxTitle) {
      addHeading(atx[1]!.length, atxTitle);
      continue;
    }
    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline) {
      // "Title\n=====" is a heading; any other rule of = or - is decoration.
      const title = paragraph.length === 1 && classify(paragraph) === "prose" ? cleanHeading(paragraph[0]!) : "";
      if (title) {
        paragraph = [];
        addHeading(underline[1]!.startsWith("=") ? 1 : 2, title);
      } else {
        flushParagraph();
      }
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function fenceEnd(lines: string[], start: number, marker: string): number {
  const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (closer.test(lines[i]!)) return i;
  }
  return lines.length - 1;
}

/** Heading text without markdown emphasis; "" when it is not usable as a heading. */
function cleanHeading(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  const emphasis = /^(\*{1,3}|_{1,3})(.+?)\1$/.exec(title);
  if (emphasis) title = emphasis[2]!.trim();
  return title.length <= MAX_HEADING_CHARS ? title : "";
}

function classify(lines: string[]): BlockKind {
  if (
    lines.length >= 2 &&
    lines.every((line) => line.includes("|")) &&
    (TABLE_DIVIDER.test(lines[1]!) || lines.every((line) => TABLE_ROW.test(line)))
  ) {
    return "table";
  }
  return LIST_ITEM.test(lines[0]!) ? "list" : "prose";
}

function headingLine(heading: Heading): string {
  return `${"#".repeat(heading.level)} ${heading.text}`;
}

// ---------------------------------------------------------------------------
// Units

type Splitter = (text: string, start: number, end: number) => Range[];

function blockUnits(block: Block, limit: number): Unit[] {
  const { kind, text, path } = block;
  if (text.length <= limit) return [{ text, path, isHeading: kind === "heading", sep: BLOCK_SEP }];
  if (kind === "table") return tableUnits(text, path, limit);
  const splitters: Splitter[] =
    kind === "code" ? [lineRanges, wordRanges] : kind === "list" ? [listItemRanges, sentenceRanges, wordRanges] : [sentenceRanges, wordRanges];
  const ranges: Range[] = [];
  splitRange(text, 0, text.length, limit, splitters, 0, ranges);
  return ranges.map(([start, end], i) => ({
    text: text.slice(start, end),
    path,
    isHeading: false,
    sep: i === 0 ? BLOCK_SEP : separator(text.slice(ranges[i - 1]![1], start), kind === "code"),
  }));
}

/** Rows become units; when the table has a header it is restated in every chunk the table spills into. */
function tableUnits(text: string, path: Heading[], limit: number): Unit[] {
  const lines = text.split("\n");
  const header = lines.length > 2 && TABLE_DIVIDER.test(lines[1]!) ? `${lines[0]}\n${lines[1]}` : "";
  const lead = header && header.length + 1 <= limit / 2 ? header : undefined;
  const rowLimit = lead ? limit - lead.length - 1 : limit;
  const units: Unit[] = lead ? [{ text: lead, path, isHeading: false, sep: BLOCK_SEP }] : [];
  for (const row of lead ? lines.slice(2) : lines) {
    const ranges: Range[] = [];
    splitRange(row, 0, row.length, rowLimit, [wordRanges], 0, ranges);
    ranges.forEach(([start, end], i) => {
      units.push({
        text: row.slice(start, end),
        path,
        isHeading: false,
        sep: units.length === 0 ? BLOCK_SEP : i === 0 ? "\n" : separator(row.slice(ranges[i - 1]![1], start), false),
        lead,
      });
    });
  }
  return units;
}

/** Splits [start, end) into ranges of at most `limit` characters, trying each splitter in turn. */
function splitRange(text: string, start: number, end: number, limit: number, splitters: Splitter[], depth: number, out: Range[]): void {
  if (end - start <= limit) {
    out.push([start, end]);
    return;
  }
  const splitter = splitters[depth];
  if (!splitter) {
    hardSplit(text, start, end, limit, out);
    return;
  }
  for (const [s, e] of splitter(text, start, end)) splitRange(text, s, e, limit, splitters, depth + 1, out);
}

/** Last resort for text without usable boundaries: small pieces, so the packer can fill chunks with them. */
function hardSplit(text: string, start: number, end: number, limit: number, out: Range[]): void {
  const size = Math.max(1, Math.ceil(limit / 8));
  let pos = start;
  while (pos < end) {
    const cut = end - pos <= size ? end : Math.min(end, safeCutIndex(text, pos + size, pos));
    out.push([pos, cut]);
    pos = cut;
  }
}

let sentenceSegmenter: Intl.Segmenter | null | undefined;

function sentenceRanges(text: string, start: number, end: number): Range[] {
  if (sentenceSegmenter === undefined) {
    try {
      sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    } catch {
      sentenceSegmenter = null;
    }
  }
  // Line breaks inside a paragraph are mostly soft wraps: hide them so they do not end sentences.
  const slice = text.slice(start, end).replace(/\n/g, " ");
  const bounds: number[] = [];
  if (sentenceSegmenter) {
    for (const segment of sentenceSegmenter.segment(slice)) bounds.push(segment.index);
  } else {
    bounds.push(0);
    for (const match of slice.matchAll(/[.!?…。！？]+["'”’)\]]*\s+/g)) bounds.push(match.index + match[0].length);
  }
  bounds.push(slice.length);
  const out: Range[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const range = trimRange(text, start + bounds[i]!, start + bounds[i + 1]!, true);
    if (range) out.push(range);
  }
  return out;
}

function wordRanges(text: string, start: number, end: number): Range[] {
  const out: Range[] = [];
  for (const match of text.slice(start, end).matchAll(/\S+/g)) {
    out.push([start + match.index, start + match.index + match[0].length]);
  }
  return out;
}

/** One range per line, keeping indentation. */
function lineRanges(text: string, start: number, end: number): Range[] {
  const out: Range[] = [];
  for (let pos = start; pos < end; ) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const range = trimRange(text, pos, lineEnd, false);
    if (range) out.push(range);
    pos = lineEnd + 1;
  }
  return out;
}

/** One range per list item (an item line plus its continuation lines), keeping indentation. */
function listItemRanges(text: string, start: number, end: number): Range[] {
  const out: Range[] = [];
  let itemStart = start;
  for (let pos = start; pos < end; ) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    if (pos > itemStart && LIST_ITEM.test(text.slice(pos, lineEnd))) {
      const range = trimRange(text, itemStart, pos, false);
      if (range) out.push(range);
      itemStart = pos;
    }
    pos = lineEnd + 1;
  }
  const last = trimRange(text, itemStart, end, false);
  if (last) out.push(last);
  return out;
}

function trimRange(text: string, start: number, end: number, trimStart: boolean): Range | null {
  let s = start;
  let e = end;
  if (trimStart) while (s < e && isSpace(text.charCodeAt(s))) s++;
  else while (s < e && text.charCodeAt(s) === 10) s++;
  while (e > s && isSpace(text.charCodeAt(e - 1))) e--;
  return e > s ? [s, e] : null;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10;
}

/** Normalised whitespace between two units of the same block. */
function separator(gap: string, keepBlankLines: boolean): string {
  if (gap === "") return "";
  if (!gap.includes("\n")) return " ";
  return keepBlankLines && gap.indexOf("\n") !== gap.lastIndexOf("\n") ? "\n\n" : "\n";
}

// ---------------------------------------------------------------------------
// Packing

interface Draft {
  units: Unit[];
  bodyUnits: number;
  /** Rendered length of `units`. */
  length: number;
  prefix: string;
  overlap: string;
  /** Characters available for `units` once prefix and overlap are accounted for. */
  budget: number;
}

function pack(units: Unit[], config: Config): Chunk[] {
  const chunks: Chunk[] = [];
  let draft: Draft | null = null;
  /** Text of the last section of the previous chunk: the source of the next overlap. */
  let tail = "";

  const unitLength = (unit: Unit, opening: boolean) =>
    opening ? unit.text.length + (unit.lead ? unit.lead.length + 1 : 0) : unit.sep.length + unit.text.length;

  const open = (first: Unit): Draft => {
    const nearest = first.isHeading ? undefined : first.path[first.path.length - 1];
    let prefix = nearest ? headingLine(nearest) : "";
    if (prefix.length > config.prefixCap) prefix = "";
    let overlap = !first.isHeading && !first.lead && chunks.length > 0 ? overlapTail(tail, config.overlap) : "";
    const reserved = () => (prefix ? prefix.length + BLOCK_SEP.length : 0) + (overlap ? overlap.length + first.sep.length : 0);
    const needed = unitLength(first, true);
    if (reserved() + needed > config.maxChars) overlap = "";
    if (reserved() + needed > config.maxChars) prefix = "";
    return { units: [], bodyUnits: 0, length: 0, prefix, overlap, budget: config.maxChars - reserved() };
  };

  const add = (target: Draft, unit: Unit) => {
    target.length += unitLength(unit, target.units.length === 0);
    target.units.push(unit);
    if (!unit.isHeading) target.bodyUnits++;
  };

  const emit = (done: Draft) => {
    let content = render(done.units, true);
    if (done.overlap) content = `${done.overlap}${done.units[0]!.sep}${content}`;
    if (done.prefix) content = `${done.prefix}${BLOCK_SEP}${content}`;
    content = content.trim();
    if (!content) return;
    const anchor = done.units.find((unit) => !unit.isHeading) ?? done.units[done.units.length - 1]!;
    chunks.push({ ordinal: chunks.length, content, metadata: headingMetadata(anchor.path) });
    tail = render(done.units.slice(done.units.findLastIndex((unit) => unit.isHeading) + 1), false);
  };

  /** Emits the draft; returns trailing headings that must open the next chunk instead. */
  const flush = (final: boolean): Unit[] => {
    const done = draft;
    draft = null;
    if (!done || done.units.length === 0) return [];
    const carried: Unit[] = [];
    if (!final && done.bodyUnits > 0) {
      while (done.units[done.units.length - 1]?.isHeading) carried.unshift(done.units.pop()!);
    }
    const last = chunks[chunks.length - 1];
    if (final && done.bodyUnits === 0 && last) {
      // Headings with nothing after them at the very end: keep them with the previous chunk when possible.
      const merged = `${last.content}${BLOCK_SEP}${render(done.units, false)}`;
      if (merged.length <= config.maxChars) {
        last.content = merged;
        return [];
      }
    }
    emit(done);
    return carried;
  };

  const pending = units.slice().reverse();
  while (pending.length > 0) {
    const unit = pending.pop()!;
    if (!draft) {
      draft = open(unit);
      add(draft, unit);
      continue;
    }
    const current: Draft = draft;
    const size = config.maxChars - current.budget + current.length;
    const sectionBreak = unit.isHeading && current.bodyUnits > 0 && size >= config.sectionBreak;
    if (!sectionBreak && current.length + unitLength(unit, false) <= current.budget) {
      add(current, unit);
      continue;
    }
    const carried = flush(false);
    pending.push(unit);
    for (let i = carried.length - 1; i >= 0; i--) pending.push(carried[i]!);
  }
  flush(true);
  return chunks;
}

function render(units: Unit[], withLead: boolean): string {
  return units
    .map((unit, i) => (i > 0 ? unit.sep + unit.text : withLead && unit.lead ? `${unit.lead}\n${unit.text}` : unit.text))
    .join("");
}

function headingMetadata(path: Heading[]): Record<string, unknown> {
  const nearest = path[path.length - 1];
  return nearest ? { heading: nearest.text, headingPath: path.map((h) => h.text) } : {};
}

/** The last `size` characters of `text`, starting at a sentence or word boundary when possible. */
function overlapTail(text: string, size: number): string {
  if (size <= 0 || !text) return "";
  if (text.length <= size) return text.trim();
  const from = text.length - size;
  const window = text.slice(from);
  let offset = 0;
  const sentenceEnd = /[.!?…。！？]["'”’)\]]*\s+/.exec(window);
  if (sentenceEnd && sentenceEnd.index + sentenceEnd[0].length <= (window.length * 2) / 3) {
    offset = sentenceEnd.index + sentenceEnd[0].length;
  } else if (!/\s/.test(text.charAt(from - 1))) {
    const space = window.search(/\s/);
    if (space !== -1 && space < window.length / 2) offset = space + 1;
  }
  return text.slice(safeStartIndex(text, from + offset)).trim();
}
