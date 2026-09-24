import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  databaseUrl?: string;
  /** Public base URL (links in stakeholder emails, Paperclip adapter config). */
  publicUrl: string;
  /** When set, the console API and MCP endpoint require `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Key Paperclip's hermes_gateway adapter must send. Defaults to apiKey. */
  hermesApiKey?: string;
  defaultCompany: { slug: string; name: string; mailDomain?: string };
  seedDemo: boolean;
  webDist?: string;
  paperclip?: { url: string; apiKey?: string };
  schedulerEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? env.EB_PORT ?? 3200);
  const host = env.HOST ?? env.EB_HOST ?? "127.0.0.1";
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const webDist = env.EB_WEB_DIST ?? resolve(repoRoot, "apps/web/dist");
  return {
    port,
    host,
    dataDir: resolve(env.EB_DATA_DIR ?? resolve(repoRoot, ".data")),
    databaseUrl: env.DATABASE_URL || undefined,
    publicUrl: (env.EB_PUBLIC_URL ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`).replace(/\/$/, ""),
    apiKey: env.EB_API_KEY || undefined,
    hermesApiKey: env.EB_HERMES_API_KEY || env.EB_API_KEY || undefined,
    defaultCompany: {
      slug: env.EB_COMPANY_SLUG ?? "acme",
      name: env.EB_COMPANY_NAME ?? "Acme Endüstri A.Ş.",
      // Replaces the catalog's placeholder addresses (careers@company.com) in installed templates.
      mailDomain: env.EB_MAIL_DOMAIN || ((env.EB_COMPANY_SLUG ?? "acme") === "acme" ? "acme.com.tr" : undefined),
    },
    seedDemo: env.EB_SEED_DEMO !== "false",
    webDist: existsSync(webDist) ? webDist : undefined,
    paperclip: env.PAPERCLIP_URL ? { url: env.PAPERCLIP_URL, apiKey: env.PAPERCLIP_API_KEY || undefined } : undefined,
    schedulerEnabled: env.EB_SCHEDULER !== "false",
  };
}
