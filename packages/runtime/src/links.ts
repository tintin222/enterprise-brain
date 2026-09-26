import { createHmac, timingSafeEqual } from "node:crypto";
import type { QueueItemType } from "./events.ts";

/** What an action link lets its holder do: act on one queue item, as one person, until it expires. */
export interface ActionClaim {
  companyId: string;
  userId: string;
  type: QueueItemType;
  id: string;
  /** Where the link was sent ("email", "teams", "google-chat"): the audit log says where people acted. */
  via?: string;
  expiresAt: Date;
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

const TYPES: QueueItemType[] = ["approval", "question", "review", "failure", "notice"];
const VIAS = ["", "email", "teams", "google-chat"];
const WEEK_SECONDS = 7 * 24 * 3600;
const VERSION = 1;
// version · company · person · type · item · via · expiry (seconds), then a 128-bit MAC.
const PAYLOAD_BYTES = 1 + 16 + 16 + 1 + 16 + 1 + 4;
const MAC_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(value: string): Buffer {
  if (!UUID.test(value)) throw new LinkError(`Not an id: ${value}`);
  return Buffer.from(value.replace(/-/g, ""), "hex");
}

function uuidOf(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Signed links for acting outside the app (the buttons of an approval email). The link is the
 * credential, like a stakeholder's answer link: bound to one person and one item, valid for a week,
 * and worth nothing once the item is handled. Opening it only shows the item; acting takes a click.
 * Tokens are short (95 characters) so links survive plain-text email and fit a URL path segment.
 */
export class ActionLinks {
  constructor(private readonly key: Buffer) {}

  sign(claim: Omit<ActionClaim, "expiresAt">, options: { ttlSeconds?: number; now?: number } = {}): string {
    const expires = Math.floor((options.now ?? Date.now()) / 1000) + (options.ttlSeconds ?? WEEK_SECONDS);
    const type = TYPES.indexOf(claim.type);
    if (type < 0) throw new LinkError(`Unknown item type ${claim.type}`);
    const payload = Buffer.alloc(PAYLOAD_BYTES);
    let offset = payload.writeUInt8(VERSION, 0);
    offset += uuidBytes(claim.companyId).copy(payload, offset);
    offset += uuidBytes(claim.userId).copy(payload, offset);
    offset = payload.writeUInt8(type, offset);
    offset += uuidBytes(claim.id).copy(payload, offset);
    offset = payload.writeUInt8(Math.max(0, VIAS.indexOf(claim.via ?? "")), offset);
    payload.writeUInt32BE(expires, offset);
    return Buffer.concat([payload, this.mac(payload)]).toString("base64url");
  }

  verify(token: string, now = Date.now()): ActionClaim {
    const invalid = () => new LinkError("This link is not valid");
    if (!/^[\w-]+$/.test(token)) throw invalid();
    const data = Buffer.from(token, "base64url");
    if (data.length !== PAYLOAD_BYTES + MAC_BYTES) throw invalid();
    const payload = data.subarray(0, PAYLOAD_BYTES);
    if (!timingSafeEqual(this.mac(payload), data.subarray(PAYLOAD_BYTES))) throw invalid();
    if (payload.readUInt8(0) !== VERSION) throw invalid();
    const type = TYPES[payload.readUInt8(33)];
    const via = VIAS[payload.readUInt8(50)];
    if (!type || via === undefined) throw invalid();
    const expires = payload.readUInt32BE(51);
    if (expires * 1000 < now) throw new LinkError("This link has expired: open the item in the app instead", 410);
    return {
      companyId: uuidOf(payload.subarray(1, 17)),
      userId: uuidOf(payload.subarray(17, 33)),
      type,
      id: uuidOf(payload.subarray(34, 50)),
      ...(via ? { via } : {}),
      expiresAt: new Date(expires * 1000),
    };
  }

  private mac(payload: Buffer): Buffer {
    return createHmac("sha256", this.key).update(payload).digest().subarray(0, MAC_BYTES);
  }
}
