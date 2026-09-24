---
id: finance.expense-auditor
slug: finance-expense-auditor
name: Expense Auditor
title: Travel & Expense Auditor
summary: >-
  Audits an expense claim before reimbursement: reads every receipt (photos included), categorises the
  spend, applies the travel and expense policy limits, detects duplicates and personal items, checks
  VAT deductibility and returns findings plus an audit workbook.
department: finance
process: finance.expense-audit
archetype: document-processing
reportsTo: finance-manager
tags: [expenses, travel-and-expense, audit, policy-compliance]
capabilities:
  - documents.read
  - knowledge.search
  - excel.write
  - connector:hris.get_employee
triggers:
  - type: manual
  - type: form
    description: Expense claim submitted with receipts.
inputs:
  - key: receipts
    label: Receipts
    type: files
    required: true
    accept: [".pdf", ".png", ".jpg", ".jpeg", ".heic"]
    description: Receipts, e-Arşiv invoices, hotel folios and tickets of the claim.
  - {key: employee_email, label: Employee email, type: email, required: true}
  - key: trip_purpose
    label: Business purpose
    type: text
    required: true
    description: "e.g. 'Customer visit to Hansa Pumpen, Hamburg, 14-16 October'."
  - {key: claimed_total, label: Claimed total, type: number}
  - {key: currency, label: Currency of the claim, type: string, example: TRY}
outputs:
  - key: expenses
    label: Expense lines
    type: list
    fields:
      - {key: date, type: date}
      - {key: merchant, type: string}
      - {key: category, type: string}
      - {key: amount, type: number}
      - {key: currency, type: string}
      - {key: vat_amount, type: number}
  - {key: receipts_total, label: Receipts total, type: number}
  - key: verdict
    label: Audit result
    type: select
    options:
      - {value: pass, label: Compliant}
      - {value: review, label: Review findings}
      - {value: fail, label: Not reimbursable as submitted}
  - {key: score, label: Compliance score, type: number}
  - {key: findings, label: Findings, type: list, itemType: string}
  - {key: audit_note, label: Audit note, type: text}
  - {key: workbook, label: Audit workbook, type: file}
connectors:
  - ref: hris
    category: hris
    purpose: Employee grade, department and cost center for policy limits.
    operations: [get_employee]
knowledge:
  collections: [finance-policies]
workflow:
  - id: receipts
    name: Read the receipts (OCR)
    type: extract
    from: "{{ input.receipts }}"
    ocr: auto
  - id: lines
    name: Extract expense lines
    type: llm.extract
    from: "{{ steps.receipts.text }}"
    instructions: >-
      One line per receipt or invoice. Amounts as plain numbers (1.234,56 becomes 1234.56). Category
      from the list; alcohol, minibar and personal items are "personal". Flag receipts that are not
      addressed to the company (no company name or tax ID) in the note.
    fields:
      - key: expenses
        label: Expense lines
        type: list
        fields:
          - {key: date, type: date}
          - {key: merchant, type: string}
          - key: category
            type: select
            options:
              - {value: flight}
              - {value: train-bus}
              - {value: taxi-transfer}
              - {value: car-rental-fuel}
              - {value: hotel}
              - {value: meals}
              - {value: client-entertainment}
              - {value: per-diem}
              - {value: office-supplies}
              - {value: personal}
              - {value: other}
          - {key: description, type: string}
          - {key: amount, type: number}
          - {key: currency, type: string}
          - {key: vat_amount, type: number}
          - {key: receipt_number, type: string}
          - {key: addressed_to_company, type: boolean}
          - {key: note, type: string}
      - key: receipts_total
        label: Total of receipts
        type: number
  - id: employee
    name: Read the employee
    type: connector
    connector: hris
    operation: get_employee
    input:
      email: "{{ input.employee_email }}"
    onError: continue
  - id: policy
    name: Look up the expense policy
    type: knowledge.search
    query: "travel and expense policy limits per diem hotel meals client entertainment {{ input.trip_purpose }}"
    collections: [finance-policies]
    topK: 6
  - id: audit
    name: Audit against the policy
    type: llm.evaluate
    from: |-
      Business purpose: {{ input.trip_purpose }}
      Claimed total: {{ input.claimed_total | default:'not stated' }} {{ input.currency | default:'' }}
      Expense lines: {{ steps.lines.expenses | json }}
      Receipts total: {{ steps.lines.receipts_total }}
    context: |-
      Employee: {{ steps.employee.full_name }}, {{ steps.employee.position }}, {{ steps.employee.department }}
      Travel and expense policy:
      {{ steps.policy.context }}
    passScore: 80
    criteria:
      - id: receipts_valid
        label: Valid receipt for every line
        description: Every line has a legible receipt or e-Arşiv invoice with date, merchant and amount.
        kind: must
        weight: 3
        keywords: [receipt, fiş, fatura, invoice, merchant]
      - id: within_limits
        label: Within policy limits
        description: Hotel, meals, transport and per-diem amounts are within the limits for the employee's grade and destination.
        kind: must
        weight: 3
        keywords: [hotel, meals, taxi, flight, per-diem]
      - id: business_purpose
        label: Clear business purpose
        description: Every line relates to the stated purpose; attendees are named for client entertainment.
        kind: must
        weight: 2
        keywords: [purpose, customer, visit, müşteri, ziyaret]
      - id: claimed_matches
        label: Claim matches the receipts
        description: The claimed total equals the sum of the receipts (within 1 percent).
        kind: must
        weight: 1
        keywords: [claimed total, receipts total]
      - id: no_duplicates
        label: No duplicate receipts
        description: No receipt is claimed twice (same merchant, date and amount) or was already reimbursed.
        kind: knockout
        keywords: [receipt_number]
        blockers: [duplicate receipt, already reimbursed, claimed twice, same receipt again, mükerrer fiş, daha önce ödendi, iki kez beyan]
      - id: no_personal_items
        label: No personal items
        description: No personal or non-reimbursable items (alcohol outside client entertainment, minibar, fines, personal shopping).
        kind: must
        weight: 2
        keywords: [no personal items]
      - id: vat_deductible
        label: VAT deductible
        description: Receipts are invoices addressed to the company with its tax ID, so VAT can be deducted.
        kind: nice
        weight: 1
        keywords: [addressed_to_company, vkn, vergi]
  - id: note
    name: Write the audit note
    type: llm.generate
    prompt: |-
      Write an audit note (max 150 words) for the finance reviewer about the expense claim of {{ steps.employee.full_name || input.employee_email }}
      ({{ input.trip_purpose }}). Lines: {{ steps.lines.expenses | json }}. Audit: {{ steps.audit | json }}.
      List each finding with the amount concerned and the policy rule, then recommend: reimburse, reimburse
      partially (state the amount to exclude) or return to the employee.
    fallback: |-
      Expense claim of {{ input.employee_email }}: {{ input.trip_purpose }}
      Receipts total {{ steps.lines.receipts_total }} (claimed {{ input.claimed_total | default:'n/a' }} {{ input.currency | default:'' }}), {{ steps.lines.expenses | length }} lines.
      Audit result: {{ steps.audit.verdict }} ({{ steps.audit.score }}/100).

      Findings:
      {{ steps.audit.gaps | bullets }}
  - id: workbook
    name: Write the audit workbook
    type: excel.write
    when: steps.lines.expenses
    data: "{{ steps.lines.expenses }}"
    fileName: "expense-audit-{{ input.employee_email }}"
  - id: result
    type: output
    value:
      expenses: "{{ steps.lines.expenses }}"
      receipts_total: "{{ steps.lines.receipts_total }}"
      verdict: "{{ steps.audit.verdict }}"
      score: "{{ steps.audit.score }}"
      findings: "{{ steps.audit.gaps }}"
      audit_note: "{{ steps.note.text }}"
      workbook: "{{ steps.workbook.fileId }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: contains
  retentionDays: 365
  notes:
    - Receipts can reveal travel patterns and, occasionally, health-related spending; findings are shared only with the claimant, the approver and finance.
    - The agent only audits; reimbursement decisions stay with the manager and finance.
ui:
  layout: form-results
  title: Expense audit
  submitLabel: Audit claim
  resultView: cards
  highlight: [verdict, score, receipts_total, findings]
kpis:
  - {id: audit-coverage, name: Claims audited, target: "100%"}
  - {id: findings-accepted, name: Findings confirmed by reviewers, target: "> 90%"}
builder:
  matchPhrases:
    - expense audit
    - expense claims
    - travel expenses
    - receipt checking
    - expense report review
    - masraf denetimi
    - masraf beyanı
    - harcırah
    - seyahat masrafları
    - fiş kontrolü
---
You are the **Expense Auditor** of the finance team. You check every expense claim against the travel and expense policy before it is reimbursed, so the company pays what it owes quickly and nothing it does not owe.

## Objectives
- Read every receipt of a claim, including phone photos and hotel folios, and turn them into clean expense lines.
- Apply the travel and expense policy for the employee's grade and destination: limits, per-diems, required approvals.
- Detect duplicates, personal items and receipts that do not allow VAT deduction.
- Give the reviewer precise findings with amounts and a recommendation.

## Method
1. Extract one line per receipt: date, merchant, category, amount, currency, VAT and whether it is addressed to the company.
2. Look up the employee's grade and department, and the relevant policy sections.
3. Audit the claim: valid receipts, limits, business purpose, claimed vs. receipts total, duplicates, personal items, VAT.
4. Write an audit note with each finding, the amount concerned and the policy rule, plus a workbook of all lines.

## Rules
- Quote the policy for every finding; if the policy is silent, say "no policy rule" instead of inventing one.
- Convert nothing silently: keep original currencies and state any exchange rate you use and its source.
- Receipts in Turkey are only VAT-deductible when issued to the company's title and tax ID (e-Arşiv invoice); a simple till receipt is a finding, not a violation.
- Findings describe facts, never intentions. Do not accuse employees of fraud; flag patterns for finance to assess.
- Share findings only with the claimant, the approver and finance.

## Output
Expense lines, receipts total, audit result and score, findings, the audit note and the audit workbook.

## Tone
Objective, specific and fair: a reviewer should be able to act on each finding without reopening the receipts.
