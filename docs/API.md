# Enterprise Brain HTTP API

Base URL: `http://localhost:3200` (configurable with `PORT` / `EB_PUBLIC_URL`).

* **Auth.** When `EB_API_KEY` is set, every `/api/...` and `/mcp` request needs `Authorization: Bearer <EB_API_KEY>` (or `x-api-key`). Public exceptions: `/api/health`, `/api/info`, `/api/public/*` (token-protected stakeholder pages) and `/api/hermes/*` (Paperclip gateway: Bearer Hermes key, which is `EB_HERMES_API_KEY`, else `EB_API_KEY`, else the key generated in `<EB_DATA_DIR>/hermes.key`). Without `EB_API_KEY` the server runs in *local trusted* mode, like Paperclip's `local_trusted`.
* **Companies.** Every domain route is company-scoped: `/api/companies/:company/...`, where `:company` is the slug or id (default slug `acme`).
* **Errors.** Non-2xx responses have the body `{ "error": string, "issues"?: [...] }`.
* **Streaming.** Endpoints marked *SSE* return `text/event-stream`.

## Instance

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ ok, version }` |
| GET | `/api/info` | `{ name, version, llm: {available, provider, model}, embeddings: {model}, database, defaultCompany, publicUrl, authRequired, paperclip: {configured, url} }` |
| GET | `/api/companies` | List companies |
| POST | `/api/companies` | `{ name, slug, mailDomain? }`: create a company. `mailDomain` (e.g. `acme.com.tr`) replaces the templates' placeholder addresses (`careers@company.com`) when agents are installed or built |
| GET | `/api/companies/:company/dashboard` | `{ company, counts: {agents, activeAgents, runs24h, succeeded24h, failed24h, pendingApprovals, departments, knowledgeDocuments, openBuilderSessions}, costMonthUsd, recentRuns[], recentActivity[] }` |
| GET | `/api/companies/:company/activity?limit=` | Audit log entries `{ id, actor, action, entityType, entityId, summary, data, createdAt }` |

## Catalog (templates)

| Method | Path | Description |
|---|---|---|
| GET | `/api/catalog` | `{ departments: DepartmentTemplate[], processes: ProcessTemplate[], agents: AgentTemplateSummary[], useCases: UseCase[] }` |
| GET | `/api/catalog/search?q=` | Ranked template matches for a free-text description |
| GET | `/api/catalog/agents/:id` | Full agent template (id like `hr.cv-screener` or slug) |
| POST | `/api/companies/:company/catalog/departments/:department/install` | `{ processes?: string[], activate?: boolean }` → `{ department, processes[], agents[] }` |
| POST | `/api/companies/:company/catalog/agents/:template/install` | `{ activate?: boolean }` → agent row |
| POST | `/api/companies/:company/catalog/use-cases/:useCase/install` | → `{ useCase, agent }` |
| GET | `/api/companies/:company/departments` | Installed departments with `processes[]` and `agents[] {id, slug, name, status, archetype, processId, source}` |

Template shapes are defined in `packages/core/src/catalog.ts` (`DepartmentTemplate`, `ProcessTemplate`, `AgentTemplate`, `UseCase`). A department has `id, name, icon, summary, mission, kpis[], roles[], systems[], processes[]`. A process has `id, department, name, summary, trigger {type, description}, frequency, steps[] {id, name, actor ("agent:…" | "human:…" | "system:…"), approval}, agents[], kpis[], integrations[], useCases[], value {hoursSavedPerMonth}, maturity`.

## Agents & runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/agents?status=` | Agent rows `{ id, slug, name, summary, archetype, status (draft/testing/active/paused/archived), source (template/builder/manual), templateId, version, departmentId, processId, title, department, triggers, ui, steps, createdAt, updatedAt }` |
| POST | `/api/companies/:company/agents` | `{ definition: AgentDefinition, status? }` |
| GET | `/api/companies/:company/agents/:agent` | `{ agent, definition: AgentDefinition, versions[] {version, note, createdBy, createdAt}, recentRuns[] }` (`:agent` = slug or id) |
| PUT | `/api/companies/:company/agents/:agent` | `{ definition, note? }` → new version |
| POST | `/api/companies/:company/agents/:agent/status` | `{ status }` |
| POST | `/api/companies/:company/agents/:agent/rollback` | `{ version }` |
| DELETE | `/api/companies/:company/agents/:agent` | Delete |
| POST | `/api/companies/:company/agents/:agent/runs` | Start a run. JSON `{ input: {...}, task?: "free-form task (runs with all the agent's tools)", wait?: true, test?: false }` **or** `multipart/form-data`: one part per input field; file parts named after the file field (`cv`, `document`, …); optional `wait`, `test`. Returns the run row. |
| GET | `/api/companies/:company/runs?agent=&status=&limit=` | Runs with `agentName`, `agentSlug` |
| GET | `/api/companies/:company/runs/:run` | `{ run, events[] {seq, type, stepId, message, data, createdAt}, approvals[], agent: {id, slug, name, outputs, ui} }` |
| POST | `/api/companies/:company/runs/:run/cancel` | Cancel |
| GET | `/api/companies/:company/runs/:run/stream` | *SSE*: `event` (run event), `delta` ({delta} streamed text), `end` ({status}) |

A run row: `{ id, agentId, agentVersion, trigger, triggerRef, status (running/waiting_approval/succeeded/failed/cancelled), input, output, error, usage {calls, inputTokens, outputTokens, costUsd}, isTest, currentStep, startedAt, finishedAt, createdAt }`.

`AgentDefinition` (see `packages/core/src/agent.ts`): `slug, name, title, summary, department, archetype, instructions, inputs: FieldSpec[], outputs: FieldSpec[], workflow: WorkflowStep[], tools[], triggers[], knowledge {collections}, connectors[], guardrails {approvalRequiredFor[], personalData, retentionDays, notes}, ui {layout: form-results|chat|inbox|table|none, title, description, submitLabel, resultView, highlight[]}, kpis[], tests[]`. `FieldSpec`: `{ key, label?, type (string|text|number|integer|boolean|date|email|phone|url|select|multiselect|file|files|list|object), required?, options?[{value,label}], description?, accept?[], fields? }`.

## Approvals (human in the loop)

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/approvals?status=pending` | `{ id, runId, agentId, agentName, origin (workflow/deferred), stepId, title, details, action {type: decision|connector|mail.send, …}, status, decidedBy, decisionNote, createdAt, decidedAt }` |
| POST | `/api/companies/:company/approvals/:approval/decide` | `{ approved: boolean, note? }` — resumes the paused run |

## Files

| Method | Path | Description |
|---|---|---|
| POST | `/api/companies/:company/files` | multipart upload → `[{ field, id, name, mimeType, size }]` |
| GET | `/api/companies/:company/files` | Recent files (`metadata.demoSet` marks bundled demo samples) |
| GET | `/api/companies/:company/files/:file?inline=1` | Download |
| GET | `/api/companies/:company/files/:file/meta` | Metadata |

## Knowledge base & search

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/knowledge/collections` | `{ id, key, name, description, documentCount, chunkCount }[]` |
| POST | `/api/companies/:company/knowledge/collections` | `{ name, key?, description? }` |
| DELETE | `/api/companies/:company/knowledge/collections/:collection` | |
| GET | `/api/companies/:company/knowledge/documents?collection=` | Documents `{ id, title, source, status, chunkCount, mimeType, createdAt, collectionId }` |
| POST | `/api/companies/:company/knowledge/documents` | multipart files + `collection` field, or JSON `{ collection, title, text }` |
| GET | `/api/companies/:company/knowledge/documents/:document` | Document with `chunks[]` |
| DELETE | `/api/companies/:company/knowledge/documents/:document` | |
| POST | `/api/companies/:company/knowledge/search` | `{ query, collections?, topK? }` → `{ query, tookMs, embeddingModel, hits: [{ chunkId, documentId, collectionKey, title, content, score, vectorRank, textRank }] }` |

## Connectors (enterprise systems)

| Method | Path | Description |
|---|---|---|
| GET | `/api/connectors/catalog` | Connector manifests `{ type, name, vendor, category, description, auth, config: ConfigField[], operations: [{id, name, description, kind: read|write, input}], maturity (stable|preview|sandbox), itRequirements[] }` |
| GET | `/api/companies/:company/connectors` | Configured instances `{ id, type, name, category, config, secretFields[], status, lastCheckedAt, lastError, sandbox }` |
| POST | `/api/companies/:company/connectors` | `{ type, name?, values: { <configKey>: value } }` (secret values are encrypted, never returned) |
| PUT | `/api/companies/:company/connectors/:id` | `{ name?, values? }` |
| DELETE | `/api/companies/:company/connectors/:id` | |
| POST | `/api/companies/:company/connectors/:id/test` | `{ ok, message }` |
| POST | `/api/companies/:company/connectors/types/:type/operations/:operation` | `{ input }` → `{ result }` (e.g. browse the sandbox ERP) |

## Mail (inbox)

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/mail/mailboxes` | `{ mailbox, total, unprocessed, agents[] }` |
| GET | `/api/companies/:company/mail/messages?mailbox=&direction=&status=` | Messages `{ id, mailbox, direction, fromAddress, fromName, toAddresses, subject, bodyText, attachments[] {fileId, name, mimeType, size}, status (new/processing/triaged/replied/error/draft/sent), classification, runId, receivedAt }` |
| GET | `/api/companies/:company/mail/messages/:id` | `{ message, run, approvals[] }` |
| POST | `/api/companies/:company/mail/messages` | Deliver a message to a (sandbox) mailbox: JSON `{ mailbox, from, fromName?, subject, body, route?: true, attachmentFileIds? }` or multipart with attachments. Matching active agents start automatically. → `{ message, runs[] }` |
| POST | `/api/companies/:company/mail/messages/:id/process` | `{ agent, wait? }` — process with a specific agent |

## Conversational AI

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/chat/conversations?agent=` | Conversations |
| POST | `/api/companies/:company/chat/conversations` | `{ agent?, title? }` (no agent = company assistant) |
| GET | `/api/companies/:company/chat/conversations/:id/messages` | `{ id, role (user/assistant), content (markdown), citations[] {n, title, collection, documentId, snippet}, createdAt }` |
| POST | `/api/companies/:company/chat/conversations/:id/messages` | `{ text }` → assistant message |
| POST | `/api/companies/:company/chat/conversations/:id/messages/stream` | *SSE* `{ text }` → `delta` events, then `message` |

## Agent Builder

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/builder/sessions` | Sessions `{ id, title, status, archetype, templateId, department, requesterName, requesterRole, agentId, createdAt, updatedAt }` |
| POST | `/api/companies/:company/builder/sessions` | `{ description, formDescription?, requesterName?, requesterEmail?, requesterRole?, department?, language? ("en"/"tr"), roundSize? }` → SessionView |
| GET | `/api/companies/:company/builder/sessions/:id` | SessionView |
| POST | `/api/companies/:company/builder/sessions/:id/reply` | JSON `{ text?, answers?: [{ nodeId, action?: answer|accept|delegate|skip, value?, delegateTo? }], fileIds? }` or multipart (`text` + files as samples) → SessionView |
| POST | `/api/companies/:company/builder/sessions/:id/samples` | multipart sample files → SessionView |
| POST | `/api/companies/:company/builder/sessions/:id/reference` | multipart reference docs (added to the agent's knowledge) |
| POST | `/api/companies/:company/builder/sessions/:id/proceed` | Continue with assumptions while stakeholders answer |
| POST | `/api/companies/:company/builder/sessions/:id/confirm` | Pass the confirmation gate: generate + test the agent |
| POST | `/api/companies/:company/builder/sessions/:id/activate` | Put the generated agent live |
| POST | `/api/companies/:company/builder/sessions/:id/reopen` | `{ nodeId }` — reopen a requirement |
| PUT | `/api/companies/:company/builder/requests/:id` | Edit a stakeholder request `{ recipientName?, recipientEmail?, subject?, body? }` |
| POST | `/api/companies/:company/builder/requests/:id/send` | `{ via: "mail" \| "manual" }` |
| GET | `/api/public/requests/:token` | Public stakeholder page data `{ id, status, role, subject, agentName, requesterName, requesterRole, goal, questions[] {nodeId, question, why, answer}, language }` |
| POST | `/api/public/requests/:token/answers` | `{ answers: [{ nodeId, answer }], answeredBy?, note? }` |

**SessionView**: `{ session {id, title, status (interviewing/awaiting-stakeholders/confirming/generating/testing/deployed), description, archetype, templateId, department, language, requesterName, requesterRole, requesterEmail, samples[], agentId, …}, tree {nodes[], states{}}, messages[] {id, role (user/analyst/system), content (markdown), round, data {round?, requestId?, summary?, samples?}, createdAt}, requests[] {id, role, recipientName, recipientEmail, subject, body, questionnaire, questions[], status (draft/sent/answered), token}, currentRound? {number, intro, questions[] {number, nodeId, title, question, why, answerType (single|multi|text|number|boolean|files|fields|criteria|categories), options?[{value,label,description}], recommended, recommendationText, owner, delegable}}, progress {total, settled, delegated, open, percent, bySection}, draft?: AgentDefinition, agent? {id, slug, status, name}, llm {available, provider, model} }`.

## Paperclip integration

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/paperclip/package?scope=installed\|catalog&departments=hr,finance&ceo=true` | `{ files: {path: content}, warnings[], agentSlugs[], specialists[], summary }` |
| GET | `/api/companies/:company/paperclip/package.zip?…` | Same as a zip |
| POST | `/api/companies/:company/paperclip/push` | `{ paperclipUrl?, paperclipApiKey?, target: new_company\|existing_company, paperclipCompanyId?, departments? }` → `{ ok, summary, warnings[], agentKeys, paperclip }`. Imports via Paperclip's API, sets each agent's `hermes_gateway` key, and creates a Paperclip API key per agent (`agentKeys` = how many) |
| GET | `/api/companies/:company/paperclip/connection` | `{ hermes: {apiBaseUrl, apiKey, keySource: env\|api-key\|generated}, paperclip: {url, configured, companyId, agentsWithKeys}, autoConnect: {state: off\|waiting\|connecting\|connected\|failed, message, updatedAt} }` (`autoConnect`: `EB_PAPERCLIP_AUTOCONNECT`, used by the Docker bundle) |
| GET | `/api/hermes/health` | Hermes gateway health (Bearer Hermes key) |
| POST | `/api/hermes/v1/runs` | Hermes contract: `{ agent, company?, input, instructions?, session_id? }` → `{ run_id, status }` |
| GET | `/api/hermes/v1/runs/:id` | `{ run_id, status, output, usage {input_tokens, output_tokens, cached_input_tokens}, cost_usd, model, session_id }` |
| GET | `/api/hermes/v1/runs/:id/events` | *SSE*: `message.delta`, `run.progress`, terminal `run.completed` / `run.failed` / `run.cancelled` |
| POST | `/api/hermes/v1/runs/:id/stop` | Stop |

## MCP

`POST /mcp` (or `/mcp/:company`): stateless Streamable HTTP MCP server. Tools: `knowledge_search`, `list_agents`, `run_agent`, `get_run`, `list_approvals`, and read-only operations of connected and sandbox systems (`erp__get_purchase_order`, `crm__search_accounts`, …).
