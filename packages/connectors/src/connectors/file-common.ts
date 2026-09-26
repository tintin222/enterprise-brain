import { createHash } from "node:crypto";
import type { ConfigFieldInput } from "../define.ts";
import { bool, int, readOp, str, writeOp, type OperationSpec } from "../schema.ts";
import { ConnectorError, type ConnectorContext, type ConnectorEvent, type ConnectorTestResult } from "../types.ts";
import { configNumber, configString, errorMessage, optBoolean, optLimit, optString, reqString, type Input, type Rec } from "../util.ts";

/**
 * What file connections share (SFTP servers, shared folders): paths inside the connection's folder,
 * name patterns, the operations AI employees use, and watching a folder for new files.
 */

export interface FileEntry {
  name: string;
  /** Inside the connection's folder, e.g. "incoming/INV-1.pdf". */
  path: string;
  type: "file" | "folder";
  size: number;
  modifiedAt: Date;
}

/** A place files live. Every path is inside the connection's folder ("" is the folder itself). */
export interface FileStore {
  /** A folder's entries, not recursive. */
  list(folder: string): Promise<FileEntry[]>;
  /** What is at a path, or undefined when nothing is. */
  stat(path: string): Promise<FileEntry | undefined>;
  /** A file's content; more than maxBytes is refused. */
  read(path: string, maxBytes: number): Promise<Buffer>;
  /** Write a file whole: under a temporary name first, then renamed, so nobody picks up half a file. */
  write(path: string, data: Buffer, overwrite: boolean): Promise<void>;
  move(from: string, to: string, overwrite: boolean): Promise<void>;
  /** Create a folder and the folders above it. */
  makeFolder(path: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A path inside the connection's folder: "/" and "\" alike, a leading "/" meaning the connection's
 * folder. Never above it: ".." is refused.
 */
export function cleanPath(value: string, label = "path"): string {
  if (/[\x00-\x1f]/.test(value)) throw new ConnectorError(`${label} contains characters a path can't have`, "validation");
  const parts = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new ConnectorError(`${label} can't go above the connection's folder (".."): ${value}`, "validation");
  return parts.join("/");
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Wildcards: * any run of characters, ? one character; case does not matter. Linear, whatever the pattern. */
function wildcardMatch(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Name patterns separated by ";" or "," (e.g. "*.pdf; *.xml"); none matches every name. */
export function fileMatcher(patterns: string | undefined): (name: string) => boolean {
  const list = (patterns ?? "")
    .split(/[;,]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return () => true;
  return (name) => list.some((pattern) => wildcardMatch(pattern, name.toLowerCase()));
}

/** Hidden files, and files still being written or left by editors (".part", "~$report.xlsx"). */
export function isHiddenOrPartial(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || /\.(part|partial|filepart|tmp|temp|crdownload|swp)$|~$/i.test(name);
}

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  xml: "application/xml",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  htm: "text/html",
  html: "text/html",
  edi: "application/edi-x12",
  x12: "application/edi-x12",
  edifact: "application/edifact",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  zip: "application/zip",
};

export function mimeTypeOf(name: string): string {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|edi-x12|edifact)$)/;
const MAX_TEXT_BYTES = 200 * 1024;

/** A text file's content for an AI employee to read, when it is small and valid UTF-8. */
function textOf(name: string, data: Buffer): string | undefined {
  if (!TEXT_TYPES.test(mimeTypeOf(name)) || data.length > MAX_TEXT_BYTES) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

function entryOut(entry: FileEntry): Rec {
  return { name: entry.name, path: entry.path, type: entry.type, size: entry.size, modified_at: entry.modifiedAt.toISOString() };
}

const DEFAULT_MAX_FILE_MB = 25;

function maxBytes(ctx: ConnectorContext): number {
  return Math.max(1, configNumber(ctx, "max_file_mb", DEFAULT_MAX_FILE_MB)) * 1024 * 1024;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** The fields of a connection whose folder AI employees watch for new files. */
export const FILE_WATCH_CONFIG: ConfigFieldInput[] = [
  {
    key: "watch_folder",
    label: "Watched folder",
    type: "string",
    placeholder: "incoming/invoices",
    help: "New files here start the duties of AI employees that watch this connection. Empty: the connection's folder.",
  },
  {
    key: "watch_pattern",
    label: "Files to pick up",
    type: "string",
    placeholder: "*.pdf; *.xml",
    help: "Name patterns separated by semicolons. Empty: every file.",
  },
  {
    key: "processed_folder",
    label: "Move picked-up files to",
    type: "string",
    placeholder: "processed",
    help: "Optional. Once picked up, a file is moved to this folder, so the watched folder only holds what is waiting. Leave empty when several AI employees watch the same folder.",
  },
  {
    key: "settle_seconds",
    label: "Wait before picking up (seconds)",
    type: "number",
    default: 30,
    help: "A file is picked up once it has not changed for this long, so a file still being uploaded is left alone.",
  },
  { key: "max_file_mb", label: "Largest file (MB)", type: "number", default: DEFAULT_MAX_FILE_MB },
];

export const FILE_OPERATIONS: OperationSpec[] = [
  readOp("list_files", "List files", "Files and folders in a folder of the connection, newest first.", {
    folder: str("Folder inside the connection, e.g. 'incoming/invoices' (default: the connection's folder)"),
    pattern: str("Name patterns separated by semicolons, e.g. '*.pdf; *.xml'"),
    recursive: bool("Include the files in subfolders too"),
    limit: int("Maximum number of entries (default 100, max 1000)"),
  }),
  readOp(
    "read_file",
    "Read file",
    "Reads a file. Returns its details and a file id that document and Excel tools read; small text files (CSV, XML, TXT) come with their text.",
    { path: str("Path of the file inside the connection, e.g. 'incoming/orders-0926.csv'") },
    ["path"],
  ),
  writeOp(
    "write_file",
    "Write file",
    "Writes a file (a report, an export, a reply file). Give its content as text, as base64, or the id of a file made or received earlier. Missing folders are created; an existing file is only replaced when asked.",
    {
      path: str("Path inside the connection, e.g. 'outgoing/payments-0926.csv'; ending with '/' uses the stored file's name"),
      content: str("The content as text (UTF-8)"),
      content_base64: str("The content, base64 encoded"),
      file_id: str("Id of a file stored in Enterprise Brain (an attachment, an upload, a generated report)"),
      overwrite: bool("Replace the file when it already exists (default: no)"),
    },
    ["path"],
  ),
  writeOp(
    "move_file",
    "Move file",
    "Moves or renames a file, e.g. into an archive folder once it is handled. Missing folders are created.",
    {
      from: str("Path of the file"),
      to: str("New path, or a folder ending with '/' to keep the name"),
      overwrite: bool("Replace a file already at the new path (default: no)"),
    },
    ["from", "to"],
  ),
];

/** The operations, on a store opened for each call. */
export function fileHandlers(open: (ctx: ConnectorContext) => Promise<FileStore>) {
  const withStore = async <T>(ctx: ConnectorContext, work: (store: FileStore) => Promise<T>): Promise<T> => {
    const store = await open(ctx);
    try {
      return await work(store);
    } finally {
      await store.close().catch(() => undefined);
    }
  };

  return {
    async list_files(input: Input, ctx: ConnectorContext) {
      const folder = cleanPath(optString(input, "folder") ?? "", "folder");
      const matches = fileMatcher(optString(input, "pattern"));
      const limit = optLimit(input, "limit", 100, 1000);
      const recursive = optBoolean(input, "recursive") ?? false;
      return withStore(ctx, async (store) => {
        const items: FileEntry[] = [];
        const folders = [{ path: folder, depth: 0 }];
        let more = false;
        while (folders.length) {
          const current = folders.shift()!;
          for (const entry of await store.list(current.path)) {
            if (entry.name.startsWith(".")) continue;
            if (entry.type === "folder" && recursive && current.depth < 5) folders.push({ path: entry.path, depth: current.depth + 1 });
            if (entry.type === "file" && !matches(entry.name)) continue;
            if (items.length >= limit) more = true;
            else items.push(entry);
          }
          if (more) break;
        }
        // Files newest first, then the folders by name.
        items.sort((a, b) =>
          a.type !== b.type
            ? a.type === "file"
              ? -1
              : 1
            : a.type === "folder"
              ? a.path.localeCompare(b.path)
              : b.modifiedAt.getTime() - a.modifiedAt.getTime() || a.path.localeCompare(b.path),
        );
        return { folder: folder || "/", items: items.map(entryOut), total: items.length, has_more: more };
      });
    },

    async read_file(input: Input, ctx: ConnectorContext) {
      const path = cleanPath(reqString(input, "path"), "path");
      return withStore(ctx, async (store) => {
        const entry = await store.stat(path);
        if (!entry) throw new ConnectorError(`There is no file at ${path}`, "not_found");
        if (entry.type !== "file") throw new ConnectorError(`${path} is a folder, not a file`, "validation");
        const limit = maxBytes(ctx);
        if (entry.size > limit)
          throw new ConnectorError(`${entry.name} is ${megabytes(entry.size)}; files up to ${megabytes(limit)} can be read`, "validation");
        return fileResult(entry, await store.read(path, limit), ctx, "file-connection");
      });
    },

    async write_file(input: Input, ctx: ConnectorContext) {
      const given = ["content", "content_base64", "file_id"].filter((key) => input[key] !== undefined && input[key] !== null);
      if (given.length !== 1) throw new ConnectorError("Give the content one way: content (text), content_base64 or file_id", "validation");
      let data: Buffer;
      let storedName: string | undefined;
      if (given[0] === "file_id") {
        if (!ctx.files) throw new ConnectorError("file_id can only be used inside Enterprise Brain; give the content instead", "unsupported");
        const file = await ctx.files.get(reqString(input, "file_id"));
        data = file.data;
        storedName = file.name;
      } else if (given[0] === "content_base64") {
        const base64 = String(input.content_base64).replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) throw new ConnectorError("content_base64 is not valid base64", "validation");
        data = Buffer.from(base64, /[-_]/.test(base64) ? "base64url" : "base64");
      } else {
        data = Buffer.from(String(input.content ?? ""), "utf8");
      }
      const limit = maxBytes(ctx);
      if (data.length > limit) throw new ConnectorError(`The file is ${megabytes(data.length)}; files up to ${megabytes(limit)} can be written`, "validation");
      const raw = reqString(input, "path");
      const overwrite = optBoolean(input, "overwrite") ?? false;
      return withStore(ctx, async (store) => {
        let path = cleanPath(raw, "path");
        const intoFolder = /[/\\]$/.test(raw) || !path || (await store.stat(path))?.type === "folder";
        if (intoFolder) {
          if (!storedName) throw new ConnectorError(`${raw || "/"} is a folder: give the file's name in the path`, "validation");
          // The stored file's own name, as one name (never a path).
          const name = cleanPath(storedName.replace(/[\\/]/g, "_"), "file name");
          if (!name) throw new ConnectorError("The stored file has no usable name: give one in the path", "validation");
          path = joinPath(path, name);
        }
        const existing = await store.stat(path);
        if (existing?.type === "folder") throw new ConnectorError(`${path} is a folder`, "validation");
        if (existing && !overwrite) throw new ConnectorError(`${path} already exists; say overwrite to replace it`, "validation");
        await store.makeFolder(parentOf(path));
        await store.write(path, data, overwrite);
        return { ok: true, path, name: nameOf(path), size: data.length, replaced: Boolean(existing) };
      });
    },

    async move_file(input: Input, ctx: ConnectorContext) {
      const from = cleanPath(reqString(input, "from"), "from");
      const rawTo = reqString(input, "to");
      const overwrite = optBoolean(input, "overwrite") ?? false;
      return withStore(ctx, async (store) => {
        const entry = await store.stat(from);
        if (!entry) throw new ConnectorError(`There is no file at ${from}`, "not_found");
        if (entry.type !== "file") throw new ConnectorError(`${from} is a folder; only files are moved`, "validation");
        const to = await moveTarget(store, from, rawTo);
        if (to === from) return { ok: true, from, to };
        const existing = await store.stat(to);
        if (existing?.type === "folder") throw new ConnectorError(`${to} is a folder`, "validation");
        if (existing && !overwrite) throw new ConnectorError(`${to} already exists; say overwrite to replace it`, "validation");
        await store.makeFolder(parentOf(to));
        await store.move(from, to, overwrite);
        return { ok: true, from, to };
      });
    },
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Test connection": what the folder holds, and whether the watched folder is there. */
export async function folderTest(store: FileStore, ctx: ConnectorContext, where: string): Promise<ConnectorTestResult> {
  const entries = await store.list("");
  const files = entries.filter((e) => e.type === "file").length;
  let watching = "";
  const watch = configString(ctx, "watch_folder");
  if (watch) {
    const folder = cleanPath(watch, "Watched folder");
    if (folder && (await store.stat(folder))?.type !== "folder")
      return { ok: false, message: `Connected to ${where}, but the watched folder ${folder} doesn't exist` };
    const matches = fileMatcher(configString(ctx, "watch_pattern"));
    const waiting = (await store.list(folder)).filter((e) => e.type === "file" && !isHiddenOrPartial(e.name) && matches(e.name)).length;
    watching = `; the watched folder holds ${plural(waiting, "file")} to pick up`;
  }
  return { ok: true, message: `Connected to ${where}: ${plural(files, "file")} and ${plural(entries.length - files, "folder")}${watching}` };
}

/** Where a file goes: the path given, or into the folder given ("archive/", or an existing folder) under its own name. */
async function moveTarget(store: FileStore, from: string, raw: string): Promise<string> {
  const to = cleanPath(raw, "to");
  if (/[/\\]$/.test(raw) || !to || (await store.stat(to))?.type === "folder") return joinPath(to, nameOf(from));
  return to;
}

/** A file brought in: stored in Enterprise Brain when possible (a file id), else its content; its text when small. */
async function fileResult(entry: FileEntry, data: Buffer, ctx: ConnectorContext, source: string): Promise<Rec> {
  const mimeType = mimeTypeOf(entry.name);
  const text = textOf(entry.name, data);
  const stored = ctx.files
    ? await ctx.files.put({ name: entry.name, data, mimeType, source, metadata: { path: entry.path, modifiedAt: entry.modifiedAt.toISOString() } })
    : undefined;
  return {
    ...entryOut(entry),
    size: data.length,
    mime_type: mimeType,
    ...(stored ? { file_id: stored.id } : { content_base64: data.toString("base64") }),
    ...(text !== undefined ? { text } : {}),
  };
}

// ---------------------------------------------------------------------------
// Watching a folder for new files
// ---------------------------------------------------------------------------

export const NEW_FILE_EVENT = {
  id: "new_file",
  name: "New file",
  description:
    "A new file arrived in the watched folder (checked every minute). Files already there when watching starts are left alone; a file replaced by a newer version counts as new.",
};

/** Most new files one check brings in; the rest wait for the next check. */
const MAX_NEW_FILES = 20;
/** A watched folder with more files than this is refused: handled files should be moved out. */
const MAX_WATCHED_FILES = 20_000;

/** The files seen in the watched folder, each by path, size and time (a replaced file is a new one). */
interface FileCursor {
  v: 1;
  seen: string[];
}

function signature(entry: FileEntry): string {
  return createHash("sha256").update(`${entry.path}\0${entry.size}\0${entry.modifiedAt.getTime()}`).digest("base64url").slice(0, 16);
}

function parseCursor(cursor: string | undefined): FileCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as Partial<FileCursor>;
    if (parsed.v === 1 && Array.isArray(parsed.seen)) return { v: 1, seen: parsed.seen.filter((s): s is string => typeof s === "string") };
  } catch {
    // Not a cursor of ours: start again.
  }
  return undefined;
}

export interface NewFiles {
  events: ConnectorEvent[];
  cursor: string;
  warnings: string[];
}

/**
 * New files in the watched folder since the last check. Each is brought in (stored, when inside
 * Enterprise Brain) and moved to the processed folder when one is set. The first check only
 * remembers what is there.
 */
export async function pollNewFiles(store: FileStore, ctx: ConnectorContext, cursor: string | undefined, now = Date.now()): Promise<NewFiles> {
  const folder = cleanPath(configString(ctx, "watch_folder") ?? "", "Watched folder");
  const processed = configString(ctx, "processed_folder") ? cleanPath(configString(ctx, "processed_folder")!, "Processed folder") : undefined;
  if (processed !== undefined && processed === folder) throw new ConnectorError("Picked-up files can't be moved to the watched folder itself", "config");
  const matches = fileMatcher(configString(ctx, "watch_pattern"));
  const settleMs = Math.max(0, configNumber(ctx, "settle_seconds", 30)) * 1000;
  const listed = await store.list(folder).catch((error) => {
    if (error instanceof ConnectorError && error.code === "not_found") throw new ConnectorError(`The watched folder ${folder || "/"} doesn't exist`, "config");
    throw error;
  });
  const entries = listed.filter((e) => e.type === "file" && !isHiddenOrPartial(e.name) && matches(e.name));
  if (entries.length > MAX_WATCHED_FILES) {
    throw new ConnectorError(`The watched folder holds ${entries.length} files; move handled files out (Move picked-up files to)`, "validation");
  }
  const previous = parseCursor(cursor);
  if (!previous) return { events: [], cursor: JSON.stringify({ v: 1, seen: entries.map(signature) }), warnings: [] };

  const seen = new Set(previous.seen);
  const fresh = entries
    .filter((e) => !seen.has(signature(e)) && now - e.modifiedAt.getTime() >= settleMs)
    .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime() || a.path.localeCompare(b.path))
    .slice(0, MAX_NEW_FILES);
  const events: ConnectorEvent[] = [];
  const warnings: string[] = [];
  const handled: string[] = [];
  const limit = maxBytes(ctx);
  for (const entry of fresh) {
    if (entry.size > limit) {
      warnings.push(`${entry.path} is ${megabytes(entry.size)}; files up to ${megabytes(limit)} are picked up`);
      handled.push(signature(entry));
      continue;
    }
    let file: Rec;
    try {
      file = await fileResult(entry, await store.read(entry.path, limit), ctx, "watched-folder");
    } catch (error) {
      // Not remembered: tried again at the next check.
      warnings.push(`${entry.path} couldn't be picked up: ${errorMessage(error)}`);
      continue;
    }
    handled.push(signature(entry));
    let movedTo: string | undefined;
    if (processed !== undefined) {
      try {
        movedTo = joinPath(processed, entry.name);
        if (await store.stat(movedTo)) movedTo = joinPath(processed, stamped(entry.name, now));
        await store.makeFolder(processed);
        await store.move(entry.path, movedTo, false);
      } catch (error) {
        warnings.push(`${entry.path} was picked up but couldn't be moved to ${processed || "/"}: ${errorMessage(error)}`);
        movedTo = undefined;
      }
    }
    events.push({
      id: `${entry.path}@${entry.modifiedAt.toISOString()}`,
      type: NEW_FILE_EVENT.id,
      occurredAt: entry.modifiedAt.toISOString(),
      data: { ...file, folder: folder || "/", ...(movedTo ? { moved_to: movedTo } : {}) },
    });
  }
  // Remembered: the files still in the folder (one that left is forgotten, so it counts as new if it comes back).
  const present = new Set(entries.map(signature));
  const seenNext = [...new Set([...previous.seen.filter((s) => present.has(s)), ...handled])];
  return { events, cursor: JSON.stringify({ v: 1, seen: seenNext }), warnings };
}

/** "INV-1.pdf" → "INV-1 20260926-101500.pdf": a name free in the processed folder. */
function stamped(name: string, now: number): string {
  const time = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} ${time}${name.slice(dot)}` : `${name} ${time}`;
}
