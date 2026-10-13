import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

/** The most another system may send to a hook. */
const HOOK_BODY_LIMIT = 5 * 1024 * 1024;

/** A hook request keeps its body as sent: signatures are checked on the bytes. */
export type HookRequest = FastifyRequest & { rawBody?: Buffer };

/** A body as JSON, a form, or text (empty: nothing). */
export function readHookBody(contentType: string | undefined, body: Buffer): unknown {
  const text = body.toString("utf8");
  if (!text.trim()) return null;
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "The body is not valid JSON");
    }
  }
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
  return text;
}

/**
 * Addresses other systems call without signing in, each carrying its own secret in the address or a
 * header: a run's callback address (a `wait` for a call). Any content type is taken, kept as sent.
 */
export async function hookRoutes(app: FastifyInstance, ctx: AppContext) {
  const engine = ctx.platform.engine;
  // Callback addresses start with the address the app is reached at.
  engine.configure({ publicUrl: ctx.config.publicUrl });

  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: HOOK_BODY_LIMIT }, (request, body, done) => {
      (request as HookRequest).rawBody = body as Buffer;
      try {
        done(null, readHookBody(request.headers["content-type"], body as Buffer));
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    // Another system answers a run that waits for it: what it sends becomes the wait step's result.
    hooks.post<{ Params: { token: string } }>("/api/hooks/callback/:token", async (request, reply) => {
      const taken = await engine.receiveCallback(request.params.token, request.body ?? null);
      // 202: kept for the run, which takes it when it gets to its wait.
      return reply.code(taken.outcome === "continued" ? 200 : 202).send({ ok: true, outcome: taken.outcome });
    });
  });
}
