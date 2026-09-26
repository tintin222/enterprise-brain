import type { ConnectorManifest, NamedAction } from "@enterprise-brain/core";

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
  /**
   * Store new secret values on the connection (e.g. a refresh token the provider replaced). Only
   * connections stored by the platform have it.
   */
  saveSecrets?: (patch: Record<string, string>) => Promise<void>;
  /** The company's files in Enterprise Brain (attachments, uploads, reports), for connections that move files. */
  files?: ConnectorFiles;
}

export interface ConnectorFiles {
  get(fileId: string): Promise<{ id: string; name: string; mimeType: string; data: Buffer }>;
  /** Store a file brought in from the system; its id is what AI employees and document tools use. */
  put(file: { name: string; data: Buffer; mimeType?: string; source: string; metadata?: Record<string, unknown> }): Promise<{ id: string }>;
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

export interface PollResult {
  events: ConnectorEvent[];
  cursor?: string;
  warnings?: string[];
}

export interface ConnectorImplementation {
  manifest: ConnectorManifest;
  /** Verify credentials/connectivity (the "Test connection" button). */
  test(ctx: ConnectorContext): Promise<ConnectorTestResult>;
  /** Execute an operation declared in manifest.operations. Throw ConnectorError on failure. */
  execute(operationId: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>;
  /** Optional polling for manifest.events (e.g. new mail since a cursor). Warnings: what it left alone, and why. */
  poll?(eventId: string, ctx: ConnectorContext, cursor?: string): Promise<PollResult>;
  /** Run a named action IT defined on a connection (web services, databases), with checked values. */
  runAction?(action: NamedAction, values: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>;
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
