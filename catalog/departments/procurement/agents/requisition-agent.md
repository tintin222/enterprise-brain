---
id: procurement.requisition-agent
slug: procurement-requisition-agent
name: Requisition Agent
title: Purchasing Assistant
summary: >-
  Turns a plain-language purchase request into a structured requisition, checks internal stock, the
  supplier master, the budget and the purchasing policy, prepares the budget holder's approval and
  creates the purchase order in the ERP once approved.
department: procurement
process: procurement.purchase-requisition
archetype: process-automation
reportsTo: buyer
tags: [purchase-requisition, purchasing, policy-compliance]
capabilities:
  - documents.read
  - knowledge.search
  - connector:erp.get_material_stock
  - connector:erp.search_suppliers
  - connector:erp.create_purchase_order
triggers:
  - type: manual
  - type: form
    description: Purchase request form in the employee portal.
inputs:
  - key: request
    label: What do you need?
    type: text
    required: true
    description: "What, how many, why and by when, e.g. '3 laptops for the new sales engineers in Gebze by 15 October'."
  - {key: requester_email, label: Your email, type: email, required: true}
  - {key: cost_center, label: Cost center, type: string, required: true, example: CC-4100 Sales Türkiye}
  - {key: needed_by, label: Needed by, type: date}
  - {key: budget, label: Budget available, type: number}
  - key: quotes
    label: Supplier quotes
    type: files
    accept: [".pdf", ".xlsx", ".docx", ".png", ".jpg"]
    description: Quotes you already have (required above the policy threshold).
outputs:
  - {key: requisition, label: Requisition, type: object}
  - key: policy_check
    label: Policy check
    type: select
    options:
      - {value: pass, label: Compliant}
      - {value: review, label: Check the flagged points}
      - {value: fail, label: Not compliant}
  - {key: issues, label: Points to check, type: list, itemType: string}
  - {key: approval_memo, label: Approval memo, type: text}
  - {key: po_number, label: Purchase order, type: string}
  - {key: status, label: Status, type: string}
connectors:
  - ref: erp
    category: erp
    purpose: Stock, supplier master and purchase order creation.
    operations: [get_material_stock, search_suppliers, create_purchase_order]
knowledge:
  collections: [procurement-policies]
workflow:
  - id: quote_docs
    name: Read attached quotes
    type: extract
    when: input.quotes
    from: "{{ input.quotes }}"
    onError: continue
  - id: requisition
    name: Structure the requisition
    type: llm.extract
    from: |-
      Request: {{ input.request }}
      Needed by: {{ input.needed_by | default:'not stated' }}; budget: {{ input.budget | default:'not stated' }}; cost center: {{ input.cost_center }}
      Attached quotes:
      {{ steps.quote_docs.text | truncate:20000 }}
    instructions: >-
      One line per distinct item with quantity and net unit price (from the quote when available,
      otherwise the requester's estimate; null when unknown). Use our material number only when it is
      stated. Currency as ISO code.
    fields:
      - key: category
        label: Spend category
        type: select
        options:
          - {value: it-hardware}
          - {value: software}
          - {value: office-supplies}
          - {value: production-materials}
          - {value: spare-parts}
          - {value: services}
          - {value: marketing}
          - {value: facilities}
          - {value: other}
      - key: items
        label: Items
        type: list
        fields:
          - {key: description, type: string}
          - {key: material, type: string}
          - {key: quantity, type: number}
          - {key: unit, type: string}
          - {key: unit_price, type: number}
      - {key: preferred_supplier, label: Preferred supplier, type: string}
      - {key: quotes_count, label: Number of quotes attached, type: integer}
      - {key: currency, label: Currency, type: string}
      - {key: estimated_total, label: Estimated total (net), type: number}
      - {key: justification, label: Business justification, type: text}
  - id: stock
    name: Check internal stock
    type: connector
    when: steps.requisition.items.0.material
    connector: erp
    operation: get_material_stock
    input:
      material: "{{ steps.requisition.items.0.material }}"
    onError: continue
  - id: suppliers
    name: Find the supplier in the ERP
    type: connector
    when: steps.requisition.preferred_supplier
    connector: erp
    operation: search_suppliers
    input:
      query: "{{ steps.requisition.preferred_supplier }}"
    onError: continue
  - id: policy
    name: Look up the purchasing policy
    type: knowledge.search
    query: "purchasing policy approval limits number of quotes preferred suppliers {{ steps.requisition.category }}"
    collections: [procurement-policies]
    topK: 5
  - id: check
    name: Check budget and policy
    type: llm.evaluate
    from: |-
      Requisition: {{ steps.requisition | json }}
      Cost center: {{ input.cost_center }}; budget: {{ input.budget | default:'not stated' }}; needed by {{ input.needed_by | default:'not stated' }}
    context: |-
      Internal stock of the first item: {{ steps.stock | json }}
      Supplier master search: {{ steps.suppliers.items | json }}
      Purchasing policy: {{ steps.policy.context }}
    passScore: 75
    instructions: >-
      Default policy when the sources are silent: one quote up to 50,000 TRY, three comparable quotes above
      50,000 TRY, sourcing by procurement above 250,000 TRY; only active suppliers from the supplier master.
    criteria:
      - id: within_budget
        label: Within budget
        description: The estimated total fits the stated budget of the cost center.
        kind: must
        weight: 3
        keywords: [budget, bütçe]
      - id: approved_supplier
        label: Approved, active supplier
        description: The supplier exists in the supplier master and is not blocked (otherwise onboarding or sourcing is needed).
        kind: must
        weight: 2
        keywords: [supplier, tedarikçi]
      - id: quotes_policy
        label: Enough quotes
        description: The number of comparable quotes meets the policy threshold for the amount.
        kind: must
        weight: 2
        keywords: [quote, teklif]
      - id: justification
        label: Business justification
        description: The request states why the purchase is needed.
        kind: must
        weight: 1
        keywords: [for, için, because, çünkü, needed, gerekli]
      - id: not_in_stock
        label: Not available in stock
        description: The item is not available from internal stock.
        kind: nice
        weight: 1
      - id: no_split
        label: No split order
        description: The request is not a split of a larger purchase that would otherwise need a higher approval.
        kind: knockout
        keywords: [request, talep]
        blockers: [split into several orders, split the order, to stay below the approval limit, onay limitinin altında kalmak için, siparişi bölerek, parçalara bölerek]
  - id: memo
    name: Write the approval memo
    type: llm.generate
    prompt: |-
      Write a short approval memo (max 120 words) for the budget holder of {{ input.cost_center }}:
      what is bought, from whom, estimated total, why, and the policy check result.
      Requisition: {{ steps.requisition | json }}. Check: {{ steps.check | json }}.
      End with the points the budget holder should consider before approving.
    fallback: |-
      Purchase request from {{ input.requester_email }} for {{ input.cost_center }}: {{ input.request }}
      Estimated total {{ steps.requisition.estimated_total | default:'n/a' }} {{ steps.requisition.currency | default:'TRY' }}; supplier {{ steps.requisition.preferred_supplier | default:'to be sourced' }}.
      Policy check: {{ steps.check.verdict }} ({{ steps.check.score }}/100).
      Points to check:
      {{ steps.check.gaps | bullets }}
  - id: approve
    name: Budget holder approval
    type: approval
    when: "!steps.check.knockout"
    title: "Purchase for {{ input.cost_center }}: {{ steps.requisition.estimated_total | default:'?' }} {{ steps.requisition.currency | default:'TRY' }} ({{ steps.requisition.category }})"
    details: "{{ steps.memo.text }}"
    assigneeRole: budget-holder
  - id: po
    name: Create the purchase order
    type: connector
    when: steps.approve.approved && steps.suppliers.items.0.supplier_id
    connector: erp
    operation: create_purchase_order
    requiresApproval: false # approved by the budget holder in "approve"
    input:
      supplier_id: "{{ steps.suppliers.items.0.supplier_id }}"
      lines: "{{ steps.requisition.items }}"
      currency: "{{ steps.requisition.currency }}"
    onError: continue
  - id: result
    type: output
    value:
      requisition: "{{ steps.requisition }}"
      policy_check: "{{ steps.check.verdict }}"
      issues: "{{ steps.check.gaps }}"
      approval_memo: "{{ steps.memo.text }}"
      po_number: "{{ steps.po.po_number }}"
      status: "{{ steps.po.error || (steps.po.po_number && 'Purchase order created') || (steps.approve.approved && 'Approved: buyer to source the supplier') || (steps.check.knockout && 'Rejected: policy violation') || 'Not approved' }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: none
  notes:
    - No purchase order is created without the budget holder's approval; suppliers not in the master go to supplier onboarding first.
    - Splitting a purchase to stay below an approval limit is a policy violation and is never proposed.
ui:
  layout: form-results
  title: Purchase request
  description: Describe what you need; the agent prepares the requisition and the approval.
  submitLabel: Submit request
  resultView: cards
  highlight: [status, policy_check, po_number, issues]
kpis:
  - {id: requisition-to-po, name: Requisition-to-PO time, target: "< 3 days"}
  - {id: first-time-right, name: Requisitions complete at first submission, target: "> 90%"}
builder:
  matchPhrases:
    - purchase requisition
    - purchase request
    - buy something
    - create purchase order
    - procurement request
    - satın alma talebi
    - satınalma talebi
    - sipariş oluşturma
    - malzeme talebi
    - satın alma siparişi
---
You are the **Requisition Agent**, the purchasing assistant every employee can talk to. You turn "I need…" into a complete, compliant requisition and a purchase order, so requesters get what they need quickly and procurement keeps control of spend.

## Objectives
- Understand the request and structure it: items, quantities, prices, preferred supplier, cost center, needed-by date and justification.
- Check whether the item is in stock, whether the supplier is approved and active, and whether budget and purchasing policy are respected.
- Prepare a clear approval for the budget holder and create the purchase order after approval.

## Method
1. Read the request and any attached quotes; extract the lines and the totals.
2. Check internal stock for known materials and look up the supplier in the ERP supplier master.
3. Apply the purchasing policy: approval limits, number of quotes, preferred suppliers, split orders.
4. Write the approval memo and ask the budget holder to approve.
5. Create the purchase order for approved requests with a known, active supplier; otherwise hand the request to a buyer for sourcing.

## Rules
- Never create a purchase order without approval, for a blocked supplier or for a supplier that is not in the master.
- Never propose splitting a purchase to stay below an approval limit.
- Use prices from quotes or the requester; never invent prices. Missing prices are flagged for the buyer.
- Internal stock comes first: if the item is available, say so before buying.
- Framework agreements and preferred suppliers take precedence where the policy says so.

## Output
The structured requisition, policy check with points to check, the approval memo, the purchase order number and the status.

## Tone
Helpful and plain-spoken towards requesters; precise and compliance-minded towards approvers.
