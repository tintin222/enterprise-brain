import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, defineConnector, defineManifest, schema, type ConnectorEvent } from "@enterprise-brain/connectors";
import { companies } from "@enterprise-brain/db";
import { LocalHashEmbedder, UnavailableLlm } from "@enterprise-brain/llm";
import { Platform } from "../src/index.ts";

/**
 * Watchers: AI employees follow connected mailboxes and systems on their own. New mail becomes work
 * for the duties that follow the mailbox, a reply goes back to its task, an email to the AI mailbox
 * gives an AI employee work, and a new record in a system starts a duty.
 */

interface TestMessage {
  id: string;
  mailbox: string;
  at: string;
  from: { name: string; address: string };
  to: string[];
  subject: string;
  body: string;
  attachment?: { name: string; text: string };
}

/** Stand-ins for a mail system (Graph-shaped messages) and an HR system with a "new employee" event. */
const inbox: TestMessage[] = [];
const sent: { to: string; subject: string }[] = [];
const hires: { id: string; name: string }[] = [];
let mailDown = false;

const testMail = defineConnector({
  manifest: defineManifest({
    type: "test-mail",
    name: "Test Mail",
    vendor: "Test",
    category: "mail",
    description: "A mailbox for tests",
    auth: "none",
    config: [{ key: "mailbox", label: "Mailbox" }],
    operations: [
      schema.readOp("get_message", "Get message", "Full message", { message_id: schema.str() }, ["message_id"]),
      schema.readOp("get_attachment", "Get attachment", "Attachment content", { message_id: schema.str(), attachment_id: schema.str() }, ["message_id", "attachment_id"]),
      schema.writeOp("send_mail", "Send e-mail", "Send", { to: schema.str(), subject: schema.str(), body: schema.str() }, ["to", "subject", "body"]),
    ],
    events: [{ id: "new_message", name: "New message", description: "A new message arrived" }],
  }),
  test: async () => ({ ok: true, message: "ok" }),
  operations: {
    get_message: async (input) => {
      const m = inbox.find((x) => x.id === input.message_id)!;
      return {
        id: m.id,
        subject: m.subject,
        from: { name: m.from.name, address: m.from.address },
        to: m.to.map((address) => ({ name: null, address })),
        received_at: m.at,
        body: `<p>${m.body}</p>`,
        body_format: "html",
        conversation_id: `conv-${m.id}`,
        attachments: m.attachment ? [{ id: "att-1", name: m.attachment.name, contentType: "text/plain", size: m.attachment.text.length, isInline: false, kind: "file" }] : [],
      };
    },
    get_attachment: async (input) => {
      const m = inbox.find((x) => x.id === input.message_id)!;
      return { id: "att-1", name: m.attachment!.name, contentType: "text/plain", contentBytes: Buffer.from(m.attachment!.text).toString("base64") };
    },
    send_mail: async (input) => {
      sent.push({ to: String(input.to), subject: String(input.subject) });
      return { ok: true };
    },
  },
  async poll(_event, ctx, cursor) {
    const mine = inbox.filter((m) => m.mailbox === ctx.config.mailbox);
    if (mailDown) throw new Error("The mail server did not answer");
    // Like the real connectors: the first poll only records the starting point.
    if (!cursor) return { events: [], cursor: String(mine.length) };
    const fresh = mine.slice(Number(cursor));
    const events: ConnectorEvent[] = fresh.map((m) => ({ id: m.id, type: "new_message", occurredAt: m.at, data: { id: m.id, subject: m.subject } }));
    return { events, cursor: String(mine.length) };
  },
});

const testHr = defineConnector({
  manifest: defineManifest({
    type: "test-hr",
    name: "Test HR",
    vendor: "Test",
    category: "hris",
    description: "An HR system for tests",
    auth: "none",
    operations: [schema.readOp("list_employees", "List employees", "Employees")],
    events: [{ id: "new_employee", name: "New employee", description: "Someone was hired" }],
  }),
  test: async () => ({ ok: true, message: "ok" }),
  operations: { list_employees: async () => hires },
  async poll(_event, _ctx, cursor) {
    if (!cursor) return { events: [], cursor: String(hires.length) };
    return { events: hires.slice(Number(cursor)).map((h) => ({ id: h.id, type: "new_employee", occurredAt: new Date().toISOString(), data: h })), cursor: String(hires.length) };
  },
});

let platform: Platform;
let companyId: string;
let n = 0;
const receive = (mailbox: string, message: Omit<TestMessage, "id" | "mailbox" | "at">) => {
  inbox.push({ id: `msg-${++n}`, mailbox, at: new Date(Date.now() + n * 1000).toISOString(), ...message });
};

beforeAll(async () => {
  platform = await Platform.create({
    dataDir: mkdtempSync(join(tmpdir(), "eb-watch-")),
    inMemory: true,
    llm: new UnavailableLlm(),
    embedder: new LocalHashEmbedder(),
    registry: createDefaultRegistry().register(testMail).register(testHr),
    env: {},
  });
  companyId = (await platform.ensureCompany({ slug: "acme", name: "Acme" })).id;
  await platform.connectors.create(companyId, { type: "test-mail", name: "Careers mailbox", values: { mailbox: "careers@acme.test" } });
  await platform.connectors.create(companyId, { type: "test-mail", name: "AI mailbox", values: { mailbox: "ai@acme.test" } });
  await platform.connectors.create(companyId, { type: "test-hr", name: "HR system", values: {} });
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "cv-intake",
      name: "CV Intake",
      summary: "Receives applications.",
      archetype: "mail-triage",
      instructions: "Receive applications.",
      triggers: [{ type: "mailbox", mailbox: "careers@acme.test" }],
      workflow: [
        { id: "ack", type: "mail.send", to: "{{ input.email.from }}", subject: "We received your application", body: "Thank you.", requiresApproval: false },
        { id: "answer", type: "wait", for: "reply", days: 5 },
        { id: "result", type: "output", value: { subject: "{{ input.email.subject }}", files: "{{ input.email.attachmentNames }}", replied: "{{ steps.answer.replied }}" } },
      ],
    },
  });
  await platform.agents.create(companyId, {
    status: "active",
    definition: {
      slug: "onboarder",
      name: "Onboarder",
      summary: "Welcomes new employees.",
      archetype: "process-automation",
      instructions: "Onboard people.",
      connectors: [{ ref: "hr", category: "hris" }],
      triggers: [{ type: "connector-event", connector: "hr", event: "new_employee" }],
      workflow: [{ id: "result", type: "output", value: { welcomed: "{{ input.event.name }}" } }],
    },
  });
  await platform.agents.create(companyId, {
    status: "active",
    definition: { slug: "helper", name: "Helper", summary: "Helps with anything.", archetype: "conversational", instructions: "Help." },
  });
  await platform.people.create(companyId, { email: "ayse@acme.test", name: "Ayşe Yılmaz" });
  const [company] = await platform.handle.db.select().from(companies).where(eq(companies.id, companyId));
  await platform.handle.db.update(companies).set({ settings: { ...company!.settings, aiMailbox: "ai@acme.test" } }).where(eq(companies.id, companyId));
});
afterAll(async () => {
  await platform?.close();
});

describe("watching connected mailboxes and systems", () => {
  it("starts from now: mail from before the watch is not replayed", async () => {
    receive("careers@acme.test", { from: { name: "Old", address: "old@example.com" }, to: ["careers@acme.test"], subject: "Old application", body: "Old." });
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ mail: 0, events: 0, errors: [] });
    // Two mailboxes, and the HR system's new employees for the Onboarder.
    expect((await platform.watchers.status(companyId)).length).toBe(3);
  });

  it("brings in new mail with its attachments and gives it to the duty that follows the mailbox", async () => {
    receive("careers@acme.test", {
      from: { name: "Jane Doe", address: "Jane.Doe@example.com" },
      to: ["careers@acme.test"],
      subject: "Application: backend developer",
      body: "Please find my CV attached.",
      attachment: { name: "jane-doe-cv.txt", text: "Jane Doe, 7 years of TypeScript" },
    });
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ mail: 1, errors: [] });
    const [message] = await platform.mail.list(companyId, { mailbox: "careers@acme.test", direction: "inbound" });
    expect(message).toMatchObject({ fromAddress: "jane.doe@example.com", fromName: "Jane Doe", subject: "Application: backend developer", bodyText: "Please find my CV attached.", threadId: "conv-msg-2" });
    expect(message!.attachments.map((a) => a.name)).toEqual(["jane-doe-cv.txt"]);
    const [task] = await platform.tasks.list(companyId);
    expect(task).toMatchObject({ title: "Application: backend developer", source: "mailbox", status: "waiting" });
    // The acknowledgement went out through the connected mailbox, with the task's reference.
    expect(sent.at(-1)).toEqual({ to: "jane.doe@example.com", subject: `We received your application [${task!.ref}]` });
    // Nothing new: nothing happens.
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ mail: 0 });
  });

  it("gives a reply back to its task", async () => {
    const [task] = await platform.tasks.list(companyId);
    receive("careers@acme.test", { from: { name: "Jane Doe", address: "jane.doe@example.com" }, to: ["careers@acme.test"], subject: `Re: We received your application [${task!.ref}]`, body: "Thanks!" });
    await platform.watchers.pollCompany(companyId, { wait: true });
    const run = (await platform.tasks.runsOf(task!.id))[0]!;
    const done = await platform.engine.waitForSettled(companyId, run.id);
    expect(done.output).toMatchObject({ subject: "Application: backend developer", files: ["jane-doe-cv.txt"], replied: true });
    expect((await platform.tasks.list(companyId)).length).toBe(1);
  });

  it("gives an AI employee work sent to the AI mailbox by a colleague, and ignores strangers", async () => {
    receive("ai@acme.test", { from: { name: "Ayşe Yılmaz", address: "ayse@acme.test" }, to: ["ai+helper@acme.test"], subject: "Summarise the attached policy", body: "For the team meeting." });
    receive("ai@acme.test", { from: { name: "Spammer", address: "win@prizes.example" }, to: ["ai+helper@acme.test"], subject: "You won", body: "Click here." });
    receive("ai@acme.test", { from: { name: "Ayşe Yılmaz", address: "ayse@acme.test" }, to: ["ai@acme.test"], subject: "Helper: book the room for Friday", body: "Room 3." });
    await platform.watchers.pollCompany(companyId, { wait: true });
    const tasks = (await platform.tasks.list(companyId)).filter((t) => t.source === "email");
    expect(tasks.map((t) => [t.title, t.requestedBy]).sort()).toEqual([
      ["Book the room for Friday", "Ayşe Yılmaz"],
      ["Summarise the attached policy", "Ayşe Yılmaz"],
    ]);
    const stranger = (await platform.mail.list(companyId, { mailbox: "ai@acme.test" })).find((m) => m.fromAddress === "win@prizes.example");
    expect(stranger?.status).toBe("ignored");
  });

  it("starts a duty when a new record appears in a connected system", async () => {
    hires.push({ id: "E-1001", name: "Selin Çelik" });
    expect(await platform.watchers.pollCompany(companyId, { wait: true })).toMatchObject({ events: 1 });
    const task = (await platform.tasks.list(companyId)).find((t) => t.source === "connector-event");
    expect(task).toMatchObject({ title: "Onboarder: Selin Çelik", status: "done" });
    const [run] = await platform.tasks.runsOf(task!.id);
    expect(run!.output).toMatchObject({ welcomed: "Selin Çelik" });
  });

  it("records a failing connection and keeps watching the others", async () => {
    mailDown = true;
    hires.push({ id: "E-1002", name: "Kerem Aksoy" });
    const result = await platform.watchers.pollCompany(companyId, { wait: true });
    expect(result.events).toBe(1);
    expect(result.errors).toEqual(["Careers mailbox: The mail server did not answer", "AI mailbox: The mail server did not answer"]);
    const careers = (await platform.watchers.status(companyId)).find((w) => w.key === "new_message" && w.lastError);
    expect(careers?.lastError).toBe("The mail server did not answer");
    mailDown = false;
  });
});
