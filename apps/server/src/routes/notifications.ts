import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHANNEL_LABELS, DELIVERY_MODES, NotificationPreferencesPatch } from "@enterprise-brain/core";
import { explanationOf, isOpen, type QueueEntry } from "@enterprise-brain/runtime";
import { canHandleWork, canSeeDepartment, viewerFromPerson, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

const VIA = new Set(["email", "teams", "google-chat"]);

/**
 * What reaches a person outside the app (their preferences), and the page an email's buttons open:
 * the signed link shows the item, and acting on it takes a click there (mail scanners open links too).
 */
export async function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  const me = (request: Parameters<typeof viewerOf>[0]) => {
    const viewer = viewerOf(request);
    if (viewer.kind !== "session" || !viewer.userId || !viewer.companyId) throw new HttpError(400, "Notifications are for people who sign in");
    return { userId: viewer.userId, companyId: viewer.companyId };
  };

  const view = async (companyId: string, userId: string) => {
    const person = await platform.people.get(companyId, userId);
    const [preferences, reachable, sent] = await Promise.all([
      platform.notifications.preferences(companyId, userId),
      platform.notifications.reachable(companyId, person),
      platform.notifications.sentTo(companyId, userId, 10),
    ]);
    return {
      preferences,
      modes: Object.entries(DELIVERY_MODES).map(([id, mode]) => ({ id, ...mode })),
      channels: (["email", "teams", "google-chat"] as const).map((id) => ({ id, label: CHANNEL_LABELS[id], reaches: reachable.includes(id) })),
      email: person.email,
      recent: sent.map((n) => ({ kind: n.kind, itemType: n.itemType, channel: n.channel, status: n.status, createdAt: n.createdAt })),
    };
  };

  app.get("/api/me/notifications", async (request) => {
    const { companyId, userId } = me(request);
    return view(companyId, userId);
  });

  app.put("/api/me/notifications", async (request) => {
    const { companyId, userId } = me(request);
    const patch = NotificationPreferencesPatch.parse(request.body ?? {});
    await platform.notifications.setPreferences(companyId, userId, patch);
    return view(companyId, userId);
  });

  // ---------------------------------------------------------------------------
  // The signed action link (public: the link is the credential)
  // ---------------------------------------------------------------------------

  const load = async (token: string) => {
    const claim = platform.actionLinks.verify(token);
    const person = await platform.people.get(claim.companyId, claim.userId).catch(() => undefined);
    if (!person || person.status !== "active") throw new HttpError(403, "This link belongs to an account that is no longer active");
    const entry = await platform.queue.entry(claim.companyId, claim.type, claim.id);
    if (!entry) throw new HttpError(404, "This item no longer exists");
    const viewer = viewerFromPerson(person);
    if (!canSeeDepartment(viewer, entry.departmentId)) throw new HttpError(403, "You no longer have access to this item");
    const company = await platform.company(claim.companyId);
    return { claim, person, entry, company, canHandle: canHandleWork(viewer, entry.departmentId, entry.assigneeUserId) };
  };

  app.get("/api/public/act/:token", async (request) => {
    const { token } = request.params as { token: string };
    const { claim, person, entry, company, canHandle } = await load(token);
    return {
      company: { name: company?.name ?? "Enterprise Brain" },
      person: { name: person.name },
      item: publicEntry(entry),
      canAct: isOpen(entry) && canHandle,
      expiresAt: claim.expiresAt,
    };
  });

  app.post("/api/public/act/:token", async (request) => {
    const { token } = request.params as { token: string };
    const body = z
      .object({
        choice: z.enum(["approve", "reject"]).optional(),
        note: z.string().max(4000).optional(),
        edits: z.record(z.string(), z.unknown()).optional(),
        answer: z.string().max(4000).optional(),
        verdict: z.enum(["right", "wrong"]).optional(),
        retry: z.boolean().optional(),
        dismiss: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    const { claim, person, entry, canHandle } = await load(token);
    if (!canHandle) throw new HttpError(403, "This is someone else's to handle now");
    const via = claim.via && VIA.has(claim.via) ? claim.via : "email";
    const note = body.note?.trim() || undefined;
    if (entry.type === "approval") {
      if (!body.choice) throw new HttpError(400, "Choose to approve or reject");
      const edits = body.choice === "approve" && body.edits && Object.keys(body.edits).length ? body.edits : undefined;
      await platform.engine.decide(
        claim.companyId,
        entry.id,
        { approved: body.choice === "approve", note, decidedBy: person.name, edits, via },
        { wait: false },
      );
    } else {
      const { answer, verdict, retry, dismiss } = body;
      await platform.engine.resolveWorkItem(claim.companyId, entry.id, { answer, verdict, note, retry, dismiss }, person.name, { wait: false, via });
    }
    const after = await platform.queue.entry(claim.companyId, claim.type, claim.id);
    return { ok: true, item: after ? publicEntry(after) : null };
  });
}

/** An item as the action page shows it: what it is, why, what would change, and whether it was handled. */
function publicEntry(entry: QueueEntry) {
  return {
    type: entry.type,
    id: entry.id,
    title: entry.title,
    /** Without a restatement of the change, which `action` carries. */
    details: explanationOf(entry),
    reason: entry.reason,
    suggestion: entry.suggestion,
    options: entry.options,
    action: entry.action,
    agent: entry.agent ? { name: entry.agent.name } : null,
    task: entry.task ? { ref: entry.task.ref, title: entry.task.title, status: entry.task.status } : null,
    status: entry.status,
    resolvedBy: entry.resolvedBy,
    answer: entry.answer,
    createdAt: entry.createdAt,
  };
}
