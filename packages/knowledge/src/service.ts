import {
  EMBEDDING_DIMENSIONS,
  departments,
  files,
  knowledgeChunks,
  knowledgeCollections,
  knowledgeDocuments,
  type DatabaseHandle,
} from "@enterprise-brain/db";
import type { Embedder } from "@enterprise-brain/llm";
import { and, asc, desc, eq, getTableColumns, inArray, or, sql, type SQL } from "drizzle-orm";
import { chunkText } from "./chunking.ts";
import { buildContext as formatContext, DEFAULT_CONTEXT_MAX_CHARS } from "./context.ts";
import { KnowledgeError } from "./errors.ts";
import { reciprocalRankFusion, RRF_K } from "./fusion.ts";
import { buildPrefixTsQuery, extractSearchTerms, termQueries } from "./query.ts";
import { contentHash, isUuid, normalizeText, safeCutIndex, truncateText } from "./text.ts";
import type {
  Chunk,
  ChunkOptions,
  EnsureCollectionInput,
  IngestTextInput,
  KnowledgeChunk,
  KnowledgeCollection,
  KnowledgeCollectionWithCounts,
  KnowledgeDocument,
  KnowledgeDocumentWithChunks,
  KnowledgeLogger,
  KnowledgeServiceOptions,
  SearchHit,
  SearchOptions,
} from "./types.ts";

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 100;
/** Candidates fetched from each retriever per requested hit. */
const CANDIDATES_PER_HIT = 4;
const DEFAULT_EMBED_BATCH = 64;
/** Chunk rows per INSERT statement (8 parameters each, far below Postgres' 65535 limit). */
const INSERT_BATCH = 100;
const MAX_QUERY_CHARS = 2000;
const MAX_ERROR_CHARS = 2000;

const CHUNK_COLUMNS = {
  id: knowledgeChunks.id,
  companyId: knowledgeChunks.companyId,
  collectionId: knowledgeChunks.collectionId,
  documentId: knowledgeChunks.documentId,
  ordinal: knowledgeChunks.ordinal,
  content: knowledgeChunks.content,
  embeddingModel: knowledgeChunks.embeddingModel,
  metadata: knowledgeChunks.metadata,
};

interface Candidate {
  id: string;
  score: number;
}

interface Retrieval {
  /** False when the retriever could not evaluate the query (no terms / no query embedding). */
  used: boolean;
  candidates: Candidate[];
}

/**
 * Company-scoped knowledge base: collections, document ingestion (chunk → embed →
 * store) and hybrid retrieval (pgvector cosine + Postgres full text, fused with
 * reciprocal rank fusion). Every method takes the company id first and never
 * reads or writes another company's rows. Works on PGlite and PostgreSQL alike.
 */
export class KnowledgeService {
  private readonly chunking: ChunkOptions;
  private readonly embedBatchSize: number;
  private readonly logger: KnowledgeLogger;

  constructor(
    private readonly handle: DatabaseHandle,
    readonly embedder: Embedder,
    options: KnowledgeServiceOptions = {},
  ) {
    if (embedder.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new KnowledgeError(
        `Embedder "${embedder.model}" produces ${embedder.dimensions}-dimensional vectors but knowledge_chunks.embedding stores ${EMBEDDING_DIMENSIONS}`,
      );
    }
    this.chunking = options.chunking ?? {};
    this.embedBatchSize = clampInt(options.embedBatchSize, 1, 2048, DEFAULT_EMBED_BATCH);
    this.logger = options.logger ?? { warn: (message, data) => console.warn(`[knowledge] ${message}`, data ?? "") };
  }

  private get db() {
    return this.handle.db;
  }

  // -------------------------------------------------------------------------
  // Collections

  /** Returns the collection with this key, creating it when missing (existing collections are not modified). */
  async ensureCollection(companyId: string, input: EnsureCollectionInput): Promise<KnowledgeCollection> {
    assertUuid(companyId, "companyId");
    const key = input.key?.trim();
    if (!key) throw new KnowledgeError("Collection key is required");
    const departmentId = input.departmentId ?? null;
    if (departmentId) await this.assertOwned(companyId, "department", departmentId);
    const [created] = await this.db
      .insert(knowledgeCollections)
      .values({ companyId, key, name: input.name?.trim() || key, description: input.description?.trim() ?? "", departmentId })
      .onConflictDoNothing({ target: [knowledgeCollections.companyId, knowledgeCollections.key] })
      .returning();
    if (created) return created;
    const existing = await this.findCollection(companyId, key);
    if (!existing) throw new Error(`Knowledge collection "${key}" could not be created`);
    return existing;
  }

  async listCollections(companyId: string): Promise<KnowledgeCollectionWithCounts[]> {
    assertUuid(companyId, "companyId");
    return this.collectionsWithCounts(eq(knowledgeCollections.companyId, companyId)).orderBy(
      asc(knowledgeCollections.name),
      asc(knowledgeCollections.key),
    );
  }

  async getCollection(companyId: string, keyOrId: string): Promise<KnowledgeCollectionWithCounts | null> {
    assertUuid(companyId, "companyId");
    const ref = typeof keyOrId === "string" ? keyOrId.trim() : "";
    if (!ref) return null;
    const rows = await this.collectionsWithCounts(collectionRef(companyId, ref));
    return rows.find((row) => row.id === ref) ?? rows[0] ?? null;
  }

  /** Deletes the collection with its documents and chunks. */
  async deleteCollection(companyId: string, keyOrId: string): Promise<boolean> {
    assertUuid(companyId, "companyId");
    const collection = await this.findCollection(companyId, keyOrId);
    if (!collection) return false;
    const deleted = await this.db
      .delete(knowledgeCollections)
      .where(and(eq(knowledgeCollections.id, collection.id), eq(knowledgeCollections.companyId, companyId)))
      .returning({ id: knowledgeCollections.id });
    return deleted.length > 0;
  }

  // -------------------------------------------------------------------------
  // Documents

  /**
   * Chunks, embeds and stores a document. Re-ingesting content that is already
   * indexed in the collection (same sha256 of the normalised text) returns the
   * existing document without re-embedding.
   *
   * Invalid input (unknown collection, empty text, foreign file id) throws. When
   * chunking/embedding/storing fails, the document is kept with status "error"
   * and the error message, and returned; ingesting the same content again retries.
   */
  async ingestText(companyId: string, collectionKeyOrId: string, input: IngestTextInput): Promise<KnowledgeDocument> {
    assertUuid(companyId, "companyId");
    const collection = await this.requireCollection(companyId, collectionKeyOrId);
    const text = normalizeText(input.text ?? "");
    if (!text) throw new KnowledgeError("Cannot ingest an empty document");
    if (input.fileId) await this.assertOwned(companyId, "file", input.fileId);
    const hash = contentHash(text);
    const fields = {
      title: input.title?.replace(/\s+/g, " ").trim() || "Untitled",
      source: input.source ?? "text",
      uri: input.uri ?? null,
      fileId: input.fileId ?? null,
      mimeType: input.mimeType ?? null,
      metadata: input.metadata ?? {},
    };

    const claim = await this.db.transaction(async (tx) => {
      // Lock the collection row so concurrent ingests of the same content cannot both create a document.
      const [locked] = await tx
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(and(eq(knowledgeCollections.id, collection.id), eq(knowledgeCollections.companyId, companyId)))
        .for("no key update");
      if (!locked) throw new KnowledgeError(`Knowledge collection "${collectionKeyOrId}" not found`, "not_found");
      const [existing] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.companyId, companyId),
            eq(knowledgeDocuments.collectionId, collection.id),
            eq(knowledgeDocuments.contentHash, hash),
          ),
        )
        .orderBy(desc(sql`${knowledgeDocuments.status} = 'indexed'`), asc(knowledgeDocuments.createdAt))
        .limit(1);
      if (existing?.status === "indexed") return { document: existing, index: false };
      if (existing) {
        // A previous attempt failed or was interrupted: retry on the same document.
        const [retry] = await tx
          .update(knowledgeDocuments)
          .set({ ...fields, status: "processing", error: null, updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, existing.id))
          .returning();
        return { document: retry!, index: true };
      }
      const [document] = await tx
        .insert(knowledgeDocuments)
        .values({ ...fields, companyId, collectionId: collection.id, contentHash: hash, status: "processing" })
        .returning();
      return { document: document!, index: true };
    });

    return claim.index ? this.indexDocument(companyId, claim.document, text, hash) : claim.document;
  }

  /**
   * Replaces a document's chunks with ones built from `text` (e.g. after the source
   * changed or the embedding model was switched). The previous chunks stay
   * searchable until the new ones are committed; failures are recorded as for ingestText.
   */
  async reindexDocument(companyId: string, documentId: string, text: string): Promise<KnowledgeDocument> {
    assertUuid(companyId, "companyId");
    const normalized = normalizeText(text ?? "");
    if (!normalized) throw new KnowledgeError("Cannot index an empty document");
    const [document] = isUuid(documentId)
      ? await this.db
          .update(knowledgeDocuments)
          .set({ status: "processing", error: null, updatedAt: new Date() })
          .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.companyId, companyId)))
          .returning()
      : [];
    if (!document) throw new KnowledgeError(`Knowledge document ${documentId} not found`, "not_found");
    return this.indexDocument(companyId, document, normalized, contentHash(normalized));
  }

  /** Deletes a document and (by cascade) its chunks. */
  async deleteDocument(companyId: string, documentId: string): Promise<boolean> {
    assertUuid(companyId, "companyId");
    if (!isUuid(documentId)) return false;
    const deleted = await this.db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.companyId, companyId)))
      .returning({ id: knowledgeDocuments.id });
    return deleted.length > 0;
  }

  /** Documents of the company (newest first), optionally of one collection. */
  async listDocuments(companyId: string, collectionKeyOrId?: string): Promise<KnowledgeDocument[]> {
    assertUuid(companyId, "companyId");
    const collection = collectionKeyOrId === undefined ? null : await this.requireCollection(companyId, collectionKeyOrId);
    return this.db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.companyId, companyId),
          collection ? eq(knowledgeDocuments.collectionId, collection.id) : undefined,
        ),
      )
      .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id));
  }

  /** A document with its chunks (in order, without embeddings), or null. */
  async getDocument(companyId: string, documentId: string): Promise<KnowledgeDocumentWithChunks | null> {
    assertUuid(companyId, "companyId");
    if (!isUuid(documentId)) return null;
    const [document] = await this.db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.companyId, companyId)))
      .limit(1);
    if (!document) return null;
    const chunks: KnowledgeChunk[] = await this.db
      .select(CHUNK_COLUMNS)
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, document.id), eq(knowledgeChunks.companyId, companyId)))
      .orderBy(asc(knowledgeChunks.ordinal));
    return { ...document, chunks };
  }

  // -------------------------------------------------------------------------
  // Retrieval

  /**
   * Hybrid search: vector nearest neighbours (chunks embedded with the current
   * embedder's model) and full-text matches (strict websearch query, falling back
   * to any-term prefix matching when nothing matches strictly), fused with RRF.
   */
  async search(companyId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    assertUuid(companyId, "companyId");
    const text = normalizeQuery(query);
    if (!text) return [];
    const topK = clampInt(options.topK, 1, MAX_TOP_K, DEFAULT_TOP_K);
    const collectionIds = await this.resolveCollectionIds(companyId, options.collections);
    if (collectionIds?.length === 0) return [];
    const limit = topK * CANDIDATES_PER_HIT;

    const [vector, fullText] = await Promise.all([
      this.vectorCandidates(companyId, text, collectionIds, limit),
      this.textCandidates(companyId, text, collectionIds, limit),
    ]);
    const retrievers = Number(vector.used) + Number(fullText.used);
    if (retrievers === 0) return [];
    // Normalise so 1 means "ranked first by every retriever that evaluated the query".
    const maxScore = retrievers / (RRF_K + 1);
    const minScore = typeof options.minScore === "number" ? options.minScore : Number.NEGATIVE_INFINITY;
    const fused = reciprocalRankFusion([vector.candidates.map((c) => c.id), fullText.candidates.map((c) => c.id)])
      .map((result) => ({ ...result, score: result.score / maxScore }))
      .filter((result) => result.score >= minScore)
      .slice(0, topK);
    if (fused.length === 0) return [];

    const details = await this.chunkDetails(companyId, fused.map((result) => result.id));
    const vectorScores = new Map(vector.candidates.map((c) => [c.id, c.score]));
    const textScores = new Map(fullText.candidates.map((c) => [c.id, c.score]));
    const hits: SearchHit[] = [];
    for (const result of fused) {
      const row = details.get(result.id);
      if (!row) continue; // deleted in the meantime
      const [vectorRank, textRank] = result.ranks;
      hits.push({
        chunkId: row.id,
        documentId: row.documentId,
        collectionId: row.collectionId,
        collectionKey: row.collectionKey,
        title: row.title,
        content: row.content,
        score: result.score,
        ...(vectorRank !== undefined ? { vectorRank, vectorScore: vectorScores.get(row.id) } : {}),
        ...(textRank !== undefined ? { textRank, textScore: textScores.get(row.id) } : {}),
        ordinal: row.ordinal,
        uri: row.uri,
        metadata: { ...row.documentMetadata, ...row.chunkMetadata },
      });
    }
    return hits;
  }

  /** Numbered sources ("[1] Title — content") for grounding answers; see {@link formatContext}. */
  buildContext(hits: SearchHit[], maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {
    return formatContext(hits, maxChars);
  }

  private async vectorCandidates(companyId: string, query: string, collectionIds: string[] | null, limit: number): Promise<Retrieval> {
    let vector: number[] | null;
    try {
      const [embedding] = await this.embedder.embed([query], "query");
      vector = prepareVector(embedding);
    } catch (error) {
      this.logger.warn("Query embedding failed; searching full text only", { model: this.embedder.model, error: errorMessage(error) });
      return { used: false, candidates: [] };
    }
    if (!vector) return { used: false, candidates: [] };
    const params: unknown[] = [companyId, `[${vector.join(",")}]`, this.embedder.model, limit];
    const scope = collectionScope(params, collectionIds);
    const rows = await this.handle.query<{ id: string; distance: number }>(
      `SELECT c.id, c.embedding <=> $2::vector AS distance
         FROM knowledge_chunks c
        WHERE c.company_id = $1 AND c.embedding_model = $3 AND c.embedding IS NOT NULL${scope}
        ORDER BY c.embedding <=> $2::vector
        LIMIT $4`,
      params,
    );
    return { used: true, candidates: rows.map((row) => ({ id: row.id, score: 1 - Number(row.distance) })) };
  }

  private async textCandidates(companyId: string, query: string, collectionIds: string[] | null, limit: number): Promise<Retrieval> {
    const terms = extractSearchTerms(query);
    if (terms.length === 0) return { used: false, candidates: [] };
    const toCandidates = (rows: { id: string; text_rank: number }[]) =>
      rows.map((row) => ({ id: row.id, score: Number(row.text_rank) }));

    const strictParams: unknown[] = [companyId, query, limit];
    const strictScope = collectionScope(strictParams, collectionIds);
    const strict = await this.handle.query<{ id: string; text_rank: number }>(
      `SELECT c.id, ts_rank_cd(c.tsv, q.query) AS text_rank
         FROM knowledge_chunks c, websearch_to_tsquery('simple', $2) AS q(query)
        WHERE c.company_id = $1 AND c.tsv @@ q.query${strictScope}
        ORDER BY text_rank DESC, c.document_id, c.ordinal
        LIMIT $3`,
      strictParams,
    );
    if (strict.length > 0) return { used: true, candidates: toCandidates(strict) };

    // Questions rarely contain only words that all occur in one chunk: match any term (as a prefix)
    // and rank by how many distinct terms a chunk contains, then by cover density.
    const looseParams: unknown[] = [companyId, buildPrefixTsQuery(terms), limit, termQueries(terms)];
    const looseScope = collectionScope(looseParams, collectionIds);
    const loose = await this.handle.query<{ id: string; text_rank: number; matched: number }>(
      `WITH terms AS MATERIALIZED (
         SELECT to_tsquery('simple', t.term) AS query FROM unnest($4::text[]) AS t(term)
       )
       SELECT c.id, ts_rank_cd(c.tsv, q.query) AS text_rank,
              (SELECT count(*) FROM terms WHERE c.tsv @@ terms.query)::int AS matched
         FROM knowledge_chunks c, to_tsquery('simple', $2) AS q(query)
        WHERE c.company_id = $1 AND c.tsv @@ q.query${looseScope}
        ORDER BY matched DESC, text_rank DESC, c.document_id, c.ordinal
        LIMIT $3`,
      looseParams,
    );
    // RRF barely separates list positions, so keep single-word coincidences out of the list when
    // better-covered chunks exist: require at least half the best chunk's term coverage.
    const cutoff = Math.ceil(Number(loose[0]?.matched ?? 0) / 2);
    return { used: true, candidates: toCandidates(loose.filter((row) => Number(row.matched) >= cutoff)) };
  }

  private async chunkDetails(companyId: string, ids: string[]) {
    const rows = await this.db
      .select({
        id: knowledgeChunks.id,
        documentId: knowledgeChunks.documentId,
        collectionId: knowledgeChunks.collectionId,
        ordinal: knowledgeChunks.ordinal,
        content: knowledgeChunks.content,
        chunkMetadata: knowledgeChunks.metadata,
        title: knowledgeDocuments.title,
        uri: knowledgeDocuments.uri,
        documentMetadata: knowledgeDocuments.metadata,
        collectionKey: knowledgeCollections.key,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .innerJoin(knowledgeCollections, eq(knowledgeCollections.id, knowledgeChunks.collectionId))
      .where(and(eq(knowledgeChunks.companyId, companyId), inArray(knowledgeChunks.id, ids)));
    return new Map(rows.map((row) => [row.id, row]));
  }

  // -------------------------------------------------------------------------
  // Internals

  private async indexDocument(companyId: string, document: KnowledgeDocument, text: string, hash: string): Promise<KnowledgeDocument> {
    try {
      const chunks = chunkText(text, this.chunking);
      if (chunks.length === 0) throw new Error("The document contains no indexable text");
      const vectors = await this.embedChunks(document.title, chunks);
      const rows = chunks.map((chunk, i) => ({
        companyId,
        collectionId: document.collectionId,
        documentId: document.id,
        ordinal: chunk.ordinal,
        content: chunk.content,
        embedding: vectors[i] ?? null,
        embeddingModel: this.embedder.model,
        metadata: chunk.metadata,
      }));
      return await this.db.transaction(async (tx) => {
        // Row lock: concurrent (re)indexing of one document replaces chunks one at a time.
        const [locked] = await tx
          .select({ id: knowledgeDocuments.id })
          .from(knowledgeDocuments)
          .where(and(eq(knowledgeDocuments.id, document.id), eq(knowledgeDocuments.companyId, companyId)))
          .for("update");
        if (!locked) throw new KnowledgeError(`Knowledge document ${document.id} was deleted while it was being indexed`, "not_found");
        await tx
          .delete(knowledgeChunks)
          .where(and(eq(knowledgeChunks.documentId, document.id), eq(knowledgeChunks.companyId, companyId)));
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          await tx.insert(knowledgeChunks).values(rows.slice(i, i + INSERT_BATCH));
        }
        const [indexed] = await tx
          .update(knowledgeDocuments)
          .set({ status: "indexed", error: null, chunkCount: rows.length, contentHash: hash, updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, document.id))
          .returning();
        return indexed!;
      });
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === "not_found") throw error;
      const [failed] = await this.db
        .update(knowledgeDocuments)
        .set({ status: "error", error: truncateText(errorMessage(error), MAX_ERROR_CHARS), updatedAt: new Date() })
        .where(and(eq(knowledgeDocuments.id, document.id), eq(knowledgeDocuments.companyId, companyId)))
        .returning();
      if (!failed) throw error;
      return failed;
    }
  }

  /** Embeds chunks in batches. The document title is prepended so every chunk carries document-level context. */
  private async embedChunks(title: string, chunks: Chunk[]): Promise<(number[] | null)[]> {
    const inputs = chunks.map((chunk) => (chunk.content.startsWith(title) ? chunk.content : `${title}\n\n${chunk.content}`));
    const vectors: (number[] | null)[] = [];
    for (let i = 0; i < inputs.length; i += this.embedBatchSize) {
      const batch = inputs.slice(i, i + this.embedBatchSize);
      const embedded = await this.embedder.embed(batch, "document");
      if (embedded.length !== batch.length) {
        throw new Error(`Embedder "${this.embedder.model}" returned ${embedded.length} vectors for ${batch.length} texts`);
      }
      for (const vector of embedded) vectors.push(prepareVector(vector));
    }
    return vectors;
  }

  private collectionsWithCounts(where: SQL | undefined) {
    return this.db
      .select({
        ...getTableColumns(knowledgeCollections),
        documentCount: sql<number>`count(${knowledgeDocuments.id})::int`.mapWith(Number),
        chunkCount: sql<number>`coalesce(sum(${knowledgeDocuments.chunkCount}), 0)::int`.mapWith(Number),
      })
      .from(knowledgeCollections)
      .leftJoin(knowledgeDocuments, eq(knowledgeDocuments.collectionId, knowledgeCollections.id))
      .where(where)
      .groupBy(knowledgeCollections.id);
  }

  private async findCollection(companyId: string, keyOrId: string): Promise<KnowledgeCollection | null> {
    const ref = typeof keyOrId === "string" ? keyOrId.trim() : "";
    if (!ref) return null;
    const rows = await this.db.select().from(knowledgeCollections).where(collectionRef(companyId, ref)).limit(2);
    return rows.find((row) => row.id === ref) ?? rows[0] ?? null;
  }

  private async requireCollection(companyId: string, keyOrId: string): Promise<KnowledgeCollection> {
    const collection = await this.findCollection(companyId, keyOrId);
    if (!collection) throw new KnowledgeError(`Knowledge collection "${keyOrId}" not found`, "not_found");
    return collection;
  }

  /** Collection ids for `collections` (keys or ids) within the company; null = no restriction. */
  private async resolveCollectionIds(companyId: string, collections: SearchOptions["collections"]): Promise<string[] | null> {
    if (collections === undefined || collections === null) return null;
    const list: unknown[] = Array.isArray(collections) ? collections : [collections];
    const refs = [...new Set(list.filter((ref): ref is string => typeof ref === "string").map((ref) => ref.trim()).filter(Boolean))];
    if (refs.length === 0) return [];
    const ids = refs.filter(isUuid);
    const rows = await this.db
      .select({ id: knowledgeCollections.id })
      .from(knowledgeCollections)
      .where(
        and(
          eq(knowledgeCollections.companyId, companyId),
          ids.length > 0
            ? or(inArray(knowledgeCollections.key, refs), inArray(knowledgeCollections.id, ids))
            : inArray(knowledgeCollections.key, refs),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** Rejects references to another company's department or file. */
  private async assertOwned(companyId: string, kind: "department" | "file", id: string): Promise<void> {
    const table = kind === "department" ? departments : files;
    const [row] = isUuid(id)
      ? await this.db
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.id, id), eq(table.companyId, companyId)))
          .limit(1)
      : [];
    if (!row) throw new KnowledgeError(`Unknown ${kind} ${id}`);
  }
}

/** SQL filter on the collection ids (when restricted), bound as the next positional parameter. */
function collectionScope(params: unknown[], collectionIds: string[] | null): string {
  return collectionIds ? ` AND c.collection_id = ANY($${params.push(collectionIds)}::uuid[])` : "";
}

function collectionRef(companyId: string, ref: string): SQL | undefined {
  return and(
    eq(knowledgeCollections.companyId, companyId),
    isUuid(ref) ? or(eq(knowledgeCollections.id, ref), eq(knowledgeCollections.key, ref)) : eq(knowledgeCollections.key, ref),
  );
}

/**
 * Validates an embedding and rounds it to float4 precision (shorter SQL literals).
 * Returns null for a zero vector, whose cosine distance is undefined.
 */
function prepareVector(vector: number[] | undefined): number[] | null {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding has ${Array.isArray(vector) ? vector.length : 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  let norm = 0;
  const rounded = vector.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Embedding contains a non-finite value");
    norm += value * value;
    return Number(value.toPrecision(9));
  });
  return norm > 0 ? rounded : null;
}

function normalizeQuery(query: string): string {
  const text = normalizeText(typeof query === "string" ? query : "").replace(/\s+/g, " ");
  return text.length > MAX_QUERY_CHARS ? text.slice(0, safeCutIndex(text, MAX_QUERY_CHARS)).trim() : text;
}

function assertUuid(value: string, name: string): void {
  if (typeof value !== "string" || !isUuid(value)) throw new KnowledgeError(`${name} must be a UUID`);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
