import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PaperclipClient, type PaperclipPlugin } from "@enterprise-brain/paperclip";
import type { AppContext } from "./context.ts";
import type { PaperclipBridge } from "./paperclip-bridge.ts";
import { pushCompany } from "./paperclip-package.ts";

/** The Enterprise Brain plugin's id in Paperclip (its manifest id). */
export const PLUGIN_KEY = "enterprise-brain";

/** The plugin as built in this repository (`pnpm build`). */
const REPO_PLUGIN_DIR = fileURLToPath(new URL("../../../plugins/paperclip-plugin/", import.meta.url));

export interface PaperclipAutoConnectStatus {
  state: "off" | "waiting" | "connecting" | "connected" | "failed";
  message: string;
  updatedAt: string;
}

/**
 * Connects Enterprise Brain to Paperclip without anyone clicking (EB_PAPERCLIP_AUTOCONNECT=true), as the
 * Docker bundle does: waits until Paperclip answers, pushes the company once (org chart, agent keys),
 * installs or updates the Enterprise Brain plugin and points it at this server. Runs on every start and
 * leaves alone what is already there, so a restart doesn't create a second company.
 */
export class PaperclipConnector {
  private current: PaperclipAutoConnectStatus;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private lastError?: string;

  constructor(
    private readonly ctx: AppContext,
    private readonly bridge: PaperclipBridge,
    private readonly options: { pluginSource?: string; retryDelaysMs?: number[] } = {},
  ) {
    const on = Boolean(ctx.config.paperclip?.autoConnect);
    this.current = { state: on ? "waiting" : "off", message: on ? `Waiting for Paperclip at ${ctx.config.paperclip!.url}` : "", updatedAt: new Date().toISOString() };
  }

  status(): PaperclipAutoConnectStatus {
    return this.current;
  }

  /** Connect in the background, retrying until Paperclip is up. Returns a stop function. */
  start(): () => void {
    if (!this.ctx.config.paperclip?.autoConnect) return () => {};
    const delays = this.options.retryDelaysMs ?? [2000, 3000, 5000, 10_000, 15_000, 30_000];
    const attempt = async (n: number) => {
      if (this.stopped) return;
      try {
        await this.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unreachable = isUnreachable(error);
        this.set(unreachable ? "waiting" : "failed", unreachable ? `Waiting for Paperclip at ${this.ctx.config.paperclip!.url}` : message);
        // Log each new problem once, not every retry.
        if (message !== this.lastError) console.warn(`[paperclip] ${unreachable ? `waiting for Paperclip at ${this.ctx.config.paperclip!.url}` : `connecting failed, will retry: ${message}`}`);
        this.lastError = message;
        if (!this.stopped) {
          this.timer = setTimeout(() => void attempt(n + 1), delays[Math.min(n, delays.length - 1)]);
          this.timer.unref();
        }
      }
    };
    void attempt(0);
    return () => {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /** One pass: company and agents, then the plugin. Throws when Paperclip isn't reachable or refuses. */
  async connect(): Promise<void> {
    const { platform, config } = this.ctx;
    const paperclip = config.paperclip;
    if (!paperclip) throw new Error("PAPERCLIP_URL is not set");
    const company = await platform.company(config.defaultCompany.slug);
    if (!company) throw new Error(`Company ${config.defaultCompany.slug} not found`);
    const client = new PaperclipClient(paperclip.url, paperclip.apiKey);
    await client.health();
    this.set("connecting", `Connecting to Paperclip at ${paperclip.url}`);

    // 1. The company, its org chart and the agents' keys: pushed once.
    const link = await this.bridge.link(company.id);
    let paperclipCompanyId = link?.url === paperclip.url ? link.companyId : undefined;
    if (paperclipCompanyId && !(await client.getCompany(paperclipCompanyId))) {
      console.warn(`[paperclip] company ${paperclipCompanyId} no longer exists in Paperclip; pushing ${company.name} again`);
      paperclipCompanyId = undefined;
    }
    let pushed = false;
    if (!paperclipCompanyId) {
      const result = await pushCompany(this.ctx, this.bridge, company, { url: paperclip.url, target: "new_company", actor: "system" });
      if (!result.paperclipCompanyId) throw new Error("Paperclip did not return the new company's id");
      paperclipCompanyId = result.paperclipCompanyId;
      pushed = true;
      for (const warning of result.warnings) console.warn(`[paperclip] ${warning}`);
    }

    // 2. The plugin: Enterprise Brain inside Paperclip, and tools for every Paperclip agent.
    const plugin = await this.ensurePlugin(client);
    if (plugin) {
      const current = (await client.getPluginConfig(plugin.id, paperclipCompanyId)) ?? {};
      const desired = { ...current, enterpriseBrainUrl: config.publicUrl, company: company.slug };
      if (JSON.stringify(current) !== JSON.stringify(desired)) await client.setPluginConfig(plugin.id, paperclipCompanyId, desired);
      if (config.apiKey && !current.apiKey) {
        console.warn("[paperclip] EB_API_KEY is set: add it as the plugin's API key secret in Paperclip (plugin settings), or the plugin can't call Enterprise Brain");
      }
    }

    const summary = `${pushed ? "Pushed" : "Linked to"} ${company.name} in Paperclip${plugin ? ", with the Enterprise Brain plugin" : ""}`;
    this.set("connected", summary);
    this.lastError = undefined;
    console.log(`[paperclip] connected: ${summary}. Open ${paperclip.url}`);
  }

  /**
   * Install the plugin, or reload it when its files changed (a new Enterprise Brain version). The files are
   * copied to EB_PAPERCLIP_PLUGIN_DIR first when set: a folder both servers see (a shared Docker volume).
   * Returns undefined when the plugin isn't built.
   */
  private async ensurePlugin(client: PaperclipClient): Promise<PaperclipPlugin | undefined> {
    const source = resolve(this.options.pluginSource ?? REPO_PLUGIN_DIR);
    if (!existsSync(join(source, "dist", "manifest.js"))) {
      console.warn(`[paperclip] the plugin is not built (${source}); run \`pnpm build\` to install it in Paperclip`);
      return undefined;
    }
    const target = resolve(this.ctx.config.paperclip?.pluginDir ?? source);
    const changed = target !== source && (await syncPlugin(source, target));
    // Paperclip records the plugin's real path.
    const installPath = await realpath(target).catch(() => target);
    let installed = (await client.listPlugins()).find((p) => p.pluginKey === PLUGIN_KEY);
    if (installed?.packagePath && installed.packagePath !== installPath) {
      // Installed from another folder before: reinstall from this one (the plugin's data is kept).
      await client.uninstallPlugin(installed.id);
      installed = undefined;
    }
    if (!installed) {
      const plugin = await client.installPlugin(installPath);
      console.log(`[paperclip] installed the Enterprise Brain plugin from ${installPath}`);
      return plugin;
    }
    if (changed && (installed.status === "ready" || installed.status === "upgrade_pending")) {
      const plugin = await client.upgradePlugin(installed.id);
      console.log("[paperclip] updated the Enterprise Brain plugin");
      return plugin;
    }
    return installed;
  }

  private set(state: PaperclipAutoConnectStatus["state"], message: string) {
    this.current = { state, message, updatedAt: new Date().toISOString() };
  }
}

/** Copy the plugin's package.json and dist/ to `target` when they differ. True when files were copied. */
export async function syncPlugin(source: string, target: string): Promise<boolean> {
  const [from, to] = await Promise.all([pluginDigest(source), pluginDigest(target)]);
  if (from === to) return false;
  await mkdir(target, { recursive: true });
  // The target may be a mount point (a Docker volume): replace what's inside, not the folder itself.
  await rm(join(target, "dist"), { recursive: true, force: true });
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
  await cp(join(source, "package.json"), join(target, "package.json"));
  return true;
}

async function pluginDigest(root: string): Promise<string | undefined> {
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "dist"))) return undefined;
  const hash = createHash("sha256");
  const files = [join(root, "package.json"), ...(await listFiles(join(root, "dist")))].sort();
  for (const file of files) hash.update(relative(root, file)).update("\0").update(await readFile(file)).update("\0");
  return hash.digest("hex");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

/** Paperclip isn't up yet (or not reachable): keep waiting quietly. */
function isUnreachable(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(cause.code)) return true;
  // Paperclip answers 502/503 while it starts behind a proxy.
  const status = (error as { status?: number } | undefined)?.status;
  return status === 502 || status === 503;
}
