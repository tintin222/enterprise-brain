import { and, desc, eq, or } from "drizzle-orm";
import { AgentDefinition, AgentStatus, type AgentDefinitionInput } from "@enterprise-brain/core";
import { agentVersions, agents, type DatabaseHandle } from "@enterprise-brain/db";

export type AgentRow = typeof agents.$inferSelect;

export interface AgentRecord {
  row: AgentRow;
  definition: AgentDefinition;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentNotFoundError extends Error {
  constructor(ref: string) {
    super(`Agent "${ref}" not found`);
    this.name = "AgentNotFoundError";
  }
}

/** Agent registry: CRUD, lifecycle status, and a revision per definition change (rollback-able). */
export class AgentService {
  constructor(private readonly handle: DatabaseHandle) {}

  async create(
    companyId: string,
    input: {
      definition: AgentDefinitionInput;
      status?: AgentStatus;
      source?: "template" | "builder" | "manual";
      templateId?: string;
      departmentId?: string | null;
      processId?: string | null;
      builderSessionId?: string | null;
      createdBy?: string;
    },
  ): Promise<AgentRecord> {
    const definition = AgentDefinition.parse(input.definition);
    const slug = await this.uniqueSlug(companyId, definition.slug);
    const finalDefinition = { ...definition, slug };
    const [row] = await this.handle.db
      .insert(agents)
      .values({
        companyId,
        slug,
        name: definition.name,
        summary: definition.summary,
        archetype: definition.archetype,
        status: input.status ?? "draft",
        source: input.source ?? "manual",
        templateId: input.templateId ?? definition.templateId ?? null,
        departmentId: input.departmentId ?? null,
        processId: input.processId ?? null,
        builderSessionId: input.builderSessionId ?? null,
        definition: finalDefinition as unknown as Record<string, unknown>,
        version: 1,
      })
      .returning();
    await this.handle.db.insert(agentVersions).values({
      agentId: row!.id,
      version: 1,
      definition: finalDefinition as unknown as Record<string, unknown>,
      note: "Created",
      createdBy: input.createdBy ?? "system",
    });
    return { row: row!, definition: finalDefinition };
  }

  private async uniqueSlug(companyId: string, base: string): Promise<string> {
    let slug = base;
    for (let i = 2; ; i++) {
      const [existing] = await this.handle.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.slug, slug)));
      if (!existing) return slug;
      slug = `${base}-${i}`;
    }
  }

  async update(
    companyId: string,
    ref: string,
    definitionInput: AgentDefinitionInput,
    options: { note?: string; createdBy?: string } = {},
  ): Promise<AgentRecord> {
    const current = await this.get(companyId, ref);
    const definition = AgentDefinition.parse({ ...definitionInput, slug: current.row.slug });
    const version = current.row.version + 1;
    const [row] = await this.handle.db
      .update(agents)
      .set({
        name: definition.name,
        summary: definition.summary,
        archetype: definition.archetype,
        definition: definition as unknown as Record<string, unknown>,
        version,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, current.row.id))
      .returning();
    await this.handle.db.insert(agentVersions).values({
      agentId: current.row.id,
      version,
      definition: definition as unknown as Record<string, unknown>,
      note: options.note ?? "Updated",
      createdBy: options.createdBy ?? "user",
    });
    return { row: row!, definition };
  }

  async setStatus(companyId: string, ref: string, status: AgentStatus): Promise<AgentRecord> {
    const current = await this.get(companyId, ref);
    const [row] = await this.handle.db
      .update(agents)
      .set({ status, updatedAt: new Date() })
      .where(eq(agents.id, current.row.id))
      .returning();
    return { row: row!, definition: current.definition };
  }

  async setPaperclipId(companyId: string, ref: string, paperclipAgentId: string | null): Promise<void> {
    const current = await this.get(companyId, ref);
    await this.handle.db.update(agents).set({ paperclipAgentId }).where(eq(agents.id, current.row.id));
  }

  async get(companyId: string, ref: string): Promise<AgentRecord> {
    const condition = UUID.test(ref) ? or(eq(agents.id, ref), eq(agents.slug, ref)) : eq(agents.slug, ref);
    const [row] = await this.handle.db.select().from(agents).where(and(eq(agents.companyId, companyId), condition));
    if (!row) throw new AgentNotFoundError(ref);
    return { row, definition: AgentDefinition.parse(row.definition) };
  }

  async find(companyId: string, ref: string): Promise<AgentRecord | undefined> {
    try {
      return await this.get(companyId, ref);
    } catch (error) {
      if (error instanceof AgentNotFoundError) return undefined;
      throw error;
    }
  }

  async list(companyId: string, filter: { status?: string; departmentId?: string } = {}): Promise<AgentRecord[]> {
    const conditions = [eq(agents.companyId, companyId)];
    if (filter.status) conditions.push(eq(agents.status, filter.status));
    if (filter.departmentId) conditions.push(eq(agents.departmentId, filter.departmentId));
    const rows = await this.handle.db
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.updatedAt));
    return rows.map((row) => ({ row, definition: AgentDefinition.parse(row.definition) }));
  }

  async versions(companyId: string, ref: string) {
    const current = await this.get(companyId, ref);
    return this.handle.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, current.row.id))
      .orderBy(desc(agentVersions.version));
  }

  async definitionAt(agentId: string, version: number): Promise<AgentDefinition> {
    const [row] = await this.handle.db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
    if (!row) throw new Error(`Agent ${agentId} has no version ${version}`);
    return AgentDefinition.parse(row.definition);
  }

  async rollback(companyId: string, ref: string, version: number, createdBy = "user"): Promise<AgentRecord> {
    const current = await this.get(companyId, ref);
    const definition = await this.definitionAt(current.row.id, version);
    return this.update(companyId, ref, definition, { note: `Rolled back to version ${version}`, createdBy });
  }

  async remove(companyId: string, ref: string): Promise<void> {
    const current = await this.get(companyId, ref);
    await this.handle.db.delete(agents).where(eq(agents.id, current.row.id));
  }
}
