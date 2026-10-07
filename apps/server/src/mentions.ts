import { parseMentions, type Mention, type MentionKind, type MentionRef } from "@enterprise-brain/core";
import type { ParticipantRow, Platform } from "@enterprise-brain/runtime";
import { canSeeDepartment, type Viewer } from "./auth/viewer.ts";
import { canSeeTable } from "./routes/tables.ts";

/** What the picker offers, and what a message's chips link to. */
export interface MentionHit {
  kind: MentionKind;
  id: string;
  name: string;
  detail: string;
  group: "People" | "AI employees" | "Things" | "Data" | "Files" | "Tasks";
  href: string | null;
}

/** The page an asset has, for a chip to link to (a mention's kind and id). */
export function mentionHref(companySlug: string, mention: MentionRef, extra: { slug?: string; key?: string } = {}): string | null {
  switch (mention.kind) {
    case "thing":
      return `/brain/e/${mention.id}`;
    case "table":
      return `/tables/${extra.key ?? mention.id}`;
    case "app":
      return `/apps/${extra.key ?? mention.id}`;
    case "calculation":
      return `/calculations/${extra.key ?? mention.id}`;
    case "task":
      return `/work/${mention.id}`;
    case "ai_employee":
      return extra.slug ? `/ai/${extra.slug}` : null;
    case "file":
      return `/api/companies/${companySlug}/files/${mention.id}?inline=1`;
    case "document":
      return "/settings/knowledge";
    case "person":
      return "/company";
    case "guest":
      return null;
  }
}

/**
 * The mentions in a text, checked against what its author may see: a token to something the author
 * cannot open stays plain text (`allowed: false`), so nobody reaches through an AI employee what they
 * could not reach themselves. Names are set to the asset's real name.
 */
export async function checkMentions(
  platform: Platform,
  viewer: Viewer,
  companyId: string,
  text: string,
  participants: ParticipantRow[] = [],
): Promise<Mention[]> {
  const found = parseMentions(text);
  const checked: Mention[] = [];
  for (const mention of found) {
    const resolved = await resolveMention(platform, viewer, companyId, mention, participants).catch(() => undefined);
    checked.push(resolved ?? { ...mention, allowed: false });
  }
  return checked;
}

async function resolveMention(
  platform: Platform,
  viewer: Viewer,
  companyId: string,
  mention: MentionRef,
  participants: ParticipantRow[],
): Promise<Mention | undefined> {
  const allowed = (name: string): Mention => ({ kind: mention.kind, id: mention.id, name, allowed: true });
  switch (mention.kind) {
    case "person": {
      const person = await platform.people.get(companyId, mention.id);
      return person.status === "active" ? allowed(person.name) : undefined;
    }
    case "ai_employee": {
      const agent = await platform.agents.find(companyId, mention.id);
      return agent && canSeeDepartment(viewer, agent.row.departmentId) ? { ...allowed(agent.definition.name), id: agent.row.id } : undefined;
    }
    case "thing": {
      const thing = await platform.brain.get(companyId, mention.id);
      return allowed(thing.name);
    }
    case "table": {
      const table = await platform.tables.get(companyId, mention.id);
      return canSeeTable(viewer, table) ? { ...allowed(table.name), id: table.key } : undefined;
    }
    case "app": {
      const app = await platform.apps.get(companyId, mention.id);
      return app.settings.visibility === "company" || canSeeDepartment(viewer, app.departmentId) ? { ...allowed(app.name), id: app.key } : undefined;
    }
    case "calculation": {
      const calculation = await platform.calculations.get(companyId, mention.id);
      return canSeeDepartment(viewer, calculation.departmentId) ? { ...allowed(calculation.name), id: calculation.key } : undefined;
    }
    case "file": {
      const file = await platform.files.meta(companyId, mention.id);
      return allowed(file.name);
    }
    case "document": {
      const document = await platform.knowledge.getDocument(companyId, mention.id);
      if (!document) return undefined;
      const collection = (await platform.knowledge.listCollections(companyId)).find((c) => c.id === document.collectionId);
      return canSeeDepartment(viewer, collection?.departmentId) ? allowed(document.title) : undefined;
    }
    case "task": {
      const task = await platform.tasks.find(companyId, mention.id);
      if (!task) return undefined;
      const agent = await platform.agents.find(companyId, task.agentId);
      return canSeeDepartment(viewer, agent?.row.departmentId) ? { ...allowed(task.title), id: task.ref } : undefined;
    }
    case "guest": {
      const guest = participants.find((p) => p.actorKind === "guest" && p.actorId === mention.id && p.status !== "revoked");
      return guest ? allowed(guest.actorName) : undefined;
    }
  }
}
