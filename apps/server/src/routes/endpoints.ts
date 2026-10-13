import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TriggerSpec } from "@enterprise-brain/core";
import type { AgentRecord, CompanyRow, EndpointRow } from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";
import { inputFromMultipart } from "./agents.ts";
import { allowCall } from "./hooks.ts";

/** Sends a public form takes from one address in a minute, at most. */
const FORM_SENDS_PER_MINUTE = 10;
/** A field people never see on the public form: bots fill it in. */
const HONEYPOT = "website";

type FormTrigger = Extract<TriggerSpec, { type: "form" }>;

/**
 * How other systems and people reach an AI employee without signing in. For its managers: its webhook
 * address (the unguessable one, and the readable one with its secret, shown once when made), its public
 * form's link, new addresses and secrets, on and off. For everyone with the link: the public form.
 */
export async function endpointRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const auth = ctx.auth!;
  const base = ctx.config.publicUrl.replace(/\/$/, "");

  /** An AI employee its viewer manages (403), and sees (404). */
  const managed = async (request: FastifyRequest, companyId: string, ref: string) => {
    const agent = await platform.agents.get(companyId, ref);
    const viewer = viewerOf(request);
    if (!canSeeDepartment(viewer, agent.row.departmentId)) throw new HttpError(404, `Agent "${ref}" not found`);
    if (!canManageDepartment(viewer, agent.row.departmentId)) throw new HttpError(403, "Only a manager of this department sees and changes its addresses");
    return agent;
  };

  const describe = (company: CompanyRow, agent: AgentRecord, webhook: EndpointRow | undefined, form: EndpointRow | undefined) => ({
    webhook: webhook
      ? {
          ...platform.endpoints.view(webhook),
          url: `${base}/api/hooks/t/${webhook.token}`,
          readableUrl: `${base}/api/hooks/${company.slug}/${agent.row.slug}`,
        }
      : null,
    form: form ? { ...platform.endpoints.view(form), url: `${base}/f/${form.token}` } : null,
  });

  /** Its addresses, made when its duties need them (a webhook duty, a public form). */
  const addressesOf = async (company: CompanyRow, agent: AgentRecord, by: string) => {
    const triggers = agent.definition.triggers;
    const webhook = triggers.some((t) => t.type === "webhook")
      ? await platform.endpoints.ensure(company.id, agent.row.id, "webhook", by)
      : await platform.endpoints.forAgent(agent.row.id, "webhook");
    const form = triggers.some((t) => t.type === "form" && t.public?.enabled)
      ? await platform.endpoints.ensure(company.id, agent.row.id, "form", by)
      : await platform.endpoints.forAgent(agent.row.id, "form");
    return describe(company, agent, webhook, form);
  };

  app.get("/api/companies/:company/agents/:agent/endpoints", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await managed(request, company.id, ref);
    return addressesOf(company, agent, actorOf(viewerOf(request)));
  });

  /** A new secret for its webhook, shown this once: the old one stops working. */
  app.post("/api/companies/:company/agents/:agent/endpoints/webhook/secret", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref } = request.params as { agent: string };
    const agent = await managed(request, company.id, ref);
    const by = actorOf(viewerOf(request));
    const endpoint = await platform.endpoints.ensure(company.id, agent.row.id, "webhook", by);
    const { secret } = await platform.endpoints.newSecret(endpoint.id);
    await platform.activity.record(company.id, {
      actor: by,
      action: "agent.webhook_secret",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `Made a new webhook secret for ${agent.definition.name}`,
    });
    return { secret, ...(await addressesOf(company, agent, by)) };
  });

  /** A new address: the old one stops working. */
  app.post("/api/companies/:company/agents/:agent/endpoints/:kind/rotate", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref, kind } = z.object({ agent: z.string(), kind: z.enum(["webhook", "form"]) }).parse(request.params);
    const agent = await managed(request, company.id, ref);
    const by = actorOf(viewerOf(request));
    const endpoint = await platform.endpoints.ensure(company.id, agent.row.id, kind, by);
    await platform.endpoints.rotate(endpoint.id);
    await platform.activity.record(company.id, {
      actor: by,
      action: `agent.${kind}_address`,
      entityType: "agent",
      entityId: agent.row.id,
      summary: `Gave ${agent.definition.name} a new ${kind === "webhook" ? "webhook address" : "form link"}`,
    });
    return addressesOf(company, agent, by);
  });

  app.put("/api/companies/:company/agents/:agent/endpoints/:kind/status", async (request) => {
    const company = await companyOf(platform, request);
    const { agent: ref, kind } = z.object({ agent: z.string(), kind: z.enum(["webhook", "form"]) }).parse(request.params);
    const { status } = z.object({ status: z.enum(["on", "off"]) }).parse(request.body);
    const agent = await managed(request, company.id, ref);
    const by = actorOf(viewerOf(request));
    const endpoint = await platform.endpoints.ensure(company.id, agent.row.id, kind, by);
    await platform.endpoints.setStatus(endpoint.id, status);
    return addressesOf(company, agent, by);
  });

  // ---------------------------------------------------------------------------
  // The public form
  // ---------------------------------------------------------------------------

  /** The form behind a link: on, of an AI employee at work whose public form is on. */
  const formOf = async (token: string) => {
    const endpoint = await platform.endpoints.byToken(token);
    if (!endpoint || endpoint.kind !== "form" || endpoint.status === "off") throw new HttpError(404, "This form is not open");
    const agent = await platform.agents.find(endpoint.companyId, endpoint.agentId);
    const trigger = agent?.definition.triggers.find((t): t is FormTrigger => t.type === "form" && Boolean(t.public?.enabled));
    if (!agent || agent.row.status !== "active" || !trigger?.public) throw new HttpError(404, "This form is not open");
    const company = await platform.company(endpoint.companyId);
    if (!company) throw new HttpError(404, "This form is not open");
    return { endpoint, agent, settings: trigger.public, company };
  };

  /** The signed-in person of the form's company, when the form asks for one. */
  const signedIn = async (request: FastifyRequest, companyId: string) => {
    const viewer = await auth.viewerFromRequest(request);
    return viewer && viewer.companyId === companyId ? viewer : undefined;
  };

  app.get("/api/public/forms/:token", async (request) => {
    const { token } = request.params as { token: string };
    const { agent, settings, company } = await formOf(token);
    const viewer = settings.signIn ? await signedIn(request, company.id) : undefined;
    return {
      company: { name: company.name },
      agent: { name: agent.definition.name },
      title: settings.title || agent.definition.ui.title || agent.definition.name,
      intro: settings.intro ?? agent.definition.ui.description ?? agent.definition.summary,
      fields: agent.definition.inputs,
      submitLabel: agent.definition.ui.submitLabel ?? "Send",
      signIn: Boolean(settings.signIn),
      viewer: viewer ? { name: viewer.name, email: viewer.email } : null,
      honeypot: HONEYPOT,
    };
  });

  app.post("/api/public/forms/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const { endpoint, agent, settings, company } = await formOf(token);
    if (!allowCall(`form:${endpoint.id}:${request.ip}`, FORM_SENDS_PER_MINUTE)) {
      reply.header("retry-after", "60");
      throw new HttpError(429, "Too many sends: wait a minute and try again");
    }
    const viewer = settings.signIn ? await signedIn(request, company.id) : undefined;
    if (settings.signIn && !viewer) throw new HttpError(401, "Sign in to send this form");
    let input: Record<string, unknown>;
    let email: string | undefined;
    let trap: string | undefined;
    if (request.isMultipart()) {
      const { fields, files } = await readMultipart(platform, company.id, request, "form");
      input = inputFromMultipart(agent.definition, fields, files);
      email = fields.email;
      trap = fields[HONEYPOT];
    } else {
      const body = z
        .object({ input: z.record(z.string(), z.unknown()).default({}), email: z.string().max(200).optional(), [HONEYPOT]: z.string().optional() })
        .parse(request.body ?? {});
      input = body.input;
      email = body.email;
      trap = body[HONEYPOT];
    }
    const thanks = settings.thanks || "Thank you: your request is in.";
    // A bot filled in the field people never see: it is told it worked, and nothing starts.
    if (trap?.trim()) return { ok: true, taskRef: null, thanks };
    const sender = email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? email.trim() : undefined;
    await platform.endpoints.touch(endpoint.id);
    const run = await platform.engine.start(company.id, agent.row.id, input, {
      trigger: "form",
      triggerRef: endpoint.id,
      requestedBy: viewer?.name ?? sender ?? "Someone, through the public form",
      actor: viewer ? actorOf(viewer) : "public-form",
      wait: false,
    });
    const taskRef = run.taskId ? ((await platform.tasks.byId(run.taskId))?.ref ?? null) : null;
    return { ok: true, taskRef, thanks };
  });
}
