# Authoring templates

The catalog in [`/catalog`](../catalog) is plain text that business analysts can read and review in pull requests. The loader in `packages/catalog` validates everything against the schemas in `packages/core` and cross-checks every reference. Run it with:

```bash
pnpm catalog:validate
```

```text
catalog/
  departments/<dept>/department.yaml            department template
  departments/<dept>/processes/<process>.yaml   process templates   (id "<dept>.<process>")
  departments/<dept>/agents/<agent>.md          agent templates     (id "<dept>.<agent>")
  use-cases/<id>.yaml                           default use cases
```

## Department (`department.yaml`)

```yaml
id: hr
name: Human Resources
icon: users                       # lucide icon name, used by the console
summary: Attract, hire, onboard and support employees.
mission: Give every employee a fast, fair and personal HR experience.
kpis:
  - { id: time-to-hire, name: Time to hire, unit: days, target: "< 30" }
roles:                            # human roles: approvers, reviewers, stakeholders
  - { id: hr-manager, title: HR Manager }
  - { id: recruiter, title: Recruiter }
systems:
  - { category: ats, examples: [Kariyer.net, Greenhouse, SuccessFactors Recruiting] }
processes: [hr.recruitment, hr.onboarding]
```

## Process (`processes/<process>.yaml`)

```yaml
id: hr.recruitment
department: hr
name: Recruitment & CV screening
summary: From application to shortlist in hours instead of days.
trigger: { type: mail, description: "A CV arrives at careers@ or through the careers page" }
steps:
  - { id: screen, name: Screen & score the CV, actor: "agent:hr.cv-screener" }
  - { id: review, name: Recruiter reviews the shortlist, actor: "human:recruiter", approval: true }
  - { id: record, name: Candidate recorded in the ATS, actor: "system:ats" }
agents: [hr.cv-screener]
kpis: [{ id: screening-time, name: Screening time per CV, target: "< 5 min" }]
integrations:
  - { category: mail, purpose: Receive applications, required: true }
  - { category: ats, purpose: Store candidates and requisitions, required: false }
useCases: [document-processing, mail-triage]
value: { hoursSavedPerMonth: 60 }
```

Actors are `agent:<agent id>`, `human:<role id>` or `system:<category>`. Processes with `trigger.type: schedule` become **routines** when exported to Paperclip.

## Agent (`agents/<agent>.md`)

YAML frontmatter holds every `AgentDefinition` field plus catalog metadata. The Markdown body is the agent's **instructions** (its system prompt).

```markdown
---
id: hr.cv-screener
slug: hr-cv-screener
name: CV Screener
title: Recruitment Screening Specialist
department: hr
process: hr.recruitment
archetype: document-processing
summary: Reads CVs, scores candidates against the open position with evidence and prepares the shortlist.
inputs:
  - { key: cv, label: CV, type: file, required: true, accept: [.pdf, .docx] }
  - { key: requisition_id, label: Position, type: string }
outputs:
  - { key: full_name, type: string }
  - { key: score, type: number }
  - { key: verdict, type: select, options: [{ value: pass }, { value: review }, { value: fail }] }
workflow:
  - { id: document, type: extract, from: "{{ input.cv || input.email.attachments }}" }
  - id: profile
    type: llm.extract
    from: "{{ steps.document.text }}"
    fields:
      - { key: full_name, type: string }
      - { key: skills, type: list, itemType: string }
  - id: evaluate
    type: llm.evaluate
    from: "{{ steps.profile | json }}"
    criteria:
      - { id: backend, label: 5+ years backend development, kind: must, weight: 2, keywords: [node.js, java, backend] }
      - id: permit
        label: Right to work in Turkey
        kind: knockout
        keywords: [turkish citizen, work permit]
        blockers: [requires visa sponsorship, needs a work permit]   # text that shows the criterion is NOT met
  - id: candidate
    type: connector
    when: steps.evaluate.verdict != 'fail'
    connector: ats
    operation: create_candidate
    input: { full_name: "{{ steps.profile.full_name }}", score: "{{ steps.evaluate.score }}" }
  - id: result
    type: output
    value: { full_name: "{{ steps.profile.full_name }}", score: "{{ steps.evaluate.score }}", verdict: "{{ steps.evaluate.verdict }}" }
connectors:
  - { ref: ats, category: ats, purpose: Candidates and requisitions }
triggers:
  - { type: form }
  - { type: mailbox, mailbox: careers@company.com, filter: { hasAttachment: true } }
guardrails:
  approvalRequiredFor: [connector:write]
  personalData: contains
ui: { layout: form-results, highlight: [full_name, score, verdict] }
builder:
  matchPhrases: [cv, resume, özgeçmiş, candidate screening]
  questions:
    - id: cv.criteria
      section: processing
      title: Scoring criteria and weights
      question: Which criteria should candidates be scored on, and how much should each one weigh?
      answerType: criteria
      replaces: [docs.criteria]   # asked instead of the generic "Decision criteria" question
      owner: process-owner
---

You are the CV Screener. …
```

### Workflow reference

- Every value can be a template: `{{ path | filter }}`.
- Paths start at `input`, `steps.<id>`, `agent`, `trigger` or `run`. `run.date` is the run's start date (`YYYY-MM-DD`) and `run.startedAt` its timestamp, for "today" in prompts and conditions.
- Filters: `json`, `join`, `default`, `upper`, `lower`, `truncate`, `length`, `first`, `pluck`, `round`, `bullets`, `money` (`{{ total | money:currency }}` → "965,664.00 TRY"). A filter's argument is an expression too: a path or a quoted text.
- `a || b` returns the first truthy value.
- `when` is an expression, for example `steps.evaluate.score >= 70 && input.role != 'intern'`.
- An `approval` step takes a `title`, `details`, `assigneeRole` and a `reason`: why a person is asked, shown first wherever the question reaches them (the work queue, email, Teams and Google Chat). Give one when the step asks only in some cases, such as an exception:

  ```yaml
  - id: approve_exception
    type: approval
    when: "steps.match.exception"
    title: "Invoice {{ steps.invoice.invoice_number }} {{ steps.match.summary }}. Post it anyway?"
    reason: "The invoice {{ steps.match.summary }}: posted without your approval, it would be blocked for payment."
  ```

  Its result is `{ approved, note, decidedBy, via? }`, `via` naming where it was decided ("Microsoft Teams", "Google Chat", "an email").

The step types and their results are documented in [ARCHITECTURE.md §3](ARCHITECTURE.md#3-agents). Mailbox-triggered runs receive `input.email = { id, from, fromName, to, subject, body, attachments: [fileIds], attachmentNames, receivedAt }`.

### Capabilities (tools for `agent` steps and chat)

- `knowledge.search`, `documents.read`, `excel.read`, `excel.write`, `mail.draft`, `mail.send`, `web.search`
- `connector:<ref>` (every operation of a binding) or `connector:<ref>.<operation>`

### Builder hints

- `builder.matchPhrases` help the Agent Builder recognise that a user's description fits this template (English and Turkish phrases).
- `builder.questions` add process-specific requirement nodes to the interview (see [AGENT-BUILDER.md](AGENT-BUILDER.md)).
- `replaces` on a question lists generic checklist questions it supersedes (ids from `packages/builder/src/nodes.ts`, for example `docs.criteria`, `mail.categories`, `docs.fields` or `governance.retention`). The generic question is then not asked, and generation reads this question's answer in its place, so the answer types must be compatible. A retention question's option labels need to contain the duration ("1 year", "6 months"). Don't replace `inputs.channels`, because its option values drive triggers and integration questions.

### Offline evaluation

Without Claude, `llm.evaluate` falls back to keyword evidence: a criterion counts as met when one of its `keywords` appears. Keywords can't tell "citizen" apart from "citizen; requires visa sponsorship", so criteria whose failure is stated in words need `blockers`. These are specific phrases (English and Turkish) that mark the criterion as not met, and they are checked before the keywords. Claude receives them as hints too.

## Use case (`use-cases/<id>.yaml`)

```yaml
id: document-processing
name: Document & OCR processing
icon: file-scan
archetype: document-processing
summary: Read any document — digital or scanned — extract what matters and act on it.
description: …
capabilities: [documents.read, knowledge.search]
connectors: [erp, dms]
defaultAgent: shared-services.document-processor
app: /documents
examples: [Supplier invoices into the ERP, Delivery notes against purchase orders, ID documents for onboarding]
```
