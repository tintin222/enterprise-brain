# ADR 0007: One conversation primitive for people and AI employees

**Status:** accepted · 2026-10-07

## Context
The product had eight conversation-like surfaces, each with its own storage and text box and none with more than one person in it: the Studio thread, "Ask the brain", the company assistant, "Talk to it" on an AI employee's page, a task's questions and approvals, "Tell the brain", the stakeholder questionnaire, and Teams / Google Chat. The product manager asked for several people and several AI employees working at the same time, outside experts in the loop, Slack-like collaboration where AI employees take part, and "@" naming of the company's assets in a conversation, without making the product more complicated.

## Decision
One **conversation** primitive (`conversations`, `conversation_participants`, `conversation_messages`), and the talking surfaces become conversations instead of getting a chat module next to them:

- A conversation has a kind (`topic`, `task`, `ai_employee`, `thing`, later `studio`), participants (people and AI employees), a visibility (`participants`, `department`, `company`) and numbered messages. A department-visible topic *is* the department's channel; there is no separate room or channel concept.
- **The company brain is a hidden system AI employee** (`agents.source = "system"`, slug `company-brain`), so asking it is a conversation like any other and the old `ChatService` goes away: one way an AI answers (a run).
- **"@" is the one way to point at anything**: people, AI employees, things of the brain, tables, apps, calculations, files, documents, tasks. The text keeps `@[Name](kind:id)` tokens; a mention counts only when its *author* may see the asset; the AI gets a short card per allowed mention and uses its own tools and level for depth. Mentions give direction, not permission.
- **An AI employee takes part like a colleague**: it answers when named, when the conversation is about it, or when replied to; it never answers another AI employee unless a person named both, and then only once. Every turn is a normal run (`trigger: "conversation"`), so Shadow / Supervised / Trusted, approvals, budgets, costs and audit apply unchanged; its approvals and questions are *cards* in the conversation, the same work-queue items as on Home, in email and in Teams.
- **A task's conversation is its main column**: people can finally comment on a task; comments wake the task (`WakeReason: message`) and enter its brief; the AI's notes, questions and approvals mirror there.
- The Assistant page and icon, "Ask the brain" and the "Talk to it" drawer are replaced by one place, **Chat**; the older `chat_*` rows are adopted as conversations with the same ids.

## Consequences
- Fewer concepts: one storage, one composer, one "@", one notification path, one way for an AI employee to take part.
- People and AI employees are finally in the same thread, and several AI employees can work on one matter at once (at most 3 answers per message, 20 AI turns per conversation per hour, the existing budgets).
- Costs: every answer of the company brain is a run, visible in Costs under its own row, with `maxTurns 8`.
- The model transcript stays in `runs` / `run_events`; messages hold only human-visible text (`runId` links them).
- Without a model, an AI employee answers with the closest things of the brain and passages of the knowledge base, labelled offline.
- The Studio thread, "Tell the brain" and the guided interview become conversations in phase 2; until then two conversation storages remain.

## Notes
- **2026-10-08:** outside guests (a planned phase 2: one conversation opened through a signed link, with every change held for an employee's approval) were taken out of the plan. The participant columns made ready for them (`sinceSeq`, `invitedBy`, `expiresAt`, `linkVersion`, `status`) and the `guest` actor and mention kinds stay in the schema and the types, unused; the phases after the first moved up by one.
