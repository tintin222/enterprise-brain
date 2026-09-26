import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMember, teamsBotSettings, type ConnectorContext, type TeamsAddress } from "@enterprise-brain/connectors";
import { ADAPTIVE_CARD, adaptiveCard, type ChatMessage, type CompanyRow } from "@enterprise-brain/runtime";
import { requireAdmin } from "../auth/viewer.ts";
import { BotFrameworkAuth } from "../channels/botframework.ts";
import { ChatConversations, type ActionResult, type ChatContext } from "../channels/conversation.ts";
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

  /** How Teams (and later Google Chat) is set up, and who uses it. */
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
    const accounts = await platform.channelAccounts.list(company.id, "teams");
    return {
      publicUrl: config.publicUrl,
      https: config.publicUrl.startsWith("https://"),
      teams: {
        connected: Boolean(connection),
        connectionId: connection?.id ?? null,
        appId,
        problem,
        messagingEndpoint: `${config.publicUrl}/api/channels/teams/${company.slug}/messages`,
        accounts: accounts.map((a) => ({
          name: a.name,
          email: a.email,
          person: a.userId ? (people.get(a.userId)?.name ?? null) : null,
          since: a.createdAt,
          lastSeenAt: a.updatedAt,
        })),
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
