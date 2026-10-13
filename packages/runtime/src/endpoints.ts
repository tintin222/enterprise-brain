import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentEndpoints, type DatabaseHandle } from "@enterprise-brain/db";
import type { SecretBox } from "./secrets.ts";

/** webhook: other systems call it; form: people fill in its public form. */
export type EndpointKind = "webhook" | "form";
export type EndpointRow = typeof agentEndpoints.$inferSelect;

/** An endpoint as people see it: never its secret, only whether it has one. */
export interface EndpointView {
  id: string;
  kind: EndpointKind;
  token: string;
  status: "on" | "off";
  hasSecret: boolean;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
}

/** 32 random bytes: the unguessable part of an address, and a secret. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * How other systems and people reach an AI employee without signing in: its webhook address (with a
 * secret for the readable address and for signatures, kept encrypted) and its public form's link. One of
 * each per AI employee, made when first needed; a new address or secret makes the old one stop working.
 */
export class EndpointService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly secretBox: SecretBox,
  ) {}

  /** The AI employee's endpoint of this kind, made when it has none yet. */
  async ensure(companyId: string, agentId: string, kind: EndpointKind, by?: string): Promise<EndpointRow> {
    const existing = await this.forAgent(agentId, kind);
    if (existing) return existing;
    await this.handle.db
      .insert(agentEndpoints)
      .values({ companyId, agentId, kind, token: randomToken(), createdBy: by ?? null })
      .onConflictDoNothing();
    return (await this.forAgent(agentId, kind))!;
  }

  async forAgent(agentId: string, kind: EndpointKind): Promise<EndpointRow | undefined> {
    const [row] = await this.handle.db
      .select()
      .from(agentEndpoints)
      .where(and(eq(agentEndpoints.agentId, agentId), eq(agentEndpoints.kind, kind)));
    return row;
  }

  async byToken(token: string): Promise<EndpointRow | undefined> {
    if (!/^[\w-]{20,100}$/.test(token)) return undefined;
    const [row] = await this.handle.db.select().from(agentEndpoints).where(eq(agentEndpoints.token, token));
    return row;
  }

  /** A new address: the old one stops working at once. */
  async rotate(id: string): Promise<EndpointRow> {
    const [row] = await this.handle.db.update(agentEndpoints).set({ token: randomToken(), rotatedAt: new Date() }).where(eq(agentEndpoints.id, id)).returning();
    return row!;
  }

  /** A new secret, returned this once (kept encrypted): the old one stops working at once. */
  async newSecret(id: string): Promise<{ row: EndpointRow; secret: string }> {
    const secret = randomToken();
    const [row] = await this.handle.db
      .update(agentEndpoints)
      .set({ secretCiphertext: this.secretBox.encrypt(secret), rotatedAt: new Date() })
      .where(eq(agentEndpoints.id, id))
      .returning();
    return { row: row!, secret };
  }

  /** The endpoint's secret, to check a caller's header or signature against; null when none was made. */
  secretOf(row: EndpointRow): string | null {
    if (!row.secretCiphertext) return null;
    try {
      return this.secretBox.decrypt<string>(row.secretCiphertext);
    } catch {
      return null;
    }
  }

  async setStatus(id: string, status: "on" | "off"): Promise<EndpointRow> {
    const [row] = await this.handle.db.update(agentEndpoints).set({ status }).where(eq(agentEndpoints.id, id)).returning();
    return row!;
  }

  /** Count a use of the endpoint. */
  async touch(id: string): Promise<void> {
    await this.handle.db
      .update(agentEndpoints)
      .set({ uses: sql`${agentEndpoints.uses} + 1`, lastUsedAt: new Date() })
      .where(eq(agentEndpoints.id, id));
  }

  view(row: EndpointRow): EndpointView {
    return {
      id: row.id,
      kind: row.kind as EndpointKind,
      token: row.token,
      status: row.status === "off" ? "off" : "on",
      hasSecret: Boolean(row.secretCiphertext),
      createdAt: row.createdAt.toISOString(),
      rotatedAt: row.rotatedAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      uses: row.uses,
    };
  }
}
