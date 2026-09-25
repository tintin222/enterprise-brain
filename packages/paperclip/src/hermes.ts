/**
 * Paperclip's `hermes_gateway` adapter contract (packages/adapters/hermes in
 * the Paperclip repo). Enterprise Brain implements the gateway side so a
 * Paperclip heartbeat can run an Enterprise Brain agent synchronously:
 *
 *   POST /v1/runs              {…payloadTemplate, input, instructions, session_id?} → { run_id }
 *   GET  /v1/runs/{id}/events  SSE: message.delta {delta}, run.<status> {status, output, usage, cost_usd}
 *   GET  /v1/runs/{id}         { status, output, usage, cost_usd, model, session_id }
 *   POST /v1/runs/{id}/stop
 *   GET  /health
 *
 * Headers: Authorization: Bearer <apiKey>, Idempotency-Key: <paperclip run id>,
 * X-Hermes-Session-Key: paperclip:company:<c>:agent:<a>[:issue:<i>|:run:<r>].
 */

export interface HermesRunRequest {
  /** Enterprise Brain agent slug (from payloadTemplate.agent). */
  agent: string;
  /** Enterprise Brain company slug (from payloadTemplate.company). */
  company?: string;
  /** The rendered Paperclip wake prompt (task brief). */
  input: string;
  instructions?: string;
  sessionKey?: string;
  idempotencyKey?: string;
  paperclip: { companyId?: string; agentId?: string; issueId?: string; runId?: string };
  extra: Record<string, unknown>;
}

export class HermesRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "HermesRequestError";
  }
}

export function parseSessionKey(key: string | undefined): HermesRunRequest["paperclip"] {
  if (!key) return {};
  const match = key.match(/^paperclip:company:([^:]+):agent:([^:]+)(?::issue:([^:]+)|:run:([^:]+))?$/);
  if (match) return { companyId: match[1], agentId: match[2], issueId: match[3], runId: match[4] };
  const run = key.match(/^paperclip:run:([^:]+)$/);
  return run ? { runId: run[1] } : {};
}

export function parseHermesRunRequest(body: unknown, headers: Record<string, string | string[] | undefined>): HermesRunRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HermesRequestError("Body must be a JSON object");
  const record = body as Record<string, unknown>;
  const agent = typeof record.agent === "string" ? record.agent.trim() : "";
  if (!agent) throw new HermesRequestError('Missing "agent": set payloadTemplate.agent to the Enterprise Brain agent slug in the adapter config');
  const input = typeof record.input === "string" ? record.input : "";
  if (!input.trim()) throw new HermesRequestError('Missing "input"');
  const header = (name: string) => {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const sessionKey = (typeof record.session_id === "string" ? record.session_id : undefined) ?? header("x-hermes-session-key");
  const { agent: _a, company, input: _i, instructions, session_id: _s, ...extra } = record;
  void _a;
  void _i;
  void _s;
  return {
    agent,
    company: typeof company === "string" ? company : undefined,
    input,
    instructions: typeof instructions === "string" ? instructions : undefined,
    sessionKey,
    idempotencyKey: header("idempotency-key"),
    paperclip: parseSessionKey(sessionKey),
    extra,
  };
}

export type HermesStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface EbRunSnapshot {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  error: string | null;
  usage: Record<string, unknown>;
  pendingApproval?: { id: string; title: string } | null;
  /** Where people approve (Enterprise Brain's approvals page), linked from the waiting note. */
  approvalsUrl?: string;
  model?: string;
}

/** Map an Enterprise Brain run to Hermes status. A run waiting for approval completes the Paperclip run with a note. */
export function toHermesStatus(run: EbRunSnapshot): HermesStatus {
  switch (run.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
    case "waiting_approval":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export function hermesOutput(run: EbRunSnapshot): string {
  if (run.status === "failed") return run.error ?? "The Enterprise Brain run failed.";
  if (run.status === "waiting_approval") {
    return `Waiting for human approval in Enterprise Brain${run.pendingApproval ? `: "${run.pendingApproval.title}"` : ""}. ${run.approvalsUrl ? `Approve or reject it at ${run.approvalsUrl}; ` : ""}the work continues automatically once it is approved.`;
  }
  const output = run.output ?? {};
  const text = [output.text, output.result, output.summary, output.answer].find((v) => typeof v === "string" && v.trim());
  if (typeof text === "string") return text;
  return Object.keys(output).length ? `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`` : "Done.";
}

export function hermesRunBody(run: EbRunSnapshot, sessionKey?: string) {
  const usage = run.usage ?? {};
  return {
    run_id: run.id,
    status: toHermesStatus(run),
    output: toHermesStatus(run) === "running" || toHermesStatus(run) === "queued" ? null : hermesOutput(run),
    usage: {
      input_tokens: Number(usage.inputTokens ?? 0),
      output_tokens: Number(usage.outputTokens ?? 0),
      cached_input_tokens: Number(usage.cacheReadTokens ?? 0),
    },
    cost_usd: Number(usage.costUsd ?? 0),
    model: run.model ?? null,
    session_id: sessionKey ?? null,
  };
}

/** Format one SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Keep Paperclip wake prompts from being read as workflow templates. */
export function escapeTemplateBraces(text: string): string {
  return text.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
}
