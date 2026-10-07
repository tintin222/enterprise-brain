import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversations, chatMessages } from "@enterprise-brain/db";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Conversations over the API: people and AI employees in one thread. A person names an AI employee
 * with "@" and it answers in a run; a Supervised AI employee's email becomes an approval card in the
 * conversation, decided from the work queue; the company brain is a participant; a task has a
 * conversation whose comments wake the task; mentions follow what their author may see; the older
 * chats become conversations.
 */

const ACCOUNTS = { auth: { mode: "accounts" as const, sessionHours: 1, providers: [] } };
const base = "/api/companies/acme";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const found = (Array.isArray(header) ? header : [header]).map(String).find((c) => c.startsWith("eb_session="));
  if (!found) throw new Error("no session cookie");
  return found.split(";")[0]!;
}

interface Message {
  id: string;
  seq: number;
  kind: string;
  author: { kind: string; id: string; name: string };
  text: string;
  plain: string;
  mentions: { kind: string; id: string; name: string; allowed: boolean; href: string | null }[];
  runId: string | null;
  card: { type: string; id: string; status: string; canHandle: boolean; title: string } | null;
  data: Record<string, unknown>;
}

interface ConversationView {
  conversation: { id: string; kind: string; title: string; lastSeq: number; visibility: string };
  participants: { actorKind: string; actorId: string; actorName: string; role: string; readSeq: number }[];
  me: { readSeq: number } | null;
  canInvite: boolean;
}

interface Summary {
  conversation: { id: string; title: string };
  unread: number;
  mentionsMe: number;
  lastMessage: { text: string } | null;
}

const briefOf = (request: ToolLoopRequest) => {
  const first = request.messages[0];
  return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
};

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("conversations", () => {
  let t: TestApp;
  let companyId: string;
  let helperId: string;
  let clerkId: string;
  let elifId: string;
  let burakId: string;
  const as: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const messages = async (who: string, id: string) => (await call(who, "GET", `/conversations/${id}/messages`)).json() as Message[];
  const aiMessages = (list: Message[]) => list.filter((m) => m.kind === "text" && m.author.kind === "ai_employee");

  beforeAll(async () => {
    const llm = new ScriptedLlm({
      "runtime.agent:invoice-helper.turn": {
        tools: (request, turn, results) => {
          const brief = briefOf(request);
          if (/approved "Send email/.test(brief)) return { text: "Sent the reminder to ap@customer.example." };
          if (/send the reminder/i.test(brief) && turn === 1) {
            return {
              calls: [{ name: "mail_send", input: { to: "ap@customer.example", subject: "Overdue invoice INV-9", body: "Please pay invoice INV-9." } }],
            };
          }
          if (results.some((r) => /approval/.test(r)))
            return { text: "I prepared the reminder; it waits for @[Burak Şahin](person:" + burakId + ")'s approval." };
          if (/@\[VBAK\]|VBAK/.test(brief)) return { text: "VBAK holds the sales orders; I read its card." };
          if (/confirms the amounts/.test(brief)) return { text: "Confirmed, @[Payment Clerk](ai_employee:" + clerkId + "): 12,400 TRY." };
          return { text: `Hello! I read ${/New messages/.test(brief) ? "your message" : "nothing"}.` };
        },
      },
      "runtime.agent:payment-clerk.turn": {
        tools: () => ({ text: `I pay once @[Invoice Helper](ai_employee:${helperId}) confirms the amounts.` }),
      },
      "runtime.agent:invoice-helper.task": {
        tools: (request) => {
          const brief = briefOf(request);
          if (/conversation/.test(brief) && /urgent/i.test(brief)) return { text: "Understood: I will treat INV-9 as urgent." };
          return { text: "Reminder prepared." };
        },
      },
      "runtime.agent:company-brain.turn": {
        tools: () => ({ text: "Supplier invoices above 250,000 TRY are approved by Burak Şahin in SAP S/4HANA." }),
      },
    });
    t = await createTestApp({ llm, config: ACCOUNTS });
    const company = (await t.platform.company("acme"))!;
    companyId = company.id;
    await seedDemoPeople(t.platform, company);
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    const helper = await t.platform.agents.create(companyId, {
      definition: {
        slug: "invoice-helper",
        name: "Invoice Helper",
        title: "Helps with supplier invoices",
        summary: "Answers questions about invoices and sends reminders.",
        archetype: "conversational",
        instructions: "Help with invoices.",
        tools: ["mail.send"],
      },
      status: "active",
      departmentId: finance.id,
      probation: "supervised",
    });
    helperId = helper.row.id;
    const clerk = await t.platform.agents.create(companyId, {
      definition: {
        slug: "payment-clerk",
        name: "Payment Clerk",
        title: "Pays supplier invoices",
        summary: "Pays invoices once they are confirmed.",
        archetype: "conversational",
        instructions: "Pay invoices.",
      },
      status: "active",
      departmentId: finance.id,
      probation: "supervised",
    });
    clerkId = clerk.row.id;
    await t.platform.employment.assignDefaultManagers(companyId);
    for (const local of ["burak.sahin", "elif.arslan", "deniz.aydin", "mehmet.oz"]) {
      as[local] = cookieFrom(await t.app.inject({ method: "POST", url: "/api/auth/demo", payload: { email: `${local}@acme.com.tr` } }));
    }
    const people = await t.platform.people.list(companyId);
    elifId = people.find((p) => p.email.startsWith("elif."))!.id;
    burakId = people.find((p) => p.email.startsWith("burak."))!.id;
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it("makes the company brain a hidden AI employee of every company", async () => {
    const listed = (await call("mehmet.oz", "GET", "/agents")).json() as { slug: string }[];
    expect(listed.some((a) => a.slug === "company-brain")).toBe(false);
    const brain = await t.platform.agents.find(companyId, "company-brain");
    expect(brain?.row.source).toBe("system");
    expect(brain?.row.status).toBe("active");
  });

  let topicId: string;

  it("starts a topic; the named AI employee joins and answers in a run, the named colleague joins", async () => {
    const started = await call("burak.sahin", "POST", "/conversations", {
      text: `@[Invoice Helper](ai_employee:${helperId}) hello, and @[Elif Arslan](person:${elifId}) please follow this.`,
    });
    expect(started.statusCode, started.body).toBe(200);
    const view = started.json() as ConversationView;
    topicId = view.conversation.id;
    expect(view.conversation.kind).toBe("topic");
    expect(view.conversation.title).toContain("@Invoice Helper hello");
    expect(view.participants.map((p) => p.actorKind).sort()).toEqual(["ai_employee", "person", "person"]);
    expect(view.canInvite).toBe(true);
    const reply = await until(async () => aiMessages(await messages("burak.sahin", topicId))[0], "the AI employee's reply");
    expect(reply.text).toBe("Hello! I read your message.");
    expect(reply.runId).toBeTruthy();
    const run = await t.platform.engine.getRow(companyId, reply.runId!);
    expect(run.trigger).toBe("conversation");
    expect(run.triggerRef).toBe(topicId);
    expect(run.taskId).toBeNull();
    expect(reply.data.answersSeq).toBe(1);
  });

  it("is seen by its participants and hidden from others", async () => {
    expect((await call("elif.arslan", "GET", `/conversations/${topicId}`)).statusCode).toBe(200);
    expect((await call("deniz.aydin", "GET", `/conversations/${topicId}`)).statusCode).toBe(404);
    const mine = (await call("elif.arslan", "GET", "/conversations?scope=mine")).json() as Summary[];
    expect(mine.map((s) => s.conversation.id)).toContain(topicId);
    expect((await call("deniz.aydin", "GET", "/conversations?scope=department")).json()).toEqual([]);
  });

  it("counts what a person has not read, and their mentions", async () => {
    const list = (await call("elif.arslan", "GET", "/conversations?scope=mine")).json() as Summary[];
    const mine = list.find((s) => s.conversation.id === topicId)!;
    expect(mine.unread).toBe(2);
    expect(mine.mentionsMe).toBe(1);
    expect(mine.lastMessage?.text).toContain("Hello!");
    await call("elif.arslan", "POST", `/conversations/${topicId}/read`, { seq: 2 });
    const after = ((await call("elif.arslan", "GET", "/conversations?scope=mine")).json() as Summary[]).find((s) => s.conversation.id === topicId)!;
    expect(after.unread).toBe(0);
    expect(after.mentionsMe).toBe(0);
  });

  it("turns a Supervised AI employee's email into an approval card, decided from the work queue, and the AI follows up", async () => {
    const posted = await call("elif.arslan", "POST", `/conversations/${topicId}/messages`, {
      text: `@[Invoice Helper](ai_employee:${helperId}) please send the reminder to ap@customer.example`,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    const card = await until(async () => (await messages("burak.sahin", topicId)).find((m) => m.kind === "card"), "the approval card");
    expect(card.card?.type).toBe("approval");
    expect(card.card?.status).toBe("pending");
    expect(card.card?.canHandle).toBe(true);
    expect(card.card?.title).toContain("Send email to ap@customer.example");
    await until(async () => (await messages("burak.sahin", topicId)).some((m) => /waits for @\[Burak/.test(m.text)), "the AI employee saying it waits");
    const elifCard = (await messages("elif.arslan", topicId)).find((m) => m.kind === "card")!;
    expect(elifCard.card?.canHandle).toBe(true);
    const decided = await call("burak.sahin", "POST", `/approvals/${card.card!.id}/decide`, { approved: true });
    expect(decided.statusCode, decided.body).toBe(200);
    const updated = (await messages("burak.sahin", topicId)).find((m) => m.kind === "card")!;
    expect(updated.card?.status).toBe("approved");
    const followUp = await until(async () => (await messages("burak.sahin", topicId)).find((m) => m.text.startsWith("Sent the reminder")), "the follow-up");
    expect(followUp.author.id).toBe(helperId);
  });

  it("keeps a mention plain when its author may not see the asset, and links the ones they may", async () => {
    const deniz = await call("deniz.aydin", "POST", "/conversations", { text: `@[Invoice Helper](ai_employee:${helperId}) can you help?` });
    expect(deniz.statusCode).toBe(200);
    const id = (deniz.json() as ConversationView).conversation.id;
    const [first] = await messages("deniz.aydin", id);
    expect(first!.mentions[0]).toMatchObject({ kind: "ai_employee", allowed: false, href: null });
    expect((deniz.json() as ConversationView).participants.some((p) => p.actorKind === "ai_employee")).toBe(false);
    const elif = (await messages("elif.arslan", topicId))[0]!;
    expect(elif.mentions.find((m) => m.kind === "ai_employee")).toMatchObject({ allowed: true, href: "/ai/invoice-helper" });
    expect(elif.plain).toBe("@Invoice Helper hello, and @Elif Arslan please follow this.");
  });

  it("offers people, AI employees, the company brain, things and tasks in the picker, by what the viewer may see", async () => {
    const hits = (await call("elif.arslan", "GET", `/mention?q=in&conversation=${topicId}`)).json() as { kind: string; name: string; group: string }[];
    expect(hits.find((h) => h.name === "Invoice Helper")).toMatchObject({ kind: "ai_employee", group: "AI employees" });
    const brain = (await call("elif.arslan", "GET", "/mention?q=brain")).json() as { kind: string; name: string }[];
    expect(brain.find((h) => h.name === "Company brain")).toMatchObject({ kind: "ai_employee" });
    const people = (await call("elif.arslan", "GET", "/mention?q=burak")).json() as { kind: string; name: string }[];
    expect(people.find((h) => h.name === "Burak Şahin")).toMatchObject({ kind: "person" });
    const deniz = (await call("deniz.aydin", "GET", "/mention?q=invoice")).json() as { name: string }[];
    expect(deniz.some((h) => h.name === "Invoice Helper")).toBe(false);
  });

  it("lets anyone talk with the company brain, which answers like an AI employee", async () => {
    const talk = await call("deniz.aydin", "GET", "/conversations/for/ai_employee/company-brain");
    expect(talk.statusCode, talk.body).toBe(200);
    const id = (talk.json() as ConversationView).conversation.id;
    expect((talk.json() as ConversationView).conversation.kind).toBe("ai_employee");
    await call("deniz.aydin", "POST", `/conversations/${id}/messages`, { text: "Who approves supplier invoices above 250,000 TRY?" });
    const answer = await until(async () => aiMessages(await messages("deniz.aydin", id))[0], "the brain's answer");
    expect(answer.text).toContain("Burak Şahin");
    expect(answer.author.name).toBe("Company brain");
    // The same talk opens again.
    expect(((await call("deniz.aydin", "GET", "/conversations/for/ai_employee/company-brain")).json() as ConversationView).conversation.id).toBe(id);
  });

  it("gives every task a conversation: a comment wakes the task, and the answer is the AI employee's message", async () => {
    const started = await call("burak.sahin", "POST", "/tasks", { agent: "invoice-helper", text: "Prepare the reminder for INV-9", wait: true });
    expect(started.statusCode, started.body).toBe(200);
    const task = (started.json() as { task?: { ref: string }; ref?: string }).task ?? (started.json() as { ref: string });
    const ref = task.ref;
    const found = await call("burak.sahin", "GET", `/conversations/for/task/${ref}`);
    expect(found.statusCode, found.body).toBe(200);
    const id = (found.json() as ConversationView).conversation.id;
    const before = await messages("burak.sahin", id);
    // The task's outcome is the AI employee's own message in its conversation.
    expect(aiMessages(before).map((m) => m.text)).toEqual(["Reminder prepared."]);
    await call("burak.sahin", "POST", `/conversations/${id}/messages`, { text: "This one is urgent, the supplier called." });
    const answer = await until(
      async () => aiMessages(await messages("burak.sahin", id)).find((m) => /urgent/.test(m.text)),
      "the AI employee's answer in the task",
    );
    expect(answer.runId).toBeTruthy();
    const events = await t.platform.tasks.events((await t.platform.tasks.get(companyId, ref)).id);
    expect(events.some((e) => e.type === "woke" && e.data.reason === "message")).toBe(true);
    expect((await call("deniz.aydin", "GET", `/conversations/${id}`)).statusCode).toBe(404);
  });

  it("lets two named AI employees answer, one answer the other once, and never a third time", async () => {
    const started = await call("burak.sahin", "POST", "/conversations", {
      text: `@[Invoice Helper](ai_employee:${helperId}) and @[Payment Clerk](ai_employee:${clerkId}) please coordinate INV-9.`,
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as ConversationView).conversation.id;
    const replies = await until(async () => {
      const ai = aiMessages(await messages("burak.sahin", id));
      return ai.length >= 3 ? ai : undefined;
    }, "two answers and one AI-to-AI reply");
    expect(
      replies
        .slice(0, 2)
        .map((m) => m.author.id)
        .sort(),
    ).toEqual([helperId, clerkId].sort());
    expect(replies.slice(0, 2).every((m) => m.data.hop === 0 && m.data.answersSeq === 1)).toBe(true);
    const hop = replies[2]!;
    expect(hop.author.id).toBe(helperId);
    expect(hop.data.hop).toBe(1);
    expect(hop.text).toContain("Confirmed, @[Payment Clerk]");
    for (const reply of replies) expect((await t.platform.engine.getRow(companyId, reply.runId!)).trigger).toBe("conversation");
    // The Payment Clerk was named again, by an AI employee answering an AI employee: nobody answers that.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(aiMessages(await messages("burak.sahin", id)).length).toBe(3);
  });

  it("emails a person who is named in a conversation they are not reading, once while it is unread", async () => {
    t.platform.notifications.configure({ publicUrl: "http://brain.test" });
    const started = await call("burak.sahin", "POST", "/conversations", { text: `@[Elif Arslan](person:${elifId}) can you look at INV-9 today?` });
    const id = (started.json() as ConversationView).conversation.id;
    const [first] = await messages("burak.sahin", id);
    const found = await t.platform.conversations.get(companyId, id);
    const row = (await t.platform.conversations.message(companyId, first!.id))!;
    expect(await t.platform.notifications.mentioned(found.conversation, row, found.participants)).toBe(1);
    const mails = (await t.platform.mail.list(companyId, { direction: "outbound" })).filter((m) => m.toAddresses.includes("elif.arslan@acme.com.tr"));
    expect(mails[0]?.subject).toContain("Burak Şahin mentioned you");
    expect(mails[0]?.bodyText).toContain(`http://brain.test/chat/${id}`);
    expect(mails[0]?.bodyText).toContain("@Elif Arslan can you look at INV-9 today?");
    expect(await t.platform.notifications.mentioned(found.conversation, row, found.participants)).toBe(0);
    // Reading the conversation means hearing it there: nothing is sent to someone with the page open.
    const stop = t.platform.conversations.subscribe(id, () => undefined, { kind: "person", id: elifId, name: "Elif Arslan" });
    const second = await call("burak.sahin", "POST", `/conversations/${id}/messages`, { text: `@[Elif Arslan](person:${elifId}) and the credit note too.` });
    const secondRow = (await t.platform.conversations.message(companyId, (second.json() as Message).id))!;
    expect(await t.platform.notifications.mentioned(found.conversation, secondRow, found.participants)).toBe(0);
    stop();
  });

  it("adopts the older chats as conversations with the same ids", async () => {
    const brain = (await t.platform.agents.find(companyId, "company-brain"))!;
    const [old] = await t.platform.handle.db.insert(chatConversations).values({ companyId, agentId: null, userId: elifId, title: "Leave policy" }).returning();
    await t.platform.handle.db.insert(chatMessages).values([
      { conversationId: old!.id, role: "user", content: "How many days of leave do I have?" },
      { conversationId: old!.id, role: "assistant", content: "You have 14 days [1].", citations: [{ n: 1, title: "Leave policy" }] },
    ]);
    await t.platform.prepareCompany(companyId);
    const adopted = await call("elif.arslan", "GET", `/conversations/${old!.id}`);
    expect(adopted.statusCode, adopted.body).toBe(200);
    const view = adopted.json() as ConversationView;
    expect(view.conversation.kind).toBe("ai_employee");
    expect(view.participants.map((p) => p.actorId).sort()).toEqual([brain.row.id, elifId].sort());
    const list = await messages("elif.arslan", old!.id);
    expect(list.map((m) => [m.seq, m.author.kind, m.text])).toEqual([
      [1, "person", "How many days of leave do I have?"],
      [2, "ai_employee", "You have 14 days [1]."],
    ]);
    expect(await t.platform.prepareCompany(companyId)).toBeUndefined();
    expect((await messages("elif.arslan", old!.id)).length).toBe(2);
  });
});
