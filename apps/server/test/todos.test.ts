import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * A person's own to-dos over HTTP: added by hand with a due day, listed due-soonest first, done,
 * dismissed and reopened; never another person's; the same source makes one to-do only; and nothing
 * without a signed-in person.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Todo {
  id: string;
  title: string;
  details: string;
  dueAt: string | null;
  status: string;
  source: string;
  link: string | null;
  project: { id: string; slug: string; name: string } | null;
  doneAt: string | null;
}

describe("to-dos over HTTP", () => {
  let t: TestApp;
  let companyId = "";
  const as: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    t = await createTestApp({ config: ACCOUNTS, seed: false });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    for (const local of ["kerem.yildiz", "selin.acar"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it("adds, lists due-soonest first, finishes, dismisses and reopens; a title is needed and a date must be one", async () => {
    const later = await call("kerem.yildiz", "POST", "/todos", { title: "Write the proposal", dueAt: "2026-12-01" });
    expect(later.statusCode, later.body).toBe(200);
    const soon = await call("kerem.yildiz", "POST", "/todos", { title: "Call Petrokim back", details: "About the flanges", dueAt: "2026-10-20" });
    const undated = await call("kerem.yildiz", "POST", "/todos", { title: "  Tidy the lab  " });
    expect((undated.json() as Todo).title).toBe("Tidy the lab");
    expect((await call("kerem.yildiz", "POST", "/todos", { title: "   " })).statusCode).toBe(400);
    expect((await call("kerem.yildiz", "POST", "/todos", { title: "x", dueAt: "someday" })).statusCode).toBe(400);
    expect((await call("kerem.yildiz", "POST", "/todos", { title: "x", projectId: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);

    let open = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    expect(open.map((x) => x.title)).toEqual(["Call Petrokim back", "Write the proposal", "Tidy the lab"]);
    expect(open[0]).toMatchObject({ status: "open", source: "manual", details: "About the flanges", project: null, doneAt: null });

    const id = (soon.json() as Todo).id;
    const done = await call("kerem.yildiz", "PATCH", `/todos/${id}`, { status: "done" });
    expect(done.statusCode, done.body).toBe(200);
    expect((done.json() as Todo).doneAt).toBeTruthy();
    open = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    expect(open.map((x) => x.title)).toEqual(["Write the proposal", "Tidy the lab"]);
    expect(((await call("kerem.yildiz", "GET", "/todos?status=done")).json() as Todo[]).map((x) => x.title)).toEqual(["Call Petrokim back"]);

    const dismissed = await call("kerem.yildiz", "PATCH", `/todos/${(later.json() as Todo).id}`, { status: "dismissed" });
    expect((dismissed.json() as Todo).status).toBe("dismissed");
    const reopened = await call("kerem.yildiz", "PATCH", `/todos/${id}`, { status: "open", title: "Call Petrokim back today", dueAt: null });
    expect(reopened.json()).toMatchObject({ status: "open", title: "Call Petrokim back today", dueAt: null, doneAt: null });
    expect(((await call("kerem.yildiz", "GET", "/todos?status=all")).json() as Todo[]).length).toBe(3);
  });

  it("is each person's own: nobody else lists, changes or removes them", async () => {
    const mine = (await call("kerem.yildiz", "GET", "/todos")).json() as Todo[];
    expect(mine.length).toBe(2);
    expect((await call("selin.acar", "GET", "/todos")).json()).toEqual([]);
    expect((await call("selin.acar", "PATCH", `/todos/${mine[0]!.id}`, { status: "done" })).statusCode).toBe(404);
    expect((await call("selin.acar", "DELETE", `/todos/${mine[0]!.id}`)).statusCode).toBe(404);
    expect((await call("kerem.yildiz", "DELETE", `/todos/${mine[0]!.id}`)).statusCode).toBe(200);
    expect(((await call("kerem.yildiz", "GET", "/todos")).json() as Todo[]).length).toBe(1);
  });

  it("makes one to-do per source: the same mail read twice is one to-do", async () => {
    const userId = (await t.platform.people.findByEmail(companyId, "kerem.yildiz@acme.com.tr"))!.id;
    const by = { kind: "system" as const, id: "mail", name: "Gmail" };
    const first = await t.platform.todos.add(
      companyId,
      { userId, title: "Reply to Ayşe: offer", source: "mail", sourceRef: "msg-1", link: "https://mail.google.com/#all/msg-1" },
      by,
    );
    const second = await t.platform.todos.add(companyId, { userId, title: "Reply to Ayşe: offer (again)", source: "mail", sourceRef: "msg-1" }, by);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.todo.id).toBe(first.todo.id);
    const other = await t.platform.todos.add(companyId, { userId, title: "Reply to Ayşe: offer", source: "studio", sourceRef: "msg-1" }, by);
    expect(other.created).toBe(true);
    expect(await t.platform.todos.countOpen(companyId, userId)).toBe(3);
  });
});

describe("to-dos without a signed-in person", () => {
  it("are nobody's: open mode answers 409", async () => {
    const t = await createTestApp({ seed: false });
    try {
      const listed = await t.app.inject({ method: "GET", url: `${base}/todos` });
      expect(listed.statusCode).toBe(409);
      expect((listed.json() as { error: string }).error).toMatch(/Sign in/);
      expect((await t.app.inject({ method: "POST", url: `${base}/todos`, payload: { title: "x" } })).statusCode).toBe(409);
    } finally {
      await t.close();
    }
  });
});
