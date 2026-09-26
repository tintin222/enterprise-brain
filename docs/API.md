# Enterprise Brain HTTP API

Base URL: `http://localhost:3200` (configurable with `PORT` / `EB_PUBLIC_URL`).

* **Auth.** By default (`EB_AUTH=accounts`) people sign in and the browser sends the `eb_session` cookie (httpOnly, SameSite=Lax); see [People and sign-in](#people-and-sign-in). Machines send `Authorization: Bearer <EB_API_KEY>` and act as an admin; `/mcp` accepts only the key. What a person may see and change follows their departments: admins everything; managers run their departments' AI employees; workers see their departments' AI employees and the company-wide ones (departments marked `openToEveryone`, e.g. Shared Services). Public exceptions: `/api/health`, `/api/info`, `/api/auth/*`, `/api/public/*` (token-protected stakeholder pages and email action links) and `/api/hermes/*` (Paperclip gateway: Bearer Hermes key, which is `EB_HERMES_API_KEY`, else `EB_API_KEY`, else the key generated in `<EB_DATA_DIR>/hermes.key`). With `EB_AUTH=open` nobody signs in and every request acts as the owner, like Paperclip's `local_trusted`; setting `EB_API_KEY` then requires the key on every request.
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

## People and sign-in

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/state` | `{ mode, company: {slug, name}, setupRequired, viewer, providers: [{id, label}], demo: [{email, name, title, isAdmin, departments}] }`: what the sign-in page and the app shell need. `viewer` is `{ kind: "session"\|"api-key"\|"open", id, name, email, isAdmin, departments: [{id, key, name, role}] }` or null |
| POST | `/api/auth/setup` | `{ name, email, password }`: first start only (nobody has an account yet); creates the admin and signs them in. 409 afterwards |
| POST | `/api/auth/signin` | `{ email, password }` → sets the session cookie. 401 on a wrong email or password; 429 after 8 failures in 15 minutes |
| POST | `/api/auth/demo` | `{ email }`: one-click sign-in as a demo person (demo installations only) |
| POST | `/api/auth/signout` | Ends the session |
| GET | `/api/auth/oidc/:provider/start?returnTo=` | Redirects to Microsoft (`microsoft`) or Google (`google`): OpenID Connect authorization code flow with PKCE |
| GET | `/api/auth/oidc/:provider/callback` | The redirect URI to register with the provider. Signs in a person added with that email, or (auto-join domains) creates a member; then redirects to `returnTo`. Errors redirect to `/signin?error=` |
| GET | `/api/me` | The viewer (as in `/api/auth/state`) |
| GET | `/api/companies/:company/people` | `[{ id, email, name, title, role: "admin"\|"member", status, departments: [{departmentId, key, name, role: "manager"\|"worker"}], hasPassword, authProvider, lastSignInAt }]`. Members see the people of their departments and the admins, without the sign-in fields |
| POST | `/api/companies/:company/people` | Admin. `{ name, email, title?, role?, password?, departments?: [{departmentId, role}] }` |
| PUT | `/api/companies/:company/people/:id` | Admin. `{ name?, title?, role?, status?: "active"\|"disabled", password?, departments? }`. Disabling or changing the password ends the person's sessions; the last admin can't be demoted or disabled (409) |
| DELETE | `/api/companies/:company/people/:id` | Admin |
| GET | `/api/companies/:company/sign-in` | Admin. `{ redirectUris: {microsoft, google}, microsoft: {configured, source, clientId, tenant}, google: {configured, source, clientId, hostedDomain}, autoJoinDomains, demo }` (never the secrets) |
| PUT | `/api/companies/:company/sign-in` | Admin. `{ microsoft?: {clientId, secret?, tenant?} \| null, google?: {clientId, secret?, hostedDomain?} \| null, autoJoinDomains?, demo? }`. Secrets are stored encrypted; `null` removes a provider |

## Catalog (templates)

| Method | Path | Description |
|---|---|---|
| GET | `/api/catalog` | `{ departments: DepartmentTemplate[], processes: ProcessTemplate[], agents: AgentTemplateSummary[], useCases: UseCase[] }` |
| GET | `/api/catalog/search?q=` | Ranked template matches for a free-text description |
| GET | `/api/catalog/agents/:id` | Full agent template (id like `hr.cv-screener` or slug) |
| POST | `/api/companies/:company/catalog/departments/:department/install` | `{ processes?: string[], activate?: boolean }` → `{ department, processes[], agents[] }` |
| POST | `/api/companies/:company/catalog/agents/:template/install` | `{ activate?: boolean }` → agent row |
| POST | `/api/companies/:company/catalog/use-cases/:useCase/install` | → `{ useCase, agent }` |
| GET | `/api/companies/:company/departments` | Installed departments with `visible`, `processes[]` and `agents[] {id, slug, name, status, archetype, processId, source}`. Everyone sees which departments exist; `agents` lists only those of departments the viewer works in (`visible: true`) |

Template shapes are defined in `packages/core/src/catalog.ts` (`DepartmentTemplate`, `ProcessTemplate`, `AgentTemplate`, `UseCase`). A department has `id, name, icon, summary, mission, kpis[], roles[], systems[], processes[]`. A process has `id, department, name, summary, trigger {type, description}, frequency, steps[] {id, name, actor ("agent:…" | "human:…" | "system:…"), approval}, agents[], kpis[], integrations[], useCases[], value {hoursSavedPerMonth}, maturity`.

## Agents & runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/agents?status=` | Agent rows `{ id, slug, name, summary, archetype, status (draft/testing/active/paused/archived), source (template/builder/manual), templateId, version, departmentId, processId, managerUserId, probation (shadow/supervised/trusted), limits, monthlyBudgetUsd, title, department, triggers, ui, steps, createdAt, updatedAt }`: the AI employees the viewer may see |
| POST | `/api/companies/:company/agents` | `{ definition: AgentDefinition, status? }` |
| GET | `/api/companies/:company/agents/:agent` | `{ agent, definition: AgentDefinition, versions[] {version, note, createdBy, createdAt}, recentRuns[], employment, canManage, managerCandidates[] {id, name, title}, activity[] {id, actor, action, summary, createdAt} }` (`:agent` = slug or id). `employment`: `{ manager {id, name, email, title} \| null, probation, limits, monthlyBudgetUsd, costThisMonthUsd, stoppedByBudget, changesToday, duties[] {kind, text} }`. `activity`: changes to it and coaching notes (`agent.coaching_note`: a correction before approving, a rejection with a reason, or a check marked wrong), newest first |
| PUT | `/api/companies/:company/agents/:agent/employment` | A manager of its department (or an admin): `{ managerUserId?: uuid \| null, probation?: "shadow"\|"supervised"\|"trusted", limits?: { maxAmount?, currency?, maxActionsPerDay?, mailDomains?[] }, monthlyBudgetUsd?: number \| null }` → `{ agent, employment }`. The manager must manage its department or be an admin (400 otherwise) |
| PUT | `/api/companies/:company/agents/:agent` | `{ definition, note? }` → new version |
| POST | `/api/companies/:company/agents/:agent/status` | `{ status }` |
| POST | `/api/companies/:company/agents/:agent/rollback` | `{ version }` |
| DELETE | `/api/companies/:company/agents/:agent` | Delete |
| POST | `/api/companies/:company/agents/:agent/runs` | Start a run. JSON `{ input: {...}, task?: "free-form task (runs with all the agent's tools)", wait?: true, test?: false }` **or** `multipart/form-data`: one part per input field; file parts named after the file field (`cv`, `document`, …); optional `wait`, `test`. Returns the run row. |
| GET | `/api/companies/:company/runs?agent=&status=&limit=` | Runs with `agentName`, `agentSlug` |
| GET | `/api/companies/:company/runs/:run` | `{ run, events[] {seq, type, stepId, message, data, createdAt}, approvals[], agent: {id, slug, name, outputs, ui} }` |
| POST | `/api/companies/:company/runs/:run/cancel` | Cancel |
| GET | `/api/companies/:company/runs/:run/stream` | *SSE*: `event` (run event), `delta` ({delta} streamed text), `end` ({status}) |

A run row: `{ id, agentId, agentVersion, taskId, trigger, triggerRef, status (running/waiting_approval/waiting/succeeded/failed/cancelled), input, output, error, usage {calls, inputTokens, outputTokens, costUsd}, isTest, currentStep, startedAt, finishedAt, createdAt }`. `waiting`: held at a `wait` step, or because its task was paused.

**Probation levels** decide which changes (an email sent, a connector write) wait for a person. A workflow step's own `requiresApproval` always wins (`false` means a person approved it earlier in the workflow). Otherwise *shadow* and *supervised* send every change to a person, and *trusted* acts alone unless the change is above its limits (the largest amount in the action, an amount in another currency, the number of changes made alone today, email recipients outside `mailDomains`) or its guardrails name that system or action. An AI employee with a `monthlyBudgetUsd` refuses new runs (409) once this month's model cost reaches it; its email waits, and the activity log records `agent.budget_reached` once a month. Test runs are not limited.

`AgentDefinition` (see `packages/core/src/agent.ts`): `slug, name, title, summary, department, archetype, instructions, inputs: FieldSpec[], outputs: FieldSpec[], workflow: WorkflowStep[], tools[], triggers[], knowledge {collections}, connectors[], guardrails {approvalRequiredFor[], personalData, retentionDays, notes}, ui {layout: form-results|chat|inbox|table|none, title, description, submitLabel, resultView, highlight[]}, kpis[], tests[]`. `FieldSpec`: `{ key, label?, type (string|text|number|integer|boolean|date|email|phone|url|select|multiselect|file|files|list|object), required?, options?[{value,label}], description?, accept?[], fields? }`.

## Tasks

A task is one piece of work from start to finish: a duty's email, a schedule, a form, or a request a person gives. It can last days: it waits for a reply or a date and wakes up on its own. Every run except test runs belongs to a task; each working session is a run.

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/tasks?status=&agent=&limit=` | Tasks of the AI employees the viewer may see, newest activity first: `{ id, ref (EB-7K2Q9), title, status, source, sourceRef, requestedBy, input, waitingFor, nextCheckAt, outcome, wakeups, createdAt, updatedAt, closedAt, agent {id, slug, name, departmentId} }`. `status`: one or more of `working`, `waiting`, `needs_person`, `paused`, `done`, `stopped`, `failed` (comma-separated), or `open` for the first four |
| GET | `/api/companies/:company/tasks/:task` | `{ task, agent, events[] {type, message, actor, runId, data, createdAt}, runs[], mails[] {direction, from, to, subject, body, receivedAt}, approvals[], canManage }` (`:task` = id or ref) |
| POST | `/api/companies/:company/tasks` | Give an AI employee work in plain words: `{ agent, text, wait? }` → `{ task, run }` |
| POST | `/api/companies/:company/tasks/:task/pause` | Managers: no wake-ups; a run on it holds at its next step. Replies are kept for when it resumes |
| POST | `/api/companies/:company/tasks/:task/resume` | Managers: back to where it was |
| POST | `/api/companies/:company/tasks/:task/stop` | Managers: cancels its runs and withdraws its open approvals |

How tasks move:

* Emails sent in a task carry its reference in the subject (`Delivery date for PO-4500031 [EB-7K2Q9]`). An inbound email with the reference, or in a thread that already belongs to a task, goes back to that task instead of starting new work, and wakes it when it waits (or reopens it when done).
* A workflow's `wait` step (`{ type: "wait", for: "reply" | "time", days?, until? }`) holds the run (status `waiting`) until a reply arrives or the time passes; the step's result is `{ replied: true, reply: {from, subject, body, …} }` or `{ replied: false, timedOut: true }` (reply waits) and `{ waited: true }` (time waits), for the next steps' `when` conditions.
* Autonomous AI employees plan with task tools: `task_note`, `task_wait_for_reply` (`days`), `task_follow_up` (`days` or `date`) and `task_complete` (`outcome`). When a run ends the task follows that plan, unless a person still has to decide on one of its changes (`needs_person`). Once everything is decided, a rejection wakes it to rethink; otherwise it follows the plan.
* The scheduler wakes waiting tasks whose next check has come, every minute. A task that wakes continues from a brief of what happened so far and why it woke.

## Home and costs

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/home` | `{ person {name, departments[], isManager}, aiEmployees[] {id, slug, name, title, department, departmentId, status, probation, today {started, done, open, needsPerson, failed}, costTodayUsd}, aiMailbox }`: the AI employees of the viewer's departments (and those they manage), most in need of a person first |
| GET | `/api/companies/:company/costs` | Managers and admins: `{ month (YYYY-MM), totalUsd, aiEmployees[] {slug, name, department, manager, status, probation, costThisMonthUsd, monthlyBudgetUsd, stoppedByBudget} }` for the AI employees they manage |

## Work queue

Everything that needs a person, in one list: approvals of AI employees' changes, questions they ask (`task_ask_person`), checks of every finished task of a Shadow AI employee, tasks that failed, and notices (an AI employee stopped at its budget). Items can be for one person (often the AI employee's manager) or for anyone who works in its department.

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/work?scope=mine\|all&status=open\|closed` | `[{ type: "approval"\|"question"\|"review"\|"failure"\|"notice", id, title, details, reason, suggestion, options, action (approvals), task {id, ref, title, status}, agent {id, slug, name}, departmentId, assignee {id, name}, forMe, canHandle, status, resolvedBy, createdAt }]`. `mine`: assigned to the viewer, or unassigned in a department they work in |
| POST | `/api/companies/:company/work/:id` | Handle a question, check, failure or notice: `{ answer }` (question: the task wakes with it), `{ verdict: "right"\|"wrong", note? }` (check: a wrong verdict is kept as a coaching note), `{ retry: true }` (failure: the task continues from the step that failed), or `{ dismiss: true }`. 403 when it is for someone else (its assignee, the department's managers and admins may handle it) |
| POST | `/api/companies/:company/approvals/:approval/decide` | See below; `edits` corrects the proposed change before it runs |
| POST | `/api/companies/:company/tasks/:task/retry` | Managers: a failed task continues from the step that failed |

## Approvals (human in the loop)

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/approvals?status=pending` | `{ id, runId, agentId, agentName, origin (workflow/deferred), stepId, title, details, action {type: decision|connector|mail.send, …}, reason (why a person is asked, e.g. "12,500 TRY is above its limit of 10,000 TRY"), status, decidedBy, decisionNote, createdAt, decidedAt }` |
| POST | `/api/companies/:company/approvals/:approval/decide` | `{ approved: boolean, note?, edits? }`: resumes the paused run. `edits` corrects the change before it runs: `{ to?, subject?, body? }` for an email, the input fields (or `{ input: {...} }`) for a system action. People of the AI employee's department and admins decide |

## Notifications and approvals by email

What reaches people outside the app. Approvals and questions (what an AI employee waits on) arrive at once; checks, failures and notices wait for a morning summary, unless the person wants everything at once. Each item reaches a person once, over one channel (Teams or Google Chat when connected for them, else email), and people get the items the app lists as theirs: the assignee, else the people of the AI employee's department (admins for company-wide AI employees). Delivery runs with the scheduler (`EB_SCHEDULER`); failed deliveries are tried again (up to three times, by email after a chat failure). Emails carry buttons that open a signed page: the link acts for one person on one item for a week, opening it changes nothing, and acting takes a click there (mail scanners open links too). Links point at `EB_PUBLIC_URL`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/me/notifications` | Signed-in people: `{ preferences {deliver: "urgent"\|"all"\|"summary"\|"off", channel: "auto"\|"email"\|"teams"\|"google-chat", summaryAt: "HH:MM", timeZone}, modes[] {id, label, description}, channels[] {id, label, reaches}, email, recent[] {kind, itemType, channel, status, createdAt} }`. The default time zone is the company setting `timeZone`, else Europe/Istanbul |
| PUT | `/api/me/notifications` | Any of the preference fields; 400 on an unknown time zone or a time not in HH:MM |
| GET | `/api/public/act/:token` | The page behind an email's buttons: `{ company {name}, person {name}, item {type, id, title, details, reason, suggestion, options, action, agent {name}, task {ref, title, status}, status, resolvedBy, answer, createdAt}, canAct, expiresAt }`. 400 for a changed link, 410 once expired, 403 when the person is disabled or no longer works in the item's department |
| POST | `/api/public/act/:token` | Act as the link's person: `{ choice: "approve"\|"reject", note?, edits? }` for approvals (edits as in `decide`), `{ answer }`, `{ verdict, note? }`, `{ retry }` or `{ dismiss }` for the rest. 409 when someone already handled it ("Approval is already approved by …"); the audit log says the decision was made in an email |

## Files

| Method | Path | Description |
|---|---|---|
| POST | `/api/companies/:company/files` | multipart upload → `[{ field, id, name, mimeType, size }]` |
| GET | `/api/companies/:company/files` | Admin. Recent files (`metadata.demoSet` marks bundled demo samples) |
| GET | `/api/companies/:company/files/demo` | The bundled demo samples (sample CVs and invoices), for everyone signed in |
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
| GET | `/api/companies/:company/connectors/:id/actions` | Admin. `{ supports, actions: NamedAction[] }` |
| PUT | `/api/companies/:company/connectors/:id/actions` | Admin. `{ actions: NamedAction[] }`: replaces the connection's named actions (400 when one doesn't fit) |
| POST | `/api/companies/:company/connectors/:id/actions/import` | Admin. Proposes actions (not saved): `{ openapi: object \| "JSON or YAML text" }`, `{ url }` of an OpenAPI/Swagger description, or `{ examples: "GET https://…\nPOST https://… {json}" }` → `{ actions, baseUrl?, warnings[] }` |
| POST | `/api/companies/:company/connectors/:id/actions/:action/test` | Admin. `{ input, confirm? }` → `{ ok, durationMs, result }`; a write action needs `confirm: true` |

**Named actions.** IT turns a web service (the generic REST connector) or a database (the SQL connector: PostgreSQL, SQL Server, MySQL) into named actions; a connection that has them offers AI employees those actions and nothing else. `NamedAction`: `{ id (get_customer), name, description, kind: read\|write, requiresApproval?, params: [{ key, type: string\|number\|integer\|boolean\|date, description?, required }], method?, path? ("/customers/{customer_id}"), query? ({ include: "{include}" }), body? (JSON template: "{param}" alone keeps the value's type), sql? ("SELECT … WHERE id = :customer_id"), watch? { cursorField, idField?, start? } }`. Values are checked against the parameters before anything is called. Database read actions run in a transaction that is always rolled back; write actions commit. `requiresApproval` means a person approves every use, at every probation level and whatever a workflow says. A watched action (it takes a `since` parameter) reports new rows or items as the event `new:<id>`, which starts `connector-event` duties.

## Watching mailboxes and systems

AI employees follow connected mailboxes and systems on their own: every minute (`EB_WATCH_INTERVAL` seconds) each connected mail connection (Microsoft 365, Gmail, IMAP) is checked for new mail, and each system an AI employee's `connector-event` duty names for new events (a new record, row or file). The first check only records the starting point, so nothing from before is replayed; each email is brought in once.

A new email goes back to its task when it is a reply (the task's reference, or its thread); otherwise every active AI employee whose mailbox duty matches gets it as new work. An email to the company's AI mailbox gives one AI employee work: `ai+cv-screener@acme.com.tr` (plus-addressing), or `CV Screener: …` in the subject. Only people with an account can give work this way; other senders' emails are marked `ignored`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/watchers` | Admin. `[{ connection, connectionId, watching (new_message, or the event), lastPolledAt, lastCount, lastError }]` |
| POST | `/api/companies/:company/watchers/poll` | Admin. Check now: `{ mail, events, errors[] }` |
| GET | `/api/companies/:company/settings` | Admin. `{ aiMailbox, mailDomain, timeZone }` |
| PUT | `/api/companies/:company/settings` | Admin. `{ aiMailbox?: "ai@acme.com.tr" \| null, timeZone?: "Europe/Istanbul" \| null }`: the mailbox people forward work to (connect it as a mail connection too), and the time zone of morning summaries for people who didn't choose their own |

## Mail (inbox)

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/mail/mailboxes` | `{ mailbox, total, unprocessed, agents[] }` |
| GET | `/api/companies/:company/mail/messages?mailbox=&direction=&status=` | Messages `{ id, mailbox, direction, fromAddress, fromName, toAddresses, subject, bodyText, attachments[] {fileId, name, mimeType, size}, status (new/processing/triaged/replied/error/draft/sent), classification, runId, receivedAt }` |
| GET | `/api/companies/:company/mail/messages/:id` | `{ message, run, approvals[] }` |
| POST | `/api/companies/:company/mail/messages` | Deliver a message to a (sandbox) mailbox: JSON `{ mailbox, from, fromName?, subject, body, route?: true, attachmentFileIds? }` or multipart with attachments (and `attachmentFileIds`, comma-separated, for stored files such as the demo samples). Matching active agents start automatically. → `{ message, runs[] }` |
| POST | `/api/companies/:company/mail/messages/:id/process` | `{ agent, wait? }` — process with a specific agent |

## Conversational AI

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/chat/conversations?agent=` | The viewer's own conversations (a signed-in person sees only theirs) |
| POST | `/api/companies/:company/chat/conversations` | `{ agent?, title? }` (no agent = company assistant). The conversation belongs to the person who starts it; people talk only to the AI employees of their departments (404 otherwise) |
| GET | `/api/companies/:company/chat/conversations/:id/messages` | `{ id, role (user/assistant), content (markdown), citations[] {n, title, collection, documentId, snippet}, createdAt }` |
| POST | `/api/companies/:company/chat/conversations/:id/messages` | `{ text }` → assistant message |
| POST | `/api/companies/:company/chat/conversations/:id/messages/stream` | *SSE* `{ text }` → `delta` events, then `message` |

## The Studio (Agent Builder)

Managers and admins. An interview belongs to the manager who started it: they, the other managers of its department and admins see it (404 for others).

| Method | Path | Description |
|---|---|---|
| GET | `/api/companies/:company/builder/sessions` | Sessions `{ id, title, status, archetype, templateId, department, requesterName, requesterRole, agentId, createdAt, updatedAt }` |
| POST | `/api/companies/:company/builder/sessions` | `{ description, formDescription?, requesterName?, requesterEmail?, requesterRole?, department?, language? ("en"/"tr"), roundSize? }` → SessionView. Signed in, the requester is the person, and `department` defaults to the one they manage |
| GET | `/api/companies/:company/builder/sessions/:id` | SessionView `{ session, tree, messages, requests, currentRound?, progress, draft?, job, agent?, llm }`. `job` is the job description in plain words: `{ duties[], needs[] {text, status: "ready"\|"to-ask"\|"asked"\|"answered"\|"yours"\|"manual"\|"open", who}, never[], level {value, label, alone, person}, samples, manager }` |
| POST | `/api/companies/:company/builder/sessions/:id/reply` | JSON `{ text?, answers?: [{ nodeId, action?: answer|accept|delegate|skip, value?, delegateTo? }], fileIds? }` or multipart (`text` + files as samples) → SessionView |
| POST | `/api/companies/:company/builder/sessions/:id/samples` | multipart sample files → SessionView |
| POST | `/api/companies/:company/builder/sessions/:id/reference` | multipart reference docs (added to the agent's knowledge) |
| POST | `/api/companies/:company/builder/sessions/:id/proceed` | Continue with assumptions while stakeholders answer |
| POST | `/api/companies/:company/builder/sessions/:id/confirm` | Pass the confirmation gate: hire the AI employee on trial (`testing`) at the agreed probation level, with the requester as its manager, and try it on the samples |
| POST | `/api/companies/:company/builder/sessions/:id/activate` | Put it to work (`active`): its duties start |
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
