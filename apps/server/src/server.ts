import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AuthService, SESSION_COOKIE } from "./auth/service.ts";
import { API_VIEWER, OPEN_VIEWER, readCookie } from "./auth/viewer.ts";
import type { AppContext } from "./context.ts";
import { bearer, errorBody, statusFor } from "./http.ts";
import { agentRoutes } from "./routes/agents.ts";
import { authRoutes } from "./routes/auth.ts";
import { builderRoutes } from "./routes/builder.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { channelRoutes } from "./routes/channels.ts";
import { chatRoutes } from "./routes/chat.ts";
import { connectorRoutes } from "./routes/connectors.ts";
import { coreRoutes } from "./routes/core.ts";
import { homeRoutes } from "./routes/home.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { mailRoutes } from "./routes/mail.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { paperclipRoutes } from "./routes/paperclip.ts";
import { peopleRoutes } from "./routes/people.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { workRoutes } from "./routes/work.ts";

/** Routes reachable without signing in (they carry their own credentials, or are the sign-in itself). */
const PUBLIC_PREFIXES = ["/api/health", "/api/info", "/api/public/", "/api/hermes/", "/api/auth/", "/api/channels/"];

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Changes made with a person's session must come from this app's own pages. Browsers also send the
 * cookie with requests from sibling sites (another port or subdomain of the same domain), which must not
 * act for the person. Browsers say where a request comes from in Sec-Fetch-Site, older ones in Origin.
 */
function fromAnotherSite(request: FastifyRequest, publicUrl: string): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return false;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string") return site !== "same-origin" && site !== "none";
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const from = new URL(origin);
    return from.host !== request.headers.host && from.origin !== new URL(publicUrl).origin;
  } catch {
    return true;
  }
}

export async function buildServer(ctx: AppContext, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    bodyLimit: 25 * 1024 * 1024,
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

  const auth = (ctx.auth ??= new AuthService(ctx.platform, ctx.config));
  app.decorateRequest("viewer", undefined);

  // Who is asking: a signed-in person (session cookie), a machine with EB_API_KEY, or, in open
  // mode (EB_AUTH=open, no EB_API_KEY), anyone acting as the owner.
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0]!;
    if (!url.startsWith("/api/") && !url.startsWith("/mcp")) return;
    const withApiKey = Boolean(ctx.config.apiKey) && bearer(request) === ctx.config.apiKey;
    if (!withApiKey && (url.startsWith("/api/auth/") || readCookie(request, SESSION_COOKIE)) && fromAnotherSite(request, ctx.config.publicUrl)) {
      return reply.code(403).send({ error: "This request came from another site" });
    }
    if (PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p))) return;
    if (withApiKey) {
      request.viewer = API_VIEWER;
      return;
    }
    const open = auth.mode === "open" && !ctx.config.apiKey;
    if (url.startsWith("/mcp")) {
      // MCP clients are machines: the API key, or nothing in open mode.
      if (open) {
        request.viewer = API_VIEWER;
        return;
      }
      return reply.code(401).send({ error: ctx.config.apiKey ? "Missing or invalid API key" : "Set EB_API_KEY to use the MCP server" });
    }
    const viewer = await auth.viewerFromRequest(request);
    if (viewer) {
      request.viewer = viewer;
      return;
    }
    if (open) {
      request.viewer = OPEN_VIEWER;
      return;
    }
    return reply.code(401).send({ error: auth.mode === "open" ? "Missing or invalid API key" : "Sign in to continue" });
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) request.log.error(error);
    reply.code(status).send(errorBody(error));
  });

  await authRoutes(app, ctx);
  await peopleRoutes(app, ctx);
  await coreRoutes(app, ctx);
  await catalogRoutes(app, ctx);
  await agentRoutes(app, ctx);
  await taskRoutes(app, ctx);
  await workRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await channelRoutes(app, ctx);
  await homeRoutes(app, ctx);
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
