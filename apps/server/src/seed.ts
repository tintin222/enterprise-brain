import { eq } from "drizzle-orm";
import { humanizeKey } from "@enterprise-brain/core";
import { companies } from "@enterprise-brain/db";
import type { CompanyRow, MembershipRole, Platform } from "@enterprise-brain/runtime";
import { DEMO_CVS, invoiceTotals, renderCv, renderInvoice, type DemoInvoice } from "./demo/documents.ts";
import { DEMO_EMAILS } from "./demo/emails.ts";
import { DEMO_KNOWLEDGE, type DemoDoc } from "./demo/knowledge.ts";

const DEMO_DEPARTMENTS = ["hr", "finance", "customer-service", "it"];

/** The demo company's people: a manager and a worker per department; the IT manager is the admin. */
const DEMO_PEOPLE: { name: string; local: string; title: string; admin?: boolean; departments: [string, MembershipRole][] }[] = [
  { name: "Mehmet Öz", local: "mehmet.oz", title: "IT Manager", admin: true, departments: [["it", "manager"], ["shared-services", "manager"]] },
  { name: "Ayşe Yılmaz", local: "ayse.yilmaz", title: "HR Manager", departments: [["hr", "manager"]] },
  { name: "Can Demir", local: "can.demir", title: "Recruitment Specialist", departments: [["hr", "worker"]] },
  { name: "Burak Şahin", local: "burak.sahin", title: "Finance Manager", departments: [["finance", "manager"]] },
  { name: "Elif Arslan", local: "elif.arslan", title: "Accounts Payable Specialist", departments: [["finance", "worker"]] },
  { name: "Zeynep Kaya", local: "zeynep.kaya", title: "Customer Service Lead", departments: [["customer-service", "manager"]] },
  { name: "Deniz Aydın", local: "deniz.aydin", title: "Customer Service Agent", departments: [["customer-service", "worker"]] },
  { name: "Emre Koç", local: "emre.koc", title: "IT Support Specialist", departments: [["it", "worker"]] },
];

/**
 * Demo people with one-click sign-in (Settings → Sign-in → Demo sign-in turns it off). Accounts that
 * already exist are left alone.
 */
export async function seedDemoPeople(platform: Platform, company: CompanyRow): Promise<string[]> {
  const domain = typeof company.settings.mailDomain === "string" && company.settings.mailDomain ? company.settings.mailDomain : "example.com";
  const departmentRows = await platform.catalog.departments(company.id);
  const emails: string[] = [];
  for (const person of DEMO_PEOPLE) {
    const email = `${person.local}@${domain}`;
    emails.push(email);
    if (await platform.people.findByEmail(company.id, email)) continue;
    const departments = person.departments
      .map(([key, role]) => ({ departmentId: departmentRows.find((d) => d.key === key)?.id, role }))
      .filter((d): d is { departmentId: string; role: MembershipRole } => Boolean(d.departmentId));
    await platform.people.create(company.id, { email, name: person.name, title: person.title, role: person.admin ? "admin" : "member", departments, authProvider: "demo" });
  }
  // Each demo AI employee reports to its department's manager.
  await platform.employment.assignDefaultManagers(company.id);
  const [row] = await platform.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, company.id));
  const signIn = (row?.settings.signIn ?? {}) as Record<string, unknown>;
  const settings = { ...(row?.settings ?? {}), demo: true, signIn: { ...signIn, demo: true, demoEmails: emails } };
  await platform.handle.db.update(companies).set({ settings }).where(eq(companies.id, company.id));
  log(`people: ${emails.length} demo people, one-click sign-in on the sign-in page`);
  return emails;
}

function log(message: string) {
  console.log(`  [seed] ${message}`);
}

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`  [seed] ${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Words in a collection key that mark a topic ("ap-policies" -> finance, "support-kb" -> customer service). */
const TOPIC_WORDS: [DemoDoc["topic"], string[]][] = [
  ["hr", ["hr", "people", "benefit", "leave", "onboarding", "recruit", "talent", "payroll"]],
  ["finance", ["finance", "ap", "ar", "invoice", "expense", "accounting", "tax", "payment", "collection", "credit", "treasury"]],
  ["it", ["it", "helpdesk", "security", "access", "integration", "infrastructure"]],
  ["customer-service", ["support", "customer", "service", "product", "manual", "faq", "return", "warranty"]],
  ["procurement", ["procurement", "purchas", "supplier", "vendor", "sourcing"]],
  ["legal", ["legal", "contract", "nda", "compliance", "privacy"]],
];
const GENERAL_WORDS = ["handbook", "company", "general", "wiki", "intranet"];

function keyTokens(key: string): string[] {
  return key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Two-letter words must match whole tokens ("it", not "item"); longer ones may be prefixes ("recruit" in "recruitment"). */
function hasWord(tokens: string[], word: string): boolean {
  return tokens.some((token) => (word.length <= 2 ? token === word : token.startsWith(word)));
}

/** Demo topics a collection should hold: its own topics, or everything for general collections, or none. */
function topicsFor(key: string): DemoDoc["topic"][] | "all" {
  const tokens = keyTokens(key);
  if (GENERAL_WORDS.some((word) => hasWord(tokens, word))) return "all";
  return TOPIC_WORDS.filter(([, words]) => words.some((word) => hasWord(tokens, word))).map(([topic]) => topic);
}

/** Pick a record field by any of several names (the sandbox systems use snake_case). */
function field<T = unknown>(record: Record<string, unknown> | undefined, ...names: string[]): T | undefined {
  for (const name of names) if (record && record[name] !== undefined && record[name] !== null) return record[name] as T;
  return undefined;
}

async function mailboxFor(platform: Platform, companyId: string, templateIds: string[], fallback: string): Promise<string> {
  const agents = await platform.agents.list(companyId);
  for (const templateId of templateIds) {
    const agent = agents.find((a) => a.row.templateId === templateId);
    const trigger = agent?.definition.triggers.find((t) => t.type === "mailbox");
    if (trigger && trigger.type === "mailbox" && trigger.mailbox !== "*") return trigger.mailbox;
  }
  return fallback;
}

/** Demo tenant: templates installed, knowledge base filled, sandbox mailboxes with realistic mail. */
export async function seedDemo(platform: Platform, companyId: string): Promise<void> {
  const catalog = platform.catalog.catalog;

  for (const useCase of catalog.useCases) {
    await attempt(`use case ${useCase.id}`, () => platform.catalog.installUseCase(companyId, useCase.id));
  }
  for (const department of DEMO_DEPARTMENTS.filter((d) => catalog.departments.some((x) => x.id === d))) {
    const result = await attempt(`department ${department}`, () => platform.catalog.installDepartment(companyId, department, { activate: true }));
    if (result) log(`installed ${department}: ${result.agents.length} agents`);
  }

  // Knowledge: each collection the installed agents use gets the policies of its topic; general
  // collections (a handbook) get everything. The company assistant searches all collections.
  for (const topic of new Set(DEMO_KNOWLEDGE.map((d) => d.topic))) {
    const existing = await platform.knowledge.listCollections(companyId);
    if (!existing.some((c) => { const t = topicsFor(c.key); return t !== "all" && t.includes(topic); })) {
      await platform.knowledge.ensureCollection(companyId, { key: `${topic}-policies`, name: `${humanizeKey(topic)} policies` });
    }
  }
  const collections = await platform.knowledge.listCollections(companyId);
  let ingested = 0;
  for (const collection of collections) {
    const topics = topicsFor(collection.key);
    const docs = topics === "all" ? DEMO_KNOWLEDGE : DEMO_KNOWLEDGE.filter((d) => topics.includes(d.topic));
    for (const doc of docs) {
      const result = await attempt(`knowledge ${doc.title}`, () =>
        platform.knowledge.ingestText(companyId, collection.key, { title: doc.title, text: doc.text, source: "text", metadata: { demo: true, topic: doc.topic } }),
      );
      if (result) ingested++;
    }
  }
  log(`knowledge: ${ingested} documents in ${collections.length} collections`);

  // Sample CVs (also used by the Agent Builder "use demo samples") and applications in the careers mailbox.
  const careers = await mailboxFor(platform, companyId, ["hr.cv-screener"], "careers@acme.com.tr");
  for (const cv of DEMO_CVS) {
    const { data, mimeType } = await renderCv(cv);
    const stored = await platform.files.put(companyId, { name: cv.fileName, data, mimeType, source: "demo", metadata: { demoSet: "cv" } });
    await platform.mail.ingest(companyId, {
      mailbox: careers,
      from: cv.from,
      fromName: cv.fromName,
      subject: cv.subject,
      body: cv.body,
      attachmentFileIds: [stored.id],
    });
  }
  log(`mail: ${DEMO_CVS.length} applications in ${careers}`);

  // Supplier invoices generated from the sandbox ERP's purchase orders: one exact 3-way match, one price mismatch.
  const invoicesMailbox = await mailboxFor(platform, companyId, ["finance.invoice-processor"], "invoices@acme.com.tr");
  // Received purchase orders not yet (fully) invoiced; search results are summaries, so fetch each order's lines.
  const invoices: DemoInvoice[] = [];
  for (const status of ["received", "partially_received"]) {
    if (invoices.length >= 2) break;
    const found = (await attempt("purchase orders", () => platform.connectors.executeByType(companyId, "sandbox-erp", "search_purchase_orders", { status }))) as
      | { items?: Record<string, unknown>[] }
      | undefined;
    for (const summary of found?.items ?? []) {
      if (invoices.length >= 2) break;
      const po = (await attempt("purchase order", () =>
        platform.connectors.executeByType(companyId, "sandbox-erp", "get_purchase_order", { po_number: String(summary.po_number) }),
      )) as Record<string, unknown> | undefined;
      const open = (field<Record<string, unknown>[]>(po, "lines") ?? [])
        .map((line) => ({ line, quantity: Number(line.received_quantity ?? 0) - Number(line.invoiced_quantity ?? 0) }))
        .filter((l) => l.quantity > 0);
      if (!po || !open.length) continue;
      const supplier = (await attempt("supplier", () =>
        platform.connectors.executeByType(companyId, "sandbox-erp", "get_supplier", { supplier_id: String(po.supplier_id) }),
      )) as Record<string, unknown> | undefined;
      if (!supplier || supplier.status === "blocked") continue;
      const index = invoices.length;
      invoices.push({
        fileName: `Invoice_${String(supplier.name).replace(/[^\w]+/g, "_").slice(0, 30)}_${index + 1}.pdf`,
        supplierName: String(supplier.name),
        supplierTaxId: String(field(supplier, "tax_id") ?? "1234567890"),
        supplierEmail: String(field(supplier, "email") ?? "billing@supplier.example"),
        invoiceNumber: `INV-2026-${String(4100 + index * 17)}`,
        invoiceDate: "2026-09-15",
        poNumber: String(po.po_number),
        currency: String(field(po, "currency") ?? "TRY"),
        // The first invoice matches the order and goods receipt exactly; the second is 12% over the agreed prices.
        lines: open.map(({ line, quantity }) => ({
          description: String(line.description ?? "Item"),
          quantity,
          unitPrice: Math.round(Number(line.unit_price ?? 0) * (index === 1 ? 1.12 : 1) * 100) / 100,
        })),
        vatRate: Math.round(Number(field(po, "tax_rate") ?? 0.2) * 100),
        iban: String(field(supplier, "iban") ?? "TR33 0006 1005 1978 6457 8413 26"),
      });
    }
  }
  for (const invoice of invoices) {
    const data = await renderInvoice(invoice);
    const stored = await platform.files.put(companyId, { name: invoice.fileName, data, mimeType: "application/pdf", source: "demo", metadata: { demoSet: "invoice" } });
    const { total } = invoiceTotals(invoice);
    await platform.mail.ingest(companyId, {
      mailbox: invoicesMailbox,
      from: invoice.supplierEmail,
      fromName: invoice.supplierName,
      subject: `Invoice ${invoice.invoiceNumber} for PO ${invoice.poNumber}`,
      body: `Dear Accounts Payable,\n\nPlease find attached invoice ${invoice.invoiceNumber} (${total.toFixed(2)} ${invoice.currency}) for purchase order ${invoice.poNumber}.\n\nBest regards,\n${invoice.supplierName}`,
      attachmentFileIds: [stored.id],
    });
  }
  log(`mail: ${invoices.length} supplier invoices in ${invoicesMailbox}`);

  const support = await mailboxFor(platform, companyId, ["customer-service.mail-triage", "shared-services.mail-assistant"], "support@acme.com.tr");
  const helpdesk = await mailboxFor(platform, companyId, ["it.helpdesk-agent"], "it-helpdesk@acme.com.tr");
  for (const email of DEMO_EMAILS) {
    await platform.mail.ingest(companyId, {
      mailbox: email.topic === "support" ? support : helpdesk,
      from: email.from,
      fromName: email.fromName,
      subject: email.subject,
      body: email.body,
    });
  }
  log(`mail: ${DEMO_EMAILS.length} messages in ${support} and ${helpdesk}`);
  await platform.activity.record(companyId, { actor: "system", action: "demo.seeded", entityType: "company", entityId: companyId, summary: "Demo company prepared" });
}
