/** Minimal client for the Enterprise Brain REST API used by the plugin worker. */
export class EnterpriseBrainClient {
  constructor(
    private readonly baseUrl: string,
    private readonly company: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Native fetch on purpose: Enterprise Brain usually runs on the private network,
    // which the host's ctx.http.fetch refuses to reach.
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/companies/${encodeURIComponent(this.company)}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(55_000),
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
      throw new Error(`Enterprise Brain: ${message}`);
    }
    return body as T;
  }

  searchKnowledge(query: string, collections?: string[]) {
    return this.request<{ hits: { title: string; collectionKey: string; content: string; score: number }[] }>("/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query, collections, topK: 6 }),
    });
  }

  listAgents() {
    return this.request<{ slug: string; name: string; status: string; summary: string; archetype: string }[]>("/agents");
  }

  runAgent(agent: string, input: Record<string, unknown>, task?: string) {
    return this.request<{ id: string; status: string; output: Record<string, unknown> | null; error: string | null }>(
      `/agents/${encodeURIComponent(agent)}/runs`,
      { method: "POST", body: JSON.stringify({ input, task, wait: true, trigger: "paperclip-plugin" }) },
    );
  }

  getRun(runId: string) {
    return this.request<{ run: { id: string; status: string; output: unknown; error: string | null }; events: { type: string; message: string }[] }>(
      `/runs/${encodeURIComponent(runId)}`,
    );
  }

  pendingApprovals() {
    return this.request<{ id: string; title: string; agentName: string; createdAt: string }[]>("/approvals?status=pending");
  }

  dashboard() {
    return this.request<{ counts: Record<string, number>; costMonthUsd: number }>("/dashboard");
  }
}
