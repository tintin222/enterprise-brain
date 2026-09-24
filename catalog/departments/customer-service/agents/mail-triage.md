---
id: customer-service.mail-triage
slug: customer-service-mail-triage
name: Mail Triage
title: Customer Service Triage Specialist
summary: >-
  Reads every customer email, classifies it, extracts order number, product and urgency, looks up
  the contact in the CRM and the order in the ERP, creates the CRM case, drafts a reply in the
  customer's language from the support knowledge base and sends it after a support specialist approves.
department: customer-service
process: customer-service.email-triage
archetype: mail-triage
reportsTo: support-team-lead
tags: [mail-triage, customer-support, case-management, flagship]
capabilities:
  - knowledge.search
  - mail.send
  - connector:crm.search_contacts
  - connector:crm.create_case
  - connector:crm.update_case
  - connector:erp.get_sales_order
triggers:
  - type: mailbox
    mailbox: support@company.com
inputs:
  - key: email
    label: Customer email
    type: object
    required: true
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
  - {key: category, label: Category, type: string}
  - {key: confidence, label: Confidence, type: number}
  - {key: urgency, label: Priority, type: string}
  - {key: sentiment, label: Sentiment, type: string}
  - {key: summary, label: Summary, type: text}
  - {key: customer, label: Customer, type: string}
  - {key: case_id, label: CRM case, type: string}
  - {key: order_status, label: Order status, type: string}
  - {key: reply_draft, label: Reply draft, type: text}
  - {key: sent, label: Reply sent, type: boolean}
connectors:
  - ref: crm
    category: crm
    purpose: Identify the contact and account; create and update the case.
    operations: [search_contacts, create_case, update_case]
  - ref: erp
    category: erp
    purpose: Live order and delivery status for order-related emails.
    operations: [get_sales_order]
knowledge:
  collections: [support-kb]
workflow:
  - id: classify
    name: Classify the email
    type: llm.classify
    from: |-
      From: {{ input.email.fromName }} <{{ input.email.from }}>
      Subject: {{ input.email.subject }}
      Attachments: {{ input.email.attachmentNames | join }}
      {{ input.email.body | truncate:8000 }}
    categories:
      - value: delivery
        label: Order and delivery status
        description: Where is my order, delivery date, shipment tracking, late or partial delivery.
        keywords: [order status, sipariş durumu, delivery, teslimat, tracking, kargo, shipment, sevkiyat, when will, ne zaman, late, gecikme]
      - value: billing
        label: Invoice and payment
        description: Invoices, payments, credit notes, price differences, e-invoice questions.
        keywords: [invoice, fatura, payment, ödeme, credit note, iade faturası, e-arşiv, e-fatura, charged, tahsilat]
      - value: quality
        label: Product quality problem
        description: Defective, damaged or non-conforming product.
        keywords: [defect, arıza, broken, kırık, leak, sızıntı, damaged, hasarlı, noise, gürültü, vibration, titreşim, not working, çalışmıyor]
      - value: warranty
        label: Warranty, repair or return
        description: Warranty claims, repair or replacement requests, returns.
        keywords: [warranty, garanti, repair, tamir, onarım, replacement, değişim, return, iade, rma]
      - value: technical_support
        label: Technical support
        description: Installation, commissioning, operation, maintenance, spare parts, manuals.
        keywords: [installation, kurulum, commissioning, devreye alma, manual, kılavuz, how to, nasıl, spare part, yedek parça, maintenance, bakım]
      - value: information_request
        label: Information request
        description: Product information, datasheets, certificates, availability, general questions.
        keywords: [information, bilgi, catalog, katalog, datasheet, teknik föy, certificate, sertifika, availability, stok durumu]
      - value: complaint
        label: Complaint about service
        description: Dissatisfaction with service, communication or repeated problems.
        keywords: [complaint, şikayet, unacceptable, kabul edilemez, disappointed, memnun değilim, rezalet, third time, üçüncü kez]
      - value: data_protection
        label: Data protection request
        description: KVKK/GDPR data subject requests (access, correction, deletion, objection).
        keywords: [kvkk, gdpr, kişisel veri, personal data, verilerimin silinmesi, delete my data, data access request, açık rıza]
      - value: spam
        label: Spam or automatic reply
        keywords: [unsubscribe, abonelikten çık, out of office, otomatik yanıt, lottery, kazandınız, click here]
      - value: other
        label: Other
  - id: details
    name: Extract the request
    type: llm.extract
    from: |-
      From: {{ input.email.fromName }} <{{ input.email.from }}>
      Subject: {{ input.email.subject }}
      {{ input.email.body }}
    instructions: >-
      Urgency: urgent = production stopped, safety risk, legal threat or press; high = complaint, overdue
      order or angry customer; medium = normal request; low = information only.
    fields:
      - {key: customer_name, label: Customer name, type: string}
      - {key: company, label: Company, type: string}
      - key: order_number
        label: Order number
        type: string
        hints: ["SO-", "Sipariş No", "Order No", "Order number", "Auftrag"]
      - {key: invoice_number, label: Invoice number, type: string, hints: ["Fatura No", "Invoice No"]}
      - {key: product, label: Product, type: string}
      - {key: serial_number, label: Serial number, type: string, hints: ["Seri No", "S/N", "Serial"]}
      - {key: summary, label: Summary, type: text, required: true, description: "2 sentences in English: what happened and what the customer wants."}
      - {key: requested_action, label: Requested action, type: string}
      - key: urgency
        label: Urgency
        type: select
        options: [{value: low}, {value: medium}, {value: high}, {value: urgent}]
      - key: sentiment
        label: Sentiment
        type: select
        options: [{value: positive}, {value: neutral}, {value: negative}, {value: angry}]
      - {key: language, label: Language, type: string, description: "ISO code, e.g. tr, en, de"}
  - id: contact
    name: Find the contact in the CRM
    type: connector
    connector: crm
    operation: search_contacts
    input:
      email: "{{ input.email.from }}"
    onError: continue
  - id: order
    name: Read the order in the ERP
    type: connector
    when: steps.details.order_number
    connector: erp
    operation: get_sales_order
    input:
      order_number: "{{ steps.details.order_number }}"
    onError: continue
  - id: knowledge
    name: Search the support knowledge base
    type: knowledge.search
    when: "steps.classify.category != 'spam'"
    query: "{{ input.email.subject }} {{ steps.details.summary }}"
    collections: [support-kb]
    topK: 5
  - id: case
    name: Create the CRM case
    type: connector
    when: "steps.classify.category != 'spam'"
    connector: crm
    operation: create_case
    input:
      contact_email: "{{ input.email.from }}"
      subject: "{{ input.email.subject | default:'Customer email' }}"
      description: |-
        {{ steps.details.summary }}
        Requested action: {{ steps.details.requested_action | default:'-' }}
        Order: {{ steps.details.order_number | default:'-' }}; product: {{ steps.details.product | default:'-' }}

        Original email:
        {{ input.email.body | truncate:3000 }}
      priority: "{{ steps.details.urgency | default:'medium' }}"
      category: "{{ (steps.classify.category == 'data_protection' && 'other') || steps.classify.category }}"
    onError: continue
  - id: draft
    name: Draft the reply
    type: llm.generate
    when: "steps.classify.category != 'spam'"
    prompt: |-
      Draft a reply to this customer email. Category: {{ steps.classify.category }}; urgency: {{ steps.details.urgency }}.
      Customer: {{ steps.contact.items.0.full_name || input.email.fromName }}, {{ steps.details.company | default:'' }}.
      Case number: {{ steps.case.case_id | default:'(pending)' }}.
      Order data from the ERP: {{ steps.order | json | truncate:4000 }}
      Support knowledge (answer only from these sources): {{ steps.knowledge.context }}

      Email: "{{ input.email.subject }}"
      {{ input.email.body | truncate:6000 }}

      Write in the customer's language ({{ steps.details.language | default:'same as the email' }}). Acknowledge the issue,
      answer what the sources and the order data answer (order status, next delivery step), ask for missing information
      (order number, photos, serial number) when needed, and state the case number. Never promise refunds, compensation,
      delivery dates or technical causes that the sources do not confirm. For data protection requests only confirm
      receipt and the 30-day response period. Max 170 words. Sign as "Customer Service Team".
    fallback: |-
      Sayın {{ steps.contact.items.0.full_name || input.email.fromName | default:'Müşterimiz' }},

      Mesajınız için teşekkür ederiz. Talebiniz {{ steps.case.case_id | default:'kayıt' }} numarası ile kaydedilmiştir; ekibimiz en kısa sürede size dönüş yapacaktır.

      Dear {{ steps.contact.items.0.full_name || input.email.fromName | default:'customer' }},

      Thank you for your message regarding "{{ input.email.subject }}". Your request has been registered under case {{ steps.case.case_id | default:'(pending)' }} and our team will get back to you shortly.

      Kind regards,
      Customer Service Team
  - id: dpo_review
    name: DPO review of the data protection request
    type: approval
    when: "steps.classify.category == 'data_protection'"
    title: "Data protection request from {{ input.email.from }}: respond within 30 days (KVKK Art. 13 / GDPR Art. 12)"
    details: |-
      {{ steps.details.summary }}
      Case: {{ steps.case.case_id | default:'-' }}

      Proposed acknowledgement:
      {{ steps.draft.text }}
    assigneeRole: dpo
  - id: approve
    name: Support specialist approval
    type: approval
    when: "steps.classify.category != 'spam' && steps.classify.category != 'data_protection'"
    title: "Reply to {{ input.email.fromName || input.email.from }}: {{ input.email.subject }} [{{ steps.classify.category }}, {{ steps.details.urgency | default:'medium' }}]"
    details: |-
      Case {{ steps.case.case_id | default:'(not created)' }}. {{ steps.details.summary }}
      Order status: {{ steps.order.status | default:'n/a' }}

      {{ steps.draft.text }}
    assigneeRole: support-specialist
  - id: send
    name: Send the reply
    type: mail.send
    when: steps.approve.approved || steps.dpo_review.approved
    requiresApproval: false # approved by the support specialist (or the DPO) above
    to: "{{ input.email.from }}"
    subject: "Re: {{ input.email.subject }} [{{ steps.case.case_id | default:'Customer Service' }}]"
    body: "{{ steps.draft.text }}"
    inReplyTo: "{{ input.email.id }}"
  - id: update_case
    name: Record the reply on the case
    type: connector
    when: steps.send.sent && steps.case.case_id
    connector: crm
    operation: update_case
    input:
      case_id: "{{ steps.case.case_id }}"
      status: waiting_on_customer
      notes: "Reply sent to the customer: {{ steps.draft.text | truncate:1500 }}"
    onError: continue
  - id: result
    type: output
    value:
      category: "{{ steps.classify.category }}"
      confidence: "{{ steps.classify.confidence }}"
      urgency: "{{ steps.details.urgency | default:'medium' }}"
      sentiment: "{{ steps.details.sentiment }}"
      summary: "{{ steps.details.summary }}"
      customer: "{{ steps.contact.items.0.full_name || input.email.fromName }}"
      case_id: "{{ steps.case.case_id }}"
      order_status: "{{ steps.order.status }}"
      reply_draft: "{{ steps.draft.text }}"
      sent: "{{ steps.send.sent || false }}"
guardrails:
  approvalRequiredFor: [mail.send]
  personalData: contains
  retentionDays: 730
  notes:
    - Every customer email becomes a CRM case automatically; every reply is approved by a support specialist, and data protection requests by the DPO.
    - Replies never promise refunds, compensation, delivery dates or root causes that the knowledge base or the ERP does not confirm.
    - KVKK/GDPR data subject requests must be answered within 30 days; the agent only acknowledges them.
tests:
  - name: Delivery status question (Turkish)
    input:
      email:
        id: sample-support-001
        mailbox: support@company.com
        from: oguz.bayram@kuzeygida.example
        fromName: Oğuz Bayram
        to: [support@company.com]
        subject: SO-7000129 sipariş durumu hakkında
        body: |-
          Merhaba,
          SO-7000129 numaralı siparişimizin durumunu öğrenebilir miyiz? Samsun tesisimizdeki devreye alma planımız bu teslimata bağlı,
          sevkiyat tarihini netleştirmemiz gerekiyor.
          Teşekkürler,
          Oğuz Bayram, Üretim Müdürü, Kuzey Gıda
        attachments: []
        attachmentNames: []
        receivedAt: "2026-09-22T09:05:00Z"
  - name: Quality complaint (English)
    input:
      email:
        id: sample-support-002
        mailbox: support@company.com
        from: p.schmitt@hansa-pumpen.example
        fromName: Petra Schmitt
        to: [support@company.com]
        subject: Leaking mechanical seals on delivered pumps - third time
        body: |-
          Hello,
          for the third time this quarter, two of the centrifugal pumps from order SO-7000121 are leaking at the mechanical seal after less than 200 operating hours.
          Our customer is threatening to stop the project. This is unacceptable. We need replacement seals and a technician this week.
          Regards,
          Petra Schmitt, Service Coordinator, Hansa Pumpen Vertrieb GmbH
        attachments: []
        attachmentNames: []
        receivedAt: "2026-09-22T10:40:00Z"
ui:
  layout: inbox
  title: Support inbox
  description: Every customer email with category, priority, CRM case, order status and a reply draft.
  highlight: [category, urgency, sentiment, case_id, summary]
kpis:
  - {id: first-response-time, name: First response time, target: "< 4 h"}
  - {id: draft-acceptance, name: Replies approved without edits, target: "> 70%"}
  - {id: classification-accuracy, name: Correct category, target: "> 95%"}
builder:
  matchPhrases:
    - customer support emails
    - support mailbox
    - customer service emails
    - classify customer emails
    - email triage
    - draft replies to customers
    - reply to customer emails
    - customer inquiries
    - müşteri e-postaları
    - destek e-postaları
    - müşteri hizmetleri e-posta
    - müşteri taleplerini sınıflandırma
    - destek kutusu
    - e-postalara yanıt taslağı
    - şikayet e-postaları
  questions:
    - id: support.knowledge_sources
      section: inputs
      title: Sources for replies
      question: Which sources may the agent use to answer customers?
      why: Replies are only as good as their sources; outdated manuals or unapproved content turn into commitments the company has to honour.
      answerType: multi
      options:
        - {value: faq, label: FAQ and standard answers}
        - {value: manuals, label: Product manuals and datasheets}
        - {value: terms, label: "Delivery, return and warranty terms"}
        - {value: past-cases, label: Resolved cases (anonymised)}
        - {value: order-data, label: Live order and delivery status from the ERP}
      recommended: [faq, manuals, terms, order-data]
      owner: process-owner
      specPath: knowledge.collections
      priority: 10
    - id: support.priorities
      section: operations
      title: Priorities and response targets
      question: How should priorities be set, and what response time applies to each?
      why: Priority drives the SLA of the CRM case and the order in which specialists work the queue.
      answerType: text
      recommended: "Urgent (production stopped, safety, legal threat, press): 4 hours. High (complaint, overdue order, angry customer): 8 hours. Medium: 24 hours. Low (information only): 72 hours."
      owner: process-owner
      specPath: workflow.details.instructions
      priority: 20
    - id: support.escalations
      section: governance
      title: Mandatory escalations
      question: Which emails must always go to a specific person before anything else happens?
      why: Some messages carry legal deadlines or reputational risk that a standard reply can make worse.
      answerType: multi
      options:
        - {value: data-protection, label: "KVKK/GDPR data subject requests (30-day deadline) to the DPO"}
        - {value: legal-threat, label: "Legal threats: lawyers, courts, consumer arbitration committees"}
        - {value: safety, label: Injuries or safety risks to the quality manager}
        - {value: press, label: Journalists and public social media escalations to communications}
        - {value: key-accounts, label: Named key accounts to their account manager}
      recommended: [data-protection, legal-threat, safety, press, key-accounts]
      owner: process-owner
      delegable: true
      priority: 20
    - id: support.case_policy
      section: integrations
      title: When to create a CRM case
      question: Which emails should become a case in the CRM?
      why: Cases give traceability, SLAs and reporting; creating them for every email makes the workload visible.
      answerType: single
      options:
        - {value: every-email, label: Every customer email except spam}
        - {value: requests-only, label: Only emails that need an action (not thank-you or FYI mails)}
        - {value: never, label: No cases; only reply drafts}
      recommended: every-email
      owner: process-owner
      specPath: workflow.case
      priority: 30
    - id: support.tone
      section: outputs
      title: Tone and signature of replies
      question: What tone and form of address should replies use, and who signs them?
      why: A consistent brand voice builds trust; the signature decides whether replies look personal or team-based.
      answerType: text
      recommended: "Empathetic and solution-oriented; formal address ('siz' in Turkish, 'Sie' in German); signed by the Customer Service Team rather than an individual."
      owner: requester
      priority: 40
---
You are **Mail Triage**, the first line of the customer service team. Every customer email passes through you: you make sure it is understood, logged, prioritised and answered, and that nothing sensitive slips through without the right person seeing it.

## Objectives
- Classify every email (delivery, billing, quality, warranty, technical support, information, complaint, data protection) and set its urgency.
- Identify the customer in the CRM, look up the order in the ERP when an order number is mentioned, and create the CRM case.
- Draft a reply in the customer's language, grounded in the support knowledge base and the live order data.
- Send the reply only after a support specialist approves it; data protection requests go to the DPO.

## Method
1. Read the email, its subject and attachment names; detect the language.
2. Classify it and extract the order number, product, serial number, requested action, urgency and sentiment.
3. Look up the contact and, if available, the sales order with its status and delivery progress.
4. Create the case with the right category and priority, then search the knowledge base.
5. Draft the reply with the case number, get approval, send it and note it on the case.

## Rules
- Answer only what the knowledge base and the ERP confirm. Never promise refunds, credit notes, compensation, delivery dates or root causes on your own.
- Legal threats, safety issues, press inquiries and angry key accounts are marked urgent and escalated to the team lead.
- KVKK/GDPR requests (access, correction, deletion) are only acknowledged; the DPO answers within 30 days.
- Do not disclose information about other customers, internal costs or supplier names.
- If the email is unclear, ask for the missing information (order number, photos, serial number) instead of guessing.

## Output
Category with confidence, priority, sentiment, a short summary, customer, CRM case, order status, the reply draft and whether it was sent.

## Tone
Empathetic, clear and solution-oriented. Formal address, in the customer's language; acknowledge frustration without admitting fault that has not been established.
