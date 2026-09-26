import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, type StructuredRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Gate 4 of phase 4, end to end over HTTP with people signed in: a quality manager asks for a supplier
 * complaints register in one sentence. The same day it is an app with its table, an AI employee files
 * complaints from email into it, and a monthly calculation ranks suppliers. Nobody sees a database, a
 * deployment or code. (Claude is scripted where it reads the emails; the rest is read from the words.)
 */

const base = "/api/companies/acme";
const text = (request: StructuredRequest) => request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

const llm = new ScriptedLlm({
  // Claude reading a complaint written in prose: the fields the register asks for.
  "runtime.extract": {
    structured: (request) => {
      const email = text(request);
      const keys = Object.keys((request.schema as { properties?: Record<string, unknown> }).properties ?? {});
      const found: Record<string, unknown> = {};
      for (const key of keys) {
        if (/supplier/.test(key)) found[key] = /Akın Metal|Demir Döküm|Yıldız Plastik/.exec(email)?.[0] ?? null;
        else if (/order/.test(key)) found[key] = /PO-\d+/.exec(email)?.[0] ?? null;
        else if (/problem/.test(key))
          found[key] = /cracked|crack/i.test(email) ? "Cracked flanges" : /bent/i.test(email) ? "Bent frames" : "Wrong paint colour";
        else found[key] = null;
      }
      return found;
    },
  },
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const EMAILS = [
  {
    subject: "Cracked flanges again",
    body: "Hello,\n\nThe flanges Akın Metal delivered on order PO-4500012 are cracked, twelve of forty in lot 7. Production is using the old stock.\n\nKerem",
  },
  {
    subject: "Bent frames from Akın Metal",
    body: "Hi, the frames on PO-4500031 came in bent; Akın Metal's driver said the pallets shifted on the road. Photos to follow.",
  },
  {
    subject: "Paint colour wrong",
    body: "Demir Döküm painted the housings on order PO-4500040 in RAL 7035 instead of RAL 7016. We can't ship them like this.",
  },
];

describe("gate 4: a supplier complaints register, from one sentence to a monthly ranking", () => {
  let t: TestApp;
  let companyId = "";
  let selin = "";
  let kerem = "";
  let mehmet = "";
  let operations = "";
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url: `${base}${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const as = async (address: string) => cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: address } }));
    selin = await as("selin.acar@acme.com.tr");
    kerem = await as("kerem.yildiz@acme.com.tr");
    mehmet = await as("mehmet.oz@acme.com.tr");
    operations = (await t.platform.catalog.departments(company.id)).find((d) => d.key === "operations")!.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("goes from one sentence to an app with its table, an AI employee filing emails into it, and a monthly ranking", async () => {
    // 1. One sentence in "What do you need?": an app, with its table.
    const asked = (
      await call(selin, "POST", "/needs", {
        text: "I need a supplier complaints register: supplier, order number, problem, status (open, in progress, closed), received on",
      })
    ).json() as { kind: string; description: string; can: { build: boolean } };
    expect(asked).toMatchObject({ kind: "app", can: { build: true } });
    const proposal = (await call(selin, "POST", "/apps/propose", { description: asked.description })).json() as {
      design: Record<string, unknown>;
      tables: { key: string; fields: { key: string; label: string; type: string }[] }[];
      outline: { title: string; blocks: string[] }[];
    };
    expect(proposal.tables).toHaveLength(1);
    const made = await call(selin, "POST", "/apps", { ...proposal.design, departmentId: operations, tables: proposal.tables });
    expect(made.statusCode, made.body).toBe(200);
    const app = made.json() as { key: string; madeTables: string[] };
    const tableKey = app.madeTables[0]!;
    expect(tableKey).toBe("supplier_complaints");
    const table = (await call(selin, "GET", `/tables/${tableKey}`)).json() as { name: string; fields: { key: string; label: string; type: string }[] };
    expect(table.fields.map((f) => [f.label, f.type])).toEqual([
      ["Supplier", "text"],
      ["Order number", "text"],
      ["Problem", "text"],
      ["Status", "choice"],
      ["Received on", "date"],
    ]);

    // 2. An AI employee files each emailed complaint into it: one answer, the mailbox.
    const filing = (
      await call(selin, "POST", "/needs", {
        text: "File the supplier complaints that come in by email to quality@acme.com.tr into Supplier complaints",
      })
    ).json() as { kind: string; intake: { table: { key: string }; mailbox: string; can: boolean } };
    expect(filing).toMatchObject({ kind: "ai-employee", intake: { table: { key: tableKey }, mailbox: "quality@acme.com.tr", can: true } });
    const job = (await call(selin, "POST", `/tables/${tableKey}/intake`, { mailbox: filing.intake.mailbox, dryRun: true })).json() as {
      name: string;
      job: { duty: string; picks: string[]; takes: string[]; startsAs: string[]; levelText: string };
    };
    expect(job).toMatchObject({
      name: "Supplier Complaints Clerk",
      job: {
        duty: "Reads every email sent to quality@acme.com.tr, and adds each one to Supplier complaints",
        picks: ["Supplier", "Order number", "Problem"],
        takes: ["Received on: the day the email came"],
        startsAs: ["Status starts as Open"],
        levelText: "At first, a person approves each record it adds",
      },
    });
    // Only the department's managers hire.
    expect((await call(kerem, "POST", `/tables/${tableKey}/intake`, { mailbox: "quality@acme.com.tr" })).statusCode).toBe(403);
    const hired = (await call(selin, "POST", `/tables/${tableKey}/intake`, { mailbox: "quality@acme.com.tr" })).json() as {
      agent: { slug: string; status: string };
    };
    expect(hired.agent).toMatchObject({ slug: "supplier-complaints-clerk", status: "testing" });
    expect((await call(selin, "POST", `/agents/${hired.agent.slug}/status`, { status: "active" })).statusCode).toBe(200);

    // Complaints arrive by email; nobody starts anything.
    for (const email of EMAILS) {
      const sent = await call(mehmet, "POST", "/mail/messages", {
        mailbox: "quality@acme.com.tr",
        from: "kerem.yildiz@acme.com.tr",
        fromName: "Kerem Yıldız",
        ...email,
        route: true,
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect((sent.json() as { runs: unknown[] }).runs).toHaveLength(1);
    }
    // Supervised at first: the quality engineer approves each record, in one click.
    const pending = await until(
      async () => (await call(kerem, "GET", "/approvals?status=pending")).json() as { id: string; title: string; agentName: string }[],
      (list) => list.length === 3,
      "three approvals",
    );
    expect(pending.map((a) => a.agentName)).toEqual(["Supplier Complaints Clerk", "Supplier Complaints Clerk", "Supplier Complaints Clerk"]);
    for (const approval of pending) expect((await call(kerem, "POST", `/approvals/${approval.id}/decide`, { approved: true })).statusCode).toBe(200);
    const filed = await until(
      async () =>
        (await call(kerem, "GET", `/tables/${tableKey}/records?sort=number&direction=asc`)).json() as {
          total: number;
          records: { number: number; values: Record<string, unknown>; createdBy: string }[];
        },
      (page) => page.total === 3,
      "three records",
    );
    // Numbered as they were approved; by order number here.
    const byOrder = [...filed.records].sort((a, b) => String(a.values.order_number).localeCompare(String(b.values.order_number)));
    expect(byOrder.map((r) => [r.values.supplier, r.values.order_number, r.values.problem, r.values.status])).toEqual([
      ["Akın Metal", "PO-4500012", "Cracked flanges", "Open"],
      ["Akın Metal", "PO-4500031", "Bent frames", "Open"],
      ["Demir Döküm", "PO-4500040", "Wrong paint colour", "Open"],
    ]);
    const receivedOn = String(filed.records[0]!.values.received_on);
    expect(receivedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const history = (await call(kerem, "GET", `/tables/${tableKey}/records/1`)).json() as { history: { action: string; by: string; ai: boolean }[] };
    expect(history.history[0]).toMatchObject({ action: "created", by: "Supplier Complaints Clerk", ai: true });

    // 3. A monthly calculation ranks suppliers.
    const ranking = (await call(selin, "POST", "/needs", { text: "Every month, rank suppliers by complaints" })).json() as {
      kind: string;
      description: string;
      schedule: { every: string };
    };
    expect(ranking).toMatchObject({ kind: "calculation", description: "Rank suppliers by complaints last month", schedule: { every: "month" } });
    const written = (await call(selin, "POST", "/calculations/write", { rule: ranking.description })).json() as {
      draft: Record<string, unknown> & { explanation: string };
      trial: { ok: boolean };
    };
    expect(written.trial.ok).toBe(true);
    const kept = (
      await call(selin, "POST", "/calculations", { ...written.draft, rule: ranking.description, schedule: "monthly", departmentId: operations })
    ).json() as {
      key: string;
      schedule: string;
    };
    expect(kept.schedule).toBe("monthly");
    // On the 1st of the next month, at 07:00 in Istanbul, it works itself out on last month's complaints.
    const [year, month] = receivedOn.split("-").map(Number) as [number, number];
    const firstOfNext = new Date(Date.UTC(year, month, 1, 4, 0));
    const runs = await t.platform.calculations.runDue(firstOfNext);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "schedule",
      status: "succeeded",
      result: [
        { rank: 1, supplier: "Akın Metal", complaints: 2 },
        { rank: 2, supplier: "Demir Döküm", complaints: 1 },
      ],
    });

    // 4. Nobody saw a database, a deployment or code: what the quality manager gets is words, pages and results.
    const detail = (await call(selin, "GET", `/calculations/${kept.key}`)).json() as Record<string, unknown>;
    expect(detail).not.toHaveProperty("code");
    const seen = JSON.stringify([asked, proposal.outline, filing, job, ranking, detail, (await call(selin, "GET", `/apps/${app.key}`)).json()]);
    expect(seen).not.toMatch(/SELECT |CREATE TABLE|function calculate|return tables|docker|deploy/i);
    // IT sees all of it, with its owner.
    const built = (await call(mehmet, "GET", "/built")).json() as { items: { type: string; name: string; owner: string }[] };
    expect(built.items.filter((i) => i.owner === "Selin Acar").map((i) => [i.type, i.name])).toEqual(
      expect.arrayContaining([
        ["table", "Supplier complaints"],
        ["app", expect.any(String)],
        ["calculation", expect.any(String)],
        ["ai-employee", "Supplier Complaints Clerk"],
      ]),
    );
  });
});
