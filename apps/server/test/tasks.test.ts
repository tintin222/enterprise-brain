import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Tasks over the API: people give their AI employees work, follow it as a task with its history, and
 * the managers of the department pause, resume and stop it. Others don't see it.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("tasks over the API", () => {
  let t: TestApp;
  let assistant: string;
  let chaser: string;
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));
  const get = async (cookie: string, url: string) => t.app.inject({ url, headers: { cookie } });
  const post = async (cookie: string, url: string, payload: Record<string, unknown> = {}) => t.app.inject({ method: "POST", url, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "finance")!;
    const collections = (await t.platform.agents.list(company.id)).find((a) => a.row.templateId === "finance.collections-agent")!;
    assistant = collections.row.slug;
    // A finance AI employee that asks and waits for the answer: a task that lasts.
    const created = await t.platform.agents.create(company.id, {
      definition: {
        slug: "po-chaser",
        name: "PO Chaser",
        summary: "Asks suppliers for delivery dates.",
        archetype: "process-automation",
        instructions: "Chase suppliers.",
        inputs: [{ key: "order", type: "string", required: true }],
        workflow: [
          { id: "ask", type: "mail.send", to: "orders@supplier.example", subject: "Delivery date for {{ input.order }}", body: "When?", requiresApproval: false },
          { id: "answer", type: "wait", for: "reply", days: 3 },
        ],
      },
      status: "active",
      departmentId: finance.id,
    });
    chaser = created.row.slug;
  });
  afterAll(() => t?.close());

  it("lets a worker give work in plain words, and shows it as a task with its history", async () => {
    const elif = await as("elif.arslan@acme.com.tr");
    const given = await post(elif, "/api/companies/acme/tasks", { agent: assistant, text: "List the invoices overdue more than 60 days", wait: true });
    expect(given.statusCode, given.body).toBe(200);
    const { task } = given.json();
    expect(task).toMatchObject({ title: "List the invoices overdue more than 60 days", requestedBy: "Elif Arslan", source: "request" });
    expect(task.ref).toMatch(/^EB-[2-9A-Z]{5}$/);

    const detail = (await get(elif, `/api/companies/acme/tasks/${task.ref}`)).json();
    expect(detail.task.status).toBe("done");
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(["created", "done"]);
    expect(detail.runs).toHaveLength(1);
    expect(detail.canManage).toBe(false);
    const list = (await get(elif, "/api/companies/acme/tasks?status=done")).json() as { ref: string; agent: { name: string } }[];
    expect(list.find((row) => row.ref === task.ref)?.agent.name).toBe("Collections Agent");
  });

  it("keeps other departments' tasks out of sight", async () => {
    const ayse = await as("ayse.yilmaz@acme.com.tr");
    const [task] = (await get(await as("burak.sahin@acme.com.tr"), "/api/companies/acme/tasks")).json() as { ref: string }[];
    expect((await get(ayse, `/api/companies/acme/tasks/${task!.ref}`)).statusCode).toBe(404);
    expect(((await get(ayse, "/api/companies/acme/tasks")).json() as unknown[]).length).toBe(0);
    expect((await post(ayse, "/api/companies/acme/tasks", { agent: assistant, text: "Anything" })).statusCode).toBe(404);
  });

  it("lets the manager pause, resume and stop a waiting task, but not a worker", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const elif = await as("elif.arslan@acme.com.tr");
    const companyId = (await t.platform.company("acme"))!.id;
    const run = await t.platform.engine.start(companyId, chaser, { order: "PO-4500040" });
    const task = await t.platform.tasks.get(companyId, run.taskId!);
    expect(task.status).toBe("waiting");

    expect((await post(elif, `/api/companies/acme/tasks/${task.ref}/pause`)).statusCode).toBe(403);
    const paused = await post(burak, `/api/companies/acme/tasks/${task.ref}/pause`);
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().status).toBe("paused");
    expect((await post(burak, `/api/companies/acme/tasks/${task.ref}/resume`)).json().status).toBe("waiting");
    expect((await post(burak, `/api/companies/acme/tasks/${task.ref}/stop`)).json().status).toBe("stopped");
    expect((await post(burak, `/api/companies/acme/tasks/${task.ref}/stop`)).statusCode).toBe(409);

    const detail = (await get(burak, `/api/companies/acme/tasks/${task.ref}`)).json();
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(["created", "waiting", "paused", "resumed", "stopped"]);
    expect(detail.mails[0].subject).toBe(`Delivery date for PO-4500040 [${task.ref}]`);
    expect(detail.canManage).toBe(true);
  });
});
