import { describeSummary, linkLines, type BrainService } from "@enterprise-brain/brain";
import { truncate, type AgentDefinition } from "@enterprise-brain/core";
import type { KnowledgeService } from "@enterprise-brain/knowledge";

/**
 * What an AI employee says without a model: the closest things in the company brain (with what the
 * best match links to) and the most relevant passages of the knowledge base, for the abilities it has.
 * Nothing is written up, but a person still finds what they were after.
 */
export async function offlineAnswer(
  deps: { knowledge: KnowledgeService; brain?: BrainService },
  companyId: string,
  definition: Pick<AgentDefinition, "tools" | "knowledge">,
  question: string,
): Promise<{ text: string; found: boolean }> {
  const query = question.replace(/\s+/g, " ").trim().slice(0, 500);
  const hits = definition.tools.includes("knowledge.search")
    ? await deps.knowledge.search(companyId, query, {
        collections: definition.knowledge.collections.length ? definition.knowledge.collections : undefined,
        topK: 3,
      })
    : [];
  const brainService = definition.tools.includes("company.lookup") ? deps.brain : undefined;
  const things = brainService ? await brainService.search(companyId, query, { limit: 5 }) : [];
  // The best match with what it links to: who knows it, who does it, who owns it.
  const top = things[0] && brainService ? await brainService.get(companyId, things[0].id) : undefined;
  const brain = things.length
    ? [
        "_From the company brain:_",
        "",
        // A Markdown line break keeps each summary under its name.
        ...things.map((t) => describeSummary(t).replace("\n  ", "  \n  ")),
        ...(top?.links.length ? ["", `_About ${top.name}:_`, "", ...linkLines(top).map((line) => `- ${line}`)] : []),
      ].join("\n")
    : "";
  const passages = hits.length
    ? [
        "_The most relevant passages from the knowledge base:_",
        "",
        // Quoted as plain text: a passage's own headings would otherwise render as headings.
        ...hits.map(
          (h, i) =>
            `**[${i + 1}] ${h.title}**\n> ${truncate(
              h.content
                .replace(/^\s{0,3}#{1,6}\s+/gm, "")
                .replace(/\s+/g, " ")
                .trim(),
              500,
            )}`,
        ),
      ].join("\n\n")
    : "";
  const found = Boolean(brain || passages);
  if (!definition.tools.includes("knowledge.search") && !brainService) {
    return { text: "Offline mode: this needs an LLM (set ANTHROPIC_API_KEY).", found: false };
  }
  return {
    text: found
      ? ["_Offline mode (no LLM configured): I can't write an answer, but this is what I found._", brain, passages].filter(Boolean).join("\n\n")
      : "_Offline mode (no LLM configured)._ I could not find anything relevant in the company brain or the knowledge base.",
    found,
  };
}
