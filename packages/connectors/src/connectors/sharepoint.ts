import { defineConnector, defineManifest } from "../define.ts";
import { httpRequest } from "../http.ts";
import { int, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { configNumber, configString, isRecord, optEnum, optLimit, optString, reqString, requireConfig, type Rec } from "../util.ts";
import { ENTRA_CONFIG, graphCollect, graphRequest } from "./microsoft.ts";

const SERVICE = "Microsoft Graph (SharePoint)";
const ITEM_SELECT = "id,name,size,file,folder,webUrl,lastModifiedDateTime,createdDateTime,lastModifiedBy,parentReference";
const DEFAULT_MAX_DOWNLOAD_MB = 25;
/** Graph's simple upload (PUT .../content) accepts files up to 250 MB; larger files need an upload session. */
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

/** Graph site ids look like "host,siteGuid,webGuid"; the commas stay literal in paths. */
function sitePath(siteId: string): string {
  return `/sites/${encodeURIComponent(siteId).replace(/%2C/gi, ",")}`;
}

/** Site URLs resolved to Graph site ids (site ids never change). */
const siteIdCache = new Map<string, string>();

/** Resolves a site given as Graph site id or as URL (https://tenant.sharepoint.com/sites/Finance). */
async function resolveSiteId(ctx: ConnectorContext, site: string): Promise<string> {
  if (!/^https?:\/\//i.test(site)) return site;
  const cacheKey = `${requireConfig(ctx, "tenant_id")}|${site.toLowerCase()}`;
  const cached = siteIdCache.get(cacheKey);
  if (cached) return cached;
  const url = new URL(site);
  const path = url.pathname.replace(/\/+$/, "");
  const response = await graphRequest(ctx, `/sites/${url.hostname}${path ? `:${path}` : ""}`, { query: { $select: "id,displayName,webUrl" } }, SERVICE);
  const id = isRecord(response.data) ? response.data.id : undefined;
  if (typeof id !== "string") throw new ConnectorError(`Could not resolve SharePoint site ${site}`, "not_found");
  siteIdCache.set(cacheKey, id);
  return id;
}

/** Graph path of the drive to work on: explicit drive, else the site's default document library. */
async function drivePath(ctx: ConnectorContext, input: { site_id?: string; drive_id?: string }): Promise<string> {
  const driveId = input.drive_id ?? configString(ctx, "drive_id");
  if (driveId) return `/drives/${encodeURIComponent(driveId)}`;
  const site = input.site_id ?? configString(ctx, "site");
  if (!site) throw new ConnectorError("No SharePoint site configured: set the connector's site or pass site_id / drive_id", "config");
  return `${sitePath(await resolveSiteId(ctx, site))}/drive`;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function toItem(item: Rec): Rec {
  const file = isRecord(item.file) ? item.file : undefined;
  const folder = isRecord(item.folder) ? item.folder : undefined;
  const parent = isRecord(item.parentReference) ? item.parentReference : {};
  const modifiedBy = isRecord(item.lastModifiedBy) && isRecord(item.lastModifiedBy.user) ? item.lastModifiedBy.user : {};
  const parentPath = typeof parent.path === "string" ? parent.path.replace(/^\/drives\/[^/]+\/root:?/, "") : "";
  return {
    id: item.id,
    name: item.name,
    type: folder ? "folder" : "file",
    size: item.size,
    mime: file?.mimeType ?? null,
    child_count: folder?.childCount ?? null,
    path: `${parentPath}/${String(item.name ?? "")}`.replace(/^\/+/, "/"),
    web_url: item.webUrl,
    drive_id: parent.driveId ?? null,
    created_at: item.createdDateTime,
    last_modified_at: item.lastModifiedDateTime,
    last_modified_by: modifiedBy.displayName ?? null,
  };
}

function locationInput(input: Rec): { site_id?: string; drive_id?: string } {
  return { site_id: optString(input, "site_id"), drive_id: optString(input, "drive_id") };
}

const manifest = defineManifest({
  type: "sharepoint",
  name: "SharePoint / OneDrive (document libraries)",
  vendor: "Microsoft",
  category: "dms",
  description:
    "Browses, searches, downloads and uploads documents in SharePoint Online document libraries (and OneDrive drives) through Microsoft Graph, e.g. contracts, policies, invoices or CVs for agents and the knowledge base, and generated reports back to the library.",
  auth: "oauth2-client-credentials",
  docsUrl: "https://learn.microsoft.com/graph/api/resources/driveitem",
  maturity: "preview",
  config: [
    ...ENTRA_CONFIG,
    {
      key: "site",
      label: "SharePoint site",
      type: "url",
      placeholder: "https://acme.sharepoint.com/sites/Finance",
      help: "Default site (URL or Graph site id). Its default document library is used unless a drive id is given.",
    },
    { key: "drive_id", label: "Drive (document library) id", type: "string", help: "Optional: a specific document library or OneDrive drive." },
    { key: "max_download_mb", label: "Max download size (MB)", type: "number", default: DEFAULT_MAX_DOWNLOAD_MB },
  ],
  operations: [
    readOp("list_files", "List files", "Files and folders in a folder of a document library (default: library root).", {
      site_id: str("Site id or URL (default: configured site)"),
      drive_id: str("Drive id (default: the site's default document library)"),
      folder_path: str("Folder path inside the library, e.g. 'Contracts/2026'"),
      top: int("Maximum number of items (default 50, max 500)"),
    }),
    readOp("download_file", "Download file", "Downloads a file: returns name, mime, size and the content as base64.", {
      item_id: str("Drive item id from list_files or search_files"),
      site_id: str("Site id or URL (default: configured site)"),
      drive_id: str("Drive id (default: configured drive or the site's default library)"),
    }, ["item_id"]),
    readOp("search_files", "Search files", "Full-text search for files in the document library (file names and content).", {
      query: str("Search text, e.g. 'framework agreement Hansa'"),
      site_id: str("Site id or URL (default: configured site)"),
      drive_id: str("Drive id"),
      top: int("Maximum number of results (default 25, max 200)"),
    }, ["query"]),
    writeOp("upload_file", "Upload file", "Uploads a file (e.g. a generated report) into a folder of the document library; by default an existing file with the same name is kept and the new one renamed.", {
      folder_path: str("Target folder inside the library, e.g. 'Reports/2026' (created when missing)"),
      file_name: str("File name, e.g. 'Supplier invoices September 2026.xlsx'"),
      content_base64: str("File content, base64 encoded"),
      content_type: str("MIME type, e.g. application/pdf (default application/octet-stream)"),
      conflict_behavior: oneOf(["rename", "replace", "fail"], "When the file exists: rename (default), replace or fail"),
      site_id: str("Site id or URL (default: configured site)"),
      drive_id: str("Drive id (default: configured drive or the site's default library)"),
    }, ["file_name", "content_base64"]),
  ],
  itRequirements: [
    "A Microsoft Entra ID app registration with a client secret; provide tenant ID, client ID and the secret value",
    "Microsoft Graph application permission Sites.Selected (recommended, then grant the app read or write access to the specific site via /sites/{id}/permissions) or Sites.Read.All / Sites.ReadWrite.All, with admin consent; write access is only needed for upload_file",
    "The URL of the SharePoint site (and optionally the document library) the agent may read",
    "Outbound HTTPS from Enterprise Brain to login.microsoftonline.com, graph.microsoft.com and *.sharepoint.com (file downloads)",
  ],
});

export const sharepointConnector = defineConnector({
  manifest,

  async test(ctx) {
    const site = configString(ctx, "site");
    const response = site
      ? await graphRequest(ctx, sitePath(await resolveSiteId(ctx, site)), { query: { $select: "id,displayName,webUrl" } }, SERVICE)
      : await graphRequest(ctx, "/sites/root", { query: { $select: "id,displayName,webUrl" } }, SERVICE);
    const data = isRecord(response.data) ? response.data : {};
    return {
      ok: true,
      message: `Connected to SharePoint site "${String(data.displayName ?? "root")}" (${String(data.webUrl ?? "")}).`,
      details: { siteId: data.id, webUrl: data.webUrl },
    };
  },

  operations: {
    async list_files(input, ctx) {
      const drive = await drivePath(ctx, locationInput(input));
      const folder = optString(input, "folder_path");
      const top = optLimit(input, "top", 50, 500);
      const path = folder && encodePath(folder) ? `${drive}/root:/${encodePath(folder)}:/children` : `${drive}/root/children`;
      const { items, hasMore } = await graphCollect(ctx, path, { query: { $select: ITEM_SELECT, $top: Math.min(top, 200) } }, top, SERVICE);
      return { items: items.map(toItem), total: items.length, has_more: hasMore, folder_path: folder ?? "/" };
    },

    async download_file(input, ctx) {
      const drive = await drivePath(ctx, locationInput(input));
      const itemId = reqString(input, "item_id");
      const response = await graphRequest(ctx, `${drive}/items/${encodeURIComponent(itemId)}`, {}, SERVICE);
      const item = isRecord(response.data) ? response.data : {};
      if (!isRecord(item.file)) throw new ConnectorError(`Item ${itemId} is not a file`, "validation");
      const maxBytes = configNumber(ctx, "max_download_mb", DEFAULT_MAX_DOWNLOAD_MB) * 1024 * 1024;
      const size = typeof item.size === "number" ? item.size : 0;
      if (size > maxBytes) {
        throw new ConnectorError(`File "${String(item.name)}" is ${(size / 1048576).toFixed(1)} MB; the download limit is ${maxBytes / 1048576} MB`, "validation");
      }
      // The pre-authenticated download URL must be fetched without the Graph token.
      const downloadUrl = item["@microsoft.graph.downloadUrl"];
      const content =
        typeof downloadUrl === "string"
          ? await httpRequest<Uint8Array>(ctx.fetch, downloadUrl, { responseType: "bytes", service: SERVICE, headers: { accept: "*/*" }, timeoutMs: 120_000 })
          : await graphRequest<Uint8Array>(ctx, `${drive}/items/${encodeURIComponent(itemId)}/content`, { responseType: "bytes", headers: { accept: "*/*" }, timeoutMs: 120_000 }, SERVICE);
      const bytes = content.data;
      return {
        item_id: item.id ?? itemId,
        name: item.name,
        mime: item.file.mimeType ?? "application/octet-stream",
        size: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"),
        web_url: item.webUrl,
        last_modified_at: item.lastModifiedDateTime,
      };
    },

    async upload_file(input, ctx) {
      const drive = await drivePath(ctx, locationInput(input));
      const fileName = reqString(input, "file_name");
      if (/[\\/:*?"<>|#%]/.test(fileName) || fileName.startsWith(".") || fileName.endsWith(".")) {
        throw new ConnectorError(`file_name contains characters SharePoint does not allow: "${fileName}"`, "validation");
      }
      const base64 = reqString(input, "content_base64").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) throw new ConnectorError("content_base64 is not valid base64", "validation");
      const bytes = Buffer.from(base64, base64.includes("-") || base64.includes("_") ? "base64url" : "base64");
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ConnectorError("Files larger than 250 MB cannot be uploaded with upload_file", "validation");
      const folder = encodePath(optString(input, "folder_path") ?? "");
      const target = folder ? `${folder}/${encodeURIComponent(fileName)}` : encodeURIComponent(fileName);
      const response = await graphRequest(ctx, `${drive}/root:/${target}:/content`, {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: { "content-type": optString(input, "content_type") ?? "application/octet-stream" },
        query: { "@microsoft.graph.conflictBehavior": optEnum(input, "conflict_behavior", ["rename", "replace", "fail"] as const) ?? "rename" },
        timeoutMs: 300_000,
      }, SERVICE);
      return { ok: true, ...toItem(isRecord(response.data) ? response.data : {}) };
    },

    async search_files(input, ctx) {
      const drive = await drivePath(ctx, locationInput(input));
      const query = reqString(input, "query");
      const top = optLimit(input, "top", 25, 200);
      const q = encodeURIComponent(query.replace(/'/g, "''"));
      const { items, hasMore } = await graphCollect(ctx, `${drive}/root/search(q='${q}')`, { query: { $select: ITEM_SELECT, $top: Math.min(top, 200) } }, top, SERVICE);
      return { items: items.map(toItem), total: items.length, has_more: hasMore, query };
    },
  },
});
