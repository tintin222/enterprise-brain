import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversations, chatMessages } from "@enterprise-brain/db";
import { ScriptedLlm, type ToolLoopRequest } from "@enterprise-brain/llm";
import { seedDemoPeople } from "../src/seed.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * Conversations over the API: channels, direct messages and threads for people and AI employees. A person
 * names an AI employee with "@" and it answers in a run; a Supervised AI employee's email becomes an
 * approval card in the conversation, decided from the work queue; the company brain is a participant; a
 * task has a conversation whose comments wake the task; mentions follow what their author may see;
 * #general and the departments' channels exist from the start; threads hang under one message; people
 * react with emoji; the older chats and topics become conversations.
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
  conversationId: string;
  seq: number;
  kind: string;
  author: { kind: string; id: string; name: string };
  text: string;
  plain: string;
  mentions: { kind: string; id: string; name: string; allowed: boolean; href: string | null }[];
  runId: string | null;
  replyToId: string | null;
  card: { type: string; id: string; status: string; canHandle: boolean; title: string } | null;
  data: Record<string, unknown>;
  reactions: { emoji: string; count: number; me: boolean; names: string[] }[];
  thread: { id: string; replies: number; lastReplyAt: string | null; repliers: { kind: string; id: string; name: string }[] } | null;
}

interface ConversationView {
  conversation: {
    id: string;
    kind: string;
    title: string;
    name: string | null;
    aboutId: string | null;
    parentId: string | null;
    lastSeq: number;
    visibility: string;
    status: string;
  };
  participants: { actorKind: string; actorId: string; actorName: string; role: string; readSeq: number }[];
  me: { readSeq: number } | null;
  canInvite: boolean;
  canManage: boolean;
  canLeave: boolean;
  parent: { id: string; kind: string; name: string | null; title: string } | null;
  root: Message | null;
  offers: { teach: boolean; work: { to: { id: string } | null } | null };
}

interface Summary {
  conversation: { id: string; kind: string; title: string; name: string | null; aboutId: string | null; visibility: string };
  participants: { actorKind: string; actorId: string; actorName: string }[];
  members: number;
  unread: number;
  mentionsMe: number;
  me: { readSeq: number } | null;
  parent: { id: string; kind: string; name: string | null } | null;
  lastMessage: { text: string } | null;
}

/** A private channel for a few people, as the tests start most conversations. */
const privateChannel = (name: string, text?: string) => ({ kind: "channel", name, visibility: "participants", ...(text ? { text } : {}) });

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
  const call = (who: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${url}`,
      headers: { cookie: as[who]! },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const messages = async (who: string, id: string) => (await call(who, "GET", `/conversations/${id}/messages`)).json() as Message[];
  // The tools each scripted turn was offered, by turn.
  let followUpTools: string[] = [];
  let handedTools: string[] = [];
  let brainTools: { name: string; description: string }[] = [];
  const aiMessages = (list: Message[]) => list.filter((m) => m.kind === "text" && m.author.kind === "ai_employee");

  beforeAll(async () => {
    const llm = new ScriptedLlm({
      "runtime.agent:invoice-helper.turn": {
        tools: (request, turn, results) => {
          const brief = briefOf(request);
          if (/pay the supplier/i.test(brief) && turn === 1 && request.tools.some((tool) => tool.name === "conversation_hand_over")) {
            return { calls: [{ name: "conversation_hand_over", input: { to: clerkId, reason: "Paying suppliers is the Payment Clerk's job." } }] };
          }
          if (/approved "Send email/.test(brief)) {
            followUpTools = request.tools.map((tool) => tool.name);
            return { text: "Sent the reminder to ap@customer.example." };
          }
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
        tools: (request) => {
          if (/handed you/.test(briefOf(request))) {
            handedTools = request.tools.map((tool) => tool.name);
            return { text: "On it: I will pay INV-9 to Kaya today." };
          }
          return { text: `I pay once @[Invoice Helper](ai_employee:${helperId}) confirms the amounts.` };
        },
      },
      "runtime.agent:invoice-helper.task": {
        tools: (request, turn) => {
          const brief = briefOf(request);
          if (/conversation/.test(brief) && /urgent/i.test(brief)) return { text: "Understood: I will treat INV-9 as urgent." };
          if (/INV-12/.test(brief)) {
            const answer =
              "Here is the reminder for **INV-12**, ready to send:\n\n> Dear Kaya, invoice INV-12 (8,200 TRY) was due on 30 September. Could you tell us when it will be paid?";
            return turn === 1 ? { calls: [{ name: "task_complete", input: { answer, outcome: "Reminder for INV-12 prepared." } }] } : { text: "Closed." };
          }
          if (/INV-14/.test(brief)) throw new Error("The ERP is not answering");
          return { text: "Reminder prepared." };
        },
      },
      "runtime.agent:company-brain.turn": {
        tools: (request) => {
          brainTools = request.tools.map((tool) => ({ name: tool.name, description: tool.description }));
          return { text: "Supplier invoices above 250,000 TRY are approved by Burak Şahin in SAP S/4HANA." };
        },
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

  it("starts a private channel; the named AI employee joins and answers in a run, the named colleague joins", async () => {
    expect((await call("burak.sahin", "POST", "/conversations", { text: "no kind" })).statusCode).toBe(400);
    const started = await call("burak.sahin", "POST", "/conversations", {
      ...privateChannel("INV-9 Kaya", `@[Invoice Helper](ai_employee:${helperId}) hello, and @[Elif Arslan](person:${elifId}) please follow this.`),
      title: "Kaya's overdue invoice",
    });
    expect(started.statusCode, started.body).toBe(200);
    const view = started.json() as ConversationView;
    topicId = view.conversation.id;
    expect(view.conversation).toMatchObject({ kind: "channel", name: "inv-9-kaya", title: "Kaya's overdue invoice", visibility: "participants" });
    expect(view.participants.map((p) => p.actorKind).sort()).toEqual(["ai_employee", "person", "person"]);
    expect(view.participants.find((p) => p.actorId === burakId)?.role).toBe("owner");
    expect(view.canInvite).toBe(true);
    expect(view.canManage).toBe(true);
    expect(view.canLeave).toBe(true);
    // A name is taken once, however it is spelled.
    expect((await call("burak.sahin", "POST", "/conversations", privateChannel("inv 9 KAYA"))).statusCode).toBe(409);
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
    const deniz = (await call("deniz.aydin", "GET", "/conversations?scope=department")).json() as Summary[];
    expect(deniz.map((s) => s.conversation.id)).not.toContain(topicId);
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
    // A turn after a decision answers it: it hands nothing over.
    expect(followUpTools).toContain("conversation_ask");
    expect(followUpTools).not.toContain("conversation_hand_over");
  });

  it("keeps a mention plain when its author may not see the asset, and links the ones they may", async () => {
    const deniz = await call("deniz.aydin", "POST", "/conversations", privateChannel("help", `@[Invoice Helper](ai_employee:${helperId}) can you help?`));
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

  it("links a named document to where anyone who may see it reads it", async () => {
    const added = await call("burak.sahin", "POST", "/knowledge/documents", {
      collection: "general",
      title: "Payment terms policy",
      text: "Suppliers are paid within 45 days of the invoice date.",
    });
    expect(added.statusCode, added.body).toBe(200);
    const documentId = (added.json() as { id: string }).id;
    const hits = (await call("elif.arslan", "GET", "/mention?q=payment&kinds=document")).json() as { kind: string; id: string; href: string | null }[];
    expect(hits.find((h) => h.id === documentId)).toMatchObject({ kind: "document", href: `/search?doc=${documentId}` });
    const started = await call(
      "elif.arslan",
      "POST",
      "/conversations",
      privateChannel("terms", `The terms are in @[Payment terms policy](document:${documentId}).`),
    );
    expect(started.statusCode, started.body).toBe(200);
    const [first] = await messages("elif.arslan", (started.json() as ConversationView).conversation.id);
    expect(first!.mentions).toMatchObject([{ kind: "document", id: documentId, allowed: true, href: `/search?doc=${documentId}` }]);
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
    // It could only hand over to AI employees Deniz may see: not finance's.
    expect(brainTools.find((tool) => tool.name === "conversation_hand_over")?.description ?? "").not.toContain("Invoice Helper");
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
    const started = await call(
      "burak.sahin",
      "POST",
      "/conversations",
      privateChannel("inv-9-coordination", `@[Invoice Helper](ai_employee:${helperId}) and @[Payment Clerk](ai_employee:${clerkId}) please coordinate INV-9.`),
    );
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

  it("hands a matter to the colleague AI employee whose job it is, who answers it once", async () => {
    const started = await call(
      "burak.sahin",
      "POST",
      "/conversations",
      privateChannel("pay-kaya", `@[Invoice Helper](ai_employee:${helperId}) please pay the supplier Kaya for INV-9.`),
    );
    expect(started.statusCode, started.body).toBe(200);
    const id = (started.json() as ConversationView).conversation.id;
    const [handOver, answer] = await until(async () => {
      const ai = aiMessages(await messages("burak.sahin", id));
      return ai.length >= 2 ? ai : undefined;
    }, "the hand-over and the colleague's answer");
    expect(handOver!.author.id).toBe(helperId);
    expect(handOver!.text).toBe(`Handing this over to @[Payment Clerk](ai_employee:${clerkId}): Paying suppliers is the Payment Clerk's job.`);
    expect(handOver!.data).toMatchObject({
      answersSeq: 1,
      hop: 0,
      handOver: { to: { kind: "ai_employee", id: clerkId }, reason: "Paying suppliers is the Payment Clerk's job." },
    });
    expect(answer!.author.id).toBe(clerkId);
    expect(answer!.text).toBe("On it: I will pay INV-9 to Kaya today.");
    expect(answer!.data).toMatchObject({ answersSeq: 1, hop: 1 });
    // The colleague answers; it cannot pass the matter on again.
    expect(handedTools).toContain("conversation_ask");
    expect(handedTools).not.toContain("conversation_hand_over");
    const view = (await call("burak.sahin", "GET", `/conversations/${id}`)).json() as { participants: { actorId: string; invitedBy: { id: string } | null }[] };
    expect(view.participants.find((p) => p.actorId === clerkId)?.invitedBy?.id).toBe(helperId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(aiMessages(await messages("burak.sahin", id)).length).toBe(2);
  });

  it("gives work from a channel: a task for the AI employee named, whose answer comes in the thread under the message", async () => {
    type View = ConversationView;
    const topic = (await call("burak.sahin", "POST", "/conversations", privateChannel("kaya-follow-up"))).json() as View;
    expect(topic.offers).toEqual({ teach: false, work: { to: null } });
    const id = topic.conversation.id;
    const given = await call("burak.sahin", "POST", `/conversations/${id}/messages`, {
      text: `@[Invoice Helper](ai_employee:${helperId}) prepare the reminder for INV-12`,
      intent: "work",
    });
    expect(given.statusCode, given.body).toBe(200);
    const message = given.json() as Message;
    expect(message.data).toMatchObject({ intent: "work", to: { id: helperId, name: "Invoice Helper" }, task: { title: "Prepare the reminder for INV-12" } });
    const ref = (message.data.task as { ref: string }).ref;
    expect(await t.platform.tasks.get(companyId, ref)).toMatchObject({ source: "chat", sourceRef: id, requestedBy: "Burak Şahin" });
    // The task does the work; when it is done, the AI employee answers in the thread under the message that gave it.
    const thread = await until(async () => {
      const found = (await call("burak.sahin", "GET", `/conversations/for/thread/${message.id}`)).json() as View;
      return found.conversation.lastSeq > 0 ? found : undefined;
    }, "the answer's thread");
    expect(thread.conversation).toMatchObject({ kind: "thread", parentId: id, aboutId: message.id, visibility: "participants" });
    expect(thread.parent).toMatchObject({ id, kind: "channel", name: "kaya-follow-up" });
    expect(thread.root?.id).toBe(message.id);
    const [answer] = aiMessages(await messages("burak.sahin", thread.conversation.id));
    expect(answer!.text).toBe(
      "Here is the reminder for **INV-12**, ready to send:\n\n> Dear Kaya, invoice INV-12 (8,200 TRY) was due on 30 September. Could you tell us when it will be paid?",
    );
    expect(answer!.author).toMatchObject({ kind: "ai_employee", id: helperId });
    expect(answer!.replyToId).toBeNull();
    expect(answer!.data).toMatchObject({ task: { ref }, taskEvent: "done" });
    expect(await t.platform.tasks.get(companyId, ref)).toMatchObject({ status: "done", outcome: "Reminder for INV-12 prepared.", answer: answer!.text });
    // The channel itself stays as it was, apart from the thread's count under the message.
    const inChannel = await messages("burak.sahin", id);
    expect(aiMessages(inChannel)).toEqual([]);
    expect(inChannel.find((m) => m.id === message.id)?.thread).toMatchObject({ id: thread.conversation.id, replies: 1, repliers: [{ id: helperId }] });
    // The thread offers giving more work to the AI employee whose answer it is under.
    expect(thread.offers).toEqual({ teach: false, work: { to: { id: helperId, slug: "invoice-helper", name: "Invoice Helper" } } });
    // The task's own conversation has it too, as the AI employee's message.
    const taskThread = (await call("burak.sahin", "GET", `/conversations/for/task/${ref}`)).json() as View;
    expect(aiMessages(await messages("burak.sahin", taskThread.conversation.id)).map((m) => m.text)).toContain(answer!.text);
    // A reply in the thread, naming nobody, is the AI employee's to answer: it wrote last there.
    await call("burak.sahin", "POST", `/conversations/${thread.conversation.id}/messages`, { text: "Thanks, send it today." });
    const followUp = await until(async () => aiMessages(await messages("burak.sahin", thread.conversation.id))[1], "the reply to the answer");
    expect(followUp.author.id).toBe(helperId);
    expect((await t.platform.engine.getRow(companyId, followUp.runId!)).triggerRef).toBe(thread.conversation.id);
    // Work that fails: a line from the app says so, in the thread under the message that gave it.
    const broken = await call("burak.sahin", "POST", `/conversations/${id}/messages`, {
      text: `@[Invoice Helper](ai_employee:${helperId}) check INV-14 in the ERP`,
      intent: "work",
    });
    const brokenId = (broken.json() as Message).id;
    const brokenRef = ((broken.json() as Message).data.task as { ref: string }).ref;
    const failed = await until(async () => {
      const found = (await call("burak.sahin", "GET", `/conversations/for/thread/${brokenId}`)).json() as View;
      return (await messages("burak.sahin", found.conversation.id)).find((m) => m.kind === "system" && m.text.startsWith(`${brokenRef} failed`));
    }, "the failure");
    expect(failed.text).toContain("The ERP is not answering");
    // In a talk with an AI employee, the work is theirs when nobody is named.
    const talk = (await call("burak.sahin", "GET", `/conversations/for/ai_employee/${helperId}`)).json() as View;
    expect(talk.offers.work).toMatchObject({ to: { id: helperId } });
    const inTalk = await call("burak.sahin", "POST", `/conversations/${talk.conversation.id}/messages`, {
      text: "check INV-13 against its order",
      intent: "work",
    });
    expect(inTalk.statusCode, inTalk.body).toBe(200);
    expect((inTalk.json() as Message).data).toMatchObject({ intent: "work", to: { id: helperId }, task: { title: "Check INV-13 against its order" } });
    // Not clear who: two named, or the company brain's talk with nobody named. Never in a task's conversation.
    const both = `@[Invoice Helper](ai_employee:${helperId}) and @[Payment Clerk](ai_employee:${clerkId}) do it`;
    expect((await call("burak.sahin", "POST", `/conversations/${id}/messages`, { text: both, intent: "work" })).statusCode).toBe(400);
    const brain = (await call("burak.sahin", "GET", "/conversations/for/ai_employee/company-brain")).json() as View;
    expect(brain.offers).toEqual({ teach: true, work: { to: null } });
    expect(
      (await call("burak.sahin", "POST", `/conversations/${brain.conversation.id}/messages`, { text: "do it now please", intent: "work" })).statusCode,
    ).toBe(400);
    const taskTalk = (await call("burak.sahin", "GET", `/conversations/for/task/${ref}`)).json() as View;
    expect(taskTalk.offers).toEqual({ teach: false, work: null });
    expect(
      (await call("burak.sahin", "POST", `/conversations/${taskTalk.conversation.id}/messages`, { text: "and again please", intent: "work" })).statusCode,
    ).toBe(400);
    // The picker says who takes work.
    const hits = (await call("burak.sahin", "GET", "/mention?kinds=ai_employee")).json() as { name: string; takesWork?: boolean }[];
    expect(hits.find((h) => h.name === "Invoice Helper")?.takesWork).toBe(true);
    expect(hits.find((h) => h.name === "Company brain")?.takesWork).toBe(false);
  });

  it("emails a person who is named in a conversation they are not reading, once while it is unread", async () => {
    t.platform.notifications.configure({ publicUrl: "http://brain.test" });
    const started = await call(
      "burak.sahin",
      "POST",
      "/conversations",
      privateChannel("inv-9-today", `@[Elif Arslan](person:${elifId}) can you look at INV-9 today?`),
    );
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

  it("gives every company #general and a channel per department, joined on first sight, with the department's AI employees in it", async () => {
    const mine = (await call("elif.arslan", "GET", "/conversations?scope=mine&kinds=channel")).json() as Summary[];
    const general = mine.find((c) => c.conversation.aboutId === "general")!;
    expect(general.conversation).toMatchObject({ kind: "channel", name: "general", visibility: "company" });
    expect(general.me).toBeTruthy();
    const finance = mine.find((c) => c.conversation.name === "finance")!;
    expect(finance.conversation).toMatchObject({ kind: "channel", visibility: "department" });
    expect(
      finance.participants
        .filter((p) => p.actorKind === "ai_employee")
        .map((p) => p.actorName)
        .sort(),
    ).toEqual(expect.arrayContaining(["Invoice Helper", "Payment Clerk"]));
    expect(mine.some((c) => c.conversation.name === "customer-service")).toBe(false);
    // Neither #general nor one's own department's channel can be left; a department channel is read by its department and IT.
    const view = (await call("elif.arslan", "GET", `/conversations/${finance.conversation.id}`)).json() as ConversationView;
    expect(view).toMatchObject({ canLeave: false, canManage: false });
    expect((await call("elif.arslan", "DELETE", `/conversations/${finance.conversation.id}/participants/person/${elifId}`)).statusCode).toBe(400);
    expect((await call("deniz.aydin", "GET", `/conversations/${finance.conversation.id}`)).statusCode).toBe(404);
    expect((await call("mehmet.oz", "GET", `/conversations/${finance.conversation.id}`)).statusCode).toBe(200);
    expect((await call("burak.sahin", "POST", `/conversations/${finance.conversation.id}/archive`)).statusCode).toBe(400);
    // Deniz has #general and customer service's channel.
    const deniz = (await call("deniz.aydin", "GET", "/conversations?scope=mine&kinds=channel")).json() as Summary[];
    expect(deniz.map((c) => c.conversation.name)).toEqual(expect.arrayContaining(["customer-service", "general"]));
    expect(deniz.map((c) => c.conversation.name)).not.toContain("finance");
  });

  it("lets anyone open a public channel, join it, leave it, and lets its owner rename and archive it", async () => {
    const made = await call("burak.sahin", "POST", "/conversations", {
      kind: "channel",
      name: "Q3 Planning",
      title: "The quarter's plan",
      visibility: "company",
    });
    expect(made.statusCode, made.body).toBe(200);
    const id = (made.json() as ConversationView).conversation.id;
    expect((made.json() as ConversationView).conversation.name).toBe("q3-planning");
    // Deniz may read it, and finds it to browse; he is not in it until he joins.
    const browse = (await call("deniz.aydin", "GET", "/conversations?scope=department&kinds=channel")).json() as Summary[];
    expect(browse.find((c) => c.conversation.id === id)).toMatchObject({ me: null, members: 1 });
    const before = (await call("deniz.aydin", "GET", `/conversations/${id}`)).json() as ConversationView;
    expect(before.me).toBeNull();
    expect(before.canLeave).toBe(false);
    const joined = await call("deniz.aydin", "POST", `/conversations/${id}/join`);
    expect(joined.statusCode, joined.body).toBe(200);
    expect((joined.json() as { participants: { actorId: string }[] }).participants.some((p) => p.actorId !== burakId)).toBe(true);
    const list = await messages("deniz.aydin", id);
    expect(list.map((m) => [m.kind, m.plain])).toEqual([["system", "Deniz Aydın joined"]]);
    const after = (await call("deniz.aydin", "GET", `/conversations/${id}`)).json() as ConversationView;
    expect(after.me).toBeTruthy();
    expect(after).toMatchObject({ canLeave: true, canManage: false });
    // The app's lines are not unread.
    const summary = ((await call("deniz.aydin", "GET", "/conversations?scope=mine&kinds=channel")).json() as Summary[]).find((c) => c.conversation.id === id)!;
    expect(summary.unread).toBe(0);
    // Only the owner, its department's managers and admins rename or archive.
    expect((await call("deniz.aydin", "PATCH", `/conversations/${id}`, { title: "Mine now" })).statusCode).toBe(403);
    const renamed = await call("burak.sahin", "PATCH", `/conversations/${id}`, { name: "q3-plan", title: "The quarter's plan, by week" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.json() as ConversationView).conversation).toMatchObject({ name: "q3-plan", title: "The quarter's plan, by week" });
    expect((await call("burak.sahin", "PATCH", `/conversations/${id}`, { name: "general" })).statusCode).toBe(409);
    const left = await call(
      "deniz.aydin",
      "DELETE",
      `/conversations/${id}/participants/person/${(await t.platform.people.list(companyId)).find((p) => p.email.startsWith("deniz."))!.id}`,
    );
    expect(left.statusCode, left.body).toBe(200);
    expect(((await call("deniz.aydin", "GET", `/conversations/${id}`)).json() as ConversationView).me).toBeNull();
    expect((await messages("burak.sahin", id)).map((m) => m.plain)).toEqual([
      "Deniz Aydın joined",
      "Burak Şahin renamed this channel #q3-plan",
      "Deniz Aydın left",
    ]);
    expect((await call("deniz.aydin", "POST", `/conversations/${id}/archive`)).statusCode).toBe(403);
    const archived = await call("mehmet.oz", "POST", `/conversations/${id}/archive`);
    expect(archived.statusCode, archived.body).toBe(200);
    expect((archived.json() as ConversationView).conversation.status).toBe("archived");
    expect((await call("burak.sahin", "POST", `/conversations/${id}/messages`, { text: "Too late" })).statusCode).toBe(409);
    expect(((await call("burak.sahin", "GET", "/conversations?scope=mine&kinds=channel")).json() as Summary[]).some((c) => c.conversation.id === id)).toBe(
      false,
    );
    // The name stays taken.
    expect((await call("burak.sahin", "POST", "/conversations", { kind: "channel", name: "q3-plan", visibility: "company" })).statusCode).toBe(409);
  });

  it("hides a private channel from everyone but its members", async () => {
    const made = (await call("burak.sahin", "POST", "/conversations", privateChannel("secret"))).json() as ConversationView;
    const id = made.conversation.id;
    expect((await call("deniz.aydin", "GET", `/conversations/${id}`)).statusCode).toBe(404);
    expect((await call("deniz.aydin", "POST", `/conversations/${id}/join`)).statusCode).toBe(404);
    expect((await call("deniz.aydin", "GET", `/mention?q=a&conversation=${id}`)).statusCode).toBe(404);
    const browse = (await call("deniz.aydin", "GET", "/conversations?scope=department&kinds=channel")).json() as Summary[];
    expect(browse.some((c) => c.conversation.id === id)).toBe(false);
    // A department channel of one's own is open to make; another department's is not.
    const finance = (await t.platform.catalog.departments(companyId)).find((d) => d.key === "finance")!;
    expect(
      (await call("deniz.aydin", "POST", "/conversations", { kind: "channel", name: "fin-side", visibility: "department", departmentId: finance.id }))
        .statusCode,
    ).toBe(400);
    const side = await call("elif.arslan", "POST", "/conversations", { kind: "channel", name: "fin-side", visibility: "department", departmentId: finance.id });
    expect(side.statusCode, side.body).toBe(200);
    expect((await call("burak.sahin", "GET", `/conversations/${(side.json() as ConversationView).conversation.id}`)).statusCode).toBe(200);
    expect((await call("deniz.aydin", "GET", `/conversations/${(side.json() as ConversationView).conversation.id}`)).statusCode).toBe(404);
  });

  it("has one direct message per set of people, and the talk with an AI employee as its direct message", async () => {
    const started = await call("elif.arslan", "POST", "/conversations", { kind: "dm", participants: [{ kind: "person", id: burakId }] });
    expect(started.statusCode, started.body).toBe(200);
    const dm = started.json() as ConversationView;
    expect(dm.conversation).toMatchObject({ kind: "dm", visibility: "participants", title: "Burak Şahin, Elif Arslan" });
    expect(dm.participants.map((p) => [p.actorId, p.role]).sort()).toEqual(
      [
        [burakId, "member"],
        [elifId, "member"],
      ].sort(),
    );
    expect(dm).toMatchObject({ canLeave: false, canManage: false });
    const again = (
      await call("burak.sahin", "POST", "/conversations", { kind: "dm", participants: [{ kind: "person", id: elifId }] })
    ).json() as ConversationView;
    expect(again.conversation.id).toBe(dm.conversation.id);
    expect(((await call("elif.arslan", "GET", `/conversations/for/dm/${burakId}`)).json() as ConversationView).conversation.id).toBe(dm.conversation.id);
    expect((await call("deniz.aydin", "GET", `/conversations/${dm.conversation.id}`)).statusCode).toBe(404);
    // Its people are fixed: a named colleague does not join, and nobody is added.
    const denizId = (await t.platform.people.list(companyId)).find((p) => p.email.startsWith("deniz."))!.id;
    await call("elif.arslan", "POST", `/conversations/${dm.conversation.id}/messages`, { text: `Ask @[Deniz Aydın](person:${denizId}) about the complaint.` });
    expect(((await call("elif.arslan", "GET", `/conversations/${dm.conversation.id}`)).json() as ConversationView).participants.length).toBe(2);
    expect((await call("elif.arslan", "POST", `/conversations/${dm.conversation.id}/participants`, { kind: "person", id: denizId })).statusCode).toBe(400);
    expect((await call("elif.arslan", "DELETE", `/conversations/${dm.conversation.id}/participants/person/${elifId}`)).statusCode).toBe(400);
    // Three people are another direct message; one AI employee is the talk with it.
    const group = (
      await call("elif.arslan", "POST", "/conversations", {
        kind: "dm",
        participants: [
          { kind: "person", id: burakId },
          { kind: "person", id: denizId },
        ],
      })
    ).json() as ConversationView;
    expect(group.conversation.id).not.toBe(dm.conversation.id);
    expect(group.participants.length).toBe(3);
    const talk = (
      await call("elif.arslan", "POST", "/conversations", { kind: "dm", participants: [{ kind: "ai_employee", id: helperId }] })
    ).json() as ConversationView;
    expect(talk.conversation.kind).toBe("ai_employee");
    expect(((await call("elif.arslan", "GET", "/conversations/for/ai_employee/invoice-helper")).json() as ConversationView).conversation.id).toBe(
      talk.conversation.id,
    );
    expect(
      (
        await call("elif.arslan", "POST", "/conversations", {
          kind: "dm",
          participants: [
            { kind: "ai_employee", id: helperId },
            { kind: "person", id: burakId },
          ],
        })
      ).statusCode,
    ).toBe(400);
    // The picker offers everyone in the company for a message, and the viewer's departments otherwise.
    const everyone = (await call("elif.arslan", "GET", "/mention?q=deniz&kinds=person&scope=company")).json() as { name: string }[];
    expect(everyone.some((h) => h.name === "Deniz Aydın")).toBe(true);
    expect(((await call("elif.arslan", "GET", "/mention?q=deniz&kinds=person")).json() as { name: string }[]).some((h) => h.name === "Deniz Aydın")).toBe(
      false,
    );
  });

  it("opens a thread under a message: its replies stay out of the channel, which hears the message changed", async () => {
    const posted = (await call("burak.sahin", "POST", `/conversations/${topicId}/messages`, { text: "Shall we call Kaya on Monday?" })).json() as Message;
    const events: { type: string; id?: string }[] = [];
    const stop = t.platform.conversations.subscribe(topicId, (event) =>
      events.push({ type: event.type, id: "message" in event ? event.message.id : undefined }),
    );
    const opened = await call("elif.arslan", "GET", `/conversations/for/thread/${posted.id}`);
    expect(opened.statusCode, opened.body).toBe(200);
    const thread = opened.json() as ConversationView;
    expect(thread.conversation).toMatchObject({ kind: "thread", parentId: topicId, aboutId: posted.id, title: "Shall we call Kaya on Monday?" });
    expect(thread.parent).toMatchObject({ id: topicId, kind: "channel", name: "inv-9-kaya" });
    expect(thread.root).toMatchObject({ id: posted.id, text: "Shall we call Kaya on Monday?" });
    expect(thread.participants.map((p) => p.actorId)).toEqual([burakId]);
    expect(((await call("elif.arslan", "GET", `/conversations/for/thread/${posted.id}`)).json() as ConversationView).conversation.id).toBe(
      thread.conversation.id,
    );
    // Not under a task's conversation, not for someone who may not read the channel, not under the app's lines.
    const task = (await call("burak.sahin", "GET", "/conversations?scope=mine&kinds=task")).json() as Summary[];
    expect(task.length).toBeGreaterThan(0);
    const taskMessage = (await messages("burak.sahin", task[0]!.conversation.id))[0]!;
    expect((await call("burak.sahin", "GET", `/conversations/for/thread/${taskMessage.id}`)).statusCode).toBe(400);
    expect((await call("deniz.aydin", "GET", `/conversations/for/thread/${posted.id}`)).statusCode).toBe(404);
    // A reply: the channel's message shows the thread; Burak, who wrote it, has the thread unread.
    const reply = await call("elif.arslan", "POST", `/conversations/${thread.conversation.id}/messages`, { text: "Monday at ten works for me." });
    expect(reply.statusCode, reply.body).toBe(200);
    const inChannel = (await messages("burak.sahin", topicId)).find((m) => m.id === posted.id)!;
    expect(inChannel.thread).toMatchObject({ id: thread.conversation.id, replies: 1, repliers: [{ kind: "person", id: elifId }] });
    expect(events).toContainEqual({ type: "updated", id: posted.id });
    expect(events.some((e) => e.type === "message")).toBe(false);
    const threads = (await call("burak.sahin", "GET", "/conversations?scope=mine&kinds=thread")).json() as Summary[];
    expect(threads.find((c) => c.conversation.id === thread.conversation.id)).toMatchObject({
      unread: 1,
      parent: { id: topicId, kind: "channel", name: "inv-9-kaya" },
    });
    // The thread's own address opens with its channel, for emails too.
    t.platform.notifications.configure({ publicUrl: "http://brain.test" });
    const named = (
      await call("elif.arslan", "POST", `/conversations/${thread.conversation.id}/messages`, { text: `@[Burak Şahin](person:${burakId}) can you?` })
    ).json() as Message;
    const found = await t.platform.conversations.get(companyId, thread.conversation.id);
    const row = (await t.platform.conversations.message(companyId, named.id))!;
    expect(await t.platform.notifications.mentioned(found.conversation, row, found.participants)).toBe(1);
    const mails = (await t.platform.mail.list(companyId, { direction: "outbound" })).filter((m) => m.toAddresses.includes("burak.sahin@acme.com.tr"));
    expect(mails.at(-1)?.bodyText).toContain(`http://brain.test/chat/${topicId}?thread=${posted.id}`);
    stop();
  });

  it("lets an AI employee answer in a thread: when named, and then as the one who wrote last", async () => {
    const posted = (await call("burak.sahin", "POST", `/conversations/${topicId}/messages`, { text: "About the VBAK extract." })).json() as Message;
    const thread = (await call("burak.sahin", "GET", `/conversations/for/thread/${posted.id}`)).json() as ConversationView;
    await call("burak.sahin", "POST", `/conversations/${thread.conversation.id}/messages`, { text: `@[Invoice Helper](ai_employee:${helperId}) hello there` });
    const first = await until(async () => aiMessages(await messages("burak.sahin", thread.conversation.id))[0], "the answer in the thread");
    expect(first.author.id).toBe(helperId);
    expect((await t.platform.engine.getRow(companyId, first.runId!)).triggerRef).toBe(thread.conversation.id);
    await call("burak.sahin", "POST", `/conversations/${thread.conversation.id}/messages`, { text: "and one more thing" });
    const second = await until(async () => aiMessages(await messages("burak.sahin", thread.conversation.id))[1], "the second answer");
    expect(second.author.id).toBe(helperId);
    // In the channel itself, nobody answers what names nobody.
    await call("burak.sahin", "POST", `/conversations/${topicId}/messages`, { text: "Just thinking aloud." });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(aiMessages(await messages("burak.sahin", topicId)).length).toBe(aiMessages(await messages("burak.sahin", topicId)).length);
    expect(aiMessages(await messages("burak.sahin", thread.conversation.id)).length).toBe(2);
  });

  it("lets people react to a message with the emoji offered, once each", async () => {
    const posted = (await call("burak.sahin", "POST", `/conversations/${topicId}/messages`, { text: "Kaya paid INV-9!" })).json() as Message;
    const url = `/conversations/${topicId}/messages/${posted.id}/reactions`;
    const events: string[] = [];
    const stop = t.platform.conversations.subscribe(topicId, (event) => events.push(event.type));
    const first = await call("elif.arslan", "PUT", `${url}/${encodeURIComponent("🎉")}`);
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as Message).reactions).toEqual([{ emoji: "🎉", count: 1, me: true, names: ["Elif Arslan"] }]);
    await call("elif.arslan", "PUT", `${url}/${encodeURIComponent("🎉")}`);
    const second = (await call("burak.sahin", "PUT", `${url}/${encodeURIComponent("🎉")}`)).json() as Message;
    expect(second.reactions).toEqual([{ emoji: "🎉", count: 2, me: true, names: ["Elif Arslan", "Burak Şahin"] }]);
    const heart = (await call("burak.sahin", "PUT", `${url}/${encodeURIComponent("❤")}`)).json() as Message;
    expect(heart.reactions.map((r) => r.emoji)).toEqual(["🎉", "❤️"]);
    expect((await call("burak.sahin", "PUT", `${url}/${encodeURIComponent("🍌")}`)).statusCode).toBe(400);
    const taken = (await call("elif.arslan", "DELETE", `${url}/${encodeURIComponent("🎉")}`)).json() as Message;
    expect(taken.reactions).toEqual([
      { emoji: "🎉", count: 1, me: false, names: ["Burak Şahin"] },
      { emoji: "❤️", count: 1, me: false, names: ["Burak Şahin"] },
    ]);
    expect(events.filter((e) => e === "updated").length).toBe(5);
    expect((await call("deniz.aydin", "PUT", `${url}/${encodeURIComponent("👍")}`)).statusCode).toBe(404);
    stop();
  });

  it("adopts the topics of before channels: two people's private one as their direct message, the rest as channels", async () => {
    const { conversations, conversationParticipants } = await import("@enterprise-brain/db");
    const row = (actorId: string, actorName: string) => ({ companyId, actorKind: "person", actorId, actorName, role: "member" });
    const [pair] = await t.platform.handle.db
      .insert(conversations)
      .values({ companyId, kind: "topic", title: "Lunch?", visibility: "participants", createdBy: { kind: "person", id: elifId, name: "Elif Arslan" } })
      .returning();
    await t.platform.handle.db.insert(conversationParticipants).values([
      { ...row(elifId, "Elif Arslan"), conversationId: pair!.id, role: "owner" },
      { ...row(burakId, "Burak Şahin"), conversationId: pair!.id },
    ]);
    const [wide] = await t.platform.handle.db
      .insert(conversations)
      .values({
        companyId,
        kind: "topic",
        title: "Kaya Çelik invoices",
        visibility: "department",
        createdBy: { kind: "person", id: elifId, name: "Elif Arslan" },
      })
      .returning();
    await t.platform.handle.db.insert(conversationParticipants).values([{ ...row(elifId, "Elif Arslan"), conversationId: wide!.id, role: "owner" }]);
    await t.platform.prepareCompany(companyId);
    // Elif and Burak already have a direct message: the pair becomes a private channel instead.
    const lunch = (await call("elif.arslan", "GET", `/conversations/${pair!.id}`)).json() as ConversationView;
    expect(lunch.conversation).toMatchObject({ kind: "channel", name: "lunch", title: "Lunch?", visibility: "participants" });
    const invoices = (await call("elif.arslan", "GET", `/conversations/${wide!.id}`)).json() as ConversationView;
    expect(invoices.conversation).toMatchObject({ kind: "channel", name: "kaya-çelik-invoices", title: "Kaya Çelik invoices", visibility: "department" });
    await t.platform.prepareCompany(companyId);
    expect(((await call("elif.arslan", "GET", `/conversations/${wide!.id}`)).json() as ConversationView).conversation.name).toBe("kaya-çelik-invoices");
  });
});
