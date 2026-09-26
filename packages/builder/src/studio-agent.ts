import { z } from "zod";
import {
  AgentDefinition,
  PROBATION_LEVELS,
  describeDuties,
  repeatCron,
  slugify,
  type AppDesignInput,
  type FieldSpec,
  type Probation,
  type TableField,
  type TriggerSpec,
} from "@enterprise-brain/core";
import type { ToolDefinition } from "@enterprise-brain/llm";

/**
 * The Studio as an agent: Claude works with a person the way Claude Code works with a developer. It
 * looks at the company with its tools, interviews the person like an analyst, builds the parts of a
 * solution (AI employees, tables, apps), tries each AI employee on real examples and fixes what fails.
 * This module holds what doesn't touch the database: the instructions, the tools as Claude sees them,
 * the shapes of their inputs, and the step from an AI employee written in plain words to its job.
 */

// ---------------------------------------------------------------------------
// Inputs of the tools
// ---------------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** When an AI employee works on its own. People can always give it work in words, too. */
export const EmployeeStart = z.discriminatedUnion("when", [
  z.object({ when: z.literal("email"), mailbox: z.string().trim().toLowerCase().email() }),
  z.object({
    when: z.literal("schedule"),
    every: z.enum(["day", "weekday", "week", "month"]),
    weekday: z.number().int().min(0).max(6).optional(),
    day: z.number().int().min(1).max(28).optional(),
    time: z.string().regex(TIME).optional(),
  }),
  z.object({ when: z.literal("form") }),
]);
export type EmployeeStart = z.infer<typeof EmployeeStart>;

export const FORM_FIELD_TYPES = ["text", "long_text", "number", "date", "email", "choice", "yes_no", "file"] as const;

export const FormFieldSpec = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(FORM_FIELD_TYPES).default("text"),
  required: z.boolean().optional(),
  choices: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  description: z.string().max(300).optional(),
});
export type FormFieldSpec = z.infer<typeof FormFieldSpec>;

export const EmployeeAbilities = z.object({
  /** Read attachments and files. */
  documents: z.boolean().optional(),
  /** Search the company's knowledge: all of it, or these collections. */
  knowledge: z.union([z.boolean(), z.array(z.string())]).optional(),
  /** Emails: none, drafts people send, or sent by itself (asking first while on probation). */
  emails: z.enum(["none", "draft", "send"]).optional(),
  web: z.boolean().optional(),
  tables: z.array(z.object({ table: z.string(), can: z.array(z.enum(["find", "add", "update"])).min(1) })).optional(),
  actions: z.array(z.object({ system: z.string(), actions: z.array(z.string()).min(1) })).optional(),
});
export type EmployeeAbilities = z.infer<typeof EmployeeAbilities>;

/** An AI employee as the Studio agent writes it. */
export const EmployeeSpec = z.object({
  key: z.string().optional(),
  name: z.string().trim().min(2).max(60),
  role: z.string().trim().min(3).max(200),
  department: z.string().optional(),
  job: z.string().trim().min(20).max(30_000),
  starts: z.array(EmployeeStart).max(10).default([]),
  form: z.array(FormFieldSpec).max(30).default([]),
  can: EmployeeAbilities.default({}),
  approval: z.array(z.enum(["emails", "changes"])).default(["emails", "changes"]),
  level: z.enum(["shadow", "supervised", "trusted"]).default("supervised"),
});
export type EmployeeSpec = z.infer<typeof EmployeeSpec>;

export const TableFieldSpec = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(["text", "long_text", "number", "money", "date", "yes_no", "choice", "person", "email", "url", "file"]).default("text"),
  choices: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  required: z.boolean().optional(),
  personal: z.boolean().optional(),
  default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  description: z.string().max(300).optional(),
});

export const TableSpec = z.object({
  key: z.string().optional(),
  name: z.string().trim().min(2).max(80),
  department: z.string().optional(),
  description: z.string().max(500).optional(),
  fields: z.array(TableFieldSpec).min(1).max(60),
  title_field: z.string().optional(),
});
export type TableSpec = z.infer<typeof TableSpec>;

export const AppSpec = z.object({
  key: z.string().optional(),
  name: z.string().trim().min(2).max(80),
  department: z.string().optional(),
  description: z.string().trim().min(10).max(4000),
  tables: z.array(z.string()).min(1).max(8),
  ai_employees: z.array(z.string()).max(8).default([]),
});
export type AppSpec = z.infer<typeof AppSpec>;

export const StudioQuestion = z.object({
  question: z.string().trim().min(3).max(500),
  why: z.string().max(500).optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
  recommended: z.string().max(500).optional(),
});
export type StudioQuestion = z.infer<typeof StudioQuestion>;

export const AskPersonInput = z.object({ questions: z.array(StudioQuestion).min(1).max(3) });

export const AskItInput = z.object({
  system: z.string().trim().min(2).max(120),
  needed: z.string().trim().min(5).max(2000),
  why: z.string().trim().min(3).max(1000),
  for: z.string().max(120).optional(),
});

export const TryInput = z.object({
  key: z.string(),
  email_id: z.string().optional(),
  email: z.object({ from: z.string().email(), subject: z.string(), body: z.string(), from_name: z.string().optional() }).optional(),
  file_id: z.string().optional(),
  request: z.string().max(4000).optional(),
  form: z.record(z.string(), z.unknown()).optional(),
});
export type TryInput = z.infer<typeof TryInput>;

export const LookAtInput = z.object({ kind: z.enum(["ai_employee", "table", "system"]), key: z.string() });
export const RemoveInput = z.object({ kind: z.enum(["ai_employee", "table", "app"]), key: z.string() });

// ---------------------------------------------------------------------------
// The tools, as Claude sees them
// ---------------------------------------------------------------------------

const string = (description: string) => ({ type: "string", description });

const FORM_FIELD_SCHEMA = {
  type: "object",
  properties: {
    label: string("What people see, e.g. Supplier"),
    type: { type: "string", enum: [...FORM_FIELD_TYPES] },
    required: { type: "boolean" },
    choices: { type: "array", items: { type: "string" }, description: "For choice: the values to pick from" },
    description: string("A hint under the field"),
  },
  required: ["label", "type"],
};

export const STUDIO_TOOLS: ToolDefinition[] = [
  {
    name: "look_around",
    description:
      "See the company as it is now: its departments and people, its AI employees and their duties, its tables, apps, connected systems (with their actions), shared mailboxes, knowledge, your open requests to IT, and today's date. Use it first, and again when you need to check something.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_mailbox",
    description:
      "Read the latest emails that came to a shared mailbox, newest first: sender, subject, date, attachments and the start of the text. Use it to learn what kinds of email arrive, and to pick real examples to try an AI employee on.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: string("The mailbox address, e.g. quality@acme.com.tr"),
        limit: { type: "integer", description: "At most this many (1 to 40, default 15)" },
      },
      required: ["mailbox"],
    },
  },
  {
    name: "read_email",
    description: "Read one email in full, with the text of its attachments.",
    inputSchema: { type: "object", properties: { id: string("The email's id, from read_mailbox") }, required: ["id"] },
  },
  {
    name: "read_file",
    description: "Read a file the person added to this conversation: a sample document, an example email, a procedure.",
    inputSchema: { type: "object", properties: { id: string("The file's id") }, required: ["id"] },
  },
  {
    name: "look_at",
    description:
      "Look at one thing in detail: an AI employee (its job, duties and what it may use), a table (its fields and latest records) or a connected system (its actions, whether each reads or changes something, and what each takes).",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["ai_employee", "table", "system"] }, key: string("Its key, from look_around") },
      required: ["kind", "key"],
    },
  },
  {
    name: "search_knowledge",
    description: "Search the company's knowledge (policies, procedures, manuals) for the rules the work must follow.",
    inputSchema: { type: "object", properties: { query: string("What to look for") }, required: ["query"] },
  },
  {
    name: "ask_person",
    description:
      "Ask the person you are building with what only they can say: how a kind of case is handled or decided, who is involved, what must never happen, what matters most. At most three questions at a time, each with the answer you recommend and, when they fit, a few options. Never ask for what your tools can show you. The conversation waits for their answer, which comes back as this tool's result.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: string("One short, clear question"),
              why: string("Why it matters, in a few words"),
              options: { type: "array", items: { type: "string" }, description: "Possible answers, when there are a few" },
              recommended: string("The answer you recommend"),
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "ask_it",
    description:
      "Ask IT to connect a system, or to add an action an AI employee needs that the company doesn't have yet. IT gets the request in its work queue; its answer shows in look_around. Say exactly what the AI employee must be able to do, and why. Never invent an action instead.",
    inputSchema: {
      type: "object",
      properties: {
        system: string("The system, e.g. SAP or the supplier portal"),
        needed: string("What the AI employee must be able to do there, in plain words, e.g. find a purchase order by its number"),
        why: string("What it is for"),
        for: string("The AI employee it is for"),
      },
      required: ["system", "needed", "why"],
    },
  },
  {
    name: "save_table",
    description:
      "Make a table the work keeps, one record per case (a complaint, an application, an order), or change one you made in this conversation (give its key). Give the fields people and AI employees fill; mark fields that hold personal data. Returns its key and what AI employees can do with it (find, add, update).",
    inputSchema: {
      type: "object",
      properties: {
        key: string("To change a table you made here: its key"),
        name: string("A plural name, e.g. Supplier complaints"),
        department: string("The department's key"),
        description: string("What one record is"),
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: string("e.g. Supplier"),
              type: { type: "string", enum: ["text", "long_text", "number", "money", "date", "yes_no", "choice", "person", "email", "url", "file"] },
              choices: { type: "array", items: { type: "string" }, description: "For choice: the values, e.g. Open, In progress, Closed" },
              required: { type: "boolean" },
              personal: { type: "boolean", description: "Personal data (a person's name, contact, CV…)" },
              default: { type: "string", description: "The value a new record starts with, e.g. Open" },
              description: string("A hint"),
            },
            required: ["label", "type"],
          },
        },
        title_field: string("The label of the field that names a record"),
      },
      required: ["name", "fields"],
    },
  },
  {
    name: "save_ai_employee",
    description: [
      "Make an AI employee, or change one you made in this conversation (give its key). An AI employee is an AI agent that does the work on its own: for each email, form or request it reads, looks things up, decides, writes, asks a person when unsure, waits for replies, follows up and closes the work.",
      "Write its job in plain words, as you would brief a capable new colleague: what it handles and what it leaves alone; the steps; how it decides each kind of case (the person's rules, in their words); what it writes, to whom and in what tone; when it asks a person and whom; what it must never do.",
      "It can only use the abilities you give it. What needs approval is asked of a person first. It stays a draft, working only in tries, until the person puts the solution to work.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        key: string("To change one you made here: its key"),
        name: string("A short job name, e.g. Complaint Handler"),
        role: string("One line: what it does"),
        department: string("The department's key"),
        job: string("Its job in plain words (markdown)"),
        starts: {
          type: "array",
          description: "When it works on its own. People can always also give it work in words.",
          items: {
            type: "object",
            properties: {
              when: {
                type: "string",
                enum: ["email", "schedule", "form"],
                description: "email: each email to a mailbox; schedule: regularly; form: each time people fill its form",
              },
              mailbox: string("For email: the mailbox address"),
              every: { type: "string", enum: ["day", "weekday", "week", "month"] },
              weekday: { type: "integer", description: "For every week: 0 Sunday … 6 Saturday" },
              day: { type: "integer", description: "For every month: the day, 1 to 28" },
              time: string("HH:MM"),
            },
            required: ["when"],
          },
        },
        form: { type: "array", description: "Its form's fields, when people start its work with a form", items: FORM_FIELD_SCHEMA },
        can: {
          type: "object",
          description: "What it may use",
          properties: {
            documents: { type: "boolean", description: "Read attachments and files" },
            knowledge: { description: "Search the company's knowledge: true for all, or a list of collection keys" },
            emails: {
              type: "string",
              enum: ["none", "draft", "send"],
              description: "draft: people send what it writes; send: it sends (asking first while approval covers emails)",
            },
            web: { type: "boolean", description: "Search the web" },
            tables: {
              type: "array",
              items: {
                type: "object",
                properties: { table: string("The table's key"), can: { type: "array", items: { type: "string", enum: ["find", "add", "update"] } } },
                required: ["table", "can"],
              },
            },
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  system: string("The system's key, from look_around"),
                  actions: { type: "array", items: { type: "string" }, description: "The actions' ids" },
                },
                required: ["system", "actions"],
              },
            },
          },
        },
        approval: {
          type: "array",
          items: { type: "string", enum: ["emails", "changes"] },
          description: "What a person approves first while it is new: sending emails, changes (records, systems). Default both.",
        },
        level: {
          type: "string",
          enum: ["shadow", "supervised", "trusted"],
          description: "shadow: only prepares, a person does everything; supervised (default): acts after approval; trusted: acts alone within limits",
        },
      },
      required: ["name", "role", "job"],
    },
  },
  {
    name: "save_app",
    description:
      "Plan the screens people use on the tables: forms to add a record, lists, boards by status, charts, and buttons that give work to an AI employee. Describe the screens in plain words; they are made from the platform's building blocks when the person puts the solution to work. Give a key to change one you planned here.",
    inputSchema: {
      type: "object",
      properties: {
        key: string("To change one you planned here: its key"),
        name: string("e.g. Complaint desk"),
        department: string("The department's key"),
        description: string("The screens and what each is for, in plain words"),
        tables: { type: "array", items: { type: "string" }, description: "The tables it shows (keys)" },
        ai_employees: { type: "array", items: { type: "string" }, description: "AI employees its buttons give work to (keys)" },
      },
      required: ["name", "description", "tables"],
    },
  },
  {
    name: "try_ai_employee",
    description:
      "Try an AI employee on a real example, the way it would work: an email from a mailbox (its id), a made-up email, a file the person added, a filled form or a request in words. A try sends nothing and changes nothing; it tells you what the AI employee did and what it would have sent or changed. Judge the result against what the person asked for; fix the job and try again when it falls short. A try takes a minute or two.",
    inputSchema: {
      type: "object",
      properties: {
        key: string("The AI employee's key"),
        email_id: string("A real email's id, from read_mailbox"),
        email: {
          type: "object",
          properties: { from: { type: "string" }, from_name: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
          required: ["from", "subject", "body"],
        },
        file_id: string("A file the person added"),
        form: { type: "object", description: "Its form, filled in" },
        request: string("A request in words, as a person would give it"),
      },
      required: ["key"],
    },
  },
  {
    name: "remove",
    description: "Remove something you made in this conversation: an AI employee, a table (while it has no records) or a planned app.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["ai_employee", "table", "app"] }, key: string("Its key") },
      required: ["kind", "key"],
    },
  },
];

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export interface StudioContext {
  company: string;
  person: { name: string; title?: string | null; admin: boolean; departments: { name: string; role: string }[] };
  /** The department it builds for, when said. */
  department?: { key: string; name: string };
}

/** The Studio's instructions: written once per conversation, so they stay the same all through it. */
export function studioSystemPrompt(ctx: StudioContext): string {
  const where = ctx.person.departments.length
    ? ctx.person.departments.map((d) => `${d.role} in ${d.name}`).join(", ")
    : ctx.person.admin
      ? "IT, for the whole company"
      : "the company";
  return [
    `You are the Studio of Enterprise Brain at ${ctx.company}. Here people build AI employees: AI agents that do real work on their own, such as handling every email that comes to a shared mailbox, keeping a table up to date, looking things up in the company's systems, asking people when they are needed and following up until the work is done.`,
    `You are working with ${ctx.person.name}${ctx.person.title ? `, ${ctx.person.title}` : ""} (${where}).${ctx.department ? ` They are building for ${ctx.department.name} (key ${ctx.department.key}).` : ""} They know the work; you know how to build it. They never see code, databases or settings: you take care of that with your tools.`,
    "",
    "How you work",
    "- Understand the work before you build: where it comes from, what should happen with each kind of item, how decisions are made, who is involved, what must never happen, and when it is done. Emails and requests vary too much for templates: ask how each kind is handled, in the person's own words, and build exactly that.",
    "- Look before you ask. Read the mailbox, the tables, the systems and the AI employees the company has, and never ask for something your tools can show you. Say briefly what you found.",
    "- Ask with ask_person, at most three questions at a time, each with the answer you recommend. Decisions are theirs; facts are yours to find. Once you know enough, build: don't interview for its own sake.",
    "- Build with save_table (what should be tracked, one record per case), save_ai_employee (who does the work) and save_app (the screens people use). Reuse what the company already has when it fits.",
    "- Check who already works on the same mailbox or table (look_around shows it): two AI employees on one mailbox both handle every email, so settle it with the person.",
    "- Give each AI employee only the abilities its job needs. Its job text is its whole briefing: complete, specific, in plain words, with the person's rules and examples.",
    "- Try each AI employee with try_ai_employee on real examples (emails from the mailbox, the person's samples) before you call it ready, and read each result critically. When it falls short, fix the job and try again. Tries send nothing and change nothing.",
    "- When a system or an action it needs isn't connected, don't invent one: ask IT with ask_it and tell the person.",
    "- Nothing works for real until the person puts the solution to work from this page. When it is built and tried, say so, and say what will happen once it is at work.",
    "",
    "How you write",
    "- Plain, warm and short. No technical words: no JSON, API, SQL, prompt, workflow or trigger.",
    "- The person sees each tool you use as a line of progress. End every turn with two to four sentences: what you did or found, and what you need from them next, if anything.",
    "- Write in the language the person writes in.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// From plain words to an AI employee's job
// ---------------------------------------------------------------------------

/** A system an AI employee may use, as the Studio lists it. */
export interface StudioSystem {
  /** What the Studio calls it: a connection's name as a key, or demo-<category>. */
  key: string;
  name: string;
  category: string;
  /** A connection's id; none for the demo systems, which stand in until IT connects the real one. */
  instanceId?: string;
  demo: boolean;
  actions: { id: string; name: string; kind: "read" | "write" }[];
}

export interface CompileContext {
  departments: { id: string; key: string; name: string }[];
  /** The company's tables (and those made in this conversation). */
  tables: { key: string; name: string; fields: TableField[] }[];
  /** The Tables connection, bound to by id. */
  tablesConnectionId?: string;
  systems: StudioSystem[];
  collections: string[];
  /** Mailboxes the company has mail in. */
  mailboxes: string[];
  timeZone?: string;
  /** The key it keeps when it is changed. */
  slug?: string;
}

export interface CompiledEmployee {
  definition: AgentDefinition;
  /** What stops it from being saved. */
  problems: string[];
  /** What the person should know (a mailbox with no mail yet). */
  notes: string[];
}

const FORM_TYPES: Record<FormFieldSpec["type"], FieldSpec["type"]> = {
  text: "string",
  long_text: "text",
  number: "number",
  date: "date",
  email: "email",
  choice: "select",
  yes_no: "boolean",
  file: "file",
};

/** A field key from a label: supplier_name, received_on. */
export function fieldKeyOf(label: string, taken: Set<string>): string {
  const base =
    label
      .toLocaleLowerCase("tr")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "f_$1")
      .slice(0, 40) || "field";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

export function compileEmployee(input: EmployeeSpec, ctx: CompileContext): CompiledEmployee {
  const spec = EmployeeSpec.parse(input);
  const problems: string[] = [];
  const notes: string[] = [];
  const department = spec.department ? ctx.departments.find((d) => d.key === spec.department || d.id === spec.department) : undefined;
  if (spec.department && !department) problems.push(`There is no department "${spec.department}"; use a key from look_around.`);

  const capabilities = new Set<string>();
  const connectors: AgentDefinition["connectors"] = [];
  const can = spec.can;
  if (can.documents) capabilities.add("documents.read");
  if (can.knowledge) capabilities.add("knowledge.search");
  const collections = Array.isArray(can.knowledge) ? can.knowledge : [];
  for (const key of collections) if (!ctx.collections.includes(key)) problems.push(`There is no knowledge collection "${key}".`);
  if (can.emails === "draft") capabilities.add("mail.draft");
  if (can.emails === "send") {
    capabilities.add("mail.draft");
    capabilities.add("mail.send");
  }
  if (can.web) capabilities.add("web.search");

  let personal = false;
  const tableOps: string[] = [];
  for (const use of can.tables ?? []) {
    const table = ctx.tables.find((t) => t.key === use.table);
    if (!table) {
      problems.push(`There is no table "${use.table}": make it with save_table first.`);
      continue;
    }
    if (table.fields.some((f) => f.personal)) personal = true;
    const ops = new Set(use.can);
    // Changing or adding usually needs finding first.
    if (ops.has("update")) ops.add("find");
    for (const op of ["find", "add", "update"] as const) {
      if (!ops.has(op)) continue;
      tableOps.push(`${op}_${table.key}`);
      if (op === "find") tableOps.push(`get_${table.key}`);
    }
  }
  if (tableOps.length) {
    connectors.push({
      ref: "tables",
      category: "tables",
      ...(ctx.tablesConnectionId ? { instanceId: ctx.tablesConnectionId } : {}),
      purpose: "Keeps the company's tables",
      operations: tableOps,
    });
    for (const op of tableOps) capabilities.add(`connector:tables.${op}`);
  }

  for (const use of can.actions ?? []) {
    const system = ctx.systems.find((s) => s.key === use.system || s.instanceId === use.system || s.name.toLowerCase() === use.system.toLowerCase());
    if (!system) {
      problems.push(`There is no connected system "${use.system}"; use a key from look_around, or ask IT with ask_it.`);
      continue;
    }
    const known = use.actions.filter((a) => system.actions.some((x) => x.id === a));
    const unknown = use.actions.filter((a) => !known.includes(a));
    if (unknown.length) {
      problems.push(
        `${system.name} has no action ${unknown.map((a) => `"${a}"`).join(", ")}. Its actions: ${system.actions.map((a) => a.id).join(", ") || "none"}.`,
      );
    }
    if (!known.length) continue;
    const ref = system.demo ? system.category : slugify(system.key, 40).replace(/-/g, "_");
    const existing = connectors.find((c) => c.ref === ref);
    if (existing) existing.operations = [...new Set([...(existing.operations ?? []), ...known])];
    else
      connectors.push({
        ref,
        category: system.category,
        ...(system.instanceId ? { instanceId: system.instanceId } : {}),
        purpose: system.name,
        operations: known,
      });
    for (const op of known) capabilities.add(`connector:${ref}.${op}`);
    if (system.demo) notes.push(`${system.name} is the demo system: it stands in until IT connects the real one.`);
  }

  const triggers: TriggerSpec[] = [];
  const taken = new Set<string>();
  const inputs: FieldSpec[] = [];
  for (const start of spec.starts) {
    if (start.when === "email") {
      triggers.push({ type: "mailbox", mailbox: start.mailbox });
      if (!ctx.mailboxes.includes(start.mailbox)) {
        notes.push(`No email has come to ${start.mailbox} yet. It reads that mailbox once IT connects it; test emails can be sent to it from Mail.`);
      }
    } else if (start.when === "schedule") {
      const cron = repeatCron({ every: start.every, weekday: start.weekday, day: start.day, time: start.time ?? "08:00" });
      triggers.push({ type: "schedule", cron, ...(ctx.timeZone ? { timezone: ctx.timeZone } : {}) });
    } else if (start.when === "form") {
      triggers.push({ type: "form", description: spec.role });
    }
  }
  if (spec.starts.some((s) => s.when === "email")) {
    taken.add("email");
    inputs.push({
      key: "email",
      label: "Email",
      type: "object",
      fields: [
        { key: "from", type: "email" },
        { key: "fromName", type: "string" },
        { key: "subject", type: "string" },
        { key: "body", type: "text" },
        { key: "receivedAt", type: "string" },
      ],
    });
  }
  for (const field of spec.form) {
    if (field.type === "choice" && !field.choices?.length) {
      problems.push(`${field.label}: give the values to pick from.`);
      continue;
    }
    inputs.push({
      key: fieldKeyOf(field.label, taken),
      label: field.label,
      type: FORM_TYPES[field.type],
      ...(field.required ? { required: true } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.type === "choice" ? { options: (field.choices ?? []).map((value) => ({ value })) } : {}),
    });
  }
  if (spec.form.length && !spec.starts.some((s) => s.when === "form")) triggers.push({ type: "form", description: spec.role });
  triggers.push({ type: "manual" });

  const email = spec.starts.some((s) => s.when === "email");
  const form = triggers.some((t) => t.type === "form");
  const approvalRequiredFor = [...(spec.approval.includes("emails") ? ["mail.send"] : []), ...(spec.approval.includes("changes") ? ["connector:write"] : [])];

  const slug = ctx.slug ?? (slugify(spec.name, 40) || "ai-employee");
  let definition: AgentDefinition;
  try {
    definition = AgentDefinition.parse({
      slug,
      name: spec.name,
      title: spec.role,
      summary: spec.role,
      ...(department ? { department: department.key } : {}),
      archetype: email ? "mail-triage" : "process-automation",
      instructions: department ? `${spec.job}\n\nYou work in ${department.name}.` : spec.job,
      model: { effort: "medium" },
      inputs,
      outputs: [],
      workflow: [],
      tools: [...capabilities],
      triggers,
      knowledge: { collections },
      connectors,
      guardrails: { approvalRequiredFor, personalData: personal ? "contains" : "none" },
      ui: { layout: email ? "inbox" : form ? "form-results" : "chat", title: spec.name, description: spec.role },
    });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    definition = AgentDefinition.parse({ slug, name: spec.name, summary: spec.role, archetype: "process-automation", instructions: spec.job });
  }
  return { definition, problems, notes };
}

/**
 * An app on the given tables, for when the words don't make a better one: for each table its records
 * (grouped by its status, when it has one), a board by that status, and a form to add a record.
 */
export function plainApp(input: {
  key: string;
  name: string;
  description: string;
  tables: { key: string; name: string; fields: TableField[] }[];
}): AppDesignInput {
  const pages: AppDesignInput["pages"] = [];
  for (const table of input.tables) {
    const status = table.fields.find((f) => f.type === "choice");
    const shown = table.fields
      .filter((f) => f.type !== "long_text" && f.type !== "file")
      .slice(0, 6)
      .map((f) => f.key);
    pages.push({ key: table.key.slice(0, 40), title: table.name.slice(0, 60), blocks: [{ type: "list", table: table.key, fields: shown, search: true }] });
    if (status) {
      pages.push({
        key: `${table.key.slice(0, 34)}_board`,
        title: `${table.name} by ${status.label.toLocaleLowerCase("tr")}`.slice(0, 60),
        blocks: [{ type: "board", table: table.key, groupBy: status.key, fields: shown.slice(0, 4) }],
      });
    }
    pages.push({ key: `${table.key.slice(0, 36)}_add`, title: `Add to ${table.name}`.slice(0, 60), blocks: [{ type: "form", table: table.key }] });
  }
  return { key: input.key, name: input.name, description: input.description.slice(0, 500), pages: pages.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// In plain words, for the person
// ---------------------------------------------------------------------------

/** What an AI employee may use, in a few words each. */
export function abilitiesOf(definition: AgentDefinition, names: { tables?: Record<string, string>; systems?: Record<string, string> } = {}): string[] {
  const out: string[] = [];
  const tools = new Set(definition.tools);
  if (tools.has("documents.read")) out.push("Reads attachments and files");
  if (tools.has("knowledge.search"))
    out.push(definition.knowledge.collections.length ? `Searches ${definition.knowledge.collections.join(", ")}` : "Searches the company's knowledge");
  if (tools.has("mail.send")) out.push("Sends emails");
  else if (tools.has("mail.draft")) out.push("Drafts emails for people to send");
  if (tools.has("web.search")) out.push("Searches the web");
  for (const binding of definition.connectors) {
    const ops = binding.operations ?? [];
    if (binding.ref === "tables") {
      const byTable = new Map<string, Set<string>>();
      for (const op of ops) {
        const [verb, ...rest] = op.split("_");
        const key = rest.join("_");
        if (!byTable.has(key)) byTable.set(key, new Set());
        byTable.get(key)!.add(verb === "get" ? "find" : verb!);
      }
      for (const [key, verbs] of byTable) {
        const words = [verbs.has("find") ? "finds" : "", verbs.has("add") ? "adds" : "", verbs.has("update") ? "changes" : ""].filter(Boolean);
        out.push(`${capitalize(words.join(", ").replace(/, ([^,]*)$/, " and $1"))} records in ${names.tables?.[key] ?? key}`);
      }
      continue;
    }
    out.push(`Uses ${names.systems?.[binding.ref] ?? binding.purpose ?? binding.ref}: ${ops.join(", ")}`);
  }
  return out;
}

/** An AI employee as the solution shows it. */
export function employeeCard(definition: AgentDefinition, level: Probation, names: Parameters<typeof abilitiesOf>[1] = {}) {
  return {
    name: definition.name,
    role: definition.summary,
    duties: describeDuties(definition.triggers).map((d) => d.text),
    abilities: abilitiesOf(definition, names),
    approvals: [
      ...(definition.guardrails.approvalRequiredFor.includes("mail.send") && definition.tools.includes("mail.send") ? ["Sending emails"] : []),
      ...(definition.guardrails.approvalRequiredFor.includes("connector:write") && definition.connectors.length ? ["Changes to records and systems"] : []),
    ],
    level,
    levelText: `${PROBATION_LEVELS[level].label}: a person approves ${PROBATION_LEVELS[level].person.charAt(0).toLowerCase()}${PROBATION_LEVELS[level].person.slice(1)}`,
    form: definition.inputs.filter((f) => f.key !== "email").map((f) => f.label ?? f.key),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
