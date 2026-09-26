import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import { join, posix } from "node:path";
import type { Server } from "ssh2";
import { hostKeyFingerprint, loadSsh2 } from "../src/index.ts";

/**
 * A real SFTP server for tests (ssh2's server), serving a folder on disk as the account's whole world:
 * "/" is the folder, and relative paths start there too. Renaming onto an existing file fails, as on
 * OpenSSH without its posix-rename extension.
 */

export interface SftpTestServer {
  port: number;
  /** The host key's fingerprint, as ssh-keygen -lf shows it. */
  fingerprint: string;
  /** A private key the server accepts for the user (OpenSSH format). */
  clientKey: string;
  username: string;
  password: string;
  /** How many sessions were opened. */
  sessions(): number;
  close(): Promise<void>;
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startSftpServer(root: string, options: { username?: string; password?: string } = {}): Promise<SftpTestServer> {
  const ssh2 = await loadSsh2();
  const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
  const username = options.username ?? "brain";
  const password = options.password ?? "s3cret-pass";
  const hostKeys = ssh2.utils.generateKeyPairSync("ed25519");
  const clientKeys = ssh2.utils.generateKeyPairSync("ed25519");
  const hostPublic = ssh2.utils.parseKey(hostKeys.public);
  const allowed = ssh2.utils.parseKey(clientKeys.public);
  if (hostPublic instanceof Error || allowed instanceof Error) throw new Error("test keys could not be parsed");
  let sessions = 0;

  const local = (path: string) => join(root, posix.resolve("/", path));
  const statusOf = (error: NodeJS.ErrnoException) =>
    error.code === "ENOENT"
      ? STATUS_CODE.NO_SUCH_FILE
      : error.code === "EACCES" || error.code === "EPERM"
        ? STATUS_CODE.PERMISSION_DENIED
        : STATUS_CODE.FAILURE;
  const attrsOf = (s: fs.Stats) => ({
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    size: s.size,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000),
  });

  const server: Server = new ssh2.Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on("authentication", (ctx) => {
      if (!same(Buffer.from(ctx.username), Buffer.from(username))) return ctx.reject();
      if (ctx.method === "password" && same(Buffer.from(ctx.password), Buffer.from(password))) return ctx.accept();
      if (
        ctx.method === "publickey" &&
        ctx.key.algo === allowed.type &&
        same(ctx.key.data, allowed.getPublicSSH()) &&
        (!ctx.signature || allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
      ) {
        return ctx.accept();
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          sessions++;
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: number; dir?: string[]; path: string }>();
          let next = 0;
          const handleFor = (entry: { fd?: number; dir?: string[]; path: string }) => {
            const id = next++;
            handles.set(id, entry);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(id);
            return buffer;
          };
          const lookup = (handle: Buffer) => (handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined);

          sftp.on("OPEN", (id, filename, flags) => {
            const mode = ssh2.utils.sftp.flagsToString(flags) ?? (flags & OPEN_MODE.WRITE ? "w" : "r");
            fs.open(local(filename), mode, (error, fd) => (error ? sftp.status(id, statusOf(error)) : sftp.handle(id, handleFor({ fd, path: filename }))));
          });
          sftp.on("READ", (id, handle, offset, length) => {
            const entry = lookup(handle);
            if (entry?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            const buffer = Buffer.alloc(length);
            fs.read(entry.fd, buffer, 0, length, offset, (error, read) => {
              if (error) return sftp.status(id, statusOf(error));
              if (!read) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, buffer.subarray(0, read));
            });
          });
          sftp.on("WRITE", (id, handle, offset, data) => {
            const entry = lookup(handle);
            if (entry?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            fs.write(entry.fd, data, 0, data.length, offset, (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK));
          });
          sftp.on("FSTAT", (id, handle) => {
            const entry = lookup(handle);
            if (entry?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            fs.fstat(entry.fd, (error, stats) => (error ? sftp.status(id, statusOf(error)) : sftp.attrs(id, attrsOf(stats))));
          });
          sftp.on("FSETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("SETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("CLOSE", (id, handle) => {
            const entry = lookup(handle);
            if (!entry) return sftp.status(id, STATUS_CODE.FAILURE);
            handles.delete(handle.readUInt32BE(0));
            if (entry.fd === undefined) return sftp.status(id, STATUS_CODE.OK);
            fs.close(entry.fd, (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK));
          });
          sftp.on("OPENDIR", (id, path) => {
            fs.readdir(local(path), (error, names) => (error ? sftp.status(id, statusOf(error)) : sftp.handle(id, handleFor({ dir: names, path }))));
          });
          sftp.on("READDIR", (id, handle) => {
            const entry = lookup(handle);
            if (!entry?.dir) return sftp.status(id, STATUS_CODE.FAILURE);
            if (!entry.dir.length) return sftp.status(id, STATUS_CODE.EOF);
            const names = entry.dir.splice(0, 50).flatMap((name) => {
              try {
                const stats = fs.lstatSync(join(local(entry.path), name));
                return [{ filename: name, longname: name, attrs: attrsOf(stats) }];
              } catch {
                return [];
              }
            });
            sftp.name(id, names);
          });
          const stat = (id: number, path: string, follow: boolean) =>
            (follow ? fs.stat : fs.lstat)(local(path), (error, stats) => (error ? sftp.status(id, statusOf(error)) : sftp.attrs(id, attrsOf(stats))));
          sftp.on("STAT", (id, path) => stat(id, path, true));
          sftp.on("LSTAT", (id, path) => stat(id, path, false));
          sftp.on("REALPATH", (id, path) => {
            const resolved = posix.resolve("/", path);
            sftp.name(id, [{ filename: resolved, longname: resolved, attrs: {} as never }]);
          });
          sftp.on("MKDIR", (id, path) => fs.mkdir(local(path), (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK)));
          sftp.on("RMDIR", (id, path) => fs.rmdir(local(path), (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK)));
          sftp.on("REMOVE", (id, path) => fs.unlink(local(path), (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK)));
          sftp.on("RENAME", (id, from, to) => {
            if (fs.existsSync(local(to))) return sftp.status(id, STATUS_CODE.FAILURE, "target exists");
            fs.rename(local(from), local(to), (error) => sftp.status(id, error ? statusOf(error) : STATUS_CODE.OK));
          });
        });
      });
    });
    client.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint: hostKeyFingerprint(hostPublic.getPublicSSH()),
    clientKey: clientKeys.private,
    username,
    password,
    sessions: () => sessions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
