import { markdownWithFrontmatter } from "./yaml.ts";

/** The skill that teaches Paperclip agents how to use Enterprise Brain. */
export function enterpriseBrainSkill(options: { url: string; companySlug: string }): string {
  const base = options.url.replace(/\/$/, "");
  return markdownWithFrontmatter(
    {
      name: "enterprise-brain",
      description:
        "Use Enterprise Brain for company knowledge, enterprise systems (ERP, CRM, HR, ITSM, mail) and specialist agents: search policies, look up records, run a specialist and check approvals.",
    },
    [
      "# Enterprise Brain",
      "",
      `Enterprise Brain (${base}) is this company's enterprise layer: the knowledge base, connectors to business systems and the specialist agents built with the business teams.`,
      "",
      "## Tools (MCP)",
      "",
      `Connect \`${base}/mcp\` as a remote MCP server (Streamable HTTP, bearer token = your Enterprise Brain API key). Tools:`,
      "",
      "- `knowledge_search` — search the company knowledge base; cite sources as [n].",
      "- `list_agents` / `run_agent` / `get_run` — run a specialist agent (e.g. the CV screener or invoice processor) with structured input and read the result.",
      "- `<system>__<operation>` — read operations on connected business systems (writes are approval-gated).",
      "- `list_approvals` — see actions waiting for a human decision.",
      "",
      "## REST (when MCP is not available)",
      "",
      "```http",
      `POST ${base}/api/companies/${options.companySlug}/knowledge/search   {"query": "..."}`,
      `POST ${base}/api/companies/${options.companySlug}/agents/<slug>/runs {"input": {...}}`,
      `GET  ${base}/api/companies/${options.companySlug}/runs/<runId>`,
      "```",
      "",
      "Send `Authorization: Bearer $ENTERPRISE_BRAIN_API_KEY`.",
      "",
      "## Rules",
      "",
      "- Prefer Enterprise Brain's knowledge over assumptions; say when something is not documented.",
      "- Never try to bypass an approval gate: if an action is pending approval, report it on the task and move on.",
      "- Do not copy personal data into task comments beyond what the task needs.",
    ].join("\n"),
  );
}
