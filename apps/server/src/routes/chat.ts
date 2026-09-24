import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { companyOf, sse } from "../http.ts";

export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  app.get("/api/companies/:company/chat/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const { agent } = z.object({ agent: z.string().optional() }).parse(request.query);
    const agentId = agent ? (await platform.agents.get(company.id, agent)).row.id : undefined;
    return platform.chat.listConversations(company.id, agentId);
  });

  app.post("/api/companies/:company/chat/conversations", async (request) => {
    const company = await companyOf(platform, request);
    const body = z.object({ agent: z.string().optional(), title: z.string().optional() }).parse(request.body ?? {});
    return platform.chat.createConversation(company.id, { agentRef: body.agent, title: body.title });
  });

  app.get("/api/companies/:company/chat/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    return platform.chat.messages(company.id, id);
  });

  app.post("/api/companies/:company/chat/conversations/:id/messages", async (request) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { text } = z.object({ text: z.string().min(1) }).parse(request.body);
    return platform.chat.send(company.id, id, text);
  });

  /** Streaming variant: `delta` events while the answer is written, then `message`. */
  app.post("/api/companies/:company/chat/conversations/:id/messages/stream", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { id } = request.params as { id: string };
    const { text } = z.object({ text: z.string().min(1) }).parse(request.body);
    const stream = sse(reply);
    try {
      const message = await platform.chat.send(company.id, id, text, { onText: (delta) => stream.send("delta", { delta }) });
      stream.send("message", message);
    } catch (error) {
      stream.send("error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      stream.close();
    }
  });
}
