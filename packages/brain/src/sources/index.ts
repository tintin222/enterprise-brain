import { biSource } from "./bi.ts";
import { mailSource } from "./mail.ts";
import { slackSource, teamsSource } from "./chat.ts";
import { dataCatalogSource } from "./data.ts";
import { hrSource } from "./hr.ts";
import { intranetSource } from "./intranet.ts";
import { inventorySource } from "./inventory.ts";
import { platformSource } from "./platform.ts";
import { projectsSource } from "./projects.ts";
import { crmSource, erpSource, itsmSource } from "./systems.ts";
import type { BrainSourceDefinition } from "./types.ts";

export * from "./runner.ts";
export * from "./types.ts";
export { demoSchema } from "./data.ts";

/**
 * The sources, in the order "Fill it from all sources" reads them: people and departments first, then
 * the systems they look after, the processes that use those systems, the clients, suppliers and
 * projects, the data and the reports on all of it, and last what people say about all of these.
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
  dataCatalogSource,
  biSource,
  teamsSource,
  slackSource,
  mailSource,
];

/** A database read through its connection: below the catalog people curate, above chat. */
const SCHEMA_PRIORITY = 45;

export function sourcePriority(origin: string): number {
  if (origin.startsWith("schema:")) return SCHEMA_PRIORITY;
  return BRAIN_SOURCES.find((s) => s.key === origin)?.priority ?? 50;
}

export function sourceName(origin: string): string {
  if (origin === "manual") return "a person";
  if (origin.startsWith("schema:")) return "the database itself";
  return BRAIN_SOURCES.find((s) => s.key === origin)?.name ?? origin;
}
