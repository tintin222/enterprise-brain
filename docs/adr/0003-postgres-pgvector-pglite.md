# ADR 0003: PostgreSQL + pgvector, with embedded PGlite for local installs

**Status:** accepted · 2026-09-24

## Context
We need relational data, vector search and full-text search. Installation must be frictionless for demos and pilots, and standard for production.

## Decision
Use PostgreSQL through Drizzle, with pgvector (`vector(1024)`) and generated `tsvector` columns. When `DATABASE_URL` is unset, use **PGlite** (Postgres 18 compiled to WASM, with the pgvector extension) under `.data/db`. The SQL and migrations are identical in both modes. Embeddings are fixed at 1024 dimensions, which Voyage, OpenAI and our offline embedder all support, so providers can be switched without a schema change.

## Consequences
- `pnpm start` works on any machine with Node 22, with no Docker.
- The Paperclip plugin can't host pgvector, which is one more reason Enterprise Brain runs as its own service (ADR 0001).
- For large corpora, apply the HNSW index script (`packages/db/sql/production-indexes.sql`).
