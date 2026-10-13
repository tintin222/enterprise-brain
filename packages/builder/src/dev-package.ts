import { describeEntity, type BrainEntityView } from "@enterprise-brain/brain";
import {
  ARCHETYPE_LABELS,
  PROBATION_LEVELS,
  brainKind,
  describeBlock,
  describeDuties,
  slugify,
  type AgentDefinition,
  type AppBlock,
  type Probation,
  type TableField,
} from "@enterprise-brain/core";
import type { AppView, CalculationView, RecordView, TableView } from "@enterprise-brain/runtime";
import type { JobDescription } from "./job.ts";
import { describeDefinition } from "./render.ts";
import { abilitiesOf } from "./studio-agent.ts";

/**
 * The development package: the folder a developer (or Claude Code) builds a project's AI employees from,
 * outside the platform. Everything here is pure: the server collects the project's parts and these
 * functions write them as Markdown, JSON and CSV. No code skeleton: the package says what to build,
 * with the rules, the company's context and sample data; the developer picks the stack.
 */

export type PackageFiles = Record<string, string | Buffer>;

export interface PackageProject {
  slug: string;
  name: string;
  summary: string;
  status: string;
  client: string | null;
  owner: string | null;
  company: string;
  createdAt: string;
  exportedAt: string;
}

export interface PackageTry {
  example: string;
  status: string;
  outcome: string;
  at: string;
}

/** An AI employee as the package carries it: its job as the platform runs it, how it was designed, what it was tried on. */
export interface PackageAgent {
  slug: string;
  definition: AgentDefinition;
  probation: Probation;
  source: "studio" | "interview" | "attached";
  department: string | null;
  status: string;
  notes: string[];
  tries: PackageTry[];
  /** How tables and systems are named in words (keys to names). */
  names: { tables?: Record<string, string>; systems?: Record<string, string> };
  /** The design in the Studio's own words, when designed with the Studio agent. */
  design?: Record<string, unknown>;
}

export interface PackageTodo {
  title: string;
  details: string;
  dueAt: string | null;
  who: string;
}

/** Something still open when the package was made: a question the Studio waits on, a request to IT. */
export interface PackageQuestion {
  about: string;
  text: string;
  status?: string;
}

export interface PackageFolder {
  folder: string;
  what: string;
  files: number;
}

/** The folders of the package, in the order CLAUDE.md names them. */
export const PACKAGE_LAYOUT: { folder: string; what: string }[] = [
  {
    folder: "agents/",
    what: "one folder per AI employee to build: SPEC.md (the job, duties, rules), definition.json (as the platform runs it), tests.md, and how it was designed",
  },
  { folder: "brain/", what: "what the company brain knows that the project needs: one Markdown file per thing, by kind, and things.json" },
  { folder: "data/", what: "the tables (schema and sample rows), calculations and apps the AI employees work with" },
  { folder: "knowledge/", what: "the documents the AI employees should know" },
  { folder: "files/", what: "files the person added: specifications, exports, screenshots" },
  { folder: "connections/", what: "the systems the AI employees reach, as named actions; never a secret" },
  { folder: "tasks/", what: "PLAN.md: the build order and what is still open" },
];

const APPROVAL_WORDS: Record<string, string> = {
  "mail.send": "sending an email",
  "connector:write": "a change in another system",
  "connector:*": "any use of another system",
};

function approvalWords(key: string): string {
  return APPROVAL_WORDS[key] ?? key;
}

function heading(text: string): string {
  return `# ${text}`;
}

function list(items: string[], none = "None."): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : none;
}

function day(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

/** A file name from a title: `supplier-complaint-handling.md`, with `-2`, `-3`… when taken. */
export function uniquePath(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** A safe file stem from a name: letters, digits and hyphens; "item" when nothing is left. */
export function fileStem(name: string, max = 60): string {
  return slugify(name, max) === "agent" && !/agent/i.test(name) ? "item" : slugify(name, max);
}

// ---------------------------------------------------------------------------
// The top of the package

export function renderReadme(project: PackageProject, summary: { agents: PackageAgent[]; folders: PackageFolder[] }): string {
  const agents = summary.agents.map((a) => `- **${a.definition.name}** (\`agents/${a.slug}/\`): ${a.definition.summary}`);
  return [
    heading(`${project.name}: development package`),
    "",
    `Exported from Enterprise Brain (${project.company}) on ${day(project.exportedAt)}.${project.client ? ` For ${project.client}.` : ""}${project.summary ? `\n\n${project.summary}` : ""}`,
    "",
    "## What this is",
    "",
    "Everything a developer needs to build this project's AI employees outside the platform: each one's job, duties, rules and triggers; the company's context from its brain (processes, systems, people, clients); the tables, documents and connections they work with, with sample data; acceptance scenarios; and the open tasks. There is no code here on purpose: build in the stack you choose.",
    "",
    "## How to use it with Claude Code",
    "",
    "1. Unzip and open the folder in Claude Code (`claude` in the folder). `CLAUDE.md` tells it what to build and the rules.",
    "2. Start with `tasks/PLAN.md`, then each `agents/<name>/SPEC.md`.",
    "3. To ask the live company brain while building, set `EB_API_KEY` in your environment: `.mcp.json` connects Claude Code to the platform's MCP server (tools `company_search`, `company_open`, `knowledge_search`, `list_agents`). The key is never in this package; ask the platform's admin for it.",
    "",
    "## AI employees to build",
    "",
    list(agents, "None yet: the designs of the project have no AI employee saved."),
    "",
    "## Folders",
    "",
    summary.folders.map((f) => `- \`${f.folder}\` (${f.files} file${f.files === 1 ? "" : "s"}): ${f.what}`).join("\n"),
    "",
  ].join("\n");
}

export function renderClaudeMd(input: {
  project: PackageProject;
  agents: PackageAgent[];
  folders: PackageFolder[];
  /** The platform's MCP server, when the package can reach the live brain. */
  mcp: { url: string; keyName: string } | null;
}): string {
  const { project, agents } = input;
  const rules: string[] = [];
  for (const agent of agents) {
    const d = agent.definition;
    const approvals = d.guardrails.approvalRequiredFor.map(approvalWords);
    rules.push(
      `**${d.name}**: a person approves ${approvals.length ? approvals.join(" and ") : "nothing (it works alone)"}; at first it is *${PROBATION_LEVELS[agent.probation].label}* (alone: ${PROBATION_LEVELS[agent.probation].alone.toLowerCase()}; a person: ${PROBATION_LEVELS[agent.probation].person.toLowerCase()}).`,
    );
    if (d.guardrails.personalData !== "none")
      rules.push(
        `**${d.name}** handles ${d.guardrails.personalData} personal data${d.guardrails.retentionDays ? `, kept at most ${d.guardrails.retentionDays} days` : ""}: store the least, log no personal data, and keep what the law of the company's country asks (KVKK/GDPR).`,
      );
    for (const note of d.guardrails.notes ?? []) rules.push(`**${d.name}**: ${note}`);
  }
  return [
    heading(`${project.name}`),
    "",
    `This folder is a development package exported from Enterprise Brain (${project.company}) on ${day(project.exportedAt)}${project.owner ? `, owned by ${project.owner}` : ""}${project.client ? `, for the client ${project.client}` : ""}. ${project.summary || ""}`.trim(),
    "",
    "## What to build",
    "",
    agents.length
      ? `${agents.length === 1 ? "One AI employee" : `${agents.length} AI employees`}, each specified in its own folder under \`agents/\`:\n\n${agents
          .map((a) => `- **${a.definition.name}** (\`agents/${a.slug}/SPEC.md\`): ${a.definition.summary}`)
          .join("\n")}`
      : "The project has no AI employee saved yet: its designs are still in progress on the platform. The brain context, data and documents here are what they will need.",
    "",
    "An AI employee is an agent that does real work on its own: it starts from its triggers (an email in a mailbox, a schedule, a new record, a form, a call from another system), follows its job in plain words, uses only the systems and data its spec allows, asks a person where its rules say so, and follows up until the work is done.",
    "",
    "## How to work here",
    "",
    "- Read `tasks/PLAN.md` first: the build order and what is still open. Then each `agents/<name>/SPEC.md`: the job is the whole briefing, in the owner's words; follow it exactly, including the examples and what must never happen.",
    "- `definition.json` next to each spec is how the platform runs the same AI employee today (triggers, tools, connector bindings, guardrails, tests). Mirror its behaviour; the shape of your code is yours.",
    "- `brain/` holds the company's own knowledge: processes with their steps and rules, systems with their APIs and databases, people and who knows what, clients. Build to the company's real steps, in its real systems, and hand work to the people the brain names.",
    "- `data/tables/*/schema.json` and `sample.csv` show the data the AI employees read and write; `connections/` lists the systems and their named actions. Personal fields are masked in samples unless the company's data protection officer approved them.",
    "- Build in the stack you choose. Keep secrets out of the repository: nothing in this package is a secret, and `connections/` names secret fields without their values.",
    "- `tests.md` in each agent folder holds acceptance scenarios: the tries made in the Studio and the test cases. Make them pass before calling an AI employee done.",
    "",
    "## The rules",
    "",
    list(rules, "No AI employee saved yet: the rules come with the specs."),
    "",
    "## The live company brain",
    "",
    input.mcp
      ? [
          `Enterprise Brain is also an MCP server: \`.mcp.json\` connects Claude Code to \`${input.mcp.url}\` with the environment variable \`${input.mcp.keyName}\` as the bearer token (the platform's machine key; ask its admin, never commit it). Its tools:`,
          "",
          "- `company_search`, `company_open`: what the company brain knows, live (newer than the `brain/` snapshot).",
          "- `knowledge_search`: the company's documents.",
          "- `list_agents`, `get_run`, `list_approvals`: the AI employees at work on the platform and their runs.",
        ].join("\n")
      : "This package was made without a public address for the platform: the `brain/` folder is the snapshot of what the company brain knew. Ask the platform's admin for its MCP address to ask it live.",
    "",
    "## Where everything is",
    "",
    input.folders.map((f) => `- \`${f.folder}\`: ${f.what}`).join("\n"),
    "",
  ].join("\n");
}

export function renderProjectJson(project: PackageProject, agents: PackageAgent[], folders: PackageFolder[]): string {
  return `${JSON.stringify(
    {
      project: {
        slug: project.slug,
        name: project.name,
        summary: project.summary,
        status: project.status,
        client: project.client,
        owner: project.owner,
        createdAt: project.createdAt,
      },
      company: project.company,
      exportedAt: project.exportedAt,
      agents: agents.map((a) => ({
        slug: a.slug,
        name: a.definition.name,
        source: a.source,
        department: a.department,
        status: a.status,
        folder: `agents/${a.slug}/`,
      })),
      folders: folders.map((f) => ({ folder: f.folder, files: f.files })),
      format: "enterprise-brain/dev-package/1",
    },
    null,
    2,
  )}\n`;
}

export function renderMcpJson(url: string, keyName = "EB_API_KEY"): string {
  return `${JSON.stringify({ mcpServers: { "enterprise-brain": { type: "http", url, headers: { Authorization: `Bearer \${${keyName}}` } } } }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// An AI employee

const SOURCE_WORDS: Record<PackageAgent["source"], string> = {
  studio: "with the Studio agent (see conversation.md)",
  interview: "in a guided interview (see interview.md)",
  attached: "an existing AI employee of the company, attached as a model",
};

export function renderAgentSpec(agent: PackageAgent): string {
  const d = agent.definition;
  const level = PROBATION_LEVELS[agent.probation];
  const systems = Object.fromEntries(d.connectors.map((c) => [c.ref, agent.names.systems?.[c.ref] ?? c.purpose ?? c.ref]));
  const duties = describeDuties(d.triggers, systems).map((duty) => duty.text);
  if (d.triggers.some((t) => t.type === "manual")) duties.push("People give it work in words (from Chat, Home or its page)");
  const connectors = d.connectors.map(
    (c) =>
      `${agent.names.systems?.[c.ref] ?? c.ref} (${c.category}${c.purpose ? `: ${c.purpose}` : ""})${c.operations?.length ? `: ${c.operations.join(", ")}` : ""}${c.instanceId ? "" : " — not connected on the platform yet (a demo system stands in)"}`,
  );
  const approvals = d.guardrails.approvalRequiredFor.map(approvalWords);
  const fields = (items: AgentDefinition["inputs"]) =>
    items.map((f) => `${f.label ?? f.key} (\`${f.key}\`, ${f.type}${f.required ? ", required" : ""})${f.description ? `: ${f.description}` : ""}`);
  return [
    heading(d.name),
    "",
    d.summary,
    "",
    list([
      `Key: \`${agent.slug}\``,
      `Type: ${ARCHETYPE_LABELS[d.archetype]}`,
      `Department: ${agent.department ?? d.department ?? "company-wide"}`,
      `Designed: ${SOURCE_WORDS[agent.source]}`,
      `Level at first: ${level.label} (alone: ${level.alone.toLowerCase()}; a person: ${level.person.toLowerCase()})`,
      `On the platform: ${agent.status}`,
    ]),
    "",
    "## The job, in full",
    "",
    "The whole briefing, in the owner's words. Build exactly this.",
    "",
    d.instructions.trim(),
    "",
    "## Duties: when it works",
    "",
    list(duties, "Only when a person gives it work."),
    "",
    "## What it may use",
    "",
    list(abilitiesOf(d, agent.names), "Nothing beyond reading what it is given."),
    "",
    "### Systems and connections",
    "",
    list(connectors, "None: it works on what it is given."),
    "",
    "### Knowledge",
    "",
    d.knowledge.collections.length
      ? `It searches these collections of the company's documents: ${d.knowledge.collections.join(", ")} (see \`knowledge/\`).`
      : "No document collections.",
    "",
    "## Inputs and outputs",
    "",
    `Inputs:\n${list(fields(d.inputs), "- Whatever its trigger brings (an email, a record, a request in words).")}`,
    "",
    `Outputs:\n${list(fields(d.outputs), "- What its job says: records added or changed, drafts, answers.")}`,
    "",
    "## Rules",
    "",
    list([
      `A person approves before: ${approvals.length ? approvals.join("; ") : "nothing (it works alone within its abilities)"}`,
      `Personal data: ${d.guardrails.personalData === "none" ? "none" : `${d.guardrails.personalData}${d.guardrails.retentionDays ? `, kept at most ${d.guardrails.retentionDays} days` : ""}`}`,
      ...(d.guardrails.notes ?? []).map((n) => `Never forget: ${n}`),
      ...agent.notes.map((n) => `Note from the Studio: ${n}`),
    ]),
    "",
    "## As the platform runs it",
    "",
    describeDefinition(d, { probation: agent.probation }),
    "",
    "## How it shows",
    "",
    `Layout: ${d.ui.layout}${d.ui.title ? ` · Title: ${d.ui.title}` : ""}${d.ui.description ? ` · ${d.ui.description}` : ""}${d.ui.resultView ? ` · Results as ${d.ui.resultView}` : ""}${d.ui.highlight?.length ? ` · Highlights ${d.ui.highlight.join(", ")}` : ""}`,
    "",
    "## KPIs",
    "",
    list(
      d.kpis.map((k) => `${k.name}${k.target ? `: ${k.target}` : ""}`),
      "None set.",
    ),
    "",
  ].join("\n");
}

export function renderTests(agent: PackageAgent): string {
  const d = agent.definition;
  const tries = agent.tries.map((t) =>
    [
      `### ${t.example}`,
      "",
      `- Given: ${t.example}`,
      "- When: the AI employee works on it as its job says",
      `- Then (${t.status}, tried ${day(t.at)}): ${t.outcome.trim()}`,
    ].join("\n"),
  );
  const cases = d.tests.map((t) =>
    [
      `### ${t.name}`,
      "",
      "Input:",
      "",
      "```json",
      JSON.stringify(t.input, null, 2),
      "```",
      ...(t.expected ? ["", "Expected:", "", "```json", JSON.stringify(t.expected, null, 2), "```"] : []),
    ].join("\n"),
  );
  const duties = describeDuties(d.triggers, agent.names.systems ?? {}).map((duty) => `${duty.text}: one run per item, none missed, none twice.`);
  const approvals = d.guardrails.approvalRequiredFor.map(
    (a) => `Before ${approvalWords(a)}, it stops and asks a person; nothing is sent or changed until they agree.`,
  );
  return [
    heading(`Acceptance scenarios: ${d.name}`),
    "",
    "## Tried in the Studio on real examples",
    "",
    tries.length ? tries.join("\n\n") : "Not tried yet.",
    "",
    "## Test cases",
    "",
    cases.length ? cases.join("\n\n") : "None recorded.",
    "",
    "## Before it goes to work",
    "",
    list([
      ...duties,
      ...approvals,
      "Everything it sends or changes can be traced back: what, when, for which item, decided by whom.",
      "Its job's examples each give the result the owner described.",
    ]),
    "",
  ].join("\n");
}

/** A Studio conversation as a readable transcript. */
export function renderTranscript(title: string, events: { kind: string; data: Record<string, unknown>; at: string }[]): string {
  const lines: string[] = [heading(`Studio conversation: ${title}`), ""];
  const text = (d: Record<string, unknown>) => (typeof d.text === "string" ? d.text.trim() : "");
  for (const event of events) {
    const d = event.data;
    switch (event.kind) {
      case "user":
      case "answer": {
        const files = Array.isArray(d.files) ? (d.files as { name: string }[]).map((f) => f.name) : [];
        lines.push(`**Person:** ${text(d)}${files.length ? ` _(files: ${files.join(", ")})_` : ""}`, "");
        break;
      }
      case "said":
        lines.push(`**Studio:** ${text(d)}`, "");
        break;
      case "note":
        lines.push(`_Studio: ${text(d)}_`, "");
        break;
      case "question": {
        const questions = Array.isArray(d.questions) ? (d.questions as { question: string; recommended?: string }[]) : [];
        lines.push("**Studio asked:**", ...questions.map((q) => `- ${q.question}${q.recommended ? ` _(recommended: ${q.recommended})_` : ""}`), "");
        break;
      }
      case "step":
        lines.push(`- ${text(d)}${d.ok === false ? " (failed)" : ""}`);
        break;
      case "part":
        lines.push(
          `- ${d.part === "asset" ? `Added ${String(d.name)} to the project` : d.part === "todo" ? `Task for the person: ${String(d.title)}` : `${d.changed ? "Changed" : "Saved"} ${String(d.part).replace("_", " ")} ${String(d.name)}`}`,
        );
        break;
      case "try":
        lines.push("", `**Tried ${String(d.name)} on ${String(d.example)}** (${String(d.status)}): ${String(d.outcome ?? "").trim()}`, "");
        break;
      case "request":
        lines.push(`- Asked IT: ${String(d.system)}: ${String(d.needed)}`);
        break;
      case "removed":
        lines.push(`- Removed ${String(d.key)}`);
        break;
      case "built":
        lines.push("", "**Put to work on the platform.**", "");
        break;
      case "error":
        lines.push("", `_Something went wrong: ${text(d)}_`, "");
        break;
      default:
        break;
    }
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** A guided interview: what was agreed, the job as it summed it up, and the conversation. */
export function renderInterview(input: {
  title: string;
  digest: string;
  job: JobDescription;
  messages: { role: string; content: string; at: string }[];
}): string {
  const { job } = input;
  return [
    heading(`Guided interview: ${input.title}`),
    "",
    "## What was agreed",
    "",
    input.digest.trim() || "Nothing settled yet.",
    "",
    "## The job as the interview summed it up",
    "",
    `Duties:\n${list(job.duties)}`,
    "",
    `Never on its own:\n${list(job.never)}`,
    "",
    `Needs from others:\n${list(
      job.needs.map((n) => `${n.text} (${n.who}: ${n.status})`),
      "Nothing asked of others.",
    )}`,
    "",
    `Level at first: ${job.level.label} (alone: ${job.level.alone.toLowerCase()}; a person: ${job.level.person.toLowerCase()})`,
    `Samples analysed: ${job.samples}${job.manager ? ` · Hiring manager: ${job.manager}` : ""}`,
    "",
    "## The conversation",
    "",
    input.messages
      .map((m) => `**${m.role === "user" ? "Person" : m.role === "analyst" || m.role === "assistant" ? "Analyst" : m.role}:** ${m.content.trim()}`)
      .join("\n\n") || "No messages.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The company's context and data

export function renderThing(view: BrainEntityView): string {
  const kind = brainKind(view.kind);
  return [
    "---",
    `id: ${view.id}`,
    `kind: ${view.kind}`,
    `key: ${view.key}`,
    `name: ${JSON.stringify(view.name)}`,
    `updated: ${view.updatedAt}`,
    "---",
    "",
    describeEntity(view, { events: 10 }),
    "",
    `_${kind?.description ?? view.kind}. Exported from the company brain; the live version may be newer (company_open over MCP)._`,
    "",
  ].join("\n");
}

export function renderThingsJson(views: BrainEntityView[]): string {
  return `${JSON.stringify(
    views.map((v) => ({
      id: v.id,
      kind: v.kind,
      key: v.key,
      name: v.name,
      aliases: v.aliases,
      summary: v.summary,
      data: v.data,
      links: v.links.map((l) => ({
        relation: l.relation,
        direction: l.direction,
        label: l.label,
        detail: l.detail,
        other: { id: l.other.id, kind: l.other.kind, name: l.other.name },
      })),
      updatedAt: v.updatedAt,
    })),
    null,
    2,
  )}\n`;
}

/** One CSV cell, RFC 4180: quoted when it holds a comma, a quote or a line break; quotes doubled. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + (rows.length ? "\r\n" : "");
}

const MASKED = "[personal]";

/** A record's value for one field, as the sample shows it: how it reads for links and people, as stored otherwise. */
function cellOf(record: RecordView, field: TableField): string {
  const shown = record.display[field.key];
  if (shown !== undefined && shown !== null && shown !== "") return String(shown);
  const value = record.values[field.key];
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join("; ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A table as the package carries it: its design in words, its schema, and sample rows (personal fields masked unless approved). */
export function renderTable(
  table: TableView,
  records: RecordView[],
  options: { maskPersonal?: boolean } = {},
): { readme: string; schema: string; csv: string } {
  const mask = options.maskPersonal ?? true;
  const approved = new Set(table.personal.approved);
  const masked = (field: TableField) => Boolean(field.personal) && mask && !approved.has(field.key);
  const header = table.fields.map((f) => f.key);
  const rows = records.map((r) => table.fields.map((f) => (masked(f) ? MASKED : cellOf(r, f))));
  const readme = [
    heading(`${table.name} (\`${table.key}\`)`),
    "",
    table.description || "No description.",
    "",
    list([
      `Department: ${table.departmentId ?? "company-wide"}`,
      `Who sees it: ${table.settings.visibility === "company" ? "everyone in the company" : "its department"}`,
      `Who edits records: ${table.settings.editors === "managers" ? "its department's managers" : "its department's people"}`,
      `Records on the platform: ${table.records} (${records.length} in sample.csv)`,
      `Title field: \`${table.titleField}\``,
    ]),
    "",
    "## Fields",
    "",
    "| key | label | type | required | personal | more |",
    "|---|---|---|---|---|---|",
    ...table.fields.map(
      (f) =>
        `| \`${f.key}\` | ${f.label} | ${f.type} | ${f.required ? "yes" : ""} | ${f.personal ? (approved.has(f.key) ? "yes (approved)" : "yes") : ""} | ${[
          f.choices?.length ? `choices: ${f.choices.join(", ")}` : "",
          f.currency ? `currency: ${f.currency}` : "",
          f.table ? `links to: ${f.table}` : "",
          f.default !== undefined ? `default: ${String(f.default)}` : "",
          f.description ?? "",
        ]
          .filter(Boolean)
          .join(" · ")} |`,
    ),
    "",
    table.fields.some(masked)
      ? `Personal fields (${table.fields
          .filter(masked)
          .map((f) => `\`${f.key}\``)
          .join(", ")}) are masked as \`${MASKED}\` in sample.csv: the data protection officer has not approved them for export.`
      : "No personal field is masked in sample.csv.",
    "",
  ].join("\n");
  const schema = `${JSON.stringify(
    {
      key: table.key,
      name: table.name,
      description: table.description,
      titleField: table.titleField,
      departmentId: table.departmentId,
      settings: table.settings,
      fields: table.fields,
      personal: table.personal,
      version: table.version,
    },
    null,
    2,
  )}\n`;
  return { readme, schema, csv: toCsv([header, ...rows]) };
}

export function renderCalculation(view: CalculationView, code?: string): string {
  return [
    heading(`${view.name} (\`${view.key}\`)`),
    "",
    `Rule, in the owner's words: ${view.rule}`,
    "",
    view.explanation ? `How it works: ${view.explanation}` : "",
    "",
    list([
      `Tables it reads: ${view.tables.join(", ") || "none"}`,
      `Result: ${view.output.kind}${view.output.unit ? ` (${view.output.unit})` : ""}${view.output.columns.length ? `; columns: ${view.output.columns.map((c) => `${c.label} (${c.type})`).join(", ")}` : ""}`,
      `Schedule: ${view.schedule ? JSON.stringify(view.schedule) : "run by hand or by an app"}`,
      `Last run on the platform: ${view.lastRunAt ? day(view.lastRunAt.toISOString()) : "never"}`,
    ]),
    "",
    "## Code",
    "",
    code !== undefined
      ? ["The rule as the platform runs it (JavaScript in a sandbox, over the tables' rows):", "", "```js", code.trim(), "```"].join("\n")
      : "The code is not in this package: only an admin's export carries it. Rebuild the rule from the words above.",
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function renderApp(view: AppView, names: Parameters<typeof describeBlock>[1]): string {
  return [
    heading(`${view.name} (\`${view.key}\`)`),
    "",
    view.description || "No description.",
    "",
    list([
      `Department: ${view.departmentId ?? "company-wide"}`,
      `Who uses it: ${view.settings.visibility === "company" ? "everyone" : "its department"}`,
      `Tables: ${view.tables.join(", ") || "none"}`,
      `AI employees its buttons call: ${view.agents.join(", ") || "none"}`,
    ]),
    "",
    "## Pages",
    "",
    ...view.pages.flatMap((page) => [`### ${page.title}`, "", list(page.blocks.map((block: AppBlock) => describeBlock(block, names))), ""]),
    "The pages' blocks as the platform stores them are in the .json file beside this one.",
    "",
  ].join("\n");
}

export function renderDocument(doc: { title: string; collection: string; source: string; uri: string | null; createdAt: string }, text: string): string {
  return [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `collection: ${doc.collection}`,
    `source: ${doc.source}${doc.uri ? ` (${doc.uri})` : ""}`,
    `added: ${day(doc.createdAt)}`,
    "---",
    "",
    heading(doc.title),
    "",
    text.trim() || "_(no text was extracted)_",
    "",
  ].join("\n");
}

export interface PackageOperation {
  id: string;
  name: string;
  description?: string;
  kind: string;
  input?: unknown;
}

/** What a demo system stands in for, in the words of the package. */
const CATEGORY_WORDS: Record<string, string> = {
  erp: "ERP",
  accounting: "accounting system",
  scm: "supply chain system",
  crm: "CRM",
  hris: "HR system",
  ats: "recruiting system (ATS)",
  itsm: "IT service desk",
  calendar: "calendar",
};

export function renderConnection(
  view: { name: string; type: string; category: string; status: string; config: Record<string, unknown>; secretFields: string[]; sandbox: boolean },
  operations: PackageOperation[],
): string {
  const properties = (input: unknown) => {
    const schema = input as { properties?: Record<string, { description?: string }>; required?: string[] } | undefined;
    if (!schema?.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => `\`${key}\`${schema.required?.includes(key) ? "*" : ""}${prop?.description ? ` (${prop.description})` : ""}`)
      .join(", ");
  };
  return [
    heading(view.name),
    "",
    list([
      `Type: ${view.type} (${view.category})`,
      `Status on the platform: ${view.status}${view.sandbox ? " (a demo system standing in for the real one)" : ""}`,
    ]),
    "",
    ...(view.sandbox
      ? [
          `A built-in demo system: it stands in for the company's real ${CATEGORY_WORDS[view.category] ?? view.category} until IT connects one. Build against the real system; these actions show what the AI employee expects of it (names, inputs, read or write).`,
          "",
          "No secrets.",
          "",
        ]
      : [
          "## Settings",
          "",
          list(
            Object.entries(view.config)
              .filter(([, value]) => value !== "" && value !== null && value !== undefined)
              .map(([key, value]) => `\`${key}\`: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`),
            "None.",
          ),
          "",
          view.secretFields.length
            ? `Secrets (names only, never their values; set them in the environment of what you build): ${view.secretFields.map((s) => `\`${s}\``).join(", ")}`
            : "No secrets.",
          "",
        ]),
    "## Named actions",
    "",
    list(
      operations.map((op) => {
        const description = (op.description ?? "").trim().replace(/\.$/, "");
        const takes = properties(op.input);
        return `\`${op.id}\` — ${op.name} (${op.kind})${description ? `: ${description}` : ""}${takes ? `. Takes ${takes}` : ""}`;
      }),
      "None.",
    ),
    "",
    "Actions that change the system (write) are gated on the platform: a person approves them while the AI employee is on probation. Keep the same gate.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The plan

export function renderPlan(input: { project: PackageProject; agents: PackageAgent[]; todos: PackageTodo[]; questions: PackageQuestion[] }): string {
  const { project, agents } = input;
  const steps = agents.map((a, i) => {
    const d = a.definition;
    const systems = d.connectors.map((c) => a.names.systems?.[c.ref] ?? c.ref);
    const duties = describeDuties(d.triggers, Object.fromEntries(d.connectors.map((c) => [c.ref, a.names.systems?.[c.ref] ?? c.ref]))).map((x) => x.text);
    return [
      `### ${i + 1}. Build ${d.name} (\`agents/${a.slug}/\`)`,
      "",
      list([
        ...duties.map((t) => `Trigger: ${t}`),
        ...(systems.length ? [`Reach: ${systems.join(", ")} (see \`connections/\`)`] : []),
        ...(d.knowledge.collections.length ? [`Knowledge: ${d.knowledge.collections.join(", ")}`] : []),
        `Approval gate: ${d.guardrails.approvalRequiredFor.map(approvalWords).join("; ") || "none"}`,
        `Tests: see \`agents/${a.slug}/tests.md\``,
      ]),
    ].join("\n");
  });
  const todos = input.todos.map(
    (t) =>
      `- [ ] ${t.title}${t.who ? ` — ${t.who}` : ""}${t.dueAt ? `, due ${day(t.dueAt)}` : ""}${t.details ? `: ${t.details.replace(/\s+/g, " ").trim()}` : ""}`,
  );
  const questions = input.questions.map((q) => `- ${q.about}: ${q.text}${q.status ? ` (${q.status})` : ""}`);
  return [
    heading(`Development plan: ${project.name}`),
    "",
    `Exported ${day(project.exportedAt)} from Enterprise Brain (${project.company}).${project.client ? ` For ${project.client}.` : ""}`,
    "",
    "## Build order",
    "",
    steps.length ? steps.join("\n\n") : "No AI employee saved yet. Start from the designs on the platform, or from `brain/` and the owner's words.",
    "",
    "## Before you start: what is still open",
    "",
    "Tasks of the project's people (from the platform):",
    "",
    todos.length ? todos.join("\n") : "- Nothing open.",
    "",
    "Questions and requests still waiting:",
    "",
    questions.length ? questions.join("\n") : "- None.",
    "",
    "## Done means",
    "",
    list([
      "Every AI employee handles each of its tries and test cases as described in its tests.md.",
      "Nothing is sent or changed without the approval gate its rules name.",
      "Personal data is kept to the minimum, and never in logs.",
      "Each run can be traced: what, when, for which item, who decided.",
    ]),
    "",
  ].join("\n");
}
