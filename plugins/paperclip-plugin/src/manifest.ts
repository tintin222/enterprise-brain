import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "enterprise-brain";
export const PAGE_ROUTE = "enterprise-brain";

export const TOOL_NAMES = {
  knowledgeSearch: "knowledge_search",
  listAgents: "list_agents",
  runAgent: "run_agent",
  getRun: "get_run",
  listApprovals: "list_approvals",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Enterprise Brain",
  description:
    "Brings Enterprise Brain into Paperclip: company knowledge search, specialist agents (CV screening, invoice processing, mail triage…) and approvals as agent tools, plus the Agent Builder and catalog inside Paperclip.",
  author: "Enterprise Brain",
  categories: ["connector", "ui"],
  capabilities: ["http.outbound", "secrets.read-ref", "agent.tools.register", "ui.page.register", "ui.sidebar.register", "ui.dashboardWidget.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enterpriseBrainUrl: {
        type: "string",
        title: "Enterprise Brain URL",
        description: "Base URL of your Enterprise Brain server, e.g. https://brain.acme.com",
      },
      company: {
        type: "string",
        title: "Enterprise Brain company",
        description: "Company slug in Enterprise Brain (default: acme)",
        default: "acme",
      },
      apiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Enterprise Brain API key",
        description: "Secret holding EB_API_KEY (leave empty when Enterprise Brain runs in local trusted mode)",
      },
    },
    required: ["enterpriseBrainUrl"],
  },
  tools: [
    {
      name: TOOL_NAMES.knowledgeSearch,
      displayName: "Search company knowledge",
      description: "Search the company knowledge base in Enterprise Brain (policies, procedures, product documentation). Cite results as [n].",
      parametersSchema: {
        type: "object",
        properties: { query: { type: "string" }, collections: { type: "array", items: { type: "string" } } },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.listAgents,
      displayName: "List Enterprise Brain agents",
      description: "List the specialist agents available in Enterprise Brain with their inputs.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: TOOL_NAMES.runAgent,
      displayName: "Run an Enterprise Brain agent",
      description:
        "Run a specialist agent in Enterprise Brain with a free-form task (and optional structured input). Returns its output; actions that change business systems wait for human approval.",
      parametersSchema: {
        type: "object",
        properties: { agent: { type: "string", description: "Agent slug from list_agents" }, task: { type: "string" }, input: { type: "object" } },
        required: ["agent"],
      },
    },
    {
      name: TOOL_NAMES.getRun,
      displayName: "Get an Enterprise Brain run",
      description: "Status and output of an Enterprise Brain agent run.",
      parametersSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    },
    {
      name: TOOL_NAMES.listApprovals,
      displayName: "List pending approvals",
      description: "Actions in Enterprise Brain waiting for a human decision.",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "enterprise-brain-page", displayName: "Enterprise Brain", exportName: "EnterpriseBrainPage", routePath: PAGE_ROUTE },
      { type: "sidebar", id: "enterprise-brain-sidebar", displayName: "Enterprise Brain", exportName: "EnterpriseBrainSidebarLink" },
      { type: "dashboardWidget", id: "enterprise-brain-widget", displayName: "Enterprise Brain", exportName: "EnterpriseBrainWidget" },
    ],
  },
};

export default manifest;
