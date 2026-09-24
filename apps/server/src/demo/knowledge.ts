/** Demo knowledge base content for "Acme Endüstri A.Ş.", a mid-size manufacturer. */
export interface DemoDoc {
  topic: "hr" | "finance" | "it" | "customer-service" | "procurement" | "legal" | "general";
  title: string;
  text: string;
}

export const DEMO_KNOWLEDGE: DemoDoc[] = [
  {
    topic: "hr",
    title: "Annual Leave Policy",
    text: `# Annual Leave Policy

Applies to all employees of Acme Endüstri A.Ş. in Turkey. Effective 1 January 2026.

## Entitlement
- Employees with 1 to 5 years of service: 14 working days of paid annual leave per year.
- Employees with more than 5 and fewer than 15 years of service: 20 working days.
- Employees with 15 years of service or more: 26 working days.
- Employees aged 18 or younger, or 50 or older, receive at least 20 working days regardless of seniority.
- New joiners become eligible after completing 12 months of service (probation included).

## Requesting leave
1. Request leave in the HR system at least 10 working days in advance (3 days for leave of 2 days or less).
2. Your line manager approves or rejects the request within 3 working days.
3. Leave of more than 10 consecutive working days also needs the department head's approval.

## Carry-over
Up to 5 unused days may be carried over to the next year and must be used by 31 March. Remaining days are not paid out except on termination.

## Other leave
- Marriage leave: 3 days. Paternity leave: 5 days. Bereavement (first-degree relatives): 3 days.
- Sick leave requires a medical report for absences longer than 2 days.

Questions: hr@acme.com.tr`,
  },
  {
    topic: "hr",
    title: "Yıllık İzin Politikası (özet)",
    text: `# Yıllık İzin Politikası

Acme Endüstri A.Ş. çalışanları için geçerlidir.

## İzin hakkı
- 1 yıldan 5 yıla kadar (5 yıl dahil) kıdemi olan çalışanlar: yılda 14 iş günü ücretli yıllık izin.
- 5 yıldan fazla, 15 yıldan az kıdemi olanlar: 20 iş günü.
- 15 yıl ve daha fazla kıdemi olanlar: 26 iş günü.
- 18 yaş ve altı ile 50 yaş ve üzeri çalışanlara en az 20 iş günü izin verilir.

## İzin talebi
İzin talepleri İK sisteminden en az 10 iş günü önce girilir; yönetici 3 iş günü içinde onaylar. 10 iş gününden uzun izinler için bölüm başkanı onayı da gerekir.

## Devreden izin
Kullanılmayan en fazla 5 gün bir sonraki yıla devreder ve 31 Mart'a kadar kullanılmalıdır.`,
  },
  {
    topic: "hr",
    title: "Recruitment & Candidate Privacy Policy",
    text: `# Recruitment & Candidate Privacy Policy

## Fair screening
- Candidates are assessed only on job-related criteria: skills, experience, qualifications and language ability required by the role.
- Age, gender, marital status, religion, ethnicity, health, photos and nationality (beyond legal work permit requirements) must never influence screening.
- Every automated recommendation is reviewed by a recruiter before a candidate is rejected or invited.

## Data protection (KVKK / GDPR)
- Applicants receive the privacy notice on the careers page before applying; applying constitutes acknowledgement of processing for recruitment.
- Applicant data is retained for 6 months after the position is filled, then deleted, unless the candidate consents to the talent pool (12 months).
- CVs must not be forwarded outside HR and the hiring manager.

## Process
1. Applications arrive at careers@acme.com.tr or through the careers page.
2. Recruiters screen within 5 working days and record candidates in the applicant tracking system.
3. Shortlisted candidates are invited to a first interview within 10 working days.`,
  },
  {
    topic: "hr",
    title: "Remote Work Policy",
    text: `# Remote Work Policy

Office-based roles may work remotely up to 2 days per week with manager approval. Production and warehouse roles are excluded.
Remote work days are registered in the HR system by Friday for the following week.
Employees must use the company VPN and keep confidential documents off personal devices.
Internet allowance: 500 TRY per month for employees working remotely at least 4 days a month.`,
  },
  {
    topic: "finance",
    title: "Travel & Expense Policy",
    text: `# Travel & Expense Policy

## Accommodation
- Domestic travel: hotel limit 4,500 TRY per night (Istanbul 6,000 TRY).
- International travel: hotel limit 180 EUR per night (London, Paris, New York: 250 EUR).

## Meals
- Daily meal allowance: 1,200 TRY domestic, 60 EUR international. Alcohol is not reimbursed.

## Transport
- Economy class for flights under 6 hours. Taxi only when public transport is impractical; keep receipts.

## Submitting expenses
Submit expense reports within 30 days with an itemised receipt for every expense above 250 TRY. Reports above 25,000 TRY need the department head's approval. Missing receipts must be explained in writing.`,
  },
  {
    topic: "finance",
    title: "Accounts Payable: Invoice Processing Rules",
    text: `# Accounts Payable: Invoice Processing Rules

## Three-way match
Every supplier invoice referencing a purchase order is matched against the PO and the goods receipt:
- Price tolerance: ±2% per line, max 1,000 TRY in total.
- Quantity tolerance: invoiced quantity must not exceed received quantity.
- Invoices without a PO number go to the requester's department head for approval.

## Approval limits
- Up to 50,000 TRY: AP clerk.
- 50,000–250,000 TRY: Finance manager.
- Above 250,000 TRY: CFO.

## Payment terms
Standard payment term is 60 days end of month unless the supplier contract states otherwise. E-invoices (e-Fatura) are mandatory for Turkish suppliers; foreign suppliers send PDF invoices to invoices@acme.com.tr.

## Duplicate protection
The same invoice number from the same supplier must never be posted twice.`,
  },
  {
    topic: "it",
    title: "Access & Password Policy",
    text: `# Access & Password Policy

- Passwords: at least 12 characters, changed every 180 days, MFA mandatory for email, VPN and ERP.
- Access to business systems (SAP, HR system, CRM) is requested through the IT service desk and approved by the employee's manager and the system owner.
- Privileged access is time-limited to 30 days.
- Lost or stolen devices must be reported to it-helpdesk@acme.com.tr immediately.

## VPN access
Employees request VPN access in the IT service desk ("Access request" → "VPN"). Approval by the line manager is required. The VPN client is installed remotely within one working day.`,
  },
  {
    topic: "it",
    title: "Integrating AI Agents with Company Systems",
    text: `# Integrating AI Agents with Company Systems

Checklist the IT team uses for integration requests coming from the Enterprise Brain Agent Builder:
- Microsoft 365 mailboxes: register an Entra ID application with Mail.Read / Mail.Send application permissions and restrict it to the requested mailbox with an application access policy.
- SAP S/4HANA: create a communication user and arrangement (e.g. SAP_COM_0053 for purchase orders, SAP_COM_0057 for supplier invoices) with the minimum scope.
- HR system (SuccessFactors): OData API user with read-only role limited to recruiting objects.
- Every technical user is documented in the CMDB with an owner and a review date.
- Integration requests are answered within 5 working days.`,
  },
  {
    topic: "customer-service",
    title: "Returns & Refunds Policy",
    text: `# Returns & Refunds Policy

- Customers may return unused products within 30 days of delivery with the original invoice.
- Defective products are replaced or refunded within the 2-year warranty; the customer sends photos of the defect first.
- Refunds are made to the original payment method within 10 working days after the returned goods are inspected.
- Custom-made or cut-to-size products cannot be returned unless defective.
- Return shipping is free for defective products; otherwise the customer pays.

To start a return, the customer emails support@acme.com.tr with the order number.`,
  },
  {
    topic: "customer-service",
    title: "Delivery Times & Order Status FAQ",
    text: `# Delivery Times & Order Status

- Standard products ship within 2 working days; delivery in Turkey takes 1–3 working days after shipping.
- Made-to-order products: 10–15 working days production + shipping.
- International orders: 5–10 working days depending on customs.
- Customers receive a tracking number by email when the order ships.
- Delayed orders: if an order is more than 5 working days late, customer service proactively informs the customer and offers a 5% discount on the next order.`,
  },
  {
    topic: "procurement",
    title: "Purchasing Policy",
    text: `# Purchasing Policy

- Purchases above 100,000 TRY require at least three supplier quotes.
- New suppliers are onboarded only after tax certificate, signature circular, bank letter and a signed code-of-conduct form are received.
- Preferred suppliers are reviewed yearly on quality, delivery performance and price.
- Purchase requisitions are approved by the budget owner before a PO is issued.`,
  },
  {
    topic: "legal",
    title: "NDA & Contract Review Guidelines",
    text: `# NDA & Contract Review Guidelines

- Mutual NDAs on the company template can be signed by department heads; one-way NDAs need Legal review.
- Contracts must be governed by Turkish law with Istanbul courts, unless Legal approves otherwise.
- Liability caps below 12 months of fees, unlimited indemnities and automatic renewals longer than 1 year are escalated to Legal.
- Personal data processing requires a data processing agreement (DPA) compliant with KVKK.`,
  },
];
