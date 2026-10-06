import { humanizeKey } from "@enterprise-brain/core";
import type { SourceEntity, SourceEvent, SourceLink, SourceRef } from "../types.ts";
import { capitalize, countryName, modelCodes, number, shortNames, text } from "./names.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * The demo systems the AI employees already use (the sandbox CRM, ERP and service desk), read as
 * the brain's sources: what AI employees change there shows up in the brain at the next reading.
 */

type Rec = Record<string, unknown>;

const STAGES: Record<string, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Won",
  closed_lost: "Lost",
};

const CASE_STATUS: Record<string, string> = {
  new: "New",
  open: "Open",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};

const ACCOUNT_STATUS: Record<string, string> = { customer: "Customer", prospect: "Prospect", partner: "Partner", former_customer: "Former customer" };

const ACTIVITY_KIND: Record<string, SourceEvent["kind"]> = { call: "call", email: "email", meeting: "meeting", note: "note", task: "update" };

function day(value: unknown): string | undefined {
  const t = text(value);
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : undefined;
}

function money(amount: unknown, currency: unknown): string {
  const n = number(amount) ?? 0;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${text(currency) ?? ""}`.trim();
}

function owner(name: unknown): SourceRef | undefined {
  const n = text(name);
  return n && !/agent|enterprise brain/i.test(n) ? { kind: "person", name: n } : undefined;
}

export const crmSource: BrainSourceDefinition = {
  key: "crm",
  name: "CRM (demo)",
  system: "Salesforce",
  description:
    "Clients and their contacts, deals and their stages, customer issues with their notes, and the calls, meetings and emails logged with clients. Reads the demo CRM the AI employees use.",
  brings: ["Clients and contacts", "Deals", "Customer issues", "Calls and meetings"],
  icon: "handshake",
  demo: true,
  priority: 50,
  async read({ companyId, deps }) {
    const [accounts, contacts, opportunities, cases, activities] = await Promise.all(
      ["accounts", "contacts", "opportunities", "cases", "activities"].map((entity) => deps.sandbox(companyId, "sandbox-crm", entity)),
    );
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    const events: SourceEvent[] = [];
    const accountOf = new Map((contacts ?? []).map((c) => [String(c.contact_id), String(c.account_id)]));
    for (const account of accounts ?? []) {
      const id = String(account.account_id);
      const revenue = number(account.annual_revenue_eur);
      const employees = number(account.employees);
      const size = [
        revenue ? `${(revenue / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} million EUR revenue` : null,
        employees ? `${employees.toLocaleString("en-US")} employees` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      entities.push({
        kind: "client",
        ref: id,
        name: String(account.name),
        aliases: shortNames(String(account.name)),
        summary:
          [text(account.segment), text(account.industry)?.toLowerCase(), `in ${text(account.city) ?? ""}, ${countryName(account.country) ?? ""}`]
            .filter(Boolean)
            .join(", ")
            .replace(/, in /, " in ") + ".",
        data: {
          status: ACCOUNT_STATUS[String(account.status)] ?? "Customer",
          industry: text(account.industry),
          segment: text(account.segment),
          country: countryName(account.country),
          city: text(account.city),
          website: text(account.website),
          since: account.status === "customer" ? day(account.created_at) : undefined,
          size: size || undefined,
          contacts: (contacts ?? [])
            .filter((c) => String(c.account_id) === id)
            .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)))
            .map((c) => ({ name: String(c.full_name), title: text(c.title) ?? "", email: text(c.email) ?? "", phone: text(c.phone) ?? "" })),
        },
      });
      const by = owner(account.owner);
      if (by) links.push({ from: by, relation: "owns", to: { kind: "client", ref: id } });
    }
    for (const opportunity of opportunities ?? []) {
      const id = String(opportunity.opportunity_id);
      entities.push({
        kind: "deal",
        ref: id,
        key: id.toLowerCase(),
        name: String(opportunity.name),
        data: {
          stage: STAGES[String(opportunity.stage)] ?? capitalize(opportunity.stage),
          amount: number(opportunity.amount),
          currency: text(opportunity.currency),
          probability: number(opportunity.probability),
          close_date: day(opportunity.close_date),
          products: Array.isArray(opportunity.products) ? opportunity.products : [],
          next_step: text(opportunity.next_step),
        },
        summary: text(opportunity.loss_reason) ? `Lost: ${text(opportunity.loss_reason)}` : undefined,
      });
      if (opportunity.account_id)
        links.push({ from: { kind: "deal", ref: id }, relation: "for_client", to: { kind: "client", ref: String(opportunity.account_id) } });
      const by = owner(opportunity.owner);
      if (by) links.push({ from: by, relation: "owns", to: { kind: "deal", ref: id } });
    }
    for (const issue of cases ?? []) {
      const id = String(issue.case_id);
      entities.push({
        kind: "case",
        ref: id,
        key: id.toLowerCase(),
        name: String(issue.subject),
        aliases: [id],
        summary: text(issue.description),
        data: {
          status: CASE_STATUS[String(issue.status)] ?? capitalize(issue.status),
          priority: capitalize(issue.priority),
          category: capitalize(issue.category),
          opened: day(issue.created_at),
          contact: [text(issue.contact_name), text(issue.contact_email)].filter(Boolean).join(", "),
        },
      });
      const me: SourceRef = { kind: "case", ref: id };
      if (issue.account_id) links.push({ from: me, relation: "for_client", to: { kind: "client", ref: String(issue.account_id) } });
      const by = owner(issue.owner);
      if (by) links.push({ from: by, relation: "owns", to: me });
      events.push({
        ref: `${id}:opened`,
        at: String(issue.created_at),
        kind: "update",
        title: `${capitalize(issue.priority)} customer issue opened: ${String(issue.subject)}`,
        body: text(issue.description)?.slice(0, 600),
        actor: text(issue.contact_name) ?? text(issue.contact_email),
        place: "Salesforce",
        about: [me, ...(issue.account_id ? [{ kind: "client" as const, ref: String(issue.account_id) }] : [])],
      });
      for (const [i, note] of ((issue.notes as Rec[] | undefined) ?? []).entries()) {
        events.push({
          ref: `${id}:note:${i}`,
          at: String(note.at),
          kind: "note",
          title: `Note on ${id}: ${String(issue.subject)}`,
          body: text(note.text),
          actor: text(note.author),
          place: "Salesforce",
          about: [me, ...(issue.account_id ? [{ kind: "client" as const, ref: String(issue.account_id) }] : [])],
        });
      }
    }
    for (const activity of activities ?? []) {
      const related = String(activity.related_to ?? "");
      const about: SourceRef[] = related.startsWith("ACC-")
        ? [{ kind: "client", ref: related }]
        : related.startsWith("OPP-")
          ? [{ kind: "deal", ref: related }]
          : related.startsWith("CASE-")
            ? [{ kind: "case", ref: related }]
            : related.startsWith("CON-") && accountOf.has(related)
              ? [{ kind: "client", ref: accountOf.get(related)! }]
              : [];
      const opportunity = (opportunities ?? []).find((o) => o.opportunity_id === related);
      const issue = (cases ?? []).find((c) => c.case_id === related);
      const account = opportunity?.account_id ?? issue?.account_id;
      if (account) about.push({ kind: "client", ref: String(account) });
      events.push({
        ref: String(activity.activity_id),
        at: String(activity.created_at),
        kind: ACTIVITY_KIND[String(activity.type)] ?? "note",
        title: String(activity.subject),
        body: text(activity.notes),
        actor: text(activity.owner),
        place: "Salesforce",
        about,
      });
    }
    return { entities, links, events };
  },
};

/** What each supplier supplies parts for, from the bills of materials. */
const SUPPLIES: Record<string, string[]> = {
  "SUP-1002": ["FG-20001"],
  "SUP-1004": ["FG-20001", "FG-20004"],
  "SUP-1005": ["FG-20002"],
  "SUP-1006": ["FG-20001", "FG-20003"],
  "SUP-1008": ["FG-20003"],
};

export const erpSource: BrainSourceDefinition = {
  key: "erp",
  name: "ERP (demo)",
  system: "SAP S/4HANA",
  description:
    "Suppliers and who buys from them, the products the company sells and who buys them, customers' open invoices, and recent sales orders. Reads the demo ERP the AI employees use.",
  brings: ["Suppliers", "Products", "Open invoices", "Sales orders"],
  icon: "factory",
  demo: true,
  priority: 50,
  async read({ companyId, deps, now }) {
    const [suppliers, orders, materials, customers, openItems, salesOrders] = await Promise.all(
      ["suppliers", "purchase_orders", "materials", "customers", "open_items", "sales_orders"].map((entity) => deps.sandbox(companyId, "sandbox-erp", entity)),
    );
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    const events: SourceEvent[] = [];
    for (const supplier of suppliers ?? []) {
      const id = String(supplier.supplier_id);
      const blocked = supplier.status === "blocked";
      entities.push({
        kind: "supplier",
        ref: id,
        name: String(supplier.name),
        aliases: shortNames(String(supplier.name)),
        summary: blocked ? `Blocked: ${text(supplier.block_reason) ?? "ask Procurement"}.` : `Supplies ${(text(supplier.category) ?? "parts").toLowerCase()}.`,
        data: {
          category: text(supplier.category),
          status: blocked ? "Blocked" : "Approved",
          country: countryName(supplier.country),
          city: text(supplier.city),
          payment_terms: text(supplier.payment_terms)?.replace(/^NET(\d+)$/, "$1 days"),
          email: text(supplier.email),
          contacts: text(supplier.contact_person)
            ? [{ name: String(supplier.contact_person), title: "", email: text(supplier.email) ?? "", phone: text(supplier.phone) ?? "" }]
            : [],
        },
      });
      // The buyer who orders from them most.
      const buyers = new Map<string, number>();
      for (const order of orders ?? [])
        if (order.supplier_id === id && text(order.buyer)) buyers.set(String(order.buyer), (buyers.get(String(order.buyer)) ?? 0) + 1);
      const buyer = [...buyers].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (buyer) links.push({ from: { kind: "person", name: buyer }, relation: "owns", to: { kind: "supplier", ref: id } });
      for (const material of SUPPLIES[id] ?? [])
        links.push({ from: { kind: "supplier", ref: id }, relation: "supplies", to: { kind: "product", ref: material } });
    }
    for (const material of (materials ?? []).filter((m) => m.type === "finished_good")) {
      const id = String(material.material);
      const description = String(material.description);
      entities.push({
        kind: "product",
        ref: id,
        name: description,
        aliases: modelCodes(description),
        summary: `${text(material.material_group) ?? "Product"} made in Gebze.`,
        data: { code: id, category: text(material.material_group), unit: text(material.unit) === "PC" ? "Piece" : text(material.unit), status: "Active" },
      });
    }
    for (const customer of customers ?? []) {
      const id = String(customer.customer_id);
      const items = (openItems ?? []).filter((i) => i.customer_id === id && number(i.open_amount) !== 0);
      const byCurrency = new Map<string, number>();
      for (const item of items) byCurrency.set(String(item.currency), (byCurrency.get(String(item.currency)) ?? 0) + (number(item.open_amount) ?? 0));
      const overdue = items.filter((i) => text(i.due_date) && String(i.due_date) < now.toISOString().slice(0, 10)).length;
      const disputed = items.some((i) => /disput/i.test(String(i.note ?? "")));
      const open = [...byCurrency].map(([currency, amount]) => money(amount, currency)).join(" + ");
      entities.push({
        kind: "client",
        ref: id,
        name: String(customer.name),
        aliases: shortNames(String(customer.name)),
        data: {
          country: countryName(customer.country),
          city: text(customer.city),
          segment: text(customer.segment),
          open_invoices: open
            ? `${open}${overdue ? ` (${overdue} overdue${disputed ? ", disputed" : ""})` : ""}${customer.status === "credit_hold" ? ", on credit hold" : ""}`
            : "None",
        },
      });
    }
    const since = new Date(now.getTime() - 150 * 86_400_000).toISOString().slice(0, 10);
    for (const order of salesOrders ?? []) {
      const customer = String(order.customer_id);
      const products = new Set<string>();
      for (const line of (order.lines as Rec[] | undefined) ?? []) {
        if (typeof line.material === "string" && line.material.startsWith("FG-")) products.add(line.material);
      }
      for (const product of products) links.push({ from: { kind: "client", ref: customer }, relation: "buys", to: { kind: "product", ref: product } });
      if (!day(order.order_date) || String(order.order_date) < since) continue;
      const lines = ((order.lines as Rec[] | undefined) ?? []).map((l) => `${number(l.quantity) ?? 0} × ${text(l.description) ?? "item"}`).join("; ");
      events.push({
        ref: `so:${String(order.order_number)}`,
        at: `${day(order.order_date)}T08:00:00.000Z`,
        kind: "order",
        title: `Sales order ${String(order.order_number)} from ${String(order.customer_name)}: ${money(order.total, order.currency)}`,
        body: `${lines}. Wanted by ${day(order.requested_delivery_date) ?? "—"}; ${humanizeKey(String(order.status)).toLowerCase()}.`,
        actor: text(order.sales_rep),
        place: "SAP S/4HANA",
        about: [{ kind: "client", ref: customer }],
      });
    }
    return { entities, links, events };
  },
};

export const itsmSource: BrainSourceDefinition = {
  key: "itsm",
  name: "IT service desk (demo)",
  system: "Jira Service Management",
  description:
    "IT tickets and access requests: what is broken, what people wait for, and which systems they are about. Reads the demo service desk the AI employees use.",
  brings: ["IT tickets", "Access requests"],
  icon: "life-buoy",
  demo: true,
  priority: 50,
  async read({ companyId, deps, now, domain }) {
    const [tickets, requests] = await Promise.all([
      deps.sandbox(companyId, "sandbox-itsm", "tickets"),
      deps.sandbox(companyId, "sandbox-itsm", "access_requests"),
    ]);
    // The demo service desk knows people by their acme.example address.
    const person = (email: unknown) => text(email)?.replace(/@acme\.example$/i, `@${domain}`);
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const events: SourceEvent[] = [];
    for (const ticket of tickets ?? []) {
      if (String(ticket.created_at) < since) continue;
      events.push({
        ref: String(ticket.ticket_id),
        at: String(ticket.created_at),
        kind: "ticket",
        title: `IT ticket ${String(ticket.ticket_id)}: ${String(ticket.title)}`,
        body: `${text(ticket.description)?.slice(0, 500) ?? ""}\n${capitalize(ticket.priority)} priority, ${humanizeKey(String(ticket.status)).toLowerCase()}${text(ticket.assignee) ? `, with ${String(ticket.assignee)}` : ""}.`.trim(),
        actor: person(ticket.requester_email),
        place: "IT service desk",
      });
    }
    for (const request of requests ?? []) {
      if (String(request.created_at) < since) continue;
      events.push({
        ref: String(request.request_id),
        at: String(request.created_at),
        kind: "ticket",
        title: `Access request: ${String(request.role)} in ${String(request.system)}`,
        body: `${text(request.justification) ?? ""}\n${humanizeKey(String(request.status)).toLowerCase()}.`.trim(),
        actor: person(request.requester_email),
        place: "IT service desk",
      });
    }
    return { events };
  },
};
