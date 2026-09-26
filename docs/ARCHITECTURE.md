# Enterprise Brain: architecture

Enterprise Brain gives a company **AI employees**: agents with a job, a manager, duties, access and a probation level, that department managers hire in a Studio and that work on their own in the company's mailboxes and systems, handing a person whatever needs one. One installation serves one company; people sign in with their Microsoft 365 or Google accounts, and the app has seven places: **Home, Company, Hire, Work, Mail, Apps and Settings**.

Underneath, it gives the company:

- templates of its **departments**, their **processes** and ready-made **AI employees** (agent templates)
- **connectors** to its systems of record (ERP, CRM, HRIS, ATS, ITSM, mail, file storage, databases)
- a **knowledge base** with hybrid retrieval
- an **agent runtime** with human approval gates and a full audit trail
- the **default use cases** (conversational AI, enterprise search, knowledge base, mail triage, document & OCR processing, Excel automation)
- an **Agent Builder** in which a non-technical employee describes an agent and an AI analyst interviews them until the agent can be generated, tested and deployed

It can also **extend [Paperclip](https://github.com/paperclipai/paperclip)**, not fork it; that export is optional. Paperclip is the control plane for AI-agent companies: org charts, goals, tasks, heartbeats, budgets and governance. Enterprise Brain provides the enterprise specifics that Paperclip deliberately leaves to extensions. Paperclip's `doc/PRODUCT.md` says "put optional chat, knowledge, and special surfaces into plugins/extensions" and "the control plane doesn't run agents".

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
| `packages/screens` | Old systems without an API, worked through their screens: Claude's browser use and computer use toolsets run on a headless Chromium (Playwright), with the system's addresses only, reads that can't send changes, and sign-ins the AI never sees. |
| `packages/catalog` | Department, process, agent and use-case templates, stored under `/catalog` as YAML and Markdown, with a validating loader and a template search. |
| `packages/runtime` | Platform services: agents and versions, the run engine, approvals, tools, chat, files, encrypted secrets, the connector service with sandbox fallback, mail, triggers and scheduler, and catalog installation. |
| `packages/builder` | The Agent Builder: requirement tree, analyst, stakeholder requests, generation, testing, refinement and deployment. |
| `packages/paperclip` | Paperclip integration: company-package exporter, Paperclip-compatible YAML, the Hermes gateway contract and an API client. |
| `apps/server` | Fastify server with the REST API, SSE streams, public stakeholder pages, Hermes gateway, MCP endpoint and demo seed. |
| `apps/web` | The app, in seven places: **Home** (what needs me, what my AI employees did today, a box to give work), **Company** (departments with their people and AI employees, each AI employee's page), **Hire** (the Studio and ready-made AI employees), **Work** (the work queue and every task), **Mail** (the shared mailboxes AI employees follow, each email with what the AI employee did with it: all of them for managers and IT, their departments' ones for everyone else), **Apps** (tables, apps and calculations) and **Settings** (connections and their actions, knowledge, people and roles, costs, building, audit log, installation, the Paperclip export). |
| `plugins/paperclip-plugin` | Paperclip plugin with agent tools, an Enterprise Brain page and a dashboard widget. |

## 2. Domain model

Every table is **company-scoped**, the same rule Paperclip follows. One deployment can serve several companies with isolated data.

| Table | Purpose |
|---|---|
| `companies` | Tenants (one per installation in practice), with company settings such as the AI mailbox |
| `users`, `sessions`, `department_members` | People, their sign-in sessions, and the departments they work in (as manager or worker) |
| `departments`, `processes` | The installed operating model (template snapshots) |
| `agents`, `agent_versions` | AI employees: their job (definition), manager, probation level, limits and monthly budget. Every change to the job is a new version and can be rolled back. |
| `tasks`, `task_events` | Work from start to finish: status, what it waits for, its next check, its history |
| `runs`, `run_events` | Executions behind tasks, with their persisted workflow state and an append-only event log |
| `approvals` | Changes an AI employee wants to make that a person decides (with the reason, and corrections) |
| `work_items` | The rest of the work queue: questions, checks of a Shadow AI employee's work, failures, notices |
| `watch_cursors` | Where each watched mailbox or system was last read |
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
| `llm.evaluate` | Subject → per-criterion judgement with evidence → **deterministic** weighted score and verdict | Keyword evidence (a criterion's `blockers` are checked first) |
| `llm.generate` | Prompt → text | `fallback` template |
| `knowledge.search` | Query → hits plus numbered context | Same (hybrid retrieval) |
| `connector` | Operation on a bound system. Writes are approval-gated. | Same (sandbox by default) |
| `approval` | Pauses for a human decision, saying why when it has a `reason` | Same |
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
  - Whether a change (an email sent, a write in a connected system) goes to a person follows one policy (`packages/runtime/src/policy.ts`): an action IT marked "a person approves every use" always asks; a workflow step's explicit `requiresApproval` comes next (`false` means a person approved it earlier in the workflow); **Shadow** and **Supervised** AI employees hand every change to a person; a **Trusted** one asks only for what its job always asks about and for anything above its manager's limits (amount and currency, changes a day, email domains). `approval` steps always pause.
  - In workflows, a change that needs a person **pauses** the run. The decision is recorded (with the person's corrections, if any), the approved action executes, and the run continues.
  - In autonomous steps and chat, write tools create **deferred approvals**. The action executes when a human approves it, so the agent never blocks.
- **Test runs** never touch real systems, whatever approved them: writes and emails become dry runs (the result says what would have been done) and decisions auto-approve. A test run may run a version of the job that isn't live (a coaching proposal), and reuse what an earlier task's waits, decisions and writes returned (replays).
- **Triggers.** A mailbox trigger routes each inbound message to every matching active agent as `input.email`, with attachments as file ids. A 5-field cron scheduler with time zones handles schedules. Webhooks, chat and Paperclip heartbeats also start runs.
- **Task mode.** A free-form task, such as a Paperclip issue, runs as one autonomous step with all of the agent's tools and connectors.
- **Events.** An append-only `run_events` table, streamed to the console and to Paperclip over SSE.
- **Cost.** Every Claude call returns token usage and USD cost (cache reads and writes priced), aggregated per run and per company.

## 5. AI employees at work

- **People and permissions.** People sign in with Microsoft 365 (Entra ID, one tenant), Google Workspace or a password (`EB_AUTH=accounts`, the default). Permissions follow departments: people see their own departments' AI employees, tasks and data; managers run their departments' AI employees; admins (IT) run the installation. Unsafe requests from other sites are refused (`Sec-Fetch-Site`/`Origin` checks), and conversations with AI employees are private to the person who started them. `EB_AUTH=open` turns sign-in off for local trials and the Paperclip bundle.
- **Employment.** Each AI employee has a manager, a **probation level** (Shadow, Supervised, Trusted) with limits for Trusted, a monthly budget (at the limit it stops starting work and tells its manager; a department's budget holds all its AI employees together the same way, counted from the first of the month in the company's time zone) and **duties**: its triggers in plain words ("Reads every email sent to careers@… with an attachment"). Duties run only while it is at work (active).
- **Tasks.** Every piece of work is a task with a reference (`EB-7K2Q9`) that also goes into the subject of every email it sends. A task can wait for a reply or a time ("when the supplier replies, or in 3 days"), and wakes when the reply arrives (matched by reference, then by thread) or when its next check comes; the scheduler checks every minute. Managers pause, resume, stop and retry tasks. AI employees working autonomously use task tools to note progress, wait for a reply, schedule a follow-up, finish, or ask a person.
- **The work queue** is everything that needs a person in one list: approvals, questions, checks of a Shadow AI employee's finished tasks, failures and notices. An item is for one person (often the manager) or for anyone in the AI employee's department. Answers wake the task; a check marked wrong, a correction before approving and a rejection with a reason become **coaching notes** on the AI employee.
- **Coaching with replay.** People of the department mark a finished task as wrong and say why, in plain words; that, and the notes above, are corrections (`coaching_notes`). The AI employee's manager asks the Studio to turn them into rules: the coach (`packages/builder/src/coaching.ts`) writes each lesson as a short rule, adds the rules to the instructions under *Rules from coaching*, and changes the job itself where following the rule needs it (category keywords, criteria, conditions), as JSON Patch that can't touch the address, triggers, connections or model. It then **replays** recent tasks with the proposal, the corrected ones first: each is run again as a test run with the task's original input, reusing what the original task's waits (replies), people's decisions and writes (a case number) returned, so nothing is sent or changed. The replay compares the results shown first (by output field: outcome or wording) and the people it would now ask, or the changes it would now make. The manager publishes the proposal as the next version, or keeps the one it has; the notes become rules in that version (or are closed as kept). A proposal made from an older version can't be published, and a newer proposal replaces one nobody decided on. Without a model the rules are the people's own words, and the offline heuristics don't read instructions, so the replay says so.
- **Performance reports** (`packages/runtime/src/reports.ts`) measure AI employees against the product's targets: the share of finished tasks nobody had to approve, answer, check or retry (70% for Trusted AI employees), the median time people take to handle a work-queue item in working hours (under 4; the company's working days and hours in its time zone, across daylight saving changes), the share of finished tasks later marked as wrong (under 5%), cost per finished task, and how long hiring took (a ready-made AI employee at work within a day, a Studio-built one within a week). Managers see their departments on *Company → Performance* with an eight-week trend; each AI employee's page shows its last four weeks.
- **Following mailboxes and systems.** A watcher checks every connected mailbox (Microsoft 365, Gmail, IMAP) and every watched system action for new items each minute, remembers where it stopped, and starts the matching duties. People also give work by forwarding an email to the AI mailbox (`ai@…`, naming the AI employee in the subject or as `ai+slug@…`).
- **Tables** (`packages/runtime/src/tables.ts`). People describe what to keep track of ("supplier complaints: supplier, order number, problem, status, owner") and the Studio proposes the table (`packages/builder/src/tables.ts`: with Claude, or from the words alone). Records live in the platform's own database as JSONB (`data_tables`, `data_records`), so a table needs no migration or deployment: every value is checked against its field (`packages/core/src/tables.ts`), each record is numbered in its table, and every change is kept with who made it and in which run (`data_record_changes`). A department's people see and change its tables; its managers change the tables themselves, and a change to a field's kind converts the records' values or changes nothing. AI employees reach the tables through the company's **Tables connection**, which the platform keeps in step (`find_`, `get_`, `add_`, `update_<table>`), so their changes follow the probation level, are left out of test runs and are replayed like any other system's.
- **Apps** (`packages/core/src/apps.ts`, `packages/runtime/src/apps.ts`). People say what the screens are for ("log a complaint, see the open ones by supplier, close them") and the Studio proposes pages of blocks (`packages/builder/src/apps.ts`), with the table the app needs when there is none. An app is data (`data_apps`): lists with filters, groups and actions that change a record or give it to an AI employee, forms, boards whose columns are a choice, charts and numbers summarised in the database, buttons that give an AI employee work, text. The web app draws it from its own components, so sign-in, permissions (each block shows only what the viewer may see of its table), the phone layout and the audit log come with it; nothing is generated as code or deployed. Every app is checked against its tables and AI employees when it is saved, and each block has a plain-words description people check before it is made.
- **Calculations** (`packages/runtime/src/calculations.ts`, `packages/builder/src/calculations.ts`). People say the rule; the Studio writes JavaScript for it (Claude, retrying with the error when the code fails on the real rows; offline, rules of the usual shapes are read from the words), tries it on the tables' rows and shows the result and how it works in plain words, never the code. The code runs in `packages/sandbox`: QuickJS compiled to WebAssembly, a fresh engine per run from a module compiled once, given the rows as data and nothing of the server (no network, files, timers, modules or host functions), stopped after 5 seconds, with its WebAssembly memory capped at 64 MB (so running out stops the calculation, not the server) and its result at 5 MB; two run at once. Every run is kept (`data_calculation_runs`) with its result or what went wrong; the scheduler runs daily, weekly and monthly calculations at 07:00 in the company's time zone, once per period. Heavier data work (Python with pandas on large files) can later go to a hosted sandbox such as E2B or Daytona behind the same contract.
- **Changes in plain words** (`packages/builder/src/changes.ts`). Whatever was built is changed the way it was made: by saying what should change. A table change ("rename Done to Closed, add Root cause, make Owner required") becomes the table as it would be, the changes said back in plain words, and the records that wouldn't fit (checked on the real records, nothing kept); an app change becomes its new pages, checked against the tables; a calculation change becomes the rule as it now reads, worked out again on today's rows next to the current result; a change to an AI employee is kept as a coaching note and goes through coaching (rules, a new version, replayed on recent tasks). Nothing changes until the person who may change it says so, and the change is a new version like any other. With Claude the change is read by the model (keeping the keys of what stays, so records and blocks keep their values); offline, the usual sentences (add, take away, rename, make … required, make … a number, a chart of … by …, this year instead) are read from the words.
- **The one box** (`packages/builder/src/needs.ts`, `apps/server/src/routes/needs.ts`). "What do you need?" on Home is the first place to go. The request is read as work for an AI employee now or regularly, an answer from the company's knowledge, a calculation on the tables, a table, an app, a new AI employee, a change, or, when it can't tell, one question back; the person sees the reading in a sentence (with the other readings one click away) and says go. Nothing new runs it: work goes to the AI employee whose job fits as a task; recurring work (`recurring_work`, `packages/runtime/src/recurring.ts`) is given as a task on its schedule in the company's time zone; answers come from the company assistant; a calculation is worked out at once and can be kept; tables and apps open the Studio's proposal with the words in it; an AI employee starts a Studio interview (the only place questions are asked), except one that files emails into a table: that job needs one answer, the mailbox, so it is hired directly (`packages/builder/src/intake.ts`: read each email, pick out the table's fields, add the record through the Tables connection, a person approving each at first); a change opens where it is made, already worked out.
- **The rules for building** (`apps/server/src/auth/building.ts`, `packages/runtime/src/reviews.ts`, `packages/runtime/src/versions.ts`). IT sets who builds (department managers by default, everyone for their own department, or only IT, plus people it names) in the company's settings. A table's fields marked personal data take no values until the data protection officer approves them (`data_tables.approved_personal`; the rest of the table works meanwhile, and AI employees meet the same check through the Tables connection); sharing a table or an app with the whole company waits for IT (`build_reviews`). Each table, app and calculation keeps every version as it was (`data_versions`), with what changed from the one before in plain words; going back makes a new version, and a table's choice values renamed since are renamed back in every record. IT's inventory lists everything built (tables, apps, calculations, AI employees, recurring work) with its owner, department, version and what waits.
- **Named actions.** IT turns any web service (from an OpenAPI/Swagger description or example calls) or database (named queries with `:param` values; PostgreSQL, SQL Server, MySQL and Oracle, which needs no Oracle client software) into named actions, each marked read or write, optionally "a person approves every use" or watched for new items. AI employees see only those actions, in plain words.

## 6. The Studio (Agent Builder)

See [AGENT-BUILDER.md](AGENT-BUILDER.md). In short, it implements the *grilling* technique for non-technical users:

- The requirements form a **design tree**.
- Each **round** asks the current **frontier**, the questions whose prerequisites are settled, each with a recommended answer.
- **Facts are the analyst's job:** it analyses uploaded samples itself and checks which systems are connected.
- **Decisions are the user's.**
- Questions the user can't answer go to the right **stakeholder** (IT, the DPO, Legal) as a drafted email plus a public questionnaire link, and the answers flow back into the tree.
- Nothing is generated until the user **confirms** the shared understanding.
- A catalog template adds its own questions and can **replace** generic ones, so nothing is asked twice.
- Generation starts from the matching catalog template (or an archetype blueprint), applies every answer and tests the agent on the samples. The user then refines it in chat (applied as JSON Patch, so only the requested change is made) and activates it.
- The Studio **hires** an AI employee: the signed-in manager is its manager, it joins their department, and it starts at the probation level agreed in the interview (Supervised is recommended). While the manager answers, the Hire screen shows its job description in plain words: its duties, what it needs from other teams and where each request stands, what it must never do, its level, and the samples it was tried on. It is hired on trial ("testing") and its duties start when the manager puts it to work.

## 7. Knowledge & search

- **Chunking** follows headings and paragraphs; each chunk carries its heading.
- **Embeddings** are 1024-dimensional so providers can be swapped without a schema change. Options are Voyage AI (`VOYAGE_API_KEY`), OpenAI (`OPENAI_API_KEY`) or the offline hashing embedder.
- **Retrieval** fuses vector similarity (pgvector) and Postgres full-text ranking (`tsvector`, `simple` configuration, which works for Turkish and English) with reciprocal rank fusion.
- Search is always filtered by company, collection and embedding model.
- Answers cite sources as `[n]`.
- For large corpora, apply `packages/db/sql/production-indexes.sql` (HNSW).

## 8. Connectors

- A connector is a manifest plus an implementation. The manifest declares the config fields (secret ones are encrypted), typed operations (read/write, with a JSON Schema input) and events. It also lists `itRequirements`, which the Agent Builder copies into IT requests.
- Agents bind *categories* (`erp`, `crm`, `ats`, …) rather than specific products. A binding resolves in this order: the configured instance, the first connected system of that category, then the **sandbox** system. Every template therefore works out of the box on demo data and switches to the real system as soon as IT connects it.
- Operations are exposed to Claude as tools (`erp__get_purchase_order`), to workflows as `connector` steps, and to Paperclip and other MCP clients through the MCP server (read operations only).
- **Systems without an API** are worked through their screens (the `screen` connector, `packages/screens`). IT writes each action in plain words; the runtime gives the connector a screen operator that opens a fresh browser context, lets Claude work the pages with its browser use toolset (or a desktop program in a remote desktop page with computer use) until it calls `finish`, and returns the values, a summary, the steps and the last screen. The guards sit in the browser, not in the prompt: requests go only to the system's hosts, a read's requests that send data are blocked, and the password is typed by the browser where Claude writes `{{password}}`, only into a password field. The model use counts in the run's cost. See [CONNECTORS.md](CONNECTORS.md).

## 9. LLM usage (Claude)

- **Model and settings.** The default model is Claude Opus 5.5, `claude-opus-5-5` (`EB_LLM_MODEL` overrides it). Requests use adaptive thinking, which Opus 5.5 always does, and are always streamed. Effort is set per purpose: `low` for extraction, classification and question phrasing; `medium` for evaluation and generation; `high` for autonomous agents and for synthesising the final agent. A call that sets none gets `medium` (`EB_LLM_EFFORT` overrides it), so it never depends on the API's default, which differs by model. No request forces a tool (`tool_choice` `any`/`tool` is rejected by Opus 5.5): structured results use structured outputs. Tool loops ask for the model's notes between tool calls (`thinking.display: "updates"`), which Opus 5.5 returns as thinking blocks, and show them in the run's timeline. Computer use goes through the computer toolset. Cost reports price cache reads per model ($0.20 per million tokens on Opus 5.5).
- **Structured outputs** (`output_config.format`) back every analysis the builder and the runtime consume.
- **Refusal fallbacks** use the server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Prompt caching is automatic (`cache_control`).
- **Browser and computer use.** Screen connections use the client toolsets `browser_toolset_20260801` and `computer_toolset_20260801` (`LlmClient.operate`): member calls in a turn run in order, the rest of a batch is answered with the toolset's halt text after a failure, every result echoes `toolset_name`, and screenshots stay in the history (1280×800, within the image limits; removing old ones would invalidate later thinking), each job being bounded by its steps. `EB_SCREENS_MODEL` picks the model for them.
- **Offline mode.** Without credentials, every feature still works with deterministic fallbacks and says so. This covers demos, CI and air-gapped installs.

## 10. Security & governance

- People sign in (`EB_AUTH=accounts`, the default); see section 5. Machines (MCP clients, scripts) send `EB_API_KEY` as a bearer key. In `EB_AUTH=open` mode (local trials, the Paperclip bundle), setting `EB_API_KEY` protects the API with the key instead. Paperclip authenticates to the Hermes gateway with a shared key: `EB_HERMES_API_KEY`, else `EB_API_KEY`, else a key generated once in the data folder (`hermes.key`), so the gateway is never open. Agents pushed to Paperclip get their own Paperclip API keys (stored encrypted), used to update their tasks. Stakeholder answer links are unguessable tokens scoped to a single request.
- Secrets are AES-256-GCM encrypted with a master key taken from `EB_MASTER_KEY` or a generated key file. They are never returned by the API or logged.
- Humans stay in control: probation levels and limits decide which changes go to a person, IT can require a person for any action, tests run without side effects, jobs are versioned with rollback, budgets stop runaway cost, and an audit log records who did what.
- Personal data (KVKK/GDPR): the builder asks about personal data, retention and legal basis, and routes open questions to the DPO. Agents carry these as guardrails. The CV templates exclude protected characteristics from evaluation.

## 11. Deployment

- **One app, one command:** `docker compose up -d` runs Enterprise Brain with PostgreSQL (pgvector), with sign-in on, published on the host's loopback (`EB_BIND` opens it to the network once the admin account exists). Each customer gets its own installation: one app and one database, holding one company.
- **With Paperclip (optional):** `docker compose -f docker-compose.paperclip.yml up -d` runs PostgreSQL (pgvector), Paperclip's official image and Enterprise Brain (without sign-in, like Paperclip's local mode). Paperclip and Enterprise Brain share one network namespace, so each reaches the other at `localhost`: Paperclip's no-login mode and its Hermes adapter both require loopback. A socat container publishes both on the host's loopback. On start, Enterprise Brain connects itself (`EB_PAPERCLIP_AUTOCONNECT`): it pushes the company once, then installs its plugin from a shared volume and configures it. See [PAPERCLIP.md](PAPERCLIP.md#the-bundle-paperclip-and-enterprise-brain-in-one-command).
- **Local:** `pnpm install && pnpm build && pnpm start`. This uses embedded Postgres under `.data/`.
- **Production:** set `DATABASE_URL` to PostgreSQL 15+ with pgvector, plus `EB_PUBLIC_URL`, `EB_API_KEY`, `EB_HERMES_API_KEY`, `EB_MASTER_KEY` and `ANTHROPIC_API_KEY`. Enabling pgvector needs a superuser, so a DBA runs `CREATE EXTENSION vector;` once; the application user then only needs to own its database. Migrations run on start. If the extension is missing, the server stops with that instruction rather than a database error. Serve over HTTPS; Paperclip requires HTTPS for remote Hermes gateways.
- **Scaling:** the server is stateless apart from files on disk (point `EB_DATA_DIR` at shared storage) and in-process run execution. Behind a load balancer, pin runs to the instance that started them, or move execution to a queue (see the roadmap).
