import { brainKind, type BrainKindKey } from "@enterprise-brain/core";
import type { EntityRow, LinkRow } from "./service.ts";
import type { BrainAttention, BrainEntitySummary, BrainEventView, BrainGap, BrainOverview, BrainProjectView } from "./types.ts";

interface OverviewInput {
  rows: EntityRow[];
  links: LinkRow[];
  recent: BrainEventView[];
  eventStats: { origin: string; n: number; recent: number }[];
  now: Date;
  summaryOf(row: EntityRow): BrainEntitySummary;
}

const DONE_TASK = new Set(["Done"]);
const CLOSED_CASE = new Set(["Resolved", "Closed"]);
const CLOSED_DEAL = new Set(["Won", "Lost"]);
const LIVE_PROJECT = new Set(["Active", "Planned", "On hold"]);
const HEALTH_ORDER: Record<string, number> = { "Off track": 0, "At risk": 1, "On track": 2 };

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function ref(row: EntityRow): { id: string; kind: BrainKindKey; name: string } {
  return { id: row.id, kind: row.kind as BrainKindKey, name: row.name };
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * What a CEO looks at first: projects and how they go, what needs attention (projects at risk, urgent
 * customer issues, late tasks, deals about to close, goals slipping), where know-how sits with one
 * person only, and who is busy with what.
 */
export function overviewOf({ rows, links, recent, eventStats, now, summaryOf }: OverviewInput): BrainOverview {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  const of = (kind: string) => rows.filter((r) => r.kind === kind);
  const outgoing = (row: EntityRow, relation: string) =>
    links.filter((l) => l.fromId === row.id && l.relation === relation).flatMap((l) => byId.get(l.toId) ?? []);
  const incoming = (row: EntityRow, relation: string) =>
    links.filter((l) => l.toId === row.id && l.relation === relation).flatMap((l) => byId.get(l.fromId) ?? []);
  const today = day(now);
  const inDays = (days: number) => day(new Date(now.getTime() + days * 86_400_000));

  const tasks = of("task");
  const openTasks = tasks.filter((t) => !DONE_TASK.has(String(t.data.status ?? "")));
  const projectOf = (task: EntityRow) => outgoing(task, "part_of").find((p) => p.kind === "project");

  const projects: BrainProjectView[] = of("project")
    .filter((p) => LIVE_PROJECT.has(String(p.data.status ?? "Active")))
    .map((p) => {
      const client = outgoing(p, "for_client")[0];
      const lead = incoming(p, "leads")[0];
      return {
        id: p.id,
        name: p.name,
        status: text(p.data.status),
        health: text(p.data.health),
        progress: typeof p.data.progress === "number" ? p.data.progress : null,
        end: text(p.data.end),
        client: client ? { id: client.id, name: client.name } : null,
        lead: lead ? { id: lead.id, name: lead.name } : null,
        openTasks: openTasks.filter((t) => projectOf(t)?.id === p.id).length,
        now: text(p.data.now),
      };
    })
    .sort((a, b) => (HEALTH_ORDER[a.health ?? ""] ?? 3) - (HEALTH_ORDER[b.health ?? ""] ?? 3) || (a.end ?? "9999").localeCompare(b.end ?? "9999"));

  const attention: BrainAttention[] = [];
  for (const project of of("project")) {
    const health = text(project.data.health);
    if (project.data.status !== "Active" || (health !== "At risk" && health !== "Off track")) continue;
    const risk = (project.data.risks as string[] | undefined)?.[0];
    attention.push({
      type: "risk",
      title: `${project.name} is ${health.toLowerCase()}`,
      detail: risk ?? text(project.data.now) ?? "",
      entity: ref(project),
      severity: health === "Off track" ? "high" : "medium",
    });
  }
  for (const issue of of("case")) {
    const priority = text(issue.data.priority);
    if (CLOSED_CASE.has(String(issue.data.status ?? "")) || (priority !== "Urgent" && priority !== "High")) continue;
    const client = outgoing(issue, "for_client")[0];
    const owner = incoming(issue, "owns")[0];
    attention.push({
      type: "issue",
      title: `${priority} customer issue${client ? ` from ${client.name}` : ""}`,
      detail: [issue.name, owner ? `with ${owner.name}` : null, text(issue.data.status)?.toLowerCase()].filter(Boolean).join(" · "),
      entity: ref(issue),
      severity: priority === "Urgent" ? "high" : "medium",
    });
  }
  for (const task of openTasks) {
    const due = text(task.data.due);
    if (!due || due >= today) continue;
    const who = outgoing(task, "assigned_to")[0];
    const project = projectOf(task);
    attention.push({
      type: "overdue",
      title: `Late: ${task.name}`,
      detail: [`due ${due}`, who ? who.name : "no one assigned", project?.name].filter(Boolean).join(" · "),
      entity: ref(task),
      severity: "medium",
    });
  }
  for (const deal of of("deal")) {
    const close = text(deal.data.close_date);
    if (!close || CLOSED_DEAL.has(String(deal.data.stage ?? "")) || close > inDays(30)) continue;
    const client = outgoing(deal, "for_client")[0];
    const amount = typeof deal.data.amount === "number" ? `${deal.data.amount.toLocaleString("en-US")} ${text(deal.data.currency) ?? ""}`.trim() : null;
    attention.push({
      type: "deal",
      title: close < today ? `Deal past its close date: ${deal.name}` : `Deal closing by ${close}: ${deal.name}`,
      detail: [client?.name, text(deal.data.stage), amount].filter(Boolean).join(" · "),
      entity: ref(deal),
      severity: close < today ? "high" : "medium",
    });
  }
  for (const goal of of("goal")) {
    const status = text(goal.data.status);
    if (status !== "At risk" && status !== "Off track") continue;
    attention.push({
      type: "goal",
      title: `Goal ${status.toLowerCase()}: ${goal.name}`,
      detail: [text(goal.data.current) ? `now ${text(goal.data.current)}` : null, text(goal.data.target) ? `target ${text(goal.data.target)}` : null]
        .filter(Boolean)
        .join(" · "),
      entity: ref(goal),
      severity: status === "Off track" ? "high" : "medium",
    });
  }
  const typeOrder = ["risk", "issue", "goal", "deal", "overdue"];
  attention.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));

  // Know-how that sits with one person, and things no one is responsible for.
  const gaps: BrainGap[] = [];
  for (const thing of rows.filter((r) => r.kind === "process" || r.kind === "system")) {
    const people = new Map<string, EntityRow>();
    for (const link of links) {
      if (link.toId !== thing.id || (link.relation !== "knows" && link.relation !== "does")) continue;
      const person = byId.get(link.fromId);
      if (person?.kind === "person" && person.data.status !== "Left") people.set(person.id, person);
    }
    const kindName = brainKind(thing.kind)!.name.toLowerCase();
    const only = people.size === 1 ? [...people.values()][0]! : undefined;
    if (only && only.data.status === "On leave") {
      gaps.push({
        type: "on-leave-expert",
        title: `Only ${only.name} knows ${thing.name}, and they are on leave`,
        detail: `No one else is linked to this ${kindName}. Ask who covers it, and add them.`,
        entity: ref(thing),
      });
    } else if (only) {
      gaps.push({
        type: "single-expert",
        title: `Only ${only.name} knows ${thing.name}`,
        detail: `If ${only.name} is away, no one else is known to do this ${kindName}.`,
        entity: ref(thing),
      });
    }
    const owner = incoming(thing, "owns").length > 0 || (thing.kind === "system" && incoming(thing, "looks_after").length > 0);
    if (!owner) gaps.push({ type: "no-owner", title: `No one is responsible for ${thing.name}`, detail: `Add the ${kindName}'s owner.`, entity: ref(thing) });
    if (thing.kind === "process" && !(thing.data.steps as unknown[] | undefined)?.length) {
      gaps.push({ type: "no-steps", title: `${thing.name} has no steps written down`, detail: "Write down how it is done, step by step.", entity: ref(thing) });
    }
  }
  const gapOrder = ["on-leave-expert", "single-expert", "no-owner", "no-steps"];
  gaps.sort((a, b) => gapOrder.indexOf(a.type) - gapOrder.indexOf(b.type) || a.entity.name.localeCompare(b.entity.name));

  const busyBy = new Map<string, { person: EntityRow; tasks: EntityRow[] }>();
  for (const task of openTasks) {
    for (const person of outgoing(task, "assigned_to")) {
      if (person.kind !== "person") continue;
      if (!busyBy.has(person.id)) busyBy.set(person.id, { person, tasks: [] });
      busyBy.get(person.id)!.tasks.push(task);
    }
  }
  const busy = [...busyBy.values()]
    .sort((a, b) => b.tasks.length - a.tasks.length || a.person.name.localeCompare(b.person.name))
    .slice(0, 8)
    .map(({ person, tasks: list }) => ({
      person: { id: person.id, name: person.name, title: text(person.data.title) },
      open: list.length,
      tasks: list.slice(0, 3).map((t) => t.name),
    }));

  const company = of("company")[0];
  return {
    company: company ? summaryOf(company) : null,
    counts,
    total: rows.length,
    links: links.length,
    events: {
      total: eventStats.reduce((sum, s) => sum + s.n, 0),
      lastWeek: eventStats.reduce((sum, s) => sum + s.recent, 0),
      bySource: Object.fromEntries(eventStats.map((s) => [s.origin, s.recent])),
    },
    recent,
    projects,
    attention: attention.slice(0, 20),
    gaps: gaps.slice(0, 30),
    busy,
    goals: of("goal").map(summaryOf),
  };
}
