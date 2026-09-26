import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMember, googleChatSettings, teamsBotSettings, type ConnectorContext, type TeamsAddress } from "@enterprise-brain/connectors";
import {
  ADAPTIVE_CARD,
  adaptiveCard,
  googleChatMessage,
  type ChannelAccountRow,
  type ChatChannelId,
  type ChatMessage,
  type CompanyRow,
} from "@enterprise-brain/runtime";
import { requireAdmin } from "../auth/viewer.ts";
import { BotFrameworkAuth } from "../channels/botframework.ts";
import { ChatConversations, type ActionResult, type ChatContext } from "../channels/conversation.ts";
import { GoogleChatAuth } from "../channels/google-chat-auth.ts";
import { teamsAppPackage } from "../channels/teams-app.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf } from "../http.ts";

/** What the Bot Framework sends the bot (the fields the app reads). */
const TeamsActivity = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    serviceUrl: z.string(),
    channelId: z.string(),
    from: z.object({ id: z.string(), name: z.string().optional(), aadObjectId: z.string().optional() }).passthrough(),
    recipient: z.object({ id: z.string() }).passthrough(),
    conversation: z.object({ id: z.string(), conversationType: z.string().optional(), tenantId: z.string().optional() }).passthrough(),
    channelData: z.record(z.string(), z.unknown()).optional(),
    text: z.string().optional(),
    value: z.unknown().optional(),
    membersAdded: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  })
  .passthrough();
type TeamsActivity = z.infer<typeof TeamsActivity>;

function tenantOf(activity: TeamsActivity): string | undefined {
  const tenant = activity.channelData?.tenant;
  const id = tenant && typeof tenant === "object" && "id" in tenant && typeof tenant.id === "string" ? tenant.id : activity.conversation.tenantId;
  return id?.toLowerCase();
}

/** What Google Chat sends the Chat app (interaction events; the fields the app reads). */
const ChatEvent = z
  .object({
    type: z.string(),
    user: z
      .object({ name: z.string(), displayName: z.string().optional(), email: z.string().optional(), type: z.string().optional() })
      .passthrough()
      .optional(),
    space: z
      .object({ name: z.string(), type: z.string().optional(), spaceType: z.string().optional(), singleUserBotDm: z.boolean().optional() })
      .passthrough()
      .optional(),
    message: z.object({ name: z.string().optional(), text: z.string().optional(), argumentText: z.string().optional() }).passthrough().optional(),
    action: z
      .object({ actionMethodName: z.string().optional(), parameters: z.array(z.object({ key: z.string(), value: z.string() })).optional() })
      .passthrough()
      .optional(),
    common: z
      .object({
        invokedFunction: z.string().optional(),
        parameters: z.record(z.string(), z.string()).optional(),
        formInputs: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** The values of a card's inputs ({ note: { stringInputs: { value: ["…"] } } } → { note: "…" }). */
function formValues(inputs: Record<string, unknown> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, input] of Object.entries(inputs ?? {})) {
    const first = record(record(input).stringInputs).value;
    if (Array.isArray(first) && typeof first[0] === "string") values[key] = first[0];
  }
  return values;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Chat apps. Teams calls the bot's messaging endpoint for every message, card button and install;
 * the call is checked (Bot Framework signature, this bot, this tenant) before anything happens.
 * Admins see how the channels are set up and download the Teams app.
 */
export async function channelRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform, config } = ctx;
  const conversations = new ChatConversations(platform, ctx.auth!);
  const botAuth = new BotFrameworkAuth(config.teams?.openIdUrl);
  const chatAuth = new GoogleChatAuth();

  const accountsView = async (companyId: string, channel: ChatChannelId, people: Map<string, { name: string }>) =>
    (await platform.channelAccounts.list(companyId, channel)).map((a: ChannelAccountRow) => ({
      name: a.name,
      email: a.email,
      person: a.userId ? (people.get(a.userId)?.name ?? null) : null,
      since: a.createdAt,
      lastSeenAt: a.updatedAt,
    }));

  /** Who wrote: their Teams account, linked to a person by the email Teams gives for them. */
  const identify = async (company: CompanyRow, connection: ConnectorContext, activity: TeamsActivity, address: TeamsAddress): Promise<ChatContext> => {
    const externalId = activity.from.aadObjectId ?? activity.from.id;
    const known = await platform.channelAccounts.find(company.id, "teams", externalId);
    let email = known?.email ?? null;
    let userId = known?.userId ?? null;
    if (!userId) {
      const member = await getMember(connection, address, activity.from.id);
      email = (member.email ?? member.userPrincipalName)?.toLowerCase() ?? null;
      const byEmail = email ? await platform.people.findByEmail(company.id, email) : undefined;
      const byUpn = !byEmail && member.userPrincipalName ? await platform.people.findByEmail(company.id, member.userPrincipalName) : undefined;
      userId = (byEmail ?? byUpn)?.id ?? null;
    }
    const account = await platform.channelAccounts.remember(company.id, "teams", {
      externalId,
      address: { ...address },
      email,
      name: activity.from.name ?? null,
      userId,
    });
    const person = account.userId ? await platform.people.get(company.id, account.userId).catch(() => undefined) : undefined;
    return { companyId: company.id, channel: "teams", account, person, email };
  };

  app.post("/api/channels/teams/:company/messages", async (request, reply) => {
    const { company: ref } = request.params as { company: string };
    const company = await platform.company(ref);
    if (!company) throw new HttpError(404, "Unknown company");
    const connection = await platform.teams.connection(company.id);
    if (!connection) throw new HttpError(404, "Microsoft Teams is not connected");
    const settings = teamsBotSettings(connection.ctx);
    const activity = TeamsActivity.parse(request.body);
    await botAuth.verify(request.headers.authorization, activity, settings.appId);
    if (tenantOf(activity) !== settings.tenantId) throw new HttpError(403, "This bot serves another Microsoft Entra tenant");
    if (activity.channelId !== "msteams") return reply.send({});

    const address: TeamsAddress = {
      serviceUrl: activity.serviceUrl,
      conversationId: activity.conversation.id,
      tenantId: settings.tenantId,
      botId: activity.recipient.id,
      userId: activity.from.id,
    };
    const send = async (messages: ChatMessage[]) => {
      for (const message of messages) await platform.teams.send(company.id, { ...address }, message);
    };
    const who = () =>
      identify(company, connection.ctx, activity, address).catch((error) => {
        request.log.warn({ err: error }, "Teams: could not look up who wrote");
        return undefined;
      });
    const unavailable: ChatMessage = { text: "I couldn't check who you are just now. Please try again in a minute." };

    if (activity.type === "invoke" && activity.name === "adaptiveCard/action") {
      const action = record(record(activity.value).action);
      const context = await who();
      const result: ActionResult = context
        ? await conversations.onAction(context, typeof action.verb === "string" ? action.verb : "", record(action.data))
        : { error: unavailable.text! };
      return reply.send(
        "card" in result
          ? { statusCode: 200, type: ADAPTIVE_CARD, value: adaptiveCard(result.card) }
          : { statusCode: 400, type: "application/vnd.microsoft.error", value: { code: "BadRequest", message: result.error } },
      );
    }

    if (activity.type === "message") {
      if ((activity.conversation.conversationType ?? "personal") !== "personal") {
        await send([{ text: "Please write to me in a personal chat: your work and approvals stay private there." }]);
        return reply.send({});
      }
      const context = await who();
      if (!context) {
        await send([unavailable]);
        return reply.send({});
      }
      const value = record(activity.value);
      if (value.eb) {
        // A card button from a Teams client without Universal Actions arrives as a message.
        const result = await conversations.onAction(context, typeof value.verb === "string" ? value.verb : "", value);
        await send(["card" in result ? { card: result.card } : { text: result.error }]);
      } else {
        await send(await conversations.onText(context, activity.text ?? ""));
      }
      return reply.send({});
    }

    if (activity.type === "conversationUpdate" && activity.membersAdded?.some((m) => m.id === activity.recipient.id)) {
      // The app was installed for someone: say hello, and what it does.
      const context = await who();
      if ((activity.conversation.conversationType ?? "personal") === "personal") await send([context ? await conversations.welcome(context) : unavailable]);
      return reply.send({});
    }
    return reply.send({});
  });

  /**
   * Google Chat calls the Chat app's HTTP endpoint for every message, card button and install; the
   * call is checked (signed by Google for Chat, issued to this endpoint or project, from your domains).
   */
  app.post("/api/channels/google-chat/:company/events", async (request, reply) => {
    const { company: ref } = request.params as { company: string };
    const company = await platform.company(ref);
    if (!company) throw new HttpError(404, "Unknown company");
    const connection = await platform.googleChat.connection(company.id);
    if (!connection) throw new HttpError(404, "Google Chat is not connected");
    const settings = googleChatSettings(connection.ctx);
    await chatAuth.verify(request.headers.authorization, settings, `${config.publicUrl}/api/channels/google-chat/${company.slug}/events`);
    const event = ChatEvent.parse(request.body);
    const user = event.user;
    if (!user || (user.type && user.type !== "HUMAN") || !event.space) return reply.send({});
    const email = user.email?.toLowerCase() ?? null;
    if (settings.allowedDomains.length && !(email && settings.allowedDomains.includes(email.split("@")[1] ?? ""))) {
      throw new HttpError(403, "This Chat app serves another domain");
    }
    const space = event.space;
    const direct = space.type === "DM" || space.spaceType === "DIRECT_MESSAGE" || space.singleUserBotDm === true;
    const privately: ChatMessage = { text: "Please message me directly: your work and approvals stay private there." };

    const person = email ? await platform.people.findByEmail(company.id, email) : undefined;
    const known = await platform.channelAccounts.find(company.id, "google-chat", user.name);
    const account = await platform.channelAccounts.remember(company.id, "google-chat", {
      externalId: user.name,
      // Only direct messages are where the app writes to the person; a space keeps the address it had.
      address: direct ? { space: space.name, user: user.name } : (known?.address ?? { user: user.name }),
      email,
      name: user.displayName ?? null,
      userId: person?.id ?? null,
    });
    const context: ChatContext = {
      companyId: company.id,
      channel: "google-chat",
      account,
      person: account.userId ? await platform.people.get(company.id, account.userId).catch(() => undefined) : undefined,
      email,
    };

    if (event.type === "ADDED_TO_SPACE") return reply.send(googleChatMessage(direct ? await conversations.welcome(context) : privately));
    if (event.type === "MESSAGE") {
      if (!direct) return reply.send(googleChatMessage(privately));
      const replies = await conversations.onText(context, event.message?.argumentText ?? event.message?.text ?? "");
      // One reply is the answer itself; several (what needs me) are separate messages, each card updatable on its own.
      if (replies.length === 1) return reply.send(googleChatMessage(replies[0]!));
      for (const message of replies) await platform.googleChat.send(company.id, { space: space.name }, message);
      return reply.send({});
    }
    if (event.type === "CARD_CLICKED") {
      const verb = event.common?.invokedFunction ?? event.action?.actionMethodName ?? "";
      const parameters = event.common?.parameters ?? Object.fromEntries((event.action?.parameters ?? []).map((p) => [p.key, p.value]));
      const result = await conversations.onAction(context, verb, { ...parameters, ...formValues(event.common?.formInputs) });
      return reply.send(
        "card" in result
          ? { actionResponse: { type: "UPDATE_MESSAGE" }, ...googleChatMessage({ card: result.card }) }
          : { actionResponse: { type: "NEW_MESSAGE" }, text: result.error },
      );
    }
    return reply.send({});
  });

  /** How Teams and Google Chat are set up, and who uses them. */
  app.get("/api/companies/:company/channels", async (request) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const connection = await platform.teams.connection(company.id);
    let appId: string | null = null;
    let problem: string | null = null;
    if (connection) {
      try {
        appId = teamsBotSettings(connection.ctx).appId;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    const people = new Map((await platform.people.list(company.id)).map((p) => [p.id, p]));
    const chat = await platform.googleChat.connection(company.id);
    let chatProblem: string | null = null;
    let chatSettings: ReturnType<typeof googleChatSettings> | undefined;
    if (chat) {
      try {
        chatSettings = googleChatSettings(chat.ctx);
      } catch (error) {
        chatProblem = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      publicUrl: config.publicUrl,
      https: config.publicUrl.startsWith("https://"),
      teams: {
        connected: Boolean(connection),
        connectionId: connection?.id ?? null,
        appId,
        problem,
        messagingEndpoint: `${config.publicUrl}/api/channels/teams/${company.slug}/messages`,
        accounts: await accountsView(company.id, "teams", people),
      },
      googleChat: {
        connected: Boolean(chat),
        connectionId: chat?.id ?? null,
        serviceAccount: chatSettings?.key.clientEmail ?? null,
        audience: chatSettings?.audience ?? null,
        allowedDomains: chatSettings?.allowedDomains ?? [],
        problem: chatProblem,
        endpoint: `${config.publicUrl}/api/channels/google-chat/${company.slug}/events`,
        accounts: await accountsView(company.id, "google-chat", people),
      },
    };
  });

  /** The Teams app to upload in the Teams admin center (manifest and icons). */
  app.get("/api/companies/:company/channels/teams/app", async (request, reply) => {
    const company = await companyOf(platform, request);
    requireAdmin(request);
    const connection = await platform.teams.connection(company.id);
    if (!connection) throw new HttpError(409, "Connect Microsoft Teams first: the app names your bot");
    const { appId } = teamsBotSettings(connection.ctx);
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${company.slug}-teams-app.zip"`)
      .send(teamsAppPackage({ appId, companyName: company.name, publicUrl: config.publicUrl }));
  });
}
