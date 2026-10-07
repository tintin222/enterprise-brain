import { clsx } from "clsx";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { MENTION_LINK, mentionsToMarkdown } from "../lib/mentions.ts";
import type { MentionKind, MessageMention } from "../types.ts";
import { MentionChip } from "./chat/MentionChip.tsx";

const components: Components = {
  a({ href, children, node: _node, ...rest }) {
    void _node;
    if (href?.startsWith(MENTION_LINK)) {
      // A mention of a person, an AI employee or an asset: a chip that opens it.
      const params = new URLSearchParams(href.slice(MENTION_LINK.length));
      return (
        <MentionChip kind={(params.get("kind") ?? "thing") as MentionKind} href={params.get("href")} className="mention">
          {children}
        </MentionChip>
      );
    }
    if (href && href.startsWith("/") && !href.startsWith("/api/") && !href.startsWith("//")) {
      return <Link to={href}>{children}</Link>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  table({ children, node: _node, ...rest }) {
    void _node;
    return <table {...rest}>{children}</table>;
  },
};

/**
 * A line that is only bold text ("**Users & stakeholders**") right after a list
 * item would be swallowed into that item (lazy continuation); give it its own paragraph.
 */
function normalize(text: string): string {
  return (
    text
      .replace(/(^|\n)(\s*(?:[-*+]|\d+[.)])\s[^\n]*)\n(\*\*[^*\n]+\*\*:?\s*)(?=\n|$)/g, "$1$2\n\n$3")
      // A "heading" longer than a paragraph line is flattened text (e.g. a quoted passage), not a heading.
      .replace(/^#{1,6}\s+(.{140,})$/gm, "$1")
  );
}

/** Keep single line breaks (plain text written with newlines) as hard breaks. */
function hardBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, "$1  \n");
}

/**
 * Markdown with GitHub-flavoured extensions (tables, task lists, strikethrough) and styled prose.
 * Mention tokens (`@[Name](kind:id)`) are drawn as chips; `mentions` says what each one links to.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  compact,
  breaks,
  mentions,
}: {
  children: string;
  className?: string;
  compact?: boolean;
  breaks?: boolean;
  mentions?: MessageMention[];
}) {
  const text = normalize(mentionsToMarkdown(children, mentions));
  return (
    <div className={clsx("md", compact && "md-compact", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {breaks ? hardBreaks(text) : text}
      </ReactMarkdown>
    </div>
  );
});
