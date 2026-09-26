import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSftpServer, type SftpTestServer } from "../../../packages/connectors/test/sftp-server.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * An SFTP server connected from Settings: the first test shows the server's host key, IT confirms it,
 * and from then on the connection works. Its settings can be changed later without typing the key
 * again.
 */

describe("an SFTP connection", () => {
  let t: TestApp;
  let server: SftpTestServer;
  const root = mkdtempSync(join(tmpdir(), "eb-sftp-api-"));
  let id = "";

  beforeAll(async () => {
    mkdirSync(join(root, "outgoing"));
    writeFileSync(join(root, "outgoing/payments-0926.csv"), "iban,amount\n");
    server = await startSftpServer(root);
    t = await createTestApp({ seed: false });
  });
  afterAll(async () => {
    await t?.close();
    await server?.close();
  });

  const test = async () => (await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${id}/test` })).json();

  it("shows the server's host key until someone confirms it", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/connectors",
      payload: {
        type: "sftp",
        name: "Bank SFTP",
        values: {
          host: "127.0.0.1",
          port: server.port,
          username: server.username,
          auth_type: "private_key",
          private_key: server.clientKey,
          folder: "/outgoing",
        },
      },
    });
    expect(created.statusCode).toBe(200);
    id = created.json().id;
    expect(created.json().secretFields).toEqual(["private_key"]);

    const unconfirmed = await test();
    expect(unconfirmed).toMatchObject({ ok: false, details: { host_key_fingerprint: server.fingerprint, key_type: "ssh-ed25519", changed: false } });

    await t.app.inject({ method: "PUT", url: `/api/companies/acme/connectors/${id}`, payload: { values: { host_key_fingerprint: server.fingerprint } } });
    expect(await test()).toMatchObject({ ok: true, message: "Connected to 127.0.0.1 as brain (/outgoing): 1 file and 0 folders" });
  });

  it("changes settings, keeping the stored key, and clears the ones given empty", async () => {
    const saved = await t.app.inject({
      method: "PUT",
      url: `/api/companies/acme/connectors/${id}`,
      payload: { name: "Bank SFTP (payments)", values: { folder: "" } },
    });
    expect(saved.json()).toMatchObject({ name: "Bank SFTP (payments)", secretFields: ["private_key"] });
    expect(saved.json().config.folder).toBeUndefined();
    expect(await test()).toMatchObject({ ok: true, message: "Connected to 127.0.0.1 as brain: 0 files and 1 folder" });
    const activity = await t.platform.activity.list(t.companyId, 5);
    expect(activity.map((a) => a.summary)).toContain("Changed the settings of Bank SFTP (payments)");
  });
});
