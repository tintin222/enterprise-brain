import type { Person, Platform, QueueEntry } from "@enterprise-brain/runtime";
import { canHandleWork, viewerFromPerson } from "./auth/viewer.ts";
import { HttpError } from "./http.ts";

/** What a person does with a queue item outside the app: on an email's page, or with a chat card's buttons. */
export interface ItemAction {
  choice?: "approve" | "reject";
  note?: string;
  /** Corrections before approving, as in the app. */
  edits?: Record<string, unknown>;
  answer?: string;
  verdict?: "right" | "wrong";
  retry?: boolean;
  dismiss?: boolean;
}

/**
 * A person handles a queue item from outside the app, by the app's rules: only people who may handle
 * it, one decision wins, and the audit log says where (`via`) it was made. Returns the item after.
 */
export async function actOnItem(platform: Platform, person: Person, entry: QueueEntry, action: ItemAction, via: string): Promise<QueueEntry | undefined> {
  if (person.status !== "active" || !canHandleWork(viewerFromPerson(person), entry.departmentId, entry.assigneeUserId)) {
    throw new HttpError(403, "This is someone else's to handle now");
  }
  const note = action.note?.trim() || undefined;
  if (entry.type === "approval") {
    if (!action.choice) throw new HttpError(400, "Choose to approve or reject");
    const edits = action.choice === "approve" && action.edits && Object.keys(action.edits).length ? action.edits : undefined;
    await platform.engine.decide(
      entry.companyId,
      entry.id,
      { approved: action.choice === "approve", note, decidedBy: person.name, edits, via },
      { wait: false },
    );
  } else {
    const { answer, verdict, retry, dismiss } = action;
    await platform.engine.resolveWorkItem(entry.companyId, entry.id, { answer, verdict, note, retry, dismiss }, person.name, { wait: false, via });
  }
  return platform.queue.entry(entry.companyId, entry.type, entry.id);
}
