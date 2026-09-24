---
id: operations.delivery-note-processor
slug: operations-delivery-note-processor
name: Delivery Note Processor
title: Goods Receipt Controller
summary: >-
  Reads delivery notes (irsaliye, scanned or e-İrsaliye) with OCR, matches supplier, materials,
  quantities and batches against the open purchase order in the ERP and the warehouse count, and
  prepares the goods receipt decision and the discrepancy notice to the supplier.
department: operations
process: operations.delivery-documents
archetype: document-processing
reportsTo: warehouse-supervisor
tags: [goods-receipt, delivery-note, irsaliye, ocr, three-way-match]
capabilities:
  - documents.read
  - mail.send
  - connector:erp.get_purchase_order
  - connector:erp.get_supplier
triggers:
  - type: manual
  - type: mailbox
    mailbox: receiving@company.com
    filter:
      hasAttachment: true
inputs:
  - key: delivery_note
    label: Delivery note (irsaliye)
    type: file
    accept: [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".xml"]
    description: Scan or photo of the delivery note, or the e-İrsaliye (UBL-TR XML or PDF).
  - {key: po_number, label: Purchase order number, type: string, description: Only if the delivery note does not show it., example: PO-4500015}
  - key: counted_quantities
    label: Warehouse count and remarks
    type: text
    description: "e.g. 'line 10: 480 pcs counted, 2 cartons damaged; line 20 complete'."
  - key: email
    label: Delivery note email
    type: object
    description: Set automatically when a supplier emails the delivery note.
    fields:
      - {key: id, type: string}
      - {key: mailbox, type: string}
      - {key: from, type: email}
      - {key: fromName, type: string}
      - {key: to, type: list, itemType: email}
      - {key: subject, type: string}
      - {key: body, type: text}
      - {key: attachments, type: files}
      - {key: attachmentNames, type: list, itemType: string}
      - {key: receivedAt, type: string}
outputs:
  - {key: delivery_note, label: Delivery note data, type: object}
  - {key: po_number, label: Purchase order, type: string}
  - key: result
    label: Receipt check
    type: select
    options:
      - {value: pass, label: Matches the order}
      - {value: review, label: Discrepancies to confirm}
      - {value: fail, label: Do not receive}
  - {key: discrepancies, label: Discrepancies, type: list, itemType: string}
  - {key: gr_recommendation, label: Goods receipt recommendation, type: text}
  - {key: supplier_notice, label: Notice to the supplier, type: text}
  - {key: confirmed, label: Confirmed by the warehouse supervisor, type: boolean}
  - {key: supplier_notified, label: Supplier notified, type: boolean}
connectors:
  - ref: erp
    category: erp
    purpose: Purchase order lines with received quantities, and the supplier contact.
    operations: [get_purchase_order, get_supplier]
workflow:
  - id: document
    name: Read the delivery note (OCR)
    type: extract
    from: "{{ input.delivery_note || input.email.attachments.0 }}"
    ocr: auto
  - id: note
    name: Extract the delivery note
    type: llm.extract
    from: "{{ steps.document.text }}"
    instructions: >-
      Quantities as plain numbers with their unit. Do not extract the driver's name or national ID
      number; the vehicle plate is enough.
    fields:
      - {key: delivery_note_number, label: Delivery note number, type: string, hints: ["İrsaliye No", "Sevk İrsaliyesi No", "Delivery Note No", "Lieferschein"]}
      - {key: e_despatch_uuid, label: e-İrsaliye ETTN, type: string, hints: ["ETTN", "UUID"]}
      - {key: issue_date, label: Issue date, type: date, hints: ["Düzenleme Tarihi", "Date"]}
      - {key: dispatch_date, label: Dispatch date, type: date, hints: ["Fiili Sevk Tarihi", "Sevk Tarihi", "Dispatch Date"]}
      - {key: supplier_name, label: Supplier, type: string, hints: ["Sevk Eden", "Satıcı", "Supplier"]}
      - {key: supplier_tax_id, label: Supplier tax ID, type: string, hints: ["VKN", "Vergi No"]}
      - {key: po_number, label: Purchase order number, type: string, hints: ["Sipariş No", "PO No", "Order No"]}
      - {key: vehicle_plate, label: Vehicle plate, type: string, hints: ["Plaka"]}
      - key: lines
        label: Delivered lines
        type: list
        fields:
          - {key: material, type: string}
          - {key: description, type: string}
          - {key: quantity, type: number}
          - {key: unit, type: string}
          - {key: batch, type: string}
      - {key: delivery_address, label: Delivery address, type: string}
  - id: po
    name: Read the purchase order
    type: connector
    when: input.po_number || steps.note.po_number
    connector: erp
    operation: get_purchase_order
    input:
      po_number: "{{ input.po_number || steps.note.po_number }}"
    onError: continue
  - id: check
    name: Compare delivery note, order and count
    type: llm.evaluate
    from: |-
      Delivery note: {{ steps.note | json }}
      Warehouse count and remarks: {{ input.counted_quantities | default:'no count provided' }}
    context: "Purchase order with ordered and already received quantities: {{ steps.po | json | truncate:8000 }}"
    passScore: 85
    instructions: >-
      Open quantity per PO line = ordered minus already received. Default tolerance: no over-delivery;
      under-deliveries are accepted as partial deliveries and noted. Compare materials by material number,
      otherwise by description.
    criteria:
      - id: po_found
        label: Purchase order found
        description: The delivery note refers to a purchase order that exists in the ERP and is open or partially received.
        kind: knockout
        keywords: [sipariş, po, order]
        blockers: [purchase order not found, po not found, without a purchase order, sipariş numarası yok, siparişsiz sevkiyat, sipariş bulunamadı]
      - id: supplier_match
        label: Supplier matches
        description: The delivering supplier is the supplier of the purchase order.
        kind: must
        weight: 2
        keywords: [supplier, satıcı, sevk eden]
      - id: materials_match
        label: Materials match
        description: Every delivered material corresponds to a line of the purchase order.
        kind: must
        weight: 3
        keywords: [material, malzeme, description]
      - id: quantities_match
        label: Quantities within the open order
        description: Delivered quantities do not exceed the open quantities; partial deliveries are noted.
        kind: must
        weight: 3
        keywords: [quantity, miktar, adet]
      - id: count_matches
        label: Count matches the delivery note
        description: The warehouse count equals the delivery note quantities and no damage is reported.
        kind: must
        weight: 2
        keywords: [counted, sayıldı, complete, tam]
      - id: traceability
        label: Batch information present
        description: Batch or lot numbers are given for batch-managed materials.
        kind: nice
        weight: 1
        keywords: [batch, lot, parti]
      - id: e_despatch
        label: e-İrsaliye reference
        description: Turkish suppliers deliver with an e-İrsaliye (ETTN present).
        kind: nice
        weight: 1
        keywords: [ettn, e-irsaliye]
  - id: supplier
    name: Read the supplier contact
    type: connector
    when: steps.po.supplier_id
    connector: erp
    operation: get_supplier
    input:
      supplier_id: "{{ steps.po.supplier_id }}"
    onError: continue
  - id: recommendation
    name: Prepare the goods receipt recommendation
    type: llm.generate
    format: markdown
    prompt: |-
      Prepare the goods receipt recommendation for the warehouse supervisor.
      Delivery note: {{ steps.note | json }}. Count: {{ input.counted_quantities | default:'not provided' }}.
      Purchase order: {{ steps.po | json | truncate:6000 }}. Check: {{ steps.check | json }}.
      Give a table per line: material, ordered, already received, open, delivered (note), counted, quantity to
      receive, remark. Then the recommendation: receive in full, receive partially (which quantities), receive
      with quality inspection, or reject; and the discrepancies to clarify with the supplier.
    fallback: |-
      Delivery note {{ steps.note.delivery_note_number | default:'(number not found)' }} from {{ steps.note.supplier_name | default:'(supplier not found)' }} for PO {{ input.po_number || steps.note.po_number | default:'(no PO)' }}
      Receipt check: {{ steps.check.verdict }} ({{ steps.check.score }}/100)
      Discrepancies:
      {{ steps.check.gaps | bullets }}
      Lines on the delivery note: {{ steps.note.lines | length }}; count: {{ input.counted_quantities | default:'not provided' }}
  - id: notice
    name: Draft the supplier notice
    type: llm.generate
    when: "steps.check.verdict != 'pass'"
    prompt: |-
      Draft a short, factual notice to the supplier {{ steps.supplier.name || steps.note.supplier_name }} about the discrepancies of
      delivery note {{ steps.note.delivery_note_number }} for purchase order {{ input.po_number || steps.note.po_number }}:
      {{ steps.check.gaps | json }}. Ask for a corrected delivery note or the missing quantities and a confirmation by
      reply. Turkish for Turkish suppliers, English otherwise. Max 120 words. Sign as "Goods Receipt Team".
    fallback: |-
      Dear supplier,

      For delivery note {{ steps.note.delivery_note_number | default:'' }} (purchase order {{ input.po_number || steps.note.po_number | default:'' }}) we found the following discrepancies:
      {{ steps.check.gaps | bullets }}

      Please confirm how you will resolve them (corrected delivery note or delivery of the missing quantities).

      Kind regards,
      Goods Receipt
  - id: confirm
    name: Warehouse supervisor confirmation
    type: approval
    title: "Goods receipt for {{ input.po_number || steps.note.po_number | default:'unknown PO' }} ({{ steps.note.supplier_name | default:'supplier' }}): {{ steps.check.verdict }}"
    details: |-
      {{ steps.recommendation.text }}

      Notice to the supplier (sent on approval when there are discrepancies):
      {{ steps.notice.text | default:'none' }}
    assigneeRole: warehouse-supervisor
  - id: notify
    name: Send the discrepancy notice
    type: mail.send
    when: steps.confirm.approved && steps.notice.text && steps.supplier.email
    requiresApproval: false # confirmed by the warehouse supervisor in "confirm"
    to: "{{ steps.supplier.email }}"
    subject: "Delivery discrepancy: delivery note {{ steps.note.delivery_note_number }} / PO {{ input.po_number || steps.note.po_number }}"
    body: "{{ steps.notice.text }}"
  - id: result
    type: output
    value:
      delivery_note: "{{ steps.note }}"
      po_number: "{{ input.po_number || steps.note.po_number }}"
      result: "{{ steps.check.verdict }}"
      discrepancies: "{{ steps.check.gaps }}"
      gr_recommendation: "{{ steps.recommendation.text }}"
      supplier_notice: "{{ steps.notice.text }}"
      confirmed: "{{ steps.confirm.approved || false }}"
      supplier_notified: "{{ steps.notify.sent || false }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: none
  retentionDays: 3650
  notes:
    - Delivery notes are tax documents (VUK); the ERP and the e-archive remain the system of record.
    - Driver names and national ID numbers printed on delivery notes are not extracted.
ui:
  layout: form-results
  title: Delivery note check
  submitLabel: Check delivery
  resultView: cards
  highlight: [result, po_number, discrepancies, confirmed]
kpis:
  - {id: dock-to-stock, name: Dock-to-stock time, target: "< 24 h"}
  - {id: discrepancies-caught, name: Discrepancies caught at receipt, target: "> 95%"}
builder:
  matchPhrases:
    - delivery note
    - goods receipt
    - receiving check
    - delivery documents
    - dispatch note
    - irsaliye
    - e-irsaliye
    - irsaliye kontrolü
    - mal kabul
    - sevk irsaliyesi
    - teslimat belgesi
---
You are the **Delivery Note Processor**, the goods receipt controller at the receiving dock. You make sure the company receives exactly what it ordered and that every discrepancy is caught at the dock, not weeks later in accounts payable.

## Objectives
- Read delivery notes reliably, including creased scans and phone photos, and e-İrsaliye documents.
- Match supplier, materials, quantities and batches against the open purchase order and the warehouse count.
- Recommend the goods receipt per line and prepare the discrepancy notice for the supplier.

## Method
1. Read the delivery note and extract number, ETTN, dates, supplier, PO number, vehicle plate and lines.
2. Read the purchase order with ordered and already received quantities.
3. Compare line by line: material, open quantity, delivered quantity, counted quantity, batch.
4. Recommend: receive in full, receive partially, receive into quality inspection, or reject.
5. After the warehouse supervisor confirms, send the discrepancy notice to the supplier when needed.

## Rules
- The physical count wins over the delivery note; never recommend receiving more than was counted.
- No over-delivery is received without the buyer's agreement; wrong materials are never received against another line.
- Do not post goods receipts yourself; the warehouse posts in the ERP after confirmation.
- Do not extract drivers' names or national ID numbers.
- If the PO number is missing or unreadable, say so and ask for it instead of guessing.

## Output
Delivery note data, the PO, the receipt check with discrepancies, the goods receipt recommendation, the supplier notice and whether it was confirmed and sent.

## Tone
Short, factual and operational: written for a busy supervisor at the dock.
