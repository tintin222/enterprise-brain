import { z } from "zod";

/**
 * Who did or said something, in the tables that keep a conversation: a person, an AI employee, or
 * the app itself. The older tables keep naming actors as strings (see `actorString`); new ones
 * store an Actor.
 */
export const ActorKind = z.enum(["person", "ai_employee", "system"]);
export type ActorKind = z.infer<typeof ActorKind>;

export const Actor = z.object({ kind: ActorKind, id: z.string().min(1).max(80), name: z.string().min(1).max(200) });
export type Actor = z.infer<typeof Actor>;

export const SYSTEM_ACTOR: Actor = { kind: "system", id: "system", name: "Enterprise Brain" };

export function sameActor(a: Pick<Actor, "kind" | "id">, b: Pick<Actor, "kind" | "id">): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function actorKey(actor: Pick<Actor, "kind" | "id">): string {
  return `${actor.kind}:${actor.id}`;
}

/** The audit log's way of naming who acted: "Name <email>", "agent:<id>", "system". */
export function actorString(actor: Actor, extra: { email?: string | null } = {}): string {
  switch (actor.kind) {
    case "person":
      return extra.email ? `${actor.name} <${extra.email}>` : actor.name;
    case "ai_employee":
      return `agent:${actor.id}`;
    case "system":
      return "system";
  }
}
