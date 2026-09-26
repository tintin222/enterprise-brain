import { createChatMessage, updateChatMessage, type ConnectorContext } from "@enterprise-brain/connectors";
import type { Card, CardBlock } from "./chat-cards.ts";
import type { ChatMessage, ChatTransport } from "./chat-channels.ts";
import type { ConnectorService } from "./connectors.ts";
import type { DeliveryRef } from "./notifications.ts";

type Json = Record<string, unknown>;

export const GOOGLE_CHAT_CONNECTOR = "google-chat";

/** Card text is a little HTML in Google Chat: everything is escaped, and line breaks kept. */
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>");
}

const TONE_COLORS: Record<string, string> = { warning: "#b45309", good: "#047857", attention: "#b91c1c", accent: "#4338ca" };
const BUTTON_COLORS = {
  positive: { red: 0.02, green: 0.59, blue: 0.41, alpha: 1 },
  destructive: { red: 0.86, green: 0.15, blue: 0.15, alpha: 1 },
};

function widgets(item: CardBlock): Json[] {
  switch (item.kind) {
    case "text":
      return [
        {
          textParagraph: {
            text:
              item.style === "strong"
                ? `<b>${html(item.text)}</b>`
                : item.style === "subtle"
                  ? `<font color="#64748b">${html(item.text)}</font>`
                  : html(item.text),
          },
        },
      ];
    case "notice":
      return [{ textParagraph: { text: `<font color="${TONE_COLORS[item.tone] ?? "#334155"}"><b>${html(item.text)}</b></font>` } }];
    case "facts":
      return item.facts.map((fact) => ({ decoratedText: { topLabel: fact.label, text: html(fact.value), wrapText: true } }));
    case "quote":
      return [{ textParagraph: { text: html(item.text) } }];
    case "input":
      return [
        {
          textInput: {
            name: item.id,
            label: item.label ?? item.placeholder ?? item.id,
            type: item.multiline ? "MULTIPLE_LINE" : "SINGLE_LINE",
            ...(item.label && item.placeholder ? { hintText: item.placeholder } : {}),
          },
        },
      ];
    case "choice":
      return [
        {
          selectionInput: {
            name: item.id,
            label: item.label ?? "Choose",
            type: item.compact ? "DROPDOWN" : "RADIO_BUTTON",
            items: item.options.map((option) => {
              const value = typeof option === "string" ? option : option.value;
              return { text: typeof option === "string" ? option : option.label, value, selected: value === item.value };
            }),
          },
        },
      ];
    case "list":
      return [
        ...(item.heading ? [{ textParagraph: { text: `<b>${html(item.heading)}</b>` } }] : []),
        ...item.items.map((entry) => ({
          decoratedText: {
            text: entry.url ? `<a href="${html(entry.url)}">${html(entry.text)}</a>` : html(entry.text),
            ...(entry.detail ? { bottomLabel: entry.detail } : {}),
            wrapText: true,
          },
        })),
      ];
  }
}

/** A card as a Google Chat card (cards v2): buttons that act come back to the app as CARD_CLICKED. */
export function googleCard(card: Card): Json {
  const buttons = card.actions.map((action) =>
    action.kind === "open"
      ? { text: action.label, onClick: { openLink: { url: action.url } } }
      : {
          text: action.label,
          onClick: { action: { function: action.verb, parameters: Object.entries(action.data).map(([key, value]) => ({ key, value })) } },
          ...(action.style ? { color: BUTTON_COLORS[action.style] } : {}),
        },
  );
  return {
    header: { title: card.title, ...(card.subtitle ? { subtitle: card.subtitle } : {}) },
    sections: [{ widgets: [...card.blocks.flatMap(widgets), ...(buttons.length ? [{ buttonList: { buttons } }] : [])] }],
  };
}

/** A chat message as a Google Chat message. */
export function googleChatMessage(message: ChatMessage): Json {
  return {
    ...(message.text ? { text: message.text } : {}),
    ...(message.card ? { cardsV2: [{ cardId: "eb", card: googleCard(message.card) }], fallbackText: message.card.summary } : {}),
  };
}

/** Writes in Google Chat through the company's Chat app (its service account). */
export class GoogleChatTransport implements ChatTransport {
  readonly channel = "google-chat" as const;

  constructor(private readonly connectors: ConnectorService) {}

  /** The company's Google Chat connection, with its credentials, when there is one. */
  async connection(companyId: string): Promise<{ id: string; ctx: ConnectorContext } | undefined> {
    const instance = (await this.connectors.list(companyId)).find((i) => i.type === GOOGLE_CHAT_CONNECTOR);
    if (!instance) return undefined;
    return { id: instance.id, ctx: await this.connectors.contextFor(companyId, instance.id) };
  }

  async connected(companyId: string): Promise<boolean> {
    return (await this.connectors.list(companyId)).some((i) => i.type === GOOGLE_CHAT_CONNECTOR);
  }

  addressable(address: Record<string, unknown>): boolean {
    return typeof address.space === "string" && address.space.startsWith("spaces/");
  }

  private async context(companyId: string): Promise<ConnectorContext> {
    const connection = await this.connection(companyId);
    if (!connection) throw new Error("Google Chat is not connected (Settings → Teams and Chat)");
    return connection.ctx;
  }

  async send(companyId: string, address: Record<string, unknown>, message: ChatMessage): Promise<DeliveryRef> {
    if (typeof address.space !== "string") throw new Error("Not a Google Chat conversation");
    const sent = await createChatMessage(await this.context(companyId), address.space, googleChatMessage(message));
    return { space: address.space, messageName: sent.name };
  }

  async update(companyId: string, ref: DeliveryRef, message: ChatMessage): Promise<void> {
    if (typeof ref.messageName !== "string" || !ref.messageName) throw new Error("This Google Chat message can't be found again");
    await updateChatMessage(await this.context(companyId), ref.messageName, googleChatMessage(message));
  }
}
