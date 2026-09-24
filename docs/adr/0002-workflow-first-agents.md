# ADR 0002: Workflow-first agents with autonomous steps

**Status:** accepted · 2026-09-24

## Context
Most departmental processes are structured: read a document, extract fields, check rules, update a system, notify someone. They need to be auditable, cheap, and explainable to auditors and works councils. Fully autonomous agents are flexible, but harder to predict and to govern.

## Decision
An agent is a typed **workflow** (`extract`, `llm.extract`, `llm.classify`, `llm.evaluate`, `llm.generate`, `knowledge.search`, `connector`, `approval`, `mail.send`, `excel.*`, `output`). Open-ended work runs in explicit **`agent` steps**: a Claude tool loop over declared capabilities. Chat and Paperclip tasks use the same loop. Evaluation scores are **aggregated in code** from per-criterion LLM judgements with evidence, so a verdict can always be traced back.

## Consequences
- Templates are readable by business analysts and can be validated statically (see the catalog validator).
- The builder can generate agents deterministically from answers.
- Every LLM step has an offline fallback, so the platform works without an API key.
- Some flexible scenarios need an `agent` step or an extra step type.
