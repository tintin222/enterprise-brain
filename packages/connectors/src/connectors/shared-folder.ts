import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineConnector, defineManifest } from "../define.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { requireConfig } from "../util.ts";
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
 * A shared folder (a network drive mounted on the Enterprise Brain server, over SMB or NFS). Only
 * folders the server's operator allows can be used, and nothing outside the chosen folder is reached,
 * not even through links.
 */

export const SHARED_FOLDER_ROOTS_ENV = "EB_SHARED_FOLDER_ROOTS";

/** The folders the server's operator allows shared-folder connections in (EB_SHARED_FOLDER_ROOTS, separated like PATH). */
export function sharedFolderRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[SHARED_FOLDER_ROOTS_ENV] ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(root));
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function fsError(error: unknown, path: string, verb: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const where = path || "the shared folder";
  switch (codeOf(error)) {
    case "ENOENT":
      return new ConnectorError(`There is no file or folder at ${where}`, "not_found");
    case "EACCES":
    case "EPERM":
      return new ConnectorError(`Enterprise Brain may not ${verb} ${where} (the share's permissions)`, "auth");
    case "ENOSPC":
    case "EDQUOT":
      return new ConnectorError(`The share is full: ${where} could not be written`, "remote");
    case "EEXIST":
      return new ConnectorError(`${where} already exists`, "validation");
    default:
      return new ConnectorError(`Could not ${verb} ${where}: ${error instanceof Error ? error.message : String(error)}`, "remote");
  }
}

class LocalFolderStore implements FileStore {
  constructor(private readonly root: string) {}

  private full(path: string): string {
    return path ? join(this.root, ...path.split("/")) : this.root;
  }

  /** Where a path really leads (links followed), which must stay inside the folder; undefined when nothing is there. */
  private async real(path: string): Promise<string | undefined> {
    let real: string;
    try {
      real = await realpath(this.full(path));
    } catch (error) {
      if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return undefined;
      throw fsError(error, path, "open");
    }
    if (!inside(this.root, real)) throw new ConnectorError(`${path} leads outside the shared folder`, "validation");
    return real;
  }

  /**
   * The place for a new or moved entry: its folder resolved (links followed, kept inside), its own name
   * as given. Files are not written through links.
   */
  private async placeFor(path: string, link: "refuse" | "allow" = "refuse"): Promise<string> {
    const folder = await this.real(parentOf(path));
    if (!folder) throw new ConnectorError(`There is no folder ${parentOf(path) || "/"}`, "not_found");
    const place = join(folder, nameOf(path));
    if (link === "refuse" && (await lstat(place).catch(() => undefined))?.isSymbolicLink()) {
      throw new ConnectorError(`${path} is a link; files are not written through links`, "validation");
    }
    return place;
  }

  private entry(path: string, info: { isDirectory(): boolean; size: number; mtime: Date }): FileEntry {
    return {
      name: nameOf(path) || basename(this.root),
      path,
      type: info.isDirectory() ? "folder" : "file",
      size: info.isDirectory() ? 0 : info.size,
      modifiedAt: info.mtime,
    };
  }

  async list(folder: string): Promise<FileEntry[]> {
    const real = await this.real(folder);
    if (!real) throw new ConnectorError(`There is no folder ${folder || "/"}`, "not_found");
    let names;
    try {
      names = await readdir(real, { withFileTypes: true });
    } catch (error) {
      throw fsError(error, folder, "list");
    }
    const entries: FileEntry[] = [];
    for (const dirent of names) {
      const path = joinPath(folder, dirent.name);
      try {
        // A link is listed as what it leads to, when that is inside the folder.
        const target = dirent.isSymbolicLink() ? await this.real(path) : join(real, dirent.name);
        if (!target) continue;
        const info = await stat(target);
        if (info.isFile() || info.isDirectory()) entries.push(this.entry(path, info));
      } catch {
        // Gone meanwhile, or leading outside: not listed.
      }
    }
    return entries;
  }

  async stat(path: string): Promise<FileEntry | undefined> {
    const real = await this.real(path);
    if (!real) return undefined;
    const info = await stat(real).catch((error) => {
      throw fsError(error, path, "open");
    });
    return info.isFile() || info.isDirectory() ? this.entry(path, info) : undefined;
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const real = await this.real(path);
    if (!real) throw new ConnectorError(`There is no file at ${path}`, "not_found");
    const handle = await open(real, "r").catch((error) => {
      throw fsError(error, path, "read");
    });
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(1 << 20, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxBytes) throw new ConnectorError(`${path} is larger than ${Math.round(maxBytes / 1048576)} MB`, "validation");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      throw fsError(error, path, "read");
    } finally {
      await handle.close();
    }
  }

  async write(path: string, data: Buffer, _overwrite: boolean): Promise<void> {
    const place = await this.placeFor(path);
    const temporary = join(dirname(place), `.${nameOf(path)}.${randomUUID().slice(0, 8)}.part`);
    try {
      await writeFile(temporary, data, { flag: "wx" });
      await rename(temporary, place);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw fsError(error, path, "write");
    }
  }

  async move(from: string, to: string, _overwrite: boolean): Promise<void> {
    // Moving a link moves the link itself.
    const source = await this.placeFor(from, "allow");
    const target = await this.placeFor(to);
    try {
      await rename(source, target);
    } catch (error) {
      throw fsError(error, from, "move");
    }
  }

  async makeFolder(path: string): Promise<void> {
    let current = "";
    let real = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      current = joinPath(current, part);
      const existing = await this.real(current);
      if (existing) {
        if (!(await stat(existing)).isDirectory()) throw new ConnectorError(`${current} is a file, not a folder`, "validation");
        real = existing;
        continue;
      }
      real = join(real, part);
      await mkdir(real).catch((error) => {
        if (codeOf(error) !== "EEXIST") throw fsError(error, current, "create");
      });
    }
  }

  async close(): Promise<void> {}
}

/** The connection's folder, once it is known to exist and to be one the server's operator allows. */
export async function openSharedFolder(ctx: ConnectorContext, env: NodeJS.ProcessEnv = process.env): Promise<FileStore> {
  const configured = requireConfig(ctx, "path", "Folder");
  if (!isAbsolute(configured)) throw new ConnectorError("The folder must be a full path on the server, e.g. /mnt/shares/finance", "config");
  const roots = sharedFolderRoots(env);
  if (!roots.length) {
    throw new ConnectorError(`The server's operator hasn't allowed any shared folders yet: they list them in ${SHARED_FOLDER_ROOTS_ENV}`, "config");
  }
  let root: string;
  try {
    root = await realpath(configured);
  } catch {
    throw new ConnectorError(`${configured} doesn't exist on the Enterprise Brain server (is the share mounted?)`, "not_found");
  }
  const allowed = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
  if (!allowed.some((r) => r !== undefined && inside(r, root))) {
    throw new ConnectorError(`${configured} isn't inside a folder the server's operator allowed (${SHARED_FOLDER_ROOTS_ENV})`, "config");
  }
  if (!(await stat(root)).isDirectory()) throw new ConnectorError(`${configured} is a file, not a folder`, "config");
  return new LocalFolderStore(root);
}

const handlers = fileHandlers((ctx) => openSharedFolder(ctx));

export const sharedFolderConnector = defineConnector({
  manifest: defineManifest({
    type: "shared-folder",
    name: "Shared folder (network drive)",
    vendor: "SMB / NFS",
    category: "storage",
    description:
      "A network drive or shared folder mounted on the Enterprise Brain server (Windows file shares over SMB, NFS). AI employees list, read and write files in it, and a folder can be watched: each new file (a scanned invoice, an export) starts their duties.",
    auth: "none",
    maturity: "stable",
    config: [
      {
        key: "path",
        label: "Folder on the Enterprise Brain server",
        type: "string",
        required: true,
        placeholder: "/mnt/shares/finance",
        help: `Where the share is mounted on the server that runs Enterprise Brain. The server's operator allows folders in ${SHARED_FOLDER_ROOTS_ENV}.`,
      },
      ...FILE_WATCH_CONFIG,
    ],
    operations: FILE_OPERATIONS,
    events: [NEW_FILE_EVENT],
    itRequirements: [
      "The network share mounted on the server that runs Enterprise Brain (SMB/CIFS or NFS), with an account that may read, and where needed write, only the folders AI employees work in",
      `The mounted folder allowed in ${SHARED_FOLDER_ROOTS_ENV} on the Enterprise Brain server (separate several with ':')`,
      "The folder to watch for new files, and where picked-up files should go",
    ],
  }),

  async test(ctx) {
    const store = await openSharedFolder(ctx);
    try {
      return await folderTest(store, ctx, String(ctx.config.path));
    } finally {
      await store.close();
    }
  },

  operations: handlers,

  async poll(_eventId, ctx, cursor) {
    const store = await openSharedFolder(ctx);
    try {
      return await pollNewFiles(store, ctx, cursor);
    } finally {
      await store.close();
    }
  },
});
