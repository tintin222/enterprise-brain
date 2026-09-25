import { and, asc, eq, sql } from "drizzle-orm";
import type { ConnectorBinding, ConnectorManifest, OperationManifest } from "@enterprise-brain/core";
import {
  ConnectorError,
  sandboxConnectorFor,
  type ConnectorContext,
  type ConnectorImplementation,
  type ConnectorRegistry,
  type SandboxStore,
} from "@enterprise-brain/connectors";
import { connectorInstances, sandboxRecords, type DatabaseHandle } from "@enterprise-brain/db";
import type { SecretBox } from "./secrets.ts";

/** SandboxStore persisted in the sandbox_records table (company-scoped). */
export class DbSandboxStore implements SandboxStore {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly companyId: string,
  ) {}

  async list(system: string, entity: string): Promise<Record<string, unknown>[]> {
    const rows = await this.handle.db
      .select({ data: sandboxRecords.data })
      .from(sandboxRecords)
      .where(
        and(
          eq(sandboxRecords.companyId, this.companyId),
          eq(sandboxRecords.system, system),
          eq(sandboxRecords.entity, entity),
        ),
      )
      .orderBy(asc(sandboxRecords.createdAt), asc(sandboxRecords.externalId));
    return rows.map((r) => r.data);
  }

  async get(system: string, entity: string, id: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await this.handle.db
      .select({ data: sandboxRecords.data })
      .from(sandboxRecords)
      .where(
        and(
          eq(sandboxRecords.companyId, this.companyId),
          eq(sandboxRecords.system, system),
          eq(sandboxRecords.entity, entity),
          eq(sandboxRecords.externalId, id),
        ),
      );
    return row?.data;
  }

  async upsert(system: string, entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.handle.db
      .insert(sandboxRecords)
      .values({ companyId: this.companyId, system, entity, externalId: id, data })
      .onConflictDoUpdate({
        target: [sandboxRecords.companyId, sandboxRecords.system, sandboxRecords.entity, sandboxRecords.externalId],
        set: { data, updatedAt: new Date() },
      });
  }

  async count(system: string): Promise<number> {
    const [row] = await this.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxRecords)
      .where(and(eq(sandboxRecords.companyId, this.companyId), eq(sandboxRecords.system, system)));
    return row?.n ?? 0;
  }
}

export interface ConnectorInstanceView {
  id: string;
  type: string;
  name: string;
  category: string;
  config: Record<string, unknown>;
  /** Names of secret fields that have a stored value (values are never returned). */
  secretFields: string[];
  status: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  sandbox: boolean;
}

export interface ResolvedConnector {
  impl: ConnectorImplementation;
  instanceId: string | null;
  /** True when the call is served by a built-in sandbox system. */
  sandbox: boolean;
  name: string;
}

/** Manages connector instances and executes operations with company-scoped credentials. */
export class ConnectorService {
  constructor(
    private readonly handle: DatabaseHandle,
    readonly registry: ConnectorRegistry,
    private readonly secretBox: SecretBox,
  ) {}

  catalog(): ConnectorManifest[] {
    return this.registry.list();
  }

  private splitConfig(manifest: ConnectorManifest, values: Record<string, unknown>) {
    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const field of manifest.config) {
      const value = values[field.key];
      if (value === undefined || value === null || value === "") continue;
      if (field.secret) secrets[field.key] = String(value);
      else config[field.key] = value;
    }
    return { config, secrets };
  }

  async create(companyId: string, input: { type: string; name?: string; values: Record<string, unknown> }) {
    const impl = this.registry.get(input.type);
    if (!impl) throw new ConnectorError(`Unknown connector type "${input.type}"`, "config");
    const { config, secrets } = this.splitConfig(impl.manifest, input.values);
    const [row] = await this.handle.db
      .insert(connectorInstances)
      .values({
        companyId,
        type: input.type,
        name: input.name || impl.manifest.name,
        config,
        secretsCiphertext: Object.keys(secrets).length ? this.secretBox.encrypt(secrets) : null,
      })
      .returning();
    return this.view(row!);
  }

  async update(companyId: string, id: string, input: { name?: string; values?: Record<string, unknown> }) {
    const row = await this.row(companyId, id);
    const impl = this.registry.get(row.type);
    if (!impl) throw new ConnectorError(`Unknown connector type "${row.type}"`, "config");
    const existingSecrets = row.secretsCiphertext ? this.secretBox.decrypt<Record<string, string>>(row.secretsCiphertext) : {};
    const { config, secrets } = this.splitConfig(impl.manifest, input.values ?? {});
    const mergedSecrets = { ...existingSecrets, ...secrets };
    const [updated] = await this.handle.db
      .update(connectorInstances)
      .set({
        name: input.name ?? row.name,
        config: input.values ? { ...row.config, ...config } : row.config,
        secretsCiphertext: Object.keys(mergedSecrets).length ? this.secretBox.encrypt(mergedSecrets) : null,
        status: "unverified",
        updatedAt: new Date(),
      })
      .where(and(eq(connectorInstances.companyId, companyId), eq(connectorInstances.id, id)))
      .returning();
    return this.view(updated!);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.handle.db
      .delete(connectorInstances)
      .where(and(eq(connectorInstances.companyId, companyId), eq(connectorInstances.id, id)));
  }

  async list(companyId: string): Promise<ConnectorInstanceView[]> {
    const rows = await this.handle.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.companyId, companyId))
      .orderBy(asc(connectorInstances.createdAt));
    return rows.map((r) => this.view(r));
  }

  async get(companyId: string, id: string): Promise<ConnectorInstanceView> {
    return this.view(await this.row(companyId, id));
  }

  private async row(companyId: string, id: string) {
    const [row] = await this.handle.db
      .select()
      .from(connectorInstances)
      .where(and(eq(connectorInstances.companyId, companyId), eq(connectorInstances.id, id)));
    if (!row) throw new ConnectorError(`Connector instance ${id} not found`, "not_found");
    return row;
  }

  private view(row: typeof connectorInstances.$inferSelect): ConnectorInstanceView {
    const impl = this.registry.get(row.type);
    const secretFields = row.secretsCiphertext
      ? Object.keys(this.secretBox.decrypt<Record<string, string>>(row.secretsCiphertext))
      : [];
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      category: impl?.manifest.category ?? "other",
      config: row.config,
      secretFields,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt,
      lastError: row.lastError,
      sandbox: impl?.manifest.maturity === "sandbox",
    };
  }

  context(companyId: string, config: Record<string, unknown> = {}, secrets: Record<string, string> = {}): ConnectorContext {
    return {
      companyId,
      config,
      secrets,
      fetch: globalThis.fetch.bind(globalThis),
      logger: {
        info: () => {},
        warn: (message, data) => console.warn(`[connector] ${message}`, data ?? ""),
      },
      sandbox: new DbSandboxStore(this.handle, companyId),
    };
  }

  private async instanceContext(companyId: string, id: string) {
    const row = await this.row(companyId, id);
    const impl = this.registry.get(row.type);
    if (!impl) throw new ConnectorError(`Unknown connector type "${row.type}"`, "config");
    const secrets = row.secretsCiphertext ? this.secretBox.decrypt<Record<string, string>>(row.secretsCiphertext) : {};
    return { row, impl, ctx: this.context(companyId, row.config, secrets) };
  }

  async test(companyId: string, id: string) {
    const { impl, ctx } = await this.instanceContext(companyId, id);
    let result;
    try {
      result = await impl.test(ctx);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    await this.handle.db
      .update(connectorInstances)
      .set({ status: result.ok ? "ok" : "error", lastCheckedAt: new Date(), lastError: result.ok ? null : result.message })
      .where(and(eq(connectorInstances.companyId, companyId), eq(connectorInstances.id, id)));
    return result;
  }

  /**
   * Resolve an agent's connector binding: explicit instance → first configured
   * instance of the category → built-in sandbox system of the category.
   */
  async resolve(companyId: string, binding: Pick<ConnectorBinding, "category" | "instanceId" | "ref">): Promise<ResolvedConnector> {
    if (binding.instanceId) {
      const row = await this.row(companyId, binding.instanceId);
      const impl = this.registry.get(row.type);
      if (!impl) throw new ConnectorError(`Unknown connector type "${row.type}"`, "config");
      return { impl, instanceId: row.id, sandbox: impl.manifest.maturity === "sandbox", name: row.name };
    }
    const instances = await this.list(companyId);
    const match = instances.find((i) => i.category === binding.category && !i.sandbox);
    if (match) {
      return { impl: this.registry.get(match.type)!, instanceId: match.id, sandbox: false, name: match.name };
    }
    const sandboxType = sandboxConnectorFor(binding.category);
    const sandboxImpl = sandboxType ? this.registry.get(sandboxType) : undefined;
    if (!sandboxImpl) {
      throw new ConnectorError(
        `No "${binding.category}" system is connected for "${binding.ref}". Configure a connector in Connectors.`,
        "config",
      );
    }
    return { impl: sandboxImpl, instanceId: null, sandbox: true, name: sandboxImpl.manifest.name };
  }

  operation(impl: ConnectorImplementation, operationId: string): OperationManifest {
    const op = impl.manifest.operations.find((o) => o.id === operationId);
    if (!op) throw new ConnectorError(`Operation "${operationId}" is not offered by ${impl.manifest.name}`, "unsupported");
    return op;
  }

  async execute(
    companyId: string,
    resolved: ResolvedConnector,
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    this.operation(resolved.impl, operationId);
    if (resolved.instanceId) {
      const { impl, ctx } = await this.instanceContext(companyId, resolved.instanceId);
      return impl.execute(operationId, input, ctx);
    }
    return resolved.impl.execute(operationId, input, this.context(companyId));
  }

  /** Run an operation on a specific connection. */
  async executeInstance(companyId: string, instanceId: string, operationId: string, input: Record<string, unknown>): Promise<unknown> {
    const { impl, ctx } = await this.instanceContext(companyId, instanceId);
    this.operation(impl, operationId);
    return impl.execute(operationId, input, ctx);
  }

  /** Ask a connection what happened since the cursor (new mail, new records); undefined when it can't be watched. */
  async poll(companyId: string, instanceId: string, eventId: string, cursor?: string) {
    const { impl, ctx } = await this.instanceContext(companyId, instanceId);
    if (!impl.poll) return undefined;
    return impl.poll(eventId, ctx, cursor);
  }

  /** Execute directly against a connector type (sandbox/demo usage from the console). */
  async executeByType(companyId: string, type: string, operationId: string, input: Record<string, unknown>) {
    const impl = this.registry.get(type);
    if (!impl) throw new ConnectorError(`Unknown connector type "${type}"`, "config");
    const instances = await this.list(companyId);
    const instance = instances.find((i) => i.type === type);
    return this.execute(companyId, { impl, instanceId: instance?.id ?? null, sandbox: impl.manifest.maturity === "sandbox", name: impl.manifest.name }, operationId, input);
  }
}
