import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaperclipBridge } from "../src/paperclip-bridge.ts";
import { PaperclipConnector } from "../src/paperclip-connect.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * The Docker bundle's automatic connection (EB_PAPERCLIP_AUTOCONNECT), against a stand-in Paperclip that
 * keeps companies, plugins and plugin settings: the company is pushed once, the plugin is copied to the
 * shared folder, installed there and pointed at Enterprise Brain, and a restart changes nothing.
 */
interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const calls: Recorded[] = [];
const companies = new Set<string>();
let imports = 0;
const plugins: { id: string; pluginKey: string; version: string; status: string; packagePath: string }[] = [];
const pluginConfigs = new Map<string, Record<string, unknown>>();
let paperclip: Server;
let paperclipUrl = "";
let t: TestApp;

const scratch = mkdtempSync(join(tmpdir(), "eb-connect-"));
const pluginSource = join(scratch, "plugin-src");
const pluginDir = join(scratch, "shared", "paperclip-plugin");

function writePlugin(workerCode: string) {
  mkdirSync(join(pluginSource, "dist", "ui"), { recursive: true });
  writeFileSync(join(pluginSource, "package.json"), JSON.stringify({ name: "@enterprise-brain/paperclip-plugin", version: "0.1.0" }));
  writeFileSync(join(pluginSource, "dist", "manifest.js"), "export default { id: 'enterprise-brain', version: '0.1.0' };");
  writeFileSync(join(pluginSource, "dist", "worker.js"), workerCode);
  writeFileSync(join(pluginSource, "dist", "ui", "index.js"), "export {};");
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  writePlugin("export const worker = 1;");
  paperclip = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://paperclip.test");
    const body = request.method === "GET" || request.method === "DELETE" ? {} : await readBody(request);
    calls.push({ method: request.method ?? "GET", path: url.pathname, body });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /api/health") return json(200, { status: "ok" });
    if (route === "POST /api/companies/import") {
      const id = `pc-co-${++imports}`;
      companies.add(id);
      const files = ((body.source as { files?: Record<string, string> })?.files ?? {}) as Record<string, string>;
      const slugs = Object.keys(files).map((path) => path.match(/^agents\/([^/]+)\/AGENTS\.md$/)?.[1]).filter(Boolean) as string[];
      return json(200, { company: { id, action: "created" }, agents: slugs.map((slug) => ({ slug, id: `pc-${slug}`, action: "created" })) });
    }
    const company = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (request.method === "GET" && company) return companies.has(company[1]!) ? json(200, { id: company[1] }) : json(404, { error: "Company not found" });
    const key = url.pathname.match(/^\/api\/agents\/([^/]+)\/keys$/);
    if (request.method === "POST" && key) return json(201, { id: `key-${key[1]}`, token: `tok-${key[1]}` });
    if (route === "GET /api/plugins") return json(200, plugins);
    if (route === "POST /api/plugins/install") {
      if (plugins.length) return json(409, { error: "Plugin already installed: enterprise-brain" });
      const plugin = { id: "plugin-1", pluginKey: "enterprise-brain", version: "0.1.0", status: "ready", packagePath: String(body.packageName) };
      plugins.push(plugin);
      return json(200, plugin);
    }
    const plugin = url.pathname.match(/^\/api\/plugins\/([^/]+)(\/[a-z]+)?$/);
    if (plugin) {
      const [, id, action] = plugin;
      if (request.method === "DELETE" && !action) {
        plugins.splice(plugins.findIndex((p) => p.id === id), 1);
        return json(200, { ok: true });
      }
      if (action === "/upgrade") return json(200, plugins.find((p) => p.id === id));
      if (action === "/config" && request.method === "GET") {
        const configJson = pluginConfigs.get(`${id}:${url.searchParams.get("companyId")}`);
        return json(200, configJson ? { configJson } : null);
      }
      if (action === "/config" && request.method === "POST") {
        pluginConfigs.set(`${id}:${String(body.companyId)}`, body.configJson as Record<string, unknown>);
        return json(200, { configJson: body.configJson });
      }
    }
    return json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => paperclip.listen(0, "127.0.0.1", resolve));
  paperclipUrl = `http://127.0.0.1:${(paperclip.address() as AddressInfo).port}`;
  t = await createTestApp({
    config: { paperclip: { url: paperclipUrl, autoConnect: true, pluginDir }, hermesApiKey: "test-hermes-key", publicUrl: "http://localhost:3200" },
  });
});

afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => paperclip?.close(() => resolve()));
});

const connector = () => new PaperclipConnector(t, new PaperclipBridge(t.platform, t.config), { pluginSource });
const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;
const connection = async () => (await t.app.inject("/api/companies/acme/paperclip/connection")).json();

describe("Enterprise Brain connects itself to Paperclip (the Docker bundle)", () => {
  it("pushes the company once the server listens", async () => {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    let state = "";
    for (let i = 0; i < 100 && state !== "connected"; i++) {
      state = (await connection()).autoConnect.state;
      if (state !== "connected") await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe("connected");
    expect(count("POST", "/api/companies/import")).toBe(1);
    const linked = await connection();
    expect(linked.paperclip.companyId).toBe("pc-co-1");
    expect(linked.paperclip.agentsWithKeys).toBeGreaterThan(0);
  });

  it("installs the plugin from the shared folder and points it at Enterprise Brain", async () => {
    plugins.length = 0;
    await connector().connect();
    expect(readFileSync(join(pluginDir, "dist", "worker.js"), "utf8")).toBe("export const worker = 1;");
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.packagePath).toBe(realpathSync(pluginDir));
    expect(pluginConfigs.get("plugin-1:pc-co-1")).toEqual({ enterpriseBrainUrl: "http://localhost:3200", company: "acme" });
  });

  it("changes nothing on a restart", async () => {
    const before = calls.length;
    await connector().connect();
    const writes = calls.slice(before).filter((c) => c.method !== "GET");
    expect(writes).toEqual([]);
  });

  it("keeps settings added in Paperclip and reloads the plugin when a new version brings new files", async () => {
    pluginConfigs.set("plugin-1:pc-co-1", { ...pluginConfigs.get("plugin-1:pc-co-1"), apiKey: "secret-ref" });
    writePlugin("export const worker = 2;");
    const installs = count("POST", "/api/plugins/install");
    await connector().connect();
    expect(readFileSync(join(pluginDir, "dist", "worker.js"), "utf8")).toBe("export const worker = 2;");
    expect(count("POST", "/api/plugins/plugin-1/upgrade")).toBe(1);
    expect(count("POST", "/api/plugins/install")).toBe(installs);
    expect(pluginConfigs.get("plugin-1:pc-co-1")).toMatchObject({ apiKey: "secret-ref", company: "acme" });
  });

  it("pushes again when the company is gone from Paperclip (a reset Paperclip)", async () => {
    companies.clear();
    await connector().connect();
    expect(count("POST", "/api/companies/import")).toBe(2);
    expect((await connection()).paperclip.companyId).toBe("pc-co-2");
    expect(pluginConfigs.get("plugin-1:pc-co-2")).toMatchObject({ enterpriseBrainUrl: "http://localhost:3200", company: "acme" });
  });

  it("waits quietly while Paperclip is not up", async () => {
    // A port nothing listens on.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const ctx = { ...t, config: { ...t.config, paperclip: { url, autoConnect: true } } };
    const waiting = new PaperclipConnector(ctx, new PaperclipBridge(t.platform, ctx.config), { pluginSource, retryDelaysMs: [10_000] });
    const stop = waiting.start();
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(waiting.status()).toMatchObject({ state: "waiting", message: `Waiting for Paperclip at ${url}` });
  });
});
