import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, gmailConnector } from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function ctxFor(fake: FakeFetch) {
  return makeCtx({
    fetch: fake.fetch,
    config: { client_id: "123-abc.apps.googleusercontent.com" },
    secrets: { client_secret: "GOCSPX-secret", refresh_token: "1//0refresh" },
  });
}

function withToken(fake: FakeFetch): FakeFetch {
  return fake.on("POST", TOKEN_URL, json({ access_token: "ya29.token", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" }));
}

const metadata = (id: string, internalDate: number, labels = ["INBOX", "UNREAD"]) => ({
  id,
  threadId: `t-${id}`,
  labelIds: labels,
  snippet: "Please find attached our offer",
  internalDate: String(internalDate),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "\"Hansa Pumpen, Einkauf\" <einkauf@hansa-pumpen.example>" },
      { name: "To", value: "sales@acme.example, \"Weber, Thomas\" <thomas.weber@acme.example>" },
      { name: "Subject", value: `Anfrage ${id}` },
      { name: "Date", value: "Thu, 24 Sep 2026 09:00:00 +0200" },
      { name: "Message-ID", value: `<${id}@hansa-pumpen.example>` },
    ],
  },
});

describe("gmail", () => {
  beforeEach(() => clearTokenCache());

  it("refreshes the access token and lists messages with Gmail search", async () => {
    const fake = withToken(new FakeFetch())
      .on("GET", `${API}/messages`, json({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], resultSizeEstimate: 2 }))
      .on("GET", `${API}/messages/m1`, json(metadata("m1", Date.UTC(2026, 8, 24, 7))))
      .on("GET", `${API}/messages/m2`, json(metadata("m2", Date.UTC(2026, 8, 23, 7), ["INBOX"])));
    const result = await run(gmailConnector, "list_messages", { unread_only: true, since: "2026-09-20T00:00:00Z", query: "has:attachment", top: 2 }, ctxFor(fake));
    expect(result.items.map((m: any) => m.id)).toEqual(["m1", "m2"]);
    expect(result.items[0]).toMatchObject({
      subject: "Anfrage m1",
      from: "\"Hansa Pumpen, Einkauf\" <einkauf@hansa-pumpen.example>",
      to: ["sales@acme.example", "\"Weber, Thomas\" <thomas.weber@acme.example>"],
      received_at: "2026-09-24T07:00:00.000Z",
      is_read: false,
    });
    expect(result.items[1].is_read).toBe(true);
    expect(Object.fromEntries(fake.calls[0]!.form!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "1//0refresh",
      client_id: "123-abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret",
    });
    const list = fake.calls[1]!;
    expect(list.headers.get("authorization")).toBe("Bearer ya29.token");
    expect(list.url.searchParams.get("q")).toBe(`has:attachment is:unread after:${Date.UTC(2026, 8, 20) / 1000}`);
    expect(list.url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
    expect(list.url.searchParams.get("maxResults")).toBe("2");
    const meta = fake.callsTo("GET", `${API}/messages/m1`)[0]!;
    expect(meta.url.searchParams.get("format")).toBe("metadata");
    expect(meta.url.searchParams.getAll("metadataHeaders")).toContain("Subject");
  });

  it("resolves user label names to label ids", async () => {
    const fake = withToken(new FakeFetch())
      .on("GET", `${API}/labels`, json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_7", name: "Invoices", type: "user" }] }))
      .on("GET", `${API}/messages`, json({ resultSizeEstimate: 0 }));
    const result = await run(gmailConnector, "list_messages", { folder: "invoices" }, ctxFor(fake));
    expect(result).toMatchObject({ items: [], total: 0, folder: "Label_7" });
    expect(fake.callsTo("GET", `${API}/messages`)[0]!.url.searchParams.getAll("labelIds")).toEqual(["Label_7"]);
    expect((await expectConnectorError(gmailConnector.execute("list_messages", { folder: "Nope" }, ctxFor(fake)))).code).toBe("not_found");
  });

  it("decodes message bodies (charset aware) and lists attachments", async () => {
    const latin5 = Buffer.from([0x53, 0x61, 0x79, 0xfd, 0x6e, 0x20, 0xdd, 0x6c, 0x67, 0x69, 0x6c, 0x69]); // "Sayın İlgili" in ISO-8859-9
    const fake = withToken(new FakeFetch())
      .on("GET", `${API}/messages/m1`, json({
        ...metadata("m1", Date.UTC(2026, 8, 24, 7)),
        payload: {
          ...metadata("m1", 0).payload,
          parts: [
            {
              partId: "0",
              mimeType: "multipart/alternative",
              parts: [
                { partId: "0.0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=\"ISO-8859-9\"" }], body: { size: 12, data: latin5.toString("base64url") } },
                { partId: "0.1", mimeType: "text/html", body: { size: 20, data: b64url("<p>ignored</p>") } },
              ],
            },
            { partId: "1", mimeType: "application/pdf", filename: "Anfrage-2026-117.pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename=\"Anfrage-2026-117.pdf\"" }], body: { attachmentId: "ANGjdJ8", size: 52011 } },
          ],
        },
      }))
      .on("GET", `${API}/messages/m1/attachments/ANGjdJ8`, json({ size: 5, data: Buffer.from("%PDF-").toString("base64url") }));
    const ctx = ctxFor(fake);
    const message = await run(gmailConnector, "get_message", { message_id: "m1" }, ctx);
    expect(message.body).toBe("Sayın İlgili");
    expect(message.attachments).toEqual([{ id: "ANGjdJ8", name: "Anfrage-2026-117.pdf", contentType: "application/pdf", size: 52011, isInline: false, part_id: "1" }]);
    const attachment = await run(gmailConnector, "get_attachment", { message_id: "m1", attachment_id: "ANGjdJ8" }, ctx);
    expect(attachment).toEqual({
      id: "ANGjdJ8",
      message_id: "m1",
      name: "Anfrage-2026-117.pdf",
      contentType: "application/pdf",
      size: 5,
      contentBytes: Buffer.from("%PDF-").toString("base64"),
    });
  });

  it("sends mail as base64url-encoded RFC 2822 with encoded headers", async () => {
    const fake = withToken(new FakeFetch()).on("POST", `${API}/messages/send`, json({ id: "sent-1", threadId: "t-9", labelIds: ["SENT"] }));
    const result = await run(
      gmailConnector,
      "send_mail",
      { to: "einkauf@hansa-pumpen.example", cc: "laura.rossi@acme.example", subject: "Angebot für ACP-80 – Teklif", body: "Sehr geehrte Damen und Herren,\nanbei unser Angebot.", thread_id: "t-9", in_reply_to: "<m1@hansa-pumpen.example>" },
      ctxFor(fake),
    );
    expect(result).toMatchObject({ ok: true, id: "sent-1", thread_id: "t-9" });
    const body = fake.calls[1]!.json as { raw: string; threadId: string };
    expect(body.threadId).toBe("t-9");
    const raw = Buffer.from(body.raw, "base64url").toString("utf8");
    const [head, encodedBody] = raw.split("\r\n\r\n");
    expect(head).toContain("To: einkauf@hansa-pumpen.example");
    expect(head).toContain("Cc: laura.rossi@acme.example");
    expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from("Angebot für ACP-80 – Teklif").toString("base64")}?=`);
    expect(head).toContain("In-Reply-To: <m1@hansa-pumpen.example>");
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(Buffer.from(encodedBody!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Sehr geehrte Damen und Herren,\nanbei unser Angebot.");
  });

  it("prevents header injection through the subject", async () => {
    const fake = withToken(new FakeFetch()).on("POST", `${API}/messages/send`, json({ id: "x" }));
    await run(gmailConnector, "send_mail", { to: "a@example.com", subject: "Hi\r\nBcc: victim@example.com", body: "x" }, ctxFor(fake));
    const raw = Buffer.from((fake.calls[1]!.json as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it("polls new inbox messages by internal date", async () => {
    const since = Date.UTC(2026, 8, 24, 9, 0, 0);
    const fake = withToken(new FakeFetch())
      .on("GET", `${API}/messages`, json({ messages: [{ id: "n2" }, { id: "n1" }, { id: "old" }] }))
      .on("GET", `${API}/messages/n1`, json(metadata("n1", since + 60_000)))
      .on("GET", `${API}/messages/n2`, json(metadata("n2", since + 120_000)))
      .on("GET", `${API}/messages/old`, json(metadata("old", since - 1_000)));
    const ctx = ctxFor(fake);
    const result = await gmailConnector.poll!("new_message", ctx, JSON.stringify({ since: new Date(since).toISOString(), seen: [] }));
    expect(result.events.map((e) => e.id)).toEqual(["n1", "n2"]);
    expect(fake.callsTo("GET", `${API}/messages`)[0]!.url.searchParams.get("q")).toBe(`after:${since / 1000 - 1}`);
    expect(JSON.parse(result.cursor!)).toEqual({ since: new Date(since + 120_000).toISOString(), seen: ["n2"] });
  });

  it("maps Google API errors", async () => {
    const fake = withToken(new FakeFetch()).on("GET", `${API}/messages/nope`, json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404));
    const error = await expectConnectorError(gmailConnector.execute("get_message", { message_id: "nope" }, ctxFor(fake)));
    expect(error).toMatchObject({ code: "not_found", message: "Gmail returned HTTP 404: NOT_FOUND: Requested entity was not found." });
  });
});
