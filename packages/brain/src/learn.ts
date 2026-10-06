import {
  BRAIN_KINDS,
  BRAIN_RELATIONS,
  brainKind,
  brainRelation,
  brainValue,
  relationFits,
  type BrainField,
  type BrainKindKey,
  type BrainRelationKey,
  type JsonSchema,
} from "@enterprise-brain/core";
import type { LlmClient } from "@enterprise-brain/llm";
import { z } from "zod";
import { describeEntity, describeSummary } from "./describe.ts";
import { BrainError, type BrainService } from "./service.ts";

/**
 * "Tell the brain": someone writes what they know in their own words ("Kerem knows the 8D process;
 * he uses SAP QM and Excel"), Claude turns it into changes to the brain (new things, values, links,
 * know-how), and the person picks which to keep. Without a model it is kept as know-how.
 */

export const LearnChange = z.object({
  /** add: a new thing · update: values of a thing · link: two things relate · knowhow: practical knowledge */
  type: z.enum(["add", "update", "link", "knowhow"]),
  kind: z.string(),
  /** The thing's id when it is already in the brain; empty for a new one. */
  id: z.string().default(""),
  name: z.string().trim().min(1).max(300),
  summary: z.string().max(4000).default(""),
  /** Values by field key; lists one item per line; steps "name | who | system | what is done". */
  fields: z.record(z.string(), z.string()).default({}),
  relation: z.string().default(""),
  to: z.object({ id: z.string().default(""), name: z.string().default(""), kind: z.string().default("") }).default({ id: "", name: "", kind: "" }),
  detail: z.string().max(200).default(""),
  /** For know-how: what it is about. */
  about: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(20)
    .default([]),
  /** Why, in the person's words. */
  why: z.string().max(600).default(""),
});
export type LearnChange = z.infer<typeof LearnChange>;

export interface LearnProposal {
  understood: string;
  changes: LearnChange[];
  /** True when no model wrote it: the text is kept as know-how. */
  offline: boolean;
}

const SIMPLE: BrainField["type"][] = ["text", "long_text", "number", "money", "percent", "date", "choice", "url", "email", "phone", "list", "steps"];

/** The kinds, their fields and the relations, in a few lines for Claude. */
function modelWords(): string {
  const kinds = BRAIN_KINDS.map((k) => {
    const fields = k.fields
      .filter((f: BrainField) => SIMPLE.includes(f.type) && !f.hidden)
      .map((f: BrainField) => `${f.key}${f.choices ? ` (${f.choices.join("/")})` : f.type === "list" ? " (list)" : f.type === "steps" ? " (steps)" : ""}`);
    return `- ${k.key}: ${k.description}. Fields: ${fields.join(", ") || "none"}`;
  });
  const relations = BRAIN_RELATIONS.map(
    (r) =>
      `- ${r.key}: "${r.label}" from ${r.from === "any" ? "anything" : r.from.join("/")} to ${r.to === "any" ? "anything" : r.to.join("/")}${"detail" in r ? ` (detail: ${r.detail.label})` : ""}`,
  );
  return ["Kinds:", ...kinds, "", "Relations:", ...relations].join("\n");
}

const SYSTEM = [
  "You keep a company's brain: the company's people, processes, systems, clients, projects and know-how, as things and links between them.",
  "Someone tells you something they know. Turn it into changes to the brain, only from what they said; never add what they didn't say.",
  "Use the things already in the brain (their ids are given) instead of adding them again; add a new thing only when it isn't there.",
  "Kinds of changes: add (a new thing, with its fields), update (new values for a thing already there, by its id), link (two things relate: the change's id or name is the first thing, `to` the second), knowhow (a practical tip or lesson, with what it is about).",
  "Practical knowledge from experience (how to get something done, what to watch for) is knowhow; facts about who does what or which system is used are links and values.",
  "Field values are words: lists one item per line; process steps one per line as `name | who | system | what is done`.",
  "Write names and values in the person's language. Keep `why` to a few words quoting them.",
].join("\n");

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    understood: { type: "string", description: "What you understood, in one sentence" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["add", "update", "link", "knowhow"] },
          kind: { type: "string", description: "The kind of the thing (for link: the first thing's kind)" },
          id: { type: "string", description: "Its id when it is in the brain, else empty" },
          name: { type: "string" },
          summary: { type: "string", description: "One or two sentences, or empty" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { key: { type: "string" }, value: { type: "string" } },
              required: ["key", "value"],
              additionalProperties: false,
            },
          },
          relation: { type: "string", description: "For link: the relation key, else empty" },
          to: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" } },
            required: ["id", "name", "kind"],
            additionalProperties: false,
          },
          detail: { type: "string", description: "For link: the relation's detail (how well, role…), else empty" },
          about: {
            type: "array",
            description: "For knowhow: the things it is about",
            items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
          },
          why: { type: "string" },
        },
        required: ["type", "kind", "id", "name", "summary", "fields", "relation", "to", "detail", "about", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["understood", "changes"],
  additionalProperties: false,
};

function firstSentence(text: string): string {
  const sentence =
    text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/** A field's words in its kept shape (steps from "name | who | system | what" lines). */
export function learnedValue(field: BrainField, words: string): unknown {
  if (field.type === "steps") {
    return brainValue(
      field,
      words
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean)
        .map((line) => {
          const [name = "", who = "", system = "", does = ""] = line.split("|").map((p) => p.trim());
          return { name, who, system, does };
        }),
    );
  }
  return brainValue(field, field.type === "list" ? words.split(/\r?\n/) : words);
}

/** Proposes changes for what someone told the brain; `about` is the thing they were looking at. */
export async function proposeLearning(brain: BrainService, llm: LlmClient, companyId: string, text: string, about?: string): Promise<LearnProposal> {
  const focus = about ? await brain.get(companyId, about).catch(() => undefined) : undefined;
  if (!llm.available) {
    return {
      understood: "Kept as know-how (no AI model is connected to sort it).",
      offline: true,
      changes: [
        LearnChange.parse({
          type: "knowhow",
          kind: "knowhow",
          name: firstSentence(text),
          fields: { details: text },
          about: focus ? [{ id: focus.id, name: focus.name }] : [],
          why: "What you wrote",
        }),
      ],
    };
  }
  const nearby = await brain.search(companyId, text, { limit: 25 });
  const context = [
    focus ? `They are looking at this thing:\n${describeEntity(focus, { events: 3 })}` : "",
    nearby.length
      ? `Things in the brain that may be meant (ids in the addresses /brain/e/<id>):\n${nearby.map(describeSummary).join("\n")}`
      : "The brain has nothing close yet.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { data } = await llm.structured<{ understood: string; changes: (Omit<LearnChange, "fields"> & { fields: { key: string; value: string }[] })[] }>({
    purpose: "brain.learn",
    system: `${SYSTEM}\n\n${modelWords()}`,
    effort: "medium",
    schema: SCHEMA,
    messages: [{ role: "user", content: `${context}\n\nWhat they told the brain:\n${text}` }],
  });
  const changes: LearnChange[] = [];
  for (const raw of data.changes ?? []) {
    const parsed = LearnChange.safeParse({ ...raw, fields: Object.fromEntries((raw.fields ?? []).map((f) => [f.key, f.value])) });
    if (parsed.success) changes.push(parsed.data);
  }
  return { understood: data.understood ?? "", changes, offline: false };
}

export interface LearnApplied {
  /** What was done, in words. */
  done: string[];
  /** What could not be done, in words. */
  skipped: string[];
  /** The things added or changed. */
  ids: string[];
}

/**
 * Makes the chosen changes, as the person: new things first, then values, then links and know-how,
 * so links can name things added in the same go. `mayEdit` false: only know-how is kept.
 */
export async function applyLearning(
  brain: BrainService,
  companyId: string,
  changes: LearnChange[],
  actor: { name: string; email?: string | null; mayEdit: boolean },
): Promise<LearnApplied> {
  const done: string[] = [];
  const skipped: string[] = [];
  const ids: string[] = [];
  const added = new Map<string, string>();
  const who = actor.email ? `${actor.name} <${actor.email}>` : actor.name;
  const values = (kind: BrainKindKey, fields: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [key, words] of Object.entries(fields)) {
      const field = brainKind(kind)?.fields.find((f) => f.key === key);
      if (!field || field.hidden) continue;
      try {
        out[key] = learnedValue(field, words);
      } catch (error) {
        skipped.push(error instanceof Error ? error.message : String(error));
      }
    }
    return out;
  };
  const resolve = async (id: string, name: string, kind: string): Promise<string | undefined> => {
    if (id && (await brain.find(companyId, id))) return id;
    const known = added.get(`${kind}|${name}`) ?? added.get(`|${name}`);
    if (known) return known;
    return name ? (await brain.find(companyId, name, kind || undefined))?.id : undefined;
  };
  const ordered = [...changes].sort((a, b) => ["add", "update", "knowhow", "link"].indexOf(a.type) - ["add", "update", "knowhow", "link"].indexOf(b.type));
  for (const change of ordered) {
    try {
      if (change.type !== "knowhow" && !actor.mayEdit) {
        skipped.push(`${change.name}: only a manager or an admin can add this`);
        continue;
      }
      const kind = brainKind(change.type === "knowhow" ? "knowhow" : change.kind);
      if (change.type === "add") {
        if (!kind) throw new BrainError(`unknown kind "${change.kind}"`);
        const created = await brain.create(
          companyId,
          { kind: kind.key as BrainKindKey, name: change.name, summary: change.summary || undefined, data: values(kind.key as BrainKindKey, change.fields) },
          who,
        );
        added.set(`${kind.key}|${change.name}`, created.id).set(`|${change.name}`, created.id);
        ids.push(created.id);
        done.push(`Added ${kind.name.toLowerCase()} "${change.name}"`);
      } else if (change.type === "update") {
        const id = await resolve(change.id, change.name, change.kind);
        if (!id) throw new BrainError("not in the brain");
        const current = await brain.get(companyId, id);
        const updated = await brain.update(companyId, id, { summary: change.summary || undefined, data: values(current.kind, change.fields) }, who);
        ids.push(updated.id);
        done.push(`Changed "${updated.name}"`);
      } else if (change.type === "knowhow") {
        const fields = { ...change.fields };
        const created = await brain.create(
          companyId,
          { kind: "knowhow", name: change.name, summary: change.summary || undefined, data: values("knowhow", fields) },
          who,
        );
        ids.push(created.id);
        for (const thing of change.about) {
          const id = await resolve(thing.id, thing.name, "");
          if (id) await brain.link(companyId, { from: created.id, relation: "about", to: id }, who).catch((error: unknown) => skipped.push(String(error)));
        }
        const me = actor.email ? (await brain.search(companyId, actor.email, { kinds: ["person"], limit: 1 }))[0] : undefined;
        if (me) await brain.link(companyId, { from: created.id, relation: "shared_by", to: me.id }, who).catch(() => undefined);
        done.push(`Kept know-how "${change.name}"`);
      } else {
        const relation = brainRelation(change.relation);
        if (!relation) throw new BrainError(`unknown relation "${change.relation}"`);
        const from = await resolve(change.id, change.name, change.kind);
        const to = await resolve(change.to.id, change.to.name, change.to.kind);
        if (!from || !to) throw new BrainError(`${!from ? change.name : change.to.name} is not in the brain`);
        const [a, b] = await Promise.all([brain.get(companyId, from), brain.get(companyId, to)]);
        if (!relationFits(relation, a.kind, b.kind)) throw new BrainError(`"${relation.label}" doesn't go from ${a.name} to ${b.name}`);
        await brain.link(companyId, { from, relation: relation.key as BrainRelationKey, to, detail: change.detail || undefined }, who);
        ids.push(from);
        done.push(`Linked: ${a.name} ${relation.label.toLowerCase()} ${b.name}${change.detail ? ` (${change.detail})` : ""}`);
      }
    } catch (error) {
      skipped.push(`${change.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { done, skipped, ids: [...new Set(ids)] };
}
