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

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
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
