# Enterprise Brain

**The enterprise layer for agentic AI transformation, built to extend [Paperclip](https://github.com/paperclipai/paperclip).**

Enterprise Brain is the underlying structure a company needs to put AI agents to work across its departments:

- **Department & process templates** (HR, Finance, Sales, Marketing, Customer Service, Procurement, IT, Legal, Operations, Management and company-wide shared services), each with KPIs, human roles, typical systems and ready-to-run **predefined agents**.
- **Connectors** to enterprise systems: SAP S/4HANA, SAP SuccessFactors, Workday, Microsoft Dynamics 365, Salesforce, HubSpot, Microsoft 365 mail, Gmail, IMAP/SMTP, SharePoint, SQL databases and generic REST APIs. Built-in **sandbox** ERP, CRM, HRIS, ATS and ITSM systems let every template run on day one.
- **One place to manage agents:** versions with rollback, runs with full timelines, human **approvals**, cost tracking and an audit log.
- **The default use cases, ready to use:** conversational AI, enterprise search, knowledge base, mail reading/classifying/replying, document & OCR processing that takes action in your systems, and Excel automation.
- **An Agent Builder for non-technical people.** An AI requirements analyst interviews the user in rounds, each question with a recommended answer. It analyses their sample files itself and drafts the email to IT or the data protection officer when something needs their input. Only after the user confirms does it generate the agent and **its screen**, test it on the samples, and put it live.
- **The platform underneath:** PostgreSQL with pgvector (embedded, zero-install locally), a hybrid-search knowledge base, a Node.js agent runtime powered by **Claude**, file storage and an MCP server.

```text
HR manager: "Every week we receive dozens of CVs at careers@acme.com.tr and through our careers page. I want an
            agent that reads each CV, scores the candidate against the open position and shortlists the best ones."
Analyst:    ❓ Q5 — Where inputs come from? (pick all that apply)   ➡️ Recommended: Email to a mailbox, A form on our website
            ❓ Q2 — Real examples: please upload 3–5 real CVs …     (analyses them: formats, languages, fields)
            ❓ Q5 — Mailbox access: this mailbox isn't connected …  ➡️ Recommended: Ask IT on my behalf
            → drafts the email to IT (with an answer link) and to the data protection officer
            → "Here's what we agreed … Reply confirm and I'll build the agent and test it on your samples."
            → generates the CV screener, tests it on the samples, activates it at /apps/cv-screener
```

## Quick start

Requirements: **Node.js 22.12+** and **pnpm 9**.

```bash
pnpm install
pnpm build          # builds the web console
pnpm start          # http://localhost:3200
```

On first start, Enterprise Brain creates the demo company **Acme Endüstri A.Ş.**:

- the six use cases and four departments (HR, Finance, Customer Service, IT) installed with active agents
- a knowledge base of company policies in English and Turkish
- sandbox mailboxes with job applications (PDF/DOCX CVs), supplier invoices generated from the sandbox ERP's purchase orders, customer emails and IT requests

**Claude:** set `ANTHROPIC_API_KEY` (default model `claude-opus-5`). Without it, everything still works in a clearly labelled **offline mode** with deterministic fallbacks. See `.env.example` for all settings (Postgres, embeddings, API keys, Paperclip).

Development: `pnpm dev` runs the API with watch mode, and `pnpm dev:web` runs the console on http://localhost:5173 with the API proxied. Run the tests with `pnpm test` and the type checks with `pnpm typecheck`.

## Try it

1. **Agent Builder** → *New agent*. Paste the HR manager's description above, answer the rounds (or click *Use recommendation*), attach the demo CVs, and say "I don't know — ask IT" for mailbox access. Open the drafted request, answer it through its link as if you were the IT director, then confirm and activate.
2. **Inbox** → *careers@…* → process an application with the CV screener. Or open *invoices@…* and watch the invoice processor run a 3-way match against the sandbox ERP and wait for your approval before posting.
3. **Approvals**: approve or reject what agents want to do in other systems.
4. **Assistant**: "How many days of annual leave do I get?" / "Yıllık izin hakkım kaç gün?", answered with citations.
5. **Catalog**: install another department (Legal, Procurement…) and see its processes and agents.
6. **Paperclip**: export the organisation as a Paperclip company, or push it directly.

## How it fits with Paperclip

Paperclip is the control plane for AI-agent companies: org charts, goals, tasks, heartbeats, budgets and governance. By design it doesn't run agents or hold knowledge. Enterprise Brain extends it **without forking** through four official extension points:

| | Integration | Result in Paperclip |
|---|---|---|
| 1 | **Company package** (`agentcompanies/v1`) | Departments → projects and lead agents; specialists → employees; scheduled processes → routines; plus the `enterprise-brain` skill |
| 2 | **`hermes_gateway` adapter** | Paperclip heartbeats run Enterprise Brain agents synchronously, with output, usage and cost |
| 3 | **Plugin** (`plugins/paperclip-plugin`) | Knowledge search, specialist agents and approvals as tools for every agent; an Enterprise Brain page and dashboard widget |
| 4 | **MCP server** (`/mcp`) | Governed access to SAP, Salesforce, sandbox systems and knowledge |

See [docs/PAPERCLIP.md](docs/PAPERCLIP.md).

## Repository

```text
apps/server          Fastify API, SSE, Agent Builder, stakeholder pages, Hermes gateway, MCP, demo seed
apps/web             React console (Vite, Tailwind)
packages/core        Domain model & schemas, safe template/expression engine
packages/db          Drizzle schema + migrations (PGlite or PostgreSQL, pgvector, full-text)
packages/llm         Claude client (structured outputs, tool loop, fallbacks, cost), embeddings
packages/documents   PDF/DOCX/XLSX/CSV/HTML extraction, OCR via Claude vision, heuristics, Excel
packages/knowledge   Chunking, embeddings, hybrid retrieval (RRF)
packages/connectors  Connector SDK, enterprise connectors, sandbox systems
packages/catalog     Template loader/validator (content lives in /catalog)
packages/runtime     Agents, run engine, approvals, tools, chat, mail, triggers, files, secrets
packages/builder     Agent Builder (requirements analyst)
packages/paperclip   Paperclip package exporter, Hermes contract, API client
plugins/paperclip-plugin   Paperclip plugin
catalog/             Departments, processes, agents (Markdown + YAML), use cases
docs/                Architecture, Agent Builder, Paperclip, API, templates, connectors, ADRs
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): layers, domain model, execution model, security, deployment
- [Agent Builder](docs/AGENT-BUILDER.md): the interview technique, stakeholder routing and generation
- [Paperclip integration](docs/PAPERCLIP.md)
- [Templates](docs/TEMPLATES.md): authoring departments, processes and agents
- [Connectors](docs/CONNECTORS.md): the connector SDK and built-in systems
- [HTTP API](docs/API.md)
- [Decisions (ADRs)](docs/adr)

## Status

This is a working foundation: every capability above is implemented and covered by automated tests, which run offline with a scripted LLM for the Claude paths. These parts are not yet proven in production:

- The **Claude-powered paths** (analyst interview, extraction, evaluation, chat, OCR) have been exercised with a scripted model that honours the same structured-output schemas, but not yet against the live API. Run the Agent Builder scenario once with `ANTHROPIC_API_KEY` set before a customer demo.
- **PostgreSQL server mode** (`DATABASE_URL`) and the **Docker image** have not been run yet. The test suite uses embedded PGlite (PostgreSQL 18 in WebAssembly, with pgvector) and the same migrations.
- The enterprise connectors are **preview**: built from vendor API documentation and tested against recorded request/response contracts, but not against live tenants. Verify each one in the customer's environment.
- The Paperclip integration follows Paperclip's source at the time of writing (plugin SDK `2026.916.1`, `hermes_gateway` contract, `agentcompanies/v1` import rules). It is covered by contract tests, including Paperclip's own YAML parser and the SDK's test harness, but has not yet run against a live Paperclip instance.
