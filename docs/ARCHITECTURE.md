# Enterprise Brain: architecture

Enterprise Brain is the **enterprise layer for agentic AI transformation**. It gives a company:

- templates of its **departments**, their **processes** and **predefined agents**
- **connectors** to its systems of record (ERP, CRM, HRIS, ATS, ITSM, mail, file storage, databases)
- a **knowledge base** with hybrid retrieval
- an **agent runtime** with human approval gates and a full audit trail
- the **default use cases** (conversational AI, enterprise search, knowledge base, mail triage, document & OCR processing, Excel automation)
- an **Agent Builder** in which a non-technical employee describes an agent and an AI analyst interviews them until the agent can be generated, tested and deployed

It is designed to **extend [Paperclip](https://github.com/paperclipai/paperclip)**, not to fork it. Paperclip is the control plane for AI-agent companies: org charts, goals, tasks, heartbeats, budgets and governance. Enterprise Brain provides the enterprise specifics that Paperclip deliberately leaves to extensions. Paperclip's `doc/PRODUCT.md` says "put optional chat, knowledge, and special surfaces into plugins/extensions" and "the control plane doesn't run agents".

```text
┌───────────────────────────── Paperclip (control plane) ─────────────────────────────┐
│ org chart · goals · tasks/issues · heartbeats · budgets · approvals · import/export │
└──────▲──────────────────────────────▲──────────────────────────────▲────────────────┘
       │ ① company package             │ ② hermes_gateway runs        │ ③ plugin tools / MCP
       │   (agentcompanies/v1)        │   (Enterprise Brain agents   │   (knowledge, agents,
       │                              │    hired as employees)       │    approvals, systems)
┌──────┴──────────────────────────────┴──────────────────────────────┴────────────────┐
│                          Enterprise Brain (this repository)                         │
│ Catalog: departments · processes · agents · use cases     Agent Builder (analyst)   │
│ Runtime: workflows · autonomous steps · approvals · triggers · runs · audit         │
│ Knowledge (pgvector + full text) · Documents & OCR · Excel · Mail                   │
│ Connectors: SAP · Dynamics · Salesforce · HubSpot · M365 · Gmail · IMAP · SharePoint│
│             SuccessFactors · SQL · REST · sandbox ERP/CRM/HRIS/ATS/ITSM             │
│ Web console · REST API · MCP server · Hermes gateway                                │
└──────┬──────────────────────────────┬──────────────────────────────┬────────────────┘
       │ Claude (Anthropic API)       │ PostgreSQL + pgvector        │ enterprise systems
       │ structured outputs, tools,   │ (embedded PGlite locally)    │ (or sandbox systems
       │ vision OCR                   │ + file storage               │  with demo data)
```

## 1. Repository map

| Package | Responsibility |
|---|---|
| `packages/core` | Domain model as Zod schemas and types: `AgentDefinition`, `WorkflowStep`, `FieldSpec`, department, process and agent templates, the builder's requirement tree, connector manifests. Also a safe template/expression engine (`{{ steps.evaluate.score }}`, `score >= 70 && …`) with no `eval`. |
| `packages/db` | Drizzle schema, SQL migrations and a client factory. Uses embedded **PGlite** (Postgres 18 in WASM, with pgvector and full-text search) when `DATABASE_URL` is unset, and **PostgreSQL + pgvector** otherwise. The SQL is the same in both modes. |
| `packages/llm` | Claude through the official Anthropic SDK. Covers streaming, adaptive thinking, per-purpose effort, structured outputs, server-side refusal fallbacks, prompt caching and cost accounting. Includes a manual tool-use loop with parallel tool calls, embedding providers (Voyage, OpenAI, local hashing) and a scripted LLM for tests. |
| `packages/documents` | Text extraction from PDF, DOCX, XLSX, CSV, HTML and JSON. OCR of scans and photos uses Claude vision (tesseract.js is optional). Also language and document-type detection (EN/TR and more), offline heuristic field extraction, and Excel read/write. |
| `packages/knowledge` | Collections, structure-aware chunking, embeddings, and hybrid retrieval (vector + `tsvector`) with reciprocal rank fusion. Everything is company-scoped. |
| `packages/connectors` | Connector SDK and built-in connectors. The real ones are **preview** quality and were not tested against live tenants. The sandbox ERP, CRM, HRIS, ATS and ITSM systems ship with demo data. |
| `packages/catalog` | Department, process, agent and use-case templates, stored under `/catalog` as YAML and Markdown, with a validating loader and a template search. |
| `packages/runtime` | Platform services: agents and versions, the run engine, approvals, tools, chat, files, encrypted secrets, the connector service with sandbox fallback, mail, triggers and scheduler, and catalog installation. |
| `packages/builder` | The Agent Builder: requirement tree, analyst, stakeholder requests, generation, testing, refinement and deployment. |
| `packages/paperclip` | Paperclip integration: company-package exporter, Paperclip-compatible YAML, the Hermes gateway contract and an API client. |
| `apps/server` | Fastify server with the REST API, SSE streams, public stakeholder pages, Hermes gateway, MCP endpoint and demo seed. |
| `apps/web` | React console: dashboard, Agent Builder, catalog, agents with generated apps, runs, approvals, inbox, knowledge, assistant, search, connectors and Paperclip. |
| `plugins/paperclip-plugin` | Paperclip plugin with agent tools, an Enterprise Brain page and a dashboard widget. |

## 2. Domain model

Every table is **company-scoped**, the same rule Paperclip follows. One deployment can serve several companies with isolated data.

| Table | Purpose |
|---|---|
| `companies` | Tenants |
| `departments`, `processes` | The installed operating model (template snapshots) |
| `agents`, `agent_versions` | Agent definitions. Every change is a new version and can be rolled back. |
| `runs`, `run_events` | Executions with their persisted workflow state and an append-only event log |
| `approvals` | Human-in-the-loop decisions: workflow pauses and deferred tool actions |
| `connector_instances` | Configured systems. Secrets are AES-256-GCM encrypted and never returned by the API. |
| `sandbox_records` | Data of the built-in sandbox systems |
| `files` | Metadata in the database, bytes content-addressed on disk |
| `knowledge_collections`, `knowledge_documents`, `knowledge_chunks` | Knowledge base. Chunks carry a `vector(1024)` embedding and a generated `tsvector`. |
| `mail_messages` | Inbound and outbound mail (sandbox mailboxes, drafts, sent) |
| `chat_conversations`, `chat_messages` | Conversational AI with citations |
| `builder_sessions`, `builder_messages`, `stakeholder_requests` | Agent Builder state, transcript and requests to other teams |
| `activity_log` | Audit trail of every mutating action |

## 3. Agents

An agent is an `AgentDefinition` with these parts:

- **identity:** `slug`, `name`, `summary`, `department`
- **`archetype`:** one of the default use cases
- **`instructions`:** the system prompt
- **`inputs` / `outputs`:** `FieldSpec[]`. A business-friendly field language from which JSON Schema is derived for Claude's structured outputs.
- **`workflow`:** typed steps
- **`tools`:** capabilities for autonomous steps and chat
- **`triggers`:** manual, form, mailbox, schedule (cron), webhook, chat, paperclip
- **`connectors`:** bindings from aliases such as `ats` or `erp` to a system category and, optionally, a configured instance
- **`knowledge.collections`**
- **`guardrails`:** approval policy, personal-data level, retention, notes
- **`ui`:** the layout of the generated app
- **`kpis`**
- **`tests`:** sample inputs

**Workflow first, autonomy where it helps.** Most enterprise processes are structured: read a document, extract fields, check rules, update a system, notify someone. The runtime executes them as explicit steps, which are deterministic, auditable and cheap. It uses Claude where judgement is needed, and runs an **autonomous tool-use loop** only in `agent` steps and in chat. The step types are:

| Step | Does | Without an LLM |
|---|---|---|
| `extract` | File → text, pages, sheets, language, document type (OCR via Claude vision) | Text layers only |
| `llm.extract` | Text → object following `FieldSpec[]` (structured output) | Heuristic extractor |
| `llm.classify` | Text → category, confidence, reason | Keyword scoring |
| `llm.evaluate` | Subject → per-criterion judgement with evidence → **deterministic** weighted score and verdict | Keyword evidence |
| `llm.generate` | Prompt → text | `fallback` template |
| `knowledge.search` | Query → hits plus numbered context | Same (hybrid retrieval) |
| `connector` | Operation on a bound system. Writes are approval-gated. | Same (sandbox by default) |
| `approval` | Pauses for a human decision | Same |
| `mail.send` | Sends mail through the company's mail connector. Approval-gated by default. | Same (sandbox outbox) |
| `excel.read` / `excel.write` | Reads a workbook / produces an `.xlsx` file | Same |
| `agent` | Autonomous Claude tool loop over the agent's capabilities | Knowledge-only fallback |
| `output` | Assembles the run output | Same |

Values are templates resolved against the run context `{ input, steps, agent, trigger, run }`. `when` guards make any step conditional.

**Explainable decisions.** `llm.evaluate` asks Claude to judge each criterion separately (`yes / partial / no / unknown` plus evidence), with protected characteristics explicitly excluded. The score and verdict are then computed in code:

- a failed **knockout** criterion fails the subject
- a missing or unverifiable **must-have** caps the verdict at `review`
- otherwise the weighted score decides

Every CV score or invoice decision can therefore be traced to evidence.

## 4. Execution

- **Runs** are persisted after every step: completed steps, their results and usage. A run that pauses for approval can resume days later, even after a restart. `resumeInterrupted()` restarts runs left `running`.
- **Approvals.**
  - In workflows, write operations (per the agent's `guardrails.approvalRequiredFor`, by default `mail.send` and `connector:write`) and `approval` steps **pause** the run. The decision is recorded, the approved action executes, and the run continues.
  - In autonomous steps and chat, write tools create **deferred approvals**. The action executes when a human approves it, so the agent never blocks.
- **Test runs** never touch real systems: gated actions become dry runs and decisions auto-approve.
- **Triggers.** A mailbox trigger routes each inbound message to every matching active agent as `input.email`, with attachments as file ids. A 5-field cron scheduler with time zones handles schedules. Webhooks, chat and Paperclip heartbeats also start runs.
- **Task mode.** A free-form task, such as a Paperclip issue, runs as one autonomous step with all of the agent's tools and connectors.
- **Events.** An append-only `run_events` table, streamed to the console and to Paperclip over SSE.
- **Cost.** Every Claude call returns token usage and USD cost (cache reads and writes priced), aggregated per run and per company.

## 5. Agent Builder

See [AGENT-BUILDER.md](AGENT-BUILDER.md). In short, it implements the *grilling* technique for non-technical users:

- The requirements form a **design tree**.
- Each **round** asks the current **frontier**, the questions whose prerequisites are settled, each with a recommended answer.
- **Facts are the analyst's job:** it analyses uploaded samples itself and checks which systems are connected.
- **Decisions are the user's.**
- Questions the user can't answer go to the right **stakeholder** (IT, the DPO, Legal) as a drafted email plus a public questionnaire link, and the answers flow back into the tree.
- Nothing is generated until the user **confirms** the shared understanding.
- Generation starts from the matching catalog template (or an archetype blueprint), applies every answer and tests the agent on the samples. The user then refines it in chat and activates it.

## 6. Knowledge & search

- **Chunking** follows headings and paragraphs; each chunk carries its heading.
- **Embeddings** are 1024-dimensional so providers can be swapped without a schema change. Options are Voyage AI (`VOYAGE_API_KEY`), OpenAI (`OPENAI_API_KEY`) or the offline hashing embedder.
- **Retrieval** fuses vector similarity (pgvector) and Postgres full-text ranking (`tsvector`, `simple` configuration, which works for Turkish and English) with reciprocal rank fusion.
- Search is always filtered by company, collection and embedding model.
- Answers cite sources as `[n]`.
- For large corpora, apply `packages/db/sql/production-indexes.sql` (HNSW).

## 7. Connectors

- A connector is a manifest plus an implementation. The manifest declares the config fields (secret ones are encrypted), typed operations (read/write, with a JSON Schema input) and events. It also lists `itRequirements`, which the Agent Builder copies into IT requests.
- Agents bind *categories* (`erp`, `crm`, `ats`, …) rather than specific products. A binding resolves in this order: the configured instance, the first connected system of that category, then the **sandbox** system. Every template therefore works out of the box on demo data and switches to the real system as soon as IT connects it.
- Operations are exposed to Claude as tools (`erp__get_purchase_order`), to workflows as `connector` steps, and to Paperclip and other MCP clients through the MCP server (read operations only).

## 8. LLM usage (Claude)

- **Model and settings.** The default model is `claude-opus-5` (`EB_LLM_MODEL` overrides it). Requests use adaptive thinking and are always streamed. Effort is set per purpose: `low` for extraction, classification and question phrasing; `medium` for evaluation and generation; `high` for autonomous agents and for synthesising the final agent.
- **Structured outputs** (`output_config.format`) back every analysis the builder and the runtime consume.
- **Refusal fallbacks** use the server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Prompt caching is automatic (`cache_control`).
- **Offline mode.** Without credentials, every feature still works with deterministic fallbacks and says so. This covers demos, CI and air-gapped installs.

## 9. Security & governance

- Local trusted mode is the default. Setting `EB_API_KEY` requires a bearer key on the console API and on MCP. Paperclip authenticates to the Hermes gateway with `EB_HERMES_API_KEY`. Stakeholder answer links are unguessable tokens scoped to a single request.
- Secrets are AES-256-GCM encrypted with a master key taken from `EB_MASTER_KEY` or a generated key file. They are never returned by the API or logged.
- Humans stay in control: approval gates on external actions, test runs without side effects, versioned agents with rollback, and an audit log of every mutation.
- Personal data (KVKK/GDPR): the builder asks about personal data, retention and legal basis, and routes open questions to the DPO. Agents carry these as guardrails. The CV templates exclude protected characteristics from evaluation.

## 10. Deployment

- **Local:** `pnpm install && pnpm build && pnpm start`. This uses embedded Postgres under `.data/`.
- **Production:** set `DATABASE_URL` to PostgreSQL with the pgvector extension available, plus `EB_PUBLIC_URL`, `EB_API_KEY`, `EB_HERMES_API_KEY`, `EB_MASTER_KEY` and `ANTHROPIC_API_KEY`. Serve over HTTPS; Paperclip requires HTTPS for remote Hermes gateways.
- **Scaling:** the server is stateless apart from files on disk (point `EB_DATA_DIR` at shared storage) and in-process run execution. Behind a load balancer, pin runs to the instance that started them, or move execution to a queue (see the roadmap).
