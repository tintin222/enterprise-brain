import { and, asc, desc, eq } from "drizzle-orm";
import { truncate, type AgentDefinition } from "@enterprise-brain/core";
import { chatConversations, chatMessages, type DatabaseHandle } from "@enterprise-brain/db";
import type { KnowledgeService, SearchHit } from "@enterprise-brain/knowledge";
import type { LlmClient, LlmUsage, MessageParam } from "@enterprise-brain/llm";
import { employmentOf, type AgentService } from "./agents.ts";
import { TOOL_GUIDANCE, mergeUsage } from "./steps/index.ts";
import { buildTools, type ToolDeps } from "./tools.ts";

export interface Citation {
  n: number;
  title: string;
  collection: string;
  documentId: string;
  snippet: string;
}

const DEFAULT_ASSISTANT: AgentDefinition = {
  slug: "company-assistant",
  name: "Company Assistant",
  summary: "Answers questions from the company knowledge base.",
  archetype: "conversational",
  instructions: [
    "You are the company's internal assistant. Answer employees' questions accurately and concisely,",
    "grounded in the company knowledge base. Always search the knowledge base before answering policy or",
    "process questions and cite sources as [n]. If the answer is not in the sources, say so and suggest who",
    "to contact. Answer in the language of the question.",
  ].join(" "),
  inputs: [],
  outputs: [],
  workflow: [],
  tools: ["knowledge.search"],
  triggers: [{ type: "chat" }],
  knowledge: { collections: [] },
  connectors: [],
  guardrails: { approvalRequiredFor: ["mail.send", "connector:write"], personalData: "none" },
  ui: { layout: "chat" },
  kpis: [],
  tests: [],
};

export class ChatError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Conversational AI: persistent conversations with a (conversational) agent, grounded in knowledge and connectors. */
export class ChatService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly llm: LlmClient,
    private readonly agents: AgentService,
    private readonly knowledge: KnowledgeService,
    private readonly toolDeps: ToolDeps,
  ) {}

  /** userId: the person starting it (the conversation is private to them). */
  async createConversation(companyId: string, input: { agentRef?: string; title?: string; userId?: string | null } = {}) {
    const agent = input.agentRef ? await this.agents.get(companyId, input.agentRef) : undefined;
    const [row] = await this.handle.db
      .insert(chatConversations)
      .values({ companyId, agentId: agent?.row.id ?? null, userId: input.userId ?? null, title: input.title ?? "New conversation" })
      .returning();
    return row!;
  }

  /** userId: only that person's conversations (omit it for all, in open mode). */
  async listConversations(companyId: string, filter: { agentId?: string; userId?: string } = {}) {
    const conditions = [eq(chatConversations.companyId, companyId)];
    if (filter.agentId) conditions.push(eq(chatConversations.agentId, filter.agentId));
    if (filter.userId) conditions.push(eq(chatConversations.userId, filter.userId));
    return this.handle.db
      .select()
      .from(chatConversations)
      .where(and(...conditions))
      .orderBy(desc(chatConversations.updatedAt))
      .limit(50);
  }

  /** A conversation; with userId, only if it is that person's. */
  async conversation(companyId: string, conversationId: string, userId?: string) {
    const [row] = await this.handle.db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.id, conversationId)));
    if (!row || (userId && row.userId !== userId)) throw new ChatError(`Conversation ${conversationId} not found`, 404);
    return row;
  }

  async messages(companyId: string, conversationId: string, userId?: string) {
    await this.conversation(companyId, conversationId, userId);
    return this.handle.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt));
  }

  async send(companyId: string, conversationId: string, text: string, options: { onText?: (delta: string) => void; userId?: string } = {}) {
    const conversation = await this.conversation(companyId, conversationId, options.userId);
    const agent = conversation.agentId ? await this.agents.get(companyId, conversation.agentId) : undefined;
    const definition = agent?.definition ?? DEFAULT_ASSISTANT;
    const history = await this.messages(companyId, conversationId);
    await this.handle.db.insert(chatMessages).values({ conversationId, role: "user", content: text });
    if (history.length === 0 && conversation.title === "New conversation") {
      await this.handle.db
        .update(chatConversations)
        .set({ title: truncate(text.replace(/\s+/g, " "), 60) })
        .where(eq(chatConversations.id, conversationId));
    }

    const citations: SearchHit[] = [];
    let answer: string;
    let usage: LlmUsage | undefined;
    if (this.llm.available) {
      const capabilities = [...new Set([...definition.tools, "knowledge.search"])];
      let toolUsage: LlmUsage | undefined;
      const { tools, serverTools } = await buildTools(
        this.toolDeps,
        {
          companyId,
          agentId: agent?.row.id ?? "company-assistant",
          definition,
          employment: agent ? employmentOf(agent.row) : undefined,
          citations,
          onUsage: (used) => {
            toolUsage = mergeUsage(toolUsage, used);
          },
        },
        capabilities,
      );
      const byName = new Map(tools.map((t) => [t.definition.name, t]));
      const messages: MessageParam[] = [
        ...history.slice(-20).map((m): MessageParam => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        { role: "user", content: text },
      ];
      const result = await this.llm.runTools({
        purpose: `chat:${definition.slug}`,
        system: `${definition.instructions}\n\n${TOOL_GUIDANCE}`,
        messages,
        tools: tools.map((t) => t.definition),
        serverTools,
        maxTurns: 8,
        effort: definition.model?.effort ?? "medium",
        model: definition.model?.model,
        onText: options.onText,
        executeTool: async (call) => {
          const tool = byName.get(call.name);
          if (!tool) return { content: `Unknown tool ${call.name}`, isError: true };
          return tool.execute((call.input ?? {}) as Record<string, unknown>);
        },
      });
      answer = result.text || "I could not produce an answer.";
      usage = mergeUsage(result.usage, toolUsage);
    } else {
      const hits = await this.knowledge.search(companyId, text, {
        collections: definition.knowledge.collections.length ? definition.knowledge.collections : undefined,
        topK: 3,
      });
      citations.push(...hits);
      answer = hits.length
        ? [
            "_Offline mode (no LLM configured) — here are the most relevant passages from the knowledge base:_",
            "",
            // Quoted as plain text: a passage's own headings would otherwise render as headings.
            ...hits.map((h, i) => `**[${i + 1}] ${h.title}**\n> ${truncate(h.content.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim(), 500)}`),
          ].join("\n\n")
        : "_Offline mode (no LLM configured)._ I could not find anything relevant in the knowledge base.";
      options.onText?.(answer);
    }
    const citationList: Citation[] = citations.map((c, i) => ({
      n: i + 1,
      title: c.title,
      collection: c.collectionKey,
      documentId: c.documentId,
      snippet: truncate(c.content.replace(/\s+/g, " "), 240),
    }));
    const [message] = await this.handle.db
      .insert(chatMessages)
      .values({
        conversationId,
        role: "assistant",
        content: answer,
        citations: citationList,
        data: usage ? { usage } : {},
      })
      .returning();
    await this.handle.db.update(chatConversations).set({ updatedAt: new Date() }).where(eq(chatConversations.id, conversationId));
    return message!;
  }
}
