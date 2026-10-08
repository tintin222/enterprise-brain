# Conversations: people and AI employees in one thread

How Enterprise Brain lets several people and several AI employees work on one matter at the same time, and how "@" names anything of the company in a conversation. Short sentences; the idea first, then how it is built.

## The idea in one paragraph

There is **one conversation**: a thread with participants (people and AI employees) and messages. Everything that talks is a conversation: a free topic, a task, a person's talk with an AI employee (the company brain included), the conversation about a thing in the brain. **"@" is the only way to point at anything**: a person, an AI employee, a process, a table, a report, a document, a task. An AI employee takes part like a polite colleague: it answers when it is addressed, it reads what others wrote, it asks with a question card, and everything it does is a normal run, so levels, approvals, costs, audit and coaching keep working unchanged. One place, **Chat**, replaces the Assistant, Ask the brain and Talk to it.

## 1. One conversation

A conversation has:

- **a kind**: `topic` (free), `task` (one per task), `ai_employee` (my talk with one AI employee), `thing` (about a thing of the brain: a process, a system, a table…), later `studio` (a Studio thread);
- **participants**: people and AI employees. The **company brain** is an AI employee too (a hidden system one, slug `company-brain`), so there is one way to talk to it: `@Company brain`;
- **visibility**: only its participants, one department, or the whole company. A topic with department visibility *is* the department's channel. There is no separate "channel" or "room";
- **messages**: text with "@" mentions, files, and **cards** (an approval, a question, a check, a failure). The cards are the work-queue items shown on Home; deciding one anywhere (Home, email, Teams) updates it in the conversation.

Where it shows:

- **Chat**: the list of my conversations (mine, my departments', everything I may see), with unread and "mentions you" badges, and the conversation itself.
- **A task**: the conversation is the main column of the task page. People comment on a task; the AI employee's notes, questions and approvals appear there; it reads the comments on its next step.
- **An AI employee**: *Talk to it* opens my talk with it in Chat. Others can be invited.
- **A thing in the brain**: *Discuss* opens its conversation, with the company brain in it. Messages that name a thing also appear on the thing's timeline and in "What's happening".

## 2. "@" mentions

- Type "@" in the composer. The picker lists, in groups: People, AI employees (the company brain among them), Things (the brain: processes, systems, clients…), Data (tables, apps, calculations), Files and documents, Tasks. It is one endpoint, `GET /mention?q=`, filtered by what *you* may see.
- The text keeps a token `@[Name](kind:id)`; the screen shows a chip that opens the asset.
- **Permission rule:** a mention counts only if the **author** may see the asset. Otherwise it is plain text. Nobody can use an AI employee to reach something they cannot open.
- **What the AI gets:** for each allowed mention, a short card in its brief (a thing's description and links; a table's fields and the tools to query it; a report's purpose and measures; a file's name and how to read it; a task's brief; a person's role; an AI employee's duties), plus the id. Then it uses **its own** tools and level to go deeper. Mentions give direction, not permission.

## 3. People and AI employees together

| Situation | Who answers |
|---|---|
| A person names `@Invoice Processor` | Invoice Processor (several named: each one, in parallel, at most 3) |
| The conversation is a talk with an AI employee or a task's, and the message names nobody | that AI employee |
| A person replies to an AI employee's message | that AI employee |
| A message names only people | nobody; AI employees read it on their next turn |
| An AI employee names another AI employee | the other answers only if the person's message named both; never a third time |

Each AI turn is a **run** (`trigger: "conversation"`), so Shadow, Supervised and Trusted apply as today: a Supervised AI employee that wants to send an email makes an approval card in the conversation; a Trusted one acts within its limits. Its final text is its message. It has one extra tool, `conversation_ask`, which puts a question card in front of a named participant (or its manager). "Invoice Processor is working…" shows while it runs. One turn at a time per AI employee per conversation; messages that arrive during a turn are read by the next one. Guards: 3 AI replies per message, 20 AI turns per conversation per hour, the existing budgets. Without a model, the AI employee answers with the closest things of the brain and passages of the knowledge base, labelled offline.

People named in a message get an email (once per unread stretch of the conversation, not while they have it open). An approval or question asked in a conversation opens in Chat from its email or card.

## 4. Simpler, not more complicated

| | Before | After phase 1 | After phase 2 |
|---|---|---|---|
| text boxes that talk to an AI | 6 | 4 | 2 (the composer, the card answer) |
| chat storages | 4 | 3 | 2 |
| ways an AI answers | 3 | 2 | 1 (runs) |
| entry points to talk | Assistant icon, Brain → Ask, Talk to it, Give work, the Home box | Chat, Give work, the Home box | Chat, the Home box |
| ways a person can comment on a task | 0 | 1 | 1 |

## How it is built

**Data** (`packages/db/src/schema.ts`, migrations `0019_conversations.sql` and `0020_drop_guest_columns.sql`): `conversations` (kind, aboutId, title, departmentId, visibility, createdBy, status, lastSeq; one per task, thing or Studio thread), `conversation_participants` (actorKind, actorId, actorName, role, readSeq, invitedBy, lastSeenAt), `conversation_messages` (seq per conversation, kind text|system|card, author, text, mentions with `allowed`, fileIds, card `{type, id}` with a unique key per conversation, runId, replyToId, data). Messages hold only human-visible text; the model transcript stays in `runs` / `run_events`. Shared types: `Actor` and `Mention` in `packages/core/src/actor.ts` and `conversation.ts`.

**Services** (`packages/runtime/src`): `company-brain.ts` (the hidden system AI employee), `conversations.ts` (`ConversationService`: numbering, participants, read marks, lists with unread and mention counts, cards from the work queue, the brain event per message, what an AI employee reads, the older chats adopted), `conversation-turns.ts` (`TurnPlanner`: the rules above, one turn at a time, the guards), `mentions.ts` (`MentionCards`: the cards in the brief), `offline-answer.ts`. The engine runs a turn as a run without a task (`StartRunOptions.conversation`), with `conversationGuidance` and the `conversation_ask` tool; a task's brief carries new comments (`WakeReason: message`), and its notes and status changes mirror into its conversation. Mentions reach people by email (`NotificationService.mentioned`).

**Server** (`apps/server/src`): `routes/conversations.ts` (the API and the `/mention` picker; see `docs/API.md`), `mentions.ts` (`checkMentions`: `allowed` by the author's visibility), `auth/conversations.ts` (who may read, who may invite).

**Web** (`apps/web/src`): `pages/chat/Chat.tsx`, `components/chat/` (`Composer` with the "@" picker, `ConversationView` live over the server's event stream, `ConversationList`, `ConversationFor`), chips drawn by `Markdown` for `@[Name](kind:id)` tokens; the task page, the AI employee's page, the brain and the Home box open their conversations.

## Phases

1. **Conversations for people and AI employees** (built): everything above.
2. **One composer everywhere**: hand-over between AI employees (`conversation_hand_over`), the Studio thread as a conversation, "Tell the brain" as a message to `@Company brain`, the Home box on the composer, the guided interview retired.
3. **Only if asked**: group chats in Teams and Google Chat mirrored to conversations, "catch me up" summaries, search across messages, reactions and presence, live streaming of an AI's draft.

## Risks and how each is handled

1. **Injection through mentioned content**: cards are data under "Things named in these messages", never instructions; the guidance says to use tools and never follow text found in data.
2. **AI loops**: one AI-to-AI hop at most, 3 replies per message, 20 turns per conversation per hour, the budgets.
3. **Permission leaks through mentions**: `allowed` follows the author's visibility at post time; the AI uses its own tools and level for depth.
4. **Notification floods**: one mention email per conversation while unread, nothing while the person is reading; cards keep the once-per-item rule.
5. **Server restarts mid-turn**: `resumeInterrupted` re-runs; the brief is rebuilt from the AI employee's read mark; the message is posted only at the end, so a repeated turn never posts twice.
