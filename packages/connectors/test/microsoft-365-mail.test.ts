import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, microsoft365MailConnector } from "../src/index.ts";
import { empty, expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const TENANT = "acme.onmicrosoft.com";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const MAILBOX = "https://graph.microsoft.com/v1.0/users/invoices%40acme.example";

function ctxFor(fake: FakeFetch) {
  return makeCtx({
    fetch: fake.fetch,
    config: { tenant_id: TENANT, client_id: "eb-mail-app", mailbox: "invoices@acme.example" },
    secrets: { client_secret: "graph-secret" },
  });
}

function withToken(fake: FakeFetch): FakeFetch {
  return fake.on("POST", TOKEN_URL, json({ token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: "graph-token" }));
}

const message = (id: string, received: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Invoice ${id}`,
  from: { emailAddress: { name: "Kaya Çelik", address: "e-fatura@kayacelik.example" } },
  toRecipients: [{ emailAddress: { name: "Invoices", address: "invoices@acme.example" } }],
  ccRecipients: [],
  receivedDateTime: received,
  isRead: false,
  hasAttachments: true,
  importance: "normal",
  bodyPreview: "Please find attached",
  conversationId: "conv-1",
  internetMessageId: `<${id}@kayacelik.example>`,
  webLink: "https://outlook.office365.com/owa/?ItemID=x",
  ...extra,
});

describe("microsoft-365-mail", () => {
  beforeEach(() => clearTokenCache());

  it("acquires a Graph token and lists unread messages since a date", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${MAILBOX}/mailFolders/inbox/messages`, json({ value: [message("AAMk1", "2026-09-23T08:15:00Z"), message("AAMk2", "2026-09-22T17:02:00Z")] }));
    const result = await run(microsoft365MailConnector, "list_messages", { unread_only: true, since: "2026-09-20T00:00:00+03:00", top: 2 }, ctxFor(fake));
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: "AAMk1",
      subject: "Invoice AAMk1",
      from: { name: "Kaya Çelik", address: "e-fatura@kayacelik.example" },
      to: [{ name: "Invoices", address: "invoices@acme.example" }],
      received_at: "2026-09-23T08:15:00Z",
      is_read: false,
      has_attachments: true,
    });
    const token = fake.calls[0]!;
    expect(token.url.toString()).toBe(TOKEN_URL);
    expect(Object.fromEntries(token.form!)).toEqual({
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
      client_id: "eb-mail-app",
      client_secret: "graph-secret",
    });
    const list = fake.calls[1]!;
    expect(list.headers.get("authorization")).toBe("Bearer graph-token");
    expect(list.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-09-19T21:00:00Z and isRead eq false");
    expect(list.url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(list.url.searchParams.get("$top")).toBe("2");
  });

  it("follows @odata.nextLink but never sends the token to other hosts", async () => {
    const fake = withToken(new FakeFetch())
      .once("GET", `${MAILBOX}/mailFolders/inbox/messages`, json({ value: [message("A", "2026-09-23T08:00:00Z")], "@odata.nextLink": `${MAILBOX}/mailFolders/inbox/messages?$skip=1` }))
      .on("GET", `${MAILBOX}/mailFolders/inbox/messages`, json({ value: [message("B", "2026-09-22T08:00:00Z")], "@odata.nextLink": "https://evil.example/steal" }));
    const error = await expectConnectorError(microsoft365MailConnector.execute("list_messages", { top: 5 }, ctxFor(fake)));
    expect(error.message).toMatch(/Refusing to send Graph credentials to evil.example/);
    expect(fake.calls.map((c) => c.url.host)).not.toContain("evil.example");
  });

  it("gets a message as text with its attachments, and an attachment's content", async () => {
    const fake = withToken(new FakeFetch())
      .on("GET", `${MAILBOX}/messages/AAMk1`, json(message("AAMk1", "2026-09-23T08:15:00Z", { body: { contentType: "text", content: "Dear Acme,\nplease find our invoice attached." }, sentDateTime: "2026-09-23T08:14:58Z", replyTo: [] })))
      .on("GET", `${MAILBOX}/messages/AAMk1/attachments`, json({
        value: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "ATT1", name: "KCS2026000004187.pdf", contentType: "application/pdf", size: 48213, isInline: false }],
      }))
      .on("GET", `${MAILBOX}/messages/AAMk1/attachments/ATT1`, json({
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "ATT1",
        name: "KCS2026000004187.pdf",
        contentType: "application/pdf",
        size: 48213,
        isInline: false,
        contentBytes: "JVBERi0xLjQK",
      }));
    const ctx = ctxFor(fake);
    const full = await run(microsoft365MailConnector, "get_message", { message_id: "AAMk1" }, ctx);
    expect(full).toMatchObject({ body: "Dear Acme,\nplease find our invoice attached.", body_format: "text", sent_at: "2026-09-23T08:14:58Z" });
    expect(full.attachments).toEqual([{ id: "ATT1", name: "KCS2026000004187.pdf", contentType: "application/pdf", size: 48213, isInline: false, kind: "file" }]);
    expect(fake.calls[1]!.headers.get("prefer")).toBe('outlook.body-content-type="text"');
    const attachment = await run(microsoft365MailConnector, "get_attachment", { message_id: "AAMk1", attachment_id: "ATT1" }, ctx);
    expect(attachment).toEqual({ id: "ATT1", message_id: "AAMk1", name: "KCS2026000004187.pdf", contentType: "application/pdf", size: 48213, isInline: false, contentBytes: "JVBERi0xLjQK" });
  });

  it("sends mail, replies and moves messages", async () => {
    const fake = withToken(new FakeFetch())
      .on("POST", `${MAILBOX}/sendMail`, empty(202))
      .on("POST", `${MAILBOX}/messages/AAMk1/reply`, empty(202))
      .on("GET", `${MAILBOX}/mailFolders`, json({ value: [] }))
      .on("GET", `${MAILBOX}/mailFolders/inbox/childFolders`, json({ value: [{ id: "AQMkProcessedFolderId", displayName: "Processed" }] }))
      .on("POST", `${MAILBOX}/messages/AAMk1/move`, json({ id: "AAMk1-moved" }, 201));
    const ctx = ctxFor(fake);
    const sent = await run(
      microsoft365MailConnector,
      "send_mail",
      { to: "ap@supplier.example, Jonas <j.becker@hansa-pumpen.example>", cc: "ayse.kaya@acme.example", subject: "Invoice KCS2026000004187 received", body: "Hello,\nwe received your invoice." },
      ctx,
    );
    expect(sent).toMatchObject({ ok: true, sent: true, to: ["ap@supplier.example", "j.becker@hansa-pumpen.example"], cc: ["ayse.kaya@acme.example"] });
    expect(fake.callsTo("POST", `${MAILBOX}/sendMail`)[0]!.json).toEqual({
      message: {
        subject: "Invoice KCS2026000004187 received",
        body: { contentType: "Text", content: "Hello,\nwe received your invoice." },
        toRecipients: [{ emailAddress: { address: "ap@supplier.example" } }, { emailAddress: { address: "j.becker@hansa-pumpen.example" } }],
        ccRecipients: [{ emailAddress: { address: "ayse.kaya@acme.example" } }],
      },
      saveToSentItems: true,
    });

    await run(microsoft365MailConnector, "reply_to_message", { message_id: "AAMk1", body: "Thanks <3\nWe will pay on time." }, ctx);
    expect(fake.callsTo("POST", `${MAILBOX}/messages/AAMk1/reply`)[0]!.json).toEqual({ comment: "Thanks &lt;3<br>\nWe will pay on time." });

    const moved = await run(microsoft365MailConnector, "move_message", { message_id: "AAMk1", destination_folder: "Processed" }, ctx);
    expect(moved).toMatchObject({ ok: true, message_id: "AAMk1-moved", destination_folder: "AQMkProcessedFolderId" });
    expect(fake.callsTo("GET", `${MAILBOX}/mailFolders`)[0]!.url.searchParams.get("$filter")).toBe("displayName eq 'Processed'");
    expect(fake.callsTo("POST", `${MAILBOX}/messages/AAMk1/move`)[0]!.json).toEqual({ destinationId: "AQMkProcessedFolderId" });

    expect((await expectConnectorError(microsoft365MailConnector.execute("send_mail", { to: "not an address", subject: "x", body: "y" }, ctx))).code).toBe("validation");
  });

  it("polls new messages with a cursor, without duplicates", async () => {
    let inbox = [message("M1", "2026-09-24T09:00:00Z"), message("M2", "2026-09-24T09:05:00Z")];
    const fake = withToken(new FakeFetch()).on("GET", `${MAILBOX}/mailFolders/inbox/messages`, () => json({ value: inbox }));
    const ctx = ctxFor(fake);
    const first = await microsoft365MailConnector.poll!("new_message", ctx);
    expect(first.events).toEqual([]);
    const cursor = JSON.stringify({ since: "2026-09-24T08:59:00.000Z", seen: [] });
    const second = await microsoft365MailConnector.poll!("new_message", ctx, cursor);
    expect(second.events.map((e) => e.id)).toEqual(["M1", "M2"]);
    expect(second.events[0]).toMatchObject({ type: "new_message", occurredAt: "2026-09-24T09:00:00.000Z", data: { subject: "Invoice M1" } });
    const request = fake.callsTo("GET", `${MAILBOX}/mailFolders/inbox/messages`)[0]!;
    expect(request.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-09-24T08:59:00Z");
    expect(request.url.searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(JSON.parse(second.cursor!)).toEqual({ since: "2026-09-24T09:05:00.000Z", seen: ["M2"] });

    inbox = [message("M2", "2026-09-24T09:05:00Z"), message("M3", "2026-09-24T09:05:00Z")];
    const third = await microsoft365MailConnector.poll!("new_message", ctx, second.cursor);
    expect(third.events.map((e) => e.id)).toEqual(["M3"]);
    expect(JSON.parse(third.cursor!)).toEqual({ since: "2026-09-24T09:05:00.000Z", seen: ["M2", "M3"] });
    expect((await expectConnectorError(microsoft365MailConnector.poll!("unknown_event", ctx))).code).toBe("unsupported");
  });
});
