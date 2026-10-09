import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDatabase, type DatabaseHandle } from "@enterprise-brain/db";
import { BrainService, describeEntity, runCompanyTool, type SourceBatch } from "../src/index.ts";

/** The company brain's rules: what sources bring, what people write, and how it is found again. */

let handle: DatabaseHandle;
let brain: BrainService;
let companyId: string;
let otherId: string;
const PRIORITY: Record<string, number> = { platform: 30, hr: 60, crm: 50, erp: 50, chat: 40 };

beforeAll(async () => {
  handle = await createDatabase();
  const [a] = await handle.db.insert(companies).values({ name: "Acme", slug: "acme" }).returning();
  const [b] = await handle.db.insert(companies).values({ name: "Globex", slug: "globex" }).returning();
  companyId = a!.id;
  otherId = b!.id;
  brain = new BrainService(handle, { priority: (origin) => PRIORITY[origin] ?? 50, originName: (origin) => `${origin} (demo)` });
});

afterAll(async () => {
  await handle.close();
});

const people: SourceBatch = {
  entities: [
    { kind: "department", key: "operations", name: "Operations" },
    { kind: "person", ref: "EMP-1", name: "Kerem Yıldız", data: { title: "Quality Engineer", email: "kerem.yildiz@acme.com.tr", status: "Active" } },
    { kind: "person", ref: "EMP-2", name: "Selin Acar", data: { title: "Quality Manager", email: "selin.acar@acme.com.tr", status: "Active" } },
    { kind: "process", key: "complaints", name: "Customer complaints and 8D", data: { steps: [{ name: "Contain", who: "Merve Aksoy", system: "SAP" }] } },
    { kind: "system", key: "mes", name: "Opcenter MES", aliases: ["MES"] },
  ],
  links: [
    { from: { kind: "person", email: "kerem.yildiz@acme.com.tr" }, relation: "works_in", to: { kind: "department", key: "operations" } },
    { from: { kind: "person", email: "kerem.yildiz@acme.com.tr" }, relation: "knows", to: { kind: "process", key: "complaints" }, detail: "Expert" },
    { from: { kind: "person", email: "selin.acar@acme.com.tr" }, relation: "owns", to: { kind: "process", key: "complaints" } },
    { from: { kind: "person", email: "kerem.yildiz@acme.com.tr" }, relation: "knows", to: { kind: "system", key: "mes" }, detail: "Can do it" },
  ],
};

describe("what sources bring", () => {
  it("adds things and links once, finds them again by source id, email or name, and keeps companies apart", async () => {
    const first = await brain.apply(companyId, "hr", people);
    expect(first).toMatchObject({ added: 5, links: { added: 4, removed: 0 }, skipped: [] });
    const again = await brain.apply(companyId, "hr", people);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 5, links: { added: 0, removed: 0 } });
    // The app knows the same person by email, with a lower priority: nothing of the HR system's is overwritten.
    const platform = await brain.apply(companyId, "platform", {
      entities: [{ kind: "person", ref: "user-1", name: "Kerem Yıldız", data: { email: "kerem.yildiz@acme.com.tr", title: "Engineer" } }],
    });
    expect(platform).toMatchObject({ added: 0, updated: 1 });
    const kerem = (await brain.find(companyId, "kerem.yildiz@acme.com.tr"))!;
    expect(kerem.data.title).toBe("Quality Engineer");
    expect(kerem.refs).toEqual({ hr: "EMP-1", platform: "user-1" });
    expect(await brain.counts(otherId)).toEqual({});
  });

  it("names people a source mentions, and drops links it no longer has", async () => {
    const result = await brain.apply(companyId, "crm", {
      entities: [{ kind: "client", ref: "ACC-1", name: "Petrokim Rafineri A.Ş.", aliases: ["Petrokim"], data: { status: "Customer" } }],
      links: [
        { from: { kind: "person", name: "Ali Yıldız" }, relation: "owns", to: { kind: "client", ref: "ACC-1" } },
        { from: { kind: "person", name: "Kerem Yıldız" }, relation: "works_on", to: { kind: "client", ref: "ACC-1" } },
      ],
    });
    // Ali Yıldız wasn't in the brain: the CRM's account owner joins it.
    expect(result).toMatchObject({ added: 2, byKind: { client: 1, person: 1 }, links: { added: 2 } });
    const dropped = await brain.apply(companyId, "crm", {
      entities: [{ kind: "client", ref: "ACC-1", name: "Petrokim Rafineri A.Ş." }],
      links: [{ from: { kind: "person", name: "Ali Yıldız" }, relation: "owns", to: { kind: "client", ref: "ACC-1" } }],
    });
    expect(dropped.links).toEqual({ added: 0, removed: 1 });
    // Another source's links stay.
    const kerem = await brain.get(companyId, (await brain.find(companyId, "Kerem Yıldız"))!.id);
    expect(kerem.links.map((l) => `${l.label}: ${l.other.name}${l.detail ? ` (${l.detail})` : ""}`).sort()).toEqual([
      "Knows: Customer complaints and 8D (Expert)",
      "Knows: Opcenter MES (Can do it)",
      "Works in: Operations",
    ]);
  });

  it("puts changes of status, stage or health on the timeline, and adds events once, tied to what they name", async () => {
    await brain.apply(companyId, "projects", {
      entities: [{ kind: "project", key: "p1", name: "Petrokim vibration fix", data: { health: "At risk", progress: 45 } }],
    });
    const moved = await brain.apply(companyId, "projects", {
      entities: [{ kind: "project", key: "p1", name: "Petrokim vibration fix", data: { health: "On track", progress: 80 } }],
    });
    expect(moved).toMatchObject({ updated: 1, changes: 2 });
    const project = (await brain.find(companyId, "Petrokim vibration fix", "project"))!;
    const changes = await brain.events(companyId, { about: project.id });
    expect(changes.map((e) => e.title).sort()).toEqual(["Petrokim vibration fix: health At risk → On track", "Petrokim vibration fix: progress 45% → 80%"]);
    expect(changes[0]).toMatchObject({ kind: "change", actor: "projects (demo)" });

    const batch: SourceBatch = {
      events: [
        {
          ref: "m1",
          at: "2026-10-01T09:00:00Z",
          kind: "message",
          title: "Kerem Yıldız checked the MES test results for Petrokim",
          actor: "selin.acar@acme.com.tr",
          place: "Quality",
        },
      ],
    };
    expect((await brain.apply(companyId, "chat", batch)).events).toBe(1);
    expect((await brain.apply(companyId, "chat", batch)).events).toBe(0);
    const [event] = await brain.events(companyId, { origin: "chat" });
    // The person by full name, the system and the client by their other names; the writer is the actor.
    expect(event!.about.map((a) => a.name).sort()).toEqual(["Kerem Yıldız", "Opcenter MES", "Petrokim Rafineri A.Ş."]);
    expect(event).toMatchObject({ actor: "Selin Acar", place: "Quality" });
    expect(event!.actorId).toBe((await brain.find(companyId, "Selin Acar"))!.id);
  });
});

describe("what people write", () => {
  it("keeps a person's values over what sources bring, and puts their changes on the timeline", async () => {
    const kerem = (await brain.find(companyId, "Kerem Yıldız"))!;
    const changed = await brain.update(
      companyId,
      kerem.id,
      { data: { title: "Senior Quality Engineer", status: "On leave" } },
      "Selin Acar <selin.acar@acme.com.tr>",
    );
    expect(changed.origins).toMatchObject({ "data.title": "manual", "data.status": "manual" });
    await brain.apply(companyId, "hr", people);
    const after = await brain.get(companyId, kerem.id);
    expect(after.data).toMatchObject({ title: "Senior Quality Engineer", status: "On leave" });
    expect(after.events.some((e) => e.title === "Kerem Yıldız: status Active → On leave" && e.actor === "Selin Acar")).toBe(true);
  });

  it("checks values and links, and won't add the same thing twice", async () => {
    await expect(brain.create(companyId, { kind: "project", name: "Bad", data: { progress: "lots" } }, "x")).rejects.toThrow(
      'Progress: "lots" is not a number',
    );
    await expect(brain.create(companyId, { kind: "system", name: "opcenter mes" }, "x")).rejects.toThrow('System "Opcenter MES" is already in the brain');
    const db = await brain.create(
      companyId,
      {
        kind: "database",
        name: "MES_PROD",
        data: { engine: "SQL Server 2019", port: 1433, tables: [{ name: "test_results", columns: [{ name: "serial_no", type: "varchar(20)" }] }] },
      },
      "x",
    );
    expect(db.data).toMatchObject({
      port: "1433",
      tables: [{ name: "test_results", description: "", columns: [{ name: "serial_no", type: "varchar(20)", key: "", description: "" }] }],
    });
    const mes = (await brain.find(companyId, "MES", "system"))!;
    await expect(brain.link(companyId, { from: db.id, relation: "has_database", to: mes.id }, "x")).rejects.toThrow(
      '"Keeps its data in" doesn\'t go from database to system',
    );
    const link = await brain.link(companyId, { from: mes.id, relation: "has_database", to: db.id }, "x");
    expect(link).toMatchObject({ label: "Keeps its data in", origin: "manual" });
  });

  it("hides what a person removes, so its source doesn't bring it back", async () => {
    const mes = (await brain.find(companyId, "Opcenter MES"))!;
    const knows = (await brain.get(companyId, mes.id)).links.find((l) => l.relation === "knows")!;
    await brain.unlink(companyId, knows.id, "x");
    await brain.apply(companyId, "hr", people);
    expect((await brain.get(companyId, mes.id)).links.some((l) => l.relation === "knows")).toBe(false);

    const ali = (await brain.find(companyId, "Ali Yıldız"))!;
    await brain.remove(companyId, ali.id, "x");
    const back = await brain.apply(companyId, "crm", {
      entities: [{ kind: "person", name: "Ali Yıldız" }],
      links: [{ from: { kind: "person", name: "Ali Yıldız" }, relation: "owns", to: { kind: "client", ref: "ACC-1" } }],
    });
    expect(back.added).toBe(0);
    expect(await brain.find(companyId, "Ali Yıldız", "person")).toBeUndefined();
  });
});

describe("finding things", () => {
  it("puts the thing a word names first, then what holds the words", async () => {
    const hits = await brain.search(companyId, "petrokim");
    expect(hits[0]).toMatchObject({ kind: "client", name: "Petrokim Rafineri A.Ş." });
    expect(hits.map((h) => h.name)).toContain("Petrokim vibration fix");
    // Accents and the dotless ı don't matter; questions' small words are ignored.
    expect((await brain.search(companyId, "who is kerem yildiz"))[0]?.name).toBe("Kerem Yıldız");
    expect((await brain.find(companyId, "Petrokim"))?.kind).toBe("client");
    expect(await brain.search(companyId, "the and of")).toEqual([]);
  });

  it("lists things with the links that say most about them", async () => {
    const [kerem] = await brain.list(companyId, { kind: "person", q: "kerem", keyLinks: true });
    expect(kerem?.keyLinks).toEqual({ Department: [expect.objectContaining({ name: "Operations", kind: "department" })] });
    const [process] = await brain.list(companyId, { kind: "process", keyLinks: true });
    expect(process?.keyLinks?.Owner?.map((o) => o.name)).toEqual(["Selin Acar"]);
  });

  it("describes a thing for Claude, with its steps, links and addresses", async () => {
    const process = (await brain.find(companyId, "Customer complaints and 8D"))!;
    const text = describeEntity(await brain.get(companyId, process.id));
    expect(text).toContain("# Customer complaints and 8D — Process");
    expect(text).toContain("  1. Contain — Merve Aksoy (in SAP)");
    expect(text).toMatch(/- Who knows it: \[Kerem Yıldız\]\(\/studio\/brain\/e\/[0-9a-f-]{36}\) \(person, Expert\)/);
    const tool = await runCompanyTool(brain, companyId, "company_open", { id_or_name: "8D" });
    expect(tool.content).toContain("# Customer complaints and 8D");
    const listed = await runCompanyTool(brain, companyId, "company_list", { kind: "person" });
    expect(listed.content).toMatch(/^\d+ people:/);
  });

  it("draws a thing and what links to it", async () => {
    const kerem = (await brain.find(companyId, "Kerem Yıldız"))!;
    const graph = await brain.graph(companyId, kerem.id);
    expect(graph.nodes.find((n) => n.depth === 0)?.name).toBe("Kerem Yıldız");
    expect(
      graph.nodes
        .filter((n) => n.depth === 1)
        .map((n) => n.name)
        .sort(),
    ).toEqual(["Customer complaints and 8D", "Operations"]);
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.from) && graph.nodes.some((n) => n.id === e.to))).toBe(true);
  });
});

describe("the overview", () => {
  it("shows what needs attention and where know-how sits with one person", async () => {
    await brain.apply(companyId, "projects", {
      entities: [
        { kind: "project", key: "p2", name: "SAP upgrade", data: { status: "Active", health: "Off track", risks: ["Overlaps the month-end close"] } },
        { kind: "task", key: "t1", name: "Copy the test system", data: { status: "In progress", due: "2020-01-01" } },
        { kind: "case", key: "c1", name: "Pumps vibrate", data: { status: "Open", priority: "Urgent" } },
      ],
      links: [
        { from: { kind: "task", key: "t1" }, relation: "part_of", to: { kind: "project", key: "p2" } },
        { from: { kind: "task", key: "t1" }, relation: "assigned_to", to: { kind: "person", name: "Selin Acar" } },
        { from: { kind: "case", key: "c1" }, relation: "for_client", to: { kind: "client", ref: "ACC-1", origin: "crm" } },
      ],
    });
    const overview = await brain.overview(companyId);
    expect(overview.attention.map((a) => a.title)).toEqual(
      expect.arrayContaining(["SAP upgrade is off track", "Urgent customer issue from Petrokim Rafineri A.Ş.", "Late: Copy the test system"]),
    );
    expect(overview.attention[0]?.severity).toBe("high");
    // Kerem is on leave and the only one who knows the complaint process.
    expect(overview.gaps).toContainEqual(
      expect.objectContaining({ type: "on-leave-expert", title: "Only Kerem Yıldız knows Customer complaints and 8D, and they are on leave" }),
    );
    expect(overview.gaps).toContainEqual(expect.objectContaining({ type: "no-owner", title: "No one is responsible for Opcenter MES" }));
    expect(overview.busy).toEqual([{ person: expect.objectContaining({ name: "Selin Acar" }), open: 1, tasks: ["Copy the test system"] }]);
    expect(overview.projects.map((p) => p.name)).toEqual(["SAP upgrade", "Petrokim vibration fix"]);
  });
});
