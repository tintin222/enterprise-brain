import type { ConnectorManifest } from "@enterprise-brain/core";

/**
 * Connector SDK contract. A connector is a manifest (what it is, how to
 * configure it, which operations it offers) plus an implementation.
 *
 * Operations are exposed to agents as tools (named `<ref>__<operationId>`) and
 * to workflows as `connector` steps. `write` operations are approval-gated by
 * the runtime unless an agent's guardrails say otherwise.
 */

export interface SandboxStore {
  list(system: string, entity: string): Promise<Record<string, unknown>[]>;
  get(system: string, entity: string, id: string): Promise<Record<string, unknown> | undefined>;
  upsert(system: string, entity: string, id: string, data: Record<string, unknown>): Promise<void>;
  /** Number of records of a system (used to seed demo data once). */
  count(system: string): Promise<number>;
}

export interface ConnectorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ConnectorContext {
  companyId: string;
  /** Non-secret configuration values (keys from manifest.config where secret=false). */
  config: Record<string, unknown>;
  /** Decrypted secret values (keys from manifest.config where secret=true). */
  secrets: Record<string, string>;
  /** Injected for testability; defaults to global fetch. */
  fetch: typeof fetch;
  logger: ConnectorLogger;
  /** Persistent store backing the built-in sandbox systems. */
  sandbox: SandboxStore;
}

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConnectorEvent {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface ConnectorImplementation {
  manifest: ConnectorManifest;
  /** Verify credentials/connectivity (the "Test connection" button). */
  test(ctx: ConnectorContext): Promise<ConnectorTestResult>;
  /** Execute an operation declared in manifest.operations. Throw ConnectorError on failure. */
  execute(operationId: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>;
  /** Optional polling for manifest.events (e.g. new mail since a cursor). */
  poll?(eventId: string, ctx: ConnectorContext, cursor?: string): Promise<{ events: ConnectorEvent[]; cursor?: string }>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "auth" | "not_found" | "validation" | "remote" | "unsupported" = "remote",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
