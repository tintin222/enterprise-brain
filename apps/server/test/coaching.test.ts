import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES_HEADING } from "@enterprise-brain/builder";
import { ScriptedLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Coaching over the API: people of the department mark a finished task as wrong and say why; the
 * department's manager has the Studio turn it into a rule, sees the replay of recent tasks, and
 * publishes the new version. Others can't.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

const text = (request: StructuredRequest) => request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

const llm = new ScriptedLlm({
  "runtime.classify": {
    structured: (request) => {
      const item = text(request).split("<item>")[1] ?? "";
      const rules = (request.system ?? "").split(RULES_HEADING)[1] ?? "";
      if (/damaged/i.test(rules) && /damaged|broken/i.test(item))
        return { category: "quality", confidence: 0.9, reason: "Damaged goods are a quality problem." };
      return { category: /order|deliver/i.test(item) ? "delivery" : "other", confidence: 0.7, reason: "By its words." };
    },
  },
  "coaching.propose": {
    structured: () => ({
      rules: ["Goods that arrive damaged are a quality problem, not a delivery question."],
      operations: [{ op: "add", path: "/workflow/0/categories/1/keywords", valueJson: '["damaged", "broken"]' }],
      explanation: "Damaged goods now go to quality.",
    }),
  },
});

describe("coaching over the API", () => {
  let t: TestApp;
  let taskRef: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const get = async (cookie: string, url: string) => t.app.inject({ url, headers: { cookie } });
  const post = async (cookie: string, url: string, payload: Record<string, unknown> = {}) =>
    t.app.inject({ method: "POST", url, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS, llm });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const service = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "customer-service")!;
    await t.platform.agents.create(company.id, {
      definition: {
        slug: "returns-desk",
        name: "Returns Desk",
        summary: "Sorts return emails.",
        archetype: "mail-triage",
        instructions: "You sort return emails.",
        inputs: [{ key: "body", type: "text", required: true }],
        outputs: [{ key: "category", label: "Category", type: "string" }],
        workflow: [
          {
            id: "classify",
            name: "Sort the email",
            type: "llm.classify",
            from: "{{ input.body }}",
            categories: [{ value: "delivery", label: "Delivery" }, { value: "quality", label: "Quality" }, { value: "other" }],
          },
          { id: "result", type: "output", value: { category: "{{ steps.classify.category }}" } },
        ],
        ui: { layout: "inbox", highlight: ["category"] },
      },
      status: "active",
      departmentId: service.id,
    });
    for (const body of ["My order SO-1 arrived damaged, the box was broken.", "When will order SO-2 be delivered?"]) {
      const run = await t.platform.engine.start(company.id, "returns-desk", { body }, { trigger: "mailbox", wait: true });
      taskRef ||= (await t.platform.tasks.byId(run.taskId!))!.ref;
    }
  });
  afterAll(() => t?.close());

  it("lets people of the department mark a finished task as wrong, and nobody else", async () => {
    const deniz = await as("deniz.aydin@acme.com.tr");
    const can = await as("can.demir@acme.com.tr");
    expect((await get(deniz, `/api/companies/acme/tasks/${taskRef}`)).json()).toMatchObject({ canCorrect: true, coaching: [] });
    expect((await post(can, `/api/companies/acme/tasks/${taskRef}/correct`, { note: "Wrong" })).statusCode).toBe(404);
    expect((await post(deniz, `/api/companies/acme/tasks/${taskRef}/correct`, { note: " " })).statusCode).toBe(400);

    const marked = await post(deniz, `/api/companies/acme/tasks/${taskRef}/correct`, {
      note: "It arrived damaged: that is a quality problem, not a delivery question.",
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().note).toMatchObject({ kind: "task", by: "Deniz Aydın", status: "open" });
    const detail = (await get(deniz, `/api/companies/acme/tasks/${taskRef}`)).json();
    expect(detail.coaching).toMatchObject([{ kind: "task", note: expect.stringMatching(/^It arrived damaged/), status: "open" }]);
    expect(detail.events.at(-1)).toMatchObject({ type: "corrected", actor: "Deniz Aydın" });
  });

  it("lets only the manager turn corrections into a new version, after the replay", async () => {
    const deniz = await as("deniz.aydin@acme.com.tr");
    const zeynep = await as("zeynep.kaya@acme.com.tr");
    expect((await get(deniz, "/api/companies/acme/agents/returns-desk/coaching")).json()).toMatchObject({
      canDecide: false,
      notes: [{ status: "open", taskRef }],
    });
    expect((await post(deniz, "/api/companies/acme/agents/returns-desk/coaching/proposals", { wait: true })).statusCode).toBe(403);

    const proposed = await post(zeynep, "/api/companies/acme/agents/returns-desk/coaching/proposals", { wait: true });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposal = proposed.json();
    expect(proposal).toMatchObject({ status: "ready", baseVersion: 1, rules: ["Goods that arrive damaged are a quality problem, not a delivery question."] });
    expect(proposal.replay.summary).toMatchObject({ total: 2, changed: 1, corrected: 1, correctedChanged: 1 });
    expect(proposal.replay.items[0]).toMatchObject({
      ref: taskRef,
      status: "changed",
      changes: [{ key: "category", before: "delivery", after: "quality", kind: "outcome" }],
    });

    const overview = (await get(zeynep, "/api/companies/acme/agents/returns-desk/coaching")).json();
    expect(overview).toMatchObject({ canDecide: true, llm: { available: true } });
    expect(overview.proposals[0].id).toBe(proposal.id);
    expect((await get(deniz, `/api/companies/acme/coaching/proposals/${proposal.id}`)).json()).toMatchObject({ canDecide: false, status: "ready" });

    expect((await post(deniz, `/api/companies/acme/coaching/proposals/${proposal.id}/publish`)).statusCode).toBe(403);
    const published = await post(zeynep, `/api/companies/acme/coaching/proposals/${proposal.id}/publish`);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ status: "published", publishedVersion: 2, decidedBy: "Zeynep Kaya" });
    expect((await post(zeynep, `/api/companies/acme/coaching/proposals/${proposal.id}/keep`)).statusCode).toBe(409);
    expect((await post(zeynep, "/api/companies/acme/agents/returns-desk/coaching/proposals", {})).statusCode).toBe(409);
    expect((await get(deniz, `/api/companies/acme/tasks/${taskRef}`)).json().coaching).toMatchObject([{ status: "applied", appliedVersion: 2 }]);
  });

  it("keeps other departments out of an AI employee's coaching", async () => {
    const ayse = await as("ayse.yilmaz@acme.com.tr");
    expect((await get(ayse, "/api/companies/acme/agents/returns-desk/coaching")).statusCode).toBe(404);
    expect((await post(ayse, "/api/companies/acme/agents/returns-desk/coaching/proposals", {})).statusCode).toBe(404);
  });
});
