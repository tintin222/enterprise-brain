import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanPath,
  fileMatcher,
  isHiddenOrPartial,
  openSharedFolder,
  SHARED_FOLDER_ROOTS_ENV,
  sftpConnector,
  sharedFolderConnector,
  type ConnectorContext,
  type ConnectorFiles,
  type ConnectorImplementation,
} from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";
import { startSftpServer, type SftpTestServer } from "./sftp-server.ts";

/**
 * File connections: shared folders mounted on the server and SFTP servers. AI employees list, read,
 * write and move files inside the connection's folder (never above it), and a watched folder's new
 * files start duties, each brought in once.
 */

/** Files stored "in Enterprise Brain" for the connectors that bring files in or send them out. */
function memoryFiles() {
  const stored = new Map<string, { id: string; name: string; mimeType: string; data: Buffer; source: string }>();
  const files: ConnectorFiles = {
    async get(id) {
      const file = stored.get(id);
      if (!file) throw new Error(`File ${id} not found`);
      return file;
    },
    async put(file) {
      const id = `file-${stored.size + 1}`;
      stored.set(id, { id, name: file.name, mimeType: file.mimeType ?? "application/octet-stream", data: file.data, source: file.source });
      return { id };
    },
  };
  return { stored, files };
}

/** A time some minutes ago, for files that finished arriving. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function put(root: string, path: string, content: string | Buffer, modified = minutesAgo(5)) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  utimesSync(full, modified, modified);
}

describe("paths and name patterns", () => {
  it("keeps every path inside the connection's folder", () => {
    expect(cleanPath("/incoming//invoices/INV-1.pdf")).toBe("incoming/invoices/INV-1.pdf");
    expect(cleanPath("incoming\\invoices\\INV-1.pdf")).toBe("incoming/invoices/INV-1.pdf");
    expect(cleanPath("./a/./b/")).toBe("a/b");
    expect(cleanPath("/")).toBe("");
    expect(() => cleanPath("../etc/passwd")).toThrow(/above the connection's folder/);
    expect(() => cleanPath("a/../../b")).toThrow(/above/);
    expect(() => cleanPath("a\0b")).toThrow(/characters/);
  });

  it("matches names by patterns, whatever their case, in linear time", () => {
    const pdfOrXml = fileMatcher("*.pdf; *.XML");
    expect(["INV-1.PDF", "e-fatura.xml", "notes.txt"].map(pdfOrXml)).toEqual([true, true, false]);
    expect(fileMatcher("INV-??.pdf")("INV-12.pdf")).toBe(true);
    expect(fileMatcher("INV-??.pdf")("INV-123.pdf")).toBe(false);
    expect(fileMatcher(undefined)("anything")).toBe(true);
    const started = Date.now();
    expect(fileMatcher("*a*a*a*a*a*a*a*a*a*b")("a".repeat(250))).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("leaves hidden files and files still being written alone", () => {
    expect([".DS_Store", "INV-1.pdf.part", "upload.filepart", "~$budget.xlsx", "report.tmp", "INV-1.pdf"].map(isHiddenOrPartial)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Both kinds of connection behave the same: each suite runs the same operations
// ---------------------------------------------------------------------------

interface Setup {
  connector: ConnectorImplementation;
  /** The folder on disk that the connection's folder is. */
  root: string;
  ctx(config?: Record<string, unknown>, files?: ConnectorFiles): ConnectorContext;
}

function fileOperations(name: string, setup: () => Setup) {
  describe(`${name}: files`, () => {
    it("writes files (folders created, nothing half-written left), and replaces one only when asked", async () => {
      const { connector, root, ctx } = setup();
      const written = await run(connector, "write_file", { path: "outgoing/reports/payments.csv", content: "iban,amount\nTR01,100\n" }, ctx());
      expect(written).toEqual({ ok: true, path: "outgoing/reports/payments.csv", name: "payments.csv", size: 21, replaced: false });
      expect(readFileSync(join(root, "outgoing/reports/payments.csv"), "utf8")).toBe("iban,amount\nTR01,100\n");
      expect(readdirSync(join(root, "outgoing/reports"))).toEqual(["payments.csv"]);

      const again = await expectConnectorError(run(connector, "write_file", { path: "/outgoing/reports/payments.csv", content: "other" }, ctx()));
      expect(again.message).toMatch(/already exists; say overwrite/);
      expect(await run(connector, "write_file", { path: "outgoing/reports/payments.csv", content: "v2", overwrite: true }, ctx())).toMatchObject({
        replaced: true,
      });
      expect(readFileSync(join(root, "outgoing/reports/payments.csv"), "utf8")).toBe("v2");
      expect(readdirSync(join(root, "outgoing/reports"))).toEqual(["payments.csv"]);

      expect((await expectConnectorError(run(connector, "write_file", { path: "x.txt" }, ctx()))).message).toMatch(/one way/);
      expect((await expectConnectorError(run(connector, "write_file", { path: "../x.txt", content: "x" }, ctx()))).message).toMatch(/above/);
    });

    it("sends a file stored in Enterprise Brain, keeping its name when given a folder", async () => {
      const { connector, root, ctx } = setup();
      const { files } = memoryFiles();
      const { id } = await files.put({ name: "September payments.xlsx", data: Buffer.from("PK-xlsx"), source: "generated" });
      expect(await run(connector, "write_file", { path: "outgoing/", file_id: id }, ctx({}, files))).toMatchObject({
        path: "outgoing/September payments.xlsx",
      });
      expect(readFileSync(join(root, "outgoing/September payments.xlsx"), "utf8")).toBe("PK-xlsx");
      expect((await expectConnectorError(run(connector, "write_file", { path: "outgoing/", file_id: id }, ctx()))).message).toMatch(/inside Enterprise Brain/);
      // A stored name is one name, never a path.
      const odd = await files.put({ name: "reports/../../escape.txt", data: Buffer.from("x"), source: "email" });
      expect(await run(connector, "write_file", { path: "outgoing/", file_id: odd.id }, ctx({}, files))).toMatchObject({
        path: "outgoing/reports_.._.._escape.txt",
      });
    });

    it("lists newest first, by pattern, and into subfolders when asked", async () => {
      const { connector, root, ctx } = setup();
      put(root, "in/INV-1.pdf", "one", minutesAgo(30));
      put(root, "in/INV-2.pdf", "two!", minutesAgo(10));
      put(root, "in/notes.txt", "n", minutesAgo(5));
      put(root, "in/2026/INV-0.pdf", "zero", minutesAgo(60));
      put(root, "in/.hidden", "h");
      const listed = await run(connector, "list_files", { folder: "in", pattern: "*.pdf" }, ctx());
      expect(listed.items.map((i: { path: string }) => i.path)).toEqual(["in/INV-2.pdf", "in/INV-1.pdf", "in/2026"]);
      expect(listed.items[0]).toMatchObject({ name: "INV-2.pdf", type: "file", size: 4 });
      const deep = await run(connector, "list_files", { folder: "/in", pattern: "*.pdf", recursive: true, limit: 3 }, ctx());
      expect(deep).toMatchObject({ total: 3, has_more: true });
      const all = await run(connector, "list_files", { folder: "in", pattern: "*.pdf", recursive: true }, ctx());
      expect(all.items.filter((i: { type: string }) => i.type === "file").map((i: { path: string }) => i.path)).toEqual([
        "in/INV-2.pdf",
        "in/INV-1.pdf",
        "in/2026/INV-0.pdf",
      ]);
      expect((await expectConnectorError(run(connector, "list_files", { folder: "missing" }, ctx()))).code).toBe("not_found");
    });

    it("reads a file: stored in Enterprise Brain when inside it, with the text of small text files", async () => {
      const { connector, root, ctx } = setup();
      put(root, "orders/0926.csv", "﻿sku,qty\nV-100,4\n");
      put(root, "orders/scan.pdf", Buffer.from("%PDF-1.7 binary\xff", "latin1"));
      const plain = await run(connector, "read_file", { path: "orders/0926.csv" }, ctx());
      expect(plain).toMatchObject({ name: "0926.csv", mime_type: "text/csv", text: "sku,qty\nV-100,4\n" });
      expect(Buffer.from(plain.content_base64, "base64").toString("utf8")).toBe("﻿sku,qty\nV-100,4\n");

      const { stored, files } = memoryFiles();
      const pdf = await run(connector, "read_file", { path: "orders/scan.pdf" }, ctx({}, files));
      expect(pdf).toMatchObject({ name: "scan.pdf", mime_type: "application/pdf", file_id: "file-1" });
      expect(pdf.content_base64).toBeUndefined();
      expect(pdf.text).toBeUndefined();
      expect(stored.get("file-1")).toMatchObject({ name: "scan.pdf", source: "file-connection" });

      expect((await expectConnectorError(run(connector, "read_file", { path: "orders" }, ctx()))).message).toMatch(/is a folder/);
      expect((await expectConnectorError(run(connector, "read_file", { path: "orders/none.csv" }, ctx()))).code).toBe("not_found");
      put(root, "big.bin", Buffer.alloc(1024 * 1024 + 1));
      expect((await expectConnectorError(run(connector, "read_file", { path: "big.bin" }, ctx({ max_file_mb: 1 })))).message).toMatch(/files up to 1 MB/);
    });

    it("moves files into a folder under their own name, or to a new name", async () => {
      const { connector, root, ctx } = setup();
      put(root, "in/INV-1.pdf", "one");
      put(root, "in/INV-2.pdf", "two");
      expect(await run(connector, "move_file", { from: "in/INV-1.pdf", to: "archive/2026/" }, ctx())).toEqual({
        ok: true,
        from: "in/INV-1.pdf",
        to: "archive/2026/INV-1.pdf",
      });
      expect(readFileSync(join(root, "archive/2026/INV-1.pdf"), "utf8")).toBe("one");
      expect(existsSync(join(root, "in/INV-1.pdf"))).toBe(false);
      // An existing folder counts as a folder, even without "/".
      expect(await run(connector, "move_file", { from: "in/INV-2.pdf", to: "archive/2026" }, ctx())).toMatchObject({ to: "archive/2026/INV-2.pdf" });
      put(root, "in/INV-2.pdf", "two again");
      expect((await expectConnectorError(run(connector, "move_file", { from: "in/INV-2.pdf", to: "archive/2026/" }, ctx()))).message).toMatch(/already exists/);
      await run(connector, "move_file", { from: "in/INV-2.pdf", to: "archive/2026/INV-2.pdf", overwrite: true }, ctx());
      expect(readFileSync(join(root, "archive/2026/INV-2.pdf"), "utf8")).toBe("two again");
      expect(await run(connector, "move_file", { from: "archive/2026/INV-2.pdf", to: "archive/INV-2 (checked).pdf" }, ctx())).toMatchObject({
        to: "archive/INV-2 (checked).pdf",
      });
    });
  });

  describe(`${name}: watching a folder`, () => {
    const watch = { watch_folder: "incoming", watch_pattern: "*.pdf; *.xml", settle_seconds: 30 };
    beforeEach(() => mkdirSync(join(setup().root, "incoming"), { recursive: true }));

    it("says when the watched folder is missing", async () => {
      const { connector, ctx } = setup();
      expect((await expectConnectorError(connector.poll!("new_file", ctx({ watch_folder: "incomming" })))).message).toBe(
        "The watched folder incomming doesn't exist",
      );
    });

    it("brings each new file in once; what was there before is left alone", async () => {
      const { connector, root, ctx } = setup();
      put(root, "incoming/old.pdf", "old");
      const { stored, files } = memoryFiles();
      const first = await connector.poll!("new_file", ctx(watch, files));
      expect(first.events).toEqual([]);

      put(root, "incoming/INV-7.pdf", "invoice seven", minutesAgo(2));
      put(root, "incoming/e-fatura.xml", "<Invoice/>", minutesAgo(1));
      put(root, "incoming/notes.txt", "not watched", minutesAgo(1));
      put(root, "incoming/INV-8.pdf.part", "half", minutesAgo(1));
      put(root, "incoming/INV-9.pdf", "still arriving", new Date());
      const second = await connector.poll!("new_file", ctx(watch, files), first.cursor);
      expect(second.events.map((e) => e.data.name)).toEqual(["INV-7.pdf", "e-fatura.xml"]);
      expect(second.events[0]).toMatchObject({ type: "new_file", id: expect.stringMatching(/^incoming\/INV-7\.pdf@/) });
      expect(second.events[0]!.data).toMatchObject({
        path: "incoming/INV-7.pdf",
        folder: "incoming",
        size: 13,
        mime_type: "application/pdf",
        file_id: "file-1",
      });
      expect(second.events[1]!.data).toMatchObject({ text: "<Invoice/>", file_id: "file-2" });
      expect(stored.get("file-1")).toMatchObject({ name: "INV-7.pdf", source: "watched-folder", data: Buffer.from("invoice seven") });

      // Nothing new: nothing brought in. The file that finished arriving comes next.
      expect((await connector.poll!("new_file", ctx(watch, files), second.cursor)).events).toEqual([]);
      utimesSync(join(root, "incoming/INV-9.pdf"), minutesAgo(1), minutesAgo(1));
      const third = await connector.poll!("new_file", ctx(watch, files), second.cursor);
      expect(third.events.map((e) => e.data.name)).toEqual(["INV-9.pdf"]);

      // A newer version under the same name is a new file.
      put(root, "incoming/INV-7.pdf", "invoice seven, corrected", minutesAgo(0.75));
      const fourth = await connector.poll!("new_file", ctx(watch, files), third.cursor);
      expect(fourth.events.map((e) => e.data.name)).toEqual(["INV-7.pdf"]);
      expect((await connector.poll!("new_file", ctx(watch, files), fourth.cursor)).events).toEqual([]);
    });

    it("moves picked-up files to the processed folder, never over one already there", async () => {
      const { connector, root, ctx } = setup();
      const config = { ...watch, processed_folder: "incoming/done" };
      const { files } = memoryFiles();
      const start = await connector.poll!("new_file", ctx(config, files));
      put(root, "incoming/done/INV-1.pdf", "handled last week");
      put(root, "incoming/INV-1.pdf", "a new INV-1");
      put(root, "incoming/INV-2.pdf", "two");
      const next = await connector.poll!("new_file", ctx(config, files), start.cursor);
      expect(next.events.map((e) => [e.data.name, e.data.moved_to])).toEqual([
        ["INV-1.pdf", expect.stringMatching(/^incoming\/done\/INV-1 \d{8}-\d{6}\.pdf$/)],
        ["INV-2.pdf", "incoming/done/INV-2.pdf"],
      ]);
      expect(readdirSync(join(root, "incoming")).sort()).toEqual(["done"]);
      expect(readFileSync(join(root, "incoming/done/INV-1.pdf"), "utf8")).toBe("handled last week");
      expect((await connector.poll!("new_file", ctx(config, files), next.cursor)).events).toEqual([]);
    });

    it("tells why a file is left alone", async () => {
      const { connector, root, ctx } = setup();
      const config = { ...watch, max_file_mb: 1 };
      const start = await connector.poll!("new_file", ctx(config));
      put(root, "incoming/huge-scan.pdf", Buffer.alloc(1024 * 1024 + 10));
      const next = await connector.poll!("new_file", ctx(config), start.cursor);
      expect(next.events).toEqual([]);
      expect(next.warnings).toEqual(["incoming/huge-scan.pdf is 1 MB; files up to 1 MB are picked up"]);
      // Said once, not at every check.
      expect((await connector.poll!("new_file", ctx(config), next.cursor)).warnings).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Shared folders
// ---------------------------------------------------------------------------

describe("shared folders", () => {
  const allowed = realpathSync(mkdtempSync(join(tmpdir(), "eb-shares-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "eb-outside-")));
  let previous: string | undefined;
  let root = "";

  beforeAll(() => {
    previous = process.env[SHARED_FOLDER_ROOTS_ENV];
    process.env[SHARED_FOLDER_ROOTS_ENV] = allowed;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env[SHARED_FOLDER_ROOTS_ENV];
    else process.env[SHARED_FOLDER_ROOTS_ENV] = previous;
  });
  beforeEach(() => {
    root = mkdtempSync(join(allowed, "finance-"));
  });

  const ctx = (config: Record<string, unknown> = {}, files?: ConnectorFiles) => makeCtx({ config: { path: root, ...config }, ...(files ? { files } : {}) });

  fileOperations("shared folder", () => ({ connector: sharedFolderConnector, root, ctx }));

  it("only opens folders the server's operator allowed", async () => {
    const at = (path: string, env: NodeJS.ProcessEnv = { [SHARED_FOLDER_ROOTS_ENV]: allowed }) =>
      expectConnectorError(openSharedFolder(makeCtx({ config: { path } }), env));
    expect((await at(root, {})).message).toMatch(/hasn't allowed any shared folders yet/);
    expect((await at(outside)).message).toMatch(/isn't inside a folder the server's operator allowed/);
    expect((await at("finance")).message).toMatch(/full path/);
    expect((await at(join(allowed, "not-mounted"))).message).toMatch(/doesn't exist/);
    expect(await sharedFolderConnector.test(ctx())).toMatchObject({ ok: true, message: `Connected to ${root}: 0 files and 0 folders` });
    expect(await sharedFolderConnector.test(ctx({ watch_folder: "incoming" }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/watched folder incoming doesn't exist/),
    });
  });

  it("never follows links out of the folder", async () => {
    put(outside, "secret.txt", "not yours");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"));
    put(root, "inside.txt", "fine");
    symlinkSync(join(root, "inside.txt"), join(root, "inside-link.txt"));

    expect((await expectConnectorError(run(sharedFolderConnector, "read_file", { path: "escape/secret.txt" }, ctx()))).message).toMatch(/leads outside/);
    expect((await expectConnectorError(run(sharedFolderConnector, "read_file", { path: "secret-link.txt" }, ctx()))).message).toMatch(/leads outside/);
    expect((await expectConnectorError(run(sharedFolderConnector, "write_file", { path: "escape/planted.txt", content: "x" }, ctx()))).message).toMatch(
      /leads outside/,
    );
    expect((await expectConnectorError(run(sharedFolderConnector, "move_file", { from: "inside.txt", to: "escape/" }, ctx()))).message).toMatch(
      /leads outside/,
    );
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    // Links that stay inside work; those leading out are not even listed.
    expect(await run(sharedFolderConnector, "read_file", { path: "inside-link.txt" }, ctx())).toMatchObject({ text: "fine" });
    const listed = await run(sharedFolderConnector, "list_files", {}, ctx());
    expect(listed.items.map((i: { name: string }) => i.name).sort()).toEqual(["inside-link.txt", "inside.txt"]);
  });
});

// ---------------------------------------------------------------------------
// SFTP servers, against a real one
// ---------------------------------------------------------------------------

describe("SFTP servers", () => {
  const serverRoot = mkdtempSync(join(tmpdir(), "eb-sftp-"));
  let server: SftpTestServer;
  let root = "";
  let folder = "";

  beforeAll(async () => {
    server = await startSftpServer(serverRoot);
  });
  afterAll(() => server?.close());
  beforeEach(() => {
    folder = `drop-${Math.random().toString(36).slice(2, 8)}`;
    root = join(serverRoot, folder);
    mkdirSync(root);
  });

  const base = () => ({
    host: "127.0.0.1",
    port: server.port,
    username: server.username,
    auth_type: "private_key",
    host_key_fingerprint: server.fingerprint,
    folder: `/${folder}`,
  });
  const ctx = (config: Record<string, unknown> = {}, files?: ConnectorFiles) =>
    makeCtx({ config: { ...base(), ...config }, secrets: { private_key: server.clientKey }, ...(files ? { files } : {}) });

  fileOperations("SFTP", () => ({ connector: sftpConnector, root, ctx }));

  it("shows the server's host key until IT confirms it, and refuses a server with another key", async () => {
    const unconfirmed = await sftpConnector.test(ctx({ host_key_fingerprint: "" }));
    expect(unconfirmed).toMatchObject({ ok: false, details: { host_key_fingerprint: server.fingerprint, key_type: "ssh-ed25519", changed: false } });
    expect(unconfirmed.message).toContain(`Confirm the server's host key: its ssh-ed25519 key has the fingerprint ${server.fingerprint}`);

    const impostor = ctx({ host_key_fingerprint: "SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKey" });
    expect((await expectConnectorError(run(sftpConnector, "list_files", {}, impostor))).message).toMatch(/not the one confirmed for this connection/);
    expect(await sftpConnector.test(impostor)).toMatchObject({ ok: false, details: { host_key_fingerprint: server.fingerprint, changed: true } });

    expect(await sftpConnector.test(ctx())).toMatchObject({ ok: true, message: `Connected to 127.0.0.1 as brain (/${folder}): 0 files and 0 folders` });
    // As ssh-keygen shows it, with or without the prefix and padding.
    expect(await sftpConnector.test(ctx({ host_key_fingerprint: `${server.fingerprint.slice(7)}=` }))).toMatchObject({ ok: true });
  });

  it("signs in with a password too, and says when it is refused", async () => {
    const password = (value: string) => makeCtx({ config: { ...base(), auth_type: "password" }, secrets: { password: value } });
    expect(await sftpConnector.test(password(server.password))).toMatchObject({ ok: true });
    expect(await sftpConnector.test(password("wrong"))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/refused to sign brain in: check the password/),
    });
    expect(await sftpConnector.test(ctx({ folder: "/not-there" }))).toMatchObject({ ok: false, message: "There is no folder /not-there on 127.0.0.1" });
  });

  it("uses one session for a whole check of the watched folder", async () => {
    const config = { watch_folder: "incoming", settle_seconds: 0 };
    mkdirSync(join(root, "incoming"));
    const start = await sftpConnector.poll!("new_file", ctx(config));
    put(root, "incoming/a.xml", "<a/>");
    put(root, "incoming/b.xml", "<b/>");
    const before = server.sessions();
    const next = await sftpConnector.poll!("new_file", ctx(config), start.cursor);
    expect(next.events.map((e) => e.data.text)).toEqual(["<a/>", "<b/>"]);
    expect(server.sessions() - before).toBe(1);
  });
});
