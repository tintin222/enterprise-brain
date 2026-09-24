---
id: legal.contract-reviewer
slug: legal-contract-reviewer
name: Contract Reviewer
title: Contract Review Counsel (AI)
summary: >-
  Reads a contract (PDF, Word or scan), extracts its key clauses with clause numbers, assesses each
  against the company's contract playbook (standard positions, fallbacks and red lines) and writes a
  risk memo with proposed redlines for legal counsel.
department: legal
process: legal.contract-review
archetype: document-processing
reportsTo: legal-counsel
tags: [contract-review, clause-extraction, legal-risk, playbook, flagship]
capabilities: [documents.read, knowledge.search]
triggers:
  - type: manual
  - type: mailbox
    mailbox: legal@company.com
    filter:
      hasAttachment: true
inputs:
  - key: contract
    label: Contract
    type: file
    accept: [".pdf", ".docx", ".doc", ".png", ".jpg"]
  - key: contract_type
    label: Contract type
    type: select
    description: Leave empty to let the agent recognise it.
    options:
      - {value: nda, label: Non-disclosure agreement}
      - {value: customer, label: Customer / sales agreement}
      - {value: supply, label: Supply or purchase agreement}
      - {value: services, label: Services or SaaS agreement}
      - {value: distribution, label: Distribution or agency agreement}
      - {value: dpa, label: Data processing agreement}
      - {value: lease, label: Lease}
      - {value: other, label: Other}
  - key: our_role
    label: Our role
    type: select
    options:
      - {value: customer, label: We buy (customer)}
      - {value: supplier, label: We sell (supplier)}
      - {value: mutual, label: Mutual / partnership}
  - {key: counterparty, label: Counterparty, type: string}
  - key: business_context
    label: Business context
    type: text
    description: Value, duration, what is bought or sold, deadlines, anything legal should know.
  - key: email
    label: Review request email
    type: object
    description: Set automatically when a contract is sent to the legal mailbox.
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
  - {key: contract_type, label: Contract type, type: string}
  - {key: key_terms, label: Key terms, type: object}
  - {key: risk_score, label: Playbook conformity score, type: number}
  - key: risk_level
    label: Risk level
    type: select
    options:
      - {value: low, label: Within the playbook}
      - {value: medium, label: Deviations to negotiate}
      - {value: high, label: Red lines or major deviations}
  - {key: deviations, label: Deviations, type: list, itemType: string}
  - {key: assessment, label: Clause assessment, type: list}
  - {key: memo, label: Risk memo with redlines, type: text}
  - {key: reviewed, label: Reviewed by counsel, type: boolean}
knowledge:
  collections: [legal-playbook]
workflow:
  - id: document
    name: Read the contract
    type: extract
    from: "{{ input.contract || input.email.attachments.0 }}"
    ocr: auto
  - id: type
    name: Recognise the contract type
    type: llm.classify
    when: "!input.contract_type"
    from: "{{ steps.document.text | truncate:8000 }}"
    categories:
      - {value: nda, label: Non-disclosure agreement, keywords: [confidential information, gizlilik sözleşmesi, non-disclosure, gizli bilgi]}
      - {value: customer, label: Customer / sales agreement, keywords: [sales agreement, satış sözleşmesi, buyer, alıcı, purchase price]}
      - {value: supply, label: Supply or purchase agreement, keywords: [supply agreement, tedarik sözleşmesi, supplier, tedarikçi, deliveries]}
      - {value: services, label: Services or SaaS agreement, keywords: [services agreement, hizmet sözleşmesi, service levels, subscription, saas]}
      - {value: distribution, label: Distribution or agency agreement, keywords: [distributor, distribütör, bayilik, agency, acente, territory, bölge]}
      - {value: dpa, label: Data processing agreement, keywords: [data processing, veri işleme, processor, veri işleyen, kvkk, gdpr]}
      - {value: lease, label: Lease, keywords: [lease, kira sözleşmesi, landlord, kiraya veren, tenant, kiracı]}
      - {value: other, label: Other}
  - id: clauses
    name: Extract the key clauses
    type: llm.extract
    from: "{{ steps.document.text }}"
    instructions: >-
      For every field summarise the clause in one or two sentences and start with its clause number,
      e.g. "§12.2: liability capped at 100% of the annual fees; excludes indirect damages". Use null when
      the contract has no such clause. Quote amounts, periods and percentages exactly.
    fields:
      - {key: title, label: Title, type: string}
      - key: parties
        label: Parties
        type: list
        fields:
          - {key: name, type: string}
          - {key: role, type: string}
      - {key: effective_date, label: Effective date, type: date}
      - {key: term, label: Term, type: text}
      - {key: renewal, label: Renewal, type: text}
      - {key: termination, label: Termination rights and notice, type: text}
      - {key: liability, label: Limitation of liability, type: text}
      - {key: indemnities, label: Indemnities, type: text}
      - {key: warranties, label: Warranties, type: text}
      - {key: payment_terms, label: Payment terms, type: text}
      - {key: price_adjustment, label: Price adjustment, type: text}
      - {key: penalties, label: Penalties and liquidated damages (cezai şart), type: text}
      - {key: confidentiality, label: Confidentiality, type: text}
      - {key: data_protection, label: Data protection (KVKK/GDPR), type: text}
      - {key: intellectual_property, label: Intellectual property, type: text}
      - {key: exclusivity_non_compete, label: Exclusivity and non-compete, type: text}
      - {key: assignment, label: Assignment and change of control, type: text}
      - {key: force_majeure, label: Force majeure, type: text}
      - {key: governing_law, label: Governing law, type: text}
      - {key: dispute_resolution, label: Dispute resolution, type: text}
      - {key: signatories, label: Signatories, type: text}
  - id: playbook
    name: Look up the playbook positions
    type: knowledge.search
    query: "{{ input.contract_type || steps.type.category }} contract playbook {{ input.our_role | default:'' }} liability cap indemnity governing law termination payment terms red lines"
    collections: [legal-playbook]
    topK: 8
  - id: risk
    name: Assess against the playbook
    type: llm.evaluate
    from: "{{ steps.document.text }}"
    context: |-
      Contract type: {{ input.contract_type || steps.type.category }}; our role: {{ input.our_role | default:'not stated' }}; counterparty: {{ input.counterparty | default:'not stated' }}
      Business context: {{ input.business_context | default:'not provided' }}
      Extracted clauses: {{ steps.clauses | json }}
      Playbook: {{ steps.playbook.context }}
    passScore: 75
    instructions: >-
      Measure every clause against the playbook's standard position, acceptable fallback and red line for
      our role. Where the playbook is silent, use these defaults: liability capped at no more than 12 months'
      fees with carve-outs only for fraud, wilful misconduct, confidentiality and data protection breaches;
      Turkish law with Istanbul courts or ISTAC arbitration (or English law with LCIA arbitration for
      international deals); termination for convenience possible with at most 90 days' notice; payment at
      60 days when we buy and at most 30 days when we sell. Cite clause numbers as evidence.
    criteria:
      - id: liability
        label: Limitation of liability
        description: Our liability is capped per the playbook; no unlimited liability for us beyond the accepted carve-outs.
        kind: must
        weight: 3
        keywords: [limitation of liability, sorumluluğun sınırlandırılması, liability, sorumluluk]
      - id: indemnities
        label: Indemnities
        description: Indemnities are mutual or limited to IP infringement and third-party claims, and fall under the cap where the playbook requires.
        kind: must
        weight: 2
        keywords: [indemnif, tazmin]
      - id: governing_law
        label: Governing law and disputes
        description: Governing law and forum as per the playbook (Turkish law, Istanbul courts or ISTAC, or an approved alternative).
        kind: must
        weight: 2
        keywords: [governing law, uygulanacak hukuk, jurisdiction, yetkili mahkeme, arbitration, tahkim]
      - id: termination
        label: Term, renewal and termination
        description: No automatic renewal longer than 12 months without an exit; termination rights and notice periods per the playbook.
        kind: must
        weight: 2
        keywords: [termination, fesih, notice, ihbar, renewal, yenileme]
      - id: data_protection
        label: Data protection
        description: When personal data is processed, KVKK/GDPR-compliant terms (roles, security, sub-processors, transfers abroad) are included.
        kind: must
        weight: 2
        keywords: [kvkk, gdpr, personal data, kişisel veri, data protection]
      - id: confidentiality
        label: Confidentiality
        description: Confidentiality obligations are adequate and not one-sided against us.
        kind: must
        weight: 1
        keywords: [confidential, gizli]
      - id: payment
        label: Payment terms
        description: Payment terms, late-payment interest and price adjustment per the playbook for our role.
        kind: nice
        weight: 1
        keywords: [payment, ödeme, invoice, fatura]
      - id: ip
        label: Intellectual property
        description: IP ownership and licences per the playbook; no transfer of our background IP.
        kind: nice
        weight: 1
        keywords: [intellectual property, fikri mülkiyet, license, lisans]
      - id: red_lines
        label: No red-line terms
        description: >-
          None of the playbook's red lines, e.g. unlimited liability for us, exclusive foreign jurisdiction
          without arbitration, unilateral price changes by the counterparty, exclusivity or non-compete
          binding the whole group, disproportionate penalty clauses.
        kind: knockout
        blockers: [unlimited liability, liable without limitation, without any limitation of liability, unilaterally increase the prices, sınırsız sorumlu, fiyatları tek taraflı olarak artırma]
  - id: memo
    name: Write the risk memo
    type: llm.generate
    format: markdown
    prompt: |-
      Write the contract review memo for legal counsel.
      Contract: {{ steps.clauses.title | default:'contract' }} with {{ input.counterparty || steps.clauses.parties | json }}; type {{ input.contract_type || steps.type.category }}; our role {{ input.our_role | default:'not stated' }}.
      Business context: {{ input.business_context | default:'not provided' }}
      Clauses: {{ steps.clauses | json }}
      Assessment: {{ steps.risk | json }}
      Playbook: {{ steps.playbook.context }}
      Structure: (1) summary with overall risk (low/medium/high) and whether it can be signed as is;
      (2) table: clause, contract position (with clause number), playbook position, risk (green/amber/red);
      (3) proposed redlines and fallback positions for every amber and red clause, as concrete wording;
      (4) questions for the business; (5) escalation needed (General Counsel) yes/no and why.
      Do not give an opinion on clauses you could not find; list them as missing.
    fallback: |-
      ## Contract review: {{ steps.clauses.title | default:'contract' }}
      Type: {{ input.contract_type || steps.type.category }}; counterparty: {{ input.counterparty | default:'-' }}; our role: {{ input.our_role | default:'-' }}
      Playbook conformity: {{ steps.risk.score }}/100 ({{ steps.risk.verdict }})

      Key terms:
      - Term: {{ steps.clauses.term | default:'not found' }}
      - Renewal: {{ steps.clauses.renewal | default:'not found' }}
      - Termination: {{ steps.clauses.termination | default:'not found' }}
      - Liability: {{ steps.clauses.liability | default:'not found' }}
      - Governing law: {{ steps.clauses.governing_law | default:'not found' }}
      - Disputes: {{ steps.clauses.dispute_resolution | default:'not found' }}

      Deviations to review:
      {{ steps.risk.gaps | bullets }}
  - id: review
    name: Legal counsel review
    type: approval
    title: "Contract review: {{ steps.clauses.title | default:'contract' }} ({{ input.counterparty | default:'counterparty not stated' }}), risk {{ (steps.risk.verdict == 'pass' && 'low') || (steps.risk.verdict == 'review' && 'medium') || 'high' }}"
    details: "{{ steps.memo.text }}"
    assigneeRole: legal-counsel
  - id: result
    type: output
    value:
      contract_type: "{{ input.contract_type || steps.type.category }}"
      key_terms: "{{ steps.clauses }}"
      risk_score: "{{ steps.risk.score }}"
      risk_level: "{{ (steps.risk.verdict == 'pass' && 'low') || (steps.risk.verdict == 'review' && 'medium') || 'high' }}"
      deviations: "{{ steps.risk.gaps }}"
      assessment: "{{ steps.risk.criteria }}"
      memo: "{{ steps.memo.text }}"
      reviewed: "{{ steps.review.approved || false }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: contains
  retentionDays: 3650
  notes:
    - Contracts are confidential; reviews are visible only to the requester and the legal team.
    - The memo supports counsel's review and is not legal advice to the business until counsel approves it.
    - Contracts containing personal data are processed under the legal team's KVKK records of processing.
ui:
  layout: form-results
  title: Contract review
  description: Upload a contract and tell us your role and the business context.
  submitLabel: Review contract
  resultView: cards
  highlight: [risk_level, risk_score, deviations, contract_type]
kpis:
  - {id: turnaround, name: Review turnaround, target: "< 3 business days"}
  - {id: counsel-time, name: Counsel time per standard contract, target: "< 45 min"}
  - {id: extraction-accuracy, name: Clauses correctly extracted, target: "> 95%"}
builder:
  matchPhrases:
    - contract review
    - review contracts
    - contract risk
    - clause extraction
    - contract analysis
    - legal review
    - redline
    - contract playbook
    - sözleşme inceleme
    - sözleşme analizi
    - sözleşme risk analizi
    - madde analizi
    - hukuki inceleme
    - sözleşme değerlendirme
  questions:
    - id: contract.types
      section: purpose
      title: Contract types in scope
      question: Which types of contracts should the agent review?
      why: Each contract type has its own risk profile and playbook; starting with the most frequent types gives the fastest benefit.
      answerType: multi
      options:
        - {value: nda, label: NDAs}
        - {value: customer, label: Customer and sales agreements}
        - {value: supply, label: Supply and purchase agreements}
        - {value: services, label: Services and SaaS agreements}
        - {value: distribution, label: Distribution and agency agreements}
        - {value: dpa, label: Data processing agreements}
        - {value: lease, label: Leases}
      recommended: [supply, customer, services]
      owner: legal
      priority: 10
    - id: contract.playbook
      section: inputs
      title: Contract playbook
      question: Please upload your contract playbook or standard templates, with the standard position, acceptable fallbacks and red lines for each key clause.
      why: Without a playbook the agent can only flag generic market risks; with it, every deviation is measured against your own positions and the memo proposes your own fallback wording.
      kind: fact
      answerType: files
      owner: legal
      delegable: true
      specPath: knowledge.collections
      priority: 10
    - id: contract.red_lines
      replaces: [docs.criteria]
      section: processing
      title: Red lines
      question: Which positions are non-negotiable, so that a contract containing them is always escalated?
      why: Red lines become knockout checks; they decide when the General Counsel must be involved.
      answerType: criteria
      recommended:
        - Unlimited liability for us (knockout)
        - Exclusive foreign jurisdiction without arbitration (knockout)
        - Unilateral price increases by the counterparty (knockout)
        - Exclusivity or non-compete binding the whole group (knockout)
        - Automatic renewal longer than 12 months without an exit (must)
        - Uncapped indemnities beyond IP infringement and third-party claims (must)
      prerequisites: [contract.playbook]
      owner: legal
      specPath: workflow.risk.criteria
      priority: 20
    - id: contract.escalation
      section: governance
      title: Escalation to the General Counsel
      question: Which contracts must be approved by the General Counsel in addition to legal counsel?
      why: Clear escalation thresholds keep standard contracts fast and make sure high-risk ones get senior attention.
      answerType: text
      recommended: "Contract value above 5,000,000 TRY or 3 years, any red-line deviation, exclusivity or non-compete, and governing law outside Türkiye without arbitration."
      owner: legal
      delegable: true
      priority: 30
    - id: contract.output
      section: outputs
      title: Review output
      question: What should counsel receive from the agent?
      why: The format decides how much of the review counsel can reuse directly in negotiations.
      answerType: single
      options:
        - {value: memo, label: "Risk memo with a clause table and proposed redline wording"}
        - {value: clause-register, label: Clause register (one row per clause) for the contract database}
        - {value: both, label: Both}
      recommended: memo
      owner: requester
      priority: 40
    - id: contract.access
      replaces: [governance.access]
      section: governance
      title: Confidentiality of reviews
      question: Who may submit contracts for review and who may see the review memos?
      why: Contracts contain confidential commercial terms and sometimes personal data; access must be need-to-know.
      answerType: text
      recommended: "Any manager may submit; the memo is visible to the requester and the legal team only, and to the General Counsel for escalations."
      owner: legal
      priority: 30
---
You are the **Contract Reviewer**, working for the legal team. You give legal counsel a precise, playbook-based first review of every contract, so counsel can focus on judgement and negotiation instead of reading boilerplate.

## Objectives
- Extract the key terms of the contract with their clause numbers: parties, term, renewal, termination, liability, indemnities, warranties, payment, penalties, confidentiality, data protection, IP, exclusivity, assignment, force majeure, governing law and disputes.
- Assess every clause against the company's playbook for our role: standard position, acceptable fallback, red line.
- Write a risk memo with a clause table, concrete redline proposals and the questions for the business.

## Method
1. Read the contract (OCR for scans) and recognise its type unless given.
2. Extract the clauses; quote amounts, periods and percentages exactly and cite clause numbers.
3. Retrieve the playbook positions for the contract type and our role.
4. Evaluate each clause; any red line means high risk and escalation to the General Counsel.
5. Write the memo and hand it to legal counsel for review.

## Rules
- Never invent clauses or content. A missing clause is reported as missing, which can itself be a risk (e.g. no limitation of liability).
- Distinguish clearly between what the contract says (with clause number), what the playbook requires and your assessment.
- Proposed redlines must be concrete wording, preferably the playbook's fallback language.
- Turkish-law points to watch: penalty clauses (cezai şart) and their proportionality, TTK notice periods, KVKK requirements for transfers of personal data abroad, and the language of the binding version.
- The memo is internal and confidential; it becomes advice only after counsel approves it.

## Output
Contract type, key terms, playbook conformity score and risk level, deviations, the clause assessment and the risk memo with redlines.

## Tone
Precise, structured and neutral, in the style of a careful senior associate writing for a partner.
