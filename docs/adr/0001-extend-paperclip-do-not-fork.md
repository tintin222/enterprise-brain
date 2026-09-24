# ADR 0001: Extend Paperclip, don't fork it

**Status:** accepted · 2026-09-24

## Context
We want Paperclip's approach to AI-agent organisations: org charts, goals, tasks, heartbeats, budgets and governance. On top of it, enterprise customers need department and process templates, connectors to their ERP/CRM/HR systems, a knowledge base, document/OCR/mail/Excel capabilities and no-code agent creation.

Paperclip is a large, fast-moving MIT project (7,700+ files, daily releases). Its own product definition keeps the core thin: "Use plugins for edge cases like rich chat, knowledge bases, doc editors" and "The control plane doesn't run agents. It orchestrates them." Its plugin runtime also has hard limits:
- no `CREATE EXTENSION`, so no pgvector
- 10–60 s tool timeouts
- agents can only be created as manifest-declared managed resources

## Decision
Enterprise Brain is a **separate service (the enterprise layer and execution plane)** that integrates with Paperclip only through its public extension points:
1. **Agent Companies packages** for the org structure (departments, agents, recurring processes, skill).
2. The built-in **`hermes_gateway` adapter**, which hires Enterprise Brain agents as Paperclip employees.
3. A **Paperclip plugin** for agent tools and UI surfaces.
4. An **MCP server** for governed tool access to enterprise systems and knowledge.

Enterprise Brain also runs standalone, with its own console, so it can be sold and demoed without Paperclip.

## Consequences
- We follow Paperclip releases without merge work, but pin the plugin SDK version (its API is alpha).
- Some duplication, such as agent status in both systems. Paperclip is the org-level source of truth; Enterprise Brain owns agent definitions and execution.
- Heavy work (OCR, long workflows, approvals that take days) stays out of Paperclip's short-lived plugin calls.
