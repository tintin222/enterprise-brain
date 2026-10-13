import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Projects over HTTP with people signed in: a person starts a project and gets a thing in the brain
 * (led by them, for its client), a private channel and a slug; everyone reads it, its owner, managers
 * and admins change it; it holds assets of every kind (what the viewer may see), designs (interviews,
 * AI employees) and the person's own to-dos.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface ProjectView {
  id: string;
  slug: string;
  name: string;
  status: string;
  client: string | null;
  ownerUserId: string | null;
  thingId: string | null;
  conversationId: string | null;
  lastExportedAt: string | null;
  counts: { assets: number; designs: number; openTodos: number };
  owner: { id: string; name: string } | null;
  channel: { id: string; name: string | null; status: string } | null;
  canEdit: boolean;
}

interface Asset {
  id: string;
  kind: string;
  ref: string;
  name: string;
  detail: string;
  exists: boolean;
}

interface Thing {
  id: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
  links: { label: string; relation: string; direction: string; other: { id: string; name: string; kind: string } }[];
}

describe("projects over HTTP", () => {
  let t: TestApp;
  let companyId = "";
  const as: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let project: ProjectView;
  let tableKey = "";
  let documentId = "";
  let fileId = "";
  let connectionId = "";
  let hrAgentId = "";

  const call = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const thing = async (id: string) => (await call("mehmet.oz", "GET", `/brain/entities/${id}`)).json() as Thing;

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    for (const local of ["selin.acar", "kerem.yildiz", "mehmet.oz", "can.demir"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
      ids[local] = (await t.platform.people.findByEmail(companyId, `${local}@acme.com.tr`))!.id;
    }
    // What the company knows: its client, the person who will lead the project, a system and a process.
    await t.platform.brain.create(companyId, { kind: "client", name: "Petrokim", summary: "Petrochemical group in İzmir" }, "test");
    await t.platform.brain.create(companyId, { kind: "person", name: "Kerem Yıldız", data: { email: "kerem.yildiz@acme.com.tr" } }, "test");
    await t.platform.brain.create(companyId, { kind: "system", name: "Supplier portal", summary: "Where suppliers see orders and upload invoices" }, "test");
    await t.platform.brain.create(companyId, { kind: "process", name: "Supplier complaint handling" }, "test");
    // A table of the operations department, a knowledge document, a file and a connection with a secret.
    const operations = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "operations")!;
    const table = await call("selin.acar", "POST", "/tables", {
      name: "Supplier complaints",
      fields: [
        { key: "supplier", label: "Supplier", type: "text", required: true },
        { key: "problem", label: "Problem", type: "long_text" },
      ],
      titleField: "supplier",
      departmentId: operations.id,
    });
    expect(table.statusCode, table.body).toBe(200);
    tableKey = (table.json() as { key: string }).key;
    await t.platform.knowledge.ensureCollection(companyId, { key: "portal-docs", name: "Portal documents" });
    documentId = (
      await t.platform.knowledge.ingestText(companyId, "portal-docs", {
        title: "Supplier portal manual",
        text: "Suppliers sign in with their vendor number and see their open orders.",
      })
    ).id;
    fileId = (await t.platform.files.put(companyId, { name: "portal-spec.txt", data: Buffer.from("The portal spec"), mimeType: "text/plain", source: "test" }))
      .id;
    connectionId = (
      await t.platform.connectors.create(companyId, {
        type: "rest-api",
        name: "Petrokim ERP",
        values: { base_url: "https://erp.petrokim.test/api", auth_type: "api_key", api_key: "s3cret-key" },
      })
    ).id;
    const hr = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "hr")!;
    hrAgentId = (await t.platform.agents.list(companyId, { departmentId: hr.id }))[0]!.row.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("a person starts a project: a slug, a thing in the brain they lead for its client, a private channel with them in it", async () => {
    const made = await call("kerem.yildiz", "POST", "/projects", {
      name: "Supplier Portal",
      summary: "AI employees for the supplier portal",
      client: "Petrokim",
    });
    expect(made.statusCode, made.body).toBe(200);
    project = made.json() as ProjectView;
    expect(project).toMatchObject({ slug: "supplier-portal", name: "Supplier Portal", status: "active", client: "Petrokim", canEdit: true });
    expect(project.owner).toEqual({ id: ids["kerem.yildiz"], name: "Kerem Yıldız" });
    expect(project.channel).toMatchObject({ name: "supplier-portal", status: "open" });

    const brainThing = await thing(project.thingId!);
    expect(brainThing).toMatchObject({ kind: "project", name: "Supplier Portal", data: { status: "Active", type: "Customer project" } });
    expect(brainThing.links.map((l) => [l.relation, l.other.name])).toEqual(
      expect.arrayContaining([
        ["leads", "Kerem Yıldız"],
        ["for_client", "Petrokim"],
      ]),
    );

    const channel = (await call("kerem.yildiz", "GET", `/conversations/${project.conversationId}`)).json() as {
      conversation: { kind: string; aboutId: string | null; visibility: string; title: string };
      participants: { actorId: string; role: string }[];
      about: { href: string; label: string } | null;
    };
    expect(channel.conversation).toMatchObject({ kind: "channel", aboutId: null, visibility: "participants", title: "Supplier Portal" });
    expect(channel.participants).toEqual([expect.objectContaining({ actorId: ids["kerem.yildiz"], role: "owner" })]);
    expect(channel.about).toEqual({ href: "/studio/projects/supplier-portal", label: "Supplier Portal" });

    // The same name again: the next slug, and the brain's project thing is shared, not doubled.
    const again = await call("selin.acar", "POST", "/projects", { name: "Supplier Portal" });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as ProjectView).slug).toBe("supplier-portal-2");
    expect((again.json() as ProjectView).thingId).toBe(project.thingId);
  });

  it("everyone reads projects; only the owner, managers and admins change them, and the thing and channel follow", async () => {
    const list = (await call("can.demir", "GET", "/projects")).json() as ProjectView[];
    expect(list.map((p) => p.slug)).toEqual(["supplier-portal-2", "supplier-portal"]);
    const read = await call("can.demir", "GET", "/projects/supplier-portal");
    expect(read.statusCode).toBe(200);
    expect((read.json() as ProjectView).canEdit).toBe(false);
    expect((await call("can.demir", "PATCH", "/projects/supplier-portal", { name: "Mine now" })).statusCode).toBe(403);

    const changed = await call("selin.acar", "PATCH", "/projects/supplier-portal", { name: "Supplier portal agents", status: "on_hold" });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ name: "Supplier portal agents", status: "on_hold", slug: "supplier-portal" });
    const brainThing = await thing(project.thingId!);
    expect(brainThing).toMatchObject({ name: "Supplier portal agents", data: { status: "On hold" } });
    const events = (await call("mehmet.oz", "GET", `/brain/events?about=${project.thingId}`)).json() as { kind: string; title: string }[];
    expect(events.some((e) => e.kind === "change" && /status/.test(e.title))).toBe(true);
    const channel = (await call("kerem.yildiz", "GET", `/conversations/${project.conversationId}`)).json() as {
      conversation: { title: string; status: string };
    };
    expect(channel.conversation).toMatchObject({ title: "Supplier portal agents", status: "open" });

    // A finished project's channel is archived.
    expect((await call("kerem.yildiz", "PATCH", "/projects/supplier-portal-2", { status: "done" })).statusCode).toBe(403); // Selin's project
    const done = await call("selin.acar", "PATCH", "/projects/supplier-portal-2", { status: "done" });
    expect(done.statusCode, done.body).toBe(200);
    const second = done.json() as ProjectView;
    expect(second.channel?.status).toBe("archived");
    expect(((await call("kerem.yildiz", "GET", "/projects?status=open")).json() as ProjectView[]).map((p) => p.slug)).toEqual(["supplier-portal"]);
  });

  it("holds assets of every kind the viewer may see; a thing is linked in the brain; adding twice changes nothing", async () => {
    const add = (who: string, kind: string, ref: string, note?: string) =>
      call(who, "POST", "/projects/supplier-portal/assets", { kind, ref, ...(note ? { note } : {}) });
    const portal = await add("kerem.yildiz", "thing", "Supplier portal", "The system it works in");
    expect(portal.statusCode, portal.body).toBe(200);
    expect(portal.json()).toMatchObject({
      kind: "thing",
      name: "Supplier portal",
      detail: expect.stringContaining("System"),
      note: "The system it works in",
      exists: true,
    });
    expect((await add("kerem.yildiz", "thing", "Supplier complaint handling")).statusCode).toBe(200);
    expect((await add("kerem.yildiz", "table", tableKey)).statusCode).toBe(200);
    expect((await add("kerem.yildiz", "document", documentId)).statusCode).toBe(200);
    expect((await add("kerem.yildiz", "file", fileId)).statusCode).toBe(200);
    expect((await add("kerem.yildiz", "connection", connectionId)).statusCode).toBe(200);
    // An AI employee of HR: not Kerem's to see, so not his to add; the admin adds it.
    expect((await add("kerem.yildiz", "agent", hrAgentId)).statusCode).toBe(404);
    expect((await add("mehmet.oz", "agent", hrAgentId)).statusCode).toBe(200);
    // What does not exist, and what is not a kind.
    expect((await add("kerem.yildiz", "table", "no_such_table")).statusCode).toBe(404);
    expect((await add("kerem.yildiz", "thing", "Nothing like this")).statusCode).toBe(404);
    expect((await add("kerem.yildiz", "widget" as never, "x")).statusCode).toBe(400);
    // Someone who may not change the project.
    expect((await add("can.demir", "file", fileId)).statusCode).toBe(403);

    // Twice is once.
    const twice = await add("kerem.yildiz", "table", tableKey);
    expect(twice.statusCode).toBe(200);
    const all = (await call("mehmet.oz", "GET", "/projects/supplier-portal/assets")).json() as { assets: Asset[]; hidden: number };
    expect(all.hidden).toBe(0);
    expect(all.assets.map((a) => [a.kind, a.name])).toEqual([
      ["thing", "Supplier complaint handling"],
      ["thing", "Supplier portal"],
      ["table", "Supplier complaints"],
      ["document", "Supplier portal manual"],
      ["file", "portal-spec.txt"],
      ["connection", "Petrokim ERP"],
      ["agent", expect.any(String)],
    ]);
    expect(all.assets.find((a) => a.kind === "connection")!.detail).toBe("rest-api");
    expect(all.assets.find((a) => a.kind === "file")!.detail).toBe("text/plain · 15 B");

    // In the brain: the project uses the portal; the process is part of it.
    const brainThing = await thing(project.thingId!);
    expect(brainThing.links.map((l) => [l.relation, l.direction, l.other.name])).toEqual(
      expect.arrayContaining([
        ["uses", "out", "Supplier portal"],
        ["part_of", "in", "Supplier complaint handling"],
      ]),
    );

    // Someone outside operations does not see its table (HR's AI employee is his own department's); the count says so.
    const seen = (await call("can.demir", "GET", "/projects/supplier-portal/assets")).json() as { assets: Asset[]; hidden: number };
    expect(seen.hidden).toBe(1);
    expect(seen.assets.map((a) => a.kind)).toEqual(["thing", "thing", "document", "file", "connection", "agent"]);

    // Where a thing already is.
    const portalId = all.assets.find((a) => a.name === "Supplier portal")!.ref;
    const holding = (await call("can.demir", "GET", `/projects?holding=thing:${portalId}`)).json() as ProjectView[];
    expect(holding.map((p) => p.slug)).toEqual(["supplier-portal"]);
    expect(holding[0]!.counts.assets).toBe(7);

    // Out again.
    const asset = all.assets.find((a) => a.kind === "file")!;
    expect((await call("kerem.yildiz", "DELETE", `/projects/supplier-portal/assets/${asset.id}`)).statusCode).toBe(200);
    const after = (await call("mehmet.oz", "GET", "/projects/supplier-portal/assets")).json() as { assets: Asset[] };
    expect(after.assets.some((a) => a.kind === "file")).toBe(false);
  });

  it("uploads files straight into the project", async () => {
    const { multipart } = await import("./helpers.ts");
    const body = multipart({}, [
      { field: "files", name: "notes.md", data: Buffer.from("# Notes\nKeep the API key out of the package."), type: "text/markdown" },
    ]);
    const uploaded = await t.app.inject({
      method: "POST",
      url: `${base}/projects/supplier-portal/files`,
      headers: { cookie: as["kerem.yildiz"]!, ...body.headers },
      payload: body.payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json()).toEqual([expect.objectContaining({ kind: "file", name: "notes.md", exists: true })]);
  });

  it("lists the designs made in it: interviews and AI employees attached, each opened by those allowed", async () => {
    const started = await call("selin.acar", "POST", "/builder/sessions", {
      description: "An AI employee that answers suppliers' questions about their invoices",
    });
    expect(started.statusCode, started.body).toBe(200);
    const interviewId = (started.json() as { session: { id: string } }).session.id;
    // The owner may change the project, but the interview is not his to put in it.
    expect((await call("kerem.yildiz", "POST", "/projects/supplier-portal/designs", { kind: "interview", id: interviewId })).statusCode).toBe(404);
    expect((await call("selin.acar", "POST", "/projects/supplier-portal/designs", { kind: "interview", id: interviewId })).statusCode).toBe(200);
    expect((await call("mehmet.oz", "POST", "/projects/supplier-portal/designs", { kind: "agent", id: hrAgentId })).statusCode).toBe(200);

    const forSelin = (await call("selin.acar", "GET", "/projects/supplier-portal/designs")).json() as {
      threads: unknown[];
      interviews: { id: string; canOpen: boolean }[];
      agents: { id: string; from: string }[];
    };
    expect(forSelin.threads).toEqual([]);
    expect(forSelin.interviews).toEqual([expect.objectContaining({ id: interviewId, canOpen: true })]);
    expect(forSelin.agents).toEqual([]); // HR's AI employee is not hers to see
    const forKerem = (await call("kerem.yildiz", "GET", "/projects/supplier-portal/designs")).json() as { interviews: { canOpen: boolean }[] };
    expect(forKerem.interviews[0]!.canOpen).toBe(false);
    const forMehmet = (await call("mehmet.oz", "GET", "/projects/supplier-portal/designs")).json() as { agents: { id: string; from: string }[] };
    expect(forMehmet.agents).toEqual([expect.objectContaining({ id: hrAgentId, from: "attached" })]);
    expect(((await call("mehmet.oz", "GET", "/projects/supplier-portal")).json() as ProjectView).counts.designs).toBe(1);
  });

  it("keeps the person's own to-dos for the project; removing the project leaves them without one", async () => {
    const added = await call("kerem.yildiz", "POST", "/projects/supplier-portal/todos", { title: "Get the API key from Petrokim", dueAt: "2026-11-02" });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ title: "Get the API key from Petrokim", status: "open", source: "project", project: { slug: "supplier-portal" } });
    expect(new Date((added.json() as { dueAt: string }).dueAt).toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(((await call("kerem.yildiz", "GET", "/projects/supplier-portal/todos")).json() as unknown[]).length).toBe(1);
    expect(((await call("selin.acar", "GET", "/projects/supplier-portal/todos")).json() as unknown[]).length).toBe(0);
    expect(((await call("kerem.yildiz", "GET", "/projects")).json() as ProjectView[]).find((p) => p.slug === "supplier-portal")!.counts.openTodos).toBe(1);
    expect(((await call("selin.acar", "GET", "/projects")).json() as ProjectView[]).find((p) => p.slug === "supplier-portal")!.counts.openTodos).toBe(0);

    expect((await call("can.demir", "DELETE", "/projects/supplier-portal")).statusCode).toBe(403);
    expect((await call("kerem.yildiz", "DELETE", "/projects/supplier-portal")).statusCode).toBe(200);
    expect((await call("kerem.yildiz", "GET", "/projects/supplier-portal")).statusCode).toBe(404);
    const channel = (await call("kerem.yildiz", "GET", `/conversations/${project.conversationId}`)).json() as { conversation: { status: string } };
    expect(channel.conversation.status).toBe("archived");
    const todos = (await call("kerem.yildiz", "GET", "/todos")).json() as { title: string; project: unknown }[];
    expect(todos).toEqual([expect.objectContaining({ title: "Get the API key from Petrokim", project: null })]);
    // The brain keeps the project and notes what happened.
    const events = (await call("mehmet.oz", "GET", `/brain/events?about=${project.thingId}`)).json() as { title: string }[];
    expect(events.some((e) => /removed from the app/.test(e.title))).toBe(true);
  });
});
