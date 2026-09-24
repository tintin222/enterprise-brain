/** A Markdown document split into its YAML frontmatter and body. */
export interface FrontmatterDocument {
  /** Raw YAML between the opening and closing `---` lines. */
  frontmatter: string;
  /** Markdown after the closing `---` line, trimmed. */
  body: string;
  /** 1-based line number of the first frontmatter line (for error positions). */
  frontmatterLine: number;
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/**
 * Split a Markdown file on its leading `---` lines:
 *
 *     ---
 *     id: hr.cv-screener
 *     ...
 *     ---
 *     # Instructions (Markdown body)
 */
export function splitFrontmatter(source: string): FrontmatterDocument {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new FrontmatterError("missing YAML frontmatter: the file must start with a '---' line");
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new FrontmatterError("unterminated YAML frontmatter: no closing '---' line");
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n").trim(),
    frontmatterLine: 2,
  };
}
