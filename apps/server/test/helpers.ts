import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { BuilderService } from "@enterprise-brain/builder";
import { LocalHashEmbedder, UnavailableLlm, type LlmClient } from "@enterprise-brain/llm";
import { Platform } from "@enterprise-brain/runtime";
import type { ServerConfig } from "../src/config.ts";
import { seedDemo } from "../src/seed.ts";
import { buildServer } from "../src/server.ts";

export interface TestApp {
  app: FastifyInstance;
  platform: Platform;
  builder: BuilderService;
  companyId: string;
  close(): Promise<void>;
}

export async function createTestApp(options: { llm?: LlmClient; seed?: boolean; config?: Partial<ServerConfig> } = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "eb-test-"));
  const platform = await Platform.create({ dataDir, inMemory: true, llm: options.llm ?? new UnavailableLlm(), embedder: new LocalHashEmbedder(), env: {} });
  const company = await platform.ensureCompany({ slug: "acme", name: "Acme Endüstri A.Ş.", settings: { mailDomain: "acme.com.tr" } });
  if (options.seed ?? true) await seedDemo(platform, company.id);
  const config: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    publicUrl: "http://brain.test",
    defaultCompany: { slug: "acme", name: company.name },
    seedDemo: false,
    schedulerEnabled: false,
    ...options.config,
  };
  const builder = new BuilderService(platform, { publicBaseUrl: config.publicUrl });
  const app = await buildServer({ platform, builder, config });
  return {
    app,
    platform,
    builder,
    companyId: company.id,
    async close() {
      await app.close();
      await platform.close();
    },
  };
}

/** Build a multipart/form-data body for fastify.inject. */
export function multipart(fields: Record<string, string>, files: { field: string; name: string; data: Buffer; type: string }[]) {
  const boundary = `----eb${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
