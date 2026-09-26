import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinitionInput } from "@enterprise-brain/core";
import { eq } from "drizzle-orm";
import { companies, departments } from "@enterprise-brain/db";
import { LocalHashEmbedder, ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import {
  ActionLinks,
  LinkError,
  Platform,
  localTime,
  readPreferences,
  summaryDue,
  type ChannelSender,
  type DeliveryRef,
  type HandledItem,
  type ItemMessage,
  type Person,
  type SummaryMessage,
} from "../src/index.ts";

/**
 * What reaches people outside the app: an approval arrives at once by email with buttons, to the
 * people who may decide it, once; the rest waits for the morning summary in each person's time zone;
 * a chat channel is preferred when it reaches the person, email takes over when it fails; handled
 * items update the cards already delivered; and only one decision wins when people act at once.
 */

const firstMessage = (request: ToolLoopRequest) => String((request.messages[0] as { content: unknown }).content);

const llm = new ScriptedLlm({
  "runtime.agent": {
    tools: (request, turn) => {
      const brief = firstMessage(request);
      const to = /customer (\w+)/.exec(brief)?.[1] ?? "jane";
      if (/Email the customer/.test(brief) && turn === 1) {
        return { calls: [{ name: "mail_send", input: { to: `${to}@customer.example`, subject: "Your order", body: "Your order ships tomorrow." } }] };
      }
      return { text: "Waiting for the approval." };
    },
  },
});

const clerk: AgentDefinitionInput = {
  slug: "ap-clerk",
  name: "AP Clerk",
  summary: "Handles supplier invoices.",
  archetype: "process-automation",
  instructions: "Handle invoices.",
  tools: ["mail.send"],
};

/** A chat channel that records what it sends (Teams stands in for any). */
class FakeChat implements ChannelSender {
  readonly id = "teams" as const;
  readonly items: ItemMessage[] = [];
  readonly summaries: SummaryMessage[] = [];
  readonly updates: HandledItem[] = [];
  failing = false;

  constructor(private readonly members: Set<string>) {}

  async reaches(_companyId: string, person: Person) {
    return this.members.has(person.email);
  }

  async sendItem(message: ItemMessage): Promise<DeliveryRef> {
    if (this.failing) throw new Error("Teams is unreachable");
    this.items.push(message);
    return { activityId: `card-${this.items.length}` };
  }

  async sendSummary(message: SummaryMessage): Promise<DeliveryRef> {
    this.summaries.push(message);
    return { activityId: "summary" };
  }

  async updateItem(handled: HandledItem): Promise<void> {
    this.updates.push(handled);
  }
}

let platform: Platform;
let companyId: string;
const people: Record<string, Person> = {};

const outbound = async (to: string) => (await platform.mail.list(companyId, { direction: "outbound" })).filter((m) => m.toAddresses.includes(to));

async function pendingApproval(customer: string) {
  const run = await platform.engine.start(companyId, "ap-clerk", {}, { task: `Email the customer ${customer} that the order ships tomorrow.` });
  const task = await platform.tasks.get(companyId, (await platform.engine.getRow(companyId, run.id)).taskId!);
  const [approval] = await platform.tasks.approvalsOf(task.id, "pending");
  return { task, approval: approval! };
}

beforeAll(async () => {
  platform = await Platform.create({ dataDir: mkdtempSync(join(tmpdir(), "eb-notify-")), inMemory: true, llm, embedder: new LocalHashEmbedder(), env: {} });
  platform.notifications.configure({ publicUrl: "https://brain.acme.test/" });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme Makina" })).id;
  const [finance] = await platform.handle.db.insert(departments).values({ companyId, key: "finance", name: "Finance" }).returning();
  const [hr] = await platform.handle.db.insert(departments).values({ companyId, key: "hr", name: "HR" }).returning();
  const add = async (key: string, name: string, departmentId: string, role: "manager" | "worker" = "worker") =>
    (people[key] = await platform.people.create(companyId, { email: `${key}@acme.test`, name, departments: [{ departmentId, role }] }));
  await add("ayse", "Ayşe Yılmaz", finance!.id);
  await add("burak", "Burak Şahin", finance!.id, "manager");
  await add("deniz", "Deniz Kaya", finance!.id);
  await add("ece", "Ece Demir", finance!.id);
  await add("can", "Can Öztürk", hr!.id);
  await platform.people.update(companyId, people.ece!.id, { status: "disabled" });
  await platform.notifications.setPreferences(companyId, people.deniz!.id, { deliver: "summary" });
  await platform.agents.create(companyId, { definition: clerk, status: "active", departmentId: finance!.id, managerUserId: people.burak!.id });
});
afterAll(async () => {
  await platform?.close();
});

describe("approvals by email", () => {
  it("emails an approval at once, with buttons, to the people who may decide it, once", async () => {
    const { approval } = await pendingApproval("jane");
    expect(await platform.notifications.dispatch(companyId)).toBe(2);
    expect(await platform.notifications.dispatch(companyId)).toBe(0);

    const [mail] = await outbound("ayse@acme.test");
    expect(mail!.subject).toBe("Approve? Send email to jane@customer.example");
    expect(mail!.bodyHtml).toContain("Your order ships tomorrow.");
    const link = /https:\/\/brain\.acme\.test\/act\/([\w.-]+)\?choice=approve/.exec(mail!.bodyHtml!);
    expect(link, mail!.bodyHtml!).toBeTruthy();
    expect(mail!.bodyText).toContain(`Approve: https://brain.acme.test/act/${link![1]}?choice=approve`);
    expect(mail!.bodyText).toContain("Change what reaches you: https://brain.acme.test/?notifications=1");
    // The link acts for Ayşe, on this approval only.
    expect(platform.actionLinks.verify(link![1]!)).toMatchObject({ companyId, userId: people.ayse!.id, type: "approval", id: approval.id });

    expect(await outbound("burak@acme.test")).toHaveLength(1);
    // Deniz wants only a summary, Ece is disabled, and Can works in HR.
    for (const key of ["deniz", "ece", "can"]) expect(await outbound(`${key}@acme.test`)).toHaveLength(0);
  });

  it("leaves checks and notices for the summary, unless a person wants everything at once", async () => {
    const finance = people.ayse!.departments[0]!.departmentId;
    await platform.work.create(companyId, { kind: "notice", title: "The ERP connection was slow today", departmentId: finance });
    await platform.notifications.setPreferences(companyId, people.burak!.id, { deliver: "all" });
    expect(await platform.notifications.dispatch(companyId)).toBe(1);
    expect((await outbound("burak@acme.test")).map((m) => m.subject)).toContain("The ERP connection was slow today");
    expect((await outbound("ayse@acme.test")).map((m) => m.subject)).not.toContain("The ERP connection was slow today");
    await platform.notifications.setPreferences(companyId, people.burak!.id, { deliver: "urgent" });
  });
});

describe("chat channels", () => {
  it("uses a chat channel that reaches the person, updates its card when the item is handled, and falls back to email", async () => {
    const chat = new FakeChat(new Set(["ayse@acme.test", "burak@acme.test"]));
    platform.notifications.register(chat);
    // Burak chose email; Ayşe leaves it to the app (auto: Teams first).
    await platform.notifications.setPreferences(companyId, people.burak!.id, { channel: "email" });
    platform.notifications.start(0);
    try {
      const { approval } = await pendingApproval("mehmet");
      await platform.notifications.idle();
      expect(chat.items.map((m) => [m.person.name, m.entry.id])).toEqual([["Ayşe Yılmaz", approval.id]]);
      expect(chat.items[0]!.links.open).toMatch(/^https:\/\/brain\.acme\.test\/work\/EB-/);
      expect((await outbound("burak@acme.test")).some((m) => m.subject.includes("mehmet@customer.example"))).toBe(true);
      expect((await outbound("ayse@acme.test")).some((m) => m.subject.includes("mehmet@customer.example"))).toBe(false);

      await platform.engine.decide(companyId, approval.id, { approved: true, decidedBy: "Burak Şahin", via: "email" });
      await platform.notifications.idle();
      expect(chat.updates).toHaveLength(1);
      expect(chat.updates[0]).toMatchObject({ by: "Burak Şahin", outcome: "approved", ref: { activityId: "card-1" }, entry: { status: "approved" } });
      const audit = (await platform.activity.list(companyId, 50)).find((a) => a.action === "approval.approved");
      expect(audit).toMatchObject({ actor: "Burak Şahin", summary: "Approved in an email: Send email to mehmet@customer.example" });

      // Teams fails: the next attempt, minutes later, goes by email.
      chat.failing = true;
      const second = await pendingApproval("selin");
      await platform.notifications.idle();
      const [failed] = (await platform.notifications.sentTo(companyId, people.ayse!.id)).filter((n) => n.itemId === second.approval.id);
      expect(failed).toMatchObject({ status: "failed", channel: "teams", error: "Teams is unreachable", attempts: 1 });
      expect(await platform.notifications.dispatch(companyId, new Date(Date.now() + 60_000))).toBe(0);
      expect(await platform.notifications.dispatch(companyId, new Date(Date.now() + 6 * 60_000))).toBe(1);
      const [retried] = (await platform.notifications.sentTo(companyId, people.ayse!.id)).filter((n) => n.itemId === second.approval.id);
      expect(retried).toMatchObject({ status: "sent", channel: "email", attempts: 2 });
      expect((await outbound("ayse@acme.test")).some((m) => m.subject.includes("selin@customer.example"))).toBe(true);
    } finally {
      chat.failing = false;
      await platform.notifications.stop();
      await platform.notifications.setPreferences(companyId, people.burak!.id, { channel: "auto" });
    }
  });

  it("lets only one decision win when people act at once", async () => {
    const { approval } = await pendingApproval("ali");
    const results = await Promise.allSettled([
      platform.engine.decide(companyId, approval.id, { approved: true, decidedBy: "Ayşe Yılmaz" }),
      platform.engine.decide(companyId, approval.id, { approved: false, decidedBy: "Burak Şahin" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [lost] = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(String(lost!.reason.message)).toMatch(/^Approval is already (approved by Ayşe Yılmaz|rejected by Burak Şahin)$/);
    expect(lost!.reason.status).toBe(409);
  });
});

describe("morning summary", () => {
  it("arrives once, at the person's time in their time zone, with what needs them and what their AI employees did", async () => {
    await platform.notifications.setPreferences(companyId, people.deniz!.id, { summaryAt: "08:30", timeZone: "Europe/Istanbul" });
    const day = new Date();
    const at = (hour: number, minute: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute));
    // 08:00 in Istanbul (UTC+3): not yet.
    expect(await platform.notifications.summaries(companyId, at(5, 0))).toBe(0);
    const sent = await platform.notifications.summaries(companyId, at(5, 31));
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(await platform.notifications.summaries(companyId, at(5, 45))).toBe(0);

    const [summary] = (await outbound("deniz@acme.test")).filter((m) => m.subject.startsWith("Good morning"));
    expect(summary!.subject).toMatch(/^Good morning, Deniz: \d+ things need you$/);
    // Open items only: the one decided above is gone.
    expect(summary!.bodyText).toContain("- Send email to selin@customer.example (AP Clerk · EB-");
    expect(summary!.bodyText).toContain("- The ERP connection was slow today: https://brain.acme.test/act/");
    expect(summary!.bodyText).not.toContain("ali@customer.example");
    expect(summary!.bodyText).toMatch(/- AP Clerk: \d+ done, \d+ started, \d+ waiting for a person/);
    expect(summary!.bodyHtml).toContain("https://brain.acme.test/ai/ap-clerk");
    // Can has nothing to hear about: no empty message.
    expect(await outbound("can@acme.test")).toHaveLength(0);
    // Nobody gets one when their preferences say "only in the app".
    await platform.notifications.setPreferences(companyId, people.deniz!.id, { deliver: "off" });
    expect(await platform.notifications.summaries(companyId, at(5, 50))).toBe(0);
  });

  it("reads a person's local time and summary window", () => {
    const now = new Date("2026-09-26T21:45:00Z");
    expect(localTime(now, "Europe/Istanbul")).toEqual({ date: "2026-09-27", minutes: 45 });
    expect(localTime(now, "America/New_York")).toEqual({ date: "2026-09-26", minutes: 17 * 60 + 45 });
    expect(summaryDue(new Date("2026-09-26T05:30:00Z"), { summaryAt: "08:30", timeZone: "Europe/Istanbul" })).toBe(true);
    expect(summaryDue(new Date("2026-09-26T09:30:00Z"), { summaryAt: "08:30", timeZone: "Europe/Istanbul" })).toBe(false);
  });
});

describe("preferences", () => {
  it("validates what a person chooses and keeps the rest", async () => {
    await expect(platform.notifications.setPreferences(companyId, people.can!.id, { timeZone: "Mars/Olympus" })).rejects.toThrow(/Unknown time zone/);
    await expect(platform.notifications.setPreferences(companyId, people.can!.id, { summaryAt: "8:30" })).rejects.toThrow(/HH:MM/);
    expect(await platform.notifications.setPreferences(companyId, people.can!.id, { deliver: "all" })).toEqual({
      deliver: "all",
      channel: "auto",
      summaryAt: "08:30",
      timeZone: "Europe/Istanbul",
    });
    // A change keeps the earlier choices; what nobody chose follows the company's time zone.
    await platform.notifications.setPreferences(companyId, people.can!.id, { channel: "email" });
    await platform.handle.db
      .update(companies)
      .set({ settings: { timeZone: "Europe/London" } })
      .where(eq(companies.id, companyId));
    expect(await platform.notifications.setPreferences(companyId, people.can!.id, { summaryAt: "07:45" })).toEqual({
      deliver: "all",
      channel: "email",
      summaryAt: "07:45",
      timeZone: "Europe/London",
    });
    await platform.handle.db.update(companies).set({ settings: {} }).where(eq(companies.id, companyId));
    // A stored value that is no longer valid falls back to its default; the others stay.
    expect(readPreferences({ deliver: "summary", timeZone: "Nowhere/City" }, { timeZone: "Europe/Berlin" })).toEqual({
      deliver: "summary",
      channel: "auto",
      summaryAt: "08:30",
      timeZone: "Europe/Berlin",
    });
  });
});

describe("action links", () => {
  const links = new ActionLinks(Buffer.alloc(32, 7));
  const claim = {
    companyId: "8f14e45f-ceea-4e67-a5b2-5f1e2b4c7d01",
    userId: "c9f0f895-fb98-4b91-9f6e-1c2d3e4f5a02",
    type: "approval" as const,
    id: "45c48cce-2e2d-4fbd-8a6b-7c8d9e0f1a03",
    via: "email",
  };

  it("acts for one person on one item until it expires, in a short link", () => {
    const token = links.sign(claim, { now: Date.UTC(2026, 8, 26) });
    expect(token).toMatch(/^[\w-]{95}$/);
    expect(links.verify(token, Date.UTC(2026, 8, 27))).toEqual({ ...claim, expiresAt: new Date(Date.UTC(2026, 9, 3)) });
    expect(() => links.verify(token, Date.UTC(2026, 9, 4))).toThrow(/expired/);
    try {
      links.verify(token, Date.UTC(2026, 9, 4));
    } catch (error) {
      expect((error as LinkError).statusCode).toBe(410);
    }
    expect(links.verify(links.sign({ ...claim, via: undefined }))).not.toHaveProperty("via");
  });

  it("refuses a link that was changed or signed with another key", () => {
    const token = links.sign(claim);
    const bytes = Buffer.from(token, "base64url");
    bytes[20] = bytes[20]! ^ 1; // another person
    expect(() => links.verify(bytes.toString("base64url"))).toThrow(/not valid/);
    expect(() => new ActionLinks(Buffer.alloc(32, 8)).verify(token)).toThrow(/not valid/);
    expect(() => links.verify("nonsense")).toThrow(/not valid/);
    expect(() => links.verify(`${token}.x`)).toThrow(/not valid/);
  });
});
