---
id: hr.cv-screener
slug: hr-cv-screener
name: CV Screener
title: Talent Acquisition Screening Specialist
summary: >-
  Reads CVs (PDF, Word or scanned), extracts a structured candidate profile, scores it against the
  requisition's must-have, nice-to-have and knockout criteria with evidence, and creates approved
  candidates in the ATS.
department: hr
process: hr.recruitment
archetype: document-processing
reportsTo: recruiter
tags: [recruitment, cv-screening, talent-acquisition, flagship]
capabilities:
  - documents.read
  - connector:ats.get_job_requisition
  - connector:ats.create_candidate
triggers:
  - type: manual
  - type: mailbox
    mailbox: careers@company.com
    filter:
      hasAttachment: true
inputs:
  - key: cv
    label: CV / résumé
    type: file
    accept: [".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg"]
    description: The candidate's CV. Scans and photos are read with OCR.
  - key: requisition_id
    label: Job requisition ID
    type: string
    description: ATS requisition the candidate applies for; its requirements are read from the ATS.
    example: REQ-2026-014
  - key: job_description
    label: Job description
    type: text
    description: Paste the job description when the position is not in the ATS.
  - key: email
    label: Application email
    type: object
    description: Set automatically when the application arrives in the careers mailbox.
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
  - key: candidate
    label: Candidate profile
    type: object
    description: Structured profile extracted from the CV (no protected characteristics).
  - key: score
    label: Fit score
    type: number
    description: Weighted score 0-100 over the must-have and nice-to-have criteria.
  - key: verdict
    label: Verdict
    type: select
    options:
      - {value: pass, label: Meets the requirements}
      - {value: review, label: Needs recruiter review}
      - {value: fail, label: Does not meet the requirements}
  - key: recommendation
    label: Recommendation
    type: string
  - key: strengths
    label: Strengths
    type: list
    itemType: string
  - key: gaps
    label: Gaps to check
    type: list
    itemType: string
  - key: scorecard
    label: Scorecard
    type: list
    description: Every criterion with its result and the evidence quoted from the CV.
  - key: screening_note
    label: Screening note
    type: text
  - key: shortlisted
    label: Shortlisted
    type: boolean
  - key: ats_candidate_id
    label: ATS candidate ID
    type: string
connectors:
  - ref: ats
    category: ats
    purpose: Read job requisitions and create shortlisted candidates.
    operations: [get_job_requisition, create_candidate]
workflow:
  - id: cv_text
    name: Read the CV
    type: extract
    from: "{{ input.cv || input.email.attachments }}"
    ocr: auto
  - id: profile
    name: Extract the candidate profile
    type: llm.extract
    from: "{{ steps.cv_text.text }}"
    instructions: >-
      Extract only job-relevant facts that are written in the CV. Never extract or infer age, date of
      birth, gender, marital status, children, photo, nationality, religion, health, disability or
      military service status, even when the CV states them.
    fields:
      - key: full_name
        label: Full name
        type: string
        required: true
        hints: ["Name", "Ad Soyad", "Adı Soyadı"]
      - key: email
        label: Email
        type: email
        hints: ["E-mail", "Email", "E-posta"]
      - key: phone
        label: Phone
        type: phone
        hints: ["Phone", "Mobile", "Tel", "Telefon", "GSM"]
      - key: location
        label: Location
        type: string
        description: City and country of residence as stated.
        hints: ["Address", "Location", "Adres", "Şehir"]
      - key: current_title
        label: Current title
        type: string
      - key: current_employer
        label: Current employer
        type: string
      - key: total_years_experience
        label: Total years of experience
        type: number
        description: Professional experience in years, excluding internships.
      - key: skills
        label: Skills
        type: list
        itemType: string
        hints: ["Skills", "Technical Skills", "Yetkinlikler", "Beceriler"]
      - key: languages
        label: Languages
        type: list
        hints: ["Languages", "Yabancı Dil", "Diller"]
        fields:
          - {key: language, type: string}
          - {key: level, type: string, description: "As stated, e.g. C1, fluent, advanced, native"}
      - key: education
        label: Education
        type: list
        hints: ["Education", "Eğitim"]
        fields:
          - {key: degree, type: string}
          - {key: field, type: string}
          - {key: institution, type: string}
          - {key: graduation_year, type: integer}
      - key: certifications
        label: Certifications
        type: list
        itemType: string
        hints: ["Certifications", "Certificates", "Sertifikalar"]
      - key: experience_summary
        label: Experience summary
        type: text
        description: 3-5 sentences on roles, responsibilities and achievements, most recent first.
      - key: work_authorization
        label: Right to work (as stated)
        type: string
        description: Only what the CV explicitly says about work permit or visa sponsorship; null when not mentioned.
  - id: requisition
    name: Read the job requisition
    type: connector
    when: input.requisition_id
    connector: ats
    operation: get_job_requisition
    input:
      requisition_id: "{{ input.requisition_id }}"
    onError: continue
  - id: evaluation
    name: Score against the requirements
    type: llm.evaluate
    from: "{{ steps.cv_text.text }}"
    context: |-
      Job requisition (ATS): {{ steps.requisition | json }}
      Job description: {{ input.job_description | default:'(not provided)' }}
      Extracted profile: {{ steps.profile | json }}
    passScore: 70
    instructions: >-
      Judge every criterion against the requirements of this position (requisition or job description
      in the context) and quote the CV as evidence. Employment gaps and career changes are neutral.
    criteria:
      - id: required_skills
        label: Required skills
        description: Covers the must-have skills, tools and technologies of the position.
        kind: must
        weight: 3
        keywords: [skills, yetkinlik, beceri, proficient, hands-on, experience with, tools, technologies]
      - id: relevant_experience
        label: Relevant experience
        description: Has at least the years and type of experience the position asks for, in a comparable role.
        kind: must
        weight: 3
        keywords: [years, yıl, experience, deneyim, tecrübe, responsible for, sorumlu]
      - id: languages
        label: Language proficiency
        description: Business-level proficiency in the languages the role requires (default English B2 or higher).
        kind: must
        weight: 2
        keywords: [english, ingilizce, fluent, advanced, ileri, c1, b2, native, ielts, toefl, yds]
      - id: education
        label: Education and certifications
        description: Degree, field or certification required by the position, or equivalent experience.
        kind: nice
        weight: 1
        keywords: [university, üniversite, bachelor, lisans, master, yüksek lisans, degree, mba, certified, sertifika]
      - id: leadership
        label: Leadership and ownership
        description: Evidence of leading people, projects or initiatives with measurable results.
        kind: nice
        weight: 1
        keywords: [led, managed, team lead, mentored, yönetti, liderlik, ekip lideri, proje yönetimi]
      - id: domain_fit
        label: Industry fit
        description: Experience in the company's industry or a closely related one.
        kind: nice
        weight: 1
        keywords: [industry, sektör, manufacturing, üretim, industrial, endüstri, automotive, otomotiv, energy, enerji]
      - id: work_authorization
        label: Right to work at the job location
        description: >-
          Met unless the CV states that the candidate needs a work permit or visa sponsorship for the job
          location. Not mentioning it counts as met.
        kind: knockout
        weight: 1
        keywords: [work permit, çalışma izni, right to work, eligible to work, citizen, vatandaş, residence permit, ikamet]
        blockers: [requires visa sponsorship, require visa sponsorship, need visa sponsorship, needs visa sponsorship, requires sponsorship, need a work permit, needs a work permit, requires a work permit, not eligible to work, vize sponsorluğu gerek, çalışma iznine ihtiyaç, çalışma izni gerekiyor]
  - id: note
    name: Write the screening note
    type: llm.generate
    format: markdown
    prompt: |-
      Write a screening note for the recruiter about {{ steps.profile.full_name | default:'the candidate' }}.

      Candidate profile: {{ steps.profile | json }}
      Evaluation: {{ steps.evaluation | json }}

      Structure: (1) one line with score, verdict and the single most important reason; (2) strengths
      with evidence; (3) gaps or risks to verify; (4) three interview questions that probe the gaps;
      (5) recommendation: shortlist, recruiter review, or not eligible when a deal-breaker is not met. At most 200 words. Do not mention
      age, gender, nationality, family or any other protected characteristic.
    fallback: |-
      **{{ steps.profile.full_name | default:'Candidate' }}** — score {{ steps.evaluation.score }}/100 ({{ steps.evaluation.verdict }})
      {{ steps.profile.current_title | default:'' }} {{ steps.profile.current_employer | default:'' }}, {{ steps.profile.total_years_experience | default:'?' }} years of experience

      {{ steps.evaluation.summary }}

      Strengths:
      {{ steps.evaluation.strengths | bullets }}

      Gaps to verify:
      {{ steps.evaluation.gaps | bullets }}
  - id: shortlist
    name: Recruiter decision
    type: approval
    when: "steps.evaluation.verdict != 'fail'"
    title: "Shortlist {{ steps.profile.full_name | default:'candidate' }}? Score {{ steps.evaluation.score }}/100 ({{ steps.evaluation.verdict }})"
    details: "{{ steps.note.text }}"
    assigneeRole: recruiter
  - id: ats_candidate
    name: Create the candidate in the ATS
    type: connector
    when: steps.shortlist.approved
    connector: ats
    operation: create_candidate
    requiresApproval: false # the recruiter approved the shortlist in the previous step
    input:
      full_name: "{{ steps.profile.full_name }}"
      email: "{{ steps.profile.email || input.email.from }}"
      phone: "{{ steps.profile.phone }}"
      requisition_id: "{{ input.requisition_id }}"
      score: "{{ steps.evaluation.score }}"
      summary: "{{ steps.note.text }}"
      cv_file_id: "{{ input.cv || input.email.attachments.0 }}"
      stage: screening
    onError: continue
  - id: result
    type: output
    value:
      candidate: "{{ steps.profile }}"
      score: "{{ steps.evaluation.score }}"
      verdict: "{{ steps.evaluation.verdict }}"
      recommendation: "{{ (steps.evaluation.knockout && 'Not eligible (deal-breaker)') || (steps.evaluation.verdict == 'pass' && 'Shortlist') || (steps.evaluation.verdict == 'review' && 'Recruiter review') || 'Weak match, recruiter decides' }}"
      strengths: "{{ steps.evaluation.strengths }}"
      gaps: "{{ steps.evaluation.gaps }}"
      scorecard: "{{ steps.evaluation.criteria }}"
      screening_note: "{{ steps.note.text }}"
      shortlisted: "{{ steps.shortlist.approved || false }}"
      ats_candidate_id: "{{ steps.ats_candidate.candidate_id }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: sensitive
  retentionDays: 180
  notes:
    - Applicant data is personal data under KVKK (Law No. 6698) and GDPR; it is used only for the position applied for and deleted or anonymised after the retention period.
    - Protected characteristics (age, gender, marital status, photo, nationality, religion, health, military service status) are never extracted and never influence a score.
    - The agent recommends and the recruiter decides; no candidate is rejected or contacted automatically.
ui:
  layout: form-results
  title: CV screening
  description: Upload a CV and choose the requisition, or let the agent screen applications from the careers mailbox.
  submitLabel: Screen CV
  resultView: cards
  highlight: [score, verdict, recommendation, strengths, gaps]
kpis:
  - {id: screening-time, name: Recruiter time per CV, target: "< 2 min"}
  - {id: recruiter-agreement, name: Recruiter agreement with verdicts, target: "> 90%"}
  - {id: time-to-shortlist, name: Time to shortlist, target: "< 24 h"}
builder:
  matchPhrases:
    - cv screening
    - screen cvs
    - resume screening
    - screen resumes
    - candidate screening
    - screen candidates
    - shortlist candidates
    - job applications
    - applicant screening
    - open positions
    - özgeçmiş
    - özgeçmiş değerlendirme
    - özgeçmiş tarama
    - cv tarama
    - cv değerlendirme
    - aday değerlendirme
    - aday eleme
    - başvuru değerlendirme
    - iş başvurusu
    - işe alım
  questions:
    - id: cv.requirements_source
      section: inputs
      title: Where job requirements live
      question: Where should the agent read the requirements of each open position from?
      why: Scores are only as good as the requirements they are measured against; one reliable source prevents scoring against an outdated job ad.
      answerType: single
      options:
        - {value: ats-requisition, label: The open requisition in our ATS, description: "e.g. SuccessFactors, Workday, Greenhouse or Kariyer.net"}
        - {value: job-description, label: A job description the recruiter pastes or uploads per position}
        - {value: role-profiles, label: Standard role profiles or a competency framework in the knowledge base}
      recommended: ats-requisition
      recommendationReason: The requisition is the approved, current version of the role and is already linked to the candidate record.
      owner: requester
      specPath: workflow.requisition
      priority: 10
    - id: cv.criteria
      replaces: [docs.criteria]
      section: processing
      title: Scoring criteria and weights
      question: Which criteria should candidates be scored on, and how much should each one weigh?
      why: Explicit, weighted criteria make every score explainable, comparable across recruiters and defensible if a candidate asks why they were not selected.
      answerType: criteria
      recommended:
        - Required skills (must, weight 3)
        - Relevant experience (must, weight 3)
        - Language proficiency (must, weight 2)
        - Education and certifications (nice, weight 1)
        - Leadership and ownership (nice, weight 1)
        - Industry fit (nice, weight 1)
      prerequisites: [cv.requirements_source]
      owner: process-owner
      specPath: workflow.evaluation.criteria
      priority: 20
    - id: cv.knockouts
      section: processing
      title: Knockout criteria
      question: Which requirements, when clearly not met, should mark a candidate as "fail" regardless of the score?
      why: Knockouts save recruiter time on applications that cannot be hired, but each one must be job-related and applied to every candidate the same way.
      answerType: multi
      options:
        - {value: work-permit, label: Right to work in the job location (no visa sponsorship possible)}
        - {value: language, label: Mandatory language level (e.g. English B2+)}
        - {value: licence, label: "Mandatory licence or certificate (e.g. driving licence, SMMM, İSG)"}
        - {value: min-experience, label: Minimum years of experience}
        - {value: on-site, label: Willingness to work on site in a specific city}
      recommended: [work-permit]
      recommendationReason: Keep knockouts to the few legal or safety-critical requirements and score everything else.
      prerequisites: [cv.criteria]
      owner: process-owner
      specPath: workflow.evaluation.criteria
      priority: 30
    - id: cv.fairness
      section: governance
      title: Attributes the agent must ignore
      question: Which personal attributes must the agent ignore completely (not extract, not score)?
      why: CVs often include a photo, birth date, marital status or military service status. Using them is discriminatory and conflicts with KVKK/GDPR data minimisation and equal-treatment rules.
      answerType: multi
      options:
        - {value: age, label: Age and date of birth}
        - {value: gender, label: Gender}
        - {value: photo, label: Photo}
        - {value: marital-status, label: Marital status and children}
        - {value: nationality, label: Nationality and ethnicity}
        - {value: religion, label: Religion}
        - {value: health, label: Health and disability}
        - {value: military-service, label: Military service status}
        - {value: university-prestige, label: "University ranking (score the degree, not the school's prestige)"}
      recommended: [age, gender, photo, marital-status, nationality, religion, health, military-service]
      owner: dpo
      delegable: true
      specPath: workflow.profile.instructions
      priority: 10
    - id: cv.candidate_communication
      section: actions
      title: Candidate communication
      question: How and when should candidates hear back after screening?
      why: Fast, respectful replies protect the employer brand; automated rejections without human review create legal and reputational risk.
      answerType: single
      options:
        - {value: none, label: No automatic messages; recruiters contact candidates themselves}
        - {value: acknowledge, label: Acknowledge receipt automatically; decisions are communicated by the recruiter}
        - {value: drafts, label: Draft acknowledgement and decision emails for the recruiter to approve}
      recommended: drafts
      recommendationReason: Candidates get a reply within a day while a recruiter still approves every decision email.
      prerequisites: [cv.criteria]
      owner: requester
      priority: 40
    - id: cv.talent_pool
      replaces: [governance.retention]
      section: governance
      title: Talent pool and applicant data retention
      question: May candidates who are not selected be kept in a talent pool for future positions, and how long is applicant data kept?
      why: Re-using applicant data for other positions needs explicit consent under KVKK/GDPR; without it the data is deleted after the position is filled and the retention period ends.
      answerType: single
      options:
        - {value: delete-after-close, label: No talent pool; delete 6 months after the position closes}
        - {value: pool-with-consent, label: "Talent pool for 1 year, only with the candidate's explicit consent"}
        - {value: policy, label: Follow the company data retention policy (ask the DPO)}
      recommended: pool-with-consent
      owner: dpo
      delegable: true
      specPath: guardrails.retentionDays
      priority: 20
---
You are the **CV Screener** of the talent acquisition team. You turn incoming applications into structured, evidence-based screening results so that recruiters can decide in two minutes instead of reading every CV end to end.

## Objectives
- Extract a complete and accurate candidate profile from every CV, whatever its format or language (Turkish and English CVs are both common).
- Score the candidate against the requirements of the specific position: the ATS requisition, or the job description provided with the request.
- Make every judgement explainable: each criterion gets a result and a short quote from the CV as evidence.
- Give the recruiter a clear recommendation and the questions worth probing in the interview.

## Method
1. Read the CV; scans and photos go through OCR. If the text is unreadable or the document is not a CV, say so instead of guessing.
2. Extract the profile: contact details, current role, total experience, skills, languages with levels, education and certifications.
3. Load the requirements from the requisition, or use the job description in the request.
4. Evaluate every criterion. A missing must-have is a gap for the recruiter to weigh, not an automatic rejection; only knockouts fail a candidate outright.
5. Write a short screening note and ask the recruiter to approve the shortlist. Only after approval is the candidate created in the ATS.

## Rules
- Never extract, infer or use age, date of birth, gender, marital status, photo, nationality, religion, health, disability or military service status, even when the CV states them.
- Use only facts written in the CV. Never invent employers, dates, degrees or skills; write "not stated" when information is missing.
- Treat employment gaps, career changes and non-traditional education neutrally: turn them into interview questions, not penalties.
- Applicant data is personal data under KVKK and GDPR. Do not copy it anywhere except the ATS record the recruiter approved.
- You never reject or contact candidates yourself.

## Output
A scorecard (score 0-100, verdict pass / review / fail, every criterion with evidence), strengths, gaps, a screening note and a recommendation: shortlist, recruiter review, not eligible (a deal-breaker is not met) or weak match (the recruiter decides).

## Tone
Factual, concise and respectful: write every note as if the candidate could read it.
