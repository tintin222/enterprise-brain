import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canSeeDepartment, viewerOf } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, sse } from "../http.ts";

/**
 * Conversations with the company assistant or an AI employee ("Talk to it"). Each is private to the
 * person who started it; people talk only to the AI employees of their departments.
 */
export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  /** The signed-in person's id: their conversations only. Machines and open mode see all. */
  const ownerOf = (request: FastifyRequest) => viewerOf(request).userId ?? undefined;

  const agentFor = async (request: FastifyRequest, companyId: string, ref: string) => {
    const agent = await platform.agents.get(companyId, ref);
    if (!canSeeDepartment(viewerOf(request), agent.row.departmentId)) throw new HttpError(404, `Agent "${ref}" not found`);
    return agent;
  };

  app.get("/api/companies/:company/chat/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const { agent } = z.object({ agent: z.string().optional() }).parse(request.query);
    const agentId = agent ? (await agentFor(request, company.id, agent)).row.id : undefined;
    return platform.chat.listConversations(company.id, { agentId, userId: ownerOf(request) });
  });

  app.post("/api/companies/:company/chat/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const body = z.object({ agent: z.string().optional(), title: z.string().optional() }).parse(request.body ?? {});
    if (body.agent) await agentFor(request, company.id, body.agent);
    return platform.chat.createConversation(company.id, { agentRef: body.agent, title: body.title, userId: ownerOf(request) ?? null });
  });

  app.get("/api/companies/:company/chat/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    return platform.chat.messages(company.id, id, ownerOf(request));
  });

  app.post("/api/companies/:company/chat/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { text } = z.object({ text: z.string().min(1) }).parse(request.body);
    return platform.chat.send(company.id, id, text, { userId: ownerOf(request) });
  });

  /** Streaming variant: `delta` events while the answer is written, then `message`. */
  app.post("/api/companies/:company/chat/conversations/:id/messages/stream", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { text } = z.object({ text: z.string().min(1) }).parse(request.body);
    // Checked before the stream starts, so a stranger's conversation is a plain 404.
    await platform.chat.conversation(company.id, id, ownerOf(request));
    const stream = sse(reply);
    try {
      const message = await platform.chat.send(company.id, id, text, { userId: ownerOf(request), onText: (delta) => stream.send("delta", { delta }) });
      stream.send("message", message);
    } catch (error) {
      stream.send("error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      stream.close();
    }
  });
}
