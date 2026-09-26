import { and, desc, eq } from "drizzle-orm";
import { channelAccounts, type DatabaseHandle } from "@enterprise-brain/db";

/** The chat apps people reach AI employees in. */
export type ChatChannelId = "teams" | "google-chat";

export const CHAT_CHANNELS: ChatChannelId[] = ["teams", "google-chat"];

export type ChannelAccountRow = typeof channelAccounts.$inferSelect;

export function isChatChannel(value: string | null | undefined): value is ChatChannelId {
  return value === "teams" || value === "google-chat";
}

/**
 * People's accounts in chat apps: who they are there (linked to a person by their email), and where
 * their conversation with the app is, to write to them first.
 */
export class ChannelAccounts {
  constructor(private readonly handle: DatabaseHandle) {}

  async find(companyId: string, channel: ChatChannelId, externalId: string): Promise<ChannelAccountRow | undefined> {
    const [row] = await this.handle.db
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.companyId, companyId), eq(channelAccounts.channel, channel), eq(channelAccounts.externalId, externalId)));
    return row;
  }

  async get(companyId: string, id: string): Promise<ChannelAccountRow | undefined> {
    const [row] = await this.handle.db
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.companyId, companyId), eq(channelAccounts.id, id)));
    return row;
  }

  /** Where a person is reached in a channel: their most recent conversation with the app. */
  async ofPerson(companyId: string, userId: string, channel: ChatChannelId): Promise<ChannelAccountRow | undefined> {
    const [row] = await this.handle.db
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.companyId, companyId), eq(channelAccounts.userId, userId), eq(channelAccounts.channel, channel)))
      .orderBy(desc(channelAccounts.updatedAt))
      .limit(1);
    return row;
  }

  async list(companyId: string, channel?: ChatChannelId): Promise<ChannelAccountRow[]> {
    const conditions = [eq(channelAccounts.companyId, companyId)];
    if (channel) conditions.push(eq(channelAccounts.channel, channel));
    return this.handle.db
      .select()
      .from(channelAccounts)
      .where(and(...conditions))
      .orderBy(desc(channelAccounts.updatedAt));
  }

  /**
   * Remember someone who wrote to the app (or installed it): where their conversation is, and the
   * person they are when known. An existing link to a person is kept.
   */
  async remember(
    companyId: string,
    channel: ChatChannelId,
    input: { externalId: string; address: Record<string, unknown>; email?: string | null; name?: string | null; userId?: string | null },
  ): Promise<ChannelAccountRow> {
    const existing = await this.find(companyId, channel, input.externalId);
    if (existing) {
      const [row] = await this.handle.db
        .update(channelAccounts)
        .set({
          address: input.address,
          email: input.email ?? existing.email,
          name: input.name ?? existing.name,
          userId: existing.userId ?? input.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(channelAccounts.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.handle.db
      .insert(channelAccounts)
      .values({
        companyId,
        channel,
        externalId: input.externalId,
        address: input.address,
        email: input.email ?? null,
        name: input.name ?? null,
        userId: input.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [channelAccounts.companyId, channelAccounts.channel, channelAccounts.externalId],
        set: { address: input.address, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async link(id: string, userId: string | null): Promise<void> {
    await this.handle.db.update(channelAccounts).set({ userId, updatedAt: new Date() }).where(eq(channelAccounts.id, id));
  }

  /** The AI employee a person is talking to in this conversation (their messages go to it). */
  async talkTo(id: string, agentId: string | null): Promise<void> {
    await this.handle.db.update(channelAccounts).set({ agentId }).where(eq(channelAccounts.id, id));
  }
}
