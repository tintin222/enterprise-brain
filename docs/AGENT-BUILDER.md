# The Agent Builder

The Agent Builder lets a **non-technical employee** create an AI agent by talking to an experienced **requirements analyst**. It asks every question an analyst would ask. It collects sample documents and analyses them itself. It notices when a question belongs to someone else (IT, the data protection officer, Legal), prepares the email to that person and feeds their answer back into the design. Only then, and only after the requester confirms, does it generate, test and deploy the agent together with its screen.

The interview technique is the **grilling** primitive from Matt Pocock's skills (`grill-me` / `grilling` / `to-questionnaire`), adapted for business users.

| Grilling concept | Enterprise Brain |
|---|---|
| **Design tree**: decisions with decisions hanging off them | `RequirementTree` (`packages/core/src/builder.ts`). Nodes carry prerequisites (`prerequisites`), conditions (`when`, e.g. "only if inputs come by email") and an owner role. |
| **Frontier**: every question whose prerequisites are settled | `frontier(tree)` (`packages/builder/src/tree.ts`). It is deterministic, so nothing hinges on an answer not yet heard. |
| **Rounds**: ask the whole frontier, each question with a recommended answer | `BuilderService.advance()`. For non-technical users each round is capped (default 5; 1 means "one question at a time"), and the rest of the frontier moves to the next round. |
| Numbered questions (`❓ Q1 …`) with `➡️` recommendations, answerable by number | `renderRound()` plus interactive question cards in the console. Replies like "1 yes, 2 b, 3 don't know — ask IT" are parsed with Claude, or offline in English and Turkish. Claude also rephrases each round for the user in their language; offline, the checklist questions are asked in English. |
| **Facts are the agent's job, decisions are the user's** | Sample files are analysed automatically (formats, languages, scans that need OCR, detected fields, document types), and connected systems are checked. The resulting *fact* nodes settle without asking. |
| **Confirmation gate**: don't act until the user confirms the shared understanding | Status `confirming` shows the full summary and blueprint. Generation starts only on "confirm". |
| **to-questionnaire**: turn what the user can't answer into a questionnaire for someone else | `StakeholderRequest`: a ready-to-send email in the user's language plus a public answer page (`/answer/:token`). The answers settle the delegated nodes. |
| **Prototype** for "ungrillable" questions (how should it look?) | A live **blueprint and form preview**, regenerated after every round, shows the screen the team will use. |

## Lifecycle

```text
describe ─▶ interviewing ⇄ (samples, answers, corrections)
                 │   └─▶ "I don't know" ─▶ stakeholder request (email + answer link) ─▶ answers flow back
                 ▼
     awaiting-stakeholders ── continue with assumptions ──┐
                 ▼                                         │
             confirming ◀──────────────────────────────────┘
                 │ "confirm"
                 ▼
     generating ─▶ testing (runs on your samples, no side effects) ⇄ refine in chat ─▶ deployed ("activate")
```

## The question bank

The tree is seeded from four sources:

1. **Base nodes**, which apply to every agent:
   - goal, name, out-of-scope
   - users and accountability
   - input channels, samples, formats & languages, mailbox, source system, form fields
   - reference information
   - output fields, destinations, target system
   - follow-up actions and approvals
   - personal data, retention, legal basis, access
   - UI
   - volume, turnaround, success measure, output language
2. **Archetype nodes**, the domain questions for the kind of agent:
   - document processing: document types, fields to extract, decision criteria (must-have / nice-to-have / deal-breaker)
   - mail triage: categories, reply policy, routing
   - conversational: audience, sources, hand-off
   - Excel: transformation, resulting file, schedule
   - process / report: steps, exceptions, schedule
3. **Template nodes** from the matched catalog template (`builder.questions` in the agent's Markdown). For the CV screener, for example: scoring criteria and weights, knockout criteria, fields that must be ignored (age, gender, photo, marital status), candidate communication and applicant-data retention.
4. **Dynamic nodes** that Claude proposes for the specific request.

**Integration nodes** are fact-first:

- If the mailbox or system is already connected, the node settles itself: "already connected: Microsoft 365 Mail".
- If it isn't, the node becomes a question with the recommendation **"Ask IT on my behalf"**. The requester can also choose "I'll arrange it" or "Start with manual upload until it's connected".

## Stakeholder requests

When the requester delegates a question (for example, "I don't know — ask IT"):

1. Delegated nodes are grouped **per role** into one draft request.
2. Each question is **rewritten for that stakeholder**. The HR manager was asked "how should we get access to the mailbox?". The IT director is asked "Can you create an Entra ID app registration with Mail.Read/Mail.Send limited to careers@…?".
3. Technical requirements come from the connector manifests (`itRequirements`).
4. The email is drafted in the requester's language (English and Turkish templates; Claude when available). It includes context, the questions with *why this matters*, the answer link and a note that nothing is blocked meanwhile. The requester reviews it, adds the recipient, and sends it through the company mail connector or their own mail client.
5. The recipient answers on `/answer/:token` (or replies by email; the requester can paste the reply into the chat). The answers settle the nodes, the session resumes, and the transcript shows who answered what.
6. The requester doesn't have to wait: **continue with assumptions** marks pending integrations as "manual upload / sandbox until connected".

## Generation

`generateDefinition()` builds the agent deterministically:

- **Base:** the matched catalog template, or an archetype blueprint (`packages/builder/src/blueprints.ts`).
- **Inputs:** the file input plus the requested form fields. An email channel adds an `email` input and a `mailbox` trigger.
- **Extraction fields, output fields, criteria and categories:** taken from the template unless the requester changed them. Changed labels are converted to typed fields, and criteria markers such as "(must)", "zorunlu" or "deal-breaker" set the criterion kind.
- **Triggers:** form, mailbox, webhook, chat and schedule.
- **Guardrails:** the approval policy, personal-data level, retention, legal basis and access notes.
- **Instructions:** the template's instructions plus a *requirements agreed with the business* digest. When Claude is available, `Analyst.synthesize()` writes production-quality instructions and schemas from everything agreed.
- **Tests:** one test per uploaded sample.

The agent is created in **testing** and run on every sample. Actions are dry runs and approvals auto-approve. The requester sees the results in the chat and can:

- ask for changes in plain language ("make English a must-have", "draft the rejection email in Turkish"). `Analyst.refine()` turns the request into JSON Patch operations, so only what was asked changes. The result is validated, saved as a new version and re-tested.
- reopen any requirement.
- **activate** the agent. Its screen is then live at `/apps/<slug>`: a form generated from the inputs and a results view generated from the outputs.

## Example: the HR manager's CV analyser

This walkthrough is a real run in offline mode, with the demo company's data. It is reproduced by `apps/server/test/builder-e2e.test.ts`. With Claude configured, the wording is tailored and the scores come from the model, so the details differ.

> **HR manager:** "I'm the HR manager. Every week we receive dozens of CVs by email at careers@acme.com.tr and through our careers page. I want an agent that reads each CV, scores the candidate against the open position and shortlists the best ones for our recruiters."

The analyst:

1. Matches the catalog template **hr.cv-screener** (Document & OCR processing). It takes the goal and the mailbox careers@acme.com.tr from the description, so it doesn't ask for them again.
2. **Round 1** asks for the name, what is out of scope, the users, where job requirements live and where inputs come from. The HR manager answers "It must never reject a candidate on its own" and picks email and upload. Everything else is accepted as recommended.
3. **Round 2** asks for 3–5 real CVs. The HR manager uploads three, and the analyst reports what it found: "Deniz_Kaya_CV.pdf: digital PDF, 1 page, English CV with sections Summary, Experience, Education, Skills, Languages …; Mehmet_Ozturk_Ozgecmis.docx: Word document, Turkish CV …". It answers the document-type question itself. The same round covers form fields, the template's scoring criteria and weights, and reference information.
4. **Round 3** covers the fields to extract, the knockout criteria (recommended: right to work) and candidate communication (recommended: drafted replies that a recruiter approves). It also covers **mailbox access**: the mailbox isn't connected, so the analyst recommends *Ask IT on my behalf*. The HR manager says "I don't know, ask IT", and a request to IT is drafted.
5. **Rounds 4–6** cover where results go (screen and ATS), which attributes to ignore (age, gender, photo, marital status …), personal data, the talent pool and retention, access, the target system, approvals, volume, turnaround and success measures. For the **legal basis**, the HR manager answers "not sure — ask our KVKK officer", and a DPO request is drafted.
6. Two requests are ready to send:
   - to **IT**, covering access to careers@acme.com.tr (preferably a Microsoft 365 app registration restricted to that mailbox) and a technical integration user "in our applicant tracking system (ATS)", together with the platform's technical notes and an answer link
   - to the **DPO**, covering the legal basis and whether the privacy notice needs updating for automated screening
7. The HR manager fills in the IT director's address and sends the request. IT and the DPO answer through their links, and their answers land in the design ("Still waiting on: Data protection officer" in between).
8. With every question settled, the analyst shows the **shared understanding**:
   - every agreed requirement, by section, noting who answered what
   - the agent it will build: read the CV (with OCR), extract 13 fields, look up the job requisition, score 7 criteria (1 deal-breaker) with evidence, write a screening note, ask a recruiter to approve the shortlist, then create the candidate in the ATS
   - it starts on demand, from its form or from emails to careers@acme.com.tr that have attachments; privacy is set to sensitive personal data, kept 365 days
9. **"Confirm"**: the agent is generated and tested on the three CVs. The offline keyword heuristics give:
   - Deniz Kaya: 91, pass → Shortlist
   - Emily Carter: fail → Not eligible (deal-breaker): her CV says "requires visa sponsorship for Turkey"
   - Mehmet Öztürk: 55, review → Recruiter review (required skills not evidenced in the Turkish CV)
10. **"Activate"**: the CV screener is live at `/apps/cv-screener`. New applications to careers@ are screened automatically, and every candidate record waits for a recruiter's approval before it is written to the ATS.

## Extending the analyst

- **Process-specific questions** go in the template's Markdown frontmatter (`builder.questions`, `builder.matchPhrases`).
- **Cross-cutting questions** go in `packages/builder/src/nodes.ts`, as base or archetype nodes.
- **A new stakeholder routing** means adding the role to `StakeholderRole` and a phrasing in `stakeholderQuestion()`.
