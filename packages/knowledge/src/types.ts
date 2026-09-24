import type { knowledgeChunks, knowledgeCollections, knowledgeDocuments } from "@enterprise-brain/db";

export interface SearchHit {
  chunkId: string;
  documentId: string;
  collectionId: string;
  collectionKey: string;
  title: string;
  content: string;
  /**
   * Fused relevance score (higher is better): reciprocal rank fusion of the vector and
   * full-text rankings, normalised to 0..1 where 1 means "ranked first by every
   * retriever that could evaluate the query".
   */
  score: number;
  /** Rank contributions, for debugging/explainability. */
  vectorRank?: number;
  textRank?: number;
  /** Cosine similarity to the query embedding (vector candidates only). */
  vectorScore?: number;
  /** ts_rank_cd of the full-text match (full-text candidates only). */
  textScore?: number;
  /** Position of the chunk within its document. */
  ordinal?: number;
  uri?: string | null;
  /** Document metadata merged with chunk metadata (e.g. `heading`, `headingPath`). */
  metadata: Record<string, unknown>;
}

export interface SearchOptions {
  /**
   * Collection keys or ids; all collections of the company when omitted.
   * An empty array (or only unknown collections) matches nothing.
   */
  collections?: string[];
  topK?: number;
  /** Minimum fused score; hits below are dropped. */
  minScore?: number;
}

export interface IngestTextInput {
  title: string;
  text: string;
  source?: "upload" | "url" | "connector" | "text" | "builder" | "mail";
  uri?: string;
  fileId?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Target maximum characters per chunk (default 1200, minimum 20). */
  maxChars?: number;
  /** Characters of overlap between consecutive chunks (default 150, at most a third of maxChars). */
  overlap?: number;
}

export interface Chunk {
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
}

export type KnowledgeCollection = typeof knowledgeCollections.$inferSelect;

export interface KnowledgeCollectionWithCounts extends KnowledgeCollection {
  documentCount: number;
  chunkCount: number;
}

export interface EnsureCollectionInput {
  key: string;
  name: string;
  description?: string;
  departmentId?: string | null;
}

/** Lifecycle of a knowledge document (`knowledge_documents.status`). */
export type KnowledgeDocumentStatus = "pending" | "processing" | "indexed" | "error";

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;

/** A stored chunk without its (large) embedding and generated tsvector columns. */
export type KnowledgeChunk = Omit<typeof knowledgeChunks.$inferSelect, "embedding" | "tsv">;

export interface KnowledgeDocumentWithChunks extends KnowledgeDocument {
  chunks: KnowledgeChunk[];
}

export interface KnowledgeLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface KnowledgeServiceOptions {
  /** Chunking used when ingesting/reindexing documents. */
  chunking?: ChunkOptions;
  /** Texts per embedder call while indexing (default 64). */
  embedBatchSize?: number;
  /** Receives non-fatal problems, e.g. search degrading to full-text only. Defaults to console.warn. */
  logger?: KnowledgeLogger;
}
