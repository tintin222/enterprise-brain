import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle, companies, knowledgeCollections, knowledgeDocuments, knowledgeChunks, EMBEDDING_DIMENSIONS } from "../src/index.ts";

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createDatabase();
});
afterAll(async () => {
  await handle.close();
});

describe("database", () => {
  it("runs migrations and supports inserts", async () => {
    const [company] = await handle.db.insert(companies).values({ name: "Acme", slug: "acme" }).returning();
    expect(company?.id).toMatch(/[0-9a-f-]{36}/);
    const rows = await handle.db.select().from(companies).where(eq(companies.slug, "acme"));
    expect(rows).toHaveLength(1);
  });

  it("supports pgvector similarity + full-text search on chunks", async () => {
    const [company] = await handle.db.select().from(companies).limit(1);
    const [collection] = await handle.db
      .insert(knowledgeCollections)
      .values({ companyId: company!.id, key: "policies", name: "Policies" })
      .returning();
    const [doc] = await handle.db
      .insert(knowledgeDocuments)
      .values({ companyId: company!.id, collectionId: collection!.id, title: "Leave policy" })
      .returning();
    const vec = (hot: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));
    await handle.db.insert(knowledgeChunks).values([
      { companyId: company!.id, collectionId: collection!.id, documentId: doc!.id, ordinal: 0, content: "Employees get 14 days of annual leave", embedding: vec(1) },
      { companyId: company!.id, collectionId: collection!.id, documentId: doc!.id, ordinal: 1, content: "Expense reports are due monthly", embedding: vec(2) },
    ]);
    const rows = await handle.query<{ content: string; distance: number; rank: number }>(
      `SELECT content, embedding <=> $1::vector AS distance, ts_rank(tsv, plainto_tsquery('simple', $2)) AS rank
       FROM knowledge_chunks ORDER BY distance ASC`,
      [JSON.stringify(vec(1)), "annual leave"],
    );
    expect(rows[0]?.content).toContain("annual leave");
    expect(rows[0]?.rank).toBeGreaterThan(0);
    expect(rows[1]?.rank).toBeLessThan(1e-10);
  });
});
