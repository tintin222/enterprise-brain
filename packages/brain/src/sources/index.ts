import { mailSource } from "./mail.ts";
import { slackSource, teamsSource } from "./chat.ts";
import { hrSource } from "./hr.ts";
import { intranetSource } from "./intranet.ts";
import { inventorySource } from "./inventory.ts";
import { platformSource } from "./platform.ts";
import { projectsSource } from "./projects.ts";
import { crmSource, erpSource, itsmSource } from "./systems.ts";
import type { BrainSourceDefinition } from "./types.ts";

export * from "./runner.ts";
export * from "./types.ts";

/**
 * The sources, in the order "Fill it from all sources" reads them: people and departments first, then
 * the systems they look after, the processes that use those systems, the clients, suppliers and
 * projects, and last what people say about all of these.
 */
export const BRAIN_SOURCES: BrainSourceDefinition[] = [
  platformSource,
  hrSource,
  inventorySource,
  intranetSource,
  crmSource,
  erpSource,
  itsmSource,
  projectsSource,
  teamsSource,
  slackSource,
  mailSource,
];

export function sourcePriority(origin: string): number {
  return BRAIN_SOURCES.find((s) => s.key === origin)?.priority ?? 50;
}

export function sourceName(origin: string): string {
  if (origin === "manual") return "a person";
  return BRAIN_SOURCES.find((s) => s.key === origin)?.name ?? origin;
}
