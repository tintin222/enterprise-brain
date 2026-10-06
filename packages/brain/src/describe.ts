import {
  brainKind,
  brainPath,
  isBlankValue,
  type BrainApi,
  type BrainContact,
  type BrainMilestone,
  type BrainStep,
  type BrainTable,
} from "@enterprise-brain/core";
import { formatValue } from "./service.ts";
import type { BrainEntitySummary, BrainEntityView, BrainEventView } from "./types.ts";

/**
 * The brain in words, for Claude: what the tools return to the company assistant, AI employees and
 * the Studio. Every thing carries its address (/brain/e/<id>) so answers can link to it.
 */

export function entityLink(thing: { id: string; name: string }): string {
  return `[${thing.name}](${brainPath(thing.id)})`;
}

export function describeSummary(thing: BrainEntitySummary): string {
  const kind = brainKind(thing.kind)?.name ?? thing.kind;
  const brief = thing.brief.map(([label, value]) => `${label}: ${value}`).join(" · ");
  return [`- ${entityLink(thing)} — ${kind}`, brief ? ` · ${brief}` : "", thing.summary ? `\n  ${thing.summary.replace(/\s+/g, " ").slice(0, 300)}` : ""].join(
    "",
  );
}

function steps(value: BrainStep[]): string[] {
  return value.map((s, i) => `  ${i + 1}. ${s.name}${s.who ? ` — ${s.who}` : ""}${s.system ? ` (in ${s.system})` : ""}${s.does ? `: ${s.does}` : ""}`);
}

function apis(value: BrainApi[]): string[] {
  return value.flatMap((api) => [
    `  - ${api.name} (${api.style})${api.url ? ` at ${api.url}` : ""}${api.auth ? `, sign-in: ${api.auth}` : ""}${api.docs ? `, docs: ${api.docs}` : ""}`,
    ...api.endpoints.map((e) => `    · ${e}`),
  ]);
}

function tables(value: BrainTable[]): string[] {
  return value.flatMap((table) => [
    `  - ${table.name}${table.description ? `: ${table.description}` : ""}`,
    ...table.columns.map((c) => `    · ${c.name}${c.type ? ` ${c.type}` : ""}${c.key ? ` [${c.key}]` : ""}${c.description ? ` — ${c.description}` : ""}`),
  ]);
}

function contacts(value: BrainContact[]): string[] {
  return value.map((c) => `  - ${c.name}${c.title ? `, ${c.title}` : ""}${c.email ? ` <${c.email}>` : ""}${c.phone ? `, ${c.phone}` : ""}`);
}

function milestones(value: BrainMilestone[]): string[] {
  return value.map((m) => `  - ${m.name}${m.due ? ` (due ${m.due})` : ""}${m.status ? `: ${m.status}` : ""}`);
}

export function describeEvent(event: BrainEventView): string {
  const about = event.about.length ? ` [about: ${event.about.map(entityLink).join(", ")}]` : "";
  const who = event.actor ? `${event.actor}` : event.origin;
  const where = event.place ? ` in ${event.place}` : "";
  const body = event.body ? `\n  ${event.body.replace(/\s+/g, " ").slice(0, 500)}` : "";
  return `- ${event.at.slice(0, 16).replace("T", " ")} · ${event.kind} from ${who}${where}: ${event.title}${about}${body}`;
}

/** Everything the brain knows about one thing: its values, links and the latest of what happened. */
export function describeEntity(view: BrainEntityView, options: { events?: number } = {}): string {
  const kind = brainKind(view.kind);
  const lines = [`# ${view.name} — ${kind?.name ?? view.kind}`, `Address: ${brainPath(view.id)}`];
  if (view.aliases.length) lines.push(`Also called: ${view.aliases.join(", ")}`);
  if (view.summary) lines.push("", view.summary);
  const values: string[] = [];
  for (const field of kind?.fields ?? []) {
    const value = view.data[field.key];
    if (field.hidden || isBlankValue(value)) continue;
    switch (field.type) {
      case "steps":
        values.push(`${field.label}:`, ...steps(value as BrainStep[]));
        break;
      case "apis":
        values.push(`${field.label}:`, ...apis(value as BrainApi[]));
        break;
      case "tables":
        values.push(`${field.label}:`, ...tables(value as BrainTable[]));
        break;
      case "contacts":
        values.push(`${field.label}:`, ...contacts(value as BrainContact[]));
        break;
      case "milestones":
        values.push(`${field.label}:`, ...milestones(value as BrainMilestone[]));
        break;
      case "list":
        values.push(`${field.label}:`, ...(value as string[]).map((item) => `  - ${item}`));
        break;
      default:
        values.push(`${field.label}: ${formatValue(field, value, view.data)}`);
    }
  }
  if (values.length) lines.push("", ...values);
  const groups = new Map<string, string[]>();
  for (const link of view.links) {
    const other = `${entityLink(link.other)} (${brainKind(link.other.kind)?.name.toLowerCase() ?? link.other.kind}${link.detail ? `, ${link.detail}` : ""})`;
    if (!groups.has(link.label)) groups.set(link.label, []);
    groups.get(link.label)!.push(other);
  }
  if (groups.size) {
    lines.push("", "Links:");
    for (const [label, others] of groups) lines.push(`- ${label}: ${others.join(", ")}`);
  }
  const events = view.events.slice(0, options.events ?? 8);
  if (events.length) lines.push("", "Latest:", ...events.map(describeEvent));
  const sources = [...new Set([...Object.values(view.origins), ...Object.keys(view.refs)])];
  if (sources.length) lines.push("", `Known from: ${sources.join(", ")}`);
  return lines.join("\n");
}

/** A thing's links in a few lines of Markdown ("Who knows it: Kerem Yıldız (Expert), …"), for answers without a model. */
export function linkLines(view: BrainEntityView, maxGroups = 6): string[] {
  const groups = new Map<string, string[]>();
  for (const link of view.links) {
    if (!groups.has(link.label)) groups.set(link.label, []);
    groups.get(link.label)!.push(`${entityLink(link.other)}${link.detail ? ` (${link.detail})` : ""}`);
  }
  return [...groups]
    .slice(0, maxGroups)
    .map(([label, others]) => `**${label}:** ${others.slice(0, 8).join(", ")}${others.length > 8 ? ` and ${others.length - 8} more` : ""}`);
}
