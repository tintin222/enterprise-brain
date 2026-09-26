import { EventEmitter } from "node:events";

/** The kinds of things in the work queue: approvals of changes, and the work items. */
export type QueueItemType = "approval" | "question" | "review" | "failure" | "notice";

export interface PlatformEventMap {
  /** Something now needs a person. */
  "queue.added": { companyId: string; type: QueueItemType; id: string };
  /** A person handled it (approved, rejected, answered, checked, dismissed), or it was withdrawn. */
  "queue.resolved": { companyId: string; type: QueueItemType; id: string; by: string; outcome: string };
  /** A task's status changed. */
  "task.changed": { companyId: string; taskId: string; status: string };
}

/**
 * In-process events between platform services (the engine and the work queue tell the
 * notification service what changed). Listeners run after the change is stored; their errors are
 * logged, never thrown back into the change.
 */
export class PlatformEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof PlatformEventMap>(event: K, listener: (payload: PlatformEventMap[K]) => void | Promise<void>): () => void {
    const wrapped = (payload: PlatformEventMap[K]) => {
      try {
        const result = listener(payload);
        if (result && typeof (result as Promise<void>).catch === "function")
          (result as Promise<void>).catch((error) => console.error(`[events] ${event}:`, error));
      } catch (error) {
        console.error(`[events] ${event}:`, error);
      }
    };
    this.emitter.on(event, wrapped);
    return () => this.emitter.off(event, wrapped);
  }

  emit<K extends keyof PlatformEventMap>(event: K, payload: PlatformEventMap[K]): void {
    this.emitter.emit(event, payload);
  }
}
