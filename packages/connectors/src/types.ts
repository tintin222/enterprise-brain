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
  /** Works old systems' screens, for connections to systems without an API (only where a browser is available). */
  screens?: ScreenOperator;
  /** Counts the model use a call had (working screens) in the cost of the work it was made for. */
  recordUsage?: (usage: ConnectorUsage) => void;
  /** The company's own tables, for the Tables connection. */
  tables?: TableStore;
  /** Who the call is made for, as people read it in a record's history ("Complaint Clerk"). */
  actor?: string;
  /** The run the call is made in, for the history. */
  runId?: string;
}

/** The company's tables as the Tables connection sees them: records found, read, added and changed by table key. */
export interface TableStore {
  find(
    table: string,
    query: { search?: string; where?: Record<string, unknown>; limit?: number },
  ): Promise<{ records: Record<string, unknown>[]; total: number }>;
  get(table: string, record: string): Promise<Record<string, unknown>>;
  add(table: string, values: Record<string, unknown>, by: { actor: string; runId?: string }): Promise<Record<string, unknown>>;
  update(table: string, record: string, values: Record<string, unknown>, by: { actor: string; runId?: string }): Promise<Record<string, unknown>>;
}

/** Model use, as the LLM layer counts it. */
export interface ConnectorUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Where an old system is and how it is entered: its screens, reached through a browser. */
export interface ScreenTarget {
  /** The system's name, as people call it. */
  system: string;
  /** Where it opens: its sign-in page, or the remote desktop page showing it. */
  startUrl: string;
  /** web: its web pages (Claude's browser use); desktop: a desktop program shown in a remote desktop page (computer use). */
  kind: "web" | "desktop";
  /** Hosts besides the start page's that may be opened (a sign-in service); nothing else can be. */
  allowedHosts: string[];
  /** Typed where the AI employee types {{username}} and {{password}}, or given to the browser's own sign-in: never shown to it. */
  credentials: { username?: string; password?: string };
  /** The system asks for the username and password itself, in a browser window (HTTP authentication). */
  httpAuth?: boolean;
  /** Accept certificates the browser doesn't trust (a company's own authority). */
  acceptInvalidCertificates?: boolean;
}

/** A job on an old system's screens: one named action, with its values filled in. */
export interface ScreenJob extends ScreenTarget {
  /** The action's name, and what to do in plain words. */
  action: string;
  goal: string;
  /** Values to bring back, read from the screens. */
  returns: { key: string; type: string; description?: string }[];
  /** Reading only: nothing may change. In web systems, forms can only be sent to formPaths (sign-in, search). */
  readOnly: boolean;
  formPaths: string[];
  /** IT's notes on how the system works. */
  guidance?: string;
  /** Most actions on the screens before giving up. */
  maxSteps: number;
}

export interface ScreenOutcome {
  /** false: the screens didn't allow it (not found, no permission, an error); summary says why. */
  done: boolean;
  summary: string;
  /** The values asked for. */
  result: Record<string, unknown>;
  /** Actions on the screens. */
  steps: number;
  /** What it did, one line per action; secrets appear only as {{password}}. */
  trail: string[];
  /** The last screen (PNG). */
  lastScreen?: Buffer;
  usage?: ConnectorUsage;
}

export interface ScreenCheck {
  ok: boolean;
  message: string;
  title?: string;
  url?: string;
  /** The start page as it opened (PNG). */
  screen?: Buffer;
}

/** Works old systems through their screens, the way a person at a desk does. */
export interface ScreenOperator {
  operate(job: ScreenJob): Promise<ScreenOutcome>;
  /** Open the start page without the AI: a connection's test. */
  check(target: ScreenTarget): Promise<ScreenCheck>;
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
