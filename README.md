# Enterprise Brain

**AI employees for every department: hired by the managers who need them, working on their own in your mailboxes and systems, with people in charge.**

An AI employee is an agent with a job, a manager, duties, access and a probation level. A department manager hires one in the **Studio** by answering an analyst's questions; it then follows its mailbox or system by itself, keeps track of its open work for days if needed, and hands a person anything that needs one. Operations workers see what needs them on **Home** and handle it in one click; managers move each AI employee from *Shadow* to *Supervised* to *Trusted* as it proves itself; IT connects the systems and chooses what AI employees may do in them.

- **Five places, each shown to the people who need it.** *Home*: what needs me, what my AI employees did today, a box to give work. *Company*: departments with their people and AI employees, and each AI employee's page. *Hire*: the Studio and 37 ready-made AI employees. *Work*: every task, and everything that needs a person. *Settings*: connections, knowledge, people and roles, costs, audit log, installation.
- **Work on their own.** Duties start by themselves when an email arrives, a set time comes, or a record appears in a connected system. Every piece of work is a task that can wait for a reply ("when the supplier answers, or in 3 days") and wake up again. Anyone can give an AI employee work in plain words, in the app or by forwarding an email.
- **People in charge.** On *Shadow* and *Supervised*, a person approves every change: every email sent and every write to a system. On *Trusted*, the manager sets the limits (amount, currency, changes a day, email domains). Workers can correct a change before approving it, and each correction, reasoned rejection or check marked wrong is kept as a coaching note. Each AI employee has a monthly budget.
- **The Studio.** An AI analyst interviews the manager in rounds, each question with a recommended answer; analyses their sample files; drafts the email to IT or the data protection officer when something needs them; and writes the job description as they answer. Nothing is hired before the manager confirms, and it starts on trial.
- **Connections.** Microsoft 365 and Gmail mailboxes; SAP S/4HANA, SuccessFactors, Workday, Dynamics 365, Salesforce and HubSpot (preview); and **any web service or database** turned into named actions, from an OpenAPI description, a few example calls or named SQL queries. Built-in demo ERP, CRM, HR, ATS and IT systems let every AI employee practise from day one.
- **People and sign-in.** Microsoft 365 (Entra ID) and Google Workspace sign-in, or passwords. Permissions follow departments: people see their own departments' AI employees, tasks and data.
- **The platform underneath:** PostgreSQL with pgvector (embedded, zero-install locally), a knowledge base with hybrid search, document reading with OCR, Excel, a Node.js runtime powered by **Claude**, and an MCP server. One installation per company.

```text
Ayşe (HR manager), in the Studio: "Every week we receive dozens of CVs at careers@acme.com.tr. I want an AI employee
                                   that reads each CV, scores it against the open position and shortlists the best ones."
Analyst:   ❓ Q5 — Mailbox access: this mailbox isn't connected yet…   ➡️ Recommended: Ask IT on my behalf
           ❓ Q1 — What it does alone at first                        ➡️ Recommended: Supervised
           Job description:  Duty      Reads every email sent to careers@acme.com.tr with an attachment
                             Needs     careers@acme.com.tr (asked IT)
                             Never     Never reject a candidate on its own
                             At first  Supervised
                             Samples   3 analysed
Ayşe:      confirm → hired on trial, tried on her 3 CVs → "put to work"
Later:     a CV arrives at careers@ → the CV Screener screens it by itself → Can (recruiter) sees
           "Shortlist Deniz Kaya? Score 91/100 (pass)" on his Home, approves → the candidate is created in the ATS
```

| | |
|---|---|
| ![Home: what needs me, what my AI employees did today, and a box to give work](docs/screenshots/home.png) | ![An AI employee's page: duties, access, probation level and rules, versions](docs/screenshots/ai-employee.png) |
| ![Hire: the Studio interview on the left, the job description building up on the right](docs/screenshots/hire-studio.png) | ![A task from start to finish: its history, emails and what it waits for](docs/screenshots/task.png) |

## Quick start

### One app, in one command

Requirements: **Docker** (Docker Desktop on Mac and Windows).

```bash
docker compose up -d
```

Open **http://localhost:3200**. The first start takes a few minutes: it builds Enterprise Brain and downloads PostgreSQL. You get the demo company **Acme Endüstri A.Ş.** with its departments, AI employees and eight demo people; the sign-in page signs you in as any of them with one click, so you can see what an HR manager, a recruiter or IT sees.

- **Claude:** put `ANTHROPIC_API_KEY=…` in a `.env` file next to `docker-compose.yml` and run `docker compose up -d` again. Without it, everything works in a clearly labelled offline mode.
- **Your own company:** before the first start, set `EB_SEED_DEMO=false`, `EB_COMPANY_NAME` and `EB_MAIL_DOMAIN` in `.env`. The first person to open the app becomes its admin, and sets up Microsoft 365 or Google sign-in, connections and people in *Settings*.
- **For colleagues:** the app listens on this computer only. Once your admin account exists, set `EB_BIND=0.0.0.0` and `EB_PUBLIC_URL` to the address they use (or put it behind your reverse proxy with HTTPS).
- **Coming from the two-app bundle** (Enterprise Brain with Paperclip)? Run `docker compose up -d --build --remove-orphans` once; your data stays.

### With Paperclip (optional)

```bash
docker compose -f docker-compose.paperclip.yml up -d
```

Paperclip on http://localhost:3100 with your company, departments and AI employees in its org chart and the Enterprise Brain page in its sidebar, and Enterprise Brain on http://localhost:3200, without sign-in. See [docs/PAPERCLIP.md](docs/PAPERCLIP.md#the-bundle-paperclip-and-enterprise-brain-in-one-command).

### From source

Requirements: **Node.js 22.12+** and **pnpm 9**.

```bash
pnpm install
pnpm build          # builds the web console and the Paperclip plugin
pnpm start          # http://localhost:3200
```

On first start, Enterprise Brain creates the demo company **Acme Endüstri A.Ş.**:

- four departments (HR, Finance, Customer Service, IT) and the company-wide shared services, with their AI employees at work
- a knowledge base of company policies in English and Turkish
- sandbox mailboxes with job applications (PDF/DOCX CVs), supplier invoices generated from the sandbox ERP's purchase orders, customer emails and IT requests

**Sign-in:** people sign in with their own accounts. On the demo company the sign-in page lists eight demo people (an admin, department managers and workers), one click each, so you can see what each role sees. A new installation without demo data asks the first person for the admin account; the admin then adds colleagues in **Settings → People and roles**, where Microsoft 365 (Entra ID) and Google Workspace sign-in are set up too. `EB_AUTH=open` turns sign-in off for local trials.

**Database:** nothing to install. Enterprise Brain runs PostgreSQL (with pgvector) *inside* the application, using [PGlite](https://pglite.dev), and keeps everything in the `.data/` folder: `db/` for the database, `files/` for uploads and `master.key` for encrypting connector secrets. Back it up by copying the folder while the server is stopped; move it with `EB_DATA_DIR`. For production, or when several servers share one database, use a PostgreSQL server (15 or later) instead:

```bash
# once, as a database superuser, in the target database:
CREATE EXTENSION vector;
# then point Enterprise Brain at it (tables are created and migrated on start):
DATABASE_URL=postgres://user:password@host:5432/enterprise_brain pnpm start
```

The Docker install runs PostgreSQL with pgvector next to the app (with Paperclip, one server holds both databases). Managed services (Azure Database for PostgreSQL, AWS RDS, Google Cloud SQL) support pgvector.

**Claude:** set `ANTHROPIC_API_KEY` (default model `claude-opus-5`). Without it, everything still works in a clearly labelled **offline mode** with deterministic fallbacks. See `.env.example` for all settings (Postgres, embeddings, API keys, Paperclip).

Development: `pnpm dev` runs the API with watch mode, and `pnpm dev:web` runs the console on http://localhost:5173 with the API proxied. Stakeholder answer links are built from `EB_PUBLIC_URL`, so during development set it to `http://localhost:5173`. Run the tests with `pnpm test` and the type checks with `pnpm typecheck`.

## Try it

1. **Hire** (sign in as *Ayşe Yılmaz*, HR manager): *Describe the job in the Studio*, paste the description above, answer the rounds (or *Use recommendation*), attach the demo CVs, and choose "Ask IT on my behalf" for the mailbox. Watch the job description build up on the right. Confirm: the CV Screener is hired on trial and tried on your CVs. Then *Put to work*.
2. **A CV arrives** (sign in as *Mehmet Öz*, IT): *Settings → Mailboxes → Simulate incoming email* to careers@acme.com.tr, attaching one of the demo CVs. Nobody starts anything: the CV Screener picks it up by itself. (If you hired a second CV Screener, pause the ready-made one on its page first, or both will screen it.)
3. **Home** (sign in as *Can Demir*, recruiter): the shortlist decision is waiting under *Needs you*. Approve it, or *Edit* a change before approving. *Work* shows the task's whole history.
4. **Company → an AI employee**: its duties, what it may use, its coaching notes, and *Probation and rules*, where its manager moves it to *Trusted* with limits or sets its monthly budget. *Talk to it*, or *Give work* in plain words.
5. **Settings → Connections** (IT): connect a web service, then *Actions*: import them from its OpenAPI description or a few example calls, name each in plain words, mark which change data, and try them.
6. **Home** (sign in as *Elif Arslan*, accounts payable): give the Invoice Processor work, and follow it as a task.

## How it fits with Paperclip (optional)

Paperclip is the control plane for AI-agent companies: org charts, goals, tasks, heartbeats, budgets and governance. By design it doesn't run agents or hold knowledge. Enterprise Brain doesn't need it, and can extend it **without forking** through four official extension points:

| | Integration | Result in Paperclip |
|---|---|---|
| 1 | **Company package** (`agentcompanies/v1`) | Departments → projects and lead agents; specialists → employees; scheduled processes → routines; plus the `enterprise-brain` skill |
| 2 | **`hermes_gateway` adapter** | Paperclip heartbeats run Enterprise Brain agents synchronously, with output, usage and cost |
| 3 | **Plugin** (`plugins/paperclip-plugin`) | Knowledge search, specialist agents and approvals as tools for every agent; an Enterprise Brain page and dashboard widget |
| 4 | **MCP server** (`/mcp`) | Governed access to SAP, Salesforce, sandbox systems and knowledge |

See [docs/PAPERCLIP.md](docs/PAPERCLIP.md).

## Repository

```text
apps/server          Fastify API, sign-in, SSE, the Studio, stakeholder pages, Hermes gateway, MCP, demo seed
apps/web             The app: Home, Company, Hire, Work, Settings (React, Vite, Tailwind)
packages/core        Domain model & schemas, safe template/expression engine
packages/db          Drizzle schema + migrations (PGlite or PostgreSQL, pgvector, full-text)
packages/llm         Claude client (structured outputs, tool loop, fallbacks, cost), embeddings
packages/documents   PDF/DOCX/XLSX/CSV/HTML extraction, OCR via Claude vision, heuristics, Excel
packages/knowledge   Chunking, embeddings, hybrid retrieval (RRF)
packages/connectors  Connector SDK, enterprise connectors, sandbox systems
packages/catalog     Template loader/validator (content lives in /catalog)
packages/runtime     AI employees, probation policy, tasks, work queue, run engine, approvals, tools,
                     chat, mail, triggers, watchers, files, secrets
packages/builder     The Studio (requirements analyst)
packages/paperclip   Paperclip package exporter, Hermes contract, API client
plugins/paperclip-plugin   Paperclip plugin
catalog/             Departments, processes, agents (Markdown + YAML), use cases
docs/                Architecture, Agent Builder, Paperclip, API, templates, connectors, ADRs
docker/              The Paperclip bundle's setup for Paperclip (its database and secrets)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): layers, domain model, execution model, security, deployment
- [The Studio](docs/AGENT-BUILDER.md): the interview technique, stakeholder routing, hiring and generation
- [Paperclip integration](docs/PAPERCLIP.md)
- [Templates](docs/TEMPLATES.md): authoring departments, processes and agents
- [Connectors](docs/CONNECTORS.md): the connector SDK and built-in systems
- [HTTP API](docs/API.md)
- [Decisions (ADRs)](docs/adr)

## Status

Phase 1 is built: people and sign-in, AI employees with managers, probation levels, limits and budgets, long-running tasks, the work queue, mailbox and system watchers, named actions for web services and databases, the new app, and hiring in the Studio. Every capability is covered by automated tests, which run offline with a scripted LLM for the Claude paths; `apps/server/test/gate1.test.ts` runs the phase's gate end to end (a CV Screener hired in the Studio follows careers@ on its own at the Supervised level, and a recruiter handles its exceptions in the app). The Docker install (`docker compose up -d`) was built and run with Docker 29. Not yet proven in production:

- The **Claude-powered paths** (analyst interview, extraction, evaluation, chat, OCR) have been exercised with a scripted model that honours the same structured-output schemas, but not yet against the live API. Run the Studio scenario once with `ANTHROPIC_API_KEY` set before a customer demo.
- Microsoft 365 and Google **sign-in** follow the providers' OpenID Connect documentation and are tested against a stand-in provider, not yet against live tenants.
- The enterprise connectors are **preview**: built from vendor API documentation and tested against recorded request/response contracts, but not against live tenants. Verify each one in the customer's environment.
- Coming in phase 2: Teams and Google Chat (AI employees as contacts, approvals as cards, a daily summary), approvals by email, and calendars.
