import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BUILDING_GUIDANCE, COMPANY_GUIDANCE } from "@enterprise-brain/brain";
import { studioThreads } from "@enterprise-brain/db";
import { ScriptedLlm, type StructuredRequest, type ToolLoopRequest } from "@enterprise-brain/llm";
import { buildTools } from "@enterprise-brain/runtime";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The company brain, over HTTP with people signed in: IT fills it from the demo sources, everyone
 * reads and asks it, managers shape it, anyone keeps know-how, each reading brings what changed, and
 * the assistant, AI employees and the Studio look things up in it.
 */

const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Thing {
  id: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
  origins: Record<string, string>;
  links: { label: string; relation: string; detail: string; other: { id: string; name: string; kind: string } }[];
  events: { title: string; kind: string; origin: string }[];
}

async function signIn(t: TestApp, people: string[]): Promise<Record<string, string>> {
  const as: Record<string, string> = {};
  for (const local of people) as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
  return as;
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the company brain", () => {
  let t: TestApp;
  let as: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const thing = async (name: string, kind: string): Promise<Thing> => {
    const hits = (await call("deniz.aydin", "GET", `/brain/search?q=${encodeURIComponent(name)}&kinds=${kind}`)).json() as { id: string; name: string }[];
    const hit = hits.find((h) => h.name === name) ?? hits[0];
    if (!hit) throw new Error(`${kind} ${name} not found`);
    return (await call("deniz.aydin", "GET", `/brain/entities/${hit.id}`)).json() as Thing;
  };
  const linked = (entity: Thing, label: string) =>
    entity.links.filter((l) => l.label === label).map((l) => (l.detail ? `${l.other.name} (${l.detail})` : l.other.name));

  beforeAll(async () => {
    t = await createTestApp({ config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    as = await signIn(t, ["mehmet.oz", "selin.acar", "deniz.aydin"]);
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it("is empty until IT fills it, and fills it from every source in an order where each finds the others", async () => {
    expect(((await call("deniz.aydin", "GET", "/brain/overview")).json() as { total: number }).total).toBe(0);
    expect((await call("deniz.aydin", "POST", "/brain/sources/sync-all")).statusCode).toBe(403);
    const filled = await call("mehmet.oz", "POST", "/brain/sources/sync-all");
    expect(filled.statusCode, filled.body).toBe(200);
    const { results, sources } = filled.json() as {
      results: Record<string, { added: number; events: number; skipped: string[] }>;
      sources: { key: string; status: string }[];
    };
    expect(sources.every((s) => s.status === "connected")).toBe(true);
    // Nothing waits for a thing another source brings.
    for (const [key, result] of Object.entries(results))
      expect(
        result.skipped.filter((s) => s.endsWith("not in the brain")),
        key,
      ).toEqual([]);
    expect(results.teams?.events).toBe(22);
    const overview = (await call("deniz.aydin", "GET", "/brain/overview")).json() as { counts: Record<string, number>; company: { name: string } };
    expect(overview.company.name).toBe("Acme Endüstri A.Ş.");
    expect(overview.counts).toMatchObject({ person: 29, system: 19, database: 5, client: 15, project: 9, policy: 5, site: 3, data_table: 31, report: 13 });
    expect(overview.counts.process).toBeGreaterThanOrEqual(18);
  });

  it("knows who does what, who knows what, and who is responsible", async () => {
    const complaints = await thing("Customer complaints and 8D", "process");
    expect(linked(complaints, "Who knows it").sort()).toEqual(["Kerem Yıldız (Expert)", "Merve Aksoy (Can do it)", "Selin Acar (Expert)"]);
    expect(linked(complaints, "Owner")).toEqual(expect.arrayContaining(["Selin Acar", "Operations"]));
    expect(linked(complaints, "Uses")).toEqual(expect.arrayContaining(["Opcenter MES", "Salesforce", "SAP S/4HANA"]));
    expect((complaints.data.steps as { name: string; who: string }[]).map((s) => s.who)).toContain("Kerem Yıldız");
    const kerem = await thing("Kerem Yıldız", "person");
    expect(kerem.data).toMatchObject({ title: "Quality Engineer", email: "kerem.yildiz@acme.com.tr" });
    expect(linked(kerem, "Reports to")).toEqual(["Selin Acar"]);
    expect(linked(kerem, "Works on")).toContain("Petrokim ACP-80 vibration fix (8D report)");
    // The title is the HR system's, though the app knew it first.
    expect(kerem.origins["data.title"]).toBe("hr");
  });

  it("knows the IT landscape: what each system is for, its APIs, its databases and their tables", async () => {
    const sap = await thing("SAP S/4HANA", "system");
    const apis = sap.data.apis as { name: string; endpoints: string[] }[];
    expect(apis[0]!.endpoints).toContain("POST API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice — post a supplier invoice");
    expect(linked(sap, "Keeps its data in")).toEqual(["S4P (SAP HANA)"]);
    expect(sap.data.connection).toBe("AI employees use the demo ERP until IT connects SAP S/4HANA");
    const mes = await thing("MES_PROD (SQL Server)", "database");
    expect(mes.data.connectable).toBe("Read-only");
    // Each table is a thing of its own, with what its columns mean.
    expect(linked(mes, "Tables")).toContain("test_results");
    const tests = await thing("test_results", "data_table");
    expect((tests.data.columns as { name: string; definition: string }[]).find((c) => c.name === "vibration_mm_s")?.definition).toBe(
      "Above 4.5 fails (ISO 10816).",
    );
    const mail = await thing("Exchange Online", "system");
    expect(mail.data.category).toBe("Mail");
  });

  it("follows clients and current work, and each reading brings what changed", async () => {
    const petrokim = await thing("Petrokim Rafineri A.Ş.", "client");
    expect(petrokim.data.open_invoices).toMatch(/disputed/);
    expect(linked(petrokim, "Work for this client")).toEqual(
      expect.arrayContaining(["Petrokim ACP-80 vibration fix", "ACP-80 pumps: excessive vibration after 200 operating hours"]),
    );
    const overview = (await call("deniz.aydin", "GET", "/brain/overview")).json() as { attention: { title: string }[]; gaps: { title: string }[] };
    expect(overview.attention.map((a) => a.title)).toEqual(
      expect.arrayContaining(["Petrokim ACP-80 vibration fix is at risk", "Urgent customer issue from Petrokim Rafineri A.Ş."]),
    );
    expect(overview.gaps.map((g) => g.title)).toContain("Only Hande Özkan knows Monthly consolidation and management report, and they are on leave");

    const projects = (await call("mehmet.oz", "POST", "/brain/sources/projects/sync")).json() as { result: { changes: number; added: number } };
    expect(projects.result).toMatchObject({ added: 1 });
    expect(projects.result.changes).toBeGreaterThan(0);
    const teams = (await call("mehmet.oz", "POST", "/brain/sources/teams/sync")).json() as { result: { events: number } };
    expect(teams.result.events).toBe(5);
    const fix = await thing("Petrokim ACP-80 vibration fix", "project");
    const titles = fix.events.map((e) => e.title);
    expect(titles).toContain("Petrokim ACP-80 vibration fix: progress 45% → 65%");
    expect(titles.some((title) => title.startsWith("Couplings arrived."))).toBe(true);
  });

  it("keeps what managers write over what the sources bring; workers keep know-how and notes", async () => {
    const fix = await thing("Petrokim ACP-80 vibration fix", "project");
    expect((await call("deniz.aydin", "PATCH", `/brain/entities/${fix.id}`, { data: { health: "On track" } })).statusCode).toBe(403);
    const changed = await call("selin.acar", "PATCH", `/brain/entities/${fix.id}`, { data: { health: "Off track" } });
    expect(changed.statusCode, changed.body).toBe(200);
    await call("mehmet.oz", "POST", "/brain/sources/projects/sync");
    const after = await thing("Petrokim ACP-80 vibration fix", "project");
    expect(after.data.health).toBe("Off track");
    expect(after.events.some((e) => e.title === "Petrokim ACP-80 vibration fix: health At risk → Off track")).toBe(true);

    expect((await call("deniz.aydin", "POST", "/brain/entities", { kind: "system", name: "Shadow IT" })).statusCode).toBe(403);
    const note = await call("deniz.aydin", "POST", "/brain/events", { kind: "note", title: "Petrokim asked for a status call on Friday", about: [fix.id] });
    expect(note.json()).toMatchObject({ actor: "Deniz Aydın", about: [{ name: "Petrokim ACP-80 vibration fix" }] });

    // Without a model, what someone tells the brain is kept as know-how about what they were looking at.
    const process = await thing("Customer emails", "process");
    const proposal = (
      await call("deniz.aydin", "POST", "/brain/learn", { text: "Hansa Pumpen wants every answer in German. Use the German templates.", about: process.id })
    ).json() as { offline: boolean; changes: unknown[] };
    expect(proposal).toMatchObject({
      offline: true,
      changes: [{ type: "knowhow", name: "Hansa Pumpen wants every answer in German.", about: [{ id: process.id }] }],
    });
    const kept = (await call("deniz.aydin", "POST", "/brain/learn/apply", { changes: proposal.changes })).json() as { done: string[]; ids: string[] };
    expect(kept.done).toEqual(['Kept know-how "Hansa Pumpen wants every answer in German."']);
    const knowhow = (await call("deniz.aydin", "GET", `/brain/entities/${kept.ids[0]}`)).json() as Thing;
    expect(linked(knowhow, "About")).toEqual(["Customer emails"]);
    expect(linked(knowhow, "From")).toEqual(["Deniz Aydın"]);
  });

  it("is taught in Chat: a card says what it would keep, the teacher keeps it with their own rights, and nobody answers it", async () => {
    type Card = {
      type: string;
      status: string;
      canKeep: boolean;
      mayEdit: boolean;
      offline: boolean;
      changes: { type: string; name: string; about: { id: string }[] }[];
      result: { done: string[] } | null;
    };
    type Msg = {
      id: string;
      kind: string;
      author: { kind: string; name: string };
      text: string;
      data: Record<string, unknown>;
      card: Card | null;
      mentions: { kind: string; id: string; href: string | null }[];
    };
    const process = await thing("Customer complaints and 8D", "process");
    const client = await thing("Gulf Water", "client");
    const about = (await call("deniz.aydin", "GET", `/conversations/for/thing/${process.id}`)).json() as {
      conversation: { id: string };
      offers: { teach: boolean };
      about: { href: string; label: string } | null;
    };
    expect(about.offers.teach).toBe(true);
    // The conversation leads to the thing's page, in the Studio's brain.
    expect(about.about).toEqual({ href: `/studio/brain/e/${process.id}`, label: "Customer complaints and 8D" });
    const id = about.conversation.id;
    const text = `@[Gulf Water](thing:${client.id}) always asks for the test certificates in English and Arabic.`;
    expect((await call("deniz.aydin", "POST", `/conversations/${id}/messages`, { text, intent: "teach", fileIds: ["a-file"] })).statusCode).toBe(400);
    const taught = await call("deniz.aydin", "POST", `/conversations/${id}/messages`, { text, intent: "teach" });
    expect(taught.statusCode, taught.body).toBe(200);
    expect((taught.json() as Msg).data.intent).toBe("teach");
    expect((taught.json() as Msg).mentions).toMatchObject([{ kind: "thing", id: client.id, href: `/studio/brain/e/${client.id}` }]);
    const list = async (who: string) => (await call(who, "GET", `/conversations/${id}/messages`)).json() as Msg[];
    const card = await until(async () => (await list("deniz.aydin")).find((m) => m.card?.type === "learning"), "the learning card");
    expect(card.author.name).toBe("Company brain");
    expect(card.card).toMatchObject({ status: "open", canKeep: true, mayEdit: false, offline: true });
    // Without a model the words are kept as know-how, about the process and what was named.
    expect(card.card!.changes).toMatchObject([{ type: "knowhow", name: "Gulf Water always asks for the test certificates in English and Arabic." }]);
    expect(card.card!.changes[0]!.about.map((a) => a.id).sort()).toEqual([process.id, client.id].sort());
    // Someone else sees it, but only the teacher keeps it.
    const others = (await list("mehmet.oz")).find((m) => m.id === card.id)!;
    expect(others.card).toMatchObject({ canKeep: false, mayEdit: true });
    expect((await call("mehmet.oz", "POST", `/conversations/${id}/messages/${card.id}/learn`, { keep: [0] })).statusCode).toBe(403);
    const kept = await call("deniz.aydin", "POST", `/conversations/${id}/messages/${card.id}/learn`, { keep: [0] });
    expect(kept.statusCode, kept.body).toBe(200);
    expect((kept.json() as Msg).card).toMatchObject({
      status: "kept",
      canKeep: false,
      result: { done: ['Kept know-how "Gulf Water always asks for the test certificates in English and Arabic."'] },
    });
    expect((await call("deniz.aydin", "POST", `/conversations/${id}/messages/${card.id}/learn`, { keep: [0] })).statusCode).toBe(409);
    // Nobody answered the words themselves, and they are no message on the process's timeline.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await list("deniz.aydin")).filter((m) => m.kind === "text" && m.author.kind === "ai_employee")).toEqual([]);
    expect((await thing("Customer complaints and 8D", "process")).events.some((e) => e.kind === "message" && /Deniz/.test(e.title))).toBe(false);
    // Teaching happens in the brain's talk and in a thing's conversation, not in a topic.
    const topic = (await call("deniz.aydin", "POST", "/conversations", { title: "Certificates" })).json() as {
      conversation: { id: string };
      offers: { teach: boolean };
    };
    expect(topic.offers.teach).toBe(false);
    expect((await call("deniz.aydin", "POST", `/conversations/${topic.conversation.id}/messages`, { text, intent: "teach" })).statusCode).toBe(400);
  });

  it("answers questions from the brain, also without a model", async () => {
    const talk = (await call("deniz.aydin", "GET", "/conversations/for/ai_employee/company-brain")).json() as { conversation: { id: string } };
    const posted = await call("deniz.aydin", "POST", `/conversations/${talk.conversation.id}/messages`, { text: "Who knows the 8D complaint process?" });
    expect(posted.statusCode, posted.body).toBe(200);
    const answer = await until(
      async () =>
        ((await call("deniz.aydin", "GET", `/conversations/${talk.conversation.id}/messages`)).json() as { author: { kind: string }; text: string }[]).find(
          (m) => m.author.kind === "ai_employee",
        ),
      "the brain's answer",
    );
    expect(answer.text).toMatch(/\[Customer complaints and 8D\]\(\/studio\/brain\/e\/[0-9a-f-]{36}\)/);
    expect(answer.text).toMatch(/\*\*Who knows it:\*\* .*Kerem Yıldız/);
  });

  it("lists a person or an AI employee once in the @ picker: the one that reaches them, not the brain's copy", async () => {
    type Hit = { kind: string; id: string; name: string; href: string | null };
    const hitsOf = async (query: string, name: string) => ((await call("mehmet.oz", "GET", `/mention${query}`)).json() as Hit[]).filter((h) => h.name === name);
    const kindsOf = async (query: string, name: string) => (await hitsOf(query, name)).map((h) => h.kind);
    expect(await kindsOf("?q=Invoice%20Processor", "Invoice Processor")).toEqual(["ai_employee"]);
    expect(await kindsOf("?q=Burak", "Burak Şahin")).toEqual(["person"]);
    // Asked for things of the brain only, its copy is what there is, linked to its page in the Studio's brain.
    const [copy] = await hitsOf("?q=Invoice%20Processor&kinds=thing", "Invoice Processor");
    expect(copy).toMatchObject({ kind: "thing", href: `/studio/brain/e/${copy!.id}` });
  });
});

describe("Claude with the company brain", () => {
  let t: TestApp;
  let as: Record<string, string> = {};
  const seen: Record<string, string[]> = {};
  let assistantSystem = "";
  let assistantTools: string[] = [];

  const llm = new ScriptedLlm({
    "runtime.agent:company-brain.turn": {
      tools: (request: ToolLoopRequest, turn: number, results: string[]) => {
        assistantSystem = request.system ?? "";
        assistantTools = request.tools.map((tool) => tool.name);
        seen.chat = results;
        if (turn === 1) return { calls: [{ name: "company_search", input: { query: "8D" } }] };
        if (turn === 2) return { calls: [{ name: "company_open", input: { id_or_name: "Customer complaints and 8D" } }] };
        return { text: "Kerem Yıldız and Selin Acar know it best." };
      },
    },
    "studio.agent": {
      tools: (_request: ToolLoopRequest, turn: number, results: string[]) => {
        seen.studio = results;
        if (turn === 1) return { calls: [{ name: "company_search", input: { query: "invoice" } }] };
        if (turn === 2) return { calls: [{ name: "company_open", input: { id_or_name: "Supplier invoice processing" } }] };
        return { text: "The brain says Elif Arslan checks and posts invoices in SAP, and Burak Şahin approves the exceptions." };
      },
    },
    "brain.learn": {
      structured: (request: StructuredRequest) => {
        seen.learn = [JSON.stringify(request.messages)];
        return {
          understood: "Burak Şahin can now do the consolidation.",
          changes: [
            {
              type: "link",
              kind: "person",
              id: "",
              name: "Burak Şahin",
              summary: "",
              fields: [],
              relation: "knows",
              to: { id: "", name: "Monthly consolidation and management report", kind: "process" },
              detail: "Can do it",
              about: [],
              why: "Burak rebuilt it with Selin",
            },
            {
              type: "knowhow",
              kind: "knowhow",
              id: "",
              name: "Hande's notes for the consolidation are on SharePoint › Finance",
              summary: "",
              fields: [{ key: "details", value: "Start from the notes, then the mapping workbook." }],
              relation: "",
              to: { id: "", name: "", kind: "" },
              detail: "",
              about: [{ id: "", name: "Monthly consolidation and management report" }],
              why: "From her notes",
            },
          ],
        };
      },
    },
  });

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    await seedDemoPeople(t.platform, (await t.platform.company("acme"))!);
    as = await signIn(t, ["mehmet.oz", "burak.sahin"]);
    await t.platform.brainSources.syncAll(t.companyId);
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it("gives the company brain the brain's tools and how to use them", async () => {
    const talk = (await t.app.inject({ url: `${base}/conversations/for/ai_employee/company-brain`, headers: { cookie: as["burak.sahin"]! } })).json() as {
      conversation: { id: string };
    };
    const posted = await t.app.inject({
      method: "POST",
      url: `${base}/conversations/${talk.conversation.id}/messages`,
      headers: { cookie: as["burak.sahin"]! },
      payload: { text: "Who knows the 8D process?" },
    });
    expect(posted.statusCode, posted.body).toBe(200);
    const answer = await until(
      async () =>
        (
          (await t.app.inject({ url: `${base}/conversations/${talk.conversation.id}/messages`, headers: { cookie: as["burak.sahin"]! } })).json() as {
            author: { kind: string };
            text: string;
          }[]
        ).find((m) => m.author.kind === "ai_employee"),
      "the brain's answer",
    );
    expect(answer.text).toBe("Kerem Yıldız and Selin Acar know it best.");
    expect(assistantTools).toEqual(expect.arrayContaining(["knowledge_search", "company_search", "company_open", "company_list", "company_activity"]));
    expect(assistantSystem).toContain(COMPANY_GUIDANCE);
    expect(seen.chat?.[0]).toMatch(/\[Customer complaints and 8D\]\(\/studio\/brain\/e\//);
    expect(seen.chat?.[1]).toContain("- Who knows it: ");
  });

  it("gives AI employees with the company ability the same tools", async () => {
    const scope = { companyId: t.companyId, agentId: "test", definition: { ...(await t.platform.agents.list(t.companyId))[0]!.definition }, citations: [] };
    const { tools } = await buildTools(t.platform.engine.toolDeps, scope, ["company.lookup"]);
    expect(tools.map((tool) => tool.definition.name)).toEqual(["company_search", "company_open", "company_list", "company_activity"]);
    const activity = await tools.find((tool) => tool.definition.name === "company_activity")!.execute({ about: "Petrokim ACP-80 vibration fix", days: 30 });
    expect(activity.content).toContain("Root cause agreed with Petrokim");
  });

  it("lets the Studio look up how the work is really done before it builds", async () => {
    const started = await t.app.inject({
      method: "POST",
      url: `${base}/studio/threads`,
      headers: { cookie: as["burak.sahin"]! },
      payload: { text: "I need help with the supplier invoices" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { id } = started.json() as { id: string };
    let view: { status: string; events: { kind: string; data: Record<string, unknown> }[] } | undefined;
    for (let i = 0; i < 50; i++) {
      view = (await t.app.inject({ method: "GET", url: `${base}/studio/threads/${id}`, headers: { cookie: as["burak.sahin"]! } })).json();
      if (view?.status !== "working") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const steps = view!.events.filter((e) => e.kind === "step").map((e) => e.data.text);
    expect(steps).toEqual(['Looked up "invoice" in the company brain', "Read about Supplier invoice processing in the company brain"]);
    expect(seen.studio?.[1]).toContain("1. Receive — Invoice Processor (AI) (in Exchange Online)");
    const [row] = await t.platform.handle.db.select().from(studioThreads).where(eq(studioThreads.id, id));
    expect(row!.setup.system).toContain(BUILDING_GUIDANCE);
    expect((row!.setup.tools as { name: string }[]).map((tool) => tool.name)).toContain("company_open");
  });

  it("turns what someone tells it into links and know-how they choose, so know-how doesn't sit with one person", async () => {
    const before = (await t.app.inject({ method: "GET", url: `${base}/brain/overview`, headers: { cookie: as["burak.sahin"]! } })).json() as {
      gaps: { title: string }[];
    };
    expect(before.gaps.map((g) => g.title)).toContain("Only Hande Özkan knows Monthly consolidation and management report, and they are on leave");
    const proposal = (
      await t.app.inject({
        method: "POST",
        url: `${base}/brain/learn`,
        headers: { cookie: as["burak.sahin"]! },
        payload: { text: "I can do the consolidation now: Selin and I rebuilt it from Hande's notes on SharePoint." },
      })
    ).json() as { changes: unknown[]; offline: boolean };
    expect(proposal.offline).toBe(false);
    // Claude saw what the brain already has, with ids to use.
    expect(seen.learn?.[0]).toContain("Monthly consolidation and management report");
    const applied = (
      await t.app.inject({ method: "POST", url: `${base}/brain/learn/apply`, headers: { cookie: as["burak.sahin"]! }, payload: { changes: proposal.changes } })
    ).json() as {
      done: string[];
      skipped: string[];
    };
    expect(applied).toEqual({
      done: [
        `Kept know-how "Hande's notes for the consolidation are on SharePoint › Finance"`,
        "Linked: Burak Şahin knows Monthly consolidation and management report (Can do it)",
      ],
      skipped: [],
      ids: expect.any(Array),
    });
    const after = (await t.app.inject({ method: "GET", url: `${base}/brain/overview`, headers: { cookie: as["burak.sahin"]! } })).json() as {
      gaps: { title: string }[];
    };
    expect(after.gaps.map((g) => g.title).join("\n")).not.toContain("Monthly consolidation and management report");
  });

  it("is taught in the talk with it: Claude reads the words and what they name, the card keeps what the teacher ticks", async () => {
    type Msg = {
      id: string;
      kind: string;
      author: { kind: string };
      text: string;
      card: { type: string; status: string; offline: boolean; changes: unknown[]; result: { done: string[] } | null } | null;
    };
    const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
      t.app.inject({
        method,
        url: `${base}${url}`,
        headers: { cookie: as["burak.sahin"]! },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    const process = ((await call("GET", "/brain/search?q=consolidation&kinds=process")).json() as { id: string; name: string }[])[0]!;
    const talk = (await call("GET", "/conversations/for/ai_employee/company-brain?teach=1")).json() as {
      conversation: { id: string };
      offers: { teach: boolean };
    };
    expect(talk.offers.teach).toBe(true);
    const id = talk.conversation.id;
    const taught = await call("POST", `/conversations/${id}/messages`, {
      text: `I can do the @[${process.name}](thing:${process.id}) now: Selin and I rebuilt it from Hande's notes on SharePoint.`,
      intent: "teach",
    });
    expect(taught.statusCode, taught.body).toBe(200);
    const card = await until(
      async () => ((await call("GET", `/conversations/${id}/messages`)).json() as Msg[]).find((m) => m.card?.type === "learning"),
      "the learning card",
    );
    expect(card.text).toBe("Burak Şahin can now do the consolidation.");
    expect(card.card).toMatchObject({ status: "open", offline: false });
    expect(card.card!.changes).toHaveLength(2);
    // Claude read the words without tokens, and what they named.
    expect(seen.learn?.[0]).toContain("Things they named");
    expect(seen.learn?.[0]).toContain(process.id);
    const kept = await call("POST", `/conversations/${id}/messages/${card.id}/learn`, { keep: [1] });
    expect(kept.statusCode, kept.body).toBe(200);
    expect((kept.json() as Msg).card?.result?.done).toEqual([`Kept know-how "Hande's notes for the consolidation are on SharePoint › Finance"`]);
    // A message without "Teach" is still a question it answers.
    await call("POST", `/conversations/${id}/messages`, { text: "Who knows the 8D process?" });
    const answer = await until(
      async () => ((await call("GET", `/conversations/${id}/messages`)).json() as Msg[]).find((m) => m.kind === "text" && m.author.kind === "ai_employee"),
      "the brain's answer",
    );
    expect(answer.text).toBe("Kerem Yıldız and Selin Acar know it best.");
  });
});
