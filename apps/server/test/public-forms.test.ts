import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, multipart, type TestApp } from "./helpers.ts";

/**
 * An AI employee's public form: its managers see its link (and its webhook address, with a secret shown
 * once); anyone with the link reads the form and sends it, a file included, and gets the task's
 * reference; bots that fill in the hidden field start nothing; a form that asks for sign-in takes only
 * the company's people; a form turned off is not there.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

describe("public forms", () => {
  let t: TestApp;
  let token = "";
  const as = async (email: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email } }));

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "finance")!;
    await t.platform.agents.create(company.id, {
      definition: {
        slug: "quotes",
        name: "Quote Desk",
        summary: "Answers requests for a quote.",
        archetype: "process-automation",
        instructions: "Prepare the quote.",
        inputs: [
          { key: "customer", type: "string", label: "Your company", required: true },
          { key: "quantity", type: "number" },
          { key: "drawing", type: "file" },
        ],
        triggers: [
          { type: "form", public: { enabled: true, title: "Ask for a quote", intro: "We answer within a day.", thanks: "Thanks! We'll write to you." } },
        ],
        workflow: [{ id: "result", type: "output", value: { customer: "{{ input.customer }}", quantity: "{{ input.quantity }}" } }],
      },
      status: "active",
      departmentId: finance.id,
    });
  });
  afterAll(() => t?.close());

  it("shows its managers the form's link, and the webhook address with a secret shown once", async () => {
    const burak = await as("burak.sahin@acme.com.tr");
    const addresses = (await t.app.inject({ url: "/api/companies/acme/agents/quotes/endpoints", headers: { cookie: burak } })).json();
    expect(addresses.webhook).toBeNull();
    expect(addresses.form).toMatchObject({ status: "on", url: expect.stringMatching(/^http:\/\/brain\.test\/f\/[\w-]{40,}$/) });
    token = addresses.form.url.split("/").at(-1);
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await t.app.inject({ url: "/api/companies/acme/agents/quotes/endpoints", headers: { cookie: elif } })).statusCode).toBe(403);

    // Called by other systems too: the address is there with its duty; the secret only when made, and once.
    const agent = await t.platform.agents.get(t.companyId, "quotes");
    await t.platform.agents.update(t.companyId, "quotes", { ...agent.definition, triggers: [...agent.definition.triggers, { type: "webhook" }] });
    const withHook = (await t.app.inject({ url: "/api/companies/acme/agents/quotes/endpoints", headers: { cookie: burak } })).json();
    expect(withHook.webhook).toMatchObject({ hasSecret: false, readableUrl: "http://brain.test/api/hooks/acme/quotes" });
    const made = await t.app.inject({ method: "POST", url: "/api/companies/acme/agents/quotes/endpoints/webhook/secret", headers: { cookie: burak } });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json()).toMatchObject({ secret: expect.stringMatching(/^[\w-]{40,}$/), webhook: { hasSecret: true } });
    const again = (await t.app.inject({ url: "/api/companies/acme/agents/quotes/endpoints", headers: { cookie: burak } })).json();
    expect(again.webhook.hasSecret).toBe(true);
    expect(JSON.stringify(again)).not.toContain(made.json().secret);
  });

  it("lets anyone with the link send it, a file included, and gives back the task's reference", async () => {
    const form = await t.app.inject({ url: `/api/public/forms/${token}` });
    expect(form.statusCode, form.body).toBe(200);
    expect(form.json()).toMatchObject({ title: "Ask for a quote", intro: "We answer within a day.", signIn: false, agent: { name: "Quote Desk" } });
    expect(form.json().fields.map((f: { key: string }) => f.key)).toEqual(["customer", "quantity", "drawing"]);

    const body = multipart({ customer: "Petrokim", quantity: "12", email: "buyer@petrokim.example" }, [
      { field: "drawing", name: "part.pdf", data: Buffer.from("%PDF-1.4 drawing"), type: "application/pdf" },
    ]);
    const sent = await t.app.inject({ method: "POST", url: `/api/public/forms/${token}`, ...body });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ ok: true, taskRef: expect.stringMatching(/^EB-/), thanks: "Thanks! We'll write to you." });
    const task = await t.platform.tasks.get(t.companyId, sent.json().taskRef);
    expect(task).toMatchObject({ source: "form", requestedBy: "buyer@petrokim.example" });
    const [run] = await t.platform.tasks.runsOf(task.id);
    expect(run!.input).toMatchObject({ customer: "Petrokim", quantity: 12, drawing: expect.any(String) });

    // A bot fills in the field people never see: it hears it worked, and nothing starts.
    const before = (await t.platform.tasks.list(t.companyId)).length;
    const bot = await t.app.inject({
      method: "POST",
      url: `/api/public/forms/${token}`,
      payload: { input: { customer: "Spam" }, website: "http://spam.example" },
    });
    expect(bot.json()).toMatchObject({ ok: true, taskRef: null });
    expect((await t.platform.tasks.list(t.companyId)).length).toBe(before);
  });

  it("takes only the company's people when it asks for sign-in, and is not there when turned off", async () => {
    const agent = await t.platform.agents.get(t.companyId, "quotes");
    await t.platform.agents.update(t.companyId, "quotes", {
      ...agent.definition,
      triggers: agent.definition.triggers.map((tr) => (tr.type === "form" ? { ...tr, public: { ...tr.public!, signIn: true } } : tr)),
    });
    const anonymous = await t.app.inject({ method: "POST", url: `/api/public/forms/${token}`, payload: { input: { customer: "Hansa" } } });
    expect(anonymous.statusCode).toBe(401);
    const elif = await as("elif.arslan@acme.com.tr");
    expect((await t.app.inject({ url: `/api/public/forms/${token}`, headers: { cookie: elif } })).json()).toMatchObject({
      signIn: true,
      viewer: { name: "Elif Arslan" },
    });
    const signed = await t.app.inject({
      method: "POST",
      url: `/api/public/forms/${token}`,
      headers: { cookie: elif },
      payload: { input: { customer: "Hansa" } },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await t.platform.tasks.get(t.companyId, signed.json().taskRef)).requestedBy).toBe("Elif Arslan");

    const burak = await as("burak.sahin@acme.com.tr");
    const off = await t.app.inject({
      method: "PUT",
      url: "/api/companies/acme/agents/quotes/endpoints/form/status",
      headers: { cookie: burak },
      payload: { status: "off" },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await t.app.inject({ url: `/api/public/forms/${token}` })).statusCode).toBe(404);
  });
});
