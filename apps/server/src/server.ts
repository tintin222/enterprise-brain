import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.ts";
import { bearer, errorBody, statusFor } from "./http.ts";
import { agentRoutes } from "./routes/agents.ts";
import { builderRoutes } from "./routes/builder.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { chatRoutes } from "./routes/chat.ts";
import { connectorRoutes } from "./routes/connectors.ts";
import { coreRoutes } from "./routes/core.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { mailRoutes } from "./routes/mail.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { paperclipRoutes } from "./routes/paperclip.ts";

/** Routes reachable without the console API key (they carry their own credentials). */
const PUBLIC_PREFIXES = ["/api/health", "/api/info", "/api/public/", "/api/hermes/"];

export async function buildServer(ctx: AppContext, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    bodyLimit: 25 * 1024 * 1024,
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

  // Local trusted mode (like Paperclip's local_trusted) when EB_API_KEY is unset.
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0]!;
    if (!ctx.config.apiKey || (!url.startsWith("/api/") && !url.startsWith("/mcp"))) return;
    if (PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p))) return;
    if (bearer(request) !== ctx.config.apiKey) {
      reply.code(401).send({ error: "Missing or invalid API key" });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) request.log.error(error);
    reply.code(status).send(errorBody(error));
  });

  await coreRoutes(app, ctx);
  await catalogRoutes(app, ctx);
  await agentRoutes(app, ctx);
  await knowledgeRoutes(app, ctx);
  await connectorRoutes(app, ctx);
  await mailRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await builderRoutes(app, ctx);
  await paperclipRoutes(app, ctx);
  await mcpRoutes(app, ctx);

  const webDist = ctx.config.webDist;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    // wildcard: files are looked up per request, so a rebuilt console is served without a restart;
    // unknown paths fall through to the handler below (index.html for client-side routes).
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: `No route ${request.method} ${request.url}` });
      }
      // A missing file (e.g. an asset from an older build) is a 404, not the app: HTML would fail as a script.
      if (/\.[a-z0-9]{1,8}$/i.test(request.url.split("?")[0]!)) {
        return reply.code(404).type("text/plain").send("Not found");
      }
      return reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      name: "Enterprise Brain API",
      console: "Build the web console with `pnpm build` (or run `pnpm dev:web`) to serve it here.",
      docs: "/api/info",
    }));
  }
  return app;
}
