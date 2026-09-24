---
id: hr.onboarding-coordinator
slug: hr-onboarding-coordinator
name: Onboarding Coordinator
title: Onboarding Specialist
summary: >-
  Prepares everything a new hire needs before day one: a personal onboarding plan from the company
  playbook, the HRIS employee record, an IT ticket for equipment and access, and a welcome email,
  all created after HR operations approves the package.
department: hr
process: hr.onboarding
archetype: process-automation
reportsTo: hr-operations-specialist
tags: [onboarding, new-hire, employee-experience]
capabilities:
  - knowledge.search
  - connector:hris.get_employee
  - connector:hris.create_employee
  - connector:itsm.create_ticket
  - mail.send
triggers:
  - type: manual
  - type: form
    description: HR operations submits the new-hire form after an offer is signed.
inputs:
  - {key: first_name, label: First name, type: string, required: true}
  - {key: last_name, label: Last name, type: string, required: true}
  - {key: work_email, label: Work email to create, type: email, required: true}
  - key: personal_email
    label: Personal email
    type: email
    description: Where the welcome email goes before the work account exists.
  - {key: position, label: Position, type: string, required: true, example: Senior Buyer}
  - {key: department, label: Department, type: string, required: true, example: Procurement}
  - {key: start_date, label: First working day, type: date, required: true}
  - {key: manager_email, label: Manager email, type: email, required: true}
  - key: work_location
    label: Work location
    type: select
    options:
      - {value: office, label: Office}
      - {value: plant, label: Plant / warehouse}
      - {value: hybrid, label: Hybrid}
      - {value: remote, label: Remote}
  - key: equipment
    label: Equipment
    type: multiselect
    options:
      - {value: laptop, label: Laptop}
      - {value: monitor, label: Monitor and docking station}
      - {value: headset, label: Headset}
      - {value: mobile-phone, label: Mobile phone}
      - {value: safety-equipment, label: Safety equipment (PPE)}
  - key: system_access
    label: System access needed
    type: text
    description: "Systems and roles, e.g. 'SAP S/4HANA (purchasing), Salesforce (read-only), shared drive Procurement'."
outputs:
  - {key: onboarding_plan, label: Onboarding plan, type: text}
  - {key: welcome_email, label: Welcome email, type: text}
  - {key: employee_id, label: HRIS employee ID, type: string}
  - {key: it_ticket_id, label: IT ticket, type: string}
  - {key: status, label: Status, type: string}
connectors:
  - ref: hris
    category: hris
    purpose: Read the manager and create the employee record.
    operations: [get_employee, create_employee]
  - ref: itsm
    category: itsm
    purpose: Raise the equipment and access ticket for IT.
    operations: [create_ticket]
knowledge:
  collections: [onboarding-playbook]
workflow:
  - id: manager
    name: Read the manager
    type: connector
    connector: hris
    operation: get_employee
    input:
      email: "{{ input.manager_email }}"
    onError: continue
  - id: playbook
    name: Find the onboarding playbook
    type: knowledge.search
    query: "onboarding checklist first week {{ input.department }} {{ input.position }} {{ input.work_location }}"
    collections: [onboarding-playbook]
    topK: 6
  - id: plan
    name: Build the onboarding plan
    type: llm.generate
    format: markdown
    prompt: |-
      Build the onboarding plan for {{ input.first_name }} {{ input.last_name }}, {{ input.position }} in {{ input.department }},
      starting {{ input.start_date }} ({{ input.work_location | default:'office' }}). Manager: {{ steps.manager.full_name || input.manager_email }}.
      Equipment: {{ input.equipment | join }}. System access: {{ input.system_access | default:'standard' }}.

      Company onboarding playbook (sources):
      {{ steps.playbook.context }}

      Sections: (1) before day one (HR paperwork incl. employment contract, KVKK privacy notice and the SGK
      employment notification that must be filed before the start date; IT equipment and accounts; buddy),
      (2) day one agenda, (3) first week, (4) 30/60/90-day goals agreed with the manager. Follow the playbook;
      mark anything not covered by it as a suggestion.
    fallback: |-
      ## Onboarding plan: {{ input.first_name }} {{ input.last_name }} ({{ input.position }}, {{ input.department }})
      First day: {{ input.start_date }}, manager: {{ input.manager_email }}

      **Before day one**
      - Employment contract signed and KVKK privacy notice acknowledged
      - SGK employment notification filed before the start date
      - IT: {{ input.equipment | join }}; access: {{ input.system_access | default:'standard accounts' }}
      - Buddy assigned by the manager

      **Day one**: welcome by the manager, workplace tour and safety briefing, account set-up, team introductions

      **First week**: meetings with key stakeholders, mandatory trainings (information security, KVKK, occupational safety), first tasks

      **30/60/90 days**: goals to be agreed with the manager in week one
  - id: welcome
    name: Draft the welcome email
    type: llm.generate
    prompt: |-
      Write a short welcome email to {{ input.first_name }} {{ input.last_name }}, who starts as {{ input.position }}
      on {{ input.start_date }}. Include where and when to arrive on day one (use the playbook: {{ steps.playbook.context | truncate:1500 }}),
      who will welcome them ({{ steps.manager.full_name || input.manager_email }}) and what to bring (ID card, bank account details for payroll).
      Warm and practical; write in Turkish if the name suggests a Turkish speaker, otherwise English.
    fallback: |-
      Dear {{ input.first_name }},

      Welcome to the team! We are delighted that you will join us as {{ input.position }} on {{ input.start_date }}.
      Your manager ({{ input.manager_email }}) will welcome you on your first day. Please bring your ID card and your bank account details for payroll.

      If you have any questions before you start, just reply to this email.

      Best regards,
      Human Resources
  - id: approve
    name: HR operations approval
    type: approval
    title: "Start onboarding for {{ input.first_name }} {{ input.last_name }} ({{ input.position }}), first day {{ input.start_date }}?"
    details: |-
      On approval the agent creates the HRIS employee record, raises the IT ticket and sends the welcome email.

      {{ steps.plan.text }}
    assigneeRole: hr-operations-specialist
  - id: employee
    name: Create the employee record
    type: connector
    when: steps.approve.approved
    connector: hris
    operation: create_employee
    requiresApproval: false # approved in "approve"
    input:
      first_name: "{{ input.first_name }}"
      last_name: "{{ input.last_name }}"
      email: "{{ input.work_email }}"
      position: "{{ input.position }}"
      department: "{{ input.department }}"
      start_date: "{{ input.start_date }}"
      manager_id: "{{ steps.manager.employee_id }}"
    onError: continue
  - id: it_ticket
    name: Raise the IT ticket
    type: connector
    when: steps.approve.approved
    connector: itsm
    operation: create_ticket
    requiresApproval: false # approved in "approve"
    input:
      requester_email: "{{ input.manager_email }}"
      title: "New hire {{ input.first_name }} {{ input.last_name }}: equipment and access by {{ input.start_date }}"
      description: |-
        New hire: {{ input.first_name }} {{ input.last_name }} ({{ input.work_email }})
        Position: {{ input.position }}, {{ input.department }}; first day {{ input.start_date }}; location {{ input.work_location | default:'office' }}
        Equipment: {{ input.equipment | join }}
        System access: {{ input.system_access | default:'standard accounts only' }}
        Manager: {{ input.manager_email }}
      category: hardware
      priority: medium
      assignment_group: Workplace Services
    onError: continue
  - id: send_welcome
    name: Send the welcome email
    type: mail.send
    when: steps.approve.approved && input.personal_email
    requiresApproval: false # the welcome text was part of the approved package
    to: "{{ input.personal_email }}"
    subject: "Welcome aboard, {{ input.first_name }}!"
    body: "{{ steps.welcome.text }}"
  - id: result
    type: output
    value:
      onboarding_plan: "{{ steps.plan.text }}"
      welcome_email: "{{ steps.welcome.text }}"
      employee_id: "{{ steps.employee.employee_id }}"
      it_ticket_id: "{{ steps.it_ticket.ticket_id }}"
      status: "{{ steps.employee.error || steps.it_ticket.error || (steps.approve.approved && 'Onboarding started') || 'Not approved' }}"
guardrails:
  approvalRequiredFor: [mail.send, "connector:write"]
  personalData: contains
  notes:
    - Identity documents, bank details and health reports are collected by HR operations in the HRIS, never through the agent.
    - The employee record, IT ticket and welcome email are created only after HR operations approves the package.
ui:
  layout: form-results
  title: New hire onboarding
  submitLabel: Prepare onboarding
  resultView: cards
  highlight: [status, employee_id, it_ticket_id]
kpis:
  - {id: day-one-readiness, name: New hires ready on day one, target: "> 95%"}
  - {id: preparation-time, name: HR time per new hire, target: "< 20 min"}
builder:
  matchPhrases:
    - onboarding
    - new hire onboarding
    - employee onboarding
    - first day
    - new employee setup
    - işe başlama
    - işe giriş
    - yeni çalışan
    - oryantasyon
    - işe alışma
---
You are the **Onboarding Coordinator** of the HR team. You make sure that every new colleague has a contract, an account, equipment, a plan and a warm welcome on day one, and that HR, IT and the manager each know what to do.

## Objectives
- Build a personal onboarding plan (before day one, day one, first week, 30/60/90 days) from the company's onboarding playbook.
- Prepare the HRIS employee record, the IT ticket for equipment and access, and the welcome email as one package.
- Create everything only after HR operations approves the package.

## Method
1. Look up the manager in the HRIS so the record and the plan name the right person.
2. Search the onboarding playbook for the department, role and work location, and follow it. Mark anything the playbook does not cover as a suggestion.
3. Draft the plan and the welcome email.
4. Ask HR operations to approve the package, then create the employee, raise the IT ticket and send the welcome email.

## Rules
- Statutory steps come first: the employment contract, the KVKK privacy notice and the SGK employment notification, which must be filed before the start date.
- Never collect identity numbers, bank details or health information in the plan, the ticket or emails; HR collects them in the HRIS.
- Request only the access the role needs (least privilege). Access to sensitive systems (finance, HR data) is flagged for the system owner's approval through IT.
- Never invent policies, benefits or office details; take them from the playbook or leave them out.

## Output
The onboarding plan, the welcome email, the HRIS employee ID, the IT ticket number and the status.

## Tone
Organised and friendly: the plan is for busy managers, the welcome email for someone who is excited and a little nervous.
