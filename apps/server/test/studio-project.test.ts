import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { studioThreads } from "@enterprise-brain/db";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The Studio agent inside a project: its instructions carry the project and what it uses, look_around shows
 * the project as it stands, what it finds goes into the project (project_add_asset), what the person must do
 * becomes a task for them (project_add_task, once per title), and the AI employee it writes is one of the
 * project's designs. Outside a project the project tools refuse.
 */

const base = "/api/companies/acme";
/** What the Studio's tools answered, kept for the assertions: look_around's overview, the asset additions, the refusal outside a project. */
let lookedAround = "";
let assetResults: string[] = [];
let refused = "";

/** The Studio's turns: `turn` counts Claude's answers in this run, `results` holds what its tools answered so far. */
function script(request: ToolLoopRequest, turn: number, results: string[]) {
  const inProject = request.tools.some((t) => t.name === "project_add_asset");
  if (!inProject) {
    // Claude tries the project tool anyway, once, and is told there is no project.
    if (turn === 1) return { calls: [{ name: "project_add_asset", input: { kind: "thing", ref: "Petrokim" } }] };
    refused = results[0] ?? "";
    return { text: "This conversation is not in a project." };
  }
  switch (turn) {
    case 1:
      return { calls: [{ name: "look_around", input: {} }] };
    case 2:
      lookedAround = results[0] ?? "";
      return {
        calls: [
          { name: "project_add_asset", input: { kind: "thing", ref: "Petrokim", note: "The client" } },
          { name: "project_add_asset", input: { kind: "table", ref: "supplier_complaints" } },
          { name: "project_add_asset", input: { kind: "thing", ref: "Nothing of that name" } },
        ],
      };
    case 3:
      assetResults = results.slice(1, 4);
      return {
        calls: [
          { name: "project_add_task", input: { title: "Get the API credentials from Petrokim", details: "Their IT contact has them.", due: "2026-11-15" } },
          { name: "project_add_task", input: { title: "Get the API credentials from Petrokim" } },
        ],
      };
    case 4:
      return {
        calls: [
          {
            name: "save_ai_employee",
            input: {
              name: "Complaint Handler",
              role: "Handles Petrokim's supplier complaints",
              department: "operations",
              job: "For each complaint email about a delivery from Petrokim's suppliers: log it in Supplier complaints with the supplier and the problem, then ask the quality engineer to confirm the root cause.",
              starts: [{ when: "email", mailbox: "quality@acme.com.tr" }],
              can: { tables: [{ table: "supplier_complaints", can: ["find", "add"] }] },
            },
          },
        ],
      };
    default:
      return { text: "The Complaint Handler is written. The project now holds Petrokim and the complaints table, and you have one task: the API credentials." };
  }
}

const llm = new ScriptedLlm({ "studio.agent": { tools: script } });

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface ThreadView {
  id: string;
  status: string;
  project: { id: string; slug: string; name: string } | null;
  events: { seq: number; kind: string; data: Record<string, unknown> }[];
  solution: { employees: { key: string; name: string }[] };
}

describe("the Studio agent inside a project", () => {
  let t: TestApp;
  let companyId = "";
  let selin = "";
  let project: { id: string; slug: string; thingId: string };
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: selin },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const thread = async (id: string) => (await call("GET", `/studio/threads/${id}`)).json() as ThreadView;

  beforeAll(async () => {
    t = await createTestApp({ llm, config: { auth: { mode: "accounts", sessionHours: 1, providers: [] } } });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    selin = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: "selin.acar@acme.com.tr" } }));
    await t.platform.brain.create(companyId, { kind: "client", name: "Petrokim", summary: "Petrochemical group in İzmir" }, "test");
    await t.platform.brain.create(companyId, { kind: "system", name: "Supplier portal", summary: "Where suppliers upload invoices" }, "test");
    const operations = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "operations")!;
    const table = await call("POST", "/tables", {
      name: "Supplier complaints",
      fields: [
        { key: "supplier", label: "Supplier", type: "text", required: true },
        { key: "problem", label: "Problem", type: "long_text" },
      ],
      titleField: "supplier",
      departmentId: operations.id,
    });
    expect(table.statusCode, table.body).toBe(200);
    const made = await call("POST", "/projects", { name: "Petrokim complaints", client: "Petrokim", summary: "Agents for the supplier complaint process." });
    expect(made.statusCode, made.body).toBe(200);
    project = made.json() as typeof project;
    expect((await call("POST", `/projects/${project.id}/assets`, { kind: "thing", ref: "Supplier portal" })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("knows the project from the start, adds what it finds to it, gives the person a task, and its AI employee is a design of the project", async () => {
    const started = await call("POST", "/studio/threads", { text: "Handle Petrokim's supplier complaints.", projectId: project.id });
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as ThreadView).id;
    expect((started.json() as ThreadView).project).toEqual({ id: project.id, slug: project.slug, name: "Petrokim complaints" });

    const view = await until(
      () => thread(id),
      (v) => v.status === "idle" || v.status === "failed",
      "the Studio's turn",
    );
    expect(view.status).toBe("idle");

    // Its instructions carry the project and what it used from the start; it has the project tools.
    const [row] = await t.platform.handle.db.select().from(studioThreads).where(eq(studioThreads.id, id));
    expect(row!.projectId).toBe(project.id);
    expect(row!.setup.system).toContain(
      'They are designing inside the project "Petrokim complaints" (active, for Petrokim). Agents for the supplier complaint process.',
    );
    expect(row!.setup.system).toContain("- In the brain: Supplier portal — System · Where suppliers upload invoices");
    expect((row!.setup.tools as { name: string }[]).map((t) => t.name)).toEqual(
      expect.arrayContaining(["project_add_asset", "project_add_task", "save_ai_employee", "company_search"]),
    );

    // look_around shows the project as it stands.
    const around = JSON.parse(lookedAround) as { project: { name: string; uses: string[]; open_tasks_for_person: string[] } };
    expect(around.project.name).toBe("Petrokim complaints");
    expect(around.project.uses).toEqual(["In the brain: Supplier portal — System · Where suppliers upload invoices"]);
    expect(around.project.open_tasks_for_person).toEqual([]);

    // What it added shows in the conversation, in the project and in the brain.
    const parts = view.events.filter((e) => e.kind === "part").map((e) => e.data);
    expect(parts).toEqual([
      expect.objectContaining({ part: "asset", kind: "thing", name: "Petrokim" }),
      expect.objectContaining({ part: "asset", kind: "table", name: "Supplier complaints", ref: "supplier_complaints" }),
      expect.objectContaining({ part: "todo", title: "Get the API credentials from Petrokim", created: true }),
      expect.objectContaining({ part: "todo", title: "Get the API credentials from Petrokim", created: false }),
      expect.objectContaining({ part: "ai_employee", name: "Complaint Handler" }),
    ]);
    expect(assetResults[0]).toContain('"added"');
    expect(JSON.parse(assetResults[1]!)).toMatchObject({
      added: { kind: "table", name: "Supplier complaints" },
      project_now_uses: expect.arrayContaining([expect.stringContaining("Table: Supplier complaints")]),
    });
    expect(assetResults[2]).toContain('No thing in the brain called "Nothing of that name"');
    const assets = (await call("GET", `/projects/${project.slug}/assets`)).json() as {
      assets: { kind: string; name: string; note: string; addedBy: { name: string } }[];
    };
    expect(assets.assets.map((a) => [a.kind, a.name])).toEqual([
      ["thing", "Petrokim"],
      ["thing", "Supplier portal"],
      ["table", "Supplier complaints"],
    ]);
    expect(assets.assets[0]).toMatchObject({ note: "The client", addedBy: { name: "The Studio" } });

    // The task is Selin's, once, due in November, pointing back at the conversation.
    const todos = (await call("GET", "/todos")).json() as { title: string; source: string; link: string; dueAt: string; project: { slug: string } }[];
    expect(todos).toEqual([
      expect.objectContaining({
        title: "Get the API credentials from Petrokim",
        source: "studio",
        link: `/studio/conversations/${id}`,
        project: { id: project.id, slug: project.slug, name: "Petrokim complaints" },
      }),
    ]);
    expect(todos[0]!.dueAt.slice(0, 10)).toBe("2026-11-15");

    // The AI employee it wrote is a design of the project.
    const designs = (await call("GET", `/projects/${project.slug}/designs`)).json() as {
      threads: { id: string; agentIds: string[]; canOpen: boolean }[];
      agents: { name: string; from: string }[];
    };
    expect(designs.threads).toEqual([expect.objectContaining({ id, canOpen: true })]);
    expect(designs.threads[0]!.agentIds.length).toBe(1);
    expect(designs.agents).toEqual([expect.objectContaining({ name: "Complaint Handler", from: "studio" })]);
    const list = (await call("GET", "/studio/threads")).json() as { id: string; project: { slug: string } | null }[];
    expect(list.find((x) => x.id === id)?.project?.slug).toBe(project.slug);
    expect(((await call("GET", `/projects/${project.slug}`)).json() as { counts: { designs: number; openTodos: number } }).counts).toMatchObject({
      designs: 1,
      openTodos: 1,
    });
  });

  it("refuses the project tools outside a project, and a thread for a project that does not exist", async () => {
    expect((await call("POST", "/studio/threads", { text: "x", projectId: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    const started = await call("POST", "/studio/threads", { text: "Handle complaints, no project." });
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as ThreadView).id;
    const view = await until(
      () => thread(id),
      (v) => v.status === "idle" || v.status === "failed",
      "the Studio's turn",
    );
    expect(view.status).toBe("idle");
    expect(view.project).toBeNull();
    const [row] = await t.platform.handle.db.select().from(studioThreads).where(eq(studioThreads.id, id));
    expect((row!.setup.tools as { name: string }[]).some((t) => t.name === "project_add_asset")).toBe(false);
    expect(row!.setup.system).not.toContain("The project");
    expect(refused).toBe("This conversation is not in a project.");
    expect(view.events.some((e) => e.kind === "part")).toBe(false);
  });
});
