import { humanizeKey } from "@enterprise-brain/core";
import type { SourceEntity, SourceEvent, SourceLink } from "../types.ts";
import type { BrainSourceDefinition, PlatformAgent } from "./types.ts";

function words(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function capitalized(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** How an AI employee's work starts, in words. */
function startsOf(definition: Record<string, unknown>): string[] {
  const triggers = Array.isArray(definition.triggers) ? (definition.triggers as Record<string, unknown>[]) : [];
  return triggers.flatMap((t) => {
    switch (t.type) {
      case "mailbox":
        return t.mailbox === "*" ? ["Each email to the mailboxes it follows"] : [`Each email to ${String(t.mailbox)}`];
      case "schedule":
        return [`On a schedule (${String(t.cron ?? "")})`];
      case "form":
        return ["When someone fills in its form"];
      case "webhook":
        return ["When another system calls it"];
      case "connector-event":
        return [`On ${String(t.event ?? "news")} in ${String(t.connector ?? "a system")}`];
      case "chat":
        return ["When someone talks to it"];
      default:
        return [];
    }
  });
}

const ABILITIES: Record<string, string> = {
  "knowledge.search": "Searches the knowledge base",
  "documents.read": "Reads documents and attachments",
  "excel.read": "Works with Excel",
  "excel.write": "Works with Excel",
  "mail.draft": "Drafts emails",
  "mail.send": "Sends emails",
  "web.search": "Searches the web",
  "company.lookup": "Looks things up in the company brain",
};

function abilitiesOf(definition: Record<string, unknown>): string[] {
  const tools = Array.isArray(definition.tools) ? (definition.tools as string[]) : [];
  const out = tools.map(
    (tool) => ABILITIES[tool] ?? (tool.startsWith("connector:") ? `Uses ${humanizeKey(tool.slice(10).split(".")[0] ?? "a system")}` : undefined),
  );
  return [...new Set(out.filter((x): x is string => Boolean(x)))];
}

/** "human:ap-clerk" → "Ap clerk"; "agent:finance.invoice-processor" → its name; "system:erp" → "ERP". */
function actorWords(actor: unknown, agents: PlatformAgent[]): { who: string; system: string } {
  const [kind, id = ""] = String(actor ?? "").split(":");
  if (kind === "agent") return { who: agents.find((a) => a.templateId === id)?.name ?? `${humanizeKey(id.split(".").pop() ?? id)} (AI)`, system: "" };
  if (kind === "system") return { who: "", system: id.length <= 4 ? id.toUpperCase() : humanizeKey(id) };
  return { who: humanizeKey(id), system: "" };
}

/**
 * Enterprise Brain itself: its departments, the people who use it and their departments, the AI
 * employees (who manages them, what they do) and the processes installed for them, and what the AI
 * employees finished in the last two weeks.
 */
export const platformSource: BrainSourceDefinition = {
  key: "platform",
  name: "Enterprise Brain",
  system: "This app",
  description:
    "Departments, the people who use the app, AI employees and their managers, the processes installed for them, and the work AI employees finished.",
  brings: ["Departments", "People", "AI employees", "Processes", "AI employees' work"],
  icon: "bot",
  demo: false,
  priority: 30,
  async read({ companyId, deps, now }) {
    const [departments, people, agents, processes, tasks] = await Promise.all([
      deps.departments(companyId),
      deps.people(companyId),
      deps.agents(companyId),
      deps.processes(companyId),
      deps.tasks(companyId, new Date(now.getTime() - 14 * 86_400_000)),
    ]);
    const live = agents.filter((a) => a.status !== "archived");
    const departmentKey = new Map(departments.map((d) => [d.id, d.key]));
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    const events: SourceEvent[] = [];

    for (const department of departments) {
      const kpis = Array.isArray(department.data.kpis) ? (department.data.kpis as Record<string, unknown>[]).map((k) => words(k.name)).filter(Boolean) : [];
      entities.push({
        kind: "department",
        ref: department.id,
        key: department.key,
        name: department.name,
        summary: department.summary,
        data: { mission: words(department.data.mission), kpis },
      });
    }
    for (const person of people) {
      entities.push({
        kind: "person",
        ref: person.id,
        name: person.name,
        data: { email: person.email, title: person.title ?? undefined, status: person.status === "active" ? "Active" : "Left" },
      });
      for (const membership of person.departments) {
        const key = departmentKey.get(membership.departmentId);
        if (key) links.push({ from: { kind: "person", ref: person.id }, relation: "works_in", to: { kind: "department", key } });
      }
    }
    for (const agent of live) {
      const instructions = words(agent.definition.instructions) ?? "";
      entities.push({
        kind: "ai_employee",
        ref: agent.id,
        key: agent.slug,
        name: agent.name,
        summary: agent.summary,
        data: {
          status: capitalized(agent.status),
          level: capitalized(agent.probation),
          job: instructions.length > 1200 ? `${instructions.slice(0, 1199)}…` : instructions,
          starts: startsOf(agent.definition),
          abilities: abilitiesOf(agent.definition),
          slug: agent.slug,
        },
      });
      const key = agent.departmentId ? departmentKey.get(agent.departmentId) : undefined;
      if (key) links.push({ from: { kind: "ai_employee", ref: agent.id }, relation: "works_in", to: { kind: "department", key } });
      if (agent.managerUserId)
        links.push({ from: { kind: "person", ref: agent.managerUserId }, relation: "manages", to: { kind: "ai_employee", ref: agent.id } });
    }
    for (const process of processes) {
      const steps = Array.isArray(process.data.steps) ? (process.data.steps as Record<string, unknown>[]) : [];
      const trigger = process.data.trigger as Record<string, unknown> | undefined;
      const kpis = Array.isArray(process.data.kpis) ? (process.data.kpis as Record<string, unknown>[]).map((k) => words(k.name)).filter(Boolean) : [];
      entities.push({
        kind: "process",
        ref: process.id,
        key: process.key,
        name: process.name,
        summary: process.summary,
        data: {
          status: "Draft",
          trigger: words(trigger?.description)?.replace(/\s+/g, " "),
          frequency: words(process.data.frequency),
          steps: steps.map((s) => ({ name: words(s.name) ?? "Step", does: (words(s.description) ?? "").replace(/\s+/g, " "), ...actorWords(s.actor, agents) })),
          kpis,
        },
      });
      const key = process.departmentId ? departmentKey.get(process.departmentId) : undefined;
      if (key) links.push({ from: { kind: "department", key }, relation: "owns", to: { kind: "process", ref: process.id } });
      const templateAgents = Array.isArray(process.data.agents) ? (process.data.agents as string[]) : [];
      for (const agent of live) {
        if (agent.processId === process.id || (agent.templateId && templateAgents.includes(agent.templateId))) {
          links.push({ from: { kind: "ai_employee", ref: agent.id }, relation: "does", to: { kind: "process", ref: process.id } });
        }
      }
    }
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const task of tasks) {
      const agent = task.agentId ? byId.get(task.agentId) : undefined;
      if (!agent) continue;
      const done = task.status === "done" ? "finished" : task.status === "failed" ? "could not finish" : task.status === "cancelled" ? "stopped" : undefined;
      if (!done) continue;
      events.push({
        ref: `task:${task.id}:${task.status}`,
        at: task.updatedAt,
        kind: "update",
        title: `${agent.name} ${done}: ${task.title}`,
        actor: agent.name,
        place: task.ref,
        about: [{ kind: "ai_employee", ref: agent.id }],
      });
    }
    return { entities, links, events };
  },
};
