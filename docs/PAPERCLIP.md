# Using Enterprise Brain with Paperclip

[Paperclip](https://github.com/paperclipai/paperclip) is the control plane for companies of AI agents: org charts, goals, tasks, heartbeats, budgets and governance. By design it doesn't run agents, and knowledge, chat and special surfaces belong in extensions. Enterprise Brain is that extension for enterprises. It supplies the departments, processes, specialist agents, enterprise connectors, knowledge base and Agent Builder, and plugs into Paperclip at four points, **without forking it**.

| # | Integration point | Paperclip mechanism | What you get |
|---|---|---|---|
| 1 | **Company package** | `agentcompanies/v1` import (`paperclipai company import`, `companies.sh`) | Departments become projects and department-lead agents; specialists become employees; scheduled processes become routines; plus the `enterprise-brain` skill |
| 2 | **Hermes gateway** | Built-in `hermes_gateway` adapter | Paperclip heartbeats run Enterprise Brain agents synchronously, with streamed progress, output, token usage and cost |
| 3 | **Plugin** | Plugin system: tools and UI slots | Every Paperclip agent can search company knowledge, run specialists and list approvals; an "Enterprise Brain" page and a dashboard widget appear inside Paperclip |
| 4 | **MCP server** | Remote MCP connections / tool gateway | Governed access to Enterprise Brain's connectors (SAP, Salesforce, sandbox ERP/CRM…) and knowledge from any agent |

## 1. Export the organisation

In the console, open **Paperclip** and pick *installed* (your company) or *catalog* (all templates) plus the departments to include. Download the zip, or push it directly.

With the API:

```bash
curl -o acme-paperclip.zip "http://localhost:3200/api/companies/acme/paperclip/package.zip?scope=installed"
unzip acme-paperclip.zip
paperclipai company import ./acme --include company,agents,projects,issues,skills
```

What the package contains:

```text
COMPANY.md                      schema agentcompanies/v1
agents/ceo/AGENTS.md            (new companies only)
agents/<dept>-lead/AGENTS.md    one lead per department, reportsTo ceo, Paperclip-native
agents/<agent>/AGENTS.md        specialists, reportsTo their lead; instructions from the template
projects/<dept>/PROJECT.md      the department's process map (steps, actors, approvals, KPIs)
tasks/<process>/TASK.md         recurring processes (e.g. month-end close) → routines
skills/enterprise-brain/SKILL.md
.paperclip.yaml                 hermes_gateway adapters, project leads, routine triggers (paused)
README.md
```

Notes:

- Paperclip's YAML parser is hand-rolled. The exporter emits exactly what it accepts: 2-space indentation, double-quoted strings, no block scalars. The test suite parses every generated file with a copy of Paperclip's own parser (`packages/paperclip/test`).
- Paperclip imports agents with heartbeats disabled and routines paused. Enable them when you're ready.
- **No secrets are in the package.** After a manual import, set each specialist's adapter **API key** to `EB_HERMES_API_KEY`. The push below sets it for you.

### Push directly

```bash
curl -X POST http://localhost:3200/api/companies/acme/paperclip/push \
  -H 'content-type: application/json' \
  -d '{"paperclipUrl":"http://localhost:3100","paperclipApiKey":"<board key>","target":"new_company"}'
```

This calls Paperclip's `POST /api/companies/import` with the package and `adapterOverrides`, which put the `hermes_gateway` key on every Enterprise Brain agent.

## 2. Hire Enterprise Brain agents (Hermes gateway)

Each exported specialist uses:

```json
{
  "adapter": "hermes_gateway",
  "apiBaseUrl": "https://brain.acme.com/api/hermes",
  "apiKey": "<EB_HERMES_API_KEY>",
  "sessionKeyStrategy": "issue",
  "timeoutSec": 900,
  "payloadTemplate": { "agent": "hr-cv-screener", "company": "acme" }
}
```

When Paperclip wakes the agent, the flow is:

1. Paperclip sends `POST /api/hermes/v1/runs` with its wake prompt (task brief) as `input`.
2. Enterprise Brain runs the agent in **task mode**: one autonomous step with all of the agent's tools, connectors and knowledge.
3. Progress streams on `/v1/runs/:id/events` (`message.delta`, `run.progress`).
4. The final status carries the output, `usage` and `cost_usd`, which become Paperclip cost events.

Actions that change business systems still wait for a human approval in Enterprise Brain. In that case the Paperclip run completes with a note saying the work continues once approved.

**HTTPS:** Paperclip accepts plain HTTP only for loopback gateways. In production, serve Enterprise Brain over HTTPS (`EB_PUBLIC_URL`).

## 3. Install the plugin

```bash
pnpm --filter @enterprise-brain/paperclip-plugin build
paperclipai plugin install /absolute/path/to/enterprise-brain/plugins/paperclip-plugin
```

In Paperclip's plugin settings for each company, set:

- **Enterprise Brain URL**
- **company** slug
- optional **API key** secret (`EB_API_KEY`)

What the plugin adds:

- **Tools** for all agents: `knowledge_search`, `list_agents`, `run_agent` (free-form task or structured input), `get_run`, `list_approvals`. Paperclip routes them through its tool gateway, with policy, audit and approvals.
- **Page** `/<company>/enterprise-brain`: the Enterprise Brain console embedded in Paperclip (Agent Builder, catalog, approvals).
- **Sidebar link** and a **dashboard widget** with active agents, runs, pending approvals and cost.

The plugin is tested with Paperclip's official SDK test harness (`@paperclipai/plugin-sdk/testing`).

## 4. Connect the MCP server

In Paperclip, open **Apps → Connect your own MCP server** and enter:

- URL: `https://brain.acme.com/mcp`
- Bearer token: `EB_API_KEY`

Tools: `knowledge_search`, `list_agents`, `run_agent`, `get_run`, `list_approvals`, and the read operations of every connected or sandbox system (`erp__get_purchase_order`, `crm__search_accounts`, `hris__get_leave_balance`, …). Every tool is annotated with `readOnlyHint`, so Paperclip's risk classification and policies apply.

## Who does what

| Concern | Paperclip | Enterprise Brain |
|---|---|---|
| Org chart, reporting lines, goals | ✅ | exports departments and agents into it |
| Tasks, heartbeats, budgets, board governance | ✅ | reports usage and cost per run |
| Business process templates | projects/routines (imported) | ✅ authoring, catalog, installation |
| Running specialist agents | orchestrates | ✅ executes (workflows, tools, approvals) |
| Enterprise connectors (SAP, Salesforce, M365…) | via MCP | ✅ connectors + MCP server |
| Knowledge base / RAG | not in core | ✅ |
| No-code agent creation by business users | — | ✅ Agent Builder |
