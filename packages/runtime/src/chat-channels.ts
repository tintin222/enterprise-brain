import type { ChannelAccounts, ChatChannelId } from "./channel-accounts.ts";
import { handledCard, itemCard, summaryCard, taskNewsCard, type Card } from "./chat-cards.ts";
import type { ItemMessage, SummaryMessage, TaskNewsMessage } from "./notification-templates.ts";
import type { ChannelSender, DeliveryRef, HandledItem } from "./notifications.ts";
import type { Person } from "./people.ts";

/** A message in a chat app: some text, a card, or both. */
export interface ChatMessage {
  text?: string;
  card?: Card;
}

/** How the platform writes in a chat app (Teams, Google Chat): the app's own API behind it. */
export interface ChatTransport {
  readonly channel: ChatChannelId;
  /** Is the app connected for the company (a connection set up in Settings)? */
  connected(companyId: string): Promise<boolean>;
  /** Write to a conversation; the returned reference finds the message again. */
  send(companyId: string, address: Record<string, unknown>, message: ChatMessage): Promise<DeliveryRef>;
  /** Replace a message sent earlier (a card that was handled). */
  update(companyId: string, ref: DeliveryRef, message: ChatMessage): Promise<void>;
}

const LABELS: Record<ChatChannelId, string> = { teams: "Microsoft Teams", "google-chat": "Google Chat" };

/**
 * Notifications in a chat app: items arrive as cards with buttons in the person's conversation with
 * the app, cards are updated once the item is handled anywhere, and the summary comes each morning.
 * A person is reached once they wrote to the app or installed it.
 */
export class ChatChannelSender implements ChannelSender {
  constructor(
    readonly id: ChatChannelId,
    private readonly accounts: ChannelAccounts,
    private readonly transport: ChatTransport,
  ) {}

  async reaches(companyId: string, person: Person): Promise<boolean> {
    if (!(await this.transport.connected(companyId))) return false;
    return Boolean(await this.accounts.ofPerson(companyId, person.id, this.id));
  }

  private async address(companyId: string, person: Person): Promise<Record<string, unknown>> {
    const account = await this.accounts.ofPerson(companyId, person.id, this.id);
    if (!account) throw new Error(`${person.name} has no conversation with the app in ${LABELS[this.id]} yet`);
    return account.address;
  }

  async sendItem(message: ItemMessage): Promise<DeliveryRef> {
    return this.transport.send(message.companyId, await this.address(message.companyId, message.person), { card: itemCard(message) });
  }

  async sendSummary(message: SummaryMessage): Promise<DeliveryRef> {
    return this.transport.send(message.companyId, await this.address(message.companyId, message.person), { card: summaryCard(message) });
  }

  async sendTaskNews(message: TaskNewsMessage): Promise<DeliveryRef> {
    return this.transport.send(message.companyId, await this.address(message.companyId, message.person), { card: taskNewsCard(message) });
  }

  async updateItem(handled: HandledItem): Promise<void> {
    await this.transport.update(handled.companyId, handled.ref, { card: handledCard(handled.entry, handled, handled.openUrl) });
  }
}
