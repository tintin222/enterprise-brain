import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { EnterpriseBrainClient } from "./eb-client.ts";
import { TOOL_NAMES } from "./manifest.ts";

interface BridgeConfig {
  enterpriseBrainUrl?: string;
  company?: string;
  apiKeyRef?: Parameters<PluginContext["secrets"]["resolve"]>[0];
}

type ClientFactory = (baseUrl: string, company: string, apiKey?: string) => EnterpriseBrainClient;

let clientFactory: ClientFactory = (baseUrl, company, apiKey) => new EnterpriseBrainClient(baseUrl, company, apiKey);

/** Test seam: swap the HTTP client. */
export function setClientFactory(factory: ClientFactory): void {
  clientFactory = factory;
}

async function clientFor(ctx: PluginContext, companyId: string): Promise<EnterpriseBrainClient> {
  const config = (await ctx.config.get(companyId)) as BridgeConfig;
  if (!config.enterpriseBrainUrl) throw new Error("Set the Enterprise Brain URL in the plugin settings for this company.");
  // Resolved per call and never stored, as the SDK requires for secrets.
  const apiKey = config.apiKeyRef ? await ctx.secrets.resolve(config.apiKeyRef, { companyId, configPath: "apiKeyRef" }) : undefined;
  return clientFactory(config.enterpriseBrainUrl, config.company || "acme", apiKey);
}

function fail(error: unknown): ToolResult {
  return { error: error instanceof Error ? error.message : String(error) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    ctx.tools.register(
      TOOL_NAMES.knowledgeSearch,
      {
        displayName: "Search company knowledge",
        description: "Search the company knowledge base in Enterprise Brain.",
        parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      async (params, runCtx) => {
        try {
          const p = asRecord(params);
          const { hits } = await (await clientFor(ctx, runCtx.companyId)).searchKnowledge(String(p.query ?? ""), p.collections as string[] | undefined);
          if (!hits.length) return { content: "No matching knowledge found." };
          return {
            content: hits.map((h, i) => `[${i + 1}] ${h.title} (${h.collectionKey})\n${h.content}`).join("\n\n"),
            data: { hits },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listAgents,
      { displayName: "List Enterprise Brain agents", description: "List specialist agents.", parametersSchema: { type: "object", properties: {} } },
      async (_params, runCtx) => {
        try {
          const agents = await (await clientFor(ctx, runCtx.companyId)).listAgents();
          const active = agents.filter((a) => a.status === "active");
          return {
            content: active.map((a) => `- ${a.slug}: ${a.name} — ${a.summary}`).join("\n") || "No active agents.",
            data: { agents: active },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );

    ctx.tools.register(
      TOOL_NAMES.runAgent,
      {
        displayName: "Run an Enterprise Brain agent",
        description: "Run a specialist agent with a task.",
        parametersSchema: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" }, input: { type: "object" } }, required: ["agent"] },
      },
      async (params, runCtx) => {
        try {
          const p = asRecord(params);
          const run = await (await clientFor(ctx, runCtx.companyId)).runAgent(String(p.agent), asRecord(p.input), p.task ? String(p.task) : undefined);
          const summary =
            run.status === "waiting_approval"
              ? "The agent is waiting for a human approval in Enterprise Brain; it will continue once approved."
              : run.status === "failed"
                ? `The run failed: ${run.error ?? "unknown error"}`
                : JSON.stringify(run.output ?? {}, null, 2);
          return { content: `Run ${run.id} — ${run.status}\n${summary}`, data: run };
        } catch (error) {
          return fail(error);
        }
      },
    );

    ctx.tools.register(
      TOOL_NAMES.getRun,
      { displayName: "Get an Enterprise Brain run", description: "Run status and output.", parametersSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } },
      async (params, runCtx) => {
        try {
          const detail = await (await clientFor(ctx, runCtx.companyId)).getRun(String(asRecord(params).runId));
          return { content: `Status: ${detail.run.status}\n${JSON.stringify(detail.run.output ?? detail.run.error, null, 2)}`, data: detail };
        } catch (error) {
          return fail(error);
        }
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listApprovals,
      { displayName: "List pending approvals", description: "Actions waiting for a human decision.", parametersSchema: { type: "object", properties: {} } },
      async (_params, runCtx) => {
        try {
          const approvals = await (await clientFor(ctx, runCtx.companyId)).pendingApprovals();
          return {
            content: approvals.length ? approvals.map((a) => `- ${a.title} (${a.agentName})`).join("\n") : "Nothing is waiting for approval.",
            data: { approvals },
          };
        } catch (error) {
          return fail(error);
        }
      },
    );

    // UI data: where the console lives (no secrets), and a small summary for the dashboard widget.
    ctx.data.register("config", async (params) => {
      const companyId = String(params.companyId ?? "");
      const config = (await ctx.config.get(companyId || undefined)) as BridgeConfig;
      return { url: config.enterpriseBrainUrl ?? null, company: config.company || "acme" };
    });

    ctx.data.register("summary", async (params) => {
      const companyId = String(params.companyId ?? "");
      try {
        const dashboard = await (await clientFor(ctx, companyId)).dashboard();
        return { ok: true, counts: dashboard.counts, costMonthUsd: dashboard.costMonthUsd };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ctx.logger.info("Enterprise Brain bridge ready");
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const url = (config as BridgeConfig).enterpriseBrainUrl;
    if (!url) errors.push("enterpriseBrainUrl is required");
    else if (!/^https?:\/\//.test(url)) errors.push("enterpriseBrainUrl must start with http:// or https://");
    return { ok: errors.length === 0, errors, warnings: [] };
  },

  async onHealth() {
    return { status: "ok", message: "Enterprise Brain bridge ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
