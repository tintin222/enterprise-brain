import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { files, type DatabaseHandle } from "@enterprise-brain/db";
import { resolveMimeType } from "@enterprise-brain/documents";

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface FileContent extends StoredFile {
  data: Buffer;
}

/** File metadata in Postgres, bytes on disk (content-addressed per company). */
export class FileService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly rootDir: string,
  ) {}

  async put(
    companyId: string,
    input: { name: string; data: Buffer; mimeType?: string; source?: string; metadata?: Record<string, unknown> },
  ): Promise<StoredFile> {
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const storageKey = `${companyId}/${sha256.slice(0, 2)}/${sha256}`;
    const path = join(this.rootDir, storageKey);
    await mkdir(join(this.rootDir, companyId, sha256.slice(0, 2)), { recursive: true });
    await writeFile(path, input.data);
    const [row] = await this.handle.db
      .insert(files)
      .values({
        companyId,
        name: input.name,
        mimeType: resolveMimeType(input.data, input.name, input.mimeType),
        size: input.data.length,
        sha256,
        storageKey,
        source: input.source ?? "upload",
        metadata: input.metadata ?? {},
      })
      .returning();
    return toStored(row!);
  }

  async meta(companyId: string, fileId: string): Promise<StoredFile> {
    const [row] = await this.handle.db
      .select()
      .from(files)
      .where(and(eq(files.companyId, companyId), eq(files.id, fileId)));
    if (!row) throw new Error(`File ${fileId} not found`);
    return toStored(row);
  }

  async get(companyId: string, fileId: string): Promise<FileContent> {
    const [row] = await this.handle.db
      .select()
      .from(files)
      .where(and(eq(files.companyId, companyId), eq(files.id, fileId)));
    if (!row) throw new Error(`File ${fileId} not found`);
    const data = await readFile(join(this.rootDir, row.storageKey));
    return { ...toStored(row), data };
  }

  async list(companyId: string, limit = 100): Promise<StoredFile[]> {
    const rows = await this.handle.db
      .select()
      .from(files)
      .where(eq(files.companyId, companyId))
      .orderBy(desc(files.createdAt))
      .limit(limit);
    return rows.map(toStored);
  }
}

function toStored(row: typeof files.$inferSelect): StoredFile {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    sha256: row.sha256,
    source: row.source,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a template value into file ids: "id", ["id"], {fileId}, [{fileId}]. */
export function toFileIds(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string" && UUID.test(v.trim())) out.push(v.trim());
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.fileId === "string") visit(rec.fileId);
      else if (typeof rec.id === "string") visit(rec.id);
    }
  };
  visit(value);
  return [...new Set(out)];
}
