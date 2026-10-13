import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyWebhookSignature } from "@enterprise-brain/connectors";
import { isRecord } from "@enterprise-brain/core";
import type { EndpointRow, Platform, RunResponse, RunRow } from "@enterprise-brain/runtime";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

/** The most another system may send to a hook. */
const HOOK_BODY_LIMIT = 5 * 1024 * 1024;
/** Calls an AI employee's webhook takes in a minute, at most. */
const CALLS_PER_MINUTE = 60;
/** How long a caller waits for the answer unless the duty says. */
const DEFAULT_WAIT_SECONDS = 25;
/** Events after which a waiting caller is answered: an answer, the end, or a stop for a person or a wait. */
const ANSWERING_EVENTS = new Set(["run.responded", "run.succeeded", "run.failed", "run.cancelled", "approval.requested", "task.waiting", "task.paused"]);

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

/** Calls per key within the last minute. */
const recent = new Map<string, { count: number; since: number }>();

/** Count a call; false when the key had its fill this minute. */
export function allowCall(key: string, perMinute: number, now = Date.now()): boolean {
  const entry = recent.get(key);
  if (!entry || now - entry.since >= 60_000) {
    recent.set(key, { count: 1, since: now });
    if (recent.size > 10_000) for (const [k, v] of recent) if (now - v.since >= 60_000) recent.delete(k);
    return true;
  }
  entry.count += 1;
  return entry.count <= perMinute;
}

/** Two secrets compared in constant time (their hashes, so lengths never tell). */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Wait until the run answers (a respond step), ends, or stops for a person or a wait, at most `ms`; then the run as it is. */
async function settledFor(platform: Platform, companyId: string, runId: string, ms: number): Promise<RunRow> {
  const engine = platform.engine;
  const answered = (run: RunRow) =>
    !["running", "queued"].includes(run.status) || Boolean(isRecord(run.context) && isRecord((run.context as { response?: unknown }).response));
  return new Promise<RunRow>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      engine.getRow(companyId, runId).then(resolve, reject);
    };
    const unsubscribe = engine.subscribe(runId, (event) => {
      if (ANSWERING_EVENTS.has(event.type)) finish();
    });
    const timer = setTimeout(finish, ms);
    // It may have answered before this listened.
    engine.getRow(companyId, runId).then((run) => (answered(run) ? finish() : undefined), reject);
  });
}

/** The answer for a caller that waited: a respond step's, else the output, the failure, or a receipt. */
function answer(reply: FastifyReply, run: RunRow, taskRef: string | null) {
  const response = (run.context as { response?: RunResponse } | null)?.response;
  if (response) {
    reply.code(response.status).headers(response.headers);
    if (response.body === null || response.body === undefined) return reply.send();
    if (typeof response.body === "string") return reply.send(response.body);
    if (!response.headers["content-type"] && !response.headers["Content-Type"]) reply.type("application/json; charset=utf-8");
    return reply.send(JSON.stringify(response.body));
  }
  if (run.status === "succeeded") return reply.code(200).send({ ok: true, runId: run.id, taskRef, output: run.output });
  if (run.status === "failed") return reply.code(500).send({ ok: false, runId: run.id, taskRef, error: run.error });
  return reply.code(202).send({ ok: true, runId: run.id, taskRef, status: run.status });
}

/**
 * Addresses other systems call without signing in, each carrying its own credential, and taking any
 * content type (kept as sent, for signatures): an AI employee's webhook, by its unguessable address or
 * by its readable address with its secret (or, when its duty says, a signature of the body made with
 * the secret); and a run's callback address (a `wait` for a call).
 */
export async function hookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const engine = platform.engine;
  // Callback addresses start with the address the app is reached at.
  engine.configure({ publicUrl: ctx.config.publicUrl });

  /** A call to an AI employee's webhook: checked, counted, and its work started; a waiting caller gets the answer. */
  const takeCall = async (request: HookRequest, reply: FastifyReply, endpoint: EndpointRow | undefined, byAddress: boolean) => {
    if (!endpoint || endpoint.kind !== "webhook") throw new HttpError(404, "Nothing answers at this address");
    if (!allowCall(`hook:${endpoint.id}`, CALLS_PER_MINUTE)) {
      reply.header("retry-after", "60");
      throw new HttpError(429, `Too many calls: at most ${CALLS_PER_MINUTE} a minute`);
    }
    if (endpoint.status === "off") throw new HttpError(409, "This address is turned off");
    const agent = await platform.agents.find(endpoint.companyId, endpoint.agentId);
    if (!agent) throw new HttpError(404, "Nothing answers at this address");
    const duty = agent.definition.triggers.find((t) => t.type === "webhook");
    if (!duty) throw new HttpError(409, `${agent.definition.name} is not called by other systems: give it that duty first`);
    const secret = platform.endpoints.secretOf(endpoint);
    if (duty.auth === "hmac") {
      // A signature proves the body too: needed on either address.
      if (!secret || !verifyWebhookSignature(secret, request.rawBody ?? Buffer.alloc(0), header(request, "x-signature"))) {
        throw new HttpError(401, "The signature is missing or wrong (X-Signature: sha256=…)");
      }
    } else if (!byAddress) {
      const given = header(request, "x-webhook-secret");
      if (!secret || !given || !sameSecret(given, secret)) throw new HttpError(401, "The secret is missing or wrong (X-Webhook-Secret)");
    }
    await platform.endpoints.touch(endpoint.id);
    const body = request.body;
    const input = isRecord(body) ? body : body === null || body === undefined ? {} : { body };
    const run = await engine.start(endpoint.companyId, agent.row.id, input, { trigger: "webhook", triggerRef: endpoint.id, wait: false, actor: "webhook" });
    const taskRef = run.taskId ? ((await platform.tasks.byId(run.taskId))?.ref ?? null) : null;
    if (!duty.respond) return reply.code(202).send({ ok: true, runId: run.id, taskRef });
    const settled = await settledFor(platform, endpoint.companyId, run.id, (duty.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000);
    return answer(reply, settled, taskRef);
  };

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

    // An AI employee's unguessable address: the address is the credential (a signature too, when its duty says).
    hooks.post<{ Params: { token: string } }>("/api/hooks/t/:token", async (request, reply) =>
      takeCall(request, reply, await platform.endpoints.byToken(request.params.token), true),
    );

    // Its readable address: the secret in X-Webhook-Secret (or a signature in X-Signature).
    hooks.post<{ Params: { company: string; agent: string } }>("/api/hooks/:company/:agent", async (request, reply) => {
      const company = await platform.company(request.params.company);
      const agent = company ? await platform.agents.find(company.id, request.params.agent) : undefined;
      const endpoint = agent ? await platform.endpoints.forAgent(agent.row.id, "webhook") : undefined;
      // Not found and not allowed read the same to a caller without the secret.
      if (!endpoint) throw new HttpError(401, "The secret is missing or wrong (X-Webhook-Secret)");
      return takeCall(request, reply, endpoint, false);
    });
  });
}
