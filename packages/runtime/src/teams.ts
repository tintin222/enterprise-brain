import { sendActivity, updateActivity, type ConnectorContext, type TeamsAddress } from "@enterprise-brain/connectors";
import type { Card, CardBlock } from "./chat-cards.ts";
import type { ChatMessage, ChatTransport } from "./chat-channels.ts";
import type { ConnectorService } from "./connectors.ts";
import type { DeliveryRef } from "./notifications.ts";

type Json = Record<string, unknown>;

export const TEAMS_CONNECTOR = "microsoft-teams";
export const ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive";

/**
 * Text as Teams shows it: link syntax made visible (a link an AI employee wrote shows its address
 * instead of hiding it behind words), everything else as written.
 */
function visible(text: string): string {
  return text.replace(/\]\(/g, "] (");
}

/** Link text inside our own links: brackets would end it early. */
function linkText(text: string): string {
  return text.replace(/[[\]]/g, "");
}

/** Lines of plain text, one TextBlock each (a single line break doesn't show in a TextBlock). */
function lineBlocks(text: string, max = 40, style: Json = {}): Json[] {
  const blocks: Json[] = [];
  let gap = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      gap = blocks.length > 0;
      continue;
    }
    if (blocks.length >= max) {
      blocks.push({ type: "TextBlock", text: "…", wrap: true, spacing: "None" });
      break;
    }
    blocks.push({ type: "TextBlock", text: visible(line), wrap: true, ...style, spacing: gap ? "Medium" : "None" });
    gap = false;
  }
  return blocks;
}

function block(item: CardBlock): Json[] {
  switch (item.kind) {
    case "text": {
      const style = item.style === "subtle" ? { isSubtle: true, size: "Small" } : item.style === "strong" ? { weight: "Bolder" } : {};
      // Several lines (an AP note, a list): one TextBlock each, or Teams runs them together.
      if (/\r?\n/.test(item.text.trim()))
        return [{ type: "Container", ...(item.style === "strong" ? { spacing: "Medium" } : {}), items: lineBlocks(item.text, 40, style) }];
      return [{ type: "TextBlock", text: visible(item.text), wrap: true, ...style, ...(item.style === "strong" ? { spacing: "Medium" } : {}) }];
    }
    case "notice":
      return [{ type: "Container", style: item.tone, items: [{ type: "TextBlock", text: visible(item.text), wrap: true }] }];
    case "facts":
      return [{ type: "FactSet", facts: item.facts.map((f) => ({ title: f.label, value: visible(f.value) })) }];
    case "quote":
      return [{ type: "Container", style: "emphasis", items: lineBlocks(item.text) }];
    case "input":
      return [
        {
          type: "Input.Text",
          id: item.id,
          ...(item.label ? { label: item.label } : {}),
          placeholder: item.placeholder ?? "",
          isMultiline: item.multiline ?? false,
        },
      ];
    case "choice":
      return [
        {
          type: "Input.ChoiceSet",
          id: item.id,
          ...(item.label ? { label: item.label } : {}),
          style: item.compact ? "compact" : "expanded",
          choices: item.options.map((option) => (typeof option === "string" ? { title: option, value: option } : { title: option.label, value: option.value })),
          ...(item.value ? { value: item.value } : {}),
        },
      ];
    case "list":
      return [
        ...(item.heading ? [{ type: "TextBlock", text: item.heading, weight: "Bolder", wrap: true, spacing: "Medium" }] : []),
        ...item.items.map((entry) => ({
          type: "TextBlock",
          text: `${entry.url ? `[${linkText(entry.text)}](${entry.url})` : visible(entry.text)}${entry.detail ? ` · ${visible(entry.detail)}` : ""}`,
          wrap: true,
          spacing: "Small",
        })),
      ];
  }
}

/** A card as an Adaptive Card (1.5, Universal Actions: buttons come back to the bot as `adaptiveCard/action`). */
export function adaptiveCard(card: Card): Json {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      ...(card.subtitle ? [{ type: "TextBlock", text: card.subtitle, size: "Small", isSubtle: true, wrap: true }] : []),
      { type: "TextBlock", text: visible(card.title), size: "Medium", weight: "Bolder", wrap: true, spacing: card.subtitle ? "None" : "Default" },
      ...card.blocks.flatMap(block),
    ],
    actions: card.actions.map((action) =>
      action.kind === "open"
        ? { type: "Action.OpenUrl", title: action.label, url: action.url }
        : { type: "Action.Execute", title: action.label, verb: action.verb, data: action.data, ...(action.style ? { style: action.style } : {}) },
    ),
    msteams: { width: "Full" },
  };
}

/** A chat message as a Bot Framework activity. */
export function teamsActivity(message: ChatMessage): Json {
  return {
    ...(message.text ? { text: message.text, textFormat: "markdown" } : {}),
    ...(message.card ? { summary: message.card.summary, attachments: [{ contentType: ADAPTIVE_CARD, content: adaptiveCard(message.card) }] } : {}),
  };
}

/** Writes in Teams through the company's Teams connection (its bot). */
export class TeamsTransport implements ChatTransport {
  readonly channel = "teams" as const;

  constructor(private readonly connectors: ConnectorService) {}

  /** The company's Teams connection, with its credentials, when there is one. */
  async connection(companyId: string): Promise<{ id: string; ctx: ConnectorContext } | undefined> {
    const instance = (await this.connectors.list(companyId)).find((i) => i.type === TEAMS_CONNECTOR);
    if (!instance) return undefined;
    return { id: instance.id, ctx: await this.connectors.contextFor(companyId, instance.id) };
  }

  async connected(companyId: string): Promise<boolean> {
    return (await this.connectors.list(companyId)).some((i) => i.type === TEAMS_CONNECTOR);
  }

  addressable(address: Record<string, unknown>): boolean {
    return typeof address.serviceUrl === "string" && typeof address.conversationId === "string";
  }

  private async context(companyId: string): Promise<ConnectorContext> {
    const connection = await this.connection(companyId);
    if (!connection) throw new Error("Microsoft Teams is not connected (Settings → Teams and Chat)");
    return connection.ctx;
  }

  async send(companyId: string, address: Record<string, unknown>, message: ChatMessage): Promise<DeliveryRef> {
    const to = teamsAddress(address);
    const sent = await sendActivity(await this.context(companyId), to, teamsActivity(message));
    return { serviceUrl: to.serviceUrl, conversationId: to.conversationId, activityId: sent.id };
  }

  async update(companyId: string, ref: DeliveryRef, message: ChatMessage): Promise<void> {
    const to = teamsAddress(ref);
    if (typeof ref.activityId !== "string" || !ref.activityId) throw new Error("This Teams message can't be found again (no activity id)");
    await updateActivity(await this.context(companyId), to, ref.activityId, teamsActivity(message));
  }
}

export function teamsAddress(value: Record<string, unknown>): TeamsAddress {
  if (typeof value.serviceUrl !== "string" || typeof value.conversationId !== "string") throw new Error("Not a Teams conversation");
  return {
    serviceUrl: value.serviceUrl,
    conversationId: value.conversationId,
    ...(typeof value.tenantId === "string" ? { tenantId: value.tenantId } : {}),
    ...(typeof value.botId === "string" ? { botId: value.botId } : {}),
    ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
  };
}
