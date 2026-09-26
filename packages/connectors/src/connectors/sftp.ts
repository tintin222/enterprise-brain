import { createHash, randomUUID } from "node:crypto";
import type { Client, ConnectConfig, SFTPWrapper, Stats } from "ssh2";
import { defineConnector, defineManifest } from "../define.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { configBoolean, configNumber, configString, errorMessage, optionalSecret, requireConfig, requireSecret } from "../util.ts";
import {
  FILE_OPERATIONS,
  FILE_WATCH_CONFIG,
  fileHandlers,
  folderTest,
  joinPath,
  nameOf,
  NEW_FILE_EVENT,
  parentOf,
  pollNewFiles,
  type FileEntry,
  type FileStore,
} from "./file-common.ts";

/**
 * SFTP servers (SSH File Transfer Protocol): the drop folders of banks, suppliers, EDI partners and
 * older systems. The server's host key is always checked against the fingerprint IT confirmed.
 */

const AUTH = { key: "auth_type" } as const;
const CONNECT_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 120_000;

/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

/** OpenSSH's fingerprint of a host key: "SHA256:" and the unpadded base64 of its SHA-256 hash. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function md5Fingerprint(key: Buffer): string {
  return `MD5:${createHash("md5")
    .update(key)
    .digest("hex")
    .replace(/(..)(?=.)/g, "$1:")}`;
}

/** The key's type, from its wire form ("ssh-ed25519", "rsa-sha2-512"…). */
function keyType(key: Buffer): string {
  try {
    const length = key.readUInt32BE(0);
    return key.subarray(4, 4 + length).toString("latin1");
  } catch {
    return "host";
  }
}

/** The fingerprints IT confirmed, in canonical form: "SHA256:…" (as ssh-keygen -lf shows it) or "MD5:aa:bb:…". */
function confirmedFingerprints(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => {
      if (/^md5:/i.test(f)) return `MD5:${f.slice(4).toLowerCase()}`;
      if (/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(f)) return `MD5:${f.toLowerCase()}`;
      return `SHA256:${f.replace(/^sha256:/i, "").replace(/=+$/, "")}`;
    });
}

function sftpError(error: unknown, path: string, verb: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  const where = path || "the connection's folder";
  if (code === NO_SUCH_FILE) return new ConnectorError(`There is no file or folder at ${where}`, "not_found");
  if (code === PERMISSION_DENIED) return new ConnectorError(`The SFTP account may not ${verb} ${where}`, "auth");
  return new ConnectorError(`The SFTP server could not ${verb} ${where}: ${errorMessage(error)}`, "remote");
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === NO_SUCH_FILE;
}

/** A call to the SFTP server, as a promise with a time limit. */
function call<T>(start: (done: (error: Error | null | undefined, value?: T) => void) => void, what: string, ms = OPERATION_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConnectorError(`The SFTP server did not answer in time (${what})`, "remote")), ms);
    try {
      start((error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

class SftpStore implements FileStore {
  constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    /** The connection's folder on the server ("" is the account's home folder). */
    private readonly base: string,
    private readonly direct: boolean,
  ) {}

  full(path: string): string {
    if (!this.base) return path || ".";
    if (!path) return this.base;
    return this.base === "/" ? `/${path}` : `${this.base}/${path}`;
  }

  private entry(path: string, stats: Stats): FileEntry {
    const folder = stats.isDirectory();
    return {
      name: nameOf(path) || this.base || "/",
      path,
      type: folder ? "folder" : "file",
      size: folder ? 0 : stats.size,
      modifiedAt: new Date(stats.mtime * 1000),
    };
  }

  async list(folder: string): Promise<FileEntry[]> {
    const list = await call<{ filename: string; attrs: Stats }[]>((done) => this.sftp.readdir(this.full(folder), done), "list").catch((error) => {
      throw sftpError(error, folder, "list");
    });
    const entries: FileEntry[] = [];
    for (const { filename, attrs } of list) {
      if (filename === "." || filename === "..") continue;
      const path = joinPath(folder, filename);
      // A link is listed as what it leads to.
      const stats = attrs.isSymbolicLink() ? await this.statOf(path).catch(() => undefined) : attrs;
      if (stats && (stats.isFile() || stats.isDirectory())) entries.push(this.entry(path, stats));
    }
    return entries;
  }

  private statOf(path: string): Promise<Stats> {
    return call<Stats>((done) => this.sftp.stat(this.full(path), done), "stat");
  }

  async stat(path: string): Promise<FileEntry | undefined> {
    try {
      const stats = await this.statOf(path);
      return stats.isFile() || stats.isDirectory() ? this.entry(path, stats) : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw sftpError(error, path, "open");
    }
  }

  read(path: string, maxBytes: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = this.sftp.createReadStream(this.full(path));
      const timer = setTimeout(() => fail(new ConnectorError(`The SFTP server did not send ${path} in time`, "remote")), OPERATION_TIMEOUT_MS);
      const fail = (error: unknown) => {
        clearTimeout(timer);
        stream.destroy();
        reject(sftpError(error, path, "read"));
      };
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) return fail(new ConnectorError(`${path} is larger than ${Math.round(maxBytes / 1048576)} MB`, "validation"));
        chunks.push(chunk);
      });
      stream.on("error", fail);
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks, total));
      });
    });
  }

  private async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    const source = this.full(from);
    const target = this.full(to);
    if (overwrite) {
      // OpenSSH's posix-rename replaces the target at once; other servers: remove it first.
      try {
        return await call<void>((done) => this.sftp.ext_openssh_rename(source, target, done), "rename");
      } catch (error) {
        if (!/does not support/i.test(errorMessage(error))) throw error;
      }
      await call<void>((done) => this.sftp.unlink(target, done), "remove").catch((error) => {
        if (!missing(error)) throw error;
      });
    }
    await call<void>((done) => this.sftp.rename(source, target, done), "rename");
  }

  async write(path: string, data: Buffer, overwrite: boolean): Promise<void> {
    try {
      if (this.direct) {
        await call<void>((done) => this.sftp.writeFile(this.full(path), data, done), "write");
        return;
      }
      // Under a temporary name first, so whoever watches the folder never picks up half a file.
      const temporary = joinPath(parentOf(path), `.${nameOf(path)}.${randomUUID().slice(0, 8)}.part`);
      await call<void>((done) => this.sftp.writeFile(this.full(temporary), data, done), "write");
      try {
        await this.rename(temporary, path, overwrite);
      } catch (error) {
        await call<void>((done) => this.sftp.unlink(this.full(temporary), done), "remove").catch(() => undefined);
        throw error;
      }
    } catch (error) {
      throw sftpError(error, path, "write");
    }
  }

  async move(from: string, to: string, overwrite: boolean): Promise<void> {
    await this.rename(from, to, overwrite).catch((error) => {
      throw sftpError(error, from, "move");
    });
  }

  async makeFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = joinPath(current, part);
      const existing = await this.stat(current);
      if (existing?.type === "folder") continue;
      if (existing) throw new ConnectorError(`${current} is a file, not a folder`, "validation");
      await call<void>((done) => this.sftp.mkdir(this.full(current), done), "create folder").catch((error) => {
        throw sftpError(error, current, "create");
      });
    }
  }

  async close(): Promise<void> {
    this.client.end();
  }
}

/** ssh2 is CommonJS: its exports, however the module system hands them over. */
export async function loadSsh2(): Promise<typeof import("ssh2")> {
  const module = (await import("ssh2")) as typeof import("ssh2") & { default?: typeof import("ssh2") };
  return module.default ?? module;
}

/** The server's host key as it presented it, when a connection was refused for it. */
class HostKeyUnconfirmed extends ConnectorError {
  constructor(
    readonly fingerprint: string,
    readonly type: string,
    /** Another key was confirmed before: the server's key changed (or something pretends to be it). */
    readonly changed: boolean,
  ) {
    super(
      changed
        ? `The server's ${type} key has the fingerprint ${fingerprint}, not the one confirmed for this connection. If the server's key really changed, confirm the new fingerprint with its administrator; otherwise something is pretending to be the server.`
        : `Confirm the server's host key: its ${type} key has the fingerprint ${fingerprint}. Check it with the server's administrator, then enter it in Host key fingerprint.`,
      "config",
    );
  }
}

/** Connected and signed in, with the server's host key checked, and the SFTP session open. */
export async function openSftp(ctx: ConnectorContext): Promise<SftpStore> {
  const host = requireConfig(ctx, "host", "Host");
  const port = configNumber(ctx, "port", 22);
  const username = requireConfig(ctx, "username", "Username");
  const confirmed = confirmedFingerprints(configString(ctx, "host_key_fingerprint"));
  const auth = configString(ctx, "auth_type", "private_key");
  let presented: { sha256: string; md5: string; type: string } | undefined;

  const config: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    hostVerifier: (key: Buffer) => {
      presented = { sha256: hostKeyFingerprint(key), md5: md5Fingerprint(key), type: keyType(key) };
      return confirmed.includes(presented.sha256) || confirmed.includes(presented.md5);
    },
  };
  if (auth === "password") {
    config.password = requireSecret(ctx, "password", "Password");
    config.tryKeyboard = true;
  } else {
    config.privateKey = requireSecret(ctx, "private_key", "Private key");
    const passphrase = optionalSecret(ctx, "passphrase");
    if (passphrase) config.passphrase = passphrase;
  }

  const client = new (await loadSsh2()).Client();
  const where = `${host}:${port}`;
  await new Promise<void>((resolve, reject) => {
    client.on("ready", () => resolve());
    client.on("close", () => reject(new ConnectorError(`${where} closed the connection`, "remote")));
    client.on("error", (failure) => {
      const error = failure as Error & { level?: string; code?: string };
      if (presented && !confirmed.includes(presented.sha256) && !confirmed.includes(presented.md5)) {
        return reject(new HostKeyUnconfirmed(presented.sha256, presented.type, confirmed.length > 0));
      }
      if (error.level === "client-authentication")
        return reject(new ConnectorError(`${where} refused to sign ${username} in: check the ${auth === "password" ? "password" : "key"}`, "auth"));
      if (error.level === "client-timeout") return reject(new ConnectorError(`No answer from ${where} within ${CONNECT_TIMEOUT_MS / 1000} seconds`, "remote"));
      if (/privateKey|private key|passphrase/i.test(error.message))
        return reject(new ConnectorError(`The private key can't be used: ${error.message}`, "config"));
      reject(new ConnectorError(`Can't reach ${where}: ${error.code ?? error.message}`, "remote"));
    });
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => config.password ?? "")));
    try {
      client.connect(config);
    } catch (error) {
      reject(new ConnectorError(`The private key can't be used: ${errorMessage(error)}`, "config"));
    }
  });
  try {
    const sftp = await call<SFTPWrapper>((done) => client.sftp(done), "start SFTP", CONNECT_TIMEOUT_MS);
    const base = (configString(ctx, "folder") ?? "").replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
    if (base.split("/").includes("..")) throw new ConnectorError("The folder can't contain '..'", "config");
    const store = new SftpStore(client, sftp, base, configBoolean(ctx, "write_directly", false));
    if (base && (await store.stat(""))?.type !== "folder") throw new ConnectorError(`There is no folder ${base} on ${host}`, "config");
    return store;
  } catch (error) {
    client.end();
    throw error instanceof ConnectorError ? error : new ConnectorError(`${host} has no SFTP service for ${username}: ${errorMessage(error)}`, "remote");
  }
}

const handlers = fileHandlers((ctx) => openSftp(ctx));

export const sftpConnector = defineConnector({
  manifest: defineManifest({
    type: "sftp",
    name: "SFTP server",
    vendor: "SSH File Transfer Protocol",
    category: "storage",
    description:
      "An SFTP server, such as the drop folders of banks, suppliers, logistics and EDI partners. AI employees list, read and write files there, and a folder can be watched: each new file (a payment report, an order, an invoice) starts their duties. The server's host key is always checked.",
    auth: "custom",
    maturity: "preview",
    docsUrl: "https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02",
    config: [
      { key: "host", label: "Host", type: "string", required: true, placeholder: "sftp.partner.example" },
      { key: "port", label: "Port", type: "number", default: 22 },
      { key: "username", label: "Username", type: "string", required: true },
      {
        key: "auth_type",
        label: "Sign-in",
        type: "select",
        default: "private_key",
        options: [
          { value: "private_key", label: "SSH key" },
          { value: "password", label: "Password" },
        ],
      },
      {
        key: "private_key",
        label: "Private key",
        type: "textarea",
        secret: true,
        placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
        help: "OpenSSH or PEM format. Give the server's administrator the matching public key.",
        showWhen: { ...AUTH, values: ["private_key"] },
      },
      { key: "passphrase", label: "Key passphrase", type: "password", secret: true, showWhen: { ...AUTH, values: ["private_key"] } },
      { key: "password", label: "Password", type: "password", secret: true, showWhen: { ...AUTH, values: ["password"] } },
      {
        key: "host_key_fingerprint",
        label: "Host key fingerprint",
        type: "string",
        placeholder: "SHA256:…",
        help: "Confirms Enterprise Brain talks to the right server (ssh-keygen -lf shows it). Test the connection without it to see the fingerprint the server presents, and check it with its administrator.",
      },
      {
        key: "folder",
        label: "Folder",
        type: "string",
        placeholder: "/outgoing",
        help: "The folder AI employees work in; every path is inside it. Empty: the account's home folder.",
      },
      {
        key: "write_directly",
        label: "Write files directly",
        type: "boolean",
        default: false,
        help: "Files are written under a temporary name and then renamed, so nobody picks up half a file. Turn this on only for servers that don't allow renaming.",
      },
      ...FILE_WATCH_CONFIG,
    ],
    operations: FILE_OPERATIONS,
    events: [NEW_FILE_EVENT],
    itRequirements: [
      "The SFTP server's address and port, reachable from Enterprise Brain (outbound SSH, usually port 22)",
      "An SFTP account for Enterprise Brain, preferably signing in with an SSH key, with access only to the folders AI employees need",
      "The server's host key fingerprint (SHA256), confirmed by its administrator",
      "The folder to watch for new files, and where picked-up files should go",
    ],
  }),

  async test(ctx) {
    let store: SftpStore;
    try {
      store = await openSftp(ctx);
    } catch (error) {
      if (error instanceof HostKeyUnconfirmed) {
        return { ok: false, message: error.message, details: { host_key_fingerprint: error.fingerprint, key_type: error.type, changed: error.changed } };
      }
      throw error;
    }
    try {
      return await folderTest(
        store,
        ctx,
        `${requireConfig(ctx, "host")} as ${requireConfig(ctx, "username")}${store.full("") === "." ? "" : ` (${store.full("")})`}`,
      );
    } finally {
      await store.close();
    }
  },

  operations: handlers,

  async poll(_eventId, ctx, cursor) {
    const store = await openSftp(ctx);
    try {
      return await pollNewFiles(store, ctx, cursor);
    } finally {
      await store.close();
    }
  },
});
