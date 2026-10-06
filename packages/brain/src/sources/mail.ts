import { released, waveMoment } from "../demo/util.ts";
import type { SourceEvent, SourceRef } from "../types.ts";
import { domainOf, text } from "./names.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * Email: the shared mailboxes in the app (support@, invoices@, careers@…), and made-up emails of the
 * sales and purchasing people with clients and suppliers. Emails are tied to the clients and suppliers
 * they come from, by their address.
 */

interface Email {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  days: number;
  wave?: number;
  about?: SourceRef[];
}

const EMAILS: Email[] = [
  {
    from: "sevgi.karaca@petrokim.example",
    fromName: "Sevgi Karaca",
    to: "ali.yildiz",
    days: -9,
    subject: "ACP-80 pumps: vibration above the limit",
    body: "Dear Ali Bey, three of the pumps delivered under our PO PKR-4500871 show vibration above 7 mm/s after about 200 hours. Please send someone to İzmit urgently. We hold the payment of invoice ACM-F-00301 until this is solved.",
  },
  {
    from: "ali.yildiz",
    fromName: "Ali Yıldız",
    to: "sevgi.karaca@petrokim.example",
    days: -3,
    subject: "RE: ACP-80 pumps: root cause and next steps",
    body: "Dear Sevgi Hanım, the cause is a misaligned coupling from one of our assembly fixtures. New couplings arrive this week; our technician re-aligns the 3 pumps on site, and you get the 8D report within 10 working days.",
    about: [{ kind: "project", key: "petrokim-vibration" }],
  },
  {
    from: "o.haddad@gulfwater.example",
    fromName: "Omar Haddad",
    to: "laura.rossi",
    days: -8,
    subject: "FAT witness for PO GW-2026-118",
    body: "Dear Laura, our inspector Mr. Rahman will witness the factory acceptance test of the first 60 pumps. Please send the test plan one week before.",
    about: [{ kind: "project", key: "gulf-water-desalination" }],
  },
  {
    from: "orders@rheintal-hydraulik.example",
    fromName: "Rheintal Hydraulik",
    to: "ayse.kaya",
    days: -3,
    subject: "Order confirmation: 3 flexible couplings",
    body: "We confirm your order for 3 flexible couplings, delivery to Gebze in 3 days.",
  },
  {
    from: "j.hansen@nordwind-energy.example",
    fromName: "Jens Hansen",
    to: "thomas.weber",
    days: -1,
    subject: "Annual volume ACP-65-NW",
    body: "Dear Thomas, after the visit we can confirm a need of about 300 cooling pumps a year from Q2. Please send your offer by the end of next month.",
    about: [{ kind: "project", key: "nordwind-npi" }],
  },
  {
    from: "info@anadoludokum.example",
    fromName: "Fatma Yurt",
    to: "ayse.kaya",
    days: -7,
    subject: "Delay of DN80 pump housings",
    body: "Dear Ayşe Hanım, because of a furnace breakdown the DN80 housings of PO-4500015 will be 6 days late. We are sorry for the trouble.",
  },
  {
    from: "rahman@gulfwater.example",
    fromName: "Abdul Rahman",
    to: "laura.rossi",
    days: 0,
    wave: 1,
    subject: "Inspector availability",
    body: "Dear Ms. Rossi, I can only travel to Gebze from the 20th. Please move the FAT accordingly.",
    about: [{ kind: "project", key: "gulf-water-desalination" }],
  },
  {
    from: "datev@steuerbuero-krueger.example",
    fromName: "Steuerbüro Krüger",
    to: "burak.sahin",
    days: 0,
    wave: 1,
    subject: "DATEV export September, Acme Pumpen GmbH",
    body: "Attached is the DATEV export of September for the consolidation.",
    about: [{ kind: "process", key: "consolidation-reporting" }],
  },
  {
    from: "sevgi.karaca@petrokim.example",
    fromName: "Sevgi Karaca",
    to: "ali.yildiz",
    days: 0,
    wave: 2,
    subject: "Payment release",
    body: "Dear Ali Bey, thank you for the quick fix and the 8D report. The payment of ACM-F-00301 is released next week.",
    about: [{ kind: "project", key: "petrokim-vibration" }],
  },
  {
    from: "m.nowak@vistula-we.example",
    fromName: "Marta Nowak",
    to: "laura.rossi",
    days: 0,
    wave: 2,
    subject: "Pumps for the Gdańsk treatment plant",
    body: "Dear Laura, as discussed, we need 24 ACP-80 pumps for delivery in Q1. Please send your offer.",
  },
];

export const mailSource: BrainSourceDefinition = {
  key: "email",
  name: "Email (demo)",
  system: "Exchange Online",
  description:
    "The shared mailboxes in the app, and the sales and purchasing people's emails with clients and suppliers, tied to the clients and suppliers they come from. New emails each time it is read.",
  brings: ["Emails with clients and suppliers", "The shared mailboxes"],
  icon: "mail",
  demo: true,
  priority: 40,
  async read({ companyId, deps, domain, now, syncs }) {
    // Who writes from which domain: clients by their website and contacts, suppliers by their email.
    const [accounts, contacts, suppliers, inbox] = await Promise.all([
      deps.sandbox(companyId, "sandbox-crm", "accounts").catch(() => []),
      deps.sandbox(companyId, "sandbox-crm", "contacts").catch(() => []),
      deps.sandbox(companyId, "sandbox-erp", "suppliers").catch(() => []),
      deps.mail(companyId, 150).catch(() => []),
    ]);
    const byDomain = new Map<string, SourceRef>();
    for (const account of accounts) {
      const host = domainOf(account.website);
      if (host) byDomain.set(host, { kind: "client", name: String(account.name) });
    }
    for (const contact of contacts) {
      const host = domainOf(contact.email);
      const account = accounts.find((a) => a.account_id === contact.account_id);
      if (host && account && !byDomain.has(host)) byDomain.set(host, { kind: "client", name: String(account.name) });
    }
    for (const supplier of suppliers) {
      const host = domainOf(supplier.email);
      if (host && !byDomain.has(host)) byDomain.set(host, { kind: "supplier", name: String(supplier.name) });
    }
    const address = (value: string) => (value.includes("@") ? value : `${value}@${domain}`);
    const sender = (from: string) => byDomain.get(domainOf(from) ?? "") ?? undefined;

    const events: SourceEvent[] = released(EMAILS, syncs).map((email, index) => {
      const from = address(email.from);
      const to = address(email.to);
      const party = sender(from) ?? sender(to);
      return {
        ref: `mail:${EMAILS.indexOf(email)}`,
        at: waveMoment(now, email.wave ?? 0, email.days, index),
        kind: "email",
        title: email.subject,
        body: email.body,
        actor: `${email.fromName} <${from}>`,
        place: `${from} → ${to}`,
        about: [...(party ? [party] : []), ...(email.about ?? [])],
      };
    });
    for (const message of inbox) {
      const party = sender(message.from);
      events.push({
        ref: `inbox:${message.id}`,
        at: message.receivedAt,
        kind: "email",
        title: message.subject || "(no subject)",
        body: text(message.body)?.slice(0, 800),
        actor: message.fromName ? `${message.fromName} <${message.from}>` : message.from,
        place: message.mailbox,
        about: party ? [party] : [],
      });
    }
    return { events };
  },
};
