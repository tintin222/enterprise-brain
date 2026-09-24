# ADR 0005: The Agent Builder interviews in grilling rounds and routes gaps to stakeholders

**Status:** accepted · 2026-09-24

## Context
Business users know their process, but not integrations, data protection or edge cases. Free-form "describe your agent" prompts produce confident but incomplete agents. We want the behaviour of an experienced analyst.

## Decision
Adopt the *grilling* technique:
- a design tree of requirement nodes, asked in rounds over the frontier, each question with a recommended answer
- facts are found by the system, decisions are made by the user
- an explicit confirmation gate before anything is built

Extend it for organisations with *to-questionnaire*: when the requester can't answer, the node is delegated to a stakeholder role (IT, the DPO, Legal…). A drafted email and a tokenised answer page collect the answer asynchronously. The frontier is computed deterministically; the LLM phrases questions, interprets replies, analyses samples and synthesises the final agent.

## Consequences
- The interview order is reproducible and testable.
- Round size is capped for non-technical users (default 5, configurable down to one question at a time). This deviates from "ask the whole frontier".
- Integrations can be requested in parallel while the agent runs on manual uploads or sandbox systems.
