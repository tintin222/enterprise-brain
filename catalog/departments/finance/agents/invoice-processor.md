---
id: finance.invoice-processor
slug: finance-invoice-processor
name: Invoice Processor
title: Accounts Payable Specialist
summary: >-
  Reads supplier invoices (PDF, scan or e-invoice) with OCR, extracts header and lines, finds the
  supplier and purchase order in the ERP, checks duplicates, amounts, prices, received quantities and
  bank details (3-way match), and posts the invoice after the AP clerk approves.
department: finance
process: finance.accounts-payable
archetype: document-processing
reportsTo: ap-clerk
tags: [accounts-payable, invoice-processing, three-way-match, ocr, flagship]
capabilities:
  - documents.read
  - knowledge.search
  - connector:erp.search_suppliers
  - connector:erp.get_supplier
  - connector:erp.get_purchase_order
  - connector:erp.get_invoice_status
  - connector:erp.post_supplier_invoice
triggers:
  - type: manual
  - type: mailbox
    mailbox: invoices@company.com
    filter:
      hasAttachment: true
inputs:
  - key: invoice
    label: Invoice
    type: file
    accept: [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".xml"]
    description: Supplier invoice as PDF, scan, photo or e-invoice XML (UBL-TR).
  - key: po_number
    label: Purchase order number
    type: string
    description: Only needed when the invoice does not mention its purchase order.
    example: PO-4500012
  - key: email
    label: Invoice email
    type: object
    description: Set automatically when the invoice arrives in the AP mailbox.
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
  - {key: invoice, label: Invoice data, type: object}
  - {key: supplier_id, label: Supplier, type: string}
  - {key: po_number, label: Purchase order, type: string}
  - {key: check_score, label: Check score, type: number}
  - key: verdict
    label: Checks
    type: select
    options:
      - {value: pass, label: Ready to post}
      - {value: review, label: Needs attention}
      - {value: fail, label: Do not post}
  - {key: issues, label: Issues, type: list, itemType: string}
  - {key: match_status, label: ERP match status, type: string}
  - {key: erp_document, label: ERP document number, type: string}
  - {key: status, label: Status, type: string}
  - {key: ap_note, label: AP note, type: text}
connectors:
  - ref: erp
    category: erp
    purpose: Supplier master, purchase orders and goods receipts, invoice status and invoice posting.
    operations: [search_suppliers, get_supplier, get_purchase_order, get_invoice_status, post_supplier_invoice]
knowledge:
  collections: [ap-policies]
workflow:
  - id: document
    name: Read the invoice (OCR)
    type: extract
    from: "{{ input.invoice || input.email.attachments.0 }}"
    ocr: auto
  - id: invoice
    name: Extract invoice data
    type: llm.extract
    from: "{{ steps.document.text }}"
    instructions: >-
      The supplier is the issuer of the invoice (satıcı), not the buyer (alıcı). Amounts are plain
      numbers with a dot as decimal separator (1.234,56 TL becomes 1234.56). Currency as ISO code
      (TL becomes TRY). ETTN is the e-invoice UUID. Copy invoice and PO numbers exactly as printed.
    fields:
      - key: supplier_name
        label: Supplier
        type: string
        required: true
        hints: ["Satıcı", "Unvan", "Supplier", "Vendor", "Seller"]
      - key: supplier_tax_id
        label: Supplier tax ID (VKN)
        type: string
        hints: ["VKN", "Vergi No", "Vergi Kimlik No", "Tax ID", "VAT No"]
      - key: supplier_tax_office
        label: Tax office
        type: string
        hints: ["Vergi Dairesi", "Tax Office"]
      - key: invoice_number
        label: Invoice number
        type: string
        required: true
        hints: ["Fatura No", "Invoice No", "Invoice Number", "Belge No"]
      - key: invoice_date
        label: Invoice date
        type: date
        required: true
        hints: ["Fatura Tarihi", "Düzenleme Tarihi", "Invoice Date"]
      - key: due_date
        label: Due date
        type: date
        hints: ["Son Ödeme Tarihi", "Vade Tarihi", "Due Date"]
      - key: e_invoice_uuid
        label: ETTN (e-invoice UUID)
        type: string
        hints: ["ETTN", "UUID"]
      - key: currency
        label: Currency
        type: string
        hints: ["Para Birimi", "Currency", "TRY", "TL", "EUR", "USD"]
      - key: net_amount
        label: Net amount
        type: number
        required: true
        hints: ["Mal Hizmet Toplam Tutarı", "Ara Toplam", "Net Amount", "Subtotal"]
      - key: tax_amount
        label: VAT (KDV)
        type: number
        hints: ["Hesaplanan KDV", "KDV", "VAT", "Tax"]
      - key: total_amount
        label: Total amount
        type: number
        required: true
        hints: ["Ödenecek Tutar", "Vergiler Dahil Toplam Tutar", "Genel Toplam", "Total", "Amount Due"]
      - key: po_number
        label: Purchase order number
        type: string
        hints: ["Sipariş No", "PO No", "Purchase Order", "Order No"]
      - key: iban
        label: IBAN
        type: string
        hints: ["IBAN"]
      - key: line_items
        label: Lines
        type: list
        fields:
          - {key: description, type: string}
          - {key: quantity, type: number}
          - {key: unit, type: string}
          - {key: unit_price, type: number}
          - {key: vat_rate, type: number}
          - {key: amount, type: number}
  - id: supplier_search
    name: Find the supplier in the ERP
    type: connector
    connector: erp
    operation: search_suppliers
    input:
      query: "{{ steps.invoice.supplier_tax_id || steps.invoice.supplier_name }}"
  - id: supplier
    name: Read the supplier master
    type: connector
    when: steps.supplier_search.total
    connector: erp
    operation: get_supplier
    input:
      supplier_id: "{{ steps.supplier_search.items.0.supplier_id }}"
  - id: purchase_order
    name: Read the purchase order and goods receipts
    type: connector
    when: input.po_number || steps.invoice.po_number
    connector: erp
    operation: get_purchase_order
    input:
      po_number: "{{ input.po_number || steps.invoice.po_number }}"
    onError: continue
  - id: duplicate_check
    name: Look for an invoice with the same number
    type: connector
    when: steps.invoice.invoice_number
    connector: erp
    operation: get_invoice_status
    input:
      invoice_number: "{{ steps.invoice.invoice_number }}"
    onError: continue
  - id: policy
    name: Look up the AP policy
    type: knowledge.search
    query: "invoice matching tolerance price quantity approval limits {{ steps.invoice.currency }}"
    collections: [ap-policies]
    topK: 4
  - id: checks
    name: Validate and match
    type: llm.evaluate
    from: "{{ steps.document.text }}"
    context: |-
      Extracted invoice: {{ steps.invoice | json }}
      Supplier master (ERP): {{ steps.supplier | json }}
      Supplier search results: {{ steps.supplier_search.total | default:0 }} match(es)
      Purchase order with received and invoiced quantities: {{ steps.purchase_order | json }}
      Existing invoice with the same number (an error here means none was found): {{ steps.duplicate_check | json }}
      AP policy: {{ steps.policy.context }}
    passScore: 80
    instructions: >-
      Compare the invoice with the ERP data in the context. Compare prices and quantities line by line
      with the purchase order and the received (not yet invoiced) quantities, applying the AP policy
      tolerances (default: price variance at most 2 percent, never more than the received quantity).
      A blocked supplier or an IBAN that differs from the supplier master is a serious finding.
    criteria:
      - id: supplier_known
        label: Supplier exists and is active
        description: The issuer's tax ID or name matches an active (not blocked) supplier in the ERP supplier master.
        kind: knockout
        keywords: [vkn, vergi, tax id, vat no]
        blockers: [supplier is blocked, not in the supplier master, unknown supplier, tedarikçi bloke, cari kaydı yok, kayıtlı tedarikçi değil]
      - id: not_duplicate
        label: Not a duplicate
        description: No invoice with the same number is already registered, posted or paid in the ERP.
        kind: knockout
        keywords: [fatura no, invoice no, invoice number]
        blockers: [duplicate invoice, duplicate copy, invoice copy, already posted, mükerrer fatura, fatura kopyasıdır, daha önce gönderilmiştir]
      - id: arithmetic
        label: Amounts are consistent
        description: Line amounts add up to the net amount and net plus VAT equals the total (rounding up to 0.05).
        kind: must
        weight: 2
        keywords: [toplam, total, kdv, vat]
      - id: po_match
        label: Matches the purchase order
        description: References an open purchase order of this supplier; prices within tolerance of the PO prices.
        kind: must
        weight: 3
        keywords: [sipariş, purchase order, po no]
      - id: receipt_match
        label: Matches the goods receipt
        description: Invoiced quantities do not exceed the quantities received and not yet invoiced (3-way match).
        kind: must
        weight: 3
        keywords: [irsaliye, delivery note, teslim, received]
      - id: bank_details
        label: Bank details match the supplier master
        description: The IBAN on the invoice equals the IBAN in the supplier master; changed bank details are a fraud signal.
        kind: must
        weight: 2
        keywords: [iban]
        blockers: [our bank details have changed, new bank account, please use the new iban, changed our bank, banka hesabımız değişti, yeni iban numaramız, yeni hesap numaramız, ödemeleri yeni hesaba]
      - id: mandatory_fields
        label: Legally required fields present
        description: Invoice number and date, supplier tax ID and tax office, buyer details, VAT breakdown and, for e-invoices, the ETTN.
        kind: nice
        weight: 1
        keywords: [ettn, vergi dairesi, tax office]
  - id: ap_note
    name: Write the AP note
    type: llm.generate
    format: markdown
    prompt: |-
      Write a review note for the AP clerk about invoice {{ steps.invoice.invoice_number }} from {{ steps.invoice.supplier_name }}.
      Invoice: {{ steps.invoice | json }}
      Checks: {{ steps.checks | json }}
      Structure: one-line status (ready to post / needs attention / do not post) with the total amount; a table
      of the checks (check, result, evidence); the variances with amounts; the recommended action. Max 180 words.
    fallback: |-
      Invoice {{ steps.invoice.invoice_number | default:'(number not found)' }} from {{ steps.invoice.supplier_name | default:'(supplier not found)' }}
      Total {{ steps.invoice.total_amount }} {{ steps.invoice.currency }} (net {{ steps.invoice.net_amount }}, VAT {{ steps.invoice.tax_amount }}), PO {{ input.po_number || steps.invoice.po_number | default:'none' }}
      Checks: {{ steps.checks.verdict }}, score {{ steps.checks.score }}/100

      Passed:
      {{ steps.checks.strengths | bullets }}

      Needs attention:
      {{ steps.checks.gaps | bullets }}
  - id: approve
    name: AP approval
    type: approval
    when: "!steps.checks.knockout"
    title: "Post invoice {{ steps.invoice.invoice_number }} from {{ steps.invoice.supplier_name }}: {{ steps.invoice.total_amount }} {{ steps.invoice.currency }}?"
    details: "{{ steps.ap_note.text }}"
    assigneeRole: ap-clerk
  - id: post
    name: Post the invoice in the ERP
    type: connector
    when: steps.approve.approved
    connector: erp
    operation: post_supplier_invoice
    requiresApproval: false # approved by the AP clerk in "approve"
    input:
      supplier_id: "{{ steps.supplier.supplier_id || steps.supplier_search.items.0.supplier_id }}"
      invoice_number: "{{ steps.invoice.invoice_number }}"
      invoice_date: "{{ steps.invoice.invoice_date }}"
      currency: "{{ steps.invoice.currency | default:'TRY' }}"
      net_amount: "{{ steps.invoice.net_amount }}"
      tax_amount: "{{ steps.invoice.tax_amount | default:0 }}"
      total_amount: "{{ steps.invoice.total_amount }}"
      po_number: "{{ input.po_number || steps.invoice.po_number }}"
    onError: continue
  - id: result
    type: output
    value:
      invoice: "{{ steps.invoice }}"
      supplier_id: "{{ steps.supplier.supplier_id }}"
      po_number: "{{ input.po_number || steps.invoice.po_number }}"
      check_score: "{{ steps.checks.score }}"
      verdict: "{{ steps.checks.verdict }}"
      issues: "{{ steps.checks.gaps }}"
      match_status: "{{ steps.post.match_status }}"
      erp_document: "{{ steps.post.document_number }}"
      status: "{{ (steps.checks.knockout && 'Rejected: failed a mandatory check') || steps.post.error || steps.post.status || (steps.approve && 'Not approved') || 'Pending' }}"
      ap_note: "{{ steps.ap_note.text }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: contains
  notes:
    - Invoices are legal documents; extracted amounts are never altered, and the ERP and e-archive remain the system of record (10-year retention under VUK).
    - A changed IBAN or a blocked supplier is never paid on the invoice's word; bank details are verified by call-back to a known contact.
    - Nothing is posted without the AP clerk's approval; the ERP's 3-way match blocks price and quantity variances for payment.
ui:
  layout: form-results
  title: Supplier invoice processing
  description: Upload an invoice or let the agent read the AP mailbox.
  submitLabel: Process invoice
  resultView: cards
  highlight: [verdict, check_score, match_status, status, issues]
kpis:
  - {id: cycle-time, name: Receipt-to-posting time, target: "< 3 days"}
  - {id: first-pass-match, name: First-pass match rate, target: "> 85%"}
  - {id: extraction-accuracy, name: Header fields correct without edits, target: "> 98%"}
builder:
  matchPhrases:
    - invoice processing
    - supplier invoices
    - vendor invoices
    - accounts payable
    - ap automation
    - invoice ocr
    - three-way match
    - 3-way match
    - purchase invoice
    - fatura
    - fatura işleme
    - gelen fatura
    - tedarikçi faturası
    - fatura onayı
    - fatura eşleştirme
    - alış faturası
    - e-fatura
    - muhasebe fatura girişi
  questions:
    - id: invoice.types
      section: inputs
      title: Invoice types
      question: Which kinds of supplier invoices do you receive? (pick all that apply)
      why: e-Fatura XML needs no OCR and carries a verified tax ID, PDFs and scans need OCR, and invoices from foreign suppliers follow different VAT rules (reverse charge) and currencies.
      answerType: multi
      options:
        - {value: e-fatura, label: "e-Fatura (UBL-TR XML) through our GİB integrator"}
        - {value: e-arsiv, label: e-Arşiv invoices as PDF}
        - {value: pdf-scan, label: PDF or scanned invoices by email}
        - {value: paper, label: Paper invoices scanned in the mail room}
        - {value: foreign, label: Invoices from foreign suppliers (EUR/USD)}
      recommended: [e-fatura, pdf-scan, foreign]
      owner: requester
      priority: 10
    - id: invoice.matching
      section: processing
      title: Matching rule
      question: Which matching rule applies to your invoices?
      why: The matching rule decides which ERP documents must exist before an invoice can be posted and what counts as a variance.
      answerType: single
      options:
        - {value: three-way, label: "3-way match: purchase order, goods receipt and invoice"}
        - {value: two-way, label: "2-way match: purchase order and invoice (e.g. services)"}
        - {value: mixed, label: "3-way for goods, 2-way for services, cost-center coding for non-PO invoices"}
      recommended: mixed
      recommendationReason: Most companies buy both goods and services and still receive some non-PO invoices (utilities, rent).
      owner: process-owner
      specPath: workflow.checks.criteria
      priority: 20
    - id: invoice.tolerances
      section: processing
      title: Price and quantity tolerances
      question: How large may price and quantity differences be before an invoice is held for review?
      why: Tolerances that are too tight flood the AP team with trivial exceptions; tolerances that are too loose let overbilling through.
      answerType: text
      recommended: "Price: at most +2% or 500 TRY per line, whichever is lower. Quantity: never more than received. Rounding up to 1 TRY per invoice."
      prerequisites: [invoice.matching]
      owner: finance
      delegable: true
      specPath: workflow.checks.instructions
      priority: 30
    - id: invoice.approval_matrix
      section: governance
      title: Approval matrix
      question: Who approves which invoices before posting and payment?
      why: Segregation of duties and approval limits are key internal controls that auditors test.
      answerType: text
      recommended: "AP clerk: matched invoices up to 250,000 TRY. Finance manager: above 250,000 TRY and every variance. CFO: above 2,500,000 TRY."
      owner: finance
      delegable: true
      specPath: workflow.approve.assigneeRole
      priority: 20
    - id: invoice.posting_mode
      section: actions
      title: What the agent may do in the ERP
      question: After the checks, should the agent post invoices in the ERP, or only prepare them?
      why: Posting creates a payable. Starting with approval-gated posting keeps a person accountable while the team builds trust in the agent.
      answerType: single
      options:
        - {value: prepare-only, label: Prepare only; the AP team posts manually}
        - {value: post-after-approval, label: Post after the AP clerk approves each invoice}
        - {value: auto-post-matched, label: Post fully matched invoices below a limit automatically; approve the rest}
      recommended: post-after-approval
      owner: process-owner
      specPath: workflow.post
      priority: 40
    - id: invoice.fraud_checks
      section: governance
      title: Duplicate and fraud checks
      question: Which duplicate and fraud checks must run before an invoice can be approved?
      why: Duplicate payments and bank-detail changes by email (business email compromise) are the most common AP losses.
      answerType: multi
      options:
        - {value: duplicate-number, label: Same invoice number from the same supplier}
        - {value: duplicate-amount, label: Same amount and date under a different number}
        - {value: iban-change, label: IBAN differs from the supplier master}
        - {value: blocked-supplier, label: Supplier blocked or not in the master}
      recommended: [duplicate-number, duplicate-amount, iban-change, blocked-supplier]
      owner: finance
      priority: 30
---
You are the **Invoice Processor** of the accounts payable team. You turn supplier invoices into correct, fully checked ERP postings, so the AP team only handles real exceptions and no invoice is paid twice or to the wrong account.

## Objectives
- Capture every invoice accurately, whatever its format: PDF, scan, phone photo or e-invoice (UBL-TR).
- Validate it against the ERP: supplier master, purchase order, goods receipt and existing invoices (3-way match).
- Apply the AP policy's tolerances and approval rules and give the AP clerk a clear recommendation.
- Post approved invoices in the ERP and report the ERP's match result.

## Method
1. Read the invoice and extract header, amounts and lines. The supplier is the issuer (satıcı), not the buyer.
2. Find the supplier by tax ID (VKN) first, then by name; read the supplier master including status and IBAN.
3. Read the purchase order with received and invoiced quantities, and check whether the invoice number already exists.
4. Evaluate: supplier active, not a duplicate, arithmetic, PO prices, received quantities, bank details, mandatory fields.
5. Write the AP note and ask the AP clerk for approval. Invoices that fail a mandatory check (unknown or blocked supplier, duplicate) are not offered for posting.
6. Post the approved invoice; variances are blocked for payment by the ERP.

## Rules
- Never change, round or "correct" amounts from the invoice. If numbers do not add up, report it.
- A different IBAN than in the supplier master, or a request to change bank details, is a potential fraud case: flag it prominently and never treat it as a formality.
- Never post an invoice for a blocked supplier or without approval.
- Invoices are legal documents (VUK): the ERP and the e-archive stay the system of record.
- When extraction is uncertain (blurred scan, handwritten corrections), say which field and why.

## Output
Invoice data, supplier and PO, the check result with score and issues, the ERP match status and document number, the status and the AP note.

## Tone
Precise, concise and audit-ready: every statement can be traced to the invoice or the ERP.
