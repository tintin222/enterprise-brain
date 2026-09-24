import { describe, expect, it } from "vitest";
import { sandboxCrmConnector } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

const crm = sandboxCrmConnector;

describe("sandbox-crm", () => {
  it("seeds accounts, contacts, leads, opportunities, cases and activities", async () => {
    const ctx = makeCtx();
    const accounts = await run(crm, "search_accounts", {}, ctx);
    expect(accounts.total).toBeGreaterThanOrEqual(12);
    for (const entity of ["accounts", "contacts", "leads", "opportunities", "cases", "activities"]) {
      expect((await ctx.sandbox.list("sandbox-crm", entity)).length, entity).toBeGreaterThanOrEqual(8);
    }
    expect((await run(crm, "search_accounts", { query: "raffinerie refining" }, ctx)).total).toBe(0);
    expect((await run(crm, "search_accounts", { query: "refining" }, ctx)).items[0].account_id).toBe("ACC-3006");
  });

  it("returns an account 360° view", async () => {
    const account = await run(crm, "get_account", { account_id: "ACC-3002" }, makeCtx());
    expect(account).toMatchObject({ name: "Hansa Pumpen Vertrieb GmbH", erp_customer_id: "CUST-2002" });
    expect(account.contacts.map((c: any) => c.contact_id)).toEqual(["CON-4003", "CON-4004", "CON-4016"]);
    expect(account.open_opportunities.map((o: any) => o.opportunity_id)).toEqual(["OPP-6001"]);
    expect(account.recent_activities.length).toBeGreaterThan(0);
  });

  it("finds contacts by e-mail and cases by status/contact", async () => {
    const ctx = makeCtx();
    const contacts = await run(crm, "search_contacts", { email: "SEVGI.KARACA@petrokim.example" }, ctx);
    expect(contacts.items).toHaveLength(1);
    expect(contacts.items[0]).toMatchObject({ contact_id: "CON-4008", account_name: "Petrokim Rafineri A.Ş." });
    const cases = await run(crm, "search_cases", { contact_email: "sevgi.karaca@petrokim.example" }, ctx);
    expect(cases.items[0]).toMatchObject({ case_id: "CASE-7003", priority: "urgent" });
    const newCases = await run(crm, "search_cases", { status: "new" }, ctx);
    expect(newCases.items.every((c: any) => c.status === "new")).toBe(true);
    const kase = await run(crm, "get_case", { case_id: "case-7003" }, ctx);
    expect(kase.notes.length).toBe(2);
    expect((await expectConnectorError(crm.execute("get_case", { case_id: "CASE-1" }, ctx))).code).toBe("not_found");
  });

  it("lists leads by status and opportunities by stage", async () => {
    const ctx = makeCtx();
    const leads = await run(crm, "search_leads", { status: "new" }, ctx);
    expect(leads.items.map((l: any) => l.score)).toEqual([...leads.items.map((l: any) => l.score)].sort((a, b) => b - a));
    const negotiation = await run(crm, "search_opportunities", { stage: "negotiation" }, ctx);
    expect(negotiation.items.map((o: any) => o.opportunity_id).sort()).toEqual(["OPP-6001", "OPP-6009"]);
  });

  it("creates and updates leads, reporting possible duplicates", async () => {
    const ctx = makeCtx();
    const lead = await run(
      crm,
      "create_lead",
      { company: "Marmara Gıda A.Ş.", contact_name: "Deniz Arı", email: "Deniz.Ari@marmaragida.example", source: "Web form", score: 66, notes: "Asks for AV-50 prices" },
      ctx,
    );
    expect(lead).toMatchObject({ ok: true, lead_id: "LEAD-5011", status: "new", email: "deniz.ari@marmaragida.example", possible_duplicates: [] });
    const dup = await run(crm, "create_lead", { company: "Rhône Aqua", contact_name: "Camille Laurent", email: "c.laurent@rhone-aqua.example" }, ctx);
    expect(dup.possible_duplicates).toEqual(["LEAD-5010", "CON-4013"]);
    const updated = await run(crm, "update_lead", { lead_id: "LEAD-5011", fields: { status: "qualified", score: 81, notes: "Budget confirmed" } }, ctx);
    expect(updated).toMatchObject({ ok: true, status: "qualified", score: 81, changed_fields: ["status", "score", "notes"] });
    expect((await expectConnectorError(crm.execute("update_lead", { lead_id: "LEAD-5011", fields: { lead_id: "X" } }, ctx))).message).toMatch(/Cannot update lead_id/);
    expect((await run(crm, "update_lead", { lead_id: "LEAD-5011", fields: { status: "Contacted" } }, ctx)).status).toBe("working");
    expect((await expectConnectorError(crm.execute("update_lead", { lead_id: "LEAD-5011", fields: { status: "maybe" } }, ctx))).message).toMatch(
      /status must be one of: new, working, qualified, disqualified, converted/,
    );
    expect((await expectConnectorError(crm.execute("create_lead", { company: "X", contact_name: "Y", email: "not-an-email" }, ctx))).code).toBe("validation");
  });

  it("creates cases linked to the contact's account and updates them", async () => {
    const ctx = makeCtx();
    const kase = await run(
      crm,
      "create_case",
      {
        contact_email: "jmorales@ibericafluid.example",
        subject: "Remaining valves of SO-7000126 still missing",
        description: "The express truck did not arrive.",
        priority: "high",
        category: "delivery",
      },
      ctx,
    );
    expect(kase).toMatchObject({ ok: true, case_id: "CASE-7010", account_id: "ACC-3003", contact_name: "Javier Morales", status: "new", related_order: "SO-7000126", contact_known: true });
    expect(Date.parse(kase.sla_due_at) - Date.parse(kase.created_at)).toBe(8 * 3_600_000);
    const unknown = await run(crm, "create_case", { contact_email: "new.person@unknown.example", subject: "Info", description: "Catalogue please", priority: "low", category: "information_request" }, ctx);
    expect(unknown).toMatchObject({ account_id: null, contact_known: false });
    const updated = await run(crm, "update_case", { case_id: "CASE-7010", status: "resolved", notes: "Delivered today" }, ctx);
    expect(updated).toMatchObject({ status: "resolved", notes: [{ text: "Delivered today" }] });
    expect(updated.resolved_at).toBeTruthy();
    expect((await expectConnectorError(crm.execute("update_case", { case_id: "CASE-7010" }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(crm.execute("create_case", { contact_email: "a@b.example", subject: "s", description: "d", priority: "whenever", category: "delivery" }, ctx))).code).toBe(
      "validation",
    );
    const synonyms = await run(crm, "create_case", { contact_email: "a@b.example", subject: "s", description: "d", priority: "Critical", category: "Product question" }, ctx);
    expect(synonyms).toMatchObject({ priority: "urgent", category: "information_request", category_detail: null });
    const custom = await run(crm, "create_case", { contact_email: "a@b.example", subject: "s", description: "d", priority: "normal", category: "Spare parts" }, ctx);
    expect(custom).toMatchObject({ priority: "medium", category: "other", category_detail: "Spare parts" });
  });

  it("logs activities on existing records only", async () => {
    const ctx = makeCtx();
    const activity = await run(crm, "log_activity", { related_to: "OPP-6001", type: "call", subject: "Rebate discussion", notes: "Agreed on 4%" }, ctx);
    expect(activity).toMatchObject({ ok: true, activity_id: "ACT-8011", related_type: "opportunity" });
    expect((await expectConnectorError(crm.execute("log_activity", { related_to: "OPP-9999", type: "call", subject: "x" }, ctx))).code).toBe("not_found");
    expect((await expectConnectorError(crm.execute("log_activity", { related_to: "XYZ-1", type: "call", subject: "x" }, ctx))).code).toBe("validation");
  });

  it("updates opportunities and derives probability from the stage", async () => {
    const ctx = makeCtx();
    const won = await run(crm, "update_opportunity", { opportunity_id: "OPP-6001", fields: { stage: "Won", amount: 1_420_000 } }, ctx);
    expect(won).toMatchObject({ ok: true, stage: "closed_won", probability: 100, amount: 1_420_000 });
    const custom = await run(crm, "update_opportunity", { opportunity_id: "OPP-6002", fields: { stage: "negotiation", probability: 60, close_date: "2026-12-15" } }, ctx);
    expect(custom).toMatchObject({ probability: 60, close_date: "2026-12-15" });
    expect((await expectConnectorError(crm.execute("update_opportunity", { opportunity_id: "OPP-6002", fields: { close_date: "15.12.2026" } }, ctx))).code).toBe("validation");
    expect((await run(crm, "search_opportunities", { account_id: "ACC-3002", stage: "closed_won" }, ctx)).total).toBe(1);
  });
});
