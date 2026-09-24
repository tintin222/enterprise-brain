---
id: sales.lead-qualifier
slug: sales-lead-qualifier
name: Lead Qualifier
title: Inbound Sales Development Representative
summary: >-
  Reads inbound inquiries from the sales mailbox or website form, separates buying intent from other
  mail, extracts company, need, budget and timeline, checks the CRM, scores the lead against the ideal
  customer profile, creates the CRM lead and drafts the first reply for SDR approval.
department: sales
process: sales.lead-qualification
archetype: mail-triage
reportsTo: sales-development-rep
tags: [lead-qualification, inbound, crm, lead-scoring, flagship]
capabilities:
  - mail.send
  - connector:crm.search_accounts
  - connector:crm.search_contacts
  - connector:crm.create_lead
  - connector:crm.log_activity
triggers:
  - type: mailbox
    mailbox: sales@company.com
  - type: webhook
    description: Website demo and contact form submissions.
  - type: manual
inputs:
  - key: email
    label: Inbound email
    type: object
    description: Set automatically for emails to the sales mailbox.
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
  - {key: company, label: Company, type: string}
  - {key: contact_name, label: Contact name, type: string}
  - {key: contact_email, label: Contact email, type: email}
  - {key: phone, label: Phone, type: phone}
  - {key: message, label: Message, type: text}
  - key: source
    label: Source
    type: select
    options:
      - {value: website-form, label: Website form}
      - {value: email, label: Email}
      - {value: trade-fair, label: Trade fair}
      - {value: partner-referral, label: Partner referral}
      - {value: linkedin, label: LinkedIn}
outputs:
  - {key: category, label: Category, type: string}
  - {key: lead, label: Lead data, type: object}
  - {key: score, label: Lead score, type: number}
  - key: verdict
    label: Qualification
    type: select
    options:
      - {value: pass, label: Qualified}
      - {value: review, label: Needs qualification call}
      - {value: fail, label: Not a fit}
  - {key: fit_evidence, label: Fit criteria met, type: list, itemType: string}
  - {key: crm_lead_id, label: CRM lead, type: string}
  - {key: next_action, label: Next action, type: string}
  - {key: reply_draft, label: Reply draft, type: text}
  - {key: sent, label: Reply sent, type: boolean}
connectors:
  - ref: crm
    category: crm
    purpose: Look up existing accounts and contacts, create leads and log activities.
    operations: [search_accounts, search_contacts, create_lead, log_activity]
workflow:
  - id: intent
    name: Classify the inquiry
    type: llm.classify
    from: |-
      From: {{ input.email.fromName || input.contact_name }} <{{ input.email.from || input.contact_email }}>
      Subject: {{ input.email.subject }}
      {{ input.email.body | truncate:6000 }}
      {{ input.message }}
    categories:
      - value: sales-inquiry
        label: Sales inquiry
        description: A prospect asks for a quote, demo, pricing, product information for a purchase, or a meeting.
        keywords: [quote, teklif, demo, pricing, fiyat, price list, fiyat listesi, interested, ilgileniyoruz, meeting, toplantı, proposal, purchase, satın almak]
      - value: partnership
        label: Partnership
        description: Reseller, distributor, integration or referral partnership proposals.
        keywords: [partnership, iş ortaklığı, bayilik, distributor, distribütör, reseller, bayi]
      - value: existing-customer
        label: Existing customer request
        description: Support, delivery, invoice or account questions from a current customer; route to customer service.
        keywords: [order, sipariş, invoice, fatura, support, destek, delivery, teslimat, complaint, şikayet]
      - value: job-application
        label: Job application
        keywords: [cv, özgeçmiş, application, başvuru, position, pozisyon, internship, staj]
      - value: vendor-offer
        label: Vendor offer
        description: Someone trying to sell services to us.
        keywords: [we offer, hizmetlerimiz, our services, seo, outsourcing, sponsorship, sponsorluk]
      - value: other
        label: Other or spam
  - id: lead
    name: Extract lead data
    type: llm.extract
    from: |-
      From: {{ input.email.fromName || input.contact_name }} <{{ input.email.from || input.contact_email }}>
      Company (form): {{ input.company }}
      Phone (form): {{ input.phone }}
      Subject: {{ input.email.subject }}
      {{ input.email.body || input.message }}
    fields:
      - key: company
        label: Company
        type: string
        hints: ["Company", "Şirket", "Firma", "A.Ş.", "Ltd.", "GmbH"]
      - {key: contact_name, label: Contact name, type: string}
      - key: job_title
        label: Job title
        type: string
        hints: ["Manager", "Müdür", "Director", "Direktör", "Head of", "Mühendis", "Engineer"]
      - {key: email, label: Email, type: email}
      - {key: phone, label: Phone, type: phone, hints: ["Tel", "Phone", "GSM", "Mobile"]}
      - {key: country, label: Country, type: string}
      - {key: city, label: City, type: string}
      - {key: industry, label: Industry, type: string}
      - key: company_size
        label: Company size
        type: select
        options: [{value: "1-49"}, {value: "50-249"}, {value: "250-999"}, {value: "1000+"}]
      - {key: need, label: Need / use case, type: text, description: "What they want to achieve or buy, in 1-2 sentences."}
      - {key: products, label: Products of interest, type: list, itemType: string}
      - {key: budget, label: Budget (as stated), type: string}
      - {key: timeline, label: Timeline (as stated), type: string}
      - key: requested_action
        label: Requested action
        type: select
        options: [{value: quote}, {value: demo}, {value: meeting}, {value: information}, {value: trial}]
      - {key: language, label: Language, type: string, description: "ISO code of the email language, e.g. tr, en, de"}
  - id: account
    name: Look up the company in the CRM
    type: connector
    when: steps.lead.company || input.company
    connector: crm
    operation: search_accounts
    input:
      query: "{{ steps.lead.company || input.company }}"
    onError: continue
  - id: contact
    name: Look up the contact in the CRM
    type: connector
    when: steps.lead.email || input.contact_email || input.email.from
    connector: crm
    operation: search_contacts
    input:
      email: "{{ steps.lead.email || input.contact_email || input.email.from }}"
    onError: continue
  - id: score
    name: Score against the ideal customer profile
    type: llm.evaluate
    when: "steps.intent.category == 'sales-inquiry'"
    from: |-
      Lead: {{ steps.lead | json }}
      Message: {{ input.email.body || input.message | truncate:4000 }}
    context: |-
      Existing CRM accounts matching the company: {{ steps.account.items | json }}
      Existing CRM contact with this email: {{ steps.contact.items | json }}
    passScore: 60
    instructions: >-
      Default ideal customer profile: industrial companies (manufacturing, energy, water and utilities,
      food and beverage, chemicals, mining, EPC contractors) with 50 or more employees in Türkiye, Europe
      or the Middle East. Base every judgement on the message and the CRM context.
    criteria:
      - id: industry_fit
        label: Target industry
        description: Operates in an industry we serve.
        kind: must
        weight: 2
        keywords: [manufacturing, üretim, fabrika, plant, energy, enerji, water, su, food, gıda, chemical, kimya, mining, maden, refinery, rafineri]
      - id: size_fit
        label: Company size
        description: 50 or more employees, several sites, or a revenue level that fits our offering.
        kind: must
        weight: 2
        keywords: [employees, çalışan, personel, factories, fabrikalar, sites, tesis, group, holding]
      - id: buying_intent
        label: Buying intent
        description: Explicit request for a quote, demo, pricing or meeting about a concrete need.
        kind: must
        weight: 3
        keywords: [quote, teklif, demo, pricing, fiyat, meeting, toplantı, proposal, görüşme]
      - id: timeline
        label: Near-term timeline
        description: Wants to decide or start within about six months.
        kind: nice
        weight: 1
        keywords: [this quarter, bu çeyrek, next month, gelecek ay, asap, acil, en kısa sürede, yıl sonuna kadar]
      - id: budget
        label: Budget indicated
        description: Mentions an approved or planned budget or a volume.
        kind: nice
        weight: 1
        keywords: [budget, bütçe, approved, onaylı, adet, units, volume]
      - id: decision_maker
        label: Decision maker involved
        description: Contact is a manager, director, owner or C-level, or names the decision process.
        kind: nice
        weight: 1
        keywords: [director, direktör, müdür, manager, head of, ceo, cfo, coo, owner, genel müdür, satın alma müdürü]
      - id: legitimate_business
        label: Legitimate business inquiry
        description: A real company with a business email or domain; not a student project, a competitor or a consumer.
        kind: knockout
        keywords: [a.ş, ltd, şirket, company, gmbh, inc, holding, san. ve tic]
        blockers: [student project, school project, for my thesis, personal use, for my home, öğrenci projesi, tez çalışması, ödevim için, kişisel kullanım, evim için]
  - id: crm_lead
    name: Create the CRM lead
    type: connector
    when: "steps.intent.category == 'sales-inquiry' && steps.score.verdict != 'fail' && !steps.contact.total"
    connector: crm
    operation: create_lead
    input:
      company: "{{ steps.lead.company || input.company }}"
      contact_name: "{{ steps.lead.contact_name || input.contact_name || input.email.fromName }}"
      email: "{{ steps.lead.email || input.contact_email || input.email.from }}"
      phone: "{{ steps.lead.phone || input.phone }}"
      source: "{{ (input.email.from && 'Email: sales mailbox') || input.source || 'Website form' }}"
      notes: "Need: {{ steps.lead.need }} | Products: {{ steps.lead.products | join }} | Timeline: {{ steps.lead.timeline | default:'n/a' }} | Budget: {{ steps.lead.budget | default:'n/a' }} | Fit: {{ steps.score.summary }}"
      score: "{{ steps.score.score }}"
    onError: continue
  - id: reply
    name: Draft the first reply
    type: llm.generate
    when: "steps.intent.category == 'sales-inquiry'"
    prompt: |-
      Draft the first reply to this inbound inquiry on behalf of the sales team.
      Lead: {{ steps.lead | json }}
      Qualification: score {{ steps.score.score }}, {{ steps.score.verdict }}; {{ steps.score.summary }}
      Original message: {{ input.email.body || input.message | truncate:4000 }}

      Reply in the sender's language ({{ steps.lead.language | default:'same as the message' }}). Thank them, reflect their need
      in one sentence, and propose the next step: for a qualified lead two meeting slots next week; otherwise one or two
      qualifying questions (volume, timeline, application). Do not quote prices or delivery dates. Max 130 words.
      Sign as "Sales Team".
    fallback: |-
      Sayın {{ steps.lead.contact_name || input.contact_name || input.email.fromName | default:'İlgili' }},

      Talebiniz için teşekkür ederiz. Satış ekibimiz ihtiyacınızı değerlendirmek için sizinle kısa bir görüşme yapmak istiyor; size uygun iki zaman aralığını paylaşabilir misiniz?

      Dear {{ steps.lead.contact_name || input.contact_name || input.email.fromName | default:'Sir or Madam' }},

      Thank you for your inquiry. Our sales team would like to schedule a short call to understand your requirements; could you share two time slots that suit you?

      Kind regards,
      Sales Team
  - id: approve_reply
    name: SDR approval
    type: approval
    when: "steps.reply.text && (input.email.from || input.contact_email)"
    title: "Reply to {{ steps.lead.contact_name || input.email.from }} ({{ steps.lead.company | default:'unknown company' }}), lead score {{ steps.score.score }}"
    details: |-
      Qualification: {{ steps.score.verdict }} ({{ steps.score.score }}/100). {{ steps.score.summary }}
      CRM lead: {{ steps.crm_lead.lead_id | default:'not created (existing contact or not qualified)' }}

      {{ steps.reply.text }}
    assigneeRole: sales-development-rep
  - id: send_reply
    name: Send the reply
    type: mail.send
    when: steps.approve_reply.approved
    requiresApproval: false # approved by the SDR in "approve_reply"
    to: "{{ input.email.from || input.contact_email }}"
    subject: "Re: {{ input.email.subject | default:'Your inquiry' }}"
    body: "{{ steps.reply.text }}"
    inReplyTo: "{{ input.email.id }}"
  - id: activity
    name: Log the reply in the CRM
    type: connector
    when: steps.send_reply.sent && (steps.crm_lead.lead_id || steps.contact.total)
    connector: crm
    operation: log_activity
    input:
      related_to: "{{ steps.crm_lead.lead_id || steps.contact.items.0.contact_id }}"
      type: email
      subject: "First reply to inbound inquiry: {{ input.email.subject | default:'website form' }}"
      notes: "Lead score {{ steps.score.score }} ({{ steps.score.verdict }}). Reply approved by the SDR and sent."
    onError: continue
  - id: result
    type: output
    value:
      category: "{{ steps.intent.category }}"
      lead: "{{ steps.lead }}"
      score: "{{ steps.score.score }}"
      verdict: "{{ steps.score.verdict }}"
      fit_evidence: "{{ steps.score.strengths }}"
      crm_lead_id: "{{ steps.crm_lead.lead_id }}"
      next_action: "{{ (steps.intent.category != 'sales-inquiry' && 'Route to the responsible team') || (steps.score.verdict == 'pass' && 'Book a discovery call') || (steps.score.verdict == 'review' && 'SDR qualification call') || 'Nurture or disqualify' }}"
      reply_draft: "{{ steps.reply.text }}"
      sent: "{{ steps.send_reply.sent || false }}"
guardrails:
  approvalRequiredFor: [mail.send]
  personalData: contains
  retentionDays: 730
  notes:
    - Leads and CRM activities are created automatically; every reply to a prospect is approved by an SDR.
    - Inquiry data is used to answer the inquiry. Marketing messages need explicit consent (KVKK) and, in Türkiye, registration in İYS; the agent never subscribes anyone to newsletters.
tests:
  - name: Demo request from a Turkish manufacturer
    input:
      email:
        id: sample-lead-001
        mailbox: sales@company.com
        from: murat.kaya@anadolumakina.example
        fromName: Murat Kaya
        to: [sales@company.com]
        subject: Demo talebi - pompa izleme çözümü
        body: |-
          Merhaba,
          Anadolu Makina A.Ş. olarak Konya ve Kayseri'deki iki fabrikamızda yaklaşık 850 çalışanımız var.
          Soğutma suyu hattındaki 40 santrifüj pompamız için uzaktan izleme ve bakım planlama çözümünüzü incelemek istiyoruz.
          Bu yıl sonuna kadar karar vermeyi planlıyoruz; bütçemiz onaylı. Önümüzdeki hafta bir demo ayarlayabilir miyiz?
          Murat Kaya
          Bakım ve Enerji Müdürü
        attachments: []
        attachmentNames: []
        receivedAt: "2026-09-22T08:15:00Z"
ui:
  layout: inbox
  title: Inbound leads
  description: Every inbound inquiry with its category, score, CRM lead and reply draft.
  highlight: [category, score, verdict, next_action]
kpis:
  - {id: speed-to-lead, name: Speed to lead, target: "< 60 min"}
  - {id: sdr-agreement, name: SDR agreement with the qualification, target: "> 85%"}
  - {id: lead-coverage, name: Inquiries logged in the CRM, target: "100%"}
builder:
  matchPhrases:
    - lead qualification
    - qualify leads
    - inbound leads
    - lead scoring
    - demo requests
    - sales inquiries
    - web form leads
    - sales mailbox
    - potansiyel müşteri
    - müşteri adayı
    - lead değerlendirme
    - lead skorlama
    - satış talepleri
    - demo talebi
  questions:
    - id: lead.icp
      replaces: [docs.criteria]
      section: processing
      title: Ideal customer profile
      question: Which criteria make a lead a good fit, and which ones are must-haves?
      why: An explicit ideal customer profile turns "gut feeling" into a score the SDR team can explain and improve.
      answerType: criteria
      recommended:
        - Target industry, e.g. manufacturing, energy, water, food and beverage (must, weight 2)
        - Company size of 50+ employees (must, weight 2)
        - Explicit buying intent such as quote, demo or meeting (must, weight 3)
        - Timeline within six months (nice, weight 1)
        - Budget indicated (nice, weight 1)
        - Decision maker involved (nice, weight 1)
      owner: process-owner
      specPath: workflow.score.criteria
      priority: 20
    - id: lead.thresholds
      section: processing
      title: Score thresholds
      question: At which score should a lead go to sales, be nurtured or be disqualified?
      why: Thresholds set the balance between sales capacity and not missing opportunities.
      answerType: single
      options:
        - {value: strict, label: "80+ to sales, 50-79 nurture, below 50 disqualify"}
        - {value: balanced, label: "60+ to sales, 40-59 SDR qualification call, below 40 nurture or disqualify"}
        - {value: inclusive, label: "40+ to sales, everything else nurture"}
      recommended: balanced
      prerequisites: [lead.icp]
      owner: process-owner
      specPath: workflow.score.passScore
      priority: 30
    - id: lead.routing
      replaces: [mail.routing]
      section: actions
      title: Lead routing
      question: >-
        Who should receive qualified leads (by territory, industry, product or account size), and where should
        the other messages go (partnership offers, job applications, requests from existing customers)?
      why: Leads contacted by the right owner within the hour convert several times better than leads that wait in a queue.
      answerType: text
      recommended: "Leads by territory: Türkiye to the domestic sales team, DACH and Nordics to the DACH account executive, rest of Europe, Middle East and Africa to the export team. Partnerships to business development, job applications to HR, existing customers to customer service."
      prerequisites: [lead.thresholds]
      owner: process-owner
      priority: 40
    - id: lead.first_reply
      replaces: [mail.reply_policy]
      section: actions
      title: First reply to the prospect
      question: How should the first reply to an inbound lead be handled?
      why: Speed matters, but a wrong promise in the first email costs trust; approval keeps the SDR in control.
      answerType: single
      options:
        - {value: draft, label: Draft a reply for the SDR to approve, description: recommended to start}
        - {value: auto-simple, label: Acknowledge automatically; the SDR drafts the personal follow-up}
        - {value: none, label: No reply; only create the lead}
      recommended: draft
      owner: requester
      priority: 30
    - id: lead.consent
      section: governance
      title: Consent and marketing follow-up
      question: May leads receive marketing follow-up (newsletters, campaigns), and on what legal basis?
      why: Commercial electronic messages in Türkiye require prior consent registered in İYS, and KVKK/GDPR limit using inquiry data for other purposes.
      answerType: single
      options:
        - {value: answer-only, label: Use inquiry data only to answer the inquiry}
        - {value: opt-in, label: Marketing only for contacts who opted in on the form (registered in İYS)}
        - {value: legal-review, label: Ask legal / the DPO to define the basis}
      recommended: answer-only
      owner: dpo
      delegable: true
      priority: 20
---
You are the **Lead Qualifier**, the inbound sales development representative of the sales team. Your job is to make sure that every real buying signal gets a fast, relevant answer and lands in the CRM with the context sales needs, while everything else goes to the right place.

## Objectives
- Separate genuine sales inquiries from partnership offers, customer service requests, job applications and vendor pitches.
- Capture the lead completely: company, contact, role, need, products, budget, timeline and requested next step.
- Score the lead against the ideal customer profile with evidence, check whether the company or contact is already known, and create the CRM lead.
- Draft a first reply that moves the conversation forward, sent only after the SDR approves it.

## Method
1. Classify the message. Non-sales messages are not scored; say which team should handle them.
2. Extract the lead data from the email or form, and look up the account and contact in the CRM.
3. Score the inquiry: industry, size, buying intent (must-haves), timeline, budget and decision maker (nice-to-haves).
4. Create the lead when the inquiry qualifies and the contact is not already in the CRM; otherwise note the existing record.
5. Draft the reply in the sender's language, get the SDR's approval, send it and log it in the CRM.

## Rules
- Never quote prices, discounts, delivery dates or technical commitments; propose a conversation instead.
- Use only facts from the message and the CRM. If company size or industry is not stated, mark it as unknown instead of guessing.
- Do not create duplicates: existing contacts and accounts are referenced, not recreated.
- Inquiry data is used to answer the inquiry. Never add anyone to marketing lists (KVKK consent, İYS in Türkiye).
- Competitors, students and job seekers are handled politely but not scored as leads.

## Output
Category, lead data, score and qualification with evidence, CRM lead ID, next action and the reply draft.

## Tone
Energetic, helpful and concise. Mirror the prospect's language and formality.
