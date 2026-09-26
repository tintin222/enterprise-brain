# ADR 0004: Deterministic fallbacks when no LLM is configured

**Status:** accepted · 2026-09-24

## Context
Sales demos, CI, air-gapped pilots and customer IT security reviews often happen before an LLM key is approved.

## Decision
Every LLM-backed feature has a clearly labelled deterministic fallback:
- heuristic field extraction
- keyword classification and evaluation
- template text generation
- retrieval-only chat
- the analyst's standard question bank with an EN/TR reply parser
- template-based stakeholder emails

The UI shows **"Offline mode"**. Claude (`claude-opus-5-5` by default) is used automatically as soon as credentials are present.

## Consequences
- Everything is testable end to end without network access. The test suite runs offline and uses a scripted LLM for the Claude paths.
- The fallbacks are intentionally simple, and their results say so (for example, "review recommended").
