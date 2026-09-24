-- Optional indexes for large production knowledge bases on PostgreSQL + pgvector >= 0.8.
-- Run once with psql against the Enterprise Brain database.

-- Approximate nearest-neighbour search over chunk embeddings (cosine distance, as used by search()).
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- Company / collection / embedding-model filters are applied after the ANN scan. Iterative scans keep
-- filtered queries from returning short result lists. Replace the database name with yours:
-- ALTER DATABASE enterprise_brain SET hnsw.iterative_scan = 'relaxed_order';
