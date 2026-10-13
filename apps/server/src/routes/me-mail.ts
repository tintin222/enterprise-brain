import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { safeReturnTo, type AuthService } from "../auth/service.ts";
import { requirePerson } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

/**
 * A person's own Gmail, read for their to-dos: connected with Google (the installation's sign-in
 * client, offline access to read mail), checked by the watcher every few minutes or on request,
 * switched off or disconnected by the person. Theirs alone: nothing of it reaches the shared mail,
 * the AI employees or the brain.
 */
export async function meMailRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;
  const auth = ctx.auth as AuthService;

  app.get("/api/me/mail", async (request) => {
    const viewer = requirePerson(request, "connect your mail");
    const company = await auth.company();
    return {
      configured: Boolean(auth.googleClient(company)),
      redirectUri: auth.gmailRedirectUri(),
      account: await platform.mailAccounts.get(company.id, viewer.userId),
    };
  });

  app.get("/api/me/mail/gmail/start", async (request, reply) => {
    const viewer = requirePerson(request, "connect your mail");
    const { returnTo } = request.query as { returnTo?: string };
    return reply.redirect(await auth.beginGmailConsent(reply, viewer, returnTo));
  });

  app.get("/api/me/mail/gmail/callback", async (request, reply) => {
    const viewer = requirePerson(request, "connect your mail");
    const query = request.query as Record<string, string>;
    try {
      const consent = await auth.completeGmailConsent(request, reply, viewer, query);
      const company = await auth.company();
      await platform.mailAccounts.connect(company.id, consent.userId, consent);
      await platform.activity.record(company.id, {
        actor: `${viewer.name} <${viewer.email}>`,
        action: "mail_account.connected",
        entityType: "user",
        entityId: viewer.userId,
        summary: `${viewer.name} connected their Gmail (${consent.address}) for their tasks`,
      });
      return reply.redirect(`${safeReturnTo(consent.returnTo)}${consent.returnTo.includes("?") ? "&" : "?"}gmail=connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Nothing of the state cookie names where the person was; home is the safe place to say what happened.
      return reply.redirect(`/?gmail=error&message=${encodeURIComponent(message)}`);
    }
  });

  app.post("/api/me/mail/check", async (request) => {
    const viewer = requirePerson(request, "connect your mail");
    const company = await auth.company();
    return platform.mailAccounts.check(company.id, viewer.userId);
  });

  app.patch("/api/me/mail", async (request) => {
    const viewer = requirePerson(request, "connect your mail");
    const company = await auth.company();
    const body = z.object({ tasksEnabled: z.boolean() }).parse(request.body);
    return platform.mailAccounts.setTasksEnabled(company.id, viewer.userId, body.tasksEnabled);
  });

  app.delete("/api/me/mail/gmail", async (request) => {
    const viewer = requirePerson(request, "connect your mail");
    const company = await auth.company();
    const removed = await platform.mailAccounts.disconnect(company.id, viewer.userId);
    if (!removed) throw new HttpError(404, "No mailbox is connected");
    await platform.activity.record(company.id, {
      actor: `${viewer.name} <${viewer.email}>`,
      action: "mail_account.disconnected",
      entityType: "user",
      entityId: viewer.userId,
      summary: `${viewer.name} disconnected their Gmail`,
    });
    return { removed: true };
  });
}
