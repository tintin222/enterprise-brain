import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A key kept in the data folder: read it, or create it on first use. */
function keyFile(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(resolve(path, ".."), { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return key;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  databaseUrl?: string;
  /** Public base URL (links in stakeholder emails, Paperclip adapter config). */
  publicUrl: string;
  /** When set, the console API and MCP endpoint require `Authorization: Bearer <key>`. */
  apiKey?: string;
  /**
   * Shared secret Paperclip's hermes_gateway adapter sends: EB_HERMES_API_KEY, else EB_API_KEY, else a key
   * generated once in the data folder (hermes.key). Unset only in tests, where the gateway is open.
   */
  hermesApiKey?: string;
  hermesApiKeySource?: "env" | "api-key" | "generated";
  defaultCompany: { slug: string; name: string; mailDomain?: string };
  seedDemo: boolean;
  webDist?: string;
  paperclip?: {
    url: string;
    apiKey?: string;
    /**
     * Connect by itself on start (EB_PAPERCLIP_AUTOCONNECT=true): push the company once, then install the
     * Enterprise Brain plugin and point it at this server. Used by the Docker bundle.
     */
    autoConnect?: boolean;
    /**
     * A folder Paperclip can read (EB_PAPERCLIP_PLUGIN_DIR): the built plugin is copied there before it is
     * installed. Unset: installed from this repository, which works when Paperclip runs on the same machine.
     */
    pluginDir?: string;
  };
  schedulerEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? env.EB_PORT ?? 3200);
  const host = env.HOST ?? env.EB_HOST ?? "127.0.0.1";
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const webDist = env.EB_WEB_DIST ?? resolve(repoRoot, "apps/web/dist");
  // Relative paths are taken from the repository root (the server itself runs in apps/server).
  const dataDir = resolve(repoRoot, env.EB_DATA_DIR ?? ".data");
  return {
    port,
    host,
    dataDir,
    databaseUrl: env.DATABASE_URL || undefined,
    publicUrl: (env.EB_PUBLIC_URL ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`).replace(/\/$/, ""),
    apiKey: env.EB_API_KEY || undefined,
    hermesApiKey: env.EB_HERMES_API_KEY || env.EB_API_KEY || keyFile(join(dataDir, "hermes.key")),
    hermesApiKeySource: env.EB_HERMES_API_KEY ? "env" : env.EB_API_KEY ? "api-key" : "generated",
    defaultCompany: {
      slug: env.EB_COMPANY_SLUG ?? "acme",
      name: env.EB_COMPANY_NAME ?? "Acme Endüstri A.Ş.",
      // Replaces the catalog's placeholder addresses (careers@company.com) in installed templates.
      mailDomain: env.EB_MAIL_DOMAIN || ((env.EB_COMPANY_SLUG ?? "acme") === "acme" ? "acme.com.tr" : undefined),
    },
    seedDemo: env.EB_SEED_DEMO !== "false",
    webDist: existsSync(webDist) ? webDist : undefined,
    paperclip: env.PAPERCLIP_URL
      ? {
          url: env.PAPERCLIP_URL.replace(/\/$/, ""),
          apiKey: env.PAPERCLIP_API_KEY || undefined,
          autoConnect: env.EB_PAPERCLIP_AUTOCONNECT === "true",
          pluginDir: env.EB_PAPERCLIP_PLUGIN_DIR || undefined,
        }
      : undefined,
    schedulerEnabled: env.EB_SCHEDULER !== "false",
  };
}
