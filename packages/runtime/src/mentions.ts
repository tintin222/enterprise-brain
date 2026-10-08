import { describeEntity, type BrainService } from "@enterprise-brain/brain";
import { truncate, type MentionRef } from "@enterprise-brain/core";
import type { KnowledgeService } from "@enterprise-brain/knowledge";
import type { AgentService } from "./agents.ts";
import type { AppService } from "./apps.ts";
import type { CalculationService } from "./calculations.ts";
import type { FileService } from "./files.ts";
import type { PeopleService } from "./people.ts";
import type { TableService } from "./tables.ts";
import type { TaskService } from "./tasks.ts";

export interface MentionCardDeps {
  brain?: BrainService;
  tables: TableService;
  apps: AppService;
  calculations: CalculationService;
  files: FileService;
  knowledge: KnowledgeService;
  tasks: TaskService;
  agents: AgentService;
  people: PeopleService;
}

/**
 * What an AI employee gets about the things a conversation names with "@": a short card per mention,
 * with the id so its own tools can go deeper (company_open, documents_read, find_<table>…). The cards
 * give direction, not permission: only mentions their author could see are turned into cards, and the
 * AI employee's own abilities and level decide what it may do next.
 */
export class MentionCards {
  constructor(private readonly deps: MentionCardDeps) {}

  async cards(companyId: string, mentions: MentionRef[], options: { max?: number; maxChars?: number } = {}): Promise<string[]> {
    const max = options.max ?? 8;
    const budget = options.maxChars ?? 6000;
    const cards: string[] = [];
    let used = 0;
    const seen = new Set<string>();
    for (const mention of mentions) {
      const key = `${mention.kind}:${mention.id}`;
      if (seen.has(key) || cards.length >= max) continue;
      seen.add(key);
      const card = await this.card(companyId, mention).catch(() => undefined);
      if (!card) continue;
      const fitted = truncate(card, Math.max(300, budget - used));
      used += fitted.length;
      cards.push(fitted);
      if (used >= budget) break;
    }
    return cards;
  }

  /** One mention in words; undefined when the asset is gone. */
  async card(companyId: string, mention: MentionRef): Promise<string | undefined> {
    switch (mention.kind) {
      case "thing": {
        if (!this.deps.brain) return undefined;
        const view = await this.deps.brain.get(companyId, mention.id);
        return truncate(describeEntity(view, { events: 3 }), 2500) + `\n(Open it with company_open: ${view.id})`;
      }
      case "table": {
        const table = await this.deps.tables.get(companyId, mention.id);
        const fields = table.fields.map((f) => `${f.label} (${f.type})${f.description ? `: ${f.description}` : ""}`);
        return [
          `## ${table.name} — table (key ${table.key})`,
          table.description,
          `Fields: ${fields.join("; ")}`,
          `Query it with find_${table.key} / get_${table.key}; change it with add_${table.key} / update_${table.key} (only if you have the Tables ability).`,
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "app": {
        const app = await this.deps.apps.get(companyId, mention.id);
        return [
          `## ${app.name} — app (key ${app.key})`,
          app.description,
          `Pages: ${app.pages.map((p) => p.title).join(", ") || "none"}`,
          app.tables.length ? `On the tables: ${app.tables.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "calculation": {
        const calculation = await this.deps.calculations.get(companyId, mention.id);
        return [
          `## ${calculation.name} — calculation (key ${calculation.key})`,
          `Rule: ${calculation.rule}`,
          calculation.explanation ? `How it works: ${calculation.explanation}` : "",
          calculation.tables.length ? `On the tables: ${calculation.tables.join(", ")}` : "",
          calculation.lastRunAt ? `Last run: ${calculation.lastRunAt.toISOString().slice(0, 16).replace("T", " ")}` : "Never run yet",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "file": {
        const file = await this.deps.files.meta(companyId, mention.id);
        const sheet = /spreadsheet|excel|csv|\.xlsx$|\.xls$|\.csv$/i.test(`${file.mimeType} ${file.name}`);
        return [
          `## ${file.name} — file (${file.mimeType}, ${Math.max(1, Math.round(file.size / 1024))} KB)`,
          sheet ? `Read it with excel_read(file_id: "${file.id}").` : `Read it with documents_read(file_id: "${file.id}").`,
        ].join("\n");
      }
      case "document": {
        const document = await this.deps.knowledge.getDocument(companyId, mention.id);
        if (!document) return undefined;
        const collection = (await this.deps.knowledge.listCollections(companyId)).find((c) => c.id === document.collectionId);
        return [
          `## ${document.title} — knowledge document${collection ? ` in ${collection.name}` : ""}`,
          collection ? `Search it with knowledge_search(query, collections: ["${collection.key}"]).` : "Search it with knowledge_search.",
        ].join("\n");
      }
      case "task": {
        const task = await this.deps.tasks.find(companyId, mention.id);
        if (!task) return undefined;
        const agent = await this.deps.agents.find(companyId, task.agentId);
        const events = (await this.deps.tasks.events(task.id)).filter((e) => e.type !== "woke").slice(-5);
        return [
          `## ${task.ref}: ${task.title} — task (${task.status.replace("_", " ")})`,
          `AI employee: ${agent?.definition.name ?? "unknown"}${task.requestedBy ? ` · asked by ${task.requestedBy}` : ""}`,
          events.length ? `Latest:\n${events.map((e) => `- ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")} ${e.message}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "person": {
        const person = await this.deps.people.get(companyId, mention.id);
        const roles = person.departments.map((d) => d.role).join(", ");
        return `## ${person.name} — colleague${person.title ? `, ${person.title}` : ""}${person.role === "admin" ? " (admin)" : roles ? ` (${roles})` : ""}${person.status !== "active" ? " · not active" : ""}`;
      }
      case "ai_employee": {
        const agent = await this.deps.agents.find(companyId, mention.id);
        if (!agent) return undefined;
        return [
          `## ${agent.definition.name} — AI employee${agent.definition.title ? `, ${agent.definition.title}` : ""} (${agent.row.status}, ${agent.row.probation})`,
          agent.definition.summary,
          "Mention them in your answer to ask them something; never do their work for them.",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  }
}
