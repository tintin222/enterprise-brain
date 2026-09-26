/** A small, lenient RFC 4180 CSV/TSV parser with delimiter sniffing. */

/** In tie-break order: tabs and semicolons rarely occur inside values, commas often do. */
const CANDIDATE_DELIMITERS = ["\t", ";", ",", "|"] as const;

/**
 * Parse delimited text into rows of raw string cells. Handles quoted fields,
 * escaped quotes (""), delimiters and line breaks inside quotes, CRLF/LF/CR line
 * endings (normalized to LF), and skips blank lines. Malformed input never throws: a stray quote
 * inside an unquoted field is literal and an unterminated quote runs to the end.
 * The delimiter is sniffed when omitted. With `keepBlankLines`, blank lines stay (as [""]), so each
 * row's index is its line in the file.
 */
export function parseCsv(input: string, delimiter: string = sniffCsvDelimiter(input), options: { keepBlankLines?: boolean } = {}): string[][] {
  // Line breaks inside quoted values are normalized too.
  const text = input.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false;

  const endField = () => {
    row.push(quoted ? field : field.trim() === "" ? "" : field);
    field = "";
    quoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "" || options.keepBlankLines) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
      continue;
    }
    if (ch === '"' && !quoted && field.trim() === "") {
      // Opening quote (leading spaces before it are ignored).
      inQuotes = true;
      quoted = true;
      field = "";
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || quoted || row.length > 0) endRow();
  return rows;
}

/**
 * Pick the delimiter (",", ";", tab or "|") that splits the first rows into the
 * most consistent number of columns (then more columns, then tab > ";" > ","
 * > "|"). Parsing the sample with each candidate keeps quoted delimiters from
 * skewing the counts. Defaults to a comma.
 */
export function sniffCsvDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const truncated = sample.length < text.length;
  let best = ",";
  let bestScore = 0;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const rows = parseCsv(sample, delimiter).slice(0, 50);
    if (truncated && rows.length > 1) rows.pop();
    if (rows.length === 0) continue;
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    const [width, frequency] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (width < 2) continue;
    const score = (frequency / rows.length) * 100 + Math.min(width, 50);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}
