import type { Actor } from "@enterprise-brain/core";
import { canReadConversation, type AgentRecord, type ConversationRow, type ParticipantRow, type Platform, type Reader } from "@enterprise-brain/runtime";
import { HttpError } from "../http.ts";
import type { AuthService } from "./service.ts";
import { OPEN_VIEWER, canManageDepartment, canSeeDepartment, viewerFromPerson, type Viewer } from "./viewer.ts";

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

/**
 * The AI employees a person may see (their departments and the open ones; admins all), at work or on
 * trial: an AI employee in a conversation hands a matter over only to one of these.
 */
export function colleaguesFor(platform: Platform, auth: AuthService) {
  return async (companyId: string, person: Actor): Promise<AgentRecord[]> => {
    if (person.kind !== "person") return [];
    let viewer: Viewer;
    if (auth.mode === "open" && person.id === "owner") viewer = OPEN_VIEWER;
    else {
      const found = await platform.people.get(companyId, person.id).catch(() => undefined);
      if (!found || found.status !== "active") return [];
      viewer = viewerFromPerson(found, await auth.openDepartmentIds(companyId));
    }
    return (await platform.agents.list(companyId, { includeSystem: true })).filter(
      (a) => (a.row.status === "active" || a.row.status === "testing") && canSeeDepartment(viewer, a.row.departmentId),
    );
  };
}
