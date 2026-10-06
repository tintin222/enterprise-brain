import { BRAIN_KIND_KEYS, brainKind, isBrainKind } from "@enterprise-brain/core";
import type { ToolDefinition, ToolExecution } from "@enterprise-brain/llm";
import { describeEntity, describeEvent, describeSummary } from "./describe.ts";
import type { BrainService } from "./service.ts";

/**
 * Tools that read the company brain, for the company assistant, AI employees ("company.lookup") and
 * the Studio. Answers link to what they name with the addresses these tools give.
 */
export const COMPANY_TOOLS: ToolDefinition[] = [
  {
    name: "company_search",
    description:
      "Search the company brain: people (titles, skills, what they know), departments, roles, processes (steps, rules, who does them), " +
      "systems (what they do, APIs, databases and their tables), document stores, clients, deals, customer issues, suppliers, products, " +
      "projects, tasks, goals, decisions, know-how and company words. Returns matches with their addresses; open one with company_open.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'A name or a few words: "invoice", "SAP", "Petrokim", "8D"' },
        kinds: { type: "array", items: { type: "string", enum: BRAIN_KIND_KEYS }, description: "Only these kinds" },
      },
      required: ["query"],
    },
  },
  {
    name: "company_open",
    description:
      "Everything the company brain knows about one thing: its details (a process's steps and rules, a system's APIs and database tables, " +
      "a project's state), who and what it is linked to (who knows it, who does it, which systems it uses…) and the latest of what happened.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_name: { type: "string", description: "Its id from company_search, or its name" },
        kind: { type: "string", enum: BRAIN_KIND_KEYS, description: "Its kind, when giving a name" },
      },
      required: ["id_or_name"],
    },
  },
  {
    name: "company_list",
    description: "Every thing of one kind in the company brain, with its main values: all projects and their health, all systems, all open customer issues…",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: BRAIN_KIND_KEYS },
        limit: { type: "number", description: "At most this many (default 60)" },
      },
      required: ["kind"],
    },
  },
  {
    name: "company_activity",
    description:
      "What has been happening, newest first: Teams and Slack messages, emails, calls, meetings, updates and changes (a deal's stage, a project's health). " +
      "About one thing, or the whole company.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "The id or name of what it should be about; leave out for everything" },
        days: { type: "number", description: "Only the last this many days (default 14)" },
        limit: { type: "number", description: "At most this many (default 25)" },
      },
    },
  },
];

export const COMPANY_TOOL_NAMES = new Set(COMPANY_TOOLS.map((t) => t.name));

const NOTHING = "The company brain has nothing on that yet.";

/** Runs one of the company tools. */
export async function runCompanyTool(
  brain: BrainService,
  companyId: string,
  name: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<ToolExecution> {
  const kindOf = (value: unknown) => (typeof value === "string" && isBrainKind(value) ? value : undefined);
  switch (name) {
    case "company_search": {
      const kinds = Array.isArray(input.kinds) ? input.kinds.filter((k): k is string => typeof k === "string" && isBrainKind(k)) : undefined;
      const hits = await brain.search(companyId, String(input.query ?? ""), { kinds, limit: 15 });
      return { content: hits.length ? hits.map(describeSummary).join("\n") : `${NOTHING} Try other words, or company_list.` };
    }
    case "company_open": {
      const found = await brain.find(companyId, String(input.id_or_name ?? ""), kindOf(input.kind));
      if (!found) {
        const hits = await brain.search(companyId, String(input.id_or_name ?? ""), { kinds: kindOf(input.kind) ? [kindOf(input.kind)!] : undefined, limit: 8 });
        return {
          content: hits.length ? `Not one thing by that name. Did you mean:\n${hits.map(describeSummary).join("\n")}` : NOTHING,
          isError: !hits.length,
        };
      }
      return { content: describeEntity(await brain.get(companyId, found.id)) };
    }
    case "company_list": {
      const kind = kindOf(input.kind);
      if (!kind) return { content: `Give a kind: ${BRAIN_KIND_KEYS.join(", ")}.`, isError: true };
      const limit = Math.min(Math.max(Number(input.limit) || 60, 1), 200);
      const all = await brain.list(companyId, { kind });
      if (!all.length) return { content: `There are no ${brainKind(kind)!.plural.toLowerCase()} in the company brain yet.` };
      const more = all.length > limit ? `\n…and ${all.length - limit} more; search to find one.` : "";
      return { content: `${all.length} ${brainKind(kind)!.plural.toLowerCase()}:\n${all.slice(0, limit).map(describeSummary).join("\n")}${more}` };
    }
    case "company_activity": {
      const days = Math.min(Math.max(Number(input.days) || 14, 1), 365);
      const about = typeof input.about === "string" && input.about.trim() ? await brain.find(companyId, input.about) : undefined;
      if (typeof input.about === "string" && input.about.trim() && !about)
        return { content: `Nothing in the company brain is called "${input.about}".`, isError: true };
      const events = await brain.events(companyId, {
        about: about?.id,
        since: new Date(now.getTime() - days * 86_400_000),
        limit: Math.min(Number(input.limit) || 25, 100),
      });
      return {
        content: events.length ? events.map(describeEvent).join("\n") : `Nothing recorded in the last ${days} days${about ? ` about ${about.name}` : ""}.`,
      };
    }
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
}

/** How Claude should use the company brain: added to the instructions of whoever has the tools. */
export const COMPANY_GUIDANCE = [
  "The company brain knows the company: its people (who does what, who knows what, who is responsible for what), departments and roles,",
  "processes (steps, rules, inputs and outputs, systems and documents), IT systems (purpose, APIs, databases and tables, where documents are kept),",
  "clients, deals, customer issues, suppliers, products, projects and tasks (who works on what now), goals, decisions, know-how and company words,",
  "and what has been happening (messages, emails, updates). Use company_search, then company_open on what you find, rather than guessing.",
  "When you name something from the brain in an answer, link it with its address, like [Kerem Yıldız](/brain/e/<id>).",
  "Say when the brain doesn't know something, and who would.",
].join(" ");

/** How the Studio should use the company brain when it builds. */
export const BUILDING_GUIDANCE = [
  "The company brain (company_search, company_open, company_list, company_activity) knows how the company really works.",
  "Before you design, look up the work the person describes: the process with its steps, rules, inputs and outputs; who does each step and who",
  "is responsible; the systems it uses (their APIs, databases and tables, and whether AI employees can reach them); the documents, policies",
  "and know-how about it. Build the AI employee to follow the company's real steps and rules, in its systems, and to hand work to the people",
  "the brain names. Say what you found in a sentence or two. Where the brain doesn't know something, ask the person, and suggest they add",
  "it to the brain. An AI employee that needs to know who does what at work can have the company ability.",
].join(" ");
