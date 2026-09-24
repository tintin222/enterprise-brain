import type { SandboxStore } from "../types.ts";

type Row = Record<string, unknown>;

/**
 * SandboxStore kept in process memory, for tests and local development. The
 * server uses a database-backed store with the same semantics. Values are
 * cloned on the way in and out so callers can never mutate stored records.
 */
export class InMemorySandboxStore implements SandboxStore {
  private readonly systems = new Map<string, Map<string, Map<string, Row>>>();

  async list(system: string, entity: string): Promise<Row[]> {
    const rows = this.systems.get(system)?.get(entity);
    return rows ? [...rows.values()].map((row) => structuredClone(row)) : [];
  }

  async get(system: string, entity: string, id: string): Promise<Row | undefined> {
    const row = this.systems.get(system)?.get(entity)?.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async upsert(system: string, entity: string, id: string, data: Row): Promise<void> {
    let entities = this.systems.get(system);
    if (!entities) {
      entities = new Map();
      this.systems.set(system, entities);
    }
    let rows = entities.get(entity);
    if (!rows) {
      rows = new Map();
      entities.set(entity, rows);
    }
    rows.set(id, structuredClone(data));
  }

  async count(system: string): Promise<number> {
    let total = 0;
    for (const rows of this.systems.get(system)?.values() ?? []) total += rows.size;
    return total;
  }

  /** Removes the records of one system (or of all systems); the next operation re-seeds demo data. */
  clear(system?: string): void {
    if (system === undefined) this.systems.clear();
    else this.systems.delete(system);
  }
}
