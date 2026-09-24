import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { companies, createDatabase, departments, knowledgeChunks, type DatabaseHandle } from "@enterprise-brain/db";
import { LocalHashEmbedder, type Embedder } from "@enterprise-brain/llm";
import { contentHash, KnowledgeError, KnowledgeService, normalizeText, type KnowledgeCollection, type KnowledgeDocument } from "../src/index.ts";

const LEAVE_POLICY = `# Leave Policy

## Annual leave

Full-time employees are entitled to 20 days of paid annual leave per calendar year. Part-time employees accrue annual leave pro rata. Up to 5 unused days may be carried over to the next year with manager approval.

## Sick leave

Employees must notify their manager before 10:00 on the first day of absence. A medical certificate is required for absences longer than 3 consecutive days.

## Parental leave

Primary caregivers receive 16 weeks of paid parental leave; secondary caregivers receive 4 weeks.`;

const EXPENSE_POLICY = `# Travel and Expense Policy

Employees are reimbursed for reasonable business expenses. Submit expense reports with itemised receipts within 30 days of purchase through the finance portal.

## Meals

The daily meal allowance is 60 EUR when travelling. Alcohol is not reimbursable.

## Travel

Book flights in economy class through the corporate travel agency. Hotel stays are capped at 150 EUR per night.`;

const SECURITY_POLICY = `# Information Security Policy

## Passwords

Passwords must be at least 14 characters long and rotated every 90 days. Multi-factor authentication (MFA) is mandatory for email, VPN and all production systems.

## Devices

Laptops must use full-disk encryption. Report lost or stolen devices to the IT service desk within 24 hours.`;

const TURKISH_LEAVE_POLICY = `# Yıllık İzin Politikası

Bir yılını dolduran çalışanlar her yıl 14 iş günü ücretli yıllık izin hakkı kazanır. Beş yıldan fazla kıdemi olan çalışanlar için bu süre 20 iş gününe çıkar.

İzin talepleri en az iki hafta önceden yöneticiye iletilmelidir. Kullanılmayan izin günleri bir sonraki yıla devredilebilir.`;

/** Wraps the local embedder, counting calls and optionally reporting another model name. */
class TestEmbedder implements Embedder {
  readonly dimensions = 1024;
  calls = 0;
  private readonly inner = new LocalHashEmbedder();

  constructor(readonly model = "local-hash-v1") {}

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    this.calls++;
    return this.inner.embed(texts, kind);
  }
}

const failingEmbedder: Embedder = {
  model: "local-hash-v1",
  dimensions: 1024,
  embed: async () => {
    throw new Error("embedding service unavailable");
  },
};

let handle: DatabaseHandle;
let service: KnowledgeService;
let companyA: string;
let companyB: string;
const collections: Record<string, KnowledgeCollection> = {};
const docs: Record<string, KnowledgeDocument> = {};

async function chunkCount(documentId: string): Promise<number> {
  const [row] = await handle.db.select({ n: count() }).from(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  handle = await createDatabase();
  const [a] = await handle.db.insert(companies).values({ name: "Acme", slug: "acme" }).returning();
  const [b] = await handle.db.insert(companies).values({ name: "Globex", slug: "globex" }).returning();
  companyA = a!.id;
  companyB = b!.id;
  service = new KnowledgeService(handle, new LocalHashEmbedder());

  collections.hr = await service.ensureCollection(companyA, { key: "hr", name: "Human Resources", description: "HR policies" });
  collections.finance = await service.ensureCollection(companyA, { key: "finance", name: "Finance" });
  collections.it = await service.ensureCollection(companyA, { key: "it", name: "IT" });
  docs.leave = await service.ingestText(companyA, "hr", {
    title: "HR Leave Policy",
    text: LEAVE_POLICY,
    uri: "https://intranet.example/hr/leave",
    metadata: { owner: "HR" },
  });
  docs.expense = await service.ingestText(companyA, "finance", { title: "Travel and Expense Policy", text: EXPENSE_POLICY });
  docs.security = await service.ingestText(companyA, collections.it.id, { title: "Information Security Policy", text: SECURITY_POLICY });
  docs.turkish = await service.ingestText(companyA, "hr", { title: "Yıllık izin politikası", text: TURKISH_LEAVE_POLICY });
});

afterAll(async () => {
  await handle?.close();
});

describe("collections", () => {
  it("ensureCollection is idempotent per company and key", async () => {
    const again = await service.ensureCollection(companyA, { key: " hr ", name: "Renamed" });
    expect(again.id).toBe(collections.hr!.id);
    expect(again.name).toBe("Human Resources");

    const other = await service.ensureCollection(companyB, { key: "hr", name: "Globex HR" });
    expect(other.id).not.toBe(collections.hr!.id);
    expect(other.companyId).toBe(companyB);

    expect((await service.getCollection(companyA, "hr"))?.id).toBe(collections.hr!.id);
    expect((await service.getCollection(companyA, collections.hr!.id))?.key).toBe("hr");
    expect(await service.getCollection(companyB, collections.hr!.id)).toBeNull();
    await expect(service.ensureCollection(companyA, { key: "  ", name: "x" })).rejects.toBeInstanceOf(KnowledgeError);
  });

  it("only links collections to departments of the same company", async () => {
    const [foreign] = await handle.db.insert(departments).values({ companyId: companyB, key: "hr", name: "HR" }).returning();
    const [own] = await handle.db.insert(departments).values({ companyId: companyA, key: "people", name: "People" }).returning();
    await expect(
      service.ensureCollection(companyA, { key: "people", name: "People", departmentId: foreign!.id }),
    ).rejects.toThrow(/Unknown department/);
    const linked = await service.ensureCollection(companyA, { key: "people", name: "People", departmentId: own!.id });
    expect(linked.departmentId).toBe(own!.id);
    expect(await service.deleteCollection(companyA, "people")).toBe(true);
  });

  it("lists collections with document and chunk counts", async () => {
    const list = await service.listCollections(companyA);
    expect(list.map((c) => c.key)).toEqual(["finance", "hr", "it"]);
    const hr = list.find((c) => c.key === "hr")!;
    expect(hr.documentCount).toBe(2);
    expect(hr.chunkCount).toBe((await chunkCount(docs.leave!.id)) + (await chunkCount(docs.turkish!.id)));
    expect(hr.chunkCount).toBeGreaterThanOrEqual(2);
    expect((await service.getCollection(companyA, "it"))?.documentCount).toBe(1);
  });

  it("deleteCollection removes documents and chunks", async () => {
    await service.ensureCollection(companyA, { key: "scratch", name: "Scratch" });
    const doc = await service.ingestText(companyA, "scratch", { title: "Temp", text: "Temporary note about the office plants." });
    expect(await chunkCount(doc.id)).toBeGreaterThan(0);
    expect(await service.deleteCollection(companyB, "scratch")).toBe(false);
    expect(await service.deleteCollection(companyA, "scratch")).toBe(true);
    expect(await service.getCollection(companyA, "scratch")).toBeNull();
    expect(await service.getDocument(companyA, doc.id)).toBeNull();
    expect(await chunkCount(doc.id)).toBe(0);
    expect(await service.deleteCollection(companyA, "scratch")).toBe(false);
  });
});

describe("ingestion", () => {
  it("chunks, embeds and stores a document", async () => {
    const doc = docs.leave!;
    expect(doc).toMatchObject({
      status: "indexed",
      error: null,
      title: "HR Leave Policy",
      source: "text",
      uri: "https://intranet.example/hr/leave",
      collectionId: collections.hr!.id,
      contentHash: contentHash(normalizeText(LEAVE_POLICY)),
    });
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.chunkCount).toBeGreaterThan(0);

    const full = await service.getDocument(companyA, doc.id);
    expect(full?.chunks).toHaveLength(doc.chunkCount);
    expect(full?.chunks.map((c) => c.ordinal)).toEqual(full?.chunks.map((_, i) => i));
    expect(full?.chunks[0]).toMatchObject({ embeddingModel: "local-hash-v1", companyId: companyA, documentId: doc.id });
    expect(full?.chunks[0]?.metadata.heading).toBeTypeOf("string");
    expect(full?.chunks[0]).not.toHaveProperty("embedding");

    const [stored] = await handle.query<{ dims: number; models: number }>(
      `SELECT min(vector_dims(embedding)) AS dims, count(DISTINCT embedding_model)::int AS models
         FROM knowledge_chunks WHERE document_id = $1 AND embedding IS NOT NULL`,
      [doc.id],
    );
    expect(stored).toEqual({ dims: 1024, models: 1 });
  });

  it("skips re-embedding identical content in the same collection", async () => {
    const embedder = new TestEmbedder();
    const counting = new KnowledgeService(handle, embedder);
    const chunksBefore = await chunkCount(docs.leave!.id);

    const again = await counting.ingestText(companyA, "hr", { title: "Leave policy (copy)", text: LEAVE_POLICY.replace(/\n/g, "\r\n") });
    expect(again.id).toBe(docs.leave!.id);
    expect(again.title).toBe("HR Leave Policy");
    expect(embedder.calls).toBe(0);
    expect(await chunkCount(docs.leave!.id)).toBe(chunksBefore);
    expect((await service.listDocuments(companyA, "hr")).length).toBe(2);

    // Deduplication is per collection.
    const elsewhere = await counting.ingestText(companyA, "it", { title: "Leave policy", text: LEAVE_POLICY });
    expect(elsewhere.id).not.toBe(docs.leave!.id);
    expect(elsewhere.status).toBe("indexed");
    expect(embedder.calls).toBeGreaterThan(0);
    expect(await service.deleteDocument(companyA, elsewhere.id)).toBe(true);
  });

  it("records failures on the document and recovers when the same content is ingested again", async () => {
    await service.ensureCollection(companyA, { key: "ops", name: "Operations" });
    const broken = new KnowledgeService(handle, failingEmbedder, { logger: { warn: () => {} } });
    const text = "Backups run nightly at 02:00 and are kept for 35 days.";

    const failed = await broken.ingestText(companyA, "ops", { title: "Backup runbook", text });
    expect(failed).toMatchObject({ status: "error", chunkCount: 0 });
    expect(failed.error).toContain("embedding service unavailable");
    expect(await chunkCount(failed.id)).toBe(0);

    const retried = await service.ingestText(companyA, "ops", { title: "Backup runbook", text });
    expect(retried.id).toBe(failed.id);
    expect(retried).toMatchObject({ status: "indexed", error: null });
    expect(await chunkCount(retried.id)).toBe(retried.chunkCount);
    expect(await service.deleteCollection(companyA, "ops")).toBe(true);
  });

  it("rejects invalid input", async () => {
    await expect(service.ingestText(companyA, "hr", { title: "Empty", text: " \n\t " })).rejects.toThrow(/empty/);
    await expect(service.ingestText(companyA, "missing", { title: "x", text: "y" })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.ingestText("not-a-uuid", "hr", { title: "x", text: "y" })).rejects.toBeInstanceOf(KnowledgeError);
    expect(() => new KnowledgeService(handle, new LocalHashEmbedder(256))).toThrow(/1024/);
  });

  it("reindexDocument replaces the chunks", async () => {
    await service.ensureCollection(companyA, { key: "guides", name: "Guides" });
    const doc = await service.ingestText(companyA, "guides", { title: "VPN guide", text: "Connect to the VPN with the Cisco AnyConnect client." });
    const updated = await service.reindexDocument(companyA, doc.id, "Connect to the VPN with WireGuard. The AnyConnect client is retired.");
    expect(updated).toMatchObject({ id: doc.id, status: "indexed" });
    expect(updated.contentHash).not.toBe(doc.contentHash);

    const chunks = (await service.getDocument(companyA, doc.id))!.chunks;
    expect(chunks.map((c) => c.content).join(" ")).toContain("WireGuard");
    expect(await chunkCount(doc.id)).toBe(updated.chunkCount);

    const hits = await service.search(companyA, "wireguard", { collections: ["guides"] });
    expect(hits[0]?.documentId).toBe(doc.id);
    expect((await service.search(companyA, "Cisco", { collections: ["guides"] })).filter((h) => h.textRank)).toEqual([]);
    await expect(service.reindexDocument(companyA, "3f1c1a8e-0000-4000-8000-000000000000", "x")).rejects.toMatchObject({ code: "not_found" });
    expect(await service.deleteCollection(companyA, "guides")).toBe(true);
  });

  it("deleteDocument removes the document and its chunks", async () => {
    const doc = await service.ingestText(companyA, "finance", { title: "Petty cash", text: "Petty cash above 200 EUR needs CFO sign-off." });
    expect(await chunkCount(doc.id)).toBeGreaterThan(0);
    expect(await service.deleteDocument(companyA, doc.id)).toBe(true);
    expect(await chunkCount(doc.id)).toBe(0);
    expect(await service.getDocument(companyA, doc.id)).toBeNull();
    expect(await service.deleteDocument(companyA, doc.id)).toBe(false);
    expect(await service.deleteDocument(companyA, "not-a-uuid")).toBe(false);
  });
});

describe("hybrid search", () => {
  it("ranks the relevant English document first", async () => {
    const hits = await service.search(companyA, "how many days of annual leave");
    expect(hits[0]).toMatchObject({
      documentId: docs.leave!.id,
      title: "HR Leave Policy",
      collectionKey: "hr",
      collectionId: collections.hr!.id,
      uri: "https://intranet.example/hr/leave",
      vectorRank: 1,
      textRank: 1,
      score: 1,
    });
    expect(hits[0]!.content).toContain("20 days of paid annual leave");
    expect(hits[0]!.metadata).toMatchObject({ owner: "HR", heading: "Annual leave" });
    for (const hit of hits.slice(1)) expect(hit.score).toBeLessThan(hits[0]!.score);

    expect((await service.search(companyA, "expense receipts deadline"))[0]?.documentId).toBe(docs.expense!.id);
    expect((await service.search(companyA, "password rotation and MFA"))[0]?.documentId).toBe(docs.security!.id);
    expect((await service.search(companyA, "hotel cost per night"))[0]?.documentId).toBe(docs.expense!.id);
  });

  it("ranks the relevant Turkish document first", async () => {
    const hits = await service.search(companyA, "yıllık izin kaç gün");
    expect(hits[0]).toMatchObject({ documentId: docs.turkish!.id, title: "Yıllık izin politikası", vectorRank: 1, textRank: 1 });
    expect(hits[0]!.content).toContain("14 iş günü");
    expect((await service.search(companyA, "İZİN TALEPLERİ"))[0]?.documentId).toBe(docs.turkish!.id);
  });

  it("uses the strict full-text query when a chunk contains every term", async () => {
    // Loose matching would also return the other policies ("policy"); the strict query only the security one.
    const hits = await service.search(companyA, "security policy");
    expect(hits[0]?.documentId).toBe(docs.security!.id);
    expect(hits.filter((h) => h.textRank !== undefined).map((h) => h.documentId)).toEqual([docs.security!.id]);
  });

  it("falls back to prefix matching when no chunk contains every term", async () => {
    // "gün" only occurs inflected ("günü", "gününe") and "hakları" does not occur at all.
    const hits = await service.search(companyA, "gün hakları");
    expect(hits[0]).toMatchObject({ documentId: docs.turkish!.id, textRank: 1 });
  });

  it("restricts results to the requested collections", async () => {
    const itHits = await service.search(companyA, "annual leave", { collections: ["it"] });
    expect(itHits.length).toBeGreaterThan(0);
    expect(itHits.every((h) => h.collectionKey === "it")).toBe(true);

    const byId = await service.search(companyA, "annual leave", { collections: [collections.finance!.id, "hr"] });
    expect(new Set(byId.map((h) => h.collectionKey))).toEqual(new Set(["finance", "hr"]));

    expect(await service.search(companyA, "annual leave", { collections: ["does-not-exist"] })).toEqual([]);
    expect(await service.search(companyA, "annual leave", { collections: [] })).toEqual([]);
  });

  it("isolates companies", async () => {
    expect(await service.search(companyB, "how many days of annual leave")).toEqual([]);

    const own = await service.ingestText(companyB, "hr", { title: "Globex leave rules", text: TURKISH_LEAVE_POLICY });
    expect(own.id).not.toBe(docs.turkish!.id); // no deduplication across companies
    const hits = await service.search(companyB, "annual leave yıllık izin");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.documentId === own.id)).toBe(true);
    // Company A's leave policy matches far better; it must not even enter B's candidate lists.
    const top = await service.search(companyB, "how many days of annual leave", { topK: 1 });
    expect(top.map((h) => h.documentId)).toEqual([own.id]);
    const candidateIds: unknown[] = [];
    const spy: DatabaseHandle = {
      ...handle,
      async query<T>(text: string, params?: unknown[]) {
        const rows = await handle.query<T>(text, params);
        candidateIds.push(...rows.map((row) => (row as { id?: unknown }).id));
        return rows;
      },
    };
    for (const query of ["how many days of annual leave", "annual leave", "security policy"]) {
      await new KnowledgeService(spy, new LocalHashEmbedder()).search(companyB, query);
    }
    const ownChunkIds = (await service.getDocument(companyB, own.id))!.chunks.map((c) => c.id);
    expect(candidateIds.length).toBeGreaterThan(0);
    expect(candidateIds.every((id) => ownChunkIds.includes(id as string))).toBe(true);

    expect(await service.search(companyB, "annual leave", { collections: [collections.hr!.id] })).toEqual([]);
    expect((await service.listDocuments(companyB)).map((d) => d.id)).toEqual([own.id]);
    expect((await service.listCollections(companyB)).map((c) => c.key)).toEqual(["hr"]);
    expect(await service.getDocument(companyB, docs.leave!.id)).toBeNull();
    expect(await service.deleteDocument(companyB, docs.leave!.id)).toBe(false);
    await expect(service.reindexDocument(companyB, docs.leave!.id, "hijack")).rejects.toMatchObject({ code: "not_found" });
    expect((await service.getDocument(companyA, docs.leave!.id))?.status).toBe("indexed");
    expect(await chunkCount(docs.leave!.id)).toBe(docs.leave!.chunkCount);
  });

  it("only compares embeddings produced by the current model", async () => {
    const otherModel = new KnowledgeService(handle, new TestEmbedder("other-model-v2"));
    const hits = await otherModel.search(companyA, "annual leave");
    expect(hits[0]?.documentId).toBe(docs.leave!.id);
    expect(hits.every((h) => h.vectorRank === undefined && h.textRank !== undefined)).toBe(true);
  });

  it("falls back to full-text search when the query cannot be embedded", async () => {
    const warnings: string[] = [];
    const degraded = new KnowledgeService(handle, failingEmbedder, { logger: { warn: (message) => warnings.push(message) } });
    const hits = await degraded.search(companyA, "annual leave");
    expect(hits[0]).toMatchObject({ documentId: docs.leave!.id, textRank: 1, score: 1 });
    expect(hits.every((h) => h.vectorRank === undefined)).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("applies topK and minScore", async () => {
    expect(await service.search(companyA, "policy", { topK: 2 })).toHaveLength(2);
    const strong = await service.search(companyA, "how many days of annual leave", { minScore: 0.9 });
    expect(strong.map((h) => h.documentId)).toEqual([docs.leave!.id]);
  });

  it("returns nothing for blank queries and validates the company id", async () => {
    expect(await service.search(companyA, "   ")).toEqual([]);
    expect(await service.search(companyA, "?! -- ::")).toEqual([]);
    await expect(service.search("acme", "leave")).rejects.toBeInstanceOf(KnowledgeError);
  });

  it("builds numbered context from hits", async () => {
    const hits = await service.search(companyA, "annual leave", { topK: 2 });
    const context = service.buildContext(hits);
    expect(context.startsWith("[1] HR Leave Policy — ")).toBe(true);
    expect(context).toContain("\n\n[2] ");
  });
});

describe("documents", () => {
  it("lists documents per company and collection", async () => {
    const all = await service.listDocuments(companyA);
    expect(all.every((d) => d.companyId === companyA)).toBe(true);
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining([docs.leave!.id, docs.expense!.id, docs.security!.id, docs.turkish!.id]));
    const hr = await service.listDocuments(companyA, collections.hr!.id);
    expect(new Set(hr.map((d) => d.id))).toEqual(new Set([docs.leave!.id, docs.turkish!.id]));
    await expect(service.listDocuments(companyA, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("stores chunk rows only for the owning company", async () => {
    const [foreign] = await handle.db
      .select({ n: count() })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, docs.leave!.id), eq(knowledgeChunks.companyId, companyB)));
    expect(Number(foreign?.n)).toBe(0);
  });
});

describe("duplicates across collections", () => {
  it("returns a passage filed in several collections once", async () => {
    await service.ensureCollection(companyA, { key: "handbook-dup", name: "Handbook" });
    await service.ensureCollection(companyA, { key: "onboarding-dup", name: "Onboarding" });
    const text = "Company cars: employees in field sales receive a company car after their probation period ends.";
    await service.ingestText(companyA, "handbook-dup", { title: "Company car policy", text });
    await service.ingestText(companyA, "onboarding-dup", { title: "Company car policy", text });
    const hits = await service.search(companyA, "company car probation", { collections: ["handbook-dup", "onboarding-dup"], topK: 5 });
    expect(hits.filter((h) => h.title === "Company car policy")).toHaveLength(1);
  });
});
