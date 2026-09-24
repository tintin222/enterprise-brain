import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "pglite" | "postgres";
  /** Run raw SQL with positional parameters ($1, $2...). */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** postgres:// URL. When omitted an embedded PGlite database is used. */
  url?: string;
  /** Directory for the embedded database. Omit (with no url) for an in-memory database. */
  dataDir?: string;
  /** Skip running migrations (default: run them). */
  skipMigrations?: boolean;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export async function createDatabase(options: DatabaseOptions = {}): Promise<DatabaseHandle> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10 });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    const db = drizzlePg(pool, { schema }) as unknown as Database;
    if (!options.skipMigrations) {
      await migratePg(drizzlePg(pool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    }
    return {
      db,
      kind: "postgres",
      async query<T>(text: string, params: unknown[] = []) {
        const result = await pool.query(text, params);
        return result.rows as T[];
      },
      close: () => pool.end(),
    };
  }

  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = await PGlite.create({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    extensions: { vector },
  });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const pgliteDb = drizzlePglite(client, { schema });
  if (!options.skipMigrations) {
    await migratePglite(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return {
    db: pgliteDb as unknown as Database,
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params);
      return result.rows as T[];
    },
    close: () => client.close(),
  };
}
