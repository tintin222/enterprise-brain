import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { departments, runs } from "@enterprise-brain/db";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { BudgetError, Platform, monthStartIn, type AgentRecord } from "../src/index.ts";

/**
 * Budgets per AI employee and per department: at its department's limit, every AI employee of the
 * department stops starting work, and their managers hear it once a month.
 */

let platform: Platform;
let companyId: string;
let financeId: string;
let first: AgentRecord;
let second: AgentRecord;
let other: AgentRecord;
const managers: Record<string, string> = {};

const spend = async (agent: AgentRecord, usd: number, at = new Date()) => {
  await platform.handle.db.insert(runs).values({ companyId, agentId: agent.row.id, status: "succeeded", usage: { costUsd: usd }, createdAt: at });
};

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-budgets-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme", settings: { timeZone: "Europe/Istanbul" } })).id;
  const [finance] = await platform.handle.db.insert(departments).values({ companyId, key: "finance", name: "Finance" }).returning();
  const [hr] = await platform.handle.db.insert(departments).values({ companyId, key: "hr", name: "HR" }).returning();
  financeId = finance!.id;
  for (const [key, name] of [
    ["burak", "Burak Şahin"],
    ["selin", "Selin Er"],
  ] as const) {
    managers[key] = (
      await platform.people.create(companyId, { email: `${key}@acme.test`, name, departments: [{ departmentId: financeId, role: "manager" }] })
    ).id;
  }
  const definition = (slug: string) => ({
    slug,
    name: slug,
    summary: "Works.",
    archetype: "process-automation" as const,
    instructions: "Work.",
    workflow: [{ id: "done", type: "output" as const, value: { ok: true } }],
  });
  first = await platform.agents.create(companyId, {
    definition: definition("ap-clerk"),
    status: "active",
    departmentId: financeId,
    managerUserId: managers.burak,
  });
  second = await platform.agents.create(companyId, {
    definition: definition("ar-clerk"),
    status: "active",
    departmentId: financeId,
    managerUserId: managers.selin,
  });
  other = await platform.agents.create(companyId, { definition: definition("recruiter"), status: "active", departmentId: hr!.id });
});
afterAll(async () => {
  await platform?.close();
});

describe("department budgets", () => {
  it("stops every AI employee of the department at its budget, and tells their managers once", async () => {
    await platform.catalog.setDepartmentBudget(companyId, financeId, 0.05, "Burak Şahin");
    // Last month's work doesn't count, this month's does: together they reach the budget.
    const lastMonth = new Date(monthStartIn(new Date(), "Europe/Istanbul").getTime() - 3_600_000);
    await spend(first, 1, lastMonth);
    await spend(first, 0.03);
    expect(await platform.engine.departmentCostThisMonth(companyId, financeId)).toBeCloseTo(0.03);
    expect((await platform.engine.start(companyId, "ar-clerk", {}, { wait: true })).status).toBe("succeeded");
    await spend(second, 0.03);

    await expect(platform.engine.start(companyId, "ap-clerk", {})).rejects.toThrow(BudgetError);
    await expect(platform.engine.start(companyId, "ar-clerk", {})).rejects.toThrow(/Finance reached its monthly budget for AI employees \(\$0\.05\)/);
    // Another department's AI employee works on; test runs aren't held up.
    expect((await platform.engine.start(companyId, "recruiter", {}, { wait: true })).status).toBe("succeeded");
    expect((await platform.engine.start(companyId, "ap-clerk", {}, { wait: true, isTest: true })).status).toBe("succeeded");

    const notices = (await platform.work.list(companyId, { statuses: ["open"] })).filter((w) => w.kind === "notice" && w.title.startsWith("Finance reached"));
    expect(notices.map((n) => n.assigneeUserId).sort()).toEqual([managers.burak, managers.selin].sort());
    expect(notices.find((n) => n.assigneeUserId === managers.burak)?.details).toMatch(/so ap-clerk start no new work/);
    const activity = await platform.activity.list(companyId, 20);
    expect(activity.filter((a) => a.action === "department.budget_reached")).toHaveLength(1);

    const view = await platform.employment.view(companyId, await platform.agents.get(companyId, "ap-clerk"));
    expect(view).toMatchObject({ stoppedByBudget: true, departmentBudget: { name: "Finance", budgetUsd: 0.05, reached: true } });
    expect((await platform.employment.view(companyId, other)).departmentBudget).toBeNull();
  });

  it("lets them work again once a manager raises it", async () => {
    await platform.catalog.setDepartmentBudget(companyId, financeId, 1, "Burak Şahin");
    expect((await platform.engine.start(companyId, "ap-clerk", {}, { wait: true })).status).toBe("succeeded");
    expect((await platform.employment.view(companyId, await platform.agents.get(companyId, "ap-clerk"))).stoppedByBudget).toBe(false);
    await platform.catalog.setDepartmentBudget(companyId, financeId, null, "Burak Şahin");
    expect((await platform.employment.view(companyId, await platform.agents.get(companyId, "ap-clerk"))).departmentBudget).toBeNull();
    const set = (await platform.activity.list(companyId, 50)).filter((a) => a.action === "department.budget_set").map((a) => a.summary);
    expect(set).toEqual(expect.arrayContaining(["Finance: monthly budget $0.05", "Finance: monthly budget $1.00", "Finance: no monthly budget"]));
  });
});
