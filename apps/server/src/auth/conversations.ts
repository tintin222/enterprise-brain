import type { Actor } from "@enterprise-brain/core";
import { canReadConversation, type ConversationRow, type ParticipantRow, type Reader } from "@enterprise-brain/runtime";
import { HttpError } from "../http.ts";
import { canManageDepartment, type Viewer } from "./viewer.ts";

/** How the viewer takes part in conversations: a person by their id; the owner in open mode; machines as the app. */
export function actorOfViewer(viewer: Viewer): Actor {
  if (viewer.kind === "session" && viewer.userId) return { kind: "person", id: viewer.userId, name: viewer.name };
  if (viewer.kind === "open") return { kind: "person", id: "owner", name: viewer.name };
  return { kind: "system", id: "api", name: viewer.name };
}

export function readerOf(viewer: Viewer): Reader {
  const actor = actorOfViewer(viewer);
  return { actor: actor.kind === "system" ? null : actor, departmentIds: viewer.departments.map((d) => d.departmentId), isAdmin: viewer.isAdmin };
}

export function canSeeConversation(viewer: Viewer, conversation: ConversationRow, participants: ParticipantRow[]): boolean {
  return canReadConversation(conversation, participants, readerOf(viewer));
}

export function requireConversation(viewer: Viewer, conversation: ConversationRow, participants: ParticipantRow[]): void {
  if (!canSeeConversation(viewer, conversation, participants)) throw new HttpError(404, "Conversation not found");
}

/** Who brings people in: its owner, the managers of its department, admins. */
export function canInvite(viewer: Viewer, conversation: ConversationRow, participants: ParticipantRow[]): boolean {
  if (viewer.isAdmin) return true;
  const me = actorOfViewer(viewer);
  if (participants.some((p) => p.actorKind === me.kind && p.actorId === me.id && p.role === "owner")) return true;
  return Boolean(conversation.departmentId) && canManageDepartment(viewer, conversation.departmentId);
}
