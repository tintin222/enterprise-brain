import { BuilderService } from "@enterprise-brain/builder";
import { Platform } from "@enterprise-brain/runtime";
import { loadConfig } from "./config.ts";
import { seedDemo } from "./seed.ts";
import { buildServer } from "./server.ts";

async function main() {
  const config = loadConfig();
  const platform = await Platform.create({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
  const existing = await platform.company(config.defaultCompany.slug);
  const { mailDomain, ...defaultCompany } = config.defaultCompany;
  const company = existing ?? (await platform.ensureCompany({ ...defaultCompany, settings: mailDomain ? { mailDomain } : {} }));
  if (!existing && config.seedDemo) {
    console.log(`Seeding demo data for ${company.name}…`);
    await seedDemo(platform, company.id);
  }
  const builder = new BuilderService(platform, { publicBaseUrl: config.publicUrl });
  const app = await buildServer({ platform, builder, config }, { logger: true });
  const resumed = await platform.engine.resumeInterrupted();
  if (config.schedulerEnabled) platform.triggers.start();
  await app.listen({ port: config.port, host: config.host });

  const llm = platform.llm.available ? `${platform.llm.provider} (${platform.llm.model})` : "offline mode — set ANTHROPIC_API_KEY for Claude";
  console.log(
    [
      "",
      "  Enterprise Brain is running",
      `  Console:        ${config.publicUrl}${config.webDist ? "" : "  (web UI not built: run `pnpm build`, or `pnpm dev:web` for development)"}`,
      `  API:            ${config.publicUrl}/api/info`,
      `  MCP endpoint:   ${config.publicUrl}/mcp`,
      `  Paperclip:      hermes_gateway apiBaseUrl = ${config.publicUrl}/api/hermes`,
      `                  key: ${config.hermesApiKeySource === "generated" ? `generated, in ${config.dataDir}/hermes.key (also on the console's Paperclip page)` : config.hermesApiKeySource === "api-key" ? "EB_API_KEY" : "EB_HERMES_API_KEY"}`,
      `  LLM:            ${llm}`,
      `  Embeddings:     ${platform.embedder.model}`,
      `  Database:       ${platform.handle.kind}${config.databaseUrl ? "" : ` (${config.dataDir}/db)`}`,
      resumed ? `  Resumed ${resumed} interrupted run(s)` : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  const shutdown = async () => {
    await app.close();
    await platform.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  // Setup problems an administrator must fix get a plain message instead of a stack trace.
  if (error instanceof Error && error.name === "DatabaseSetupError") console.error(`\nCannot start Enterprise Brain: ${error.message}\n`);
  else console.error(error);
  process.exit(1);
});
