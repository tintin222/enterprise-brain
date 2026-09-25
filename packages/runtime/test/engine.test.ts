import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { LocalHashEmbedder, ScriptedLlm } from "@enterprise-brain/llm";
import { BudgetError, Platform } from "../src/index.ts";

/**
 * The run engine with Claude scripted: structured classification, generation, an approval-gated
 * email, dry-run test runs and a task-mode tool loop against the sandbox ERP.
 */
const llm = new ScriptedLlm({
  "runtime.classify": { structured: () => ({ category: "complaint", confidence: 0.93, reason: "The order arrived late." }) },
  "runtime.generate": { complete: () => "Dear customer, we are sorry your order was late. It ships today." },
  "runtime.agent": {
    tools: (request, turn, previous) => {
      const lookup = request.tools.find((t) => t.name.endsWith("get_purchase_order"));
      return turn === 1 && lookup ? { calls: [{ name: lookup.name, input: { po_number: "PO-4500012" } }] } : { text: `Checked the order. ${previous.at(-1)?.slice(0, 60) ?? ""}` };
    },
  },
});

const complaintDesk: AgentDefinitionInput = {
  slug: "complaint-desk",
  name: "Complaint Desk",
  summary: "Classifies customer emails and answers complaints.",
  archetype: "mail-triage",
  instructions: "You answer customer emails for Acme.",
  inputs: [
    { key: "text", label: "Email text", type: "text", required: true },
    { key: "customer", label: "Customer email", type: "email", required: true },
  ],
  outputs: [
    { key: "category", type: "string" },
    { key: "sent", type: "boolean" },
  ],
  workflow: [
    { id: "classify", type: "llm.classify", from: "{{ input.text }}", categories: [{ value: "complaint" }, { value: "question" }] },
    { id: "reply", type: "llm.generate", prompt: "Answer this complaint: {{ input.text }}", when: "steps.classify.category == 'complaint'" },
    { id: "send", type: "mail.send", to: "{{ input.customer }}", subject: "About your order", body: "{{ steps.reply.text }}" },
    { id: "result", type: "output", value: { category: "{{ steps.classify.category }}", sent: "{{ steps.send.sent }}" } },
  ],
  guardrails: { approvalRequiredFor: ["mail.send"], personalData: "contains" },
};

const orderDesk: AgentDefinitionInput = {
  slug: "order-desk",
  name: "Order Desk",
  summary: "Answers questions about purchase orders.",
  archetype: "conversational",
  instructions: "You answer questions about purchase orders using the ERP.",
  connectors: [{ ref: "erp", category: "erp", purpose: "Purchase orders" }],
  tools: ["connector:erp.get_purchase_order"],
};

/** Posts a supplier invoice in the sandbox ERP: a change whose amount the probation limits look at. */
const invoicePoster: AgentDefinitionInput = {
  slug: "invoice-poster",
  name: "Invoice Poster",
  summary: "Posts supplier invoices in the ERP.",
  archetype: "document-processing",
  instructions: "Post supplier invoices.",
  inputs: [
    { key: "number", type: "string", required: true },
    { key: "net", type: "number", required: true },
  ],
  connectors: [{ ref: "erp", category: "erp", purpose: "Supplier invoices" }],
  triggers: [{ type: "manual" }, { type: "mailbox", mailbox: "invoices@acme.test" }],
  workflow: [
    {
      id: "post",
      type: "connector",
      connector: "erp",
      operation: "post_supplier_invoice",
      input: {
        supplier_id: "SUP-1001",
        invoice_number: "{{ input.number }}",
        invoice_date: "2026-09-01",
        currency: "TRY",
        net_amount: "{{ input.net }}",
        tax_amount: "{{ input.net * 0.2 }}",
        total_amount: "{{ input.net * 1.2 }}",
      },
    },
  ],
};

let platform: Platform;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-runtime-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.agents.create(companyId, { definition: complaintDesk, status: "active" });
  await platform.agents.create(companyId, { definition: orderDesk, status: "active" });
  await platform.agents.create(companyId, { definition: invoicePoster, status: "active" });
});
afterAll(async () => {
  await platform?.close();
});

const input = { text: "My order SO-7000121 arrived two weeks late!", customer: "ops@customer.example" };

describe("run engine with Claude (scripted)", () => {
  it("pauses before sending an email and sends it only after approval", async () => {
    const run = await platform.engine.start(companyId, "complaint-desk", input, { wait: true });
    expect(run.status).toBe("waiting_approval");
    const outboxBefore = await platform.mail.list(companyId, { direction: "outbound" });
    expect(outboxBefore.some((m) => m.toAddresses.includes(input.customer))).toBe(false);

    const [approval] = (await platform.engine.listApprovals(companyId, { status: "pending" })).filter((a) => a.runId === run.id);
    expect(approval?.action).toMatchObject({ type: "mail.send", to: input.customer, body: expect.stringContaining("sorry") });
    await platform.engine.decide(companyId, approval!.id, { approved: true, decidedBy: "test" }, { wait: true });

    const done = await platform.engine.getRow(companyId, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toMatchObject({ category: "complaint", sent: true });
    const outbox = await platform.mail.list(companyId, { direction: "outbound" });
    // The email carries its task's reference, so a reply finds its way back to the task.
    expect(outbox.some((m) => m.toAddresses.includes(input.customer) && /^About your order \[EB-[2-9A-Z]{5}\]$/.test(m.subject))).toBe(true);
    expect(llm.calls.some((c) => c.purpose === "runtime.classify:complaint-desk.classify")).toBe(true);
  });

  it("dry-runs gated actions in test runs", async () => {
    const before = (await platform.mail.list(companyId, { direction: "outbound" })).length;
    const run = await platform.engine.start(companyId, "complaint-desk", input, { wait: true, isTest: true });
    expect(run.status).toBe("succeeded");
    const { events } = await platform.engine.get(companyId, run.id);
    expect(events.some((e) => e.stepId === "send" && /dry run/i.test(e.message ?? ""))).toBe(true);
    expect((await platform.mail.list(companyId, { direction: "outbound" })).length).toBe(before);
  });

  it("works on a free-form task with the agent's connector tools (task mode)", async () => {
    const run = await platform.engine.start(companyId, "order-desk", {}, { wait: true, task: "What is the status of PO-4500012?" });
    expect(run.status).toBe("succeeded");
    const { events } = await platform.engine.get(companyId, run.id);
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult?.message).toMatch(/get_purchase_order/);
    expect(toolResult?.data).toMatchObject({ isError: false });
    expect(String((run.output as { text?: string } | null)?.text ?? JSON.stringify(run.output))).toContain("Checked the order");
  });
});

describe("probation levels and budgets in runs", () => {
  const post = (number: string, net: number) => platform.engine.start(companyId, "invoice-poster", { number, net }, { wait: true });
  const approvalOf = async (runId: string) => (await platform.engine.listApprovals(companyId, { status: "pending" })).find((a) => a.runId === runId);

  it("starts new AI employees supervised: every change waits for a person, who sees why", async () => {
    const agent = await platform.agents.get(companyId, "invoice-poster");
    expect(agent.row.probation).toBe("supervised");
    const run = await post("INV-P-1", 1000);
    expect(run.status).toBe("waiting_approval");
    expect((await approvalOf(run.id))?.reason).toBe("Supervised: every change goes to a person");
  });

  it("lets a trusted AI employee post alone within its limit, and asks above it", async () => {
    await platform.employment.update(companyId, "invoice-poster", { probation: "trusted", limits: { maxAmount: 10_000, currency: "TRY" } }, "test");
    const alone = await post("INV-P-2", 5000);
    expect(alone.status, alone.error ?? "").toBe("succeeded");
    const { events } = await platform.engine.get(companyId, alone.id);
    expect(events.find((e) => e.type === "action.executed")?.data).toMatchObject({ alone: true, reason: "Within its limits (Trusted)" });
    const agent = await platform.agents.get(companyId, "invoice-poster");
    expect(await platform.engine.changesToday(agent.row.id)).toBe(1);

    const above = await post("INV-P-3", 10_000);
    expect(above.status).toBe("waiting_approval");
    expect((await approvalOf(above.id))?.reason).toBe("12,000 TRY is above its limit of 10,000 TRY");
  });

  it("asks a person once its changes for the day are used up", async () => {
    await platform.employment.update(companyId, "invoice-poster", { limits: { maxAmount: 10_000, currency: "TRY", maxActionsPerDay: 1 } }, "test");
    const run = await post("INV-P-4", 100);
    expect(run.status).toBe("waiting_approval");
    expect((await approvalOf(run.id))?.reason).toBe("Above its limit of 1 changes a day");
  });

  it("stops at its monthly budget, tells its manager once, and leaves its email for later", async () => {
    await platform.employment.update(companyId, "invoice-poster", { monthlyBudgetUsd: 0 }, "test");
    await expect(post("INV-P-5", 100)).rejects.toBeInstanceOf(BudgetError);
    await expect(post("INV-P-6", 100)).rejects.toThrow(/reached its monthly budget/);
    const notices = (await platform.activity.list(companyId, 200)).filter((a) => a.action === "agent.budget_reached");
    expect(notices).toHaveLength(1);
    // Test runs still work: they are how a manager checks a change before raising the budget.
    expect((await platform.engine.start(companyId, "invoice-poster", { number: "INV-T", net: 1 }, { wait: true, isTest: true })).status).toBe("succeeded");

    const mail = await platform.mail.ingest(companyId, { mailbox: "invoices@acme.test", from: "billing@kayacelik.example", subject: "Invoice", body: "Attached." });
    expect(await platform.triggers.routeInboundMail(companyId, mail, { wait: true })).toEqual([]);
    expect((await platform.mail.get(companyId, mail.id)).status).toBe("new");

    const view = await platform.employment.view(companyId, await platform.agents.get(companyId, "invoice-poster"));
    expect(view).toMatchObject({ probation: "trusted", monthlyBudgetUsd: 0, stoppedByBudget: true });
    expect(view.duties.map((d) => d.text)).toEqual(["Reads every email sent to invoices@acme.test"]);
  });
});
