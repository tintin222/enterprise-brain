import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, sharepointConnector } from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SITE_ID = "acme.sharepoint.com,1f4e5c2a-0000-4000-8000-000000000001,9a8b7c6d-0000-4000-8000-000000000002";
const DRIVE = `${GRAPH}/sites/${SITE_ID}/drive`;

function ctxFor(fake: FakeFetch, config: Record<string, unknown> = {}) {
  return makeCtx({
    fetch: fake.fetch,
    config: { tenant_id: "tenant-1", client_id: "eb-sp", site: "https://acme.sharepoint.com/sites/Finance", ...config },
    secrets: { client_secret: "sp-secret" },
  });
}

function withSite(fake: FakeFetch): FakeFetch {
  return fake
    .on("POST", TOKEN_URL, json({ access_token: "sp-token", expires_in: 3600 }))
    .on("GET", `${GRAPH}/sites/acme.sharepoint.com:/sites/Finance`, json({ id: SITE_ID, displayName: "Finance", webUrl: "https://acme.sharepoint.com/sites/Finance" }));
}

const item = (id: string, name: string, file = true) => ({
  id,
  name,
  size: 1024,
  webUrl: `https://acme.sharepoint.com/sites/Finance/Shared%20Documents/${name}`,
  lastModifiedDateTime: "2026-09-01T10:00:00Z",
  createdDateTime: "2026-08-01T10:00:00Z",
  lastModifiedBy: { user: { displayName: "Selin Arslan" } },
  parentReference: { driveId: "b!drive", path: "/drives/b!drive/root:/Contracts/2026 Q3" },
  ...(file ? { file: { mimeType: "application/pdf" } } : { folder: { childCount: 3 } }),
});

describe("sharepoint", () => {
  beforeEach(() => clearTokenCache());

  it("resolves the site URL once and lists a folder by path", async () => {
    const fake = withSite(new FakeFetch()).on("GET", `${DRIVE}/root:/Contracts/2026%20Q3:/children`, json({ value: [item("01A", "Hansa frame agreement 2027.pdf"), item("01B", "Drafts", false)] }));
    const ctx = ctxFor(fake);
    const result = await run(sharepointConnector, "list_files", { folder_path: "/Contracts/2026 Q3/" }, ctx);
    expect(result.items).toEqual([
      {
        id: "01A",
        name: "Hansa frame agreement 2027.pdf",
        type: "file",
        size: 1024,
        mime: "application/pdf",
        child_count: null,
        path: "/Contracts/2026 Q3/Hansa frame agreement 2027.pdf",
        web_url: "https://acme.sharepoint.com/sites/Finance/Shared%20Documents/Hansa frame agreement 2027.pdf",
        drive_id: "b!drive",
        created_at: "2026-08-01T10:00:00Z",
        last_modified_at: "2026-09-01T10:00:00Z",
        last_modified_by: "Selin Arslan",
      },
      expect.objectContaining({ id: "01B", type: "folder", child_count: 3, mime: null }),
    ]);
    const list = fake.callsTo("GET", `${DRIVE}/root:/Contracts/2026%20Q3:/children`)[0]!;
    expect(list.headers.get("authorization")).toBe("Bearer sp-token");
    expect(list.url.searchParams.get("$select")).toContain("parentReference");
    await run(sharepointConnector, "list_files", { folder_path: "Contracts/2026 Q3" }, ctx);
    expect(fake.callsTo("GET", `${GRAPH}/sites/acme.sharepoint.com:/sites/Finance`)).toHaveLength(1);
  });

  it("downloads a file through the pre-authenticated URL without the Graph token", async () => {
    const downloadUrl = "https://acme.sharepoint.com/sites/Finance/_layouts/15/download.aspx?UniqueId=abc&tempauth=xyz";
    const fake = new FakeFetch()
      .on("POST", TOKEN_URL, json({ access_token: "sp-token", expires_in: 3600 }))
      .on("GET", `${GRAPH}/drives/b!drive/items/01A`, json({ ...item("01A", "invoice.pdf"), "@microsoft.graph.downloadUrl": downloadUrl }))
      .on("GET", "https://acme.sharepoint.com/sites/Finance/_layouts/15/download.aspx", () => new Response(Buffer.from("%PDF-1.7 demo")));
    const file = await run(sharepointConnector, "download_file", { item_id: "01A", drive_id: "b!drive" }, ctxFor(fake));
    expect(file).toMatchObject({ item_id: "01A", name: "invoice.pdf", mime: "application/pdf", size: 13, base64: Buffer.from("%PDF-1.7 demo").toString("base64") });
    const download = fake.calls.find((c) => c.url.pathname.endsWith("download.aspx"))!;
    expect(download.headers.get("authorization")).toBeNull();
    expect(download.url.searchParams.get("tempauth")).toBe("xyz");
  });

  it("enforces the download size limit and rejects folders", async () => {
    const fake = new FakeFetch()
      .on("POST", TOKEN_URL, json({ access_token: "sp-token", expires_in: 3600 }))
      .on("GET", `${GRAPH}/drives/d1/items/big`, json({ ...item("big", "scan.tif"), size: 80 * 1024 * 1024 }))
      .on("GET", `${GRAPH}/drives/d1/items/folder`, json(item("folder", "Contracts", false)));
    const ctx = ctxFor(fake, { drive_id: "d1", max_download_mb: 25 });
    expect((await expectConnectorError(sharepointConnector.execute("download_file", { item_id: "big" }, ctx))).message).toMatch(/80\.0 MB; the download limit is 25 MB/);
    expect((await expectConnectorError(sharepointConnector.execute("download_file", { item_id: "folder" }, ctx))).message).toMatch(/not a file/);
  });

  it("searches files in the site's document library", async () => {
    const fake = withSite(new FakeFetch()).on("GET", (url) => url.pathname.startsWith(`/v1.0/sites/${SITE_ID}/drive/root/search(`), json({ value: [item("01C", "Supplier's framework agreement.pdf")] }));
    const result = await run(sharepointConnector, "search_files", { query: "supplier's framework" }, ctxFor(fake));
    expect(result.items.map((i: any) => i.id)).toEqual(["01C"]);
    const search = fake.calls.find((c) => c.url.pathname.includes("search("))!;
    expect(decodeURIComponent(search.url.pathname)).toBe(`/v1.0/sites/${SITE_ID}/drive/root/search(q='supplier''s framework')`);
  });

  it("uploads a file into a folder, renaming on conflict by default", async () => {
    const content = Buffer.from("PK\u0003\u0004 fake xlsx");
    const fake = withSite(new FakeFetch()).on("PUT", `${DRIVE}/root:/Reports/2026/Supplier%20invoices%20September.xlsx:/content`, json(
      { ...item("01D", "Supplier invoices September.xlsx"), file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } },
      201,
    ));
    const result = await run(
      sharepointConnector,
      "upload_file",
      {
        folder_path: "Reports/2026",
        file_name: "Supplier invoices September.xlsx",
        content_base64: content.toString("base64"),
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      ctxFor(fake),
    );
    expect(result).toMatchObject({ ok: true, id: "01D", name: "Supplier invoices September.xlsx", type: "file" });
    const put = fake.callsTo("PUT", `${DRIVE}/root:/Reports/2026/Supplier%20invoices%20September.xlsx:/content`)[0]!;
    expect(put.headers.get("authorization")).toBe("Bearer sp-token");
    expect(put.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(put.url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("rename");
    expect(put.body).toBe(content.toString("utf8"));
    const ctx = ctxFor(fake);
    expect((await expectConnectorError(sharepointConnector.execute("upload_file", { file_name: "a/b.txt", content_base64: "aGk=" }, ctx))).code).toBe("validation");
    expect((await expectConnectorError(sharepointConnector.execute("upload_file", { file_name: "b.txt", content_base64: "not base64!" }, ctx))).code).toBe("validation");
  });

  it("tests the connection against the configured site", async () => {
    const fake = withSite(new FakeFetch()).on("GET", `${GRAPH}/sites/${SITE_ID}`, json({ id: SITE_ID, displayName: "Finance", webUrl: "https://acme.sharepoint.com/sites/Finance" }));
    expect(await sharepointConnector.test(ctxFor(fake))).toMatchObject({ ok: true, message: expect.stringContaining('"Finance"') });
  });
});
