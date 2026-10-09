import type { Actor } from "@enterprise-brain/core";
import {
  canReadConversation,
  type AgentRecord,
  type ConversationRow,
  type ConversationWithParticipants,
  type ParticipantRow,
  type Platform,
  type Reader,
} from "@enterprise-brain/runtime";
import { HttpError } from "../http.ts";
import type { AuthService } from "./service.ts";
import { OPEN_VIEWER, canManageDepartment, canSeeDepartment, viewerFromPerson, type Viewer } from "./viewer.ts";

/** How the viewer takes part in conversations: a person by their id; the owner in open mode; machines as the app. */
export function actorOfViewer(viewer: Viewer): Actor {
  if (viewer.kind === "session" && viewer.userId) return { kind: "person", id: viewer.userId, name: viewer.name };
  if (viewer.kind === "open") return { kind: "person", id: "owner", name: viewer.name };
  return { kind: "system", id: "api", name: viewer.name };
}

/** The departments whose conversations the viewer reads: their own and the open ones (shared services). */
export function readerOf(viewer: Viewer): Reader {
  const actor = actorOfViewer(viewer);
  return {
    actor: actor.kind === "system" ? null : actor,
    departmentIds: [...new Set([...viewer.departments.map((d) => d.departmentId), ...viewer.openDepartmentIds])],
    isAdmin: viewer.isAdmin,
  };
}

/** The departments the viewer works in (not the open ones): they are in those channels, and can't leave them. */
export function ownDepartmentIds(viewer: Viewer): string[] {
  return viewer.departments.map((d) => d.departmentId);
}

/** A thread is read as its channel or direct message is. */
export function canSeeConversation(viewer: Viewer, found: ConversationWithParticipants): boolean {
  return canReadConversation(found.conversation, found.participants, readerOf(viewer), found.parent);
}

export function requireConversation(viewer: Viewer, found: ConversationWithParticipants): void {
  if (!canSeeConversation(viewer, found)) throw new HttpError(404, "Conversation not found");
}

/** Who runs a channel (archives, renames it) and brings people into a private one: its owner, the managers of its department, admins. */
export function canManageConversation(viewer: Viewer, conversation: ConversationRow, participants: ParticipantRow[]): boolean {
  if (viewer.isAdmin) return true;
  const me = actorOfViewer(viewer);
  if (participants.some((p) => p.actorKind === me.kind && p.actorId === me.id && p.role === "owner")) return true;
  return Boolean(conversation.departmentId) && canManageDepartment(viewer, conversation.departmentId);
}

/** Who brings people in and removes them: the same as who runs it (any participant brings people in, see the routes). */
export const canInvite = canManageConversation;

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
