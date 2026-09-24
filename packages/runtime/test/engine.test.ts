import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { LocalHashEmbedder, ScriptedLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

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

let platform: Platform;
let companyId: string;

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-runtime-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.agents.create(companyId, { definition: complaintDesk, status: "active" });
  await platform.agents.create(companyId, { definition: orderDesk, status: "active" });
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
    expect(outbox.some((m) => m.toAddresses.includes(input.customer) && m.subject === "About your order")).toBe(true);
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
