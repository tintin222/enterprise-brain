import { channelName } from "@enterprise-brain/core";
import type { AgentService } from "./agents.ts";
import type { ChannelAccounts, ChatChannelId } from "./channel-accounts.ts";
import type { ChatTransport } from "./chat-channels.ts";
import { agentActor, type ConversationService } from "./conversations.ts";
import type { PeopleService } from "./people.ts";
import type { ChatPoster, ChatPostRequest, ChatPostResult } from "./run-types.ts";
import type { TaskService } from "./tasks.ts";

const VIA_NAMES: Record<ChatChannelId, string> = { teams: "Microsoft Teams", "google-chat": "Google Chat" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ChatPostsDeps {
  conversations: ConversationService;
  agents: AgentService;
  people: PeopleService;
  tasks: TaskService;
  accounts: ChannelAccounts;
  transports: Record<ChatChannelId, ChatTransport>;
}

/**
 * Where a chat.send step writes, as the AI employee: a channel it may write in (open to the company, its
 * own department's, or a private one it is in), a person's direct message with it, the task's
 * conversation, or a person's chat with the app in Teams or Google Chat. A check finds the place and
 * says what is wrong with it, without writing (test runs, and before a person approves the message).
 */
export class ChatPosts implements ChatPoster {
  constructor(private readonly deps: ChatPostsDeps) {}

  async post(request: ChatPostRequest, options: { check?: boolean } = {}): Promise<ChatPostResult> {
    const { companyId } = request;
    const agent = await this.deps.agents.get(companyId, request.agentId);
    const to = request.to.trim();
    const via = request.via ?? "chat";
    const write = async (conversationId: string, where: string): Promise<ChatPostResult> => {
      if (options.check) return { where, via: "chat", conversationId };
      const message = await this.deps.conversations.post(companyId, conversationId, {
        author: agentActor(agent),
        text: request.text,
        runId: request.runId ?? null,
        data: { from: "step" },
      });
      return { where, via: "chat", conversationId, seq: message.seq };
    };

    if (to.toLowerCase() === "task") {
      if (via !== "chat") throw new Error("The task's conversation is in the app's Chat, not in Teams or Google Chat");
      if (!request.taskId) {
        if (options.check) return { where: "the task's conversation", via: "chat" };
        throw new Error("This work has no task: write to a channel or a person instead");
      }
      const task = await this.deps.tasks.byId(request.taskId);
      if (!task) throw new Error("The task is gone");
      const conversation = await this.deps.conversations.forTask(companyId, task);
      return write(conversation.conversation.id, `the conversation of ${task.ref}`);
    }

    if (to.startsWith("#")) {
      const name = channelName(to.slice(1));
      if (via !== "chat") throw new Error(`#${name} is a channel of the app's Chat: Teams and Google Chat reach people`);
      const found = await this.deps.conversations.findByName(companyId, name);
      if (!found || found.conversation.status !== "open") throw new Error(`There is no open channel #${name}`);
      const { conversation, participants } = found;
      const member = participants.some((p) => p.actorKind === "ai_employee" && p.actorId === agent.row.id);
      const open = conversation.visibility === "company" || (conversation.visibility === "department" && conversation.departmentId === agent.row.departmentId);
      if (!member && !open) throw new Error(`${agent.definition.name} isn't in #${name}: add it to the channel first`);
      return write(conversation.id, `#${name}`);
    }

    if (!EMAIL.test(to)) throw new Error(`Write to a channel (#name), a person's email address or "task", not "${to}"`);
    const user = await this.deps.people.findByEmail(companyId, to);
    if (!user || user.status !== "active") throw new Error(`Nobody at the company has the email address ${to}`);
    if (via === "chat") {
      const where = `${user.name} (direct message)`;
      if (options.check) return { where, via: "chat" };
      const talk = await this.deps.conversations.talkWith(companyId, agent, { kind: "person", id: user.id, name: user.name });
      return write(talk.conversation.id, where);
    }
    const transport = this.deps.transports[via];
    if (!(await transport.connected(companyId))) throw new Error(`${VIA_NAMES[via]} is not connected (Studio → Settings → Teams and Chat)`);
    const account = await this.deps.accounts.ofPerson(companyId, user.id, via);
    if (!account || !transport.addressable(account.address)) throw new Error(`${user.name} has no conversation with the app in ${VIA_NAMES[via]} yet`);
    const where = `${user.name} in ${VIA_NAMES[via]}`;
    if (options.check) return { where, via };
    await transport.send(companyId, account.address, { text: `**${agent.definition.name}:** ${request.text}` });
    return { where, via };
  }
}
