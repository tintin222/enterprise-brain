/** Minimal Paperclip REST client for pushing company packages and checking the instance. */
export interface PaperclipImportOptions {
  files: Record<string, string>;
  rootPath: string;
  target: { mode: "new_company" } | { mode: "existing_company"; companyId: string };
  include?: { company?: boolean; agents?: boolean; projects?: boolean; issues?: boolean; skills?: boolean };
  collisionStrategy?: "rename" | "skip" | "replace";
  /** Per agent slug: adapter type + config (e.g. the hermes_gateway apiKey), applied at import. */
  adapterOverrides?: Record<string, { adapterType: string; adapterConfig?: Record<string, unknown> }>;
  pauseAutomations?: boolean;
}

export interface PaperclipIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  status: string;
  assigneeAgentId?: string | null;
}

export interface PaperclipComment {
  id: string;
  body?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: string;
}

export class PaperclipApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

export class PaperclipClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async request(path: string, init: RequestInit = {}, as?: { token: string; runId?: string }): Promise<unknown> {
    const token = as?.token ?? this.token;
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // Paperclip attributes agent writes to the heartbeat run they happen in.
        ...(as?.runId ? { "x-paperclip-run-id": as.runId } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
      throw new PaperclipApiError(`Paperclip ${init.method ?? "GET"} ${path} failed: ${message}`, response.status, body);
    }
    return body;
  }

  health() {
    return this.request("/api/health");
  }

  companies() {
    return this.request("/api/companies");
  }

  /** Board-level import (runs as a background job in Paperclip). */
  importCompany(options: PaperclipImportOptions) {
    return this.request("/api/companies/import", {
      method: "POST",
      body: JSON.stringify({
        source: { type: "inline", rootPath: options.rootPath, files: options.files },
        target: options.target,
        include: options.include ?? { company: options.target.mode === "new_company", agents: true, projects: true, issues: true, skills: true },
        agents: "all",
        collisionStrategy: options.collisionStrategy ?? "rename",
        ...(options.adapterOverrides ? { adapterOverrides: options.adapterOverrides } : {}),
        ...(options.pauseAutomations !== undefined ? { pauseAutomations: options.pauseAutomations } : {}),
      }),
    });
  }

  /** Board: create an API key an agent uses to act in Paperclip (returned once, as `token`). */
  async createAgentKey(agentId: string, name: string): Promise<{ id: string; token: string }> {
    const body = (await this.request(`/api/agents/${encodeURIComponent(agentId)}/keys`, { method: "POST", body: JSON.stringify({ name }) })) as { id?: string; token?: string };
    if (!body?.token) throw new PaperclipApiError("Paperclip did not return an agent key", 500, body);
    return { id: String(body.id ?? ""), token: body.token };
  }

  getIssue(issueId: string, as?: { token: string }): Promise<PaperclipIssue> {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {}, as) as Promise<PaperclipIssue>;
  }

  async issueComments(issueId: string, as?: { token: string }): Promise<PaperclipComment[]> {
    const body = (await this.request(`/api/issues/${encodeURIComponent(issueId)}/comments`, {}, as)) as PaperclipComment[] | { comments?: PaperclipComment[] };
    return Array.isArray(body) ? body : (body?.comments ?? []);
  }

  /**
   * Update an issue (status and/or comment). With `as`, the update is made by an agent
   * (its API key and current heartbeat run); without it, with the board credentials.
   */
  updateIssue(issueId: string, patch: { status?: string; comment?: string }, as?: { token: string; runId?: string }) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, { method: "PATCH", body: JSON.stringify(patch) }, as);
  }

  previewImport(options: Omit<PaperclipImportOptions, "adapterOverrides" | "pauseAutomations">) {
    return this.request("/api/companies/import/preview", {
      method: "POST",
      body: JSON.stringify({
        source: { type: "inline", rootPath: options.rootPath, files: options.files },
        target: options.target,
        include: options.include ?? { company: options.target.mode === "new_company", agents: true, projects: true, issues: true, skills: true },
        agents: "all",
        collisionStrategy: options.collisionStrategy ?? "rename",
      }),
    });
  }
}
