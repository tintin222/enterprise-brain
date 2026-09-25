import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MailService } from "@enterprise-brain/runtime";
import { actorOf, requireAnyManager } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { companyOf, readMultipart } from "../http.ts";

export async function mailRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  app.get("/api/companies/:company/mail/mailboxes", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const boxes = await platform.mail.mailboxes(company.id);
    const agents = await platform.agents.list(company.id);
    return boxes.map((box) => ({
      ...box,
      agents: agents
        .filter((a) => a.definition.triggers.some((t) => t.type === "mailbox" && (t.mailbox.toLowerCase() === box.mailbox || t.mailbox === "*")))
        .map((a) => ({ id: a.row.id, slug: a.row.slug, name: a.row.name, status: a.row.status })),
    }));
  });

  app.get("/api/companies/:company/mail/messages", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const query = z.object({ mailbox: z.string().optional(), direction: z.string().optional(), status: z.string().optional() }).parse(request.query);
    return platform.mail.list(company.id, query);
  });

  app.get("/api/companies/:company/mail/messages/:id", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    const { id } = request.params as { id: string };
    const message = await platform.mail.get(company.id, id);
    const run = message.runId ? await platform.engine.get(company.id, message.runId).catch(() => undefined) : undefined;
    // Same approval shape as GET /approvals (with the agent's name).
    const agentName = run ? (await platform.agents.get(company.id, run.run.agentId).catch(() => undefined))?.row.name ?? null : null;
    return { message, run: run ? { ...run.run, context: undefined } : null, approvals: (run?.approvals ?? []).map((a) => ({ ...a, agentName })) };
  });

  /** Deliver a message into a (sandbox) mailbox; matching agents start automatically. */
  app.post("/api/companies/:company/mail/messages", async (request) => {
    const company = await companyOf(platform, request);
    requireAnyManager(request);
    let payload: { mailbox: string; from: string; fromName?: string; subject: string; body: string; route: boolean; attachmentFileIds: string[] };
    if (request.isMultipart()) {
      const { fields, files } = await readMultipart(platform, company.id, request, "mail");
      payload = {
        mailbox: fields.mailbox ?? "inbox@acme.com.tr",
        from: fields.from ?? "someone@example.com",
        fromName: fields.fromName,
        subject: fields.subject ?? "(no subject)",
        body: fields.body ?? "",
        route: fields.route !== "false",
        // Uploaded files, plus stored ones (e.g. the demo samples) by id.
        attachmentFileIds: [...files.map((f) => f.id), ...(fields.attachmentFileIds ?? "").split(",").map((id) => id.trim()).filter(Boolean)],
      };
    } else {
      const body = z
        .object({
          mailbox: z.string(),
          from: z.string(),
          fromName: z.string().optional(),
          subject: z.string(),
          body: z.string().default(""),
          route: z.boolean().default(true),
          attachmentFileIds: z.array(z.string()).default([]),
        })
        .parse(request.body);
      payload = body;
    }
    const message = await platform.mail.ingest(company.id, { ...payload, attachmentFileIds: payload.attachmentFileIds });
    const runs = payload.route ? await platform.triggers.routeInboundMail(company.id, message, { wait: false }) : [];
    return { message, runs: runs.map((r) => ({ id: r.id, agentId: r.agentId, status: r.status })) };
  });

  /** Process a message with a specific agent (manual triage). */
  app.post("/api/companies/:company/mail/messages/:id/process", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = requireAnyManager(request);
    const { id } = request.params as { id: string };
    const { agent, wait } = z.object({ agent: z.string(), wait: z.boolean().default(true) }).parse(request.body);
    const message = await platform.mail.get(company.id, id);
    await platform.mail.update(company.id, id, { status: "processing" });
    const run = await platform.engine.start(company.id, agent, { email: MailService.toEmailInput(message) }, { trigger: "mailbox", triggerRef: id, wait, actor: actorOf(viewer) });
    await platform.mail.update(company.id, id, { runId: run.id, status: run.status === "failed" ? "error" : "triaged", classification: (run.output as Record<string, unknown> | null) ?? null });
    return { ...run, context: undefined };
  });
}
