import { describe, expect, it } from "vitest";
import { AgentDefinition, describeDuties, scheduleText } from "@enterprise-brain/core";
import { actionAmount, checkApproval, defaultProbation, type Employment } from "../src/policy.ts";

/** Probation levels decide which changes go to a person; limits bound what a trusted AI employee does alone. */
const job = AgentDefinition.parse({
  slug: "invoice-clerk",
  name: "Invoice Clerk",
  summary: "Posts supplier invoices.",
  archetype: "document-processing",
  instructions: "Post invoices.",
  connectors: [
    { ref: "erp", category: "erp" },
    { ref: "bank", category: "rest-api" },
  ],
  guardrails: { approvalRequiredFor: ["mail.send", "connector:write", "connector:bank"], personalData: "none" },
});
const invoice = (total: number, currency = "TRY") => ({
  type: "connector" as const,
  ref: "erp",
  operation: "post_supplier_invoice",
  input: { supplier_id: "SUP-1001", currency, net_amount: total / 1.2, tax_amount: total - total / 1.2, total_amount: total },
});
const trusted = (limits: Employment["limits"] = {}): Employment => ({ probation: "trusted", limits });

describe("probation levels", () => {
  it("sends every change to a person in Shadow and Supervised", () => {
    for (const probation of ["shadow", "supervised"] as const) {
      const check = checkApproval(job, { probation, limits: {} }, invoice(100));
      expect(check.needed).toBe(true);
      expect(check.reason).toMatch(/every change goes to a person/);
      expect(checkApproval(job, { probation, limits: {} }, { type: "mail.send", to: "a@b.com" }).needed).toBe(true);
    }
  });

  it("lets a trusted AI employee act alone within its limits", () => {
    const check = checkApproval(job, trusted({ maxAmount: 10_000, currency: "TRY" }), invoice(8_000));
    expect(check).toMatchObject({ needed: false, alone: true });
    expect(checkApproval(job, trusted(), { type: "mail.send", to: "supplier@partner.com" }).needed).toBe(false);
  });

  it("asks a person above the amount limit, or in another currency", () => {
    const limits = { maxAmount: 10_000, currency: "TRY" };
    const above = checkApproval(job, trusted(limits), invoice(12_500));
    expect(above).toMatchObject({ needed: true });
    expect(above.reason).toBe("12,500 TRY is above its limit of 10,000 TRY");
    expect(checkApproval(job, trusted(limits), invoice(900, "EUR")).reason).toBe("The amount is in EUR; its limit is in TRY");
  });

  it("asks a person after its daily number of changes", () => {
    const limits = { maxActionsPerDay: 20 };
    expect(checkApproval(job, trusted(limits), invoice(10), { changesToday: 19 }).needed).toBe(false);
    expect(checkApproval(job, trusted(limits), invoice(10), { changesToday: 20 }).reason).toBe("Above its limit of 20 changes a day");
  });

  it("emails alone only inside the allowed domains", () => {
    const limits = { mailDomains: ["acme.com.tr"] };
    expect(checkApproval(job, trusted(limits), { type: "mail.send", to: "ayse@acme.com.tr" }).needed).toBe(false);
    expect(checkApproval(job, trusted(limits), { type: "mail.send", to: "it@hq.acme.com.tr" }).needed).toBe(false);
    const outside = checkApproval(job, trusted(limits), { type: "mail.send", to: "ayse@acme.com.tr, Candidate <jane@gmail.com>" });
    expect(outside.needed).toBe(true);
    expect(outside.reason).toMatch(/^jane@gmail\.com is outside/);
  });

  it("always asks before what the job names, at every level", () => {
    const pay = { type: "connector" as const, ref: "bank", operation: "http_post", input: { amount: 5 } };
    expect(checkApproval(job, trusted(), pay).reason).toBe("Its job says to always ask a person before this");
  });

  it("honours a workflow step's own rule: false means a person approved it earlier", () => {
    expect(checkApproval(job, { probation: "shadow", limits: {} }, invoice(50_000), { explicit: false }).needed).toBe(false);
    expect(checkApproval(job, trusted(), invoice(1), { explicit: true }).needed).toBe(true);
  });

  it("starts jobs that asked for no approvals as trusted", () => {
    expect(defaultProbation(job)).toBe("supervised");
    expect(defaultProbation({ ...job, guardrails: { ...job.guardrails, approvalRequiredFor: [] } })).toBe("trusted");
  });
});

describe("amounts in an action", () => {
  it("finds totals, prices and order lines", () => {
    expect(actionAmount({ total_amount: 1200, net_amount: 1000 })).toBe(1200);
    expect(actionAmount({ supplier_id: "S", lines: [{ quantity: 3, unit_price: 250 }, { quantity: 2, unit_price: "100" }] })).toBe(950);
    expect(actionAmount({ body: { Amount: "15000.50" } })).toBe(15000.5);
    expect(actionAmount({ subject: "Hello", count: 4 })).toBeUndefined();
  });
});

describe("duties in plain words", () => {
  it("describes triggers as standing jobs", () => {
    const duties = describeDuties([
      { type: "manual" },
      { type: "mailbox", mailbox: "careers@acme.com.tr", filter: { hasAttachment: true } },
      { type: "schedule", cron: "0 8 * * 1-5" },
      { type: "connector-event", connector: "erp", event: "invoice.created" },
    ]);
    expect(duties.map((d) => d.text)).toEqual([
      "Reads every email sent to careers@acme.com.tr with an attachment",
      "Works every weekday at 08:00",
      "Acts when “invoice created” happens in erp",
    ]);
  });

  it("reads common schedules", () => {
    expect(scheduleText("0 9 * * *")).toBe("every day at 09:00");
    expect(scheduleText("30 7 * * 1")).toBe("every Monday at 07:30");
    expect(scheduleText("0 6 1 * *")).toBe("on day 1 of every month at 06:00");
    expect(scheduleText("*/15 * * * *")).toBe("every 15 minutes");
    expect(scheduleText("0 8 1-7 * 1")).toBe("on the schedule “0 8 1-7 * 1”");
  });
});
